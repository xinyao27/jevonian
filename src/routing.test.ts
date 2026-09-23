import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { usePriceTable } from "./pricing";
import {
  applyProviderPreference,
  classifyPhase,
  decideRoute,
  deriveRoutings,
  deriveTiers,
  extractUserQuery,
  lastUserMessage,
  routingCandidates,
  SessionStore,
  type RequestKind as RouteKind,
  type RouteDecision,
  type RouteInput,
} from "./routing";

let ledgerDir = "";
let previousLedger: string | undefined;
let previousData: string | undefined;

beforeEach(() => {
  ledgerDir = mkdtempSync(join(tmpdir(), "jevonian-routing-"));
  previousLedger = process.env.JEVONIAN_LEDGER;
  previousData = process.env.JEVONIAN_DATA_DIR;
  process.env.JEVONIAN_LEDGER = join(ledgerDir, "ledger.jsonl");
  process.env.JEVONIAN_DATA_DIR = join(ledgerDir, "data");
  process.env.TYPESAFE_API_KEY = "test-key";
  // The brain picks a routing from the ones the router offered. The stub mirrors the old
  // cheapest-that-fits rule via routing ids: plan for fresh asks, execute once tools flow.
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse((init.body as string) ?? "{}") as { state?: Record<string, unknown> };
    const state = body.state ?? {};
    const failures =
      typeof state.consecutive_failures === "number" ? state.consecutive_failures : 0;
    const routings = Array.isArray(state.routings)
      ? (state.routings as Array<{ id: string }>).map((entry) => entry.id)
      : [];
    const wantCheap = state.has_tool_results === true && failures < 2;
    const choice = wantCheap
      ? routings.includes("execute")
        ? "execute"
        : routings[0]
      : ((routings.includes("plan") ? "plan" : routings[0]) ?? "none_of_the_above");
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { model: { choice, confidence: 0.9 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
});

afterEach(() => {
  if (previousLedger === undefined) delete process.env.JEVONIAN_LEDGER;
  else process.env.JEVONIAN_LEDGER = previousLedger;
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  delete process.env.TYPESAFE_API_KEY;
  vi.unstubAllGlobals();
  rmSync(ledgerDir, { recursive: true, force: true });
});

function testConfig(overrides: Record<string, unknown> = {}) {
  return parseConfig({
    defaultProvider: "mock",
    providers: [
      {
        name: "mock",
        type: "openai",
        baseUrl: "http://127.0.0.1:9999/v1",
        apiKey: "test",
        models: ["deepseek-v4-pro", "deepseek-v4.1-flash"],
      },
    ],
    routing: {
      brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1_000 }],
      ...(overrides.routing as Record<string, unknown> | undefined),
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "routing")),
  });
}

const planBody = (model = "auto") => ({
  model,
  messages: [{ role: "user", content: "build a feature" }],
});

const executeBody = (model = "auto", failures = 0) => ({
  model,
  messages: [
    { role: "user", content: "build a feature" },
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id: "1", type: "function", function: { name: "edit", arguments: "{}" } }],
    },
    ...Array.from({ length: failures }, (_, index) => ({
      role: "tool",
      tool_call_id: String(index),
      content: "Error: tests failed",
    })),
    ...(failures === 0 ? [{ role: "tool", tool_call_id: "ok", content: "wrote 3 lines" }] : []),
  ],
});

async function route(input: RouteInput): Promise<RouteDecision> {
  const result = await decideRoute(input);
  if ("error" in result) throw new Error(result.error);
  return result;
}

