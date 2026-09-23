/**
 * Retries for upstream calls that failed for reasons the network owns.
 *
 * A coding-agent turn is expensive to lose: the client has already assembled a large context
 * and the user is watching the spinner. The failures that reach this module are rarely the
 * model refusing — they are a local proxy resetting the socket, a DNS lookup timing out, or a
 * gateway answering 502 while it restarts. The same request almost always succeeds on the next
 * attempt, so repeating it here is far cheaper than making the agent re-drive the whole turn.
 *
 * Only a request that failed *before* anything reached the client is retried. Once a body is
 * streaming there is nothing to rewind, so a mid-stream failure is left to the caller.
 */

/** Transport codes that mean "the connection failed", never "the request was wrong". */
const RETRYABLE_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  "EAI_AGAIN",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
]);

/** Node's fetch hides the real cause behind this wrapper, so the message is worth matching. */
const RETRYABLE_MESSAGES = [
  /fetch failed/i,
  /terminated/i,
  /other side closed/i,
  /socket hang up/i,
];

/** Statuses a gateway emits while it is briefly unavailable; the same host may recover. */
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);

/** Retries after the first attempt. Three attempts total, so one bad window is absorbed. */
const DEFAULT_RETRIES = 2;

/** A ceiling for `JEVONIAN_UPSTREAM_RETRIES`, so a typo cannot turn into a retry storm. */
const MAX_RETRIES = 5;

const BASE_DELAY_MS = 250;
const MAX_DELAY_MS = 2_000;

/**
 * True when a thrown fetch error looks like a transport failure worth repeating.
 *
 * Walks the `cause` chain, because Node reports every transport problem as a bare
 * `TypeError: fetch failed` and puts the actual code — DNS, a refused connection, a proxy that
 * will not tunnel — underneath. A deliberate abort is not retried: that is the caller giving
 * up, not the network failing.
 *
 * Broader on purpose than `isTransientProxyError` in `./proxy`, which decides whether a stray
 * rejection is safe to swallow. Retrying is harmless even when the cause is a DNS blip, so this
 * one accepts more shapes.
 */
export function isRetryableFetchError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth += 1) {
    // Bound to a const so the narrowing survives into the message callbacks below.
    const failure: Error = current;
    if (failure.name === "AbortError") return false;
    const code = (failure as { code?: unknown }).code;
    if (typeof code === "string" && RETRYABLE_CODES.has(code)) return true;
    if (RETRYABLE_MESSAGES.some((pattern) => pattern.test(failure.message))) return true;
    current = (failure as { cause?: unknown }).cause;
  }
  return false;
}

/** True when an upstream status is one a second attempt may turn into a success. */
export function isRetryableStatus(status: number): boolean {
  return RETRYABLE_STATUS.has(status);
}

/** The retry policy every Jevonian egress uses: transport throws plus "the host could not answer". */
export function retryTransient<T extends { status: number }>(outcome: T): RetryFailure | undefined {
  return isRetryableStatus(outcome.status) ? { status: outcome.status } : undefined;
}

/**
 * A `fetch` that repeats a transient failure instead of handing it to the caller.
 *
 * For the calls that sit on the critical path but are not the model request itself — the
 * routing brain, a token refresh, a desktop passthrough — where a single dropped socket would
 * otherwise fail the turn before the model is even asked.
 *
 * `label` names the caller in `serve.log`, so a flaky link stays diagnosable. Pass it for
 * anything a user would notice; leave it out for a background refresh nobody is waiting on.
 */
export async function retryingFetch(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  options: { label?: string } = {},
): Promise<Response> {
  const budget = configuredRetries();
  return withRetry(() => fetch(input, init), {
    attempts: budget + 1,
    retryWhen: retryTransient,
    discard: async (response) => response.body?.cancel(),
    ...(options.label
      ? {
          onRetry: ({ attempt, delayMs, failure }: RetryAttempt): void => {
            console.warn(
              `${options.label} retry ${attempt}/${budget} in ${delayMs}ms: ${describeFailure(failure)}`,
            );
          },
        }
      : {}),
  });
}

