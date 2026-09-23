import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { appendRecord } from "./ledger";
import { canonicalModelId, canonicalModels, canonicalVariants } from "./models";
import { resetQuotaCache } from "./quota";
import { decideRoute, firstFromTier, SessionStore } from "./routing";

/**
 * Catalog identities are read from the pricing snapshot, which normally comes from models.dev and
 * is absent in a clean checkout. `official` depends on them, so the suite writes its own snapshot
 * instead of inheriting whatever the developer happens to have cached locally.
 */
const FIXTURE_IDENTITIES = {
  "anthropic/claude-sonnet-4-6": { name: "Claude Sonnet 4.6", family: "Claude Sonnet" },
  "deepseek/deepseek-v4-pro": { name: "DeepSeek V4 Pro", family: "DeepSeek" },
};

let dataDirPath = "";
let previousDataDir: string | undefined;
let previousLedger: string | undefined;
let previousTypesafeKey: string | undefined;

beforeEach(() => {
  dataDirPath = mkdtempSync(join(tmpdir(), "jevonian-models-"));
  previousDataDir = process.env.JEVONIAN_DATA_DIR;
  previousLedger = process.env.JEVONIAN_LEDGER;
  previousTypesafeKey = process.env.TYPESAFE_API_KEY;
  process.env.JEVONIAN_DATA_DIR = dataDirPath;
  process.env.JEVONIAN_LEDGER = join(dataDirPath, "ledger.jsonl");
  process.env.TYPESAFE_API_KEY = "test-key";
  writeFileSync(
    join(dataDirPath, "pricing.json"),
    JSON.stringify({
      fetchedAt: new Date(0).toISOString(),
      source: "test-fixture",
      models: {},
      providers: {},
      identities: FIXTURE_IDENTITIES,
    }),
  );
  resetQuotaCache();
});

afterEach(() => {
  if (previousDataDir === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousDataDir;
  if (previousLedger === undefined) delete process.env.JEVONIAN_LEDGER;
  else process.env.JEVONIAN_LEDGER = previousLedger;
  if (previousTypesafeKey === undefined) delete process.env.TYPESAFE_API_KEY;
  else process.env.TYPESAFE_API_KEY = previousTypesafeKey;
  resetQuotaCache();
  rmSync(dataDirPath, { recursive: true, force: true });
});

describe("canonicalModelId", () => {
  it("normalizes prefixes, case, dots, and date stamps", () => {
    expect(canonicalModelId("anthropic/claude-sonnet-4.6")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("Claude-Sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(canonicalModelId("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(canonicalModelId("openai/gpt-5.6")).toBe("gpt-5-6");
    expect(canonicalModelId("deepseek-v4-pro")).toBe("deepseek-v4-pro");
    expect(canonicalModelId("taste-1")).toBe("taste-1");
    expect(canonicalModelId("gemini-3.8-flash-tiered")).toBe("gemini-3-8-flash");
  });
});

function mixedConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    defaultProvider: "anthropic",
    providers: [
      {
        name: "anthropic",
        type: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        apiKey: "test",
        models: ["claude-sonnet-4-6", "claude-opus-4-6"],
      },
      {
        name: "openrouter",
        type: "openai",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "test",
        models: ["anthropic/claude-sonnet-4.6", "deepseek/deepseek-v4-pro"],
      },
      {
        name: "deepseek",
        type: "openai",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "test",
        models: ["deepseek-v4-pro"],
      },
    ],
    ...overrides,
  });
}

