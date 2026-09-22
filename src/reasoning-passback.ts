import { createHash } from "node:crypto";

/**
 * DeepSeek (and Moonshot/Kimi) thinking mode requires `reasoning_content` on
 * assistant turns to be replayed whenever the request carries `tools`. Clients
 * like Cursor drop that field after the first tool call, so the next upstream
 * request fails with:
 *
 *   The reasoning_content in the thinking mode must be passed back to the API.
 *
 * Jevonian sits between the client and the provider: capture the field from
 * upstream responses, then reinject it into later outbound chat histories.
 *
 * @see https://api-docs.deepseek.com/guides/thinking_mode
 */

const MAX_ENTRIES = 4_000;
const MAX_AGE_MS = 6 * 60 * 60 * 1_000;

interface CacheEntry {
  reasoning: string;
  at: number;
}

const cache = new Map<string, CacheEntry>();

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function sha256(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function prune(now = Date.now()): void {
  for (const [key, entry] of cache) {
    if (now - entry.at > MAX_AGE_MS) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function put(key: string, reasoning: string): void {
  cache.delete(key);
  cache.set(key, { reasoning, at: Date.now() });
  prune();
}

function get(key: string): string | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.at > MAX_AGE_MS) {
    cache.delete(key);
    return undefined;
  }
  // Refresh LRU order.
  cache.delete(key);
  cache.set(key, entry);
  return entry.reasoning;
}

/** Clears the in-process cache. Tests only. */
export function clearReasoningPassbackCache(): void {
  cache.clear();
}

export function reasoningPassbackCacheSize(): number {
  return cache.size;
}

/**
 * True when this upstream is known to reject missing `reasoning_content` on
 * tool-bearing turns (DeepSeek thinking mode, Moonshot/Kimi thinking).
 */
export function needsReasoningPassback(providerName: string, model: string, baseUrl = ""): boolean {
  const haystack = `${providerName} ${model} ${baseUrl}`.toLowerCase();
  return (
    haystack.includes("deepseek") ||
    haystack.includes("moonshot") ||
    /(^|[^a-z])kimi([^a-z]|$)/.test(haystack)
  );
}

function contentFingerprint(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      const block = asRecord(part);
      if (typeof block.text === "string") return { type: block.type ?? "text", text: block.text };
      return block;
    });
  }
  return content ?? "";
}

function normalizeToolCall(raw: unknown): Record<string, unknown> {
  const call = asRecord(raw);
  const fn = asRecord(call.function);
  const argumentsValue =
    typeof fn.arguments === "string"
      ? fn.arguments
      : fn.arguments === undefined
        ? ""
        : JSON.stringify(fn.arguments);
  return {
    id: typeof call.id === "string" ? call.id : null,
    type: typeof call.type === "string" ? call.type : "function",
    function: {
      name: typeof fn.name === "string" ? fn.name : "",
      arguments: argumentsValue,
    },
  };
}

function toolCallIds(message: Record<string, unknown>): string[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const ids: string[] = [];
  for (const raw of calls) {
    const id = asRecord(raw).id;
    if (typeof id === "string" && id.length > 0) ids.push(id);
  }
  return ids;
}

function toolCallSignatures(message: Record<string, unknown>): string[] {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return calls.map((raw) => {
    const normalized = normalizeToolCall(raw);
    const { id: _id, ...rest } = normalized;
    return sha256(rest);
  });
}

/** Stable fingerprint of an assistant message, ignoring reasoning_content. */
export function messageSignature(message: Record<string, unknown>): string {
  const calls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((raw) => normalizeToolCall(raw))
    : [];
  return sha256({
    content: contentFingerprint(message.content),
    tool_calls: calls,
  });
}

function canonicalScopeMessage(message: Record<string, unknown>): Record<string, unknown> {
  const canonical: Record<string, unknown> = { role: message.role };
  if ("content" in message) canonical.content = contentFingerprint(message.content);
  if (typeof message.name === "string") canonical.name = message.name;
  if (typeof message.tool_call_id === "string") canonical.tool_call_id = message.tool_call_id;
  if (Array.isArray(message.tool_calls)) {
    canonical.tool_calls = message.tool_calls.map((raw) => normalizeToolCall(raw));
  }
  return canonical;
}

/** Hash of the conversation prefix used to isolate concurrent chats. */
export function conversationScope(
  messages: readonly Record<string, unknown>[],
  namespace = "",
): string {
  const scopeMessages = messages.map((message) => canonicalScopeMessage(message));
  return sha256(namespace ? { namespace, messages: scopeMessages } : scopeMessages);
}

