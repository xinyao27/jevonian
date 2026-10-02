import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { readRecords } from "./ledger";
import { resetQuotaCache } from "./quota";
import { SessionStore } from "./routing";
import { createApp } from "./server";
import { resetTraces, traceFor } from "./trace";

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-trace-"));
  for (const key of ["JEVONIAN_DATA_DIR", "JEVONIAN_LEDGER", "TYPESAFE_API_KEY"]) {
    saved[key] = process.env[key];
  }
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.TYPESAFE_API_KEY = "test-key";
  resetQuotaCache();
  resetTraces();
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetQuotaCache();
  resetTraces();
  rmSync(dir, { recursive: true, force: true });
});

function config(routing: Record<string, unknown> = {}) {
  return parseConfig({
    defaultProvider: "primary",
    providers: [
      {
        name: "primary",
        type: "openai",
        baseUrl: "https://primary.example/v1",
        apiKey: "primary-key",
        models: ["model-a"],
      },
      {
        name: "secondary",
        type: "openai",
        baseUrl: "https://secondary.example/v1",
        apiKey: "secondary-key",
        models: ["model-b"],
      },
    ],
    routing: {
      mode: "auto",
      brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1_000 }],
      tiers: {
        plan: ["model-a", "model-b"],
        execute: ["model-a", "model-b"],
        utility: ["model-b"],
        chat: ["model-b"],
      },
      ...routing,
    },
  });
}

function brain(): Response {
  return new Response(
    JSON.stringify({
      model: "jev-1.13.0",
      answers: { model: { choice: "execute", confidence: 0.9 } },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function chatJson(content = "ok"): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-1",
      choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function chatSse(): Response {
  return new Response(
    [
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":"hi"}}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function send(body: Record<string, unknown> = {}) {
  const app = createApp({ config: config() } as never, new SessionStore(60_000));
  const response = await app.request("/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content: "hi" }], ...body }),
  });
  return { response, records: readRecords().filter((record) => record.kind !== "brain") };
}

describe("a clean turn", () => {
  it("carries no attempts, so a healthy row stays as small as before", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("typesafe") ? brain() : chatJson(),
    );
    const { response, records } = await send();

    expect(response.status).toBe(200);
    const record = records.at(-1)!;
    expect(record.tries).toBeUndefined();
    expect(record.failovers).toBeUndefined();
    // The trace still exists, so the dashboard can show the order the turn chose from.
    const trace = traceFor(record.id!)!;
    expect(trace.done).toBe(true);
    expect(trace.tries).toHaveLength(1);
    expect(trace.tries[0]?.cause).toBe("initial");
  });

  it("reports the request id on the response so a client log can be joined", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("typesafe") ? brain() : chatJson(),
    );
    const { response, records } = await send();
    const requestId = response.headers.get("x-jevonian-request-id");
    expect(requestId).toBeTruthy();
    expect(records.at(-1)?.id).toBe(requestId);
    expect(traceFor(requestId!)?.requestId).toBe(requestId);
  });

  it("records the candidate order the turn chose from", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("typesafe") ? brain() : chatJson(),
    );
    const { response } = await send();
    const trace = traceFor(response.headers.get("x-jevonian-request-id")!)!;
    expect(trace.order.length).toBeGreaterThan(1);
    expect(trace.order.map((candidate) => candidate.rank)).toEqual(
      trace.order.map((_, index) => index),
    );
    expect(trace.order[0]?.provider).toBe("primary");
  });
});

describe("a quota failover", () => {
  it("records both attempts and counts the failover", async () => {
    let primaryHits = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("typesafe")) return brain();
      if (String(url).includes("primary.example")) {
        primaryHits += 1;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "GoUsageLimitError", message: "Weekly usage limit reached." },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      return chatJson();
    });

    const { response, records } = await send();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-jevonian-provider")).toBe("secondary");
    expect(primaryHits).toBe(1);

    const record = records.at(-1)!;
    expect(record.failovers).toBe(1);
    expect(record.tries).toHaveLength(2);
    expect(record.tries?.[0]).toMatchObject({
      provider: "primary",
      model: "model-a",
      cause: "initial",
      status: 429,
      fail: "quota",
    });
    expect(record.tries?.[1]).toMatchObject({
      provider: "secondary",
      model: "model-b",
      cause: "failover",
      status: 200,
    });
  });

  it("moves the trace's phase and reason onto the provider that served the turn", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("typesafe")) return brain();
      if (String(url).includes("primary.example")) {
        return new Response(JSON.stringify({ error: { type: "GoUsageLimitError" } }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return chatJson();
    });

    const { response } = await send();
    const trace = traceFor(response.headers.get("x-jevonian-request-id")!)!;
    expect(trace.reason).toContain("quota-failover");
    expect(trace.failovers).toBe(1);
    expect(trace.order.some((candidate) => candidate.provider === "secondary")).toBe(true);
  });
});

describe("a transient upstream failure", () => {
  it("records the failed attempt and the retry, without calling it a failover", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("typesafe")) return brain();
      attempts += 1;
      if (attempts === 1) {
        return new Response("bad gateway", { status: 502 });
      }
      return chatJson();
    });

    const { response, records } = await send();
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);

    const record = records.at(-1)!;
    expect(record.retries).toBe(1);
    expect(record.failovers).toBeUndefined();
    expect(record.tries?.map((attempt) => attempt.cause)).toEqual(["initial", "retry"]);
    expect(record.tries?.[0]?.fail).toBe("HTTP 502");
  });
});

describe("a streamed turn", () => {
  it("records a first-token time once content reaches the client", async () => {
    vi.stubGlobal("fetch", async (url: string) =>
      String(url).includes("typesafe") ? brain() : chatSse(),
    );
    const { response } = await send({ stream: true });
    expect(response.status).toBe(200);
    // Reading the body is what drives the stream and its keepalive wrapper.
    const text = await response.text();
    expect(text).toContain("data:");

    // Read the ledger only after the stream flushed: the row is written on the last byte.
    const record = readRecords()
      .filter((entry) => entry.kind !== "brain")
      .at(-1)!;
    expect(record.ttftMs).toBeGreaterThanOrEqual(0);
    expect(traceFor(record.id!)?.ttftMs).toBe(record.ttftMs);
    expect(traceFor(record.id!)?.tries[0]?.ttftMs).toBeGreaterThanOrEqual(0);
  });
});

describe("a refused turn", () => {
  it("closes the trace with the upstream status when every provider refuses", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (String(url).includes("typesafe")) return brain();
      return new Response(JSON.stringify({ error: { type: "GoUsageLimitError" } }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const { response, records } = await send();
    expect(response.status).toBe(429);
    const record = records.at(-1)!;
    const trace = traceFor(record.id!)!;
    expect(trace.done).toBe(true);
    expect(trace.status).toBe(429);
    // Every provider got one shot before the refusal was surfaced.
    expect(trace.tries).toHaveLength(2);
    expect(trace.failovers).toBe(1);
  });
});