describe("canonicalVariants", () => {
  it("finds every provider that serves the same underlying model", () => {
    const variants = canonicalVariants(mixedConfig(), "claude-sonnet-4.6");
    expect(variants).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", official: true },
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    ]);
  });

  it("includes Anthropic-only hosts for OpenAI clients via the bridge", () => {
    const variants = canonicalVariants(mixedConfig(), "claude-sonnet-4.6", "openai");
    expect(variants).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", official: true },
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    ]);
  });

  it("excludes Responses-only hosts for Anthropic clients", () => {
    const config = parseConfig({
      providers: [
        {
          name: "anthropic",
          type: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiKey: "test",
          models: ["gpt-5.4"],
        },
        {
          name: "chatgpt",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          auth: "oauth",
          oauthSource: "codex",
          models: ["gpt-5.4"],
        },
      ],
    });
    expect(canonicalVariants(config, "gpt-5.4", "anthropic")).toEqual([
      { provider: "anthropic", model: "gpt-5.4" },
    ]);
  });

  it("matches Antigravity service-tier suffixed ids", () => {
    const config = parseConfig({
      providers: [
        {
          name: "antigravity",
          type: "gemini",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          auth: "oauth",
          oauthSource: "antigravity",
          models: ["gemini-3.8-flash-tiered"],
        },
      ],
    });
    expect(canonicalVariants(config, "gemini-3.8-flash")).toEqual([
      { provider: "antigravity", model: "gemini-3.8-flash-tiered" },
    ]);
  });

  it("honors user-defined aliases", () => {
    const config = mixedConfig({
      modelAliases: { "claude-sonnet-4.6": ["openrouter/anthropic/claude-sonnet-4.6"] },
    });
    const variants = canonicalVariants(config, "claude-sonnet-4.6");
    expect(variants[0]).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4.6",
    });
    expect(variants).toHaveLength(2);
  });
});

describe("canonicalModels", () => {
  it("groups provider-specific spellings under one canonical id", () => {
    const entries = canonicalModels(mixedConfig());
    const sonnet = entries.find((entry) => entry.id === "claude-sonnet-4-6");
    expect(sonnet?.variants).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6", official: true },
      { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
    ]);
    const deepseek = entries.find((entry) => entry.id === "deepseek-v4-pro");
    expect(deepseek?.variants).toHaveLength(2);
  });
});

describe("routing with canonical ids", () => {
  it("resolves a canonical tier entry to a configured provider", () => {
    const picked = firstFromTier(mixedConfig(), ["claude-sonnet-4.6"]);
    expect(picked).toEqual({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      canonical: "claude-sonnet-4.6",
    });
  });

  it("prefers an exact model id over canonical expansion", () => {
    const picked = firstFromTier(mixedConfig(), ["anthropic/claude-sonnet-4.6"]);
    expect(picked).toEqual({ model: "anthropic/claude-sonnet-4.6", provider: "openrouter" });
  });

  it("resolves a pinned canonical id", async () => {
    const decision = await decideRoute({
      config: mixedConfig(),
      body: {
        model: "claude-sonnet-4.6",
        messages: [{ role: "user", content: "build a cache layer" }],
      },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    // Official Anthropic host wins; OpenAI clients reach it via the to-anthropic bridge.
    expect(decision.provider).toBe("anthropic");
    expect(decision.model).toBe("claude-sonnet-4-6");
    expect(decision.canonical).toBe("claude-sonnet-4.6");
    expect(decision.reason).toBe("canonical-model");
    expect(decision.routed).toBe(false);
  });
});

describe("canonical routing with the quota guard", () => {
  it("skips a constrained provider variant for a healthy one", async () => {
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
          models: ["claude-sonnet-4-6"],
        },
        {
          name: "sub-b",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "test",
          billing: "subscription",
          quota: { fiveHourUsd: 10 },
          models: ["anthropic/claude-sonnet-4.6"],
        },
      ],
      routing: {
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }],
        tiers: { plan: ["claude-sonnet-4.6"], execute: [], utility: [], chat: [] },
      },
    });
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as { state?: Record<string, unknown> };
      const routings = (body.state?.routings ?? []) as Array<{ id: string }>;
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: routings[0]?.id ?? "none_of_the_above" } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    appendRecord({
      ts: new Date().toISOString(),
      session: "s",
      path: "/chat/completions",
      provider: "sub-a",
      model: "claude-sonnet-4-6",
      stream: false,
      status: 200,
      latencyMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 10,
      pricingKnown: true,
      billing: "subscription",
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
    expect(decision.provider).toBe("sub-b");
    expect(decision.model).toBe("anthropic/claude-sonnet-4.6");
    expect(decision.reason).toContain("quota-skip");
    expect(decision.reason).toContain("canonical:claude-sonnet-4.6");
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });
});