// Runs a request through the Jev brain and returns the exact `state` object it received.
async function brainStateFor(
  body: Record<string, unknown>,
  kind: RouteKind,
): Promise<Record<string, unknown>> {
  let sent = "";
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    sent = init.body as string;
    return new Response(
      JSON.stringify({
        model: "jev-1.13.0",
        answers: { model: { choice: "plan", confidence: 0.9 } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  await route({
    config: testConfig(),
    body,
    headers: {},
    store: new SessionStore(60_000),
    kind,
    now: 1_000_000,
  });
  return (JSON.parse(sent) as { state: Record<string, unknown> }).state;
}

function baseInput(
  body: Record<string, unknown>,
  store = new SessionStore(60_000),
  headers = {},
): RouteInput {
  return { config: testConfig(), body, headers, store, kind: "openai", now: 1_000_000 };
}

describe("classifyPhase", () => {
  it("extracts the wrapped user query", async () => {
    expect(extractUserQuery("<timestamp>x</timestamp>\n<user_query>fix it</user_query>")).toBe(
      "fix it",
    );
    expect(extractUserQuery("plain")).toBe("plain");
  });

  it("reads Cursor-style queries from the last user message", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: "<user_info>\nOS Version: darwin\nWorkspace: /tmp/x\n</user_info>",
        },
        { role: "assistant", content: "Hi! What would you like to work on?" },
        { role: "user", content: "<user_query>你是什么模型</user_query>" },
      ],
    };
    expect(lastUserMessage(body, "openai")).toBe("你是什么模型");
    expect(classifyPhase(body, "openai").phase).toBe("plan");
  });

  it("ignores an injected context block far larger than the old length cap", async () => {
    // Regression lock: Cursor/Codex preambles can be tens of kilobytes. When a length cap
    // truncated them the closing tag was lost, and the whole preamble was read as the
    // user's request (and as the session goal).
    const preamble = `<user_info>\nOS Version: darwin\n${"x".repeat(80_000)}\n</user_info>`;
    const body = {
      model: "auto",
      messages: [
        { role: "user", content: `${preamble}\n<timestamp>now</timestamp>` },
        { role: "assistant", content: "ok" },
        { role: "user", content: "<user_query>fix the cache bug</user_query>" },
      ],
    };
    expect(lastUserMessage(body, "openai")).toBe("fix the cache bug");
    const state = await brainStateFor(body, "openai");
    expect(state.session_goal).toBe("fix the cache bug");
    expect(JSON.stringify(state.recent_messages)).not.toContain("OS Version");
  });

  it("ignores an unclosed injected block", async () => {
    const body = {
      messages: [
        { role: "user", content: "<environment_context>\npath=/tmp\nshell=zsh" },
        { role: "assistant", content: "ok" },
      ],
    };
    expect(lastUserMessage(body, "openai")).toBe("");
  });

  it("still reads a pasted code fragment as the user's request", async () => {
    const body = {
      messages: [{ role: "user", content: "<div class='a'>broken layout</div>" }],
    };
    expect(lastUserMessage(body, "openai")).toBe("<div class='a'>broken layout</div>");
  });

  it("skips a trailing Claude Code reminder down to the real ask", async () => {
    const body = {
      messages: [
        { role: "user", content: "make the build green" },
        {
          role: "user",
          content: [{ type: "text", text: "<system-reminder>\nMode is plan.\n</system-reminder>" }],
        },
      ],
    };
    expect(lastUserMessage(body, "anthropic")).toBe("make the build green");
  });

  it("reads Codex Responses tool calls from the input items", async () => {
    const body = {
      model: "auto",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
        { type: "function_call", name: "shell", arguments: '{"command":"ls -la"}' },
        { type: "function_call_output", call_id: "1", output: "wrote 3 lines" },
      ],
    };
    const state = await brainStateFor(body, "responses");
    // Shell args are redacted before they reach the brain — raw `; curl` patterns trip
    // TypeSafe's Cloudflare WAF and take the whole router down.
    expect(state.recent_tool_calls).toEqual(["shell(<command redacted>)"]);
  });

  it("classifies a fresh conversation as planning", async () => {
    const signals = classifyPhase(planBody(), "openai");
    expect(signals.phase).toBe("plan");
    expect(signals.consecutiveFailures).toBe(0);
  });

  it("classifies OpenAI tool results as execution", async () => {
    const signals = classifyPhase(executeBody(), "openai");
    expect(signals.phase).toBe("execute");
    expect(signals.hasToolResults).toBe(true);
  });

  it("classifies Anthropic tool_result blocks as execution", async () => {
    const signals = classifyPhase(
      {
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          { role: "assistant", content: [{ type: "tool_use", id: "1", name: "edit", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
        ],
      },
      "anthropic",
    );
    expect(signals.phase).toBe("execute");
  });

  it("classifies Responses function_call_output items as execution", async () => {
    const signals = classifyPhase(
      {
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
          { type: "function_call_output", call_id: "1", output: "wrote 3 lines" },
        ],
      },
      "responses",
    );
    expect(signals.phase).toBe("execute");
    expect(signals.hasToolResults).toBe(true);
  });

  it("counts consecutive failures from the end", async () => {
    const signals = classifyPhase(
      {
        messages: [
          { role: "user", content: "go" },
          { role: "tool", content: "Error: boom" },
          { role: "tool", content: "ok" },
          { role: "tool", content: "Error: tests failed" },
          { role: "tool", content: "FAIL src/a.test.ts" },
        ],
      },
      "openai",
    );
    expect(signals.consecutiveFailures).toBe(2);
  });
});

