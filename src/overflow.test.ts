import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { JevResponse } from "./compaction";
import { parseConfig } from "./config";
import { resetQuotaCache } from "./quota";
import { SessionStore } from "./routing";

let dir = "";
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-overflow-"));
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

/** A conversation with one stale tool call and one the assistant is still working from. */
function longBody() {
  return {
    model: "auto",
    messages: [
      { role: "user", content: "Never edit src/generated. Fix the failing test." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "old", function: { name: "Read", arguments: '{"file_path":"huge.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "old", content: "stale ".repeat(3_000) },
      { role: "assistant", content: "That file was unrelated; checking the real one." },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "new", function: { name: "Bash", arguments: '{"command":"npm test"}' } },
        ],
      },
      { role: "tool", tool_call_id: "new", content: "FAIL b.test.ts: expected 2 to be 3" },
      { role: "user", content: "go ahead and fix it" },
    ],
  };
}

const config = () =>
  parseConfig({
    defaultProvider: "sub",
    providers: [
      {
        name: "sub",
        type: "openai",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        models: ["tiny-model"],
      },
    ],
    routing: {
      mode: "auto",
      tiers: { plan: ["tiny-model"], execute: ["tiny-model"] },
      brains: [{ channel: "typesafe", apiKeyEnv: "TYPESAFE_API_KEY" }],
      // A window far smaller than the conversation, so overflow is guaranteed.
      capacities: { "tiny-model": { contextWindow: 2_000 } },
    },
  });

describe("context overflow", () => {
  it("flags the overflow and compacts the history before routing again", async () => {
    const seen: Array<{ keys: string[]; messageCount: number }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as {
        questions?: Record<string, unknown>;
        state?: { candidates?: Array<{ model: string }>; history?: unknown[] };
      };
      const keys = Object.keys(body.questions ?? {});
      seen.push({ keys, messageCount: body.state?.history?.length ?? 0 });
      // Model choice or the two compaction probes per tool call.
      const answers: Record<string, unknown> = {
        model: { choice: "tiny-model", confidence: 0.9 },
        effort: { choice: "low", confidence: 0.9 },
      };
      for (const key of keys) {
        if (key.startsWith("call_")) answers[key] = { noul: key === "call_t1" ? 0.05 : 0.95 };
        if (key.startsWith("result_")) answers[key] = { noul: 0.05 };
      }
      return new Response(JSON.stringify({ model: "jev", answers }), { status: 200 });
    });

    const { decideRoute } = await import("./routing");
    const decision = await decideRoute({
      config: config(),
      body: longBody(),
      headers: {},
      store: new SessionStore(60_000),
      kind: "openai",
      now: 1_000,
    });
    if ("error" in decision) throw new Error(decision.error);
    expect(decision.contextOverflow).toBe(true);
    expect(decision.skipped?.[0]).toMatchObject({ model: "tiny-model", reason: "context" });
    // The brain still answered, so the turn is routed rather than failed.
    expect(decision.model).toBe("tiny-model");
    expect(seen[0]?.keys).toEqual(["model", "effort"]);
  });

  it("compacts by dropping only what Jev rejects, keeping prose verbatim", async () => {
    const { normalizeTranscript, compact } = await import("./compaction");
    const { askJevRaw } = await import("./brain");
    let captured: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      const body = JSON.parse((init.body as string) ?? "{}") as Record<string, unknown>;
      captured = body;
      const keys = Object.keys((body.questions as Record<string, unknown>) ?? {});
      const answers: Record<string, unknown> = {};
      for (const key of keys) {
        // The stale call is rejected; the live one is kept.
        answers[key] = { noul: key.includes("t1") ? 0.05 : 0.95 };
      }
      return new Response(JSON.stringify({ model: "jev", answers }), { status: 200 });
    });

    const messages = normalizeTranscript(longBody());
    const brain = config().routing.brains[0];
    if (!brain) throw new Error("missing brain");
    const result = await compact(
      messages,
      {
        ask: async (state, questions) => {
          const { answers } = await askJevRaw(
            brain,
            state as unknown as Record<string, unknown>,
            questions,
          );
          return { answers: answers as JevResponse["answers"] };
        },
      },
      { preserveRecentMessages: 0 },
    );

    // Prose survives untouched, in order.
    const text = result.messages.map((message) => message.text).filter(Boolean);
    expect(text).toEqual([
      "Never edit src/generated. Fix the failing test.",
      "That file was unrelated; checking the real one.",
      "go ahead and fix it",
    ]);
    // The stale call and its result are gone; the live pair is intact.
    const remaining = result.messages.flatMap((message) =>
      message.toolUses.map((t) => t.tool_use_id),
    );
    expect(remaining).toEqual(["new"]);
    expect(result.stats.callsDropped).toBeGreaterThan(0);
    // The state sent to Jev carried the results as notes, never their contents.
    expect(JSON.stringify(captured.state)).not.toContain("stale stale");
  });
});
