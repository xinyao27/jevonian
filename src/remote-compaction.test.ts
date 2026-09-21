import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig } from "./config";
import { splitSseEvents } from "./responses";
import { SessionStore } from "./routing";
import { createApp } from "./server";

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-compact-"));
  for (const key of ["JEVONIAN_DATA_DIR", "JEVONIAN_LEDGER"]) {
    saved[key] = process.env[key];
  }
  process.env.JEVONIAN_DATA_DIR = dir;
  process.env.JEVONIAN_LEDGER = join(dir, "ledger.jsonl");
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("Codex remote compaction v2", () => {
  it("pins compaction_trigger requests to the ChatGPT Responses provider", async () => {
    const config = parseConfig({
      defaultProvider: "deepseek",
      providers: [
        {
          name: "deepseek",
          type: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "ds-key",
          models: ["deepseek-v4.1-flash"],
        },
        {
          name: "chatgpt-subscription",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiKey: "codex-key",
          billing: "subscription",
          models: ["gpt-5.4"],
        },
      ],
      routing: {
        mode: "auto",
        brains: [],
        tiers: {
          plan: ["deepseek-v4.1-flash"],
          execute: ["deepseek-v4.1-flash"],
          utility: ["deepseek-v4.1-flash"],
          chat: ["deepseek-v4.1-flash"],
        },
      },
    });

    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      hits.push(url);
      expect(url).toContain("chatgpt.com");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as {
        input?: Array<{ type?: string }>;
        model?: string;
      };
      expect(body.input?.some((item) => item.type === "compaction_trigger")).toBe(true);
      expect(body.model).toBe("gpt-5.4");

      const sse = [
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","id":"cmp_1","encrypted_content":"compact-payload"}}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_compact","object":"response","model":"gpt-5.4","status":"completed","output":[],"usage":{"input_tokens":9,"output_tokens":4,"total_tokens":13}}}\n\n',
      ].join("");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    const app = createApp({ config } as never, new SessionStore(60_000));
    const response = await app.request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jevonian/auto",
        stream: true,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "long history" }],
          },
          { type: "compaction_trigger" },
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(hits.some((url) => url.includes("deepseek"))).toBe(false);
    expect(hits.some((url) => url.includes("chatgpt.com"))).toBe(true);

    const text = await response.text();
    const { events } = splitSseEvents(text);
    const itemDone = events.find((event) => event.type === "response.output_item.done");
    expect(itemDone).toMatchObject({
      item: { type: "compaction", id: "cmp_1", encrypted_content: "compact-payload" },
    });
    const completed = events.find((event) => event.type === "response.completed");
    expect(completed).toMatchObject({
      response: {
        output: [{ type: "compaction", id: "cmp_1" }],
      },
    });
  });

  it("rejects remote compaction when no Responses provider is configured", async () => {
    const config = parseConfig({
      defaultProvider: "deepseek",
      providers: [
        {
          name: "deepseek",
          type: "openai",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "ds-key",
          models: ["deepseek-v4.1-flash"],
        },
      ],
      routing: { mode: "off", brains: [], tiers: { plan: [], execute: [], utility: [], chat: [] } },
    });

    vi.stubGlobal("fetch", async () => {
      throw new Error("upstream should not be called");
    });

    const app = createApp({ config } as never, new SessionStore(60_000));
    const response = await app.request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: true,
        input: [{ type: "compaction_trigger" }],
      }),
    });

    expect(response.status).toBe(400);
    const json = (await response.json()) as { error?: { message?: string } };
    expect(json.error?.message).toMatch(/ChatGPT subscription/i);
  });

  it("does not quota-failover remote compaction onto a Chat Completions host", async () => {
    const config = parseConfig({
      defaultProvider: "openrouter",
      providers: [
        {
          name: "chatgpt-subscription",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          apiKey: "codex-key",
          billing: "subscription",
          models: ["gpt-5.4"],
        },
        {
          name: "openrouter",
          type: "openai",
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "or-key",
          models: ["openai/gpt-5.4"],
        },
      ],
      routing: {
        mode: "auto",
        brains: [],
        tiers: {
          plan: ["gpt-5.4", "openai/gpt-5.4"],
          execute: ["gpt-5.4", "openai/gpt-5.4"],
          utility: [],
          chat: [],
        },
      },
    });

    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      hits.push(url);
      if (url.includes("chatgpt.com")) {
        return new Response(
          JSON.stringify({
            error: { message: "Weekly usage limit reached. Resets in 4h.", type: "usage_limit" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected upstream ${url}`);
    });

    const app = createApp({ config } as never, new SessionStore(60_000));
    const response = await app.request("http://127.0.0.1/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "jevonian/auto",
        stream: true,
        input: [{ type: "compaction_trigger" }],
      }),
    });

    expect(response.status).toBe(429);
    expect(hits.every((url) => url.includes("chatgpt.com"))).toBe(true);
    expect(hits.some((url) => url.includes("openrouter"))).toBe(false);
    const text = await response.text();
    expect(text).toMatch(/Weekly usage limit/i);
  });
});