describe("deriveTiers", () => {
  it("derives plan and execute from the price table when unconfigured", async () => {
    const tiers = deriveTiers(testConfig());
    expect(tiers.plan).toEqual(["deepseek-v4-pro"]);
    expect(tiers.execute).toEqual(["deepseek-v4.1-flash"]);
    expect(tiers.chat.length).toBeGreaterThan(0);
  });

  it("keeps declared tiers", async () => {
    const tiers = deriveTiers(
      testConfig({
        routing: {
          tiers: { plan: ["deepseek-v4-pro"], execute: ["deepseek-v4-pro"], utility: [] },
        },
      }),
    );
    expect(tiers.plan).toEqual(["deepseek-v4-pro"]);
    expect(tiers.execute).toEqual(["deepseek-v4-pro"]);
  });

  it("avoids experimental models when picking tiers", async () => {
    usePriceTable({
      "p/stable-cheap": { provider: "p", input: 0.1, output: 0.2 },
      "p/fast-exp": { provider: "p", input: 0.05, output: 0.1 },
      "p/frontier": { provider: "p", input: 2, output: 8 },
    });
    const tiers = deriveTiers(
      parseConfig({
        defaultProvider: "p",
        providers: [
          {
            name: "p",
            type: "openai",
            baseUrl: "http://127.0.0.1:9999/v1",
            apiKey: "test",
            models: ["p/frontier", "p/fast-exp", "p/stable-cheap"],
          },
        ],
      }),
    );
    expect(tiers.plan).toEqual(["p/frontier"]);
    expect(tiers.execute).toEqual(["p/stable-cheap"]);
    expect(tiers.utility).toEqual(["p/fast-exp"]);
  });

  it("falls back to an unpriced configured model when nothing is priced yet", () => {
    usePriceTable({});
    const routings = deriveRoutings(
      parseConfig({
        providers: [
          {
            name: "codex",
            type: "responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            auth: "oauth",
            oauthSource: "codex",
            models: ["gpt-6-sol"],
          },
        ],
      }),
    );
    expect(routings.find((entry) => entry.id === "plan")?.models).toEqual(["gpt-6-sol"]);
  });

  it("prefers priced models over unpriced ones when both are available", () => {
    usePriceTable({
      "gpt-6-astra": { provider: "openai", input: 2, output: 10 },
    });
    const routings = deriveRoutings(
      parseConfig({
        providers: [
          {
            name: "codex",
            type: "responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            auth: "oauth",
            oauthSource: "codex",
            models: ["gpt-6-sol", "gpt-6-astra"],
          },
        ],
      }),
    );
    expect(routings.find((entry) => entry.id === "plan")?.models).toEqual(["gpt-6-astra"]);
    // A cheap routing is a cost claim an unknown price cannot back: it reuses the priced plan
    // model rather than being pinned to the unpriced id.
    expect(routings.find((entry) => entry.id === "execute")?.models).toEqual(["gpt-6-astra"]);
  });

  it("never makes an unpriced model the cheap pick while an expensive slot is open", () => {
    usePriceTable({
      "gpt-6-astra": { provider: "openai", input: 2, output: 10 },
      "gpt-mini": { provider: "openai", input: 0.1, output: 0.4 },
    });
    const routings = deriveRoutings(
      parseConfig({
        providers: [
          {
            name: "codex",
            type: "responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            auth: "oauth",
            oauthSource: "codex",
            models: ["gpt-6-sol", "gpt-6-astra", "gpt-mini"],
          },
        ],
      }),
    );
    const cheap = routings.filter((entry) => entry.id !== "plan").flatMap((entry) => entry.models);
    expect(cheap).not.toContain("gpt-6-sol");
    expect(routings.find((entry) => entry.id === "execute")?.models).toEqual(["gpt-mini"]);
  });

  it("keeps fixed routings unchanged when a new unpriced model is configured", () => {
    usePriceTable({ "gpt-6-astra": { provider: "openai", input: 2, output: 10 } });
    const routings = deriveRoutings(
      parseConfig({
        providers: [
          {
            name: "codex",
            type: "responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            auth: "oauth",
            oauthSource: "codex",
            models: ["gpt-6-astra", "gpt-6-sol"],
          },
        ],
        routing: {
          routings: [
            { id: "plan", label: "Plan", description: "plan", models: ["gpt-6-astra"] },
            { id: "execute", label: "Execute", description: "exec", models: ["gpt-6-astra"] },
          ],
        },
      }),
    );
    expect(routings.find((entry) => entry.id === "plan")?.models).toEqual(["gpt-6-astra"]);
    expect(routings.find((entry) => entry.id === "execute")?.models).toEqual(["gpt-6-astra"]);
  });
});