function lookupKeys(message: Record<string, unknown>, scope: string, namespace: string): string[] {
  const keys = [
    `scope:${scope}:signature:${messageSignature(message)}`,
    ...toolCallIds(message).map((id) => `scope:${scope}:tool_call:${id}`),
    ...toolCallSignatures(message).map((sig) => `scope:${scope}:tool_call_signature:${sig}`),
  ];
  if (namespace.length > 0) {
    // Portable fallbacks when the prefix hash drifts (compaction, soft edits)
    // but tool-call ids or the message body still match within this session.
    keys.push(
      `ns:${namespace}:signature:${messageSignature(message)}`,
      ...toolCallIds(message).map((id) => `ns:${namespace}:tool_call:${id}`),
      ...toolCallSignatures(message).map((sig) => `ns:${namespace}:tool_call_signature:${sig}`),
    );
  }
  return [...new Set(keys)];
}

/**
 * Persist an assistant message's reasoning under every lookup key that later
 * turns might use to find it again.
 */
export function rememberAssistantReasoning(
  message: Record<string, unknown>,
  priorMessages: readonly Record<string, unknown>[],
  namespace = "",
): number {
  if (message.role !== "assistant") return 0;
  const reasoning = message.reasoning_content;
  if (typeof reasoning !== "string") return 0;
  const scope = conversationScope(priorMessages, namespace);
  const keys = lookupKeys(message, scope, namespace);
  for (const key of keys) put(key, reasoning);
  return keys.length;
}

function requestHasTools(body: Record<string, unknown>): boolean {
  return Array.isArray(body.tools) && body.tools.length > 0;
}

function assistantNeedsReasoning(
  message: Record<string, unknown>,
  prior: readonly Record<string, unknown>[],
  hasTools: boolean,
): boolean {
  if (!hasTools) {
    // Without tools, DeepSeek ignores reasoning on later turns — no repair needed.
    return false;
  }
  // With tools present, every assistant turn must carry reasoning_content —
  // including turns that never called a tool.
  if (message.role !== "assistant") return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) return true;
  for (let i = prior.length - 1; i >= 0; i -= 1) {
    const role = prior[i]?.role;
    if (role === "tool") return true;
    if (role === "user" || role === "system") break;
  }
  // Final assistant reply after a tool loop, or a plain assistant turn while
  // tools are advertised — DeepSeek still requires the field.
  return true;
}

export interface RepairStats {
  patched: number;
  emptyFilled: number;
  alreadyPresent: number;
}

/**
 * Reinject cached `reasoning_content` into a chat-completions body before it
 * is sent upstream. When a required field is still missing, fill `""` so the
 * provider accepts the request (same contract DeepSeek documents for turns
 * that produced no reasoning text).
 */
export function repairReasoningContent(
  body: Record<string, unknown>,
  namespace = "",
): { body: Record<string, unknown>; stats: RepairStats } {
  const stats: RepairStats = { patched: 0, emptyFilled: 0, alreadyPresent: 0 };
  if (!requestHasTools(body)) return { body, stats };
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return { body, stats };

  const next = messages.map((raw) => asRecord(raw));
  let changed = false;

  for (let i = 0; i < next.length; i += 1) {
    const message = next[i]!;
    if (!assistantNeedsReasoning(message, next.slice(0, i), true)) continue;

    if (typeof message.reasoning_content === "string") {
      stats.alreadyPresent += 1;
      // Keep whatever the client already sent, and refresh the cache from it.
      rememberAssistantReasoning(message, next.slice(0, i), namespace);
      continue;
    }

    const scope = conversationScope(next.slice(0, i), namespace);
    let restored: string | undefined;
    for (const key of lookupKeys(message, scope, namespace)) {
      restored = get(key);
      if (restored !== undefined) break;
    }

    const reasoning = restored ?? "";
    next[i] = { ...message, reasoning_content: reasoning };
    changed = true;
    if (restored !== undefined) stats.patched += 1;
    else stats.emptyFilled += 1;
  }

  if (!changed) return { body, stats };
  return { body: { ...body, messages: next }, stats };
}

/**
 * Capture reasoning from a non-streaming chat completion response.
 */
