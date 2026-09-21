import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { appendRecord } from "./ledger";
import {
  anthropicWindowsFromHeaders,
  captureQuotaHeaders,
  captureUsageLimit,
  codexWindowsFromHeaders,
  headerQuotas,
  providerQuotaHealth,
  providerQuotas,
  providerSpendSignal,
  quotaStatePath,
  resetQuotaCache,
} from "./quota";

let dir = "";
let previousData: string | undefined;
let previousLedger: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-quota-"));
  previousData = process.env.JEVONIAN_DATA_DIR;
  previousLedger = process.env.JEVONIAN_LEDGER;
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  resetQuotaCache();
  const tokenPath = join(dir, "antigravity.json");
  writeFileSync(tokenPath, JSON.stringify({ token: { access_token: "test-quota-token" } }));
  vi.stubEnv("JEVONIAN_ANTIGRAVITY_TOKEN", tokenPath);
  vi.stubEnv("JEVONIAN_ANTIGRAVITY_PROJECT", "test-project");
});

afterEach(() => {
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  if (previousLedger === undefined) delete process.env.JEVONIAN_LEDGER;
  else process.env.JEVONIAN_LEDGER = previousLedger;
  resetQuotaCache();
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("providerSpendSignal", () => {
  it("treats HTTP 402 as billing regardless of body copy", () => {
    expect(providerSpendSignal(402, '{"error":{"message":"Insufficient Balance"}}')).toBe(
      "billing",
    );
    expect(providerSpendSignal(402, "Payment Required")).toBe("billing");
  });

  it("reads structured type/code tokens, not free-text messages", () => {
    expect(
      providerSpendSignal(
        429,
        JSON.stringify({ error: { type: "usage_limit_reached", message: "whatever marketing" } }),
      ),
    ).toBe("quota");
    expect(
      providerSpendSignal(
        429,
        JSON.stringify({
          type: "error",
          error: { type: "GoUsageLimitError", message: "Weekly usage limit reached." },
        }),
      ),
    ).toBe("quota");
    expect(
      providerSpendSignal(
        402,
        JSON.stringify({ error: { code: "insufficient_credits", message: "nope" } }),
      ),
    ).toBe("billing");
  });

  it("ignores transient rate limits that are not a spend signal", () => {
    expect(
      providerSpendSignal(
        429,
        JSON.stringify({
          error: {
            message: "You've exceeded the rate limit, please slow down",
            type: "invalid_request_error",
            code: "rate_limit_exceeded",
          },
        }),
      ),
    ).toBeUndefined();
    expect(providerSpendSignal(429, "The usage limit has been reached")).toBeUndefined();
  });
});

describe("quota headers", () => {
  it("parses Anthropic unified rate limit headers", () => {
    const headers = new Headers({
      "anthropic-ratelimit-unified-5h-utilization": "0.42",
      "anthropic-ratelimit-unified-5h-reset": "1700000000",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": "0.81",
      "anthropic-ratelimit-unified-7d-status": "allowed_warning",
    });
    const windows = anthropicWindowsFromHeaders(headers);
    expect(windows[0]).toMatchObject({ id: "5h", usedPercent: 42, status: "allowed" });
    expect(windows[0]?.resetsAt).toBe(new Date(1_700_000_000_000).toISOString());
    expect(windows[1]).toMatchObject({ id: "7d", usedPercent: 81, status: "allowed_warning" });
  });

  it("parses Codex rate limit headers", () => {
    const headers = new Headers({
      "x-codex-primary-used-percent": "12.5",
      "x-codex-primary-window-minutes": "300",
      "x-codex-primary-reset-at": "1700000000",
      "x-codex-secondary-used-percent": "6",
      "x-codex-secondary-window-minutes": "10080",
    });
    const windows = codexWindowsFromHeaders(headers);
    expect(windows[0]).toMatchObject({ id: "codex-primary", label: "5h", usedPercent: 12.5 });
    expect(windows[1]).toMatchObject({ id: "codex-secondary", label: "7d", usedPercent: 6 });
  });

  it("ignores responses without rate limit headers", () => {
    expect(anthropicWindowsFromHeaders(new Headers())).toEqual([]);
    expect(codexWindowsFromHeaders(new Headers())).toEqual([]);
  });

  it("persists captured headers for later reads", () => {
    const provider = parseConfig({
      providers: [
        {
          name: "claude-sub",
          type: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          auth: "oauth",
          oauthSource: "claude-code",
          billing: "subscription",
          models: ["claude-sonnet-4-6"],
        },
      ],
    }).providers[0];
    if (!provider) throw new Error("provider missing");
    captureQuotaHeaders(
      provider,
      new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.1" }),
    );
    expect(headerQuotas()["claude-sub"]?.windows[0]).toMatchObject({
      id: "5h",
      usedPercent: 10,
    });
    resetQuotaCache();
    expect(headerQuotas()["claude-sub"]?.windows[0]).toMatchObject({
      id: "5h",
      usedPercent: 10,
    });
  });

  it("refreshes a snapshot whose window fields stayed identical past the TTL", () => {
    const provider = parseConfig({
      providers: [
        {
          name: "chatgpt-subscription",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          auth: "oauth",
          oauthSource: "codex",
          billing: "subscription",
          models: ["gpt-6-astra"],
        },
      ],
    }).providers[0];
    if (!provider) throw new Error("provider missing");
    const headers = new Headers({
      "x-codex-primary-used-percent": "8",
      "x-codex-primary-window-minutes": "300",
      "x-codex-secondary-used-percent": "100",
      "x-codex-secondary-window-minutes": "10080",
      "x-codex-secondary-reset-at": "1790432990",
    });
    captureQuotaHeaders(provider, headers);
    const captured = headerQuotas()["chatgpt-subscription"];
    if (!captured) throw new Error("snapshot missing");
    expect(captured.windows[1]).toMatchObject({ id: "codex-secondary", usedPercent: 100 });

    // Backdate the persisted snapshot beyond the TTL, as if captured last period.
    const staleFetchedAt = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    writeFileSync(
      quotaStatePath(),
      `${JSON.stringify({
        "chatgpt-subscription": { windows: captured.windows, fetchedAt: staleFetchedAt },
      })}\n`,
    );
    resetQuotaCache();
    expect(headerQuotas()["chatgpt-subscription"]?.fetchedAt).toBe(staleFetchedAt);

    // Same window fields, but the snapshot is stale so it must be rewritten.
    captureQuotaHeaders(provider, headers);
    const refreshed = headerQuotas()["chatgpt-subscription"];
    expect(refreshed?.fetchedAt).not.toBe(staleFetchedAt);
    expect(Date.parse(refreshed?.fetchedAt ?? "")).toBeGreaterThan(Date.parse(staleFetchedAt));
  });

  it("marks a provider exhausted from an OpenCode Go weekly limit 429", () => {
    const provider = parseConfig({
      providers: [
        {
          name: "opencode-go",
          type: "both",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "key",
          billing: "subscription",
          models: ["claude-haiku-4-5-20251001"],
        },
      ],
    }).providers[0]!;
    captureUsageLimit(
      provider,
      429,
      JSON.stringify({
        type: "error",
        error: {
          type: "GoUsageLimitError",
          message: "Weekly usage limit reached. Resets in 9hr 27min.",
        },
      }),
    );
    const stored = headerQuotas()["opencode-go"];
    expect(stored?.windows[0]).toMatchObject({
      id: "week",
      usedPercent: 100,
    });
    expect(stored?.windows[0]?.resetsAt).toBeDefined();
    expect(providerQuotaHealth(provider).status).toBe("exhausted");
  });

  it("marks ChatGPT exhausted from usage_limit_reached and parses resets_at", () => {
    const provider = parseConfig({
      providers: [
        {
          name: "chatgpt-subscription",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiKey: "key",
          billing: "subscription",
          models: ["gpt-6-astra"],
        },
      ],
    }).providers[0]!;
    const resetsAt = Math.floor(Date.now() / 1000) + 11_163;
    captureUsageLimit(
      provider,
      429,
      JSON.stringify({
        error: {
          type: "usage_limit_reached",
          message: "The usage limit has been reached",
          plan_type: "plus",
          resets_at: resetsAt,
          resets_in_seconds: 11163,
        },
      }),
    );
    const stored = headerQuotas()["chatgpt-subscription"];
    expect(stored?.windows[0]).toMatchObject({
      id: "limit",
      usedPercent: 100,
      resetsAt: new Date(resetsAt * 1000).toISOString(),
    });
    expect(providerQuotaHealth(provider).status).toBe("exhausted");
  });

  it("marks a provider exhausted from a 402 Insufficient Balance", () => {
    const provider = parseConfig({
      providers: [
        {
          name: "deepseek",
          type: "both",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "key",
          models: ["deepseek-flash"],
        },
      ],
    }).providers[0]!;
    expect(
      captureUsageLimit(
        provider,
        402,
        JSON.stringify({
          error: {
            message: "Insufficient Balance",
            type: "unknown_error",
            code: "invalid_request_error",
          },
        }),
      ),
    ).toBe(true);
    expect(headerQuotas().deepseek?.windows[0]).toMatchObject({
      id: "balance",
      usedPercent: 100,
    });
    expect(providerQuotaHealth(provider).status).toBe("exhausted");
  });

  it("serves a stale snapshot with an age note instead of implying it is current", async () => {
    const config = parseConfig({
      providers: [
        {
          name: "opencode",
          type: "openai",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "bad-key",
          billing: "subscription",
          models: ["opencode-go/kimi-k3"],
        },
      ],
    });
    const fetchedAt = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
    writeFileSync(
      quotaStatePath(),
      `${JSON.stringify({
        opencode: { windows: [{ id: "week", label: "week", usedPercent: 0 }], fetchedAt },
      })}\n`,
    );
    // The live endpoint is unreachable, so the on-disk snapshot is all we have.
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }));

    const quotas = await providerQuotas(config, { refresh: true });
    expect(quotas[0]?.source).toBe("headers");
    expect(quotas[0]?.error).toContain("rejected the key");
    // The numbers are still served, but the age must be disclosed.
    expect(quotas[0]?.windows[0]?.usedPercent).toBe(0);
    expect(quotas[0]?.note).toBe("measured 7d ago");
    expect(quotas[0]?.fetchedAt).toBe(fetchedAt);
  });

  it("does not flag a freshly captured snapshot as stale", async () => {
    const config = parseConfig({
      providers: [
        {
          name: "opencode",
          type: "openai",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "bad-key",
          billing: "subscription",
          models: ["opencode-go/kimi-k3"],
        },
      ],
    });
    writeFileSync(
      quotaStatePath(),
      `${JSON.stringify({
        opencode: {
          windows: [{ id: "week", label: "week", usedPercent: 0 }],
          fetchedAt: new Date().toISOString(),
        },
      })}\n`,
    );
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 401 }));

    const quotas = await providerQuotas(config, { refresh: true });
    expect(quotas[0]?.source).toBe("headers");
    expect(quotas[0]?.note).toBeUndefined();
  });

  it("flags a stale snapshot in quota health so routing can distrust it", () => {
    const provider = parseConfig({
      providers: [
        {
          name: "claude-sub",
          type: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          auth: "oauth",
          oauthSource: "claude-code",
          billing: "subscription",
          models: ["claude-sonnet-4-6"],
        },
      ],
    }).providers[0];
    if (!provider) throw new Error("provider missing");
    captureQuotaHeaders(
      provider,
      new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.0" }),
    );
    const captured = headerQuotas()["claude-sub"];
    if (!captured) throw new Error("snapshot missing");
    writeFileSync(
      quotaStatePath(),
      `${JSON.stringify({
        "claude-sub": {
          windows: captured.windows,
          fetchedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        },
      })}\n`,
    );
    resetQuotaCache();

    const health = providerQuotaHealth(provider);
    // 0% used looks perfectly healthy, which is exactly why it must be labelled.
    expect(health.status).toBe("ok");
    expect(health.note).toBe("stale snapshot (measured 3h ago)");
  });

  it("splits Antigravity quota by counter instead of collapsing to one minimum", async () => {
    const config = parseConfig({
      providers: [
        {
          name: "antigravity",
          type: "gemini",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          auth: "oauth",
          oauthSource: "antigravity",
          billing: "subscription",
          models: ["gemini-3.6-flash"],
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            models: {
              // Google counter is nearly exhausted ...
              "gemini-3.6-flash": {
                modelProvider: "MODEL_PROVIDER_GOOGLE",
                quotaInfo: { remainingFraction: 0.05, resetTime: "2026-09-19T17:14:32Z" },
              },
              "gemini-3.1-pro-high": {
                modelProvider: "MODEL_PROVIDER_GOOGLE",
                quotaInfo: { remainingFraction: 0.05, resetTime: "2026-09-19T17:14:32Z" },
              },
              // ... while the Anthropic counter is untouched. Collapsing both to a
              // single minimum would report "5% left" for everything.
              "claude-sonnet-4-6": {
                modelProvider: "MODEL_PROVIDER_ANTHROPIC",
                quotaInfo: { remainingFraction: 1, resetTime: "2026-09-19T21:51:36Z" },
              },
              "gpt-oss-120b-medium": {
                modelProvider: "MODEL_PROVIDER_OPENAI",
                quotaInfo: { remainingFraction: 1, resetTime: "2026-09-19T21:51:36Z" },
              },
            },
          }),
          { status: 200 },
        ),
    );

    const quotas = await providerQuotas(config, { refresh: true });
    const windows = quotas[0]?.windows ?? [];
    expect(quotas[0]?.source).toBe("live");
    // One window per counter, in a stable gemini -> claude -> openai order.
    expect(windows.map((w) => w.label)).toEqual(["gemini", "claude", "openai"]);
    expect(windows[0]?.usedPercent).toBeCloseTo(95);
    expect(windows[0]?.resetsAt).toBe("2026-09-19T17:14:32.000Z");
    // The healthy counters must not be dragged down by the exhausted one.
    expect(windows[1]?.usedPercent).toBe(0);
    expect(windows[2]?.usedPercent).toBe(0);
    expect(quotas[0]?.note).toBe("3 quota counters");
  });

  it("ignores Antigravity models that carry no quota info", async () => {
    const config = parseConfig({
      providers: [
        {
          name: "antigravity",
          type: "gemini",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          auth: "oauth",
          oauthSource: "antigravity",
          billing: "subscription",
          models: ["gemini-3.6-flash"],
        },
      ],
    });
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            models: {
              tab_flash_lite_preview: { modelProvider: "MODEL_PROVIDER_GOOGLE" },
              "gemini-3.6-flash": {
                modelProvider: "MODEL_PROVIDER_GOOGLE",
                quotaInfo: { remainingFraction: 0.5, resetTime: "2026-09-19T17:14:32Z" },
              },
            },
          }),
          { status: 200 },
        ),
    );

    const quotas = await providerQuotas(config, { refresh: true });
    expect(quotas[0]?.windows.map((w) => w.label)).toEqual(["gemini"]);
    expect(quotas[0]?.windows[0]?.usedPercent).toBeCloseTo(50);
    // A single counter needs no explanatory note.
    expect(quotas[0]?.note).toBeUndefined();
  });

  it("reads live windows from the OpenCode Go usage endpoint", async () => {
    const config = parseConfig({
      providers: [
        {
          name: "opencode-go",
          type: "openai",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "test",
          billing: "subscription",
          models: ["opencode-go/kimi-k3"],
        },
      ],
    });
    let requestedUrl = "";
    vi.stubGlobal("fetch", async (url: string) => {
      requestedUrl = url;
      return new Response(
        JSON.stringify({
          usage: {
            rolling: { status: "ok", percent: 4, resetsAt: "2026-08-13T16:27:38.287Z" },
            weekly: { status: "ok", percent: 3, resetsAt: "2026-08-17T00:00:00.287Z" },
            monthly: { status: "ok", percent: 1, resetsAt: "2026-09-13T06:06:01.287Z" },
          },
        }),
        { status: 200 },
      );
    });
    const quotas = await providerQuotas(config);
    expect(requestedUrl).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(quotas[0]?.source).toBe("live");
    expect(quotas[0]?.windows.map((window) => window.label)).toEqual(["5h", "week", "month"]);
    expect(quotas[0]?.windows[0]?.usedPercent).toBe(4);
    expect(quotas[0]?.windows[2]?.usedPercent).toBe(1);
  });

  it.each([0, 0.5, 1, 2, 50, 100])(
    "keeps OpenCode Go percent %s in percentage units",
    async (usedPercent) => {
      const config = parseConfig({
        providers: [
          {
            name: "opencode-go",
            type: "openai",
            baseUrl: "https://opencode.ai/zen/go/v1",
            apiKey: "test",
            billing: "subscription",
            models: ["deepseek-v4.1-flash"],
          },
        ],
      });
      vi.stubGlobal(
        "fetch",
        async () =>
          new Response(
            JSON.stringify({
              usage: { weekly: { status: "ok", percent: usedPercent } },
            }),
          ),
      );

      const quotas = await providerQuotas(config, { refresh: true });
      expect(quotas[0]?.windows[0]?.usedPercent).toBe(usedPercent);
      expect(providerQuotaHealth(config.providers[0]!).status).toBe(
        usedPercent === 100 ? "exhausted" : "ok",
      );
    },
  );

  it("reads DeepSeek, OpenRouter, and Moonshot balances", async () => {
    const config = parseConfig({
      providers: [
        {
          name: "deepseek",
          type: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "test",
          models: ["deepseek-v4-pro"],
        },
        {
          name: "openrouter",
          type: "openai",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "test",
          models: ["openai/gpt-6-astra"],
        },
        {
          name: "moonshotai",
          type: "openai",
          baseUrl: "https://api.moonshot.ai/v1",
          apiKey: "test",
          models: ["kimi-k3"],
        },
      ],
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("deepseek.com")) {
        return new Response(
          JSON.stringify({
            is_available: true,
            balance_infos: [{ currency: "CNY", total_balance: "4.02" }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("openrouter.ai")) {
        return new Response(JSON.stringify({ data: { total_credits: 24.4, total_usage: 20.83 } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({ code: 0, data: { available_balance: 12.5 } }), {
        status: 200,
      });
    });
    const quotas = await providerQuotas(config);
    const deepseek = quotas.find((quota) => quota.provider === "deepseek");
    expect(deepseek?.source).toBe("live");
    expect(deepseek?.balance).toEqual({ amount: 4.02, currency: "CNY" });
    const openrouter = quotas.find((quota) => quota.provider === "openrouter");
    expect(openrouter?.balance?.amount).toBeCloseTo(3.57);
    expect(openrouter?.balance?.currency).toBe("USD");
    const moonshot = quotas.find((quota) => quota.provider === "moonshotai");
    expect(moonshot?.balance?.amount).toBeCloseTo(12.5);
  });

  it("falls back to the ledger for subscription providers with caps", async () => {
    const config = parseConfig({
      providers: [
        {
          name: "custom-sub",
          type: "openai",
          baseUrl: "https://subscription.example.com/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 14, weeklyUsd: 35, monthlyUsd: 70 },
          models: ["taste-1"],
        },
      ],
    });
    appendRecord({
      ts: new Date().toISOString(),
      session: "s",
      path: "/chat/completions",
      provider: "custom-sub",
      model: "taste-1",
      stream: false,
      status: 200,
      latencyMs: 10,
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 7,
      pricingKnown: true,
      billing: "subscription",
    });
    const quotas = await providerQuotas(config);
    expect(quotas[0]?.source).toBe("ledger");
    expect(quotas[0]?.spend.fiveHourUsd).toBe(7);
    expect(quotas[0]?.windows.find((window) => window.id === "5h")?.usedPercent).toBeCloseTo(50);
    expect(quotas[0]?.windows.find((window) => window.id === "month")?.usedPercent).toBeCloseTo(10);
  });
});
