import { createHash } from "node:crypto";
import type { Usage } from "./pricing";

/** OpenAI Responses rejects `call_id` longer than this (`string_above_max_length`). */
const MAX_CALL_ID_LENGTH = 64;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** First non-empty string among candidates (unlike `??`, empty string is missing). */
function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function syntheticCallId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/**
 * Map oversized ids to a stable short form so function_call / function_call_output
 * pairs still match after clamp. Bridged clients (Cursor / Codex / non-OpenAI
 * backends) can emit ids past the Responses 64-char max.
 */
function clampCallId(id: string): string {
  if (id.length <= MAX_CALL_ID_LENGTH) return id;
  const hash = createHash("sha256").update(id, "utf8").digest("hex").slice(0, 24);
  return `call_${hash}`;
}

/** Prefer real ids; never return "" — OpenAI Responses rejects empty `call_id`. */
function callIdOf(...values: unknown[]): string {
  const id = firstNonEmpty(...values);
  return id ? clampCallId(id) : syntheticCallId();
}

/** OpenAI Responses rejects empty `name` on function_call items (minLength 1). */
function toolNameOf(...values: unknown[]): string {
  return firstNonEmpty(...values) || "tool";
}

/**
 * Fill empty / oversized `call_id` and empty `name` on Responses `input` items
 * before upstream. Pair orphan `function_call_output` items with preceding
 * unpaired `function_call`s. Cursor / bridged history can leave "" on both
 * fields after broken stream merges, or grow `call_id` past 64 characters.
 */
export function ensureResponsesCallIds(body: Record<string, unknown>): Record<string, unknown> {
  const input = Array.isArray(body.input) ? body.input : null;
  if (!input || input.length === 0) return body;

  const unpaired: string[] = [];
  let changed = false;
  let lastName = "";
  const next = input.map((raw) => {
    const item = asRecord(raw);
    if (item.type === "function_call") {
      const callId = callIdOf(item.call_id);
      const name = toolNameOf(item.name, lastName);
      if (firstNonEmpty(item.name)) lastName = asString(item.name);
      unpaired.push(callId);
      if (callId === item.call_id && name === item.name) return raw;
      changed = true;
      return { ...item, call_id: callId, name };
    }
    if (item.type === "function_call_output") {
      const existing = firstNonEmpty(item.call_id);
      let callId = existing ? clampCallId(existing) : unpaired.shift() || syntheticCallId();
      if (existing) {
        const index = unpaired.indexOf(callId);
        if (index >= 0) unpaired.splice(index, 1);
      }
      if (callId === item.call_id) return raw;
      changed = true;
      return { ...item, call_id: callId };
    }
    return raw;
  });

  return changed ? { ...body, input: next } : body;
}

export function responsesUsage(raw: unknown): Usage {
  const usage = asRecord(raw);
  const details = asRecord(usage.input_tokens_details);
  return {
    input: number(usage.input_tokens),
    output: number(usage.output_tokens),
    cacheRead: number(details.cached_tokens),
    cacheWrite: 0,
  };
}

/** Input markers Codex uses for remote compaction v2 (`POST /v1/responses`). */
const COMPACTION_TRIGGER_TYPES = new Set(["compaction_trigger", "context_compaction"]);

/** Output item types Codex accepts as the compaction result. */
const COMPACTION_OUTPUT_TYPES = new Set(["compaction", "compaction_summary", "context_compaction"]);

/**
 * True when the Responses body is a Codex remote-compaction v2 turn.
 * Those requests must stay on a native Responses (ChatGPT) upstream — bridging them to
 * Chat Completions yields an ordinary message item and Codex fails with
 * "expected exactly one compaction output item, got 0 from N".
 */
export function isRemoteCompactionV2(body: Record<string, unknown>): boolean {
  const input = Array.isArray(body.input) ? body.input : [];
  return input.some((raw) => COMPACTION_TRIGGER_TYPES.has(asString(asRecord(raw).type)));
}

export function isCompactionOutputItem(item: unknown): boolean {
  return COMPACTION_OUTPUT_TYPES.has(asString(asRecord(item).type));
}

