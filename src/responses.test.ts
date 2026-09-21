import { describe, expect, it } from "vite-plus/test";

import {
  chatCompletionFrom,
  chatResultFromResponse,
  chatToResponses,
  ChatToResponsesBridge,
  collectOutputItemsFromEvents,
  ensureResponsesCallIds,
  isRemoteCompactionV2,
  repairResponsesOutput,
  ResponsesChatBridge,
  responsesPassthroughRepairStream,
  responsesToChatRequest,
  responsesUsage,
  splitSseEvents,
} from "./responses";

describe("responsesToChatRequest", () => {
  it("maps Responses input, tools, and reasoning back to chat completions", () => {
    const body = responsesToChatRequest(
      {
        model: "ignored",
        instructions: "be brief",
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          {
            type: "function_call",
            call_id: "call_1",
            name: "edit",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "call_1", output: "done" },
        ],
        tools: [
          {
            type: "function",
            name: "edit",
            description: "edit a file",
            parameters: { type: "object", properties: {} },
          },
        ],
        reasoning: { effort: "low" },
        max_output_tokens: 512,
        stream: true,
      },
      "openai/gpt-6-astra",
    );
    expect(body.model).toBe("openai/gpt-6-astra");
    expect(body.stream).toBe(true);
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_tokens).toBe(512);
    expect(body.messages).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "edit", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "done" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "edit",
          description: "edit a file",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);
  });
});

describe("chatToResponses", () => {
  it("maps messages, tools, and tool results to the responses shape", () => {
    const body = chatToResponses(
      {
        model: "ignored",
        messages: [
          { role: "system", content: "be brief" },
          { role: "user", content: "fix the bug" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "edit", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_1", content: "Error: tests failed" },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "edit",
              description: "edit a file",
              parameters: { type: "object", properties: {} },
            },
          },
        ],
        max_tokens: 512,
        reasoning_effort: "low",
      },
      "gpt-5.6-codex",
    );

    expect(body.model).toBe("gpt-5.6-codex");
    expect(body.instructions).toBe("be brief");
    expect(body.max_output_tokens).toBe(512);
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.store).toBe(false);
    const input = body.input as Array<Record<string, unknown>>;
    expect(input[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "fix the bug" }],
    });
    expect(input[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "edit" });
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "Error: tests failed",
    });
    expect(body.tools).toEqual([
      {
        type: "function",
        name: "edit",
        description: "edit a file",
        parameters: { type: "object", properties: {} },
        strict: false,
      },
    ]);
  });

  it("synthesizes call_id when tool call ids are missing or empty", () => {
    const body = chatToResponses(
      {
        messages: [
          { role: "user", content: "fix" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "", type: "function", function: { name: "edit", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "", content: "done" },
        ],
      },
      "gpt-5.6-codex",
    );
    const input = body.input as Array<Record<string, unknown>>;
    const call = input.find((item) => item.type === "function_call");
    const output = input.find((item) => item.type === "function_call_output");
    expect(typeof call?.call_id).toBe("string");
    expect(String(call?.call_id).length).toBeGreaterThan(0);
    expect(output?.call_id).toBe(call?.call_id);
  });

  it("pairs orphan tool results with preceding unpaired calls by order", () => {
    const body = chatToResponses(
      {
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "call_a", type: "function", function: { name: "a", arguments: "{}" } },
              { type: "function", function: { name: "b", arguments: "{}" } },
            ],
          },
          { role: "tool", tool_call_id: "call_a", content: "A" },
          { role: "tool", content: "B" },
        ],
      },
      "gpt-5.6-codex",
    );
    const input = body.input as Array<Record<string, unknown>>;
    const calls = input.filter((item) => item.type === "function_call");
    const outputs = input.filter((item) => item.type === "function_call_output");
    expect(calls[0]?.call_id).toBe("call_a");
    expect(String(calls[1]?.call_id).length).toBeGreaterThan(0);
    expect(outputs[0]?.call_id).toBe("call_a");
    expect(outputs[1]?.call_id).toBe(calls[1]?.call_id);
  });
});

describe("ensureResponsesCallIds", () => {
  it("fills empty call_id on passthrough input and pairs outputs", () => {
    const body = ensureResponsesCallIds({
      model: "gpt-5.6-codex",
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "function_call", call_id: "", name: "edit", arguments: "{}" },
        { type: "function_call_output", call_id: "", output: "done" },
      ],
    });
    const input = body.input as Array<Record<string, unknown>>;
    expect(String(input[1]?.call_id).length).toBeGreaterThan(0);
    expect(input[2]?.call_id).toBe(input[1]?.call_id);
  });

  it("leaves valid call_id untouched", () => {
    const original = {
      model: "gpt-5.6-codex",
      input: [
        { type: "function_call", call_id: "call_1", name: "edit", arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    };
    const body = ensureResponsesCallIds(original);
    expect(body).toBe(original);
  });
});