/** One line naming what an attempt failed on, for the log. */
export function describeFailure(failure: RetryFailure): string {
  if ("status" in failure) return `HTTP ${failure.status}`;
  return describeFetchError(failure.error);
}

/**
 * Compact chain of `message [code]` for a fetch failure.
 *
 * Node's fetch reports every transport problem as a bare "TypeError: fetch failed" and buries
 * the reason — DNS, a refused connection, a proxy that will not tunnel — in `cause`. Without it
 * a failed turn says nothing about what to fix.
 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && parts.length < 5) {
    const code = (current as { code?: unknown }).code;
    parts.push(typeof code === "string" ? `${current.message} [${code}]` : current.message);
    current = (current as { cause?: unknown }).cause;
  }
  return parts.length === 0 ? String(error) : parts.join(" caused by ");
}

/** Retries to allow after the first attempt, from `JEVONIAN_UPSTREAM_RETRIES`. */
export function configuredRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.JEVONIAN_UPSTREAM_RETRIES ?? "").trim();
  if (raw.length === 0) return DEFAULT_RETRIES;
  const parsed = Number.parseInt(raw, 10);
  // An unparseable or negative value falls back to the default rather than disabling retries:
  // a typo should not silently turn off the stability this exists to provide.
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETRIES;
  return Math.min(parsed, MAX_RETRIES);
}

/** Exponential backoff with jitter, so a burst of turns does not retry in lockstep. */
export function retryDelayMs(attempt: number): number {
  const backoff = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** (attempt - 1));
  return Math.round(backoff * (0.5 + Math.random() * 0.5));
}

/** What made an attempt fail: a thrown transport error, or a retryable outcome. */
export type RetryFailure = { error: unknown } | { status: number };

export interface RetryAttempt {
  /** 1-based index of the attempt that just failed. */
  attempt: number;
  /** Milliseconds to wait before the next attempt. */
  delayMs: number;
  failure: RetryFailure;
}

export interface RetryOptions<T> {
  /** Total attempts including the first. Defaults to three. */
  attempts?: number;
  /**
   * Whether a returned outcome is worth repeating, and how to describe it. Returning undefined
   * accepts the outcome as final — so a 429, which another host should serve, is left alone.
   */
  retryWhen?: (outcome: T) => RetryFailure | undefined;
  /** Releases an outcome that is being thrown away, such as an unread response body. */
  discard?: (outcome: T) => void | Promise<void>;
  /** Called before each retry, so the caller can log or count it. */
  onRetry?: (info: RetryAttempt) => void;
  /** Injectable sleep, so tests do not pay real backoff. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs `run`, repeating it while the failure looks transient and attempts remain.
 *
 * A throw is retried when {@link isRetryableFetchError} recognises it; a returned outcome is
 * retried when `retryWhen` says so. The last outcome is returned even when it is still
 * retryable: an exhausted retry is the caller's to interpret, not this helper's.
 */
export async function withRetry<T>(
  run: () => Promise<T>,
  options: RetryOptions<T> = {},
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 1 + DEFAULT_RETRIES);
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    let outcome: T;
    try {
      outcome = await run();
    } catch (error) {
      if (attempt >= attempts || !isRetryableFetchError(error)) throw error;
      const delayMs = retryDelayMs(attempt);
      options.onRetry?.({ attempt, delayMs, failure: { error } });
      await sleep(delayMs);
      continue;
    }
    const failure = options.retryWhen?.(outcome);
    if (attempt >= attempts || failure === undefined) return outcome;
    await options.discard?.(outcome);
    const delayMs = retryDelayMs(attempt);
    options.onRetry?.({ attempt, delayMs, failure });
    await sleep(delayMs);
  }
}
