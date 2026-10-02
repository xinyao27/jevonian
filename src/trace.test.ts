import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  TRACE_KEEP,
  beginRoute,
  beginTry,
  endTry,
  finishRoute,
  firstToken,
  latestFor,
  noteDecision,
  recentTraces,
  resetTraces,
  subscribeTraces,
  traceFor,
  waitForSession,
  weigh,
  type RouteInit,
} from "./trace";

afterEach(() => {
  resetTraces();
});

function init(overrides: Partial<RouteInit> = {}): RouteInit {
  return {
    requestId: "req-1",
    session: "sess-1",
    path: "/chat/completions",
    requestedModel: "jevonian/auto",
    stream: true,
    startedAt: Date.now(),
    ...overrides,
  };
}

describe("beginRoute", () => {
  it("records the request identity and starts open", () => {
    const trace = beginRoute(init());
    expect(trace.requestId).toBe("req-1");
    expect(trace.session).toBe("sess-1");
    expect(trace.done).toBe(false);
    expect(trace.tries).toEqual([]);
    expect(trace.failovers).toBe(0);
    expect(trace.seq).toBeGreaterThan(0);
  });

  it("keeps the client's own session header when it differs from the resolved key", () => {
    const trace = beginRoute(init({ clientSession: "client-session" }));
    expect(trace.clientSession).toBe("client-session");
  });

  it("bumps seq on every change", () => {
    const started = beginRoute(init());
    weigh("req-1", [{ provider: "p", model: "m", rank: 0 }]);
    const weighed = traceFor("req-1");
    expect(weighed!.seq).toBeGreaterThan(started.seq);
    beginTry("req-1", { provider: "p", model: "m", cause: "initial" });
    const attempted = traceFor("req-1");
    expect(attempted!.seq).toBeGreaterThan(weighed!.seq);
    endTry("req-1", { status: 200 });
    expect(traceFor("req-1")!.seq).toBeGreaterThan(attempted!.seq);
  });
});

describe("tries", () => {
  it("counts a failover cause and closes the open attempt", () => {
    beginRoute(init());
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    endTry("req-1", { status: 429, fail: "quota" });
    beginTry("req-1", { provider: "b", model: "m2", cause: "failover" });
    endTry("req-1", { status: 200 });

    const trace = traceFor("req-1")!;
    expect(trace.failovers).toBe(1);
    expect(trace.tries).toHaveLength(2);
    expect(trace.tries[0]).toMatchObject({
      provider: "a",
      model: "m1",
      cause: "initial",
      status: 429,
      fail: "quota",
      done: true,
    });
    expect(trace.tries[1]).toMatchObject({ provider: "b", cause: "failover", status: 200 });
  });

  it("does not count a transient retry as a failover", () => {
    beginRoute(init());
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    endTry("req-1", { fail: "http-502" });
    beginTry("req-1", { provider: "a", model: "m1", cause: "retry" });
    endTry("req-1", { status: 200 });

    const trace = traceFor("req-1")!;
    expect(trace.failovers).toBe(0);
    expect(trace.tries.map((attempt) => attempt.cause)).toEqual(["initial", "retry"]);
  });

  it("ignores an endTry when no attempt is open", () => {
    beginRoute(init());
    endTry("req-1", { status: 200 });
    expect(traceFor("req-1")!.tries).toEqual([]);
  });

  it("leaves an attempt open while it is still in flight", () => {
    beginRoute(init());
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    const trace = traceFor("req-1")!;
    expect(trace.tries[0]?.done).toBe(false);
    expect(trace.tries[0]?.ms).toBeUndefined();
  });
});

describe("firstToken", () => {
  it("records the turn and attempt first-token time once", async () => {
    const startedAt = Date.now() - 25;
    beginRoute(init({ startedAt }));
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    firstToken("req-1");
    const trace = traceFor("req-1")!;
    expect(trace.ttftMs).toBeGreaterThanOrEqual(20);
    expect(trace.tries[0]?.ttftMs).toBeGreaterThanOrEqual(0);

    // A second call must not move the first measurement.
    const first = trace.ttftMs;
    firstToken("req-1");
    expect(traceFor("req-1")!.ttftMs).toBe(first);
  });

  it("is a no-op for an unknown trace", () => {
    expect(() => firstToken("missing")).not.toThrow();
  });
});

describe("finishRoute", () => {
  it("closes the open attempt with the turn's status and duration", () => {
    beginRoute(init());
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    const trace = finishRoute("req-1", { status: 200 })!;
    expect(trace.done).toBe(true);
    expect(trace.status).toBe(200);
    expect(trace.ms).toBeGreaterThanOrEqual(0);
    expect(trace.tries[0]).toMatchObject({ done: true, status: 200 });
  });

  it("names a canceled turn rather than reporting an http status", () => {
    beginRoute(init());
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    finishRoute("req-1", { status: 499, error: "client canceled" });
    const trace = traceFor("req-1")!;
    expect(trace.error).toBe("client canceled");
    expect(trace.tries[0]?.fail).toBe("client-canceled");
  });

  it("returns undefined for an unknown trace", () => {
    expect(finishRoute("missing", { status: 200 })).toBeUndefined();
  });
});

