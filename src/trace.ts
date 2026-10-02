/**
 * The routing trace: what routing did with a turn, recorded as it did it.
 *
 * Every value here is written at the decision point that produced it, from the same
 * inputs the decision used — nothing is recomputed afterwards, so a trace can never
 * disagree with what routing actually did. A trace holds provider, model, timing,
 * status, and the reason a try failed; never prompt text, tool arguments, or
 * credentials.
 *
 * Bounded and in memory: only the newest {@link TRACE_KEEP} turns are kept, and a
 * finished turn is dropped once enough newer turns exist. Nothing is written to disk.
 *
 * `seq` is bumped on every change, so a reader can long-poll with `after=<seq>` and be
 * woken once per change instead of polling on a timer.
 */

/** How many turns stay resident. A dashboard wants recently finished turns too, not just live ones. */
export const TRACE_KEEP = 200;

/** Default long-poll ceiling. Long enough to be cheap, short enough to survive idle proxies. */
export const TRACE_WAIT_MS = 60_000;

/**
 * Quota health as routing reads it. Declared structurally rather than imported from
 * `./quota`, so this module stays free of the ledger and pricing graph.
 */
export type TraceQuotaStatus = "ok" | "low" | "exhausted" | "unknown";

/** Cache affinity as routing reads it; see {@link TraceQuotaStatus} for why it is local. */
export type TraceCacheState = "hot" | "warm" | "stale" | "unknown";

/** One candidate as routing weighed it, before any try was made. */
export interface WeighedCandidate {
  provider: string;
  model: string;
  canonical?: string;
  /** 0 is the candidate routing put first; a larger number was considered after it. */
  rank: number;
  quota?: TraceQuotaStatus;
  cacheState?: TraceCacheState;
  /** Set when code withheld this candidate, with the reason it was not offered. */
  skipped?: { reason: string; detail: string };
}

/** Why an upstream attempt was made: the first shot, a transient repeat, or a re-route. */
export type TryCause = "initial" | "retry" | "failover";

/** One upstream attempt. A transient retry and a quota failover are both tries. */
export interface RouteTry {
  provider: string;
  model: string;
  effort?: string;
  cause: TryCause;
  /** Epoch ms when the attempt began, for the waterfall. */
  startedAt: number;
  /** Milliseconds from `startedAt` to the end of the attempt; absent while it is open. */
  ms?: number;
  /** Milliseconds from the turn starting to the first streamed content of this attempt. */
  ttftMs?: number;
  status?: number;
  /** Why the attempt failed: `quota`, `rate`, `http-502`, `fetch: ECONNRESET`, `client-canceled`. */
  fail?: string;
  /** False while the attempt is still awaiting a response. */
  done: boolean;
}

/** How routing decided, and how long the decision took. */
export interface TraceBrain {
  /** Channel that answered, e.g. `typesafe`. */
  channel?: string;
  model?: string;
  confidence?: number;
  ms: number;
}

/** A single turn's routing, from the request arriving to the last byte leaving. */
export interface RouteTrace {
  /** Bumped on every change; a long-poll waits for it to pass the reader's `after`. */
  seq: number;
  /** Same id as the ledger row and the captured body, so the two can be joined. */
  requestId: string;
  /** The resolved session key — a fingerprint when the client sent no session header. */
  session: string;
  /** The client's own session header, when it sent one. */
  clientSession?: string;
  /** A key only ever reads its own traces; `local` and `unauthenticated` are their own keys. */
  keyId?: string;
  keyName?: string;
  /** ISO timestamp of the first byte of the request. */
  at: string;
  path: string;
  requestedModel: string;
  stream: boolean;
  phase?: string;
  reason?: string;
  brain?: TraceBrain;
  cacheKeep?: string;
  /** The candidate order routing chose from, best first. Empty when the model was pinned. */
  order: WeighedCandidate[];
  tries: RouteTry[];
  /** Quota or refusal failovers this turn took before it was served. */
  failovers: number;
  done: boolean;
  status?: number;
  error?: string;
  /** Milliseconds from the request arriving to the turn finishing. */
  ms?: number;
  /** Milliseconds from the request arriving to the first streamed content. */
  ttftMs?: number;
}

export interface RouteInit {
  requestId: string;
  session: string;
  clientSession?: string;
  keyId?: string;
  keyName?: string;
  path: string;
  requestedModel: string;
  stream: boolean;
  startedAt: number;
  phase?: string;
  reason?: string;
  cacheKeep?: string;
}

type TraceListener = (trace: RouteTrace) => void;