describe("decideRoute", () => {
  it("routes a virtual model to the planning tier for a new session", async () => {
    const decision = await route(baseInput(planBody()));
    expect(decision.virtual).toBe(true);
    expect(decision.routed).toBe(true);
    expect(decision.phase).toBe("plan");
    expect(decision.model).toBe("deepseek-v4-pro");
    expect(decision.reason).toBe("brain:plan");
    expect(decision.brain).toBe("jev");
  });

  it("keeps the frontier model for a greeting when it is the only candidate", async () => {
    const config = testConfig({
      routing: {
        tiers: {
          plan: ["deepseek-v4-pro"],
          execute: ["deepseek-v4-pro"],
          utility: ["deepseek-v4-pro"],
          chat: ["deepseek-v4-pro"],
        },
      },
    });
    const result = await decideRoute({
      config,
      body: { model: "jevonian/auto", messages: [{ role: "user", content: "hi" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.model).toBe("deepseek-v4-pro");
    expect(result.brain).toBe("jev");
  });

  it("errors when no Jev brain is configured", async () => {
    const config = testConfig({ routing: { brains: [] } });
    const result = await decideRoute({
      config,
      body: planBody(),
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    expect("error" in result && result.error).toContain("No Jev brain is configured");
    expect("error" in result && result.status).toBe(400);
  });

  it("routes namespaced virtual models", async () => {
    const decision = await route(baseInput(planBody("jevonian/auto")));
    expect(decision.virtual).toBe(true);
    expect(decision.model).toBe("deepseek-v4-pro");
    expect(decision.requestedModel).toBe("jevonian/auto");
  });

  it("strips the jevonian/ prefix from pinned models", async () => {
    const decision = await route(baseInput(planBody("jevonian/deepseek-v4.1-flash")));
    expect(decision.routed).toBe(false);
    expect(decision.reason).toBe("pinned-model");
    expect(decision.model).toBe("deepseek-v4.1-flash");
  });

  it("pins a real model named auto when a provider declares it", async () => {
    const config = parseConfig({
      defaultProvider: "agg",
      providers: [
        {
          name: "agg",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          models: ["auto"],
        },
      ],
    });
    const result = await decideRoute({
      config,
      body: planBody("auto"),
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.virtual).toBe(false);
    expect(result.reason).toBe("pinned-model");
    expect(result.model).toBe("auto");
    expect(result.provider).toBe("agg");
  });

  it("honors pinned real models", async () => {
    const decision = await route(baseInput(planBody("deepseek-v4.1-flash")));
    expect(decision.routed).toBe(false);
    expect(decision.model).toBe("deepseek-v4.1-flash");
    expect(decision.reason).toBe("pinned-model");
  });

  it("drops to the cheap model once tool results are flowing", async () => {
    const store = new SessionStore(60_000);
    await route(baseInput(planBody(), store));
    const decision = await route(baseInput(executeBody(), store));
    expect(decision.phase).toBe("execute");
    expect(decision.model).toBe("deepseek-v4.1-flash");
    expect(decision.reason).toBe("brain:execute");
  });

  it("returns to the frontier model after repeated failures", async () => {
    const store = new SessionStore(60_000);
    await route(baseInput(planBody(), store));
    await route(baseInput(executeBody(), store));
    const decision = await route(baseInput(executeBody("auto", 2), store));
    expect(decision.model).toBe("deepseek-v4-pro");
    expect(decision.phase).toBe("plan");
  });

  it("routes Responses requests to a Responses provider", async () => {
    const config = parseConfig({
      defaultProvider: "codex",
      providers: [
        {
          name: "codex",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          auth: "oauth",
          oauthSource: "codex",
          billing: "subscription",
          models: ["gpt-5.6-codex"],
        },
      ],
      routing: {
        tiers: { plan: ["gpt-5.6-codex"], execute: ["gpt-5.6-codex"], utility: [] },
      },
    });
    const result = await decideRoute({
      config,
      body: { model: "auto", input: "hi" },
      headers: { "x-jevonian-phase": "plan" },
      store: new SessionStore(60_000),
      kind: "responses",
      now: 1_000,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.model).toBe("gpt-5.6-codex");
    expect(result.provider).toBe("codex");
  });

  it("honors an explicit phase header", async () => {
    const decision = await route(
      baseInput(planBody(), new SessionStore(60_000), { "x-jevonian-phase": "execute" }),
    );
    expect(decision.phase).toBe("execute");
    expect(decision.model).toBe("deepseek-v4.1-flash");
    expect(decision.reason).toBe("explicit:execute");
  });

  it("rejects virtual models when routing is off", async () => {
    const input = baseInput(planBody());
    input.config = testConfig({ routing: { mode: "off" } });
    const result = await decideRoute(input);
    expect("error" in result).toBe(true);
  });

  it("uses an explicit session header for stickiness", async () => {
    const store = new SessionStore(60_000);
    const headers = { "x-session-id": "session-1" };
    const first = await route(baseInput(planBody(), store, headers));
    const second = await route(baseInput(planBody(), store, headers));
    expect(first.session).toBe("session-1");
    expect(second.phase).toBe("plan");
    expect(second.reason).toBe("brain:plan");
  });
});

describe("SessionStore", () => {
  it("expires sessions after the ttl", async () => {
    const store = new SessionStore(1_000);
    store.set("a", {
      phase: "plan",
      model: "m",
      provider: "p",
      turns: 1,
      updatedAt: 0,
    });
    expect(store.get("a", 500)).toBeDefined();
    expect(store.get("a", 2_000)).toBeUndefined();
  });
});

describe("decideRoute with the Jev brain", () => {
  function jevInput(): RouteInput {
    process.env.TYPESAFE_API_KEY = "test-key";
    const input = baseInput(planBody());
    input.config = testConfig({
      routing: { brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }] },
    });
    return input;
  }

  it("accepts a confident Jev verdict", async () => {
    let sentBody = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sentBody = init.body as string;
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "execute", confidence: 0.9 } },
          usage: { input_tokens: 120, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const decision = await route(jevInput());
    expect(sentBody).toContain('"last_user_message":"build a feature"');
    expect(decision.phase).toBe("execute");
    expect(decision.model).toBe("deepseek-v4.1-flash");
    expect(decision.brain).toBe("jev");
    expect(decision.reason).toBe("brain:execute");
    const records = readFileSync(process.env.JEVONIAN_LEDGER ?? "", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const brainCall = records.find((record) => record.kind === "brain");
    expect(brainCall).toMatchObject({
      provider: "brain:typesafe",
      // The routed model is in `verdict.model`; this field names the brain that answered.
      model: "jev-1.13.0",
      status: 200,
      promptTokens: 120,
      completionTokens: 5,
    });
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });

  it("uses a low-confidence verdict without consulting the next brain", async () => {
    process.env.JEV_TEST_BRAIN_KEY = "test-key";
    const config = parseConfig({
      defaultProvider: "mock",
      providers: [
        {
          name: "mock",
          type: "openai",
          baseUrl: "http://127.0.0.1:9999/v1",
          apiKey: "test",
          models: ["deepseek-v4-pro", "deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: [
          {
            channel: "custom",
            baseUrl: "http://first-brain/systemone",
            apiKeyEnv: "JEV_TEST_BRAIN_KEY",
            timeoutMs: 500,
            minConfidence: 0.6,
          },
          {
            channel: "custom",
            baseUrl: "http://second-brain/systemone",
            apiKeyEnv: "JEV_TEST_BRAIN_KEY",
            timeoutMs: 500,
          },
        ],
      },
    });
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(String(url));
      return new Response(
        JSON.stringify({
          answers: { model: { choice: "execute", confidence: 0.4 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await decideRoute({
      config,
      body: planBody(),
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.brain).toBe("jev-low-confidence");
    expect(result.reason).toBe("brain:execute:brain-low-confidence");
    expect(urls).toEqual(["http://first-brain/systemone"]);
    vi.unstubAllGlobals();
    delete process.env.JEV_TEST_BRAIN_KEY;
  });

  it("marks a single-brain low-confidence verdict without failing the turn", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            answers: { model: { choice: "execute", confidence: 0.4 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const decision = await route(jevInput());
    expect(decision.phase).toBe("execute");
    expect(decision.model).toBe("deepseek-v4.1-flash");
    expect(decision.brain).toBe("jev-low-confidence");
    expect(decision.reason).toBe("brain:execute:brain-low-confidence");
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });

  it("sends the full transcript when the brain asks for it", async () => {
    process.env.JEV_TEST_BRAIN_KEY = "test-key";
    let sent = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = init.body as string;
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "plan", confidence: 0.9 } },
        }),
        { status: 200 },
      );
    });
    const config = parseConfig({
      defaultProvider: "mock",
      providers: [
        {
          name: "mock",
          type: "openai",
          baseUrl: "http://127.0.0.1:9999/v1",
          apiKey: "test",
          models: ["deepseek-v4-pro", "deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: [
          {
            channel: "custom",
            baseUrl: "http://brain/systemone",
            apiKeyEnv: "JEV_TEST_BRAIN_KEY",
            fullPrompt: true,
          },
        ],
      },
    });
    await route({
      config,
      body: planBody(),
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    const state = (JSON.parse(sent) as { state: { transcript?: string } }).state;
    expect(state.transcript).toContain("[user] build a feature");
    vi.unstubAllGlobals();
    delete process.env.JEV_TEST_BRAIN_KEY;
  });

  it("falls back to the next brain when the first one fails", async () => {
    process.env.JEV_TEST_BRAIN_KEY = "test-key";
    const config = parseConfig({
      defaultProvider: "mock",
      providers: [
        {
          name: "mock",
          type: "openai",
          baseUrl: "http://127.0.0.1:9999/v1",
          apiKey: "test",
          models: ["deepseek-v4-pro", "deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: [
          {
            channel: "custom",
            baseUrl: "http://first-brain/systemone",
            apiKeyEnv: "JEV_TEST_BRAIN_KEY",
            timeoutMs: 500,
          },
          {
            channel: "custom",
            baseUrl: "http://second-brain/systemone",
            apiKeyEnv: "JEV_TEST_BRAIN_KEY",
            timeoutMs: 500,
          },
        ],
      },
    });
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("first-brain")) throw new Error("boom");
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "execute", confidence: 0.9 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await decideRoute({
      config,
      body: planBody(),
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in result) throw new Error(result.error);
    expect(result.brain).toBe("jev");
    expect(result.brainChannel).toBe("custom");
    expect(result.reason).toBe("brain:execute");
    const records = readFileSync(process.env.JEVONIAN_LEDGER ?? "", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "brain");
    expect(records.map((record) => record.status)).toEqual([502, 200]);
    vi.unstubAllGlobals();
    delete process.env.JEV_TEST_BRAIN_KEY;
  });

  it("falls back to heuristic routing when every brain fails", async () => {
    // Disable retries so a permanently dead brain fails in one pass (no backoff sleep).
    process.env.JEVONIAN_UPSTREAM_RETRIES = "0";
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const result = await decideRoute(jevInput());
    // Soft-fail: keep the turn alive with classifyPhase rather than 502ing Cursor.
    if ("error" in result) throw new Error(result.error);
    expect(result.brain).toBe("heuristic");
    expect(result.reason).toMatch(/^brain-fallback:/);
    expect(result.phase).toBe("plan");
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEVONIAN_UPSTREAM_RETRIES;
  });

  it("retries the whole brain round when every channel fails once", async () => {
    process.env.JEVONIAN_UPSTREAM_RETRIES = "1";
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      // Exhaust round 1's per-request retries (2 attempts with budget 1), then recover.
      if (hits <= 2) return new Response("down", { status: 502 });
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "execute", confidence: 0.9 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const result = await decideRoute(jevInput());
    if ("error" in result) throw new Error(result.error);
    expect(result.brain).toBe("jev");
    expect(hits).toBe(3);
    const records = readFileSync(process.env.JEVONIAN_LEDGER ?? "", "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record.kind === "brain");
    // Round 1 recorded a failed channel call; round 2 recorded the success.
    expect(records.map((record) => record.status)).toEqual([502, 200]);
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
    delete process.env.JEVONIAN_UPSTREAM_RETRIES;
  });
  it("falls back to the first candidate when the brain names an unknown model", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            answers: { model: { choice: "gpt-9-nonexistent", confidence: 0.9 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const decision = await route(jevInput());
    // Whatever it names, the turn still lands on a model code actually offered.
    expect(["deepseek-v4-pro", "deepseek-v4.1-flash"]).toContain(decision.model);
    vi.unstubAllGlobals();
    delete process.env.TYPESAFE_API_KEY;
  });
});

// The executable definition of "generic": Cursor (openai), Claude Code (anthropic) and
// Codex (responses) must reach Jev with the same state, so no agent needs its own parser.
describe("protocol parity", () => {
  const ASK = "fix the flaky auth test";
  const PREAMBLE = "<user_info>\nOS Version: darwin\nWorkspace: /repo\n</user_info>";
  const TOOL = "shell";
  const FAILED = "Exit code: 1\n\nCommand output:\n\n```\nnpm err assert failed\n```";

  const shapes = {
    openai: {
      model: "auto",
      messages: [
        { role: "user", content: `${PREAMBLE}\n<timestamp>t</timestamp>` },
        { role: "user", content: `<user_query>${ASK}</user_query>` },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "1", function: { name: TOOL, arguments: '{"cmd":"npm test"}' } }],
        },
        { role: "tool", tool_call_id: "1", content: FAILED },
      ],
    },
    anthropic: {
      model: "auto",
      messages: [
        { role: "user", content: [{ type: "text", text: PREAMBLE }] },
        { role: "user", content: [{ type: "text", text: ASK }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "1", name: TOOL, input: { cmd: "npm test" } }],
        },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: FAILED }] },
      ],
    },
    responses: {
      model: "auto",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: PREAMBLE }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: ASK }] },
        { type: "function_call", name: TOOL, arguments: '{"cmd":"npm test"}' },
        { type: "function_call_output", call_id: "1", output: FAILED },
      ],
    },
  } as const;

  const semanticFields = [
    "last_user_message",
    "session_goal",
    "recent_messages",
    "recent_tool_calls",
    "recent_tool_results",
    "has_tool_results",
    "has_tools",
    "consecutive_failures",
    "routings",
  ] as const;

  async function stateFor(kind: keyof typeof shapes): Promise<Record<string, unknown>> {
    let sent = "";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      sent = init.body as string;
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "execute", confidence: 0.9 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    await route({
      ...baseInput(shapes[kind] as unknown as Record<string, unknown>),
      kind,
    });
    vi.unstubAllGlobals();
    return (JSON.parse(sent) as { state: Record<string, unknown> }).state;
  }

  // "both" so one provider serves every shape under test.
  it("gives Jev one state for Cursor, Claude Code and Codex shapes", async () => {
    const pick = (state: Record<string, unknown>) => {
      const selected = Object.fromEntries(semanticFields.map((field) => [field, state[field]]));
      // Compare routing identity, not per-candidate cache arithmetic (token estimates can
      // differ slightly across wire shapes for the same semantic transcript).
      const routings = Array.isArray(state.routings)
        ? (state.routings as Array<{ id: string; label: string; description: string }>).map(
            (entry) => ({
              id: entry.id,
              label: entry.label,
              description: entry.description,
            }),
          )
        : [];
      return { ...selected, routings };
    };
    const openai = await stateFor("openai");
    const anthropic = await stateFor("anthropic");
    const responses = await stateFor("responses");
    expect(pick(anthropic)).toEqual(pick(openai));
    expect(pick(responses)).toEqual(pick(openai));
  });

  it("reads the same ask and failing tool result in every shape", async () => {
    for (const kind of ["openai", "anthropic", "responses"] as const) {
      const state = await stateFor(kind);
      expect(state.last_user_message).toBe(ASK);
      expect(state.session_goal).toBe(ASK);
      expect(state.recent_tool_calls).toEqual([`${TOOL}(<command redacted>)`]);
      expect(state.consecutive_failures).toBe(1);
      expect(String(state.recent_tool_results)).toContain("assert failed");
      expect(JSON.stringify(state.recent_messages)).not.toContain("OS Version");
    }
  });
});

describe("custom routings", () => {
  it("migrates legacy tiers into named routings with default copy", () => {
    const config = parseConfig({
      providers: [
        {
          name: "mock",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "t",
          models: ["m"],
        },
      ],
      routing: {
        tiers: { plan: ["m"], execute: ["m"], utility: [], chat: [] },
      },
    });
    expect(config.routing.routings.map((entry) => entry.id)).toEqual([
      "plan",
      "execute",
      "utility",
      "chat",
    ]);
    expect(config.routing.routings[0]?.label).toBe("Plan");
    expect(config.routing.routings[0]?.description).toContain("planning");
    expect(config.routing.routings[0]?.description).not.toContain("debugging");
    expect(config.routing.routings[1]?.description).toContain("debugging");
    expect(config.routing.tiers.plan).toEqual(["m"]);
  });

  it("advertises and routes a custom routing alias", async () => {
    const config = parseConfig({
      defaultProvider: "mock",
      providers: [
        {
          name: "mock",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "t",
          models: ["frontend-model", "deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1_000 }],
        routings: [
          {
            id: "plan",
            label: "Plan & debug",
            description: "planning",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "execute",
            label: "Execute",
            description: "implementation",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "utility",
            label: "Background",
            description: "summaries",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "chat",
            label: "Chit-chat",
            description: "small talk",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "frontend",
            label: "Frontend",
            description: "React, CSS, UI polish",
            models: ["frontend-model"],
          },
        ],
      },
    });
    const { virtualModels, clientModels, isVirtualModel } = await import("./routing");
    expect(virtualModels(config)).toContain("jevonian/frontend");
    expect(clientModels(config)).toContain("jevonian/frontend");
    expect(isVirtualModel("jevonian/frontend", config)).toBe(true);
    expect(isVirtualModel("jevonian/frontend")).toBe(false);

    const decision = await route({
      config,
      body: {
        model: "jevonian/frontend",
        messages: [{ role: "user", content: "style the button" }],
      },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    expect(decision.phase).toBe("frontend");
    expect(decision.model).toBe("frontend-model");
    expect(decision.reason).toBe("explicit:frontend");
  });

  it("lets the brain pick a custom routing from its description", async () => {
    const config = parseConfig({
      defaultProvider: "mock",
      providers: [
        {
          name: "mock",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "t",
          models: ["frontend-model", "deepseek-v4.1-flash"],
        },
      ],
      routing: {
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1_000 }],
        routings: [
          {
            id: "plan",
            label: "Plan & debug",
            description: "planning",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "execute",
            label: "Execute",
            description: "implementation",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "utility",
            label: "Background",
            description: "summaries",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "chat",
            label: "Chit-chat",
            description: "small talk",
            models: ["deepseek-v4.1-flash"],
          },
          {
            id: "frontend",
            label: "Frontend",
            description: "React, CSS, UI polish",
            models: ["frontend-model"],
          },
        ],
      },
    });
    let criteria: Record<string, string | null> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as {
        questions?: { model?: { criteria?: Record<string, string | null> } };
      };
      criteria = body.questions?.model?.criteria ?? {};
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "frontend", confidence: 0.95 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const decision = await route({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "polish the hero CSS" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    expect(criteria.frontend).toContain("React, CSS");
    expect(decision.phase).toBe("frontend");
    expect(decision.model).toBe("frontend-model");
    expect(decision.reason).toBe("brain:frontend");
  });
});

describe("per-model provider allow-list", () => {
  const picks = [
    { model: "m", provider: "a" },
    { model: "m", provider: "b" },
    { model: "m", provider: "c" },
  ];

  it("keeps discovery order when no list is saved", () => {
    expect(applyProviderPreference(picks).map((entry) => entry.provider)).toEqual(["a", "b", "c"]);
  });

  it("orders named providers first", () => {
    expect(applyProviderPreference(picks, ["c", "a"]).map((entry) => entry.provider)).toEqual([
      "c",
      "a",
    ]);
  });

  it("drops every provider that is not named, so removing one stops the router using it", () => {
    expect(applyProviderPreference(picks, ["b"]).map((entry) => entry.provider)).toEqual(["b"]);
  });

  it("withholds the model when the last provider was removed", () => {
    // Deleting the final chip is not "use them all again" — it means no provider.
    expect(applyProviderPreference(picks, [])).toEqual([]);
    expect(
      applyProviderPreference(
        picks.filter((pick) => pick.provider === "gone"),
        ["b"],
      ),
    ).toEqual([]);
  });

  it("ignores a saved name no provider serves any more", () => {
    expect(applyProviderPreference(picks, ["gone", "a"]).map((entry) => entry.provider)).toEqual([
      "a",
    ]);
  });

  it("applies the per-routing provider list when expanding candidates", () => {
    const config = testConfig({
      providers: [
        {
          name: "alpha",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "a",
          models: ["shared-model"],
        },
        {
          name: "beta",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "b",
          models: ["shared-model"],
        },
      ],
    });
    const entry = {
      models: ["shared-model"],
      providers: { "shared-model": ["beta", "alpha"] },
    };
    expect(routingCandidates(config, entry).map((pick) => pick.provider)).toEqual([
      "beta",
      "alpha",
    ]);
  });

  it("lets a routing drop one provider and keep the other", () => {
    const config = testConfig({
      providers: [
        {
          name: "alpha",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "a",
          models: ["shared-model"],
        },
        {
          name: "beta",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "b",
          models: ["shared-model"],
        },
      ],
    });
    const entry = { models: ["shared-model"], providers: { "shared-model": ["alpha"] } };
    expect(routingCandidates(config, entry).map((pick) => pick.provider)).toEqual(["alpha"]);
  });

  it("withholds a model whose every provider was removed", () => {
    const config = testConfig({
      providers: [
        {
          name: "alpha",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "a",
          models: ["shared-model"],
        },
      ],
    });
    const entry = { models: ["shared-model"], providers: { "shared-model": [] } };
    expect(routingCandidates(config, entry)).toEqual([]);
  });

  it("serves the preferred provider after the brain picks a routing", async () => {
    const config = testConfig({
      providers: [
        {
          name: "alpha",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "a",
          models: ["shared-model"],
        },
        {
          name: "beta",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "b",
          models: ["shared-model"],
        },
      ],
      routing: {
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1_000 }],
        routings: [
          {
            id: "plan",
            label: "Plan",
            description: "planning",
            models: ["shared-model"],
            providers: { "shared-model": ["beta", "alpha"] },
          },
          {
            id: "execute",
            label: "Execute",
            description: "impl",
            models: ["shared-model"],
          },
          {
            id: "utility",
            label: "Background",
            description: "bg",
            models: ["shared-model"],
          },
          {
            id: "chat",
            label: "Chat",
            description: "chat",
            models: ["shared-model"],
          },
        ],
      },
    });
    let brainModels: Array<{ provider: string; preference_rank?: number }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as {
        state?: { routings?: Array<{ id: string; models?: typeof brainModels }> };
        questions?: { model?: { instructions?: string } };
      };
      const plan = body.state?.routings?.find((entry) => entry.id === "plan");
      brainModels = plan?.models ?? [];
      expect(body.questions?.model?.instructions ?? "").toContain("preference order");
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { model: { choice: "plan", confidence: 0.95 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const decision = await decideRoute({
      config,
      body: { model: "auto", messages: [{ role: "user", content: "design the API" }] },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    expect(decision).not.toHaveProperty("error");
    if ("error" in decision) return;
    expect(decision.provider).toBe("beta");
    expect(decision.model).toBe("shared-model");
    expect(brainModels.map((entry) => entry.provider)).toEqual(["beta", "alpha"]);
    expect(brainModels[0]?.preference_rank).toBe(1);
  });

  it("honours the provider allow-list on an explicit routing alias", async () => {
    const config = testConfig({
      providers: [
        {
          name: "alpha",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "a",
          models: ["shared-model"],
        },
        {
          name: "beta",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "b",
          models: ["shared-model"],
        },
      ],
      routing: {
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1_000 }],
        routings: [
          {
            id: "plan",
            label: "Plan",
            description: "planning",
            models: ["shared-model"],
          },
          {
            id: "execute",
            label: "Execute",
            description: "impl",
            models: ["shared-model"],
            providers: { "shared-model": ["beta"] },
          },
          {
            id: "utility",
            label: "Background",
            description: "bg",
            models: ["shared-model"],
          },
          {
            id: "chat",
            label: "Chat",
            description: "chat",
            models: ["shared-model"],
          },
        ],
      },
    });
    const decision = await decideRoute({
      config,
      body: {
        model: "jevonian/execute",
        messages: [{ role: "user", content: "implement it" }],
      },
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    expect(decision).not.toHaveProperty("error");
    if ("error" in decision) return;
    expect(decision.provider).toBe("beta");
    expect(decision.reason).toBe("explicit:execute");
  });
});

describe("cache-aware routing", () => {
  it("exposes recent observed cache reads without claiming a verified prefix", async () => {
    const store = new SessionStore(600_000);
    const input = baseInput(planBody(), store, { "x-session-id": "cache-test" });
    const first = await route(input);
    store.observeCache(first.session, {
      provider: first.provider,
      model: first.model,
      at: input.now!,
      uncachedInputTokens: 100,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
      success: true,
    });
    const next = await route({ ...input, now: input.now! + 1_000 });
    expect(next.cache?.state).toBe("hot");
    expect(next.cache?.prefixMatch).toBe("unknown");
    expect(next.cache?.observedHitRatio).toBeCloseTo(0.9);
    expect(next.cache?.expectedReadTokens).toBeGreaterThan(0);
    expect(next.cache?.costKnown).toBe(true);
    expect(next.switchPenaltyUsd).toBe(0);
    const stale = await route({ ...input, now: input.now! + 300_000 });
    expect(stale.cache?.state).toBe("stale");
    expect(stale.cache?.expectedReadTokens).toBe(0);
    expect(stale.cache?.confidence).toBe(0);
  });

  it("does not carry another provider's hit or stale response into the current model", () => {
    const store = new SessionStore(60_000);
    store.set("s", { phase: "plan", provider: "p", model: "m", turns: 1, updatedAt: 100 });
    const observation = {
      provider: "p",
      model: "m",
      at: 100,
      uncachedInputTokens: 10,
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      success: true,
    };
    store.observeCache("s", observation);
    store.observeCache("s", { ...observation, at: 99, cacheReadTokens: 0 });
    store.observeCache("s", { ...observation, provider: "other", at: 101 });
    store.observeCache("s", { ...observation, success: false, at: 102 });
    expect(store.get("s", 103)?.cache).toEqual(observation);
    expect(store.get("s", 60_101)).toBeUndefined();
  });
});
