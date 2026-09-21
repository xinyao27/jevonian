import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { clampEffort } from "./capabilities";
import { estimateTokens } from "./compaction";
import { parseConfig } from "./config";
import { resetQuotaCache } from "./quota";
import { decideRoute, partitionByCapability, SessionStore, type CapableCandidate } from "./routing";

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-capable-"));
  for (const key of ["JEVONIAN_DATA_DIR", "JEVONIAN_LEDGER", "TYPESAFE_API_KEY"]) {
    saved[key] = process.env[key];
  }
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.TYPESAFE_API_KEY = "test-key";
  resetQuotaCache();
  // A brain that names whichever routing it is told to prefer, so assertions are about what
  // the router offered rather than about the brain's judgement. It always asks for the deepest
  // thinking level, so a clamp is visible whenever the chosen model cannot honour it.
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse((init.body as string) ?? "{}") as { state?: Record<string, unknown> };
    const routings = Array.isArray(body.state?.routings)
      ? (body.state.routings as Array<{ id: string }>)
      : [];
    const choice =
      typeof body.state?.prefer === "string"
        ? body.state.prefer
        : (routings[0]?.id ?? "none_of_the_above");
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: {
          model: { choice, confidence: 0.9 },
          effort: { choice: "max", confidence: 0.9 },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetQuotaCache();
  rmSync(dir, { recursive: true, force: true });
});

const BRAINS = [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }];

function configWith(capacities: Record<string, unknown>) {
  return parseConfig({
    defaultProvider: "sub",
    providers: [
      {
        name: "sub",
        type: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        billing: "subscription",
        models: ["small-model", "big-model"],
      },
    ],
    routing: {
      mode: "auto",
      tiers: { plan: ["small-model", "big-model"], execute: ["small-model", "big-model"] },
      brains: BRAINS,
      capacities,
    },
  });
}

const candidate = (
  model: string,
  capabilities: CapableCandidate["capabilities"],
): CapableCandidate => ({ model, provider: "sub", capabilities });

describe("partitionByCapability", () => {
  it("withholds a model whose window cannot hold the conversation", () => {
    const { usable, skipped } = partitionByCapability(
      [
        candidate("small-model", { contextWindow: 8_000 }),
        candidate("big-model", { contextWindow: 200_000 }),
      ],
      50_000,
    );
    expect(usable.map((entry) => entry.model)).toEqual(["big-model"]);
    expect(skipped).toEqual([
      {
        model: "small-model",
        provider: "sub",
        reason: "context",
        detail: "~50000 tokens exceeds the 8000 window",
      },
    ]);
  });

  it("never withholds a model whose window is unknown", () => {
    const { usable, skipped } = partitionByCapability([candidate("mystery", {})], 900_000);
    expect(usable.map((entry) => entry.model)).toEqual(["mystery"]);
    expect(skipped).toHaveLength(0);
  });

  it("leaves headroom below the stated window", () => {
    // 90% of 10_000 is 9_000, so 9_500 does not fit even though it is under the window.
    const { usable } = partitionByCapability([candidate("m", { contextWindow: 10_000 })], 9_500);
    expect(usable).toHaveLength(0);
    expect(
      partitionByCapability([candidate("m", { contextWindow: 10_000 })], 8_000).usable,
    ).toHaveLength(1);
  });

  it("withholds a model that cannot think as deeply as the caller demanded", () => {
    const { usable, skipped } = partitionByCapability(
      [
        candidate("shallow", { efforts: ["low", "medium"] }),
        candidate("deep", { efforts: ["low", "high"] }),
      ],
      100,
      { minEffort: "high", requiredEffort: true },
    );
    expect(usable.map((entry) => entry.model)).toEqual(["deep"]);
    expect(skipped[0]).toMatchObject({ model: "shallow", reason: "effort" });
    expect(skipped[0]?.detail).toBe('supports up to "medium", needs "high"');
  });

  it("ignores the effort floor when the caller did not demand one", () => {
    const { usable } = partitionByCapability([candidate("shallow", { efforts: ["low"] })], 100, {
      minEffort: "high",
    });
    expect(usable).toHaveLength(1);
  });
});

describe("clampEffort", () => {
  it("keeps a level the model supports", () => {
    expect(clampEffort("high", ["low", "high"])).toBe("high");
  });

  it("picks the nearest supported level by depth", () => {
    expect(clampEffort("high", ["low", "max"])).toBe("max");
    expect(clampEffort("max", ["low", "medium"])).toBe("medium");
  });

  it("takes the middle level when nothing was asked for", () => {
    expect(clampEffort(undefined, ["low", "medium", "high"])).toBe("medium");
  });

  it("passes the request through when the model states no levels", () => {
    expect(clampEffort("high", undefined)).toBe("high");
    expect(clampEffort("high", [])).toBe("high");
  });
});