interface Waiter {
  session: string;
  keyId?: string;
  after: number;
  resolve: (trace: RouteTrace | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Insertion-ordered, so the oldest trace is the first key. */
const traces = new Map<string, RouteTrace>();
/** Session key → the id of its latest trace. */
const latestBySession = new Map<string, string>();
const listeners = new Set<TraceListener>();
const waiters = new Set<Waiter>();

/** Milliseconds for a monotonic-ish stamp; injected nowhere, so tests can use the real clock. */
function now(): number {
  return Date.now();
}

function clone(trace: RouteTrace): RouteTrace {
  return {
    ...trace,
    order: trace.order.map((candidate) => ({ ...candidate })),
    tries: trace.tries.map((attempt) => ({ ...attempt })),
  };
}

/** Bumps `seq` and fans out to listeners and any long-poll that was waiting for this change. */
function changed(trace: RouteTrace): void {
  trace.seq += 1;
  for (const listener of listeners) {
    try {
      listener(clone(trace));
    } catch {
      // A listener must never break the request it is observing.
    }
  }
  // Deleting from a Set while iterating is defined behaviour, so the copy is unnecessary.
  for (const waiter of waiters) {
    if (waiter.session !== trace.session) continue;
    if (waiter.keyId !== undefined && waiter.keyId !== trace.keyId) continue;
    if (trace.seq <= waiter.after) continue;
    waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.resolve(clone(trace));
  }
}

/** The last still-open attempt, which is the one a turn is currently spending time on. */
function openTry(trace: RouteTrace): RouteTry | undefined {
  for (let index = trace.tries.length - 1; index >= 0; index -= 1) {
    const attempt = trace.tries[index];
    if (attempt && !attempt.done) return attempt;
  }
  return undefined;
}

/** Drops the oldest traces once the buffer is over {@link TRACE_KEEP}, preferring finished ones. */
function trim(): void {
  if (traces.size <= TRACE_KEEP) return;
  const overflow = traces.size - TRACE_KEEP;
  let dropped = 0;
  for (const [id, trace] of traces) {
    if (dropped >= overflow) break;
    if (!trace.done) continue;
    traces.delete(id);
    if (latestBySession.get(trace.session) === id) latestBySession.delete(trace.session);
    dropped += 1;
  }
  // Everything still resident is in flight: drop the oldest anyway rather than grow unbounded.
  for (const [id, trace] of traces) {
    if (dropped >= overflow) break;
    traces.delete(id);
    if (latestBySession.get(trace.session) === id) latestBySession.delete(trace.session);
    dropped += 1;
  }
}

/** Starts a trace for a turn. Re-using an id replaces the previous trace. */
export function beginRoute(init: RouteInit): RouteTrace {
  const trace: RouteTrace = {
    seq: 0,
    requestId: init.requestId,
    session: init.session,
    ...(init.clientSession ? { clientSession: init.clientSession } : {}),
    ...(init.keyId ? { keyId: init.keyId } : {}),
    ...(init.keyName ? { keyName: init.keyName } : {}),
    at: new Date(init.startedAt).toISOString(),
    path: init.path,
    requestedModel: init.requestedModel,
    stream: init.stream,
    ...(init.phase ? { phase: init.phase } : {}),
    ...(init.reason ? { reason: init.reason } : {}),
    ...(init.cacheKeep ? { cacheKeep: init.cacheKeep } : {}),
    order: [],
    tries: [],
    failovers: 0,
    done: false,
  };
  traces.set(init.requestId, trace);
  latestBySession.set(init.session, init.requestId);
  trim();
  changed(trace);
  return clone(trace);
}

/** Records the candidate order routing chose from, best first. Reporting only. */
export function weigh(id: string, order: WeighedCandidate[]): void {
  const trace = traces.get(id);
  if (!trace) return;
  trace.order = order.map((candidate, rank) => ({ ...candidate, rank }));
  changed(trace);
}

/** Records the decision itself, so a re-route (failover) updates what the trace reports. */
export function noteDecision(
  id: string,
  decision: {
    phase?: string;
    reason?: string;
    cacheKeep?: string;
    brain?: TraceBrain;
  },
): void {
  const trace = traces.get(id);
  if (!trace) return;
  if (decision.phase !== undefined) trace.phase = decision.phase;
  if (decision.reason !== undefined) trace.reason = decision.reason;
  if (decision.cacheKeep !== undefined) trace.cacheKeep = decision.cacheKeep;
  if (decision.brain !== undefined) trace.brain = decision.brain;
  changed(trace);
}

/** Opens an attempt. A `failover` cause also counts the failover the turn took. */
export function beginTry(
  id: string,
  attempt: { provider: string; model: string; cause: TryCause; effort?: string },
): void {
  const trace = traces.get(id);
  if (!trace) return;
  if (attempt.cause === "failover") trace.failovers += 1;
  trace.tries.push({
    provider: attempt.provider,
    model: attempt.model,
    ...(attempt.effort ? { effort: attempt.effort } : {}),
    cause: attempt.cause,
    startedAt: now(),
    done: false,
  });
  changed(trace);
}

/** Closes the open attempt with its outcome. A no-op when nothing is open. */
export function endTry(id: string, outcome: { status?: number; fail?: string }): void {
  const trace = traces.get(id);
  if (!trace) return;
  const attempt = openTry(trace);
  if (!attempt) return;
  attempt.done = true;
  attempt.ms = Math.max(0, now() - attempt.startedAt);
  if (outcome.status !== undefined) attempt.status = outcome.status;
  if (outcome.fail !== undefined) attempt.fail = outcome.fail;
  changed(trace);
}

/** Records the first streamed content of the turn, on the trace and the open attempt. */
export function firstToken(id: string): void {
  const trace = traces.get(id);
  if (!trace || trace.ttftMs !== undefined) return;
  const elapsed = Math.max(0, now() - Date.parse(trace.at));
  trace.ttftMs = elapsed;
  const attempt = openTry(trace);
  if (attempt) attempt.ttftMs = Math.max(0, now() - attempt.startedAt);
  changed(trace);
}

/**
 * Closes a trace with the turn's final status. The open attempt is closed too, so a turn
 * that was served gets its attempt's `ms` set to the turn duration rather than staying open.
 * Returns the finished trace, or undefined when tracing never started for this id.
 */
export function finishRoute(
  id: string,
  outcome: { status: number; error?: string },
): RouteTrace | undefined {
  const trace = traces.get(id);
  if (!trace) return undefined;
  const attempt = openTry(trace);
  if (attempt) {
    attempt.done = true;
    attempt.ms = Math.max(0, now() - attempt.startedAt);
    attempt.status = outcome.status;
    if (attempt.fail === undefined && outcome.status >= 400) {
      attempt.fail = outcome.status === 499 ? "client-canceled" : `http-${outcome.status}`;
    }
  }
  trace.done = true;
  trace.status = outcome.status;
  trace.ms = Math.max(0, now() - Date.parse(trace.at));
  if (outcome.error) trace.error = outcome.error;
  changed(trace);
  return clone(trace);
}

/** The latest trace for a session, scoped to a key when one is given. */
export function latestFor(session: string, keyId?: string): RouteTrace | undefined {
  const id = latestBySession.get(session);
  if (!id) return undefined;
  const trace = traces.get(id);
  if (!trace) return undefined;
  if (keyId !== undefined && trace.keyId !== keyId) return undefined;
  return clone(trace);
}

/** A trace by request id. */
export function traceFor(id: string): RouteTrace | undefined {
  const trace = traces.get(id);
  return trace ? clone(trace) : undefined;
}

/** Newest first, for the dashboard list. */
export function recentTraces(limit = TRACE_KEEP): RouteTrace[] {
  const out: RouteTrace[] = [];
  for (const trace of traces.values()) out.push(clone(trace));
  return out.reverse().slice(0, Math.max(0, limit));
}

/**
 * Resolves with the session's latest trace once its `seq` passes `after`, or with null when
 * `waitMs` elapses first. Resolves immediately when a newer trace already exists.
 */
export function waitForSession(q: {
  session: string;
  keyId?: string;
  after?: number;
  waitMs?: number;
}): Promise<RouteTrace | null> {
  const after = q.after ?? 0;
  const current = latestFor(q.session, q.keyId);
  if (current && current.seq > after) return Promise.resolve(current);
  const waitMs = Math.max(0, q.waitMs ?? TRACE_WAIT_MS);
  if (waitMs === 0) return Promise.resolve(null);
  return new Promise<RouteTrace | null>((resolve) => {
    const waiter: Waiter = {
      session: q.session,
      ...(q.keyId !== undefined ? { keyId: q.keyId } : {}),
      after,
      resolve,
      timer: setTimeout(() => {
        waiters.delete(waiter);
        resolve(null);
      }, waitMs),
    };
    // Do not keep the process alive solely for a long-poll.
    waiter.timer.unref?.();
    waiters.add(waiter);
  });
}

/** Subscribes to every trace change. Returns an unsubscribe function. */
export function subscribeTraces(listener: TraceListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clears every trace, waiter, and subscriber. Tests only. */
export function resetTraces(): void {
  for (const waiter of waiters) clearTimeout(waiter.timer);
  waiters.clear();
  listeners.clear();
  traces.clear();
  latestBySession.clear();
}
