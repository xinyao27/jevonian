import { describe, expect, it } from "vite-plus/test";

import {
  chatToGemini,
  geminiChatCompletion,
  geminiEndpoint,
  geminiResult,
  geminiToChatStream,
  sanitizeToolName,
  unwrapGemini,
} from "./gemini";

describe("chatToGemini", () => {
  it("maps system, messages, tools, and tool results", () => {
    const request = chatToGemini({
      model: "ignored",
      messages: [
        { role: "system", content: "be brief" },
        { role: "user", content: "fix the bug" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "read/file", arguments: '{"p":"a"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "Error: test failed" },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: "read/file",
            description: "read a file",
            parameters: {
              $schema: "https://json-schema.org/draft/2020-12/schema",
              type: "object",
              properties: { mode: { const: "text" } },
              required: ["mode"],
            },
          },
        },
      ],
      temperature: 0.2,
      max_tokens: 512,
      stop: ["END"],
      tool_choice: { type: "function", function: { name: "read/file" } },
    });

    expect(request.systemInstruction).toEqual({ parts: [{ text: "be brief" }] });
    const contents = request.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents[0]).toEqual({ role: "user", parts: [{ text: "fix the bug" }] });
    expect(contents[1]?.role).toBe("model");
    expect(contents[1]?.parts[0]).toEqual({
      functionCall: { name: "read_file", args: { p: "a" }, id: "call_1" },
      thoughtSignature: "skip_thought_signature_validator",
    });
    expect(contents[2]).toEqual({
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "read_file",
            id: "call_1",
            response: { result: "Error: test failed" },
          },
        },
      ],
    });
    expect(request.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: "read_file",
            description: "read a file",
            parameters: {
              type: "object",
              properties: { mode: { enum: ["text"] } },
              required: ["mode"],
            },
          },
        ],
      },
    ]);
    expect(request.generationConfig).toEqual({
      temperature: 0.2,
      maxOutputTokens: 512,
      stopSequences: ["END"],
    });
    expect(request.toolConfig).toEqual({
      functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["read_file"] },
    });
  });

  it("keeps function responses object-shaped for array tool content", () => {
    const request = chatToGemini({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "a", type: "function", function: { name: "read", arguments: '["x"]' } },
          ],
        },
        {
          role: "tool",
          tool_call_id: "a",
          content: [
            { type: "text", text: "file one" },
            { type: "text", text: "file two" },
          ],
        },
      ],
    });
    const contents = request.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents[0]?.parts[0]).toEqual({
      functionCall: { name: "read", args: {}, id: "a" },
      thoughtSignature: "skip_thought_signature_validator",
    });
    const response = contents[1]?.parts[0]?.functionResponse as Record<string, unknown>;
    expect(Array.isArray(response.response)).toBe(false);
    expect(response.response).toEqual({ result: "file one\nfile two" });
  });

  it("reuses the thought signature from the model response on later turns", () => {
    geminiResult({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: { name: "default_api:Read", args: { path: "a" } },
                thoughtSignature: "sig-123",
              },
            ],
          },
        },
      ],
    });
    const request = chatToGemini({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "default_api:Read", arguments: '{"path":"a"}' },
            },
          ],
        },
      ],
    });
    const contents = request.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts[0]?.thoughtSignature).toBe("sig-123");
  });

  it("skips signature validation for function calls the model never signed", () => {
    const request = chatToGemini({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "never_seen_tool_9", arguments: "{}" },
            },
          ],
        },
      ],
    });
    const contents = request.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts[0]?.thoughtSignature).toBe("skip_thought_signature_validator");
  });

  it("carries signatures that arrive on thought parts onto later turns", () => {
    geminiResult({
      candidates: [
        {
          content: {
            parts: [
              { thought: true, thoughtSignature: "sig-thought" },
              { functionCall: { name: "thought_sig_tool", args: { q: 1 } } },
            ],
          },
        },
      ],
    });
    const request = chatToGemini({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "thought_sig_tool", arguments: '{"q":1}' },
            },
          ],
        },
      ],
    });
    const contents = request.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts[0]?.thoughtSignature).toBe("sig-thought");
  });

  it("stamps only the first parallel function call with a fallback signature", () => {
    const request = chatToGemini({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "parallel_a", arguments: "{}" } },
            { id: "call_2", type: "function", function: { name: "parallel_b", arguments: "{}" } },
          ],
        },
      ],
    });
    const contents = request.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts).toHaveLength(2);
    expect(contents[0]?.parts[0]?.thoughtSignature).toBe("skip_thought_signature_validator");
    expect(contents[0]?.parts[1]?.thoughtSignature).toBeUndefined();
  });

  it("merges consecutive same-role messages", () => {
    const request = chatToGemini({
      messages: [
        { role: "user", content: "one" },
        { role: "user", content: "two" },
        { role: "assistant", content: "ok" },
        { role: "assistant", content: "sure" },
      ],
    });
    const contents = request.contents as Array<{
      role: string;
      parts: Array<Record<string, unknown>>;
    }>;
    expect(contents).toHaveLength(2);
    expect(contents[0]?.parts).toEqual([{ text: "one" }, { text: "two" }]);
    expect(contents[1]?.parts).toEqual([{ text: "ok" }, { text: "sure" }]);
  });
});