/**
 * Pull compaction (and other) output items from SSE events. Upstream often puts the
 * real compaction payload on `response.output_item.done` while `response.completed`
 * still has `output: []`.
 */
export function collectOutputItemsFromEvents(events: Record<string, unknown>[]): unknown[] {
  const byIndex = new Map<number, unknown>();
  const unordered: unknown[] = [];
  for (const event of events) {
    const type = asString(event.type);
    if (type !== "response.output_item.done" && type !== "response.output_item.added") continue;
    const item = event.item;
    if (item === undefined || item === null) continue;
    const index = number(event.output_index);
    if (Number.isFinite(index) && event.output_index !== undefined) {
      // Prefer `.done` over `.added` for the same index.
      if (type === "response.output_item.done" || !byIndex.has(index)) {
        byIndex.set(index, item);
      }
    } else {
      unordered.push(item);
    }
  }
  const ordered = [...byIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, item]) => item);
  return [...ordered, ...unordered];
}

/**
 * When the terminal Responses object has an empty `output`, rebuild it from SSE
 * `output_item.*` events so Codex still sees the compaction item.
 */
export function repairResponsesOutput(
  response: Record<string, unknown>,
  events: Record<string, unknown>[],
): Record<string, unknown> {
  const existing = Array.isArray(response.output) ? response.output : [];
  if (existing.length > 0) return response;
  const collected = collectOutputItemsFromEvents(events);
  if (collected.length === 0) return response;
  return { ...response, output: collected };
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        const record = asRecord(block);
        if (typeof record.text === "string") return record.text;
        if (record.type === "image_url" || record.type === "input_image") return "[image]";
        return JSON.stringify(record);
      })
      .join("\n");
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function chatToolToResponses(raw: unknown): unknown[] {
  const tool = asRecord(raw);
  if (tool.type !== "function") return [];
  const fn = asRecord(tool.function);
  if (typeof fn.name !== "string" || fn.name.length === 0) return [];
  return [
    {
      type: "function",
      name: fn.name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      parameters: asRecord(fn.parameters),
      strict: false,
    },
  ];
}

function responsesToolToChat(raw: unknown): Record<string, unknown> | undefined {
  const tool = asRecord(raw);
  if (tool.type !== "function") return undefined;
  const name = asString(tool.name);
  if (!name) return undefined;
  return {
    type: "function",
    function: {
      name,
      ...(typeof tool.description === "string" ? { description: tool.description } : {}),
      parameters: asRecord(tool.parameters),
    },
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value === undefined || value === null ? "" : textOf(value);
  return value
    .map((block) => {
      const record = asRecord(block);
      if (typeof record.text === "string") return record.text;
      if (record.type === "input_text" || record.type === "output_text" || record.type === "text") {
        return asString(record.text);
      }
      if (record.type === "input_image" || record.type === "image_url") return "[image]";
      return "";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * The inverse of {@link chatToResponses}: a Responses `/responses` body as OpenAI chat.
 *
 * Needed when ChatGPT Desktop / Codex is routed off the ChatGPT subscription onto an
 * OpenAI Chat Completions host (OpenRouter, DeepSeek, …).
 */
export function responsesToChatRequest(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const instructions = body.instructions;
  if (typeof instructions === "string" && instructions.length > 0) {
    messages.push({ role: "system", content: instructions });
  }

  const input = Array.isArray(body.input) ? body.input : [];
  for (const raw of input) {
    const item = asRecord(raw);
    // Compaction markers are request-only; they must never become chat messages.
    if (COMPACTION_TRIGGER_TYPES.has(asString(item.type)) || isCompactionOutputItem(item)) {
      continue;
    }
    if (item.type === "function_call" || item.type === "function_call_output") {
      if (item.type === "function_call") {
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: callIdOf(item.call_id, item.id),
              type: "function",
              function: {
                name: asString(item.name),
                arguments:
                  typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments ?? {}),
              },
            },
          ],
        });
      } else {
        messages.push({
          role: "tool",
          tool_call_id: callIdOf(item.call_id, item.id),
          content: contentText(item.output ?? item.content),
        });
      }
      continue;
    }

    const role = item.role === "assistant" || item.role === "system" ? item.role : "user";
    if (role === "assistant") {
      const toolCalls: unknown[] = [];
      // Rare Responses shape: assistant message with embedded function calls in content.
      const content = Array.isArray(item.content) ? item.content : [];
      for (const rawPart of content) {
        const part = asRecord(rawPart);
        if (part.type === "function_call" || part.type === "tool_use") {
          toolCalls.push({
            id: callIdOf(part.call_id, part.id),
            type: "function",
            function: {
              name: asString(part.name),
              arguments:
                typeof part.arguments === "string"
                  ? part.arguments
                  : JSON.stringify(part.arguments ?? part.input ?? {}),
            },
          });
        }
      }
      const text = contentText(item.content);
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: text.length > 0 ? text : null,
      };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      messages.push(entry);
      continue;
    }
    messages.push({ role, content: contentText(item.content) });
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((tool) => {
        const converted = responsesToolToChat(tool);
        return converted ? [converted] : [];
      })
    : [];
  const reasoning = asRecord(body.reasoning);
  const max = body.max_output_tokens ?? body.max_tokens;

  return {
    model,
    messages,
    ...(typeof body.stream === "boolean" ? { stream: body.stream } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(typeof max === "number" ? { max_tokens: max } : {}),
    ...(typeof reasoning.effort === "string" ? { reasoning_effort: reasoning.effort } : {}),
    ...(typeof body.prompt_cache_key === "string"
      ? { prompt_cache_key: body.prompt_cache_key }
      : {}),
  };
}

