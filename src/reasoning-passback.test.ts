import { describe, expect, it, beforeEach } from "vite-plus/test";

import {
  clearReasoningPassbackCache,
  conversationScope,
  messageSignature,
  needsReasoningPassback,
  ReasoningStreamAccumulator,
  rememberAssistantReasoning,
  rememberFromChatCompletion,
  repairReasoningContent,
  reasoningPassbackCacheSize,
} from "./reasoning-passback";

beforeEach(() => {
  clearReasoningPassbackCache();
});

describe("needsReasoningPassback", () => {
  it("matches DeepSeek and Moonshot/Kimi hosts and model ids", () => {
    expect(needsReasoningPassback("deepseek", "deepseek-v4-pro")).toBe(true);
    expect(needsReasoningPassback("openrouter", "deepseek/deepseek-v4-flash")).toBe(true);
    expect(needsReasoningPassback("moonshotai", "kimi-k2.5")).toBe(true);
    expect(needsReasoningPassback("custom", "gpt-4o", "https://api.deepseek.com/v1")).toBe(true);
    expect(needsReasoningPassback("openai", "gpt-4o")).toBe(false);
  });
});

describe("repairReasoningContent", () => {
  const tools = [{ type: "function", function: { name: "edit", parameters: {} } }];
  const namespace = "session-a";

  it("restores cached reasoning onto a tool-call assistant turn Cursor stripped", () => {
    const prior = [{ role: "user", content: "fix the bug" }] as Record<string, unknown>[];
    const assistant = {
      role: "assistant",
      content: "",
      reasoning_content: "I should call edit",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "edit", arguments: '{"path":"a.ts"}' },
        },
      ],
    };
    rememberAssistantReasoning(assistant, prior, namespace);

    const followUp = {
      model: "deepseek-v4-pro",
      tools,
      messages: [
        ...prior,
        {
          role: "assistant",
          content: "",
          tool_calls: assistant.tool_calls,
        },
        { role: "tool", tool_call_id: "call_1", content: "ok" },
        { role: "user", content: "continue" },
      ],
    };

    const { body, stats } = repairReasoningContent(followUp, namespace);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.reasoning_content).toBe("I should call edit");
    expect(stats.patched).toBe(1);
    expect(stats.emptyFilled).toBe(0);
  });

  it("fills an empty string when tools are present and no cache hit exists", () => {
    const { body, stats } = repairReasoningContent(
      {
        tools,
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_missing",
                type: "function",
                function: { name: "edit", arguments: "{}" },
              },
            ],
          },
          { role: "tool", tool_call_id: "call_missing", content: "done" },
        ],
      },
      namespace,
    );
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[1]?.reasoning_content).toBe("");
    expect(stats.emptyFilled).toBe(1);
  });

  it("leaves bodies without tools untouched", () => {
    const body = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
    };
    const result = repairReasoningContent(body, namespace);
    expect(result.body).toBe(body);
    expect(result.stats).toEqual({ patched: 0, emptyFilled: 0, alreadyPresent: 0 });
  });

  it("keeps client-supplied reasoning and refreshes the cache from it", () => {
    const body = {
      tools,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          reasoning_content: "from client",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "edit", arguments: "{}" },
            },
          ],
        },
      ],
    };
    const { stats } = repairReasoningContent(body, namespace);
    expect(stats.alreadyPresent).toBe(1);
    expect(reasoningPassbackCacheSize()).toBeGreaterThan(0);

    const stripped = {
      tools,
      messages: [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "call_2",
              type: "function",
              function: { name: "edit", arguments: "{}" },
            },
          ],
        },
      ],
    };
    const restored = repairReasoningContent(stripped, namespace);
    expect((restored.body.messages as Array<Record<string, unknown>>)[1]?.reasoning_content).toBe(
      "from client",
    );
  });

  it("looks up by tool_call id when the assistant content fingerprint changes", () => {
    const prior = [{ role: "user", content: "task" }] as Record<string, unknown>[];
    rememberAssistantReasoning(
      {
        role: "assistant",
        content: "original",
        reasoning_content: "think",
        tool_calls: [
          {
            id: "call_stable",
            type: "function",
            function: { name: "read", arguments: '{"path":"a"}' },
          },
        ],
      },
      prior,
      namespace,
    );

    const { body } = repairReasoningContent(
      {
        tools,
        messages: [
          ...prior,
          {
            role: "assistant",
            content: "", // Cursor often clears content on replay
            tool_calls: [
              {
                id: "call_stable",
                type: "function",
                function: { name: "read", arguments: '{"path":"a"}' },
              },
            ],
          },
        ],
      },
      namespace,
    );
    expect((body.messages as Array<Record<string, unknown>>)[1]?.reasoning_content).toBe("think");
  });
});

describe("rememberFromChatCompletion", () => {
  it("stores message.reasoning_content from a non-streaming response", () => {
    const prior = [{ role: "user", content: "go" }] as Record<string, unknown>[];
    const stored = rememberFromChatCompletion(
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              reasoning_content: "plan",
              tool_calls: [
                {
                  id: "call_x",
                  type: "function",
                  function: { name: "edit", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
      prior,
      "ns",
    );
    expect(stored).toBeGreaterThan(0);

    const { body } = repairReasoningContent(
      {
        tools: [{ type: "function", function: { name: "edit" } }],
        messages: [
          ...prior,
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_x",
                type: "function",
                function: { name: "edit", arguments: "{}" },
              },
            ],
          },
        ],
      },
      "ns",
    );
    expect((body.messages as Array<Record<string, unknown>>)[1]?.reasoning_content).toBe("plan");
  });
});

describe("ReasoningStreamAccumulator", () => {
  it("assembles streamed reasoning and tool_call deltas before storing", () => {
    const prior = [{ role: "user", content: "stream" }] as Record<string, unknown>[];
    const acc = new ReasoningStreamAccumulator();
    acc.ingest({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", reasoning_content: "step " },
        },
      ],
    });
    acc.ingest({
      choices: [
        {
          index: 0,
          delta: {
            reasoning_content: "two",
            tool_calls: [
              {
                index: 0,
                id: "call_s",
                type: "function",
                function: { name: "edit", arguments: "" },
              },
            ],
          },
        },
      ],
    });
    acc.ingest({
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
          finish_reason: "tool_calls",
        },
      ],
    });
    expect(acc.store(prior, "stream-ns")).toBeGreaterThan(0);

    const { body } = repairReasoningContent(
      {
        tools: [{ type: "function", function: { name: "edit" } }],
        messages: [
          ...prior,
          {
            role: "assistant",
            content: "",
            tool_calls: [
              {
                id: "call_s",
                type: "function",
                function: { name: "edit", arguments: "{}" },
              },
            ],
          },
        ],
      },
      "stream-ns",
    );
    expect((body.messages as Array<Record<string, unknown>>)[1]?.reasoning_content).toBe(
      "step two",
    );
  });
});

describe("fingerprints", () => {
  it("ignores reasoning_content when hashing message and scope", () => {
    const withReasoning = {
      role: "assistant",
      content: "hi",
      reasoning_content: "secret",
      tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }],
    };
    const without = {
      role: "assistant",
      content: "hi",
      tool_calls: [{ id: "c1", type: "function", function: { name: "a", arguments: "{}" } }],
    };
    expect(messageSignature(withReasoning)).toBe(messageSignature(without));
    expect(conversationScope([withReasoning])).toBe(conversationScope([without]));
  });
});
