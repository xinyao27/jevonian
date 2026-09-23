import { describe, expect, it, vi } from "vite-plus/test";

import {
  configuredRetries,
  isRetryableFetchError,
  isRetryableStatus,
  retryDelayMs,
  withRetry,
} from "./retry";

/** The shape Node's fetch produces for a transport failure: a wrapper plus the real cause. */
function fetchFailure(code: string, message = "fetch failed"): TypeError {
  return Object.assign(new TypeError(message), {
    cause: Object.assign(new Error("other side closed"), { code }),
  });
}

const noSleep = async (): Promise<void> => {};

describe("isRetryableFetchError", () => {
  it("recognises a proxy reset buried under the fetch wrapper", () => {
    expect(isRetryableFetchError(fetchFailure("UND_ERR_SOCKET"))).toBe(true);
    expect(isRetryableFetchError(fetchFailure("ECONNRESET"))).toBe(true);
    expect(isRetryableFetchError(fetchFailure("ETIMEDOUT"))).toBe(true);
    expect(isRetryableFetchError(fetchFailure("ENOTFOUND"))).toBe(true);
  });

  it("recognises the message-only shapes with no code", () => {
    expect(isRetryableFetchError(new TypeError("fetch failed"))).toBe(true);
    expect(isRetryableFetchError(new Error("terminated"))).toBe(true);
    expect(isRetryableFetchError(new Error("socket hang up"))).toBe(true);
  });

  it("leaves a caller's abort alone, because that is not the network failing", () => {
    const abort = Object.assign(new Error("This operation was aborted"), { name: "AbortError" });
    expect(isRetryableFetchError(abort)).toBe(false);
  });

  it("leaves ordinary errors alone", () => {
    expect(isRetryableFetchError(new Error("Invalid JSON body"))).toBe(false);
    expect(isRetryableFetchError(undefined)).toBe(false);
  });
});

describe("configuredRetries", () => {
  it("defaults to two retries when nothing is set", () => {
    expect(configuredRetries({})).toBe(2);
  });

  it("reads an explicit budget, including zero", () => {
    expect(configuredRetries({ JEVONIAN_UPSTREAM_RETRIES: "1" })).toBe(1);
    expect(configuredRetries({ JEVONIAN_UPSTREAM_RETRIES: "0" })).toBe(0);
  });

  it("falls back rather than disabling retries on a typo, and caps the budget", () => {
    expect(configuredRetries({ JEVONIAN_UPSTREAM_RETRIES: "lots" })).toBe(2);
    expect(configuredRetries({ JEVONIAN_UPSTREAM_RETRIES: "-3" })).toBe(2);
    expect(configuredRetries({ JEVONIAN_UPSTREAM_RETRIES: "99" })).toBe(5);
  });
});

describe("retryDelayMs", () => {
  it("grows with the attempt and stays inside the jittered ceiling", () => {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const delay = retryDelayMs(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(2_000);
    }
    const sample = Array.from({ length: 40 }, () => retryDelayMs(3));
    expect(Math.max(...sample)).toBeGreaterThan(Math.min(...sample));
  });
});

describe("isRetryableStatus", () => {
  it("repeats the statuses a gateway emits while it is briefly unavailable", () => {
    for (const status of [408, 500, 502, 503, 504]) {
      expect(isRetryableStatus(status)).toBe(true);
    }
  });

  it("leaves verdicts about the request or the quota to the caller", () => {
    for (const status of [400, 401, 402, 403, 404, 422, 429]) {
      expect(isRetryableStatus(status)).toBe(false);
    }
  });
});

/** The retry policy the upstream path applies: transient statuses only, transport throws too. */
function retryWhenStatusIsTransient(response: Response) {
  return isRetryableStatus(response.status) ? { status: response.status } : undefined;
}

describe("withRetry", () => {
  it("returns the first successful response without retrying", async () => {
    const send = vi.fn(async () => new Response("ok", { status: 200 }));
    const onRetry = vi.fn();
    const response = await withRetry(send, {
      attempts: 3,
      retryWhen: retryWhenStatusIsTransient,
      onRetry,
      sleep: noSleep,
    });
    expect(response.status).toBe(200);
    expect(send).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a transport failure and returns the recovered response", async () => {
    let calls = 0;
    const send = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) throw fetchFailure("ECONNRESET");
      return new Response("ok", { status: 200 });
    };
    const onRetry = vi.fn();
    const response = await withRetry(send, {
      attempts: 3,
      retryWhen: retryWhenStatusIsTransient,
      onRetry,
      sleep: noSleep,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1 });
  });

  it("gives up after the configured attempts and rethrows the last error", async () => {
    const send = vi.fn(async () => {
      throw fetchFailure("UND_ERR_SOCKET");
    });
    await expect(
      withRetry(send, { attempts: 3, retryWhen: retryWhenStatusIsTransient, sleep: noSleep }),
    ).rejects.toThrow("fetch failed");
    expect(send).toHaveBeenCalledTimes(3);
  });

  it("does not retry a non-retryable error", async () => {
    const send = vi.fn(async () => {
      throw new Error("Invalid JSON body");
    });
    await expect(
      withRetry(send, { attempts: 3, retryWhen: retryWhenStatusIsTransient, sleep: noSleep }),
    ).rejects.toThrow("Invalid JSON body");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("retries a gateway 502 and releases the discarded body first", async () => {
    let calls = 0;
    let cancelled = false;
    const send = async (): Promise<Response> => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          new ReadableStream({
            cancel: () => {
              cancelled = true;
            },
          }),
          { status: 502 },
        );
      }
      return new Response("ok", { status: 200 });
    };
    const response = await withRetry(send, {
      attempts: 3,
      retryWhen: retryWhenStatusIsTransient,
      discard: async (response) => response.body?.cancel(),
      sleep: noSleep,
    });
    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(cancelled).toBe(true);
  });

  it("returns the last retryable status once the budget is spent, rather than throwing", async () => {
    const send = vi.fn(async () => new Response("bad gateway", { status: 503 }));
    const response = await withRetry(send, {
      attempts: 2,
      retryWhen: retryWhenStatusIsTransient,
      sleep: noSleep,
    });
    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(2);
    expect(await response.text()).toBe("bad gateway");
  });

  it("leaves a 429 to the caller, so quota failover stays in charge", async () => {
    const send = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const response = await withRetry(send, {
      attempts: 3,
      retryWhen: retryWhenStatusIsTransient,
      sleep: noSleep,
    });
    expect(response.status).toBe(429);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("leaves a 400 to the caller, because the request itself is wrong", async () => {
    const send = vi.fn(async () => new Response("bad request", { status: 400 }));
    const response = await withRetry(send, {
      attempts: 3,
      retryWhen: retryWhenStatusIsTransient,
      sleep: noSleep,
    });
    expect(response.status).toBe(400);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("makes a single attempt when the budget is zero", async () => {
    const send = vi.fn(async () => new Response("bad gateway", { status: 502 }));
    const response = await withRetry(send, {
      attempts: 1,
      retryWhen: retryWhenStatusIsTransient,
      sleep: noSleep,
    });
    expect(response.status).toBe(502);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("carries no status requirement when the caller passes no policy", async () => {
    const send = vi.fn(async () => new Response("nope", { status: 500 }));
    const response = await withRetry(send, { attempts: 3, sleep: noSleep });
    expect(response.status).toBe(500);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