export function chatToResponses(
  body: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const instructions: string[] = [];
  const input: unknown[] = [];
  // Track assistant tool call ids so orphan tool results can pair by order.
  const unpairedCallIds: string[] = [];

  for (const raw of messages) {
    const message = asRecord(raw);
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      const existing = firstNonEmpty(message.tool_call_id);
      let callId = existing ? clampCallId(existing) : unpairedCallIds.shift() || syntheticCallId();
      if (existing) {
        const index = unpairedCallIds.indexOf(callId);
        if (index >= 0) unpairedCallIds.splice(index, 1);
      }
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: textOf(message.content),
      });
      continue;
    }
    if (role === "assistant") {
      const text = textOf(message.content);
      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text }],
        });
      }
      // Streaming merges sometimes leave a sibling with name+empty args and another
      // with args+empty name in the same assistant turn — reuse the last real name.
      let lastToolName = "";
      for (const rawCall of toolCalls) {
        const call = asRecord(rawCall);
        const fn = asRecord(call.function);
        const callId = callIdOf(call.id);
        const name = toolNameOf(fn.name, lastToolName);
        if (firstNonEmpty(fn.name)) lastToolName = asString(fn.name);
        unpairedCallIds.push(callId);
        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments:
            typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
        });
      }
      continue;
    }
    input.push({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: textOf(message.content) }],
    });
  }

  const tools = Array.isArray(body.tools)
    ? body.tools.flatMap((tool) => chatToolToResponses(tool))
    : [];
  const max = body.max_completion_tokens ?? body.max_tokens;

  return {
    model,
    input,
    stream: true,
    store: false,
    ...(instructions.length > 0 ? { instructions: instructions.join("\n\n") } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(body.tool_choice === undefined ? {} : { tool_choice: body.tool_choice }),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(typeof body.top_p === "number" ? { top_p: body.top_p } : {}),
    ...(typeof max === "number" ? { max_output_tokens: max } : {}),
    ...(typeof body.reasoning_effort === "string"
      ? { reasoning: { effort: body.reasoning_effort } }
      : {}),
    ...(typeof body.prompt_cache_key === "string"
      ? { prompt_cache_key: body.prompt_cache_key }
      : {}),
  };
}

export interface ChatBridgeCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatBridgeResult {
  content: string;
  toolCalls: ChatBridgeCall[];
  finishReason: string;
  usage: Usage;
  failure?: string;
}

interface PendingCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

export class ResponsesChatBridge {
  readonly id: string;
  readonly created: number;
  private readonly model: string;
  private readonly calls = new Map<string, PendingCall>();
  private readonly order: string[] = [];
  private content = "";
  private finishReason = "stop";
  private usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private failure: string | undefined;
  private completed = false;

