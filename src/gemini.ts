import type { Usage } from "./pricing";
import { splitSseEvents } from "./responses";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

const SKIP_THOUGHT_SIGNATURE = "skip_thought_signature_validator";
const SIGNATURE_CACHE_LIMIT = 512;
const signatures = new Map<string, string>();

function signatureKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args ?? {})}`;
}

function rememberSignature(name: string, args: unknown, signature: unknown): void {
  if (typeof signature !== "string" || signature.length === 0) return;
  const key = signatureKey(name, args);
  signatures.delete(key);
  signatures.set(key, signature);
  if (signatures.size > SIGNATURE_CACHE_LIMIT) {
    const oldest = signatures.keys().next().value;
    if (oldest !== undefined) signatures.delete(oldest);
  }
}

export function thoughtSignatureFor(name: string, args: unknown): string | undefined {
  return signatures.get(signatureKey(name, args));
}

export function geminiEndpoint(baseUrl: string, stream: boolean): string {
  const base = baseUrl.replace(/\/+$/, "").replace(/\/v1internal$/, "");
  return stream
    ? `${base}/v1internal:streamGenerateContent?alt=sse`
    : `${base}/v1internal:generateContent`;
}

export function unwrapGemini(payload: unknown): Record<string, unknown> {
  const body = asRecord(payload);
  return body.response === undefined ? body : asRecord(body.response);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        const record = asRecord(block);
        if (typeof record.text === "string") return record.text;
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return value === undefined ? "" : JSON.stringify(value);
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      if (parsed !== undefined) return { result: parsed };
      return { result: value };
    } catch {
      return { result: value };
    }
  }
  if (Array.isArray(value)) return { result: textOf(value) || JSON.stringify(value) };
  const record = asRecord(value);
  if (Array.isArray(record)) return { result: JSON.stringify(record) };
  return Object.keys(record).length > 0 ? record : { result: "" };
}

function parseArgs(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? {} : asRecord(parsed);
    } catch {
      return {};
    }
  }
  return Array.isArray(value) ? {} : asRecord(value);
}

const UNSUPPORTED_SCHEMA_KEYS = new Set([
  "$schema",
  "$id",
  "$defs",
  "definitions",
  "$ref",
  "default",
  "examples",
  "title",
  "const",
]);

export function sanitizeSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sanitizeSchema(item));
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    if (UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    target[key] = sanitizeSchema(item);
  }
  if (source.const !== undefined && target.enum === undefined) target.enum = [source.const];
  return target;
}

export function sanitizeToolName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 64);
  if (cleaned.length === 0) return "tool";
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `_${cleaned}`.slice(0, 64);
}

function chatToolsToGemini(raw: unknown): unknown[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const declarations = raw.flatMap((entry) => {
    const tool = asRecord(entry);
    if (tool.type !== "function") return [];
    const fn = asRecord(tool.function);
    const name = asString(fn.name);
    if (name.length === 0) return [];
    return [
      {
        name: sanitizeToolName(name),
        ...(typeof fn.description === "string" ? { description: fn.description } : {}),
        parameters: sanitizeSchema(asRecord(fn.parameters)),
      },
    ];
  });
  return declarations.length > 0 ? [{ functionDeclarations: declarations }] : undefined;
}

function toolConfigFor(choice: unknown): Record<string, unknown> | undefined {
  if (choice === "none") return { functionCallingConfig: { mode: "NONE" } };
  if (choice === "required") return { functionCallingConfig: { mode: "ANY" } };
  if (typeof choice === "object" && choice !== null) {
    const name = asString(asRecord(asRecord(choice).function).name);
    if (name.length > 0) {
      return {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: [sanitizeToolName(name)] },
      };
    }
  }
  return undefined;
}

export function chatToGemini(body: Record<string, unknown>): Record<string, unknown> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const systemTexts: string[] = [];
  const contents: Array<{ role: string; parts: unknown[] }> = [];
  const toolNames = new Map<string, string>();

  const push = (role: "user" | "model", parts: unknown[]): void => {
    if (parts.length === 0) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };

  for (const raw of messages) {
    const message = asRecord(raw);
    const role = message.role;
    if (role === "system" || role === "developer") {
      const text = textOf(message.content);
      if (text.length > 0) systemTexts.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      const callId = asString(message.tool_call_id);
      const name = toolNames.get(callId) ?? sanitizeToolName(asString(message.name) || "tool");
      push("user", [
        {
          functionResponse: {
            name,
            ...(callId.length > 0 ? { id: callId } : {}),
            response: responseObject(message.content),
          },
        },
      ]);
      continue;
    }
    if (role === "assistant") {
      const parts: unknown[] = [];
      const text = textOf(message.content);
      if (text.length > 0) parts.push({ text });
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      let firstCall = true;
      for (const rawCall of calls) {
        const call = asRecord(rawCall);
        const fn = asRecord(call.function);
        const id = asString(call.id);
        const name = sanitizeToolName(asString(fn.name));
        if (id.length > 0) toolNames.set(id, name);
        const args = parseArgs(fn.arguments);
        const signature = thoughtSignatureFor(name, args);
        parts.push({
          functionCall: { name, args, ...(id.length > 0 ? { id } : {}) },
          ...(signature !== undefined
            ? { thoughtSignature: signature }
            : firstCall
              ? { thoughtSignature: SKIP_THOUGHT_SIGNATURE }
              : {}),
        });
        firstCall = false;
      }
      push("model", parts);
      continue;
    }
    const text = textOf(message.content);
    push("user", text.length > 0 ? [{ text }] : []);
  }

  const request: Record<string, unknown> = { contents };
  if (systemTexts.length > 0) {
    request.systemInstruction = { parts: [{ text: systemTexts.join("\n\n") }] };
  }
  const tools = chatToolsToGemini(body.tools);
  if (tools) request.tools = tools;
  const config: Record<string, unknown> = {};
  if (typeof body.temperature === "number") config.temperature = body.temperature;
  if (typeof body.top_p === "number") config.topP = body.top_p;
  const max = body.max_completion_tokens ?? body.max_tokens;
  if (typeof max === "number") config.maxOutputTokens = max;
  const stop = body.stop;
  if (typeof stop === "string") config.stopSequences = [stop];
  else if (Array.isArray(stop)) {
    const sequences = stop.filter((item): item is string => typeof item === "string");
    if (sequences.length > 0) config.stopSequences = sequences;
  }
  if (Object.keys(config).length > 0) request.generationConfig = config;
  const toolConfig = toolConfigFor(body.tool_choice);
  if (toolConfig) request.toolConfig = toolConfig;
  return request;
}

export function geminiUsage(raw: unknown): Usage {
  const meta = asRecord(raw);
  return {
    input: number(meta.promptTokenCount),
    output: number(meta.candidatesTokenCount) + number(meta.thoughtsTokenCount),
    cacheRead: number(meta.cachedContentTokenCount),
    cacheWrite: 0,
  };
}

export interface GeminiCall {
  id?: string;
  name: string;
  arguments: string;
}

export interface GeminiResult {
  text: string;
  calls: GeminiCall[];
  finishReason: string;
  usage: Usage;
}

const FINISH_REASONS: Record<string, string> = {
  STOP: "stop",
  MAX_TOKENS: "length",
  MAX_OUTPUT_TOKENS: "length",
  SAFETY: "content_filter",
  RECITATION: "content_filter",
  BLOCKLIST: "content_filter",
  PROHIBITED_CONTENT: "content_filter",
  SPII: "content_filter",
  OTHER: "stop",
};

function partsOf(response: Record<string, unknown>, index = 0): Record<string, unknown>[] {
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const candidate = asRecord(candidates[index]);
  const content = asRecord(candidate.content);
  const parts = Array.isArray(content.parts) ? content.parts : [];
  return parts.map((part) => asRecord(part));
}

function finishOf(response: Record<string, unknown>, hasCalls: boolean, index = 0): string {
  const candidates = Array.isArray(response.candidates) ? response.candidates : [];
  const raw = asString(asRecord(candidates[index]).finishReason);
  if (hasCalls && (raw === "STOP" || raw === "OTHER" || raw === "")) return "tool_calls";
  return FINISH_REASONS[raw] ?? (hasCalls ? "tool_calls" : "stop");
}

export function geminiResult(response: Record<string, unknown>): GeminiResult {
  let text = "";
  const calls: GeminiCall[] = [];
  let pendingSignature: string | undefined;
  for (const part of partsOf(response)) {
    const signature = typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
    if (part.thought === true) {
      if (signature !== undefined) pendingSignature = signature;
      continue;
    }
    if (typeof part.text === "string") text += part.text;
    const call = part.functionCall === undefined ? undefined : asRecord(part.functionCall);
    if (call) {
      const id = asString(call.id);
      const args = call.args ?? {};
      rememberSignature(asString(call.name), args, signature ?? pendingSignature);
      pendingSignature = undefined;
      calls.push({
        ...(id.length > 0 ? { id } : {}),
        name: asString(call.name),
        arguments: JSON.stringify(args),
      });
    }
  }
  return {
    text,
    calls,
    finishReason: finishOf(response, calls.length > 0),
    usage: geminiUsage(response.usageMetadata),
  };
}

export function geminiChatCompletion(
  response: Record<string, unknown>,
  model: string,
): Record<string, unknown> {
  const result = geminiResult(response);
  const message: Record<string, unknown> = {
    role: "assistant",
    content: result.text.length > 0 ? result.text : null,
  };
  if (result.calls.length > 0) {
    message.tool_calls = result.calls.map((call, index) => ({
      index,
      id: call.id ?? `call_${index}`,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  return {
    id:
      asString(response.responseId) ||
      `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: asString(response.modelVersion) || model,
    choices: [{ index: 0, message, finish_reason: result.finishReason }],
    usage: {
      prompt_tokens: result.usage.input,
      completion_tokens: result.usage.output,
      total_tokens: result.usage.input + result.usage.output,
    },
  };
}