describe("routing with capability constraints", () => {
  it("reports a context skip in the reason and the headers", async () => {
    const config = configWith({ "small-model": { contextWindow: 1_000 } });
    // A long conversation that only big-model can hold.
    const body = {
      model: "auto",
      messages: [{ role: "user", content: "summarise ".repeat(4_000) }],
    };
    const decision = await decideRoute({
      config,
      body,
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.model).toBe("big-model");
    expect(decision.reason).toContain("context-skip");
    expect(decision.skipped).toEqual([
      expect.objectContaining({ model: "small-model", reason: "context" }),
    ]);
  });

  it("offers every model again when none fits rather than failing the turn", async () => {
    const config = configWith({
      "small-model": { contextWindow: 100 },
      "big-model": { contextWindow: 100 },
    });
    const body = { model: "auto", messages: [{ role: "user", content: "go ".repeat(2_000) }] };
    const decision = await decideRoute({
      config,
      body,
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    // The turn still lands, and the squeeze is recorded rather than hidden.
    expect(decision.model).toBe("small-model");
    expect(decision.skipped).toHaveLength(2);
  });

  it("honours an explicit effort floor from the request headers", async () => {
    const config = configWith({
      "small-model": { efforts: ["low"] },
      "big-model": { efforts: ["low", "high"] },
    });
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "plan the migration" }] },
      headers: { "x-jevonian-effort": "high" },
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.model).toBe("big-model");
    expect(decision.reason).toContain("effort-skip");
  });

  it("clamps an effort the chosen model cannot honour and says so", async () => {
    const config = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          billing: "subscription",
          models: ["small-model", "big-model"],
        },
      ],
      routing: {
        mode: "auto",
        tiers: { plan: ["big-model"], execute: ["small-model"], utility: [], chat: [] },
        brains: BRAINS,
        capacities: { "big-model": { efforts: ["low", "medium"] } },
      },
    });
    // A brain that picks the plan routing (big-model) even though execute is also offered.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: {
              model: { choice: "plan", confidence: 0.9 },
              effort: { choice: "max", confidence: 0.9 },
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "go" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.model).toBe("big-model");
    expect(decision.effort).toBe("medium");
    expect(decision.effortNote).toBe('clamped "max" to "medium"');
    expect(decision.reason).toContain("effort-clamped");
  });

  it("leaves effort undefined when the brain takes no effort question", async () => {
    // The commitment loop goes through a separate double that omits the effort answer.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { model: { choice: "plan", confidence: 0.9 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const config = configWith({});
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "go" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.effort).toBeUndefined();
    expect(decision.effortNote).toBeUndefined();
  });
});

describe("estimator", () => {
  it("is the calibrated compaction estimator, not a characters-per-token ratio", () => {
    // Two words, so two tokens; a length/4 ratio would also say 2 here, but the point is the
    // router and the compactor measure the same way, so the filter and the fitting agree.
    expect(estimateTokens("hello world")).toBe(2);
    expect(estimateTokens('{"a":1}')).toBeGreaterThanOrEqual(3);
  });
});

describe("brainPicksEffort off", () => {
  it("does not ask the brain for a thinking level", async () => {
    let questions: string[] = [];
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as {
        questions?: Record<string, unknown>;
        state?: { routings?: Array<{ id: string }> };
      };
      questions = Object.keys(body.questions ?? {});
      const first = body.state?.routings?.[0]?.id ?? "none_of_the_above";
      return new Response(
        JSON.stringify({ model: "jev", answers: { model: { choice: first, confidence: 0.9 } } }),
        { status: 200 },
      );
    });
    const config = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          models: ["small-model"],
        },
      ],
      routing: {
        mode: "auto",
        tiers: { plan: ["small-model"], execute: ["small-model"] },
        brains: BRAINS,
        brainPicksEffort: false,
        defaultEffort: "low",
      },
    });
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "go" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(questions).toEqual(["model"]);
    // The configured default is what reaches the wire, since the brain was not asked.
    expect(decision.effort).toBe("low");
  });

  it("ignores the brain's effort answer when it was not asked", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            model: "jev",
            answers: {
              model: { choice: "plan", confidence: 0.9 },
              // An answer to a question that was never asked must not be trusted.
              effort: { choice: "max", confidence: 0.9 },
            },
          }),
          { status: 200 },
        ),
    );
    const config = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          models: ["small-model"],
        },
      ],
      routing: {
        mode: "auto",
        tiers: { plan: ["small-model"], execute: ["small-model"] },
        brains: BRAINS,
        brainPicksEffort: false,
        defaultEffort: "medium",
        capacities: { "small-model": { efforts: ["low", "medium"] } },
      },
    });
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "go" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.effort).toBe("medium");
  });
});

describe("routing config round-trip", () => {
  it("parses capacities and the effort policy from config", () => {
    const config = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "t",
          models: ["m"],
        },
      ],
      routing: {
        mode: "auto",
        tiers: { plan: ["m"], execute: ["m"] },
        brains: BRAINS,
        brainPicksEffort: false,
        defaultEffort: "high",
        capacities: { m: { contextWindow: 4_000, efforts: ["low", "medium"] } },
      },
    });
    expect(config.routing.brainPicksEffort).toBe(false);
    expect(config.routing.defaultEffort).toBe("high");
    expect(config.routing.capacities).toEqual({
      m: { contextWindow: 4_000, efforts: ["low", "medium"] },
    });
  });

  it("ignores an unknown effort level rather than storing it", () => {
    const config = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "t",
          models: ["m"],
        },
      ],
      routing: {
        mode: "auto",
        tiers: { plan: ["m"], execute: ["m"] },
        brains: BRAINS,
        defaultEffort: "ultra-mega",
      },
    });
    expect(config.routing.defaultEffort).toBeUndefined();
  });

  it("defaults effort picking on, so the brain decides unless told otherwise", () => {
    const config = parseConfig({
      defaultProvider: "sub",
      providers: [
        {
          name: "sub",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "t",
          models: ["m"],
        },
      ],
      routing: { mode: "auto", tiers: { plan: ["m"], execute: ["m"] }, brains: BRAINS },
    });
    expect(config.routing.brainPicksEffort).toBe(true);
  });
});