  constructor(model: string) {
    this.model = model;
    this.id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.created = Math.floor(Date.now() / 1000);
  }

  private chunk(
    delta: Record<string, unknown>,
    finishReason: string | null,
  ): Record<string, unknown> {
    return {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
  }

  handle(raw: unknown): Record<string, unknown>[] {
    const event = asRecord(raw);
    const type = event.type;
    if (type === "response.created") {
      return [this.chunk({ role: "assistant", content: "" }, null)];
    }
    if (type === "response.output_text.delta") {
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!delta) return [];
      this.content += delta;
      return [this.chunk({ content: delta }, null)];
    }
    if (type === "response.output_item.added") {
      const item = asRecord(event.item);
      if (item.type !== "function_call") return [];
      const itemId = asString(item.id ?? event.item_id);
      const call: PendingCall = {
        index: this.order.length,
        id: callIdOf(item.call_id, item.id),
        name: asString(item.name),
        arguments: typeof item.arguments === "string" ? item.arguments : "",
      };
      this.calls.set(itemId, call);
      this.order.push(itemId);
      return [
        this.chunk(
          {
            tool_calls: [
              {
                index: call.index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: "" },
              },
            ],
          },
          null,
        ),
      ];
    }
    if (type === "response.function_call_arguments.delta") {
      const itemId = asString(event.item_id);
      const call = this.calls.get(itemId);
      const delta = typeof event.delta === "string" ? event.delta : "";
      if (!call || !delta) return [];
      call.arguments += delta;
      return [
        this.chunk({ tool_calls: [{ index: call.index, function: { arguments: delta } }] }, null),
      ];
    }
    if (type === "response.completed") {
      const response = asRecord(event.response);
      this.usage = responsesUsage(response.usage);
      this.finishReason = this.order.length > 0 ? "tool_calls" : "stop";
      this.completed = true;
      return [this.chunk({}, this.finishReason)];
    }
    if (type === "response.incomplete") {
      this.finishReason = "length";
      this.completed = true;
      return [this.chunk({}, this.finishReason)];
    }
    if (type === "response.failed") {
      const response = asRecord(event.response);
      const error = asRecord(response.error);
      this.failure = typeof error.message === "string" ? error.message : "upstream response failed";
      return [];
    }
    if (type === "error") {
      const error = asRecord(event.error);
      this.failure = typeof error.message === "string" ? error.message : "upstream error";
      return [];
    }
    return [];
  }

  result(): ChatBridgeResult {
    const toolCalls = this.order.flatMap((key) => {
      const call = this.calls.get(key);
      return call ? [{ id: call.id, name: call.name, arguments: call.arguments }] : [];
    });
    return {
      content: this.content,
      toolCalls,
      finishReason: this.finishReason,
      usage: this.usage,
      ...(this.failure ? { failure: this.failure } : {}),
    };
  }

  finish(): Record<string, unknown>[] {
    if (this.failure) {
      return [{ error: { message: this.failure, type: "upstream_error" } }];
    }
    if (!this.completed) return [this.chunk({}, this.finishReason)];
    return [];
  }
}

export function chatCompletionFrom(
  result: ChatBridgeResult,
  model: string,
  id: string,
  created: number,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.content || null,
  };
  if (result.toolCalls.length > 0) {
    message.tool_calls = result.toolCalls.map((call, index) => ({
      index,
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: result.finishReason }],
    usage: {
      prompt_tokens: result.usage.input,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.input + result.usage.output,
    },
  };
}

export function splitSseEvents(text: string): {
  events: Record<string, unknown>[];
  rest: string;
} {
  const events: Record<string, unknown>[] = [];
  let rest = text.replace(/\r\n/g, "\n");
  let index = rest.indexOf("\n\n");
  while (index !== -1) {
    const block = rest.slice(0, index);
    rest = rest.slice(index + 2);
    for (const line of block.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data.length === 0 || data === "[DONE]") continue;
      try {
        events.push(JSON.parse(data) as Record<string, unknown>);
      } catch {
        continue;
      }
    }
    index = rest.indexOf("\n\n");
  }
  return { events, rest };
}