describe("responsesToChatRequest empty call_id", () => {
  it("falls back to item.id when call_id is empty string", () => {
    const body = responsesToChatRequest(
      {
        input: [
          {
            type: "function_call",
            call_id: "",
            id: "fc_real",
            name: "edit",
            arguments: "{}",
          },
          { type: "function_call_output", call_id: "", id: "fc_real", output: "done" },
        ],
      },
      "openai/gpt-6-astra",
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    const assistant = messages[0] as {
      tool_calls: Array<{ id: string }>;
    };
    const tool = messages[1] as { tool_call_id: string };
    expect(assistant.tool_calls[0]?.id).toBe("fc_real");
    expect(tool.tool_call_id).toBe("fc_real");
  });
});

describe("ResponsesChatBridge", () => {
  it("turns responses events into chat completion chunks", () => {
    const bridge = new ResponsesChatBridge("gpt-5.6-codex");
    const chunks = [
      ...bridge.handle({ type: "response.created" }),
      ...bridge.handle({ type: "response.output_text.delta", delta: "hello " }),
      ...bridge.handle({ type: "response.output_text.delta", delta: "world" }),
      ...bridge.handle({
        type: "response.output_item.added",
        item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "edit" },
      }),
      ...bridge.handle({
        type: "response.function_call_arguments.delta",
        item_id: "fc_1",
        delta: '{"path"',
      }),
      ...bridge.handle({ type: "response.completed", response: { usage: { input_tokens: 12 } } }),
    ];

    const deltas = chunks.map(
      (chunk) => (chunk.choices as Array<{ delta: Record<string, unknown> }>)[0]?.delta ?? {},
    );
    expect(deltas[0]).toEqual({ role: "assistant", content: "" });
    expect(deltas[1]).toEqual({ content: "hello " });
    expect(deltas[3]).toMatchObject({
      tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "edit" } }],
    });
    expect(deltas[4]).toMatchObject({
      tool_calls: [{ index: 0, function: { arguments: '{"path"' } }],
    });
    const choices = (chunks.at(-1)?.choices ?? []) as Array<{ finish_reason: string }>;
    expect(choices[0]?.finish_reason).toBe("tool_calls");

    const result = bridge.result();
    expect(result.content).toBe("hello world");
    expect(result.toolCalls).toEqual([{ id: "call_9", name: "edit", arguments: '{"path"' }]);
    expect(result.usage.input).toBe(12);
    expect(bridge.finish()).toEqual([]);
  });

  it("reports upstream failures", () => {
    const bridge = new ResponsesChatBridge("gpt-5.6-codex");
    bridge.handle({ type: "response.failed", response: { error: { message: "boom" } } });
    expect(bridge.result().failure).toBe("boom");
    expect(bridge.finish()).toEqual([{ error: { message: "boom", type: "upstream_error" } }]);
  });
});

describe("ChatToResponsesBridge", () => {
  it("turns chat completion chunks into responses events", () => {
    const bridge = new ChatToResponsesBridge("openai/gpt-6-astra");
    const events = [
      ...bridge.handle({
        choices: [{ index: 0, delta: { role: "assistant", content: "hello " } }],
      }),
      ...bridge.handle({
        choices: [{ index: 0, delta: { content: "world" } }],
      }),
      ...bridge.handle({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      }),
      ...bridge.finish(),
    ];
    expect(events[0]).toMatchObject({ type: "response.created" });
    const textDelta = events.find((event) => event.type === "response.output_text.delta");
    expect(textDelta).toMatchObject({
      type: "response.output_text.delta",
      item_id: expect.stringMatching(/^msg_/),
      delta: "hello ",
    });
    expect(events.some((event) => event.type === "response.output_item.done")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 3, output_tokens: 2 },
      },
    });
    expect(bridge.result().content).toBe("hello world");
  });

  it("surfaces OpenRouter reasoning when there is no visible content", () => {
    const bridge = new ChatToResponsesBridge("deepseek/deepseek-v4.1-flash");
    const events = [
      ...bridge.handle({
        choices: [{ index: 0, delta: { reasoning: "thinking hard" } }],
      }),
      ...bridge.handle({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 40 },
      }),
      ...bridge.finish(),
    ];
    expect(events.some((event) => event.type === "response.reasoning_summary_text.delta")).toBe(
      true,
    );
    const completed = events.at(-1) as { response: { output: Array<{ content?: unknown[] }> } };
    expect(JSON.stringify(completed.response.output)).toContain("thinking hard");
  });

  it("closes tool calls with done events Codex expects", () => {
    const bridge = new ChatToResponsesBridge("deepseek/deepseek-v4.1-flash");
    const events = [
      ...bridge.handle({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: "call_abc",
                  type: "function",
                  function: { name: "exec_command", arguments: '{"cmd":"ls"}' },
                },
              ],
            },
          },
        ],
      }),
      ...bridge.handle({
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      }),
      ...bridge.finish(),
    ];
    expect(events.some((event) => event.type === "response.function_call_arguments.done")).toBe(
      true,
    );
    expect(
      events.filter((event) => event.type === "response.output_item.done").length,
    ).toBeGreaterThanOrEqual(1);
    expect(bridge.result().toolCalls[0]).toMatchObject({
      id: "call_abc",
      name: "exec_command",
      arguments: '{"cmd":"ls"}',
    });
  });
});