describe("sanitizeToolName", () => {
  it("replaces invalid characters and keeps a valid first character", () => {
    expect(sanitizeToolName("read/file")).toBe("read_file");
    expect(sanitizeToolName("123 tool")).toBe("_123_tool");
    expect(sanitizeToolName("mcp:db.query")).toBe("mcp:db.query");
  });
});

describe("geminiResult", () => {
  it("collects text, tool calls, usage, and finish reason", () => {
    const result = geminiResult({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              { thought: true, text: "thinking..." },
              { text: "hello " },
              { functionCall: { name: "edit", args: { path: "a" }, id: "toolu_1" } },
            ],
          },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        thoughtsTokenCount: 6,
        cachedContentTokenCount: 2,
      },
    });
    expect(result.text).toBe("hello ");
    expect(result.calls).toEqual([{ id: "toolu_1", name: "edit", arguments: '{"path":"a"}' }]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ input: 10, output: 10, cacheRead: 2, cacheWrite: 0 });
  });

  it("maps MAX_TOKENS to length", () => {
    const result = geminiResult({
      candidates: [{ content: { parts: [{ text: "cut" }] }, finishReason: "MAX_TOKENS" }],
    });
    expect(result.finishReason).toBe("length");
  });
});

describe("geminiChatCompletion", () => {
  it("builds an OpenAI-shaped completion", () => {
    const completion = geminiChatCompletion(
      {
        responseId: "resp_1",
        modelVersion: "gemini-3-flash",
        candidates: [{ content: { parts: [{ text: "hi" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      },
      "fallback-model",
    );
    expect(completion.id).toBe("resp_1");
    expect(completion.model).toBe("gemini-3-flash");
    expect(completion.choices).toMatchObject([
      { message: { role: "assistant", content: "hi" }, finish_reason: "stop" },
    ]);
    expect(completion.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
  });
});

describe("unwrapGemini", () => {
  it("unwraps the cloud code envelope", () => {
    expect(unwrapGemini({ response: { candidates: [] } })).toEqual({ candidates: [] });
    expect(unwrapGemini({ candidates: [] })).toEqual({ candidates: [] });
  });
});

describe("geminiEndpoint", () => {
  it("builds cloud code URLs", () => {
    expect(geminiEndpoint("https://daily-cloudcode-pa.googleapis.com/", false)).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent",
    );
    expect(geminiEndpoint("https://daily-cloudcode-pa.googleapis.com/v1internal", true)).toBe(
      "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse",
    );
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

describe("geminiToChatStream", () => {
  it("translates streamed generateContent chunks into chat deltas", async () => {
    let finished: { input: number; output: number } | undefined;
    const transform = geminiToChatStream("gemini-3-flash", (usage) => {
      finished = { input: usage.input, output: usage.output };
    });
    const writer = transform.writable.getWriter();
    const readPromise = collect(transform.readable);

    const send = (payload: unknown): Promise<void> =>
      writer.write(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));

    await send({ response: { candidates: [{ content: { parts: [{ text: "hello " }] } }] } });
    await send({
      response: {
        candidates: [{ content: { parts: [{ text: "world" }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 },
      },
    });
    await send({
      response: {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "edit", args: { path: "x" } } }] },
            finishReason: "STOP",
          },
        ],
      },
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
    expect(deltas[1]?.delta).toEqual({ content: "hello " });
    expect(deltas[2]?.delta).toEqual({ content: "world" });
    expect(deltas[3]?.delta).toMatchObject({
      tool_calls: [
        { index: 0, type: "function", function: { name: "edit", arguments: '{"path":"x"}' } },
      ],
    });
    expect(deltas.at(-1)?.finish_reason).toBe("tool_calls");
    expect(output).toContain("data: [DONE]");
    expect(finished).toEqual({ input: 7, output: 2 });
  });

  it("remembers signatures that stream ahead of the function call", async () => {
    const transform = geminiToChatStream("gemini-3-flash");
    const writer = transform.writable.getWriter();
    const readPromise = collect(transform.readable);
    const send = (payload: unknown): Promise<void> =>
      writer.write(new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`));

    await send({
      response: {
        candidates: [{ content: { parts: [{ thought: true, thoughtSignature: "stream-sig" }] } }],
      },
    });
    await send({
      response: {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: "stream_sig_tool", args: {} } }] },
            finishReason: "STOP",
          },
        ],
      },
    });
    await writer.close();
    await readPromise;

    const request = chatToGemini({
      messages: [
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "stream_sig_tool", arguments: "{}" },
            },
          ],
        },
      ],
    });
    const contents = request.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]?.parts[0]?.thoughtSignature).toBe("stream-sig");
  });
});
