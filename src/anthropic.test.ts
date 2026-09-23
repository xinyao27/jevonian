import { describe, expect, it } from "vite-plus/test";

import {
  anthropicResult,
  anthropicToChat,
  anthropicToChatRequest,
  anthropicToChatStream,
  anthropicToolId,
  chatToAnthropic,
  chatToAnthropicMessage,
  needsAnthropicWire,
} from "./anthropic";
describe("needsAnthropicWire", () => {
  it("detects Claude-family models", () => {
    expect(needsAnthropicWire("claude-fable-5-1")).toBe(true);
    expect(needsAnthropicWire("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(needsAnthropicWire("deepseek-v4.1-flash")).toBe(false);
    expect(needsAnthropicWire("z-ai/glm-5.3-flash")).toBe(false);
  });
});

describe("anthropicToChatRequest / chatToAnthropicMessage", () => {
  it("round-trips a simple probe through the OpenAI wire", () => {
    const request = anthropicToChatRequest(
      {
        model: "claude-haiku-4-5-20251001",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      },
      "deepseek/deepseek-v4.1-flash",
    );
    expect(request).toMatchObject({
      model: "deepseek/deepseek-v4.1-flash",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });
    const response = chatToAnthropicMessage(
      {
        id: "chatcmpl-1",
        model: "deepseek/deepseek-v4.1-flash",
        choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 1 },
      },
      "deepseek/deepseek-v4.1-flash",
    );
    expect(response).toMatchObject({
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });
});

describe("chatToAnthropic", () => {
  it("maps messages, tools, and tool results", () => {
    const request = chatToAnthropic({
      model: "ignored",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "fix the bug" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "read", arguments: '{"p":"a"}' } },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "Error: test failed" },
      ],
      tools: [
        {
          type: "function",
          function: { name: "read", description: "read a file", parameters: { type: "object" } },
        },
      ],
      max_tokens: 512,
      temperature: 0.2,
      tool_choice: { type: "function", function: { name: "read" } },
    });

    expect(request.system).toBe("be brief");
    expect(request.max_tokens).toBe(512);
    expect(request.temperature).toBe(0.2);
    const messages = request.messages as Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>;
    expect(messages[0]).toEqual({ role: "user", content: [{ type: "text", text: "fix the bug" }] });
    expect(messages[1]?.content[0]).toEqual({
      type: "tool_use",
      id: "call_1",
      name: "read",
      input: { p: "a" },
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "Error: test failed" }],
    });
    expect(request.tools).toEqual([
      { name: "read", description: "read a file", input_schema: { type: "object" } },
    ]);
    expect(request.tool_choice).toEqual({ type: "tool", name: "read" });
  });

  it("defaults max_tokens like Anthropic requires", () => {
    const request = chatToAnthropic({ messages: [{ role: "user", content: "hi" }] });
    expect(request.max_tokens).toBe(4_096);
  });

  it("flattens array tool content to a string", () => {
    const request = chatToAnthropic({
      messages: [
        { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "line one" }] },
      ],
    });
    const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages[0]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "call_1",
      content: "line one",
    });
  });

  it("sanitizes tool ids to Anthropic's charset and keeps call/result paired", () => {
    const dirty = "call:abc.def/1";
    const request = chatToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: dirty, type: "function", function: { name: "read", arguments: "{}" } },
          ],
        },
        { role: "tool", tool_call_id: dirty, content: "ok" },
      ],
    });
    const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const useId = messages[0]?.content[0]?.id;
    const resultId = messages[1]?.content[0]?.tool_use_id;
    expect(String(useId)).toMatch(/^call_abc_def_1_[a-f0-9]{8}$/);
    expect(resultId).toBe(useId);
  });

  it("keeps ids distinct when they differ only in punctuation", () => {
    const ids = ["call:a", "call.a", "call_a"].map((id) => anthropicToolId(id));
    expect(new Set(ids).size).toBe(3);
    expect(ids[2]).toBe("call_a");
    for (const id of ids) expect(id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("truncates long ids to Anthropic's length limit", () => {
    const id = anthropicToolId(`call.${"x".repeat(200)}`);
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it("hashes empty or unrecoverable tool ids deterministically", () => {
    const request = chatToAnthropic({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "", content: "ok" },
      ],
    });
    const messages = request.messages as Array<{ content: Array<Record<string, unknown>> }>;
    const useId = String(messages[0]?.content[0]?.id);
    expect(useId).toMatch(/^tool_[a-f0-9]{24}$/);
    expect(messages[1]?.content[0]?.tool_use_id).toBe(useId);
  });
});

describe("anthropicToChat", () => {
  it("translates a message response with tool use", () => {
    const completion = anthropicToChat(
      {
        id: "msg_1",
        model: "claude-fable-5-1",
        content: [
          { type: "text", text: "hello " },
          { type: "tool_use", id: "toolu_1", name: "edit", input: { path: "a" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
      },
      "fallback",
    );
    expect(completion.id).toBe("msg_1");
    expect(completion.choices).toMatchObject([
      {
        message: {
          role: "assistant",
          content: "hello ",
          tool_calls: [{ id: "toolu_1", function: { name: "edit", arguments: '{"path":"a"}' } }],
        },
        finish_reason: "tool_calls",
      },
    ]);
    expect(completion.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });

  it("maps stop reasons", () => {
    expect(anthropicResult({ stop_reason: "end_turn" }).finishReason).toBe("stop");
    expect(anthropicResult({ stop_reason: "max_tokens" }).finishReason).toBe("length");
    expect(anthropicResult({ stop_reason: "refusal" }).finishReason).toBe("content_filter");
  });
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

describe("anthropicToChatStream", () => {
  it("turns Anthropic SSE into chat deltas", async () => {
    let finished: { input: number; output: number } | undefined;
    const transform = anthropicToChatStream("claude-fable-5-1", (usage) => {
      finished = { input: usage.input, output: usage.output };
    });
    const writer = transform.writable.getWriter();
    const readPromise = collect(transform.readable);
    const send = (payload: unknown): Promise<void> =>
      writer.write(new TextEncoder().encode(`event: x\ndata: ${JSON.stringify(payload)}\n\n`));

    await send({
      type: "message_start",
      message: { usage: { input_tokens: 12, cache_read_input_tokens: 5 } },
    });
    await send({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "toolu_1", name: "edit" },
    });
    await send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"path"' },
    });
    await send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: ':"a"}' },
    });
    await send({
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 7 },
    });
    await writer.close();
    const output = await readPromise;

    const chunks = output
      .split("\n\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const deltas = chunks.map(
      (chunk) =>
        (
          chunk.choices as Array<{ delta: Record<string, unknown>; finish_reason: string | null }>
        )[0],
    );
    expect(deltas[0]?.delta).toEqual({ role: "assistant", content: "" });
    expect(deltas[1]?.delta).toMatchObject({
      tool_calls: [{ index: 0, id: "toolu_1", function: { name: "edit", arguments: "" } }],
    });
    expect(deltas[2]?.delta).toMatchObject({
      tool_calls: [{ index: 0, function: { arguments: '{"path"' } }],
    });
    expect(deltas.at(-1)?.finish_reason).toBe("tool_calls");
    expect(output).toContain("data: [DONE]");
    expect(finished).toEqual({ input: 12, output: 7 });
  });
});