describe("noteDecision", () => {
  it("updates what a re-route changed", () => {
    beginRoute(init({ phase: "plan", reason: "brain:plan" }));
    noteDecision("req-1", { phase: "execute", reason: "brain:execute:quota-failover" });
    const trace = traceFor("req-1")!;
    expect(trace.phase).toBe("execute");
    expect(trace.reason).toBe("brain:execute:quota-failover");
  });
});

describe("lookup", () => {
  it("finds the latest trace for a session", () => {
    beginRoute(init({ requestId: "old", startedAt: Date.now() - 1000 }));
    beginRoute(init({ requestId: "new" }));
    expect(latestFor("sess-1")?.requestId).toBe("new");
  });

  it("scopes a session lookup to the requesting key", () => {
    beginRoute(init({ requestId: "mine", keyId: "key-a" }));
    expect(latestFor("sess-1", "key-a")?.requestId).toBe("mine");
    expect(latestFor("sess-1", "key-b")).toBeUndefined();
  });

  it("returns recent traces newest first", () => {
    beginRoute(init({ requestId: "first", startedAt: Date.now() - 1000 }));
    beginRoute(init({ requestId: "second" }));
    expect(recentTraces().map((trace) => trace.requestId)).toEqual(["second", "first"]);
  });
});

describe("waitForSession", () => {
  it("resolves immediately when a newer trace already exists", async () => {
    const started = beginRoute(init());
    const trace = await waitForSession({
      session: "sess-1",
      after: started.seq - 1,
      waitMs: 5_000,
    });
    expect(trace?.requestId).toBe("req-1");
  });

  it("resolves when a change lands after the wait begins", async () => {
    const started = beginRoute(init());
    const pending = waitForSession({ session: "sess-1", after: started.seq, waitMs: 5_000 });
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    const trace = await pending;
    expect(trace?.tries).toHaveLength(1);
  });

  it("resolves null when the wait elapses with no change", async () => {
    const started = beginRoute(init());
    const trace = await waitForSession({ session: "sess-1", after: started.seq, waitMs: 10 });
    expect(trace).toBeNull();
  });

  it("does not wake a waiter watching a different session", async () => {
    const other = beginRoute(init({ requestId: "other", session: "sess-2" }));
    const pending = waitForSession({ session: "sess-2", after: other.seq, waitMs: 5_000 });
    beginTry("other", { provider: "a", model: "m1", cause: "initial" });
    expect(await pending).not.toBeNull();
  });

  it("does not wake a waiter scoped to another key", async () => {
    const started = beginRoute(init({ keyId: "key-a" }));
    const trace = await waitForSession({
      session: "sess-1",
      keyId: "key-b",
      after: started.seq,
      waitMs: 10,
    });
    expect(trace).toBeNull();
  });
});

describe("subscribeTraces", () => {
  it("delivers a clone on every change", () => {
    const seen: string[] = [];
    const unsubscribe = subscribeTraces((trace) => seen.push(trace.requestId));
    beginRoute(init());
    beginTry("req-1", { provider: "a", model: "m1", cause: "initial" });
    expect(seen).toEqual(["req-1", "req-1"]);
    unsubscribe();
    endTry("req-1", { status: 200 });
    expect(seen).toHaveLength(2);
  });

  it("does not leak a mutable view of the trace", () => {
    let snapshot: ReturnType<typeof traceFor>;
    subscribeTraces((trace) => {
      snapshot = trace;
    });
    beginRoute(init());
    snapshot!.tries.push({ provider: "x", model: "y", cause: "retry", startedAt: 0, done: true });
    expect(traceFor("req-1")!.tries).toEqual([]);
  });
});

describe("ring buffer", () => {
  it("keeps only the newest traces", () => {
    for (let index = 0; index < TRACE_KEEP + 20; index += 1) {
      beginRoute(init({ requestId: `req-${index}` }));
    }
    const recent = recentTraces(TRACE_KEEP + 20);
    expect(recent.length).toBe(TRACE_KEEP);
    expect(recent[0]?.requestId).toBe(`req-${TRACE_KEEP + 19}`);
  });

  it("never drops an in-flight trace in favour of a finished one", () => {
    const live = beginRoute(init({ requestId: "live" }));
    for (let index = 0; index < TRACE_KEEP + 5; index += 1) {
      beginRoute(init({ requestId: `done-${index}` }));
      finishRoute(`done-${index}`, { status: 200 });
    }
    expect(traceFor("live")?.seq).toBe(live.seq);
  });
});
