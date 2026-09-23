import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { readRecords, resetLedgerCache } from "./ledger";
import { resetQuotaCache } from "./quota";
import { SessionStore } from "./routing";
import { createApp } from "./server";

let dir = "";
const saved: Record<string, string | undefined> = {};

/** A pinned model never consults the brain, so most tests here need no brain stub. */
function config() {
  return parseConfig({
    defaultProvider: "flaky",
    providers: [
      {
        name: "flaky",
        type: "openai",
        baseUrl: "https://flaky.example/v1",
        apiKey: "flaky-key",
        models: ["flaky-model"],
      },
    ],
    routing: { mode: "auto" },
  });
}

/** The same provider, reachable through `jevonian/auto`, which sends the turn via the brain. */
function brainConfig() {
  return parseConfig({
    defaultProvider: "flaky",
    providers: [
      {
        name: "flaky",
        type: "openai",
        baseUrl: "https://flaky.example/v1",
        apiKey: "flaky-key",
        models: ["flaky-model"],
      },
    ],
    routing: {
      mode: "auto",
      brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 5_000 }],
      tiers: {
        plan: ["flaky-model"],
        execute: ["flaky-model"],
        utility: ["flaky-model"],
        chat: ["flaky-model"],
      },
    },
  });
}

function chatRequest(app: ReturnType<typeof createApp>, model = "flaky-model") {
  return app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

function chatCompletion(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** The JSON body of a response, as a loosely typed record the assertions can walk. */
async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

/** The first choice's assistant message content, or undefined. */
async function contentOf(response: Response): Promise<unknown> {
  const choices = (await bodyOf(response)).choices as Array<Record<string, unknown>>;
  return (choices[0]?.message as Record<string, unknown> | undefined)?.content;
}

/** The error message of a JSON error response, or undefined. */
async function errorMessageOf(response: Response): Promise<unknown> {
  return ((await bodyOf(response)).error as Record<string, unknown> | undefined)?.message;
}

/** The transport failure shape Node's fetch produces when a proxy drops the socket. */
function socketReset(): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

/** Ledger rows for the turn itself, in write order. */
function turnRecords() {
  return readRecords().filter((record) => record.kind !== "brain");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-retry-"));
  for (const key of [
    "JEVONIAN_DATA_DIR",
    "JEVONIAN_LEDGER",
    "JEVONIAN_UPSTREAM_RETRIES",
    "TYPESAFE_API_KEY",
  ]) {
    saved[key] = process.env[key];
  }
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.TYPESAFE_API_KEY = "test-key";
  // One retry keeps the suite fast; the budget itself is covered by retry.test.ts.
  process.env.JEVONIAN_UPSTREAM_RETRIES = "1";
  resetQuotaCache();
  resetLedgerCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetQuotaCache();
  resetLedgerCache();
  rmSync(dir, { recursive: true, force: true });
});

describe("upstream retry on transient failure", () => {
  it("repeats a socket reset and answers the turn", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      if (hits === 1) throw socketReset();
      return chatCompletion();
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await chatRequest(app);

    expect(response.status).toBe(200);
    expect(await contentOf(response)).toBe("ok");
    // The client can see that the turn was recovered rather than served on the first try.
    expect(response.headers.get("x-jevonian-retries")).toBe("1");
    expect(hits).toBe(2);

    const records = turnRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe(200);
    expect(records[0]?.retries).toBe(1);
  });

  it("repeats a gateway 502 and answers the turn", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      if (hits === 1) return new Response("bad gateway", { status: 502 });
      return chatCompletion();
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await chatRequest(app);

    expect(response.status).toBe(200);
    expect(hits).toBe(2);
    expect(turnRecords()[0]?.retries).toBe(1);
  });

  it("reports the failure after the retry budget is spent", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      throw socketReset();
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await chatRequest(app);

    expect(response.status).toBe(502);
    expect(hits).toBe(2);
    expect(await errorMessageOf(response)).toContain("Upstream request failed");

    const records = turnRecords();
    expect(records[0]?.status).toBe(502);
    expect(records[0]?.retries).toBe(1);
    expect(records[0]?.error).toContain("fetch failed");
  });

  it("uses three attempts by default when no budget is configured", async () => {
    delete process.env.JEVONIAN_UPSTREAM_RETRIES;
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      throw socketReset();
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await chatRequest(app);

    expect(response.status).toBe(502);
    expect(hits).toBe(3);
  });

  it("does not repeat a request the upstream rejected on its merits", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await chatRequest(app);

    expect(response.status).toBe(400);
    expect(hits).toBe(1);
    // A turn that never retried carries no retry field at all.
    expect(turnRecords()[0]?.retries).toBeUndefined();
    expect(response.headers.get("x-jevonian-retries")).toBeNull();
  });

  it("leaves a 429 to the quota-failover path instead of retrying the same host", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      return new Response(JSON.stringify({ error: { message: "slow down" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await chatRequest(app);

    expect(response.status).toBe(429);
    expect(hits).toBe(1);
  });

  it("retries the routing brain call, so one dropped socket does not fail the turn", async () => {
    // A virtual model sends the turn through the brain first. A transient failure there used to
    // end the turn with a 502 before any model was asked.
    let brainHits = 0;
    let upstreamHits = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.includes("systemone")) {
        brainHits += 1;
        if (brainHits === 1) throw socketReset();
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { model: { choice: "execute", confidence: 0.9 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      upstreamHits += 1;
      return chatCompletion();
    });

    const app = createApp({ config: brainConfig() }, new SessionStore(60_000));
    const response = await chatRequest(app, "jevonian/auto");

    expect(response.status).toBe(200);
    expect(brainHits).toBe(2);
    expect(upstreamHits).toBe(1);
    // The turn's own upstream call succeeded first try, so it carries no retry count: the
    // repeated attempt belonged to the brain, which is a separate ledger row.
    expect(turnRecords()[0]?.retries).toBeUndefined();
  });

  it("retries the bridged Chat Completions call behind a Responses client", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      if (hits === 1) return new Response("bad gateway", { status: 502 });
      return new Response(
        [
          'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"}}]}\n\n',
          'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n',
          "data: [DONE]\n\n",
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "flaky-model",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(hits).toBe(2);
    const text = await response.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain("response.completed");
    expect(turnRecords()[0]?.retries).toBe(1);
  });

  it("retries an Anthropic-wire turn too", async () => {
    let hits = 0;
    vi.stubGlobal("fetch", async () => {
      hits += 1;
      if (hits === 1) throw socketReset();
      return new Response(
        JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const anthropicConfig = parseConfig({
      defaultProvider: "flaky",
      providers: [
        {
          name: "flaky",
          type: "anthropic",
          baseUrl: "https://flaky.example",
          apiKey: "flaky-key",
          models: ["flaky-model"],
        },
      ],
      routing: { mode: "auto" },
    });

    const app = createApp({ config: anthropicConfig }, new SessionStore(60_000));
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "flaky-model",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(hits).toBe(2);
    expect(turnRecords()[0]?.retries).toBe(1);
  });
});