export function rememberFromChatCompletion(
  json: Record<string, unknown>,
  priorMessages: readonly Record<string, unknown>[],
  namespace = "",
): number {
  const choices = Array.isArray(json.choices) ? json.choices : [];
  let stored = 0;
  for (const raw of choices) {
    const message = asRecord(asRecord(raw).message);
    stored += rememberAssistantReasoning(message, priorMessages, namespace);
  }
  return stored;
}

interface StreamChoiceState {
  content: string;
  reasoning: string;
  hasReasoning: boolean;
  toolCalls: Record<string, unknown>[];
  finishReason: string | null;
}

/**
 * Accumulates OpenAI chat-completion SSE deltas so reasoning can be stored
 * once tool-call ids (or the finish reason) are known.
 */
export class ReasoningStreamAccumulator {
  private readonly choices = new Map<number, StreamChoiceState>();

  ingest(chunk: Record<string, unknown>): void {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const raw of choices) {
      const choice = asRecord(raw);
      const index = typeof choice.index === "number" ? choice.index : 0;
      const state = this.choices.get(index) ?? {
        content: "",
        reasoning: "",
        hasReasoning: false,
        toolCalls: [],
        finishReason: null,
      };
      if (typeof choice.finish_reason === "string") state.finishReason = choice.finish_reason;

      const delta = asRecord(choice.delta);
      if (typeof delta.content === "string") state.content += delta.content;
      if (typeof delta.reasoning_content === "string") {
        state.hasReasoning = true;
        state.reasoning += delta.reasoning_content;
      } else if (typeof delta.reasoning === "string") {
        // OpenRouter-style alias.
        state.hasReasoning = true;
        state.reasoning += delta.reasoning;
      }
      this.mergeToolCalls(state, delta.tool_calls);
      this.choices.set(index, state);
    }
  }

  /**
   * Persist any choice that has reasoning and either finished or already
   * carries identified tool calls.
   */
  store(priorMessages: readonly Record<string, unknown>[], namespace = ""): number {
    let stored = 0;
    for (const state of this.choices.values()) {
      if (!state.hasReasoning) continue;
      const ready =
        state.finishReason !== null ||
        (state.toolCalls.length > 0 &&
          state.toolCalls.every((call) => typeof call.id === "string" && call.id.length > 0));
      if (!ready) continue;
      const message: Record<string, unknown> = {
        role: "assistant",
        content: state.content,
        reasoning_content: state.reasoning,
      };
      if (state.toolCalls.length > 0) message.tool_calls = state.toolCalls;
      stored += rememberAssistantReasoning(message, priorMessages, namespace);
    }
    return stored;
  }

  private mergeToolCalls(state: StreamChoiceState, deltas: unknown): void {
    if (!Array.isArray(deltas)) return;
    for (const raw of deltas) {
      const delta = asRecord(raw);
      const index = typeof delta.index === "number" ? delta.index : state.toolCalls.length;
      while (state.toolCalls.length <= index) {
        state.toolCalls.push({ type: "function", function: { name: "", arguments: "" } });
      }
      const call = state.toolCalls[index]!;
      if (typeof delta.id === "string" && delta.id.length > 0) call.id = delta.id;
      if (typeof delta.type === "string") call.type = delta.type;
      const fnDelta = asRecord(delta.function);
      const fn = asRecord(call.function);
      if (typeof fnDelta.name === "string" && fnDelta.name.length > 0) {
        fn.name = `${typeof fn.name === "string" ? fn.name : ""}${fnDelta.name}`;
      }
      if (typeof fnDelta.arguments === "string") {
        fn.arguments = `${typeof fn.arguments === "string" ? fn.arguments : ""}${fnDelta.arguments}`;
      }
      call.function = fn;
    }
  }
}

/**
 * Transform that tees an OpenAI chat SSE stream, remembering reasoning without
 * altering bytes sent to the client.
 */
export function reasoningCaptureTransform(
  priorMessages: readonly Record<string, unknown>[],
  namespace = "",
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const accumulator = new ReasoningStreamAccumulator();
  let buffer = "";

  const consume = (text: string): void => {
    buffer += text;
    let index = buffer.indexOf("\n\n");
    while (index !== -1) {
      const event = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data.length === 0 || data === "[DONE]") continue;
        try {
          accumulator.ingest(JSON.parse(data) as Record<string, unknown>);
          accumulator.store(priorMessages, namespace);
        } catch {
          continue;
        }
      }
      index = buffer.indexOf("\n\n");
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      consume(decoder.decode(chunk, { stream: true }));
    },
    flush() {
      consume(decoder.decode());
      accumulator.store(priorMessages, namespace);
    },
  });
}
