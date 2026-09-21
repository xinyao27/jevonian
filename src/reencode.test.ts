import { describe, expect, it } from "vite-plus/test";

import {
  applyDecisions,
  collectToolCalls,
  compact,
  normalizeTranscript,
  reencodeMessages,
} from "./compaction";

describe("reencodeMessages", () => {
  it("rewrites an OpenAI body without touching any other field", () => {
    const body = {
      model: "gpt-x",
      stream: true,
      tools: [{ type: "function", function: { name: "Read" } }],
      messages: [
        { role: "user", content: "fix it" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "contents" },
      ],
    };
    const out = reencodeMessages(body, normalizeTranscript(body));
    expect(out.model).toBe("gpt-x");
    expect(out.stream).toBe(true);
    expect(out.tools).toEqual(body.tools);
    expect(out.messages).toHaveLength(3);
    expect((out.messages as Array<Record<string, unknown>>)[2]).toMatchObject({ role: "user" });
  });

  it("round-trips an Anthropic body into content blocks", () => {
    const body = {
      model: "claude-x",
      messages: [
        { role: "user", content: [{ type: "text", text: "fix it" }] },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "c1", name: "Read", input: { file_path: "a.ts" } }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "c1", content: "contents" }],
        },
      ],
    };
    const out = reencodeMessages(body, normalizeTranscript(body));
    const messages = out.messages as Array<{ content: Array<{ type: string }> }>;
    expect(messages[0]?.content[0]?.type).toBe("text");
    expect(messages[1]?.content[0]?.type).toBe("tool_use");
    expect(messages[2]?.content[0]?.type).toBe("tool_result");
  });

  it("uses `input` for the Responses wire", () => {
    const body = {
      model: "gpt-x",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "fix it" }] },
        { type: "function_call", name: "Read", call_id: "c1", arguments: '{"file_path":"a.ts"}' },
        { type: "function_call_output", call_id: "c1", output: "contents" },
      ],
    };
    const out = reencodeMessages(body, normalizeTranscript(body));
    expect(out.messages).toBeUndefined();
    expect(out.input).toHaveLength(3);
  });

  it("drops a tool result whose call was removed, so the pair is never split", () => {
    const body = {
      model: "gpt-x",
      messages: [
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "Read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "x".repeat(500) },
      ],
    };
    const messages = normalizeTranscript(body);
    const calls = collectToolCalls(messages, 0);
    const kept = applyDecisions(
      messages,
      [
        {
          id: calls[0]!.id,
          tool: "Read",
          keepCall: 0,
          keepResult: 0,
          action: "drop_call",
          reason: "call_dropped",
        },
      ],
      calls,
      300,
    );
    const out = reencodeMessages(body, kept);
    const encoded = out.messages as Array<{ content: Array<{ type: string }> }>;
    // The assistant message lost its only block and the tool result is gone with it.
    expect(encoded).toHaveLength(1);
    expect(encoded[0]?.content[0]).toMatchObject({ type: "text" });
  });
});

describe("compaction over a re-encoded body", () => {
  it("keeps the request usable after dropping a stale call", async () => {
    const body = {
      model: "gpt-x",
      messages: [
        { role: "user", content: "Never edit src/generated. Fix the test." },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", function: { name: "Read", arguments: '{"file_path":"a.ts"}' } }],
        },
        { role: "tool", tool_call_id: "c1", content: "a".repeat(4000) },
        { role: "user", content: "keep going" },
      ],
    };
    const messages = normalizeTranscript(body);
    const result = await compact(
      messages,
      {
        ask: async (_state, questions) => ({
          answers: Object.fromEntries(
            Object.keys(questions).map((key) => [
              key,
              { noul: key.startsWith("call_") ? 0.9 : 0.1 },
            ]),
          ),
        }),
      },
      { preserveRecentMessages: 0 },
    );
    expect(result.decisions[0]?.action).toBe("drop_result");
    const out = reencodeMessages(body, result.messages);
    const encoded = JSON.stringify(out);
    // The call survives, its long result is truncated rather than lost.
    expect(encoded).toContain('"tool_use"');
    expect(encoded).toContain("jevonian truncated");
    expect(encoded).toContain("Never edit src/generated");
    // What shrank is the payload the model reads, not the JSON envelope: re-encoding into block
    // form is more verbose than the terse chat shape, so compare the result text alone.
    expect(result.stats.charsAfter).toBeLessThan(result.stats.charsBefore / 2);
  });
});