export function responsesToChatStream(
  model: string,
  onFinish?: (result: ChatBridgeResult) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const bridge = new ResponsesChatBridge(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const emit = (
    payloads: Record<string, unknown>[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    for (const payload of payloads) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const { events, rest } = splitSseEvents(buffer);
      buffer = rest;
      for (const event of events) emit(bridge.handle(event), controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      for (const event of splitSseEvents(buffer).events) emit(bridge.handle(event), controller);
      emit(bridge.finish(), controller);
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      onFinish?.(bridge.result());
    },
  });
}

/**
 * Inverse of {@link ResponsesChatBridge}: Chat Completions SSE → Responses SSE.
 * Lets Codex keep talking `/v1/responses` while the upstream is OpenRouter / DeepSeek / …
 *
 * Codex is picky about the Responses event shape: bare `{type, delta}` text events are
 * dropped. Emit the same item/content indexes the native API does, plus `.done` markers,
 * and surface OpenRouter reasoning deltas so a thinking-only reply is not silent.
 */
export class ChatToResponsesBridge {
  readonly id: string;
  readonly created: number;
  private readonly model: string;
  private readonly calls = new Map<
    number,
    { id: string; name: string; arguments: string; itemId: string; outputIndex: number }
  >();
  private content = "";
  private reasoning = "";
  private usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private finishReason = "stop";
  private started = false;
  private completed = false;
  private messageItemId: string | undefined;
  private messageOutputIndex: number | undefined;
  private nextOutputIndex = 0;

  constructor(model: string) {
    this.model = model;
    this.id = `resp_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
    this.created = Math.floor(Date.now() / 1000);
  }

  private responseSkeleton(status: string, output: unknown[] = []): Record<string, unknown> {
    return {
      id: this.id,
      object: "response",
      created_at: this.created,
      status,
      model: this.model,
      output,
      usage: {
        input_tokens: this.usage.input,
        output_tokens: this.usage.output,
        total_tokens: this.usage.input + this.usage.output,
        input_tokens_details: { cached_tokens: this.usage.cacheRead },
      },
    };
  }

  private ensureMessageItem(events: Record<string, unknown>[]): {
    itemId: string;
    outputIndex: number;
  } {
    if (this.messageItemId !== undefined && this.messageOutputIndex !== undefined) {
      return { itemId: this.messageItemId, outputIndex: this.messageOutputIndex };
    }
    const itemId = `msg_${this.id}`;
    const outputIndex = this.nextOutputIndex;
    this.nextOutputIndex += 1;
    this.messageItemId = itemId;
    this.messageOutputIndex = outputIndex;
    events.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: {
        type: "message",
        id: itemId,
        role: "assistant",
        status: "in_progress",
        content: [],
      },
    });
    events.push({
      type: "response.content_part.added",
      item_id: itemId,
      output_index: outputIndex,
      content_index: 0,
      part: { type: "output_text", text: "" },
    });
    return { itemId, outputIndex };
  }

  private reasoningText(delta: Record<string, unknown>): string {
    if (typeof delta.reasoning === "string" && delta.reasoning.length > 0) return delta.reasoning;
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
      return delta.reasoning_content;
    }
    const details = Array.isArray(delta.reasoning_details) ? delta.reasoning_details : [];
    const parts: string[] = [];
    for (const raw of details) {
      const detail = asRecord(raw);
      if (typeof detail.text === "string" && detail.text.length > 0) parts.push(detail.text);
      else if (typeof detail.content === "string" && detail.content.length > 0) {
        parts.push(detail.content);
      }
    }
    return parts.join("");
  }

  handle(raw: unknown): Record<string, unknown>[] {
    const chunk = asRecord(raw);
    if (typeof chunk.error === "object" && chunk.error !== null) {
      const error = asRecord(chunk.error);
      return [
        {
          type: "response.failed",
          response: {
            ...this.responseSkeleton("failed"),
            error: {
              message: typeof error.message === "string" ? error.message : "upstream error",
              type: typeof error.type === "string" ? error.type : "upstream_error",
            },
          },
        },
      ];
    }

    const events: Record<string, unknown>[] = [];
    if (!this.started) {
      this.started = true;
      events.push({ type: "response.created", response: this.responseSkeleton("in_progress") });
      events.push({ type: "response.in_progress", response: this.responseSkeleton("in_progress") });
    }

    if (chunk.usage) {
      const usage = asRecord(chunk.usage);
      this.usage = {
        input: number(usage.prompt_tokens),
        output: number(usage.completion_tokens),
        cacheRead: number(asRecord(usage.prompt_tokens_details).cached_tokens),
        cacheWrite: 0,
      };
    }

    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of choices) {
      const choice = asRecord(rawChoice);
      const delta = asRecord(choice.delta);

      const thinking = this.reasoningText(delta);
      if (thinking.length > 0) {
        this.reasoning += thinking;
        events.push({ type: "response.reasoning_summary_text.delta", delta: thinking });
      }

      if (typeof delta.content === "string" && delta.content.length > 0) {
        const { itemId, outputIndex } = this.ensureMessageItem(events);
        this.content += delta.content;
        events.push({
          type: "response.output_text.delta",
          item_id: itemId,
          output_index: outputIndex,
          content_index: 0,
          delta: delta.content,
        });
      }

      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawCall of toolCalls) {
        const call = asRecord(rawCall);
        const index = typeof call.index === "number" ? call.index : 0;
        const fn = asRecord(call.function);
        let pending = this.calls.get(index);
        if (!pending) {
          const id =
            asString(call.id) || `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
          const itemId = `fc_${id}`;
          const outputIndex = this.nextOutputIndex;
          this.nextOutputIndex += 1;
          pending = {
            id,
            name: asString(fn.name),
            arguments: "",
            itemId,
            outputIndex,
          };
          this.calls.set(index, pending);
          events.push({
            type: "response.output_item.added",
            output_index: outputIndex,
            item_id: itemId,
            item: {
              type: "function_call",
              id: itemId,
              call_id: id,
              name: pending.name,
              arguments: "",
              status: "in_progress",
            },
          });
        } else if (
          typeof call.id === "string" &&
          call.id.length > 0 &&
          pending.id.startsWith("call_")
        ) {
          // First chunk sometimes omits the id; adopt it when it arrives.
          pending.id = call.id;
        }
        if (typeof fn.name === "string" && fn.name.length > 0) pending.name = fn.name;
        if (typeof fn.arguments === "string" && fn.arguments.length > 0) {
          pending.arguments += fn.arguments;
          events.push({
            type: "response.function_call_arguments.delta",
            item_id: pending.itemId,
            output_index: pending.outputIndex,
            delta: fn.arguments,
          });
        }
      }
      if (typeof choice.finish_reason === "string" && choice.finish_reason.length > 0) {
        this.finishReason = choice.finish_reason;
      }
    }
    return events;
  }

  result(): ChatBridgeResult {
    return {
      content: this.content,
      toolCalls: [...this.calls.values()].map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
      finishReason:
        this.finishReason === "tool_calls" || this.calls.size > 0 ? "tool_calls" : "stop",
      usage: this.usage,
    };
  }

  finish(): Record<string, unknown>[] {
    if (this.completed) return [];
    this.completed = true;
    const events: Record<string, unknown>[] = [];
    const output: unknown[] = [];

    if (this.messageItemId !== undefined && this.messageOutputIndex !== undefined) {
      events.push({
        type: "response.output_text.done",
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        text: this.content,
      });
      events.push({
        type: "response.content_part.done",
        item_id: this.messageItemId,
        output_index: this.messageOutputIndex,
        content_index: 0,
        part: { type: "output_text", text: this.content },
      });
      const messageItem = {
        type: "message",
        id: this.messageItemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: this.content }],
      };
      events.push({
        type: "response.output_item.done",
        output_index: this.messageOutputIndex,
        item: messageItem,
      });
      output.push(messageItem);
    } else if (this.content.length > 0 || (this.reasoning.length > 0 && this.calls.size === 0)) {
      // No streamed message item (e.g. reasoning-only). Still surface something Codex can show.
      const text = this.content.length > 0 ? this.content : this.reasoning;
      const itemId = `msg_${this.id}`;
      output.push({
        type: "message",
        id: itemId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text }],
      });
    }

    for (const call of this.calls.values()) {
      events.push({
        type: "response.function_call_arguments.done",
        item_id: call.itemId,
        output_index: call.outputIndex,
        arguments: call.arguments,
      });
      const item = {
        type: "function_call",
        id: call.itemId,
        call_id: call.id,
        name: call.name,
        arguments: call.arguments,
        status: "completed",
      };
      events.push({
        type: "response.output_item.done",
        output_index: call.outputIndex,
        item,
      });
      output.push(item);
    }

    events.push({
      type: "response.completed",
      response: this.responseSkeleton("completed", output),
    });
    return events;
  }
}