export function geminiToChatStream(
  model: string,
  onFinish?: (usage: Usage) => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const id = `chatcmpl-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);
  let buffer = "";
  let usage: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let callIndex = 0;
  let roleSent = false;
  let finished = false;
  let pendingSignature: string | undefined;

  const chunk = (
    delta: Record<string, unknown>,
    finishReason: string | null,
  ): Record<string, unknown> => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });

  const emit = (
    payload: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
  };

  const handle = (
    event: Record<string, unknown>,
    controller: TransformStreamDefaultController<Uint8Array>,
  ): void => {
    const response = unwrapGemini(event);
    if (!roleSent) {
      emit(chunk({ role: "assistant", content: "" }, null), controller);
      roleSent = true;
    }
    for (const part of partsOf(response)) {
      const signature =
        typeof part.thoughtSignature === "string" ? part.thoughtSignature : undefined;
      if (part.thought === true) {
        if (signature !== undefined) pendingSignature = signature;
        continue;
      }
      if (typeof part.text === "string" && part.text.length > 0) {
        emit(chunk({ content: part.text }, null), controller);
      }
      const call = part.functionCall === undefined ? undefined : asRecord(part.functionCall);
      if (call) {
        const callId = asString(call.id) || `call_${callIndex}`;
        rememberSignature(asString(call.name), call.args ?? {}, signature ?? pendingSignature);
        pendingSignature = undefined;
        emit(
          chunk(
            {
              tool_calls: [
                {
                  index: callIndex,
                  id: callId,
                  type: "function",
                  function: {
                    name: asString(call.name),
                    arguments: JSON.stringify(call.args ?? {}),
                  },
                },
              ],
            },
            null,
          ),
          controller,
        );
        callIndex += 1;
      }
    }
    if (response.usageMetadata !== undefined) usage = geminiUsage(response.usageMetadata);
    const candidates = Array.isArray(response.candidates) ? response.candidates : [];
    const rawFinish = asString(asRecord(candidates[0]).finishReason);
    if (rawFinish.length > 0 && !finished) {
      finished = true;
      const finishReason =
        callIndex > 0 && (rawFinish === "STOP" || rawFinish === "OTHER")
          ? "tool_calls"
          : (FINISH_REASONS[rawFinish] ?? (callIndex > 0 ? "tool_calls" : "stop"));
      emit(
        {
          ...chunk({}, finishReason),
          usage: {
            prompt_tokens: usage.input,
            completion_tokens: usage.output,
            total_tokens: usage.input + usage.output,
          },
        },
        controller,
      );
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(input, controller) {
      buffer += decoder.decode(input, { stream: true });
      const { events, rest } = splitSseEvents(buffer);
      buffer = rest;
      for (const event of events) handle(event, controller);
    },
    flush(controller) {
      buffer += decoder.decode();
      for (const event of splitSseEvents(buffer).events) handle(event, controller);
      if (!finished) {
        const finishReason = callIndex > 0 ? "tool_calls" : "stop";
        emit(
          {
            ...chunk({}, finishReason),
            usage: {
              prompt_tokens: usage.input,
              completion_tokens: usage.output,
              total_tokens: usage.input + usage.output,
            },
          },
          controller,
        );
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      onFinish?.(usage);
    },
  });
}