describe("chatResultFromResponse", () => {
  it("collects text and tool calls from a responses payload", () => {
    const result = chatResultFromResponse({
      output: [
        { type: "message", content: [{ type: "output_text", text: "hi" }] },
        { type: "function_call", call_id: "call_1", name: "edit", arguments: "{}" },
      ],
      usage: { input_tokens: 5, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } },
    });
    expect(result.content).toBe("hi");
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ input: 5, output: 2, cacheRead: 1, cacheWrite: 0 });

    const completion = chatCompletionFrom(result, "gpt-5.6-codex", "chatcmpl-1", 0);
    expect(completion.object).toBe("chat.completion");
    expect(completion.choices).toMatchObject([
      { message: { role: "assistant", content: "hi" }, finish_reason: "tool_calls" },
    ]);
  });
});

describe("splitSseEvents", () => {
  it("parses data lines and keeps partial buffers", () => {
    const { events, rest } = splitSseEvents(
      'event: response.output_text.delta\ndata: {"type":"a"}\n\ndata: {"type":"b"}\n\ndata: {"type":',
    );
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
    expect(rest).toBe('data: {"type":');
  });

  it("parses CRLF-framed events", () => {
    const { events, rest } = splitSseEvents(
      'data: {"type":"a"}\r\n\r\ndata: {"type":"b"}\r\n\r\ndata: {"type":',
    );
    expect(events).toEqual([{ type: "a" }, { type: "b" }]);
    expect(rest).toBe('data: {"type":');
  });
});

describe("responsesUsage", () => {
  it("maps cached tokens", () => {
    expect(
      responsesUsage({
        input_tokens: 10,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 4 },
      }),
    ).toEqual({ input: 10, output: 3, cacheRead: 4, cacheWrite: 0 });
  });
});

describe("remote compaction v2 helpers", () => {
  it("detects compaction_trigger input items", () => {
    expect(isRemoteCompactionV2({ input: [{ type: "message", role: "user", content: "x" }] })).toBe(
      false,
    );
    expect(isRemoteCompactionV2({ input: [{ type: "compaction_trigger" }] })).toBe(true);
    expect(isRemoteCompactionV2({ input: [{ type: "context_compaction" }] })).toBe(true);
  });

  it("does not turn compaction markers into chat messages", () => {
    const body = responsesToChatRequest(
      {
        input: [
          { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
          { type: "compaction_trigger" },
          {
            type: "compaction",
            id: "cmp_1",
            encrypted_content: "secret",
          },
        ],
      },
      "gpt-5.4",
    );
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("repairs an empty completed.output from output_item.done", () => {
    const compaction = {
      type: "compaction",
      id: "cmp_1",
      encrypted_content: "payload",
    };
    const events = [
      {
        type: "response.output_item.done",
        output_index: 0,
        item: compaction,
      },
      {
        type: "response.completed",
        response: { id: "resp_1", output: [], usage: { input_tokens: 1, output_tokens: 1 } },
      },
    ];
    expect(collectOutputItemsFromEvents(events)).toEqual([compaction]);
    expect(repairResponsesOutput({ id: "resp_1", output: [] }, events).output).toEqual([
      compaction,
    ]);
    expect(
      repairResponsesOutput({ id: "resp_1", output: [{ type: "message" }] }, events).output,
    ).toEqual([{ type: "message" }]);
  });

  it("rewrites completed SSE frames so the compaction item is present", async () => {
    const upstream = [
      'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"compaction","id":"cmp_1","encrypted_content":"x"}}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[],"usage":{"input_tokens":9,"output_tokens":4}}}\n\n',
    ].join("");

    let completed: Record<string, unknown> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(upstream));
        controller.close();
      },
    }).pipeThrough(
      responsesPassthroughRepairStream((response) => {
        completed = response;
      }),
    );
    const text = await new Response(stream).text();
    const { events } = splitSseEvents(text);
    const done = events.find((event) => event.type === "response.completed");
    expect(done).toMatchObject({
      response: {
        output: [{ type: "compaction", id: "cmp_1", encrypted_content: "x" }],
      },
    });
    expect(completed?.output).toEqual([
      { type: "compaction", id: "cmp_1", encrypted_content: "x" },
    ]);
  });
});