/** OpenAI Chat Completions SSE → Responses SSE for a Responses client. */
export function chatToResponsesStream(
  model: string,
  onFinish?: (result: ChatBridgeResult) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const bridge = new ChatToResponsesBridge(model);
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const emit = (
    payloads: Record<string, unknown>[],
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    for (const payload of payloads) {
      const type = typeof payload.type === "string" ? payload.type : "message";
      controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
    }
  };

  const consume = (
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    buffer += text;
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data.length === 0 || data === "[DONE]") continue;
        try {
          emit(bridge.handle(JSON.parse(data)), controller);
        } catch {
          continue;
        }
      }
      index = buffer.indexOf("\n\n");
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      consume(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      consume(decoder.decode(), controller);
      emit(bridge.finish(), controller);
      onFinish?.(bridge.result());
    },
  });
}

export function chatResultFromResponse(response: Record<string, unknown>): ChatBridgeResult {
  const output = Array.isArray(response.output) ? response.output : [];
  let content = "";
  const toolCalls: ChatBridgeCall[] = [];
  for (const raw of output) {
    const item = asRecord(raw);
    if (item.type === "message") {
      const parts = Array.isArray(item.content) ? item.content : [];
      for (const rawPart of parts) {
        const part = asRecord(rawPart);
        if (typeof part.text === "string") content += part.text;
      }
      continue;
    }
    if (item.type === "function_call") {
      toolCalls.push({
        id: callIdOf(item.call_id, item.id),
        name: asString(item.name),
        arguments: typeof item.arguments === "string" ? item.arguments : "",
      });
    }
  }
  return {
    content,
    toolCalls,
    finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
    usage: responsesUsage(response.usage),
  };
}

