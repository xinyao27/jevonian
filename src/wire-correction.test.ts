import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { parseConfig, parseModelEntries, mergeModelEntries } from "./config";
import { SessionStore } from "./routing";
import { createApp } from "./server";

describe("model entry parse", () => {
  it("accepts bare strings and { id, wire } objects", () => {
    expect(parseModelEntries(["a", { id: "b", wire: "anthropic" }, { model: "c" }])).toEqual([
      { id: "a" },
      { id: "b", wire: "anthropic" },
      { id: "c" },
    ]);
  });

  it("preserves wire pins when the UI saves bare ids", () => {
    const merged = mergeModelEntries(
      [{ id: "keep", wire: "responses" }, { id: "drop" }],
      ["keep", "new"],
    );
    expect(merged).toEqual([{ id: "keep", wire: "responses" }, { id: "new" }]);
  });
});

describe("OpenCode Responses passthrough", () => {
  let dir = "";
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "jevonian-wire-"));
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

  it("forwards Codex /responses to OpenCode /responses without a Chat bridge", async () => {
    const config = parseConfig({
      defaultProvider: "opencode-go",
      providers: [
        {
          name: "opencode-go",
          type: "both",
          baseUrl: "https://opencode.ai/zen/go/v1",
          apiKey: "go-key",
          billing: "subscription",
          models: ["deepseek-v4.1-flash"],
        },
      ],
      routing: { mode: "off" },
    });

    const hits: string[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      hits.push(url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};
      expect(url).toContain("/responses");
      expect(url).not.toContain("/chat/completions");
      expect(url).not.toContain("/messages");
      expect(body.input).toBeDefined();
      expect(body.messages).toBeUndefined();
      return new Response(
        [
          'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
          'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\n',
          'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"ok"}]}],"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
        ].join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });

    const app = createApp({ config }, new SessionStore(60_000));
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "deepseek-v4.1-flash",
        stream: true,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });

    expect(response.status).toBe(200);
    expect(hits).toEqual(["https://opencode.ai/zen/go/v1/responses"]);
    expect(await response.text()).toContain("response.output_text.delta");
  });
});
