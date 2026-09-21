import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { appendRecord } from "./ledger";
import { providerQuotaHealth, resetQuotaCache } from "./quota";
import { decideRoute, SessionStore } from "./routing";

let dir = "";
let previousData: string | undefined;
let previousLedger: string | undefined;
let previousBrainKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-guard-"));
  previousData = process.env.JEVONIAN_DATA_DIR;
  previousLedger = process.env.JEVONIAN_LEDGER;
  previousBrainKey = process.env.TYPESAFE_API_KEY;
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.TYPESAFE_API_KEY = "test-key";
  resetQuotaCache();
  // A dependable brain: it names the first routing it is offered, so every assertion here is
  // about what the router put in front of it rather than about the brain's judgement.
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse((init.body as string) ?? "{}") as { state?: Record<string, unknown> };
    const routings = Array.isArray(body.state?.routings)
      ? (body.state?.routings as Array<{ id: string }>)
      : [];
    const choice =
      typeof body.state?.prefer === "string"
        ? body.state.prefer
        : (routings[0]?.id ?? "none_of_the_above");
    return new Response(
      JSON.stringify({ model: "jev-1.13.0", answers: { model: { choice, confidence: 0.9 } } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  if (previousLedger === undefined) delete process.env.JEVONIAN_LEDGER;
  else process.env.JEVONIAN_LEDGER = previousLedger;
  if (previousBrainKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousBrainKey;
  resetQuotaCache();
  rmSync(dir, { recursive: true, force: true });
});

// Every routing decision in this file comes from the brain, so the candidates it was shown
// are what the quota guard actually filtered.
const BRAINS = [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }];

async function shownCandidates(config: ReturnType<typeof twoProviderConfig>) {
  let shown: Array<{ model: string; provider: string }> = [];
  let shownRoutings: Array<{ id: string }> = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse((init.body as string) ?? "{}") as { state?: Record<string, unknown> };
    shown = (body.state?.candidates ?? []) as Array<{ model: string; provider: string }>;
    shownRoutings = (body.state?.routings ?? []) as Array<{ id: string }>;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          model: { choice: shownRoutings[0]?.id ?? "none_of_the_above", confidence: 0.9 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  const decision = await decideRoute({
    config,
    body: { model: "auto", messages: [{ role: "user", content: "build a cache layer" }] },
    headers: {},
    store: new SessionStore(60_000),
    kind: "openai",
    now: 1_000,
  });
  if ("error" in decision) throw new Error(decision.error);
  return {
    shown: shown.map((candidate) => ({ model: candidate.model, provider: candidate.provider })),
    shownRoutings,
    decision,
  };
}

function spend(provider: string, costUsd: number, requests = 1): void {
  for (let index = 0; index < requests; index += 1) {
    appendRecord({
      ts: new Date().toISOString(),
      session: "s",
      path: "/chat/completions",
      provider,
      model: "m",
      stream: false,
      status: 200,
      latencyMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      pricingKnown: true,
      billing: "subscription",
    });
  }
}

const twoProviderConfig = (quotaGuard?: Record<string, unknown>) =>
  parseConfig({
    defaultProvider: "sub-a",
    providers: [
      {
        name: "sub-a",
        type: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        billing: "subscription",
        quota: { fiveHourUsd: 10, monthlyUsd: 100 },
        models: ["model-a"],
      },
      {
        name: "sub-b",
        type: "openai",
        baseUrl: "http://127.0.0.1:2/v1",
        apiKey: "test",
        billing: "subscription",
        quota: { fiveHourUsd: 10, monthlyUsd: 100 },
        models: ["model-b"],
      },
    ],
    routing: {
      brains: BRAINS,
      tiers: { plan: ["model-a", "model-b"], execute: [], utility: [], chat: [] },
      ...(quotaGuard ? { quotaGuard } : {}),
    },
  });

describe("providerQuotaHealth", () => {
  it("marks a provider low when remaining percent is under the threshold", () => {
    spend("sub-a", 9.5);
    const config = twoProviderConfig();
    const provider = config.providers[0];
    if (!provider) throw new Error("missing provider");
    const health = providerQuotaHealth(provider, { lowPercent: 10 });
    expect(health.status).toBe("low");
    expect(health.remainingPercent).toBeCloseTo(5);
    expect(health.remainingUsd).toBeCloseTo(0.5);
  });

  it("marks a provider exhausted once the window is spent", () => {
    spend("sub-a", 10);
    const config = twoProviderConfig();
    const provider = config.providers[0];
    if (!provider) throw new Error("missing provider");
    expect(providerQuotaHealth(provider, { lowPercent: 10 }).status).toBe("exhausted");
  });

  it("marks a provider low when the remaining budget cannot fund a few more requests", () => {
    spend("sub-a", 0.5, 5);
    spend("sub-a", 4.5);
    const config = twoProviderConfig();
    const provider = config.providers[0];
    if (!provider) throw new Error("missing provider");
    const health = providerQuotaHealth(provider, { lowPercent: 0 });
    expect(health.remainingPercent).toBeCloseTo(30);
    expect(health.remainingUsd).toBeCloseTo(3);
    expect(health.avgRequestUsd).toBeCloseTo(7 / 6);
    expect(health.status).toBe("low");
  });

  it("marks a provider exhausted when the remaining budget cannot fund one request", () => {
    spend("sub-a", 0.5, 5);
    spend("sub-a", 7.2);
    const config = twoProviderConfig();
    const provider = config.providers[0];
    if (!provider) throw new Error("missing provider");
    const health = providerQuotaHealth(provider, { lowPercent: 0 });
    expect(health.remainingUsd).toBeCloseTo(0.3);
    expect(health.status).toBe("exhausted");
  });
});

describe("the quota guard narrows what the brain is offered", () => {
  it("hides an exhausted provider when a healthier one offers a tiered model", async () => {
    spend("sub-a", 10);
    const { shown } = await shownCandidates(twoProviderConfig());
    expect(shown.map((candidate) => candidate.provider)).toEqual(["sub-b"]);
  });

  it("hides one provider of a shared model and keeps the other", async () => {
    spend("sub-a", 10);
    const config = parseConfig({
      defaultProvider: "sub-a",
      providers: [
        {
          name: "sub-a",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["shared-model"],
        },
        {
          name: "sub-b",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["shared-model"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: { plan: ["shared-model"], execute: [], utility: [], chat: [] },
      },
    });
    const { shown, decision } = await shownCandidates(config);
    expect(shown).toEqual([{ provider: "sub-b", model: "shared-model" }]);
    expect(decision.provider).toBe("sub-b");
    expect(decision.reason).toContain("quota-skip");
  });

  it("offers the whole list when the guard is disabled", async () => {
    spend("sub-a", 10);
    const { shown, decision } = await shownCandidates(twoProviderConfig({ enabled: false }));
    expect(shown.map((candidate) => candidate.provider)).toEqual(["sub-a", "sub-b"]);
    expect(decision.provider).toBe("sub-a");
    expect(decision.reason).not.toContain("quota-skip");
  });

  it("keeps an exhausted provider when nothing healthier exists anywhere", async () => {
    spend("sub-a", 10);
    const config = twoProviderConfig();
    const { applyTiersToRoutings, syncRoutingViews } = await import("./config");
    config.routing = syncRoutingViews({
      ...config.routing,
      routings: applyTiersToRoutings(config.routing.routings, {
        plan: ["model-a"],
        execute: [],
        utility: [],
        chat: [],
      }),
    });
    const { shown, decision } = await shownCandidates(config);
    // Every provider is exhausted, so the guard yields to "a turn must still be served".
    expect(shown).toEqual([{ provider: "sub-a", model: "model-a" }]);
    expect(decision.provider).toBe("sub-a");
    // Nothing was skipped, so no quota note is added.
    expect(decision.reason).not.toContain("quota-skip");
  });

  it("widens an exhausted explicit utility tier instead of pinning the OpenCode haiku probe", async () => {
    // OpenCode's connection check sends the haiku stand-in → jevonian/utility. When that
    // tier's only provider is spent, aggregated routing must fall across to a healthy one.
    spend("opencode-go", 10);
    const config = parseConfig({
      defaultProvider: "opencode-go",
      providers: [
        {
          name: "opencode-go",
          type: "both",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["claude-haiku-4-5-20251001"],
        },
        {
          name: "deepseek",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: {
          plan: ["deepseek-v4.1-flash"],
          execute: [],
          utility: ["claude-haiku-4-5-20251001"],
          chat: [],
        },
      },
    });
    const decision = await decideRoute({
      config,
      body: { model: "jevonian/utility", messages: [{ role: "user", content: "hi" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "anthropic",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.provider).toBe("deepseek");
    expect(decision.model).toBe("deepseek-v4.1-flash");
    expect(decision.reason).toContain("quota-fallback");
  });

  it("promotes a legacy OpenRouter openai type to both for Anthropic candidates", async () => {
    spend("opencode-go", 10);
    spend("commandcode", 10);
    const config = parseConfig({
      defaultProvider: "opencode-go",
      providers: [
        {
          name: "opencode-go",
          type: "both",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["deepseek-v4.1-flash"],
        },
        {
          name: "commandcode",
          type: "both",
          baseUrl: "https://api.commandcode.ai/provider/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["deepseek/deepseek-v4.1-flash"],
        },
        {
          name: "openrouter",
          type: "openai",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "test",
          models: ["deepseek/deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: {
          plan: [],
          execute: [],
          utility: ["deepseek-v4.1-flash"],
          chat: [],
        },
      },
    });
    expect(config.providers.find((p) => p.name === "openrouter")?.type).toBe("both");
    const decision = await decideRoute({
      config,
      body: { model: "jevonian/utility", messages: [{ role: "user", content: "hi" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "anthropic",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.provider).toBe("openrouter");
    expect(decision.reason).toContain("quota-skip");
  });

  it("auto (brain) widens to OpenAI providers when Anthropic-capable subscriptions are spent", async () => {
    spend("opencode-go", 10);
    spend("commandcode", 10);
    const config = parseConfig({
      defaultProvider: "opencode-go",
      providers: [
        {
          name: "opencode-go",
          type: "both",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["deepseek-v4.1-flash"],
        },
        {
          name: "commandcode",
          type: "both",
          baseUrl: "https://api.commandcode.ai/provider/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["deepseek/deepseek-v4.1-flash"],
        },
        {
          name: "openrouter",
          // Legacy configs stored openai; parse promotes OpenRouter to both.
          type: "openai",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "test",
          models: ["deepseek/deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: {
          plan: [],
          execute: ["deepseek-v4.1-flash"],
          utility: [],
          chat: [],
        },
      },
    });
    expect(config.providers.find((p) => p.name === "openrouter")?.type).toBe("both");
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "build a cache layer" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "anthropic",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.provider).toBe("openrouter");
    expect(decision.reason).toContain("quota-skip");
  });

  it("auto (brain) prefers DeepSeek as a dual-wire candidate when OpenCode is spent", async () => {
    spend("opencode-go", 10);
    const config = parseConfig({
      defaultProvider: "opencode-go",
      providers: [
        {
          name: "opencode-go",
          type: "both",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["deepseek-v4.1-flash"],
        },
        {
          name: "deepseek",
          // Legacy configs stored openai; parse promotes api.deepseek.com to both.
          type: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "test",
          models: ["deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: {
          plan: [],
          execute: ["deepseek-v4.1-flash"],
          utility: [],
          chat: [],
        },
      },
    });
    expect(config.providers.find((p) => p.name === "deepseek")?.type).toBe("both");
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "build a cache layer" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "anthropic",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.provider).toBe("deepseek");
    expect(decision.reason).toContain("quota-skip");
  });

  it("auto (brain) includes OpenAI-wire providers for Anthropic clients via bridge", async () => {
    spend("opencode-go", 10);
    const config = parseConfig({
      defaultProvider: "opencode-go",
      providers: [
        {
          name: "opencode-go",
          type: "both",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["deepseek-v4.1-flash"],
        },
        {
          name: "reseller",
          type: "openai",
          baseUrl: "http://127.0.0.1:9/v1",
          apiKey: "test",
          models: ["deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: {
          plan: [],
          execute: ["deepseek-v4.1-flash"],
          utility: [],
          chat: [],
        },
      },
    });
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "build a cache layer" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "anthropic",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.provider).toBe("reseller");
    expect(decision.reason).toContain("quota-skip");
  });

  it("auto (brain) includes OpenAI-wire providers for Responses clients via bridge", async () => {
    spend("chatgpt-subscription", 10);
    const config = parseConfig({
      defaultProvider: "chatgpt-subscription",
      providers: [
        {
          name: "chatgpt-subscription",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["gpt-6-astra"],
        },
        {
          name: "openrouter",
          type: "both",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "test",
          models: ["openai/gpt-6-astra", "google/gemini-3.8-flash"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: {
          plan: ["gpt-6-astra", "gemini-3-8-flash"],
          execute: ["gpt-6-astra"],
          utility: [],
          chat: [],
        },
      },
    });
    const decision = await decideRoute({
      config,
      body: {
        model: "auto",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      },
      headers: {},
      store: new SessionStore(60_000),
      kind: "responses",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.provider).toBe("openrouter");
    expect(decision.reason).toContain("quota-skip");
  });

  it("crosses tiers: a healthy utility model stays available to the brain", async () => {
    spend("sub-a", 10);
    spend("sub-b", 10);
    const config = parseConfig({
      defaultProvider: "sub-a",
      providers: [
        {
          name: "sub-a",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["model-a"],
        },
        {
          name: "sub-b",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["model-b"],
        },
        {
          name: "cheap",
          type: "openai",
          baseUrl: "http://127.0.0.1:3/v1",
          apiKey: "test",
          models: ["model-cheap"],
        },
      ],
      routing: {
        brains: BRAINS,
        tiers: { plan: ["model-a"], execute: ["model-b"], utility: ["model-cheap"], chat: [] },
      },
    });
    const { shown, decision } = await shownCandidates(config);
    expect(shown.map((candidate) => candidate.provider)).toEqual(["cheap"]);
    expect(decision.provider).toBe("cheap");
    expect(decision.phase).toBe("utility");
    expect(decision.reason).toContain("quota-skip");
  });
});