export function responsesErrorMessage(events: Record<string, unknown>[]): string | undefined {
  for (const event of events) {
    if (event.type !== "response.failed") continue;
    const response = asRecord(event.response);
    const error = asRecord(response.error);
    return typeof error.message === "string" ? error.message : "upstream response failed";
  }
  return undefined;
}

/**
 * Passthrough Responses SSE that repairs an empty `response.completed.output` from
 * earlier `output_item.done` events. Needed for ChatGPT remote compaction v2, where
 * the compaction payload often arrives only on the item event.
 */
export function responsesPassthroughRepairStream(
  onCompleted?: (response: Record<string, unknown>) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  const seen: Record<string, unknown>[] = [];

  const rewrite = (event: Record<string, unknown>): Record<string, unknown> => {
    seen.push(event);
    if (event.type !== "response.completed" && event.type !== "response.done") return event;
    const response = asRecord(event.response);
    const repaired = repairResponsesOutput(response, seen);
    if (repaired === response) return event;
    return { ...event, response: repaired };
  };

  const emit = (
    event: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const next = rewrite(event);
    if (next.type === "response.completed") {
      onCompleted?.(asRecord(next.response));
    }
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(next)}\n\n`));
  };

  const consume = (
    text: string,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    buffer += text;
    const { events, rest } = splitSseEvents(buffer);
    buffer = rest;
    for (const event of events) emit(event, controller);
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      consume(decoder.decode(chunk, { stream: true }), controller);
    },
    flush(controller) {
      consume(decoder.decode(), controller);
      if (buffer.trim().length > 0) {
        // Trailing incomplete frame — forward as-is rather than drop bytes.
        controller.enqueue(encoder.encode(buffer));
        buffer = "";
      }
    },
  });
}
