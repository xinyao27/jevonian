import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { resetQuotaCache } from "./quota";
import { SessionStore } from "./routing";
import { createApp } from "./server";

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-gemini-bridge-"));
  for (const key of ["JEVONIAN_DATA_DIR", "JEVONIAN_LEDGER", "TYPESAFE_API_KEY"]) {
    saved[key] = process.env[key];
  }
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
  process.env.TYPESAFE_API_KEY = "test-key";
  resetQuotaCache();
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

describe("Responses → Antigravity Gemini bridge", () => {
  const config = () =>
    parseConfig({
      defaultProvider: "antigravity",
      providers: [
        {
          name: "antigravity",
          type: "gemini",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          apiKey: "ag-key",
          billing: "subscription",
          models: ["gemini-3.8-flash-tiered"],
        },
      ],
      routing: {
        mode: "auto",
        brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY", timeoutMs: 1_000 }],
        tiers: {
          plan: ["gemini-3-8-flash"],
          execute: ["gemini-3-8-flash"],
          utility: ["gemini-3-8-flash"],
          chat: ["gemini-3-8-flash"],
        },
      },
    });

  it("sends a Gemini envelope (contents), not Chat Completions fields", async () => {
    let upstreamBody: Record<string, unknown> = {};
    let upstreamUrl = "";
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.includes("typesafe") || url.includes("systemone") || url.includes("evaluation")) {
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { model: { choice: "chat", confidence: 0.99 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      upstreamUrl = url;
      upstreamBody = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      // Non-stream Responses path expects a single Gemini JSON payload.
      return new Response(
        JSON.stringify({
          response: {
            candidates: [
              {
                content: { role: "model", parts: [{ text: "I am gemini-3.8-flash-tiered" }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jevonian/auto",
        stream: false,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "你是什么模型" }],
          },
        ],
        tools: [
          {
            type: "function",
            name: "exec_command",
            description: "Run a shell command.",
            parameters: { type: "object", properties: { cmd: { type: "string" } } },
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-jevonian-provider")).toBe("antigravity");
    expect(upstreamUrl).toContain("v1internal:generateContent");
    // Antigravity wrapper — never a bare OpenAI Chat Completions body.
    expect(upstreamBody.model).toBe("gemini-3.8-flash-tiered");
    expect(upstreamBody.userAgent).toBe("antigravity");
    expect(upstreamBody.messages).toBeUndefined();
    expect(upstreamBody.stream).toBeUndefined();
    expect(upstreamBody.tools).toBeUndefined();
    expect(upstreamBody.tool_choice).toBeUndefined();
    expect(upstreamBody.reasoning_effort).toBeUndefined();
    expect(upstreamBody.prompt_cache_key).toBeUndefined();
    const request = upstreamBody.request as Record<string, unknown>;
    expect(Array.isArray(request.contents)).toBe(true);
    expect(request.contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          parts: expect.arrayContaining([expect.objectContaining({ text: "你是什么模型" })]),
        }),
      ]),
    );
    expect(Array.isArray(request.tools)).toBe(true);
    const json = (await response.json()) as {
      model?: string;
      status?: string;
      output?: Array<{ content?: Array<{ text?: string }> }>;
    };
    expect(json.model).toBe("gemini-3.8-flash-tiered");
    expect(json.status).toBe("completed");
    expect(json.output?.[0]?.content?.[0]?.text).toBe("I am gemini-3.8-flash-tiered");
  });

  it("streams Gemini SSE into Responses text deltas (not an empty completed)", async () => {
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url.includes("typesafe") || url.includes("systemone") || url.includes("evaluation")) {
        return new Response(
          JSON.stringify({
            model: "jev-1.13.0",
            answers: { model: { choice: "chat", confidence: 0.99 } },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(url).toContain("streamGenerateContent");
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      expect(body.messages).toBeUndefined();
      expect(body.request?.contents).toBeDefined();
      const sse = [
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"pong"}]}}]}}\n\n',
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":""}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":6,"candidatesTokenCount":1}}}\n\n',
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const app = createApp({ config: config() }, new SessionStore(60_000));
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jevonian/auto",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Reply with exactly: pong" }],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-jevonian-provider")).toBe("antigravity");
    const text = await response.text();
    expect(text).toContain("response.output_text.delta");
    expect(text).toContain('"delta":"pong"');
    expect(text).toContain("response.completed");
    // Completed must carry the assistant message — empty output was the silent-done bug.
    expect(text).toMatch(/"type":"response\.completed"[\s\S]*"output":\[\s*\{\s*"type":"message"/);
  });
});
