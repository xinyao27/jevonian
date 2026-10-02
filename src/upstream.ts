import type { Context } from "hono";

import { proxyNativeCodex, shouldProxyNativeCodex } from "./account";
import {
  anthropicToChat,
  anthropicToChatRequest,
  anthropicToChatStream,
  chatToAnthropic,
  chatToAnthropicMessage,
} from "./anthropic";
import {
  adaptiveEffort,
  anthropicThinkingSupport,
  fitThinkingMaxTokens,
} from "./anthropic-thinking";
import { resolveProviderAuth, withSessionAffinity, type AuthResolution } from "./auth";
import { saveBody } from "./bodies";
import { decodeBody } from "./body-encoding";
import { askJevRaw } from "./brain";
import { effectiveCapabilities, isReasoningEffort, type ReasoningEffort } from "./capabilities";
import { chatToAnthropicStream } from "./chat-anthropic-stream";
import { isClaudeGatewayRequest, resolveClaudeGatewayModel } from "./claude-gateway";
import {
  compact,
  normalizeTranscript,
  reductionRatio,
  reencodeMessages,
  type CompactResult,
  type JevAsker,
  type JevResponse,
} from "./compaction";
import type { Config, Provider } from "./config";
import { findProviderByName } from "./config";
import {
  cursorChatCompletion,
  cursorConversation,
  cursorLastUser,
  cursorToChatStream,
  resolveCursorAgentUrl,
  runCursor,
  type CursorEvent,
  type CursorFinish,
  type CursorStreamError,
} from "./cursor";
import { cursorModelId } from "./cursor-catalog";
import {
  buildDevinChatRequest,
  classifyDevinError,
  devinChatCompletion,
  devinChatUrl,
  devinHeaders,
  devinToChatStream,
  peekDevinStream,
  stripAgentSystemMessages,
  type DevinErrorKind,
  type DevinFinish,
  type DevinStreamError,
} from "./devin";
import {
  chatToGemini,
  geminiChatCompletion,
  geminiEndpoint,
  geminiToChatStream,
  geminiUsage,
  unwrapGemini,
} from "./gemini";
import { appendRecord } from "./ledger";
import { LOCAL_CLIENT_KEYS } from "./local-client";
import { CLAUDE_CODE_SYSTEM_PROMPT, invalidateOAuthToken } from "./oauth";
import { costOf, type Usage } from "./pricing";
import { rewritePromptBodies } from "./prompt-policy";
import {
  captureQuotaHeaders,
  captureUsageLimit,
  isProviderRefusal,
  isRateLimitRefusal,
  markProviderSpent,
  messageSpendSignal,
  providerQuotaHealth,
  PROVIDER_COOLDOWN_MS,
} from "./quota";
import {
  needsReasoningPassback,
  rememberFromChatCompletion,
  repairReasoningContent,
  reasoningCaptureTransform,
} from "./reasoning-passback";
import {
  chatCompletionFrom,
  chatResultFromResponse,
  chatToResponses,
  chatToResponsesStream,
  ensureResponsesCallIds,
  isRemoteCompactionV2,
  repairResponsesOutput,
  responsesErrorMessage,
  responsesPassthroughRepairStream,
  responsesToChatRequest,
  responsesToChatStream,
  responsesUsage,
  splitSseEvents,
} from "./responses";
import {
  configuredRetries,
  describeFailure,
  describeFetchError,
  retryTransient,
  withRetry,
  type RetryAttempt,
  type RetryFailure,
} from "./retry";
import {
  compactionEstimate,
  decideRoute,
  isDesktopRoutedModel,
  phaseOfModel,
  resolveSessionKey,
  type RequestKind,
  type RouteDecision,
  type RouteSkip,
  type SessionStore,
} from "./routing";
import { saveTokens, warnSaverUnavailable } from "./saver";
import type { AppEnv } from "./server";
import { streamWithKeepalive } from "./stream-keepalive";
import {
  beginRoute,
  beginTry,
  endTry,
  finishRoute,
  firstToken,
  noteDecision,
  weigh,
  type TryCause,
} from "./trace";
import {
  normalizeOpenAIMessages,
  planUpstreamWire,
  sanitizeOpenAIChatResponse,
  sanitizeOpenAIChatStream,
  upstreamUrlFor,
} from "./wire";
import { ensureWorkbuddySystem, foldOpenAIChatStream, isWorkbuddyAiSource } from "./workbuddy";

interface RequestMeta {
  id: string;
  session: string;
  path: string;
  provider: string;
  model: string;
  stream: boolean;
  started: number;
  requestedModel?: string;
  phase?: string;
  routed?: boolean;
  reason?: string;
  store?: SessionStore;
  usageKind?: RequestKind;
  cache?: RouteDecision["cache"];
  switchPenaltyUsd?: number | null;
  /** Why the conversation stayed where it was answered, or moved (cache affinity). */
  cacheKeep?: RouteDecision["cacheKeep"];
  brain?: string;
  confidence?: number;
  canonical?: string;
  billing?: "api" | "subscription";
  effort?: string;
  effortNote?: string;
  skipped?: RouteSkip[];
  keyId?: string;
  keyName?: string;
  /** Transient upstream failures that were retried before this turn was recorded. */
  retries?: number;
  /** Estimated prompt tokens the tool-result saver removed before egress. */
  savedTokens?: number;
  /** Trace this turn is being recorded under, so attempts and TTFT land on the ledger row. */
  traceId?: string;
  /** Set once a ledger row is written so cancel cannot double-record a finished turn. */
  recorded?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Non-stream Chat Completions body → Responses API body. Shared by every path that answers a
 * Responses client from a chat-shaped result (OpenAI hosts directly, Anthropic hosts via
 * `anthropicToChat`), so the two cannot drift on ids, tool-call shape, or usage fields.
 */
function chatJsonToResponse(
  chat: Record<string, unknown>,
  context: { model: string; session: string; started: number; usage: Usage },
): Record<string, unknown> {
  const choice = asRecord(asRecord((chat.choices as unknown[])?.[0]).message);
  const toolCalls = Array.isArray(choice.tool_calls) ? choice.tool_calls : [];
  const output: unknown[] = [];
  if (typeof choice.content === "string" && choice.content.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: choice.content }],
    });
  }
  for (const raw of toolCalls) {
    const call = asRecord(raw);
    const fn = asRecord(call.function);
    const callId =
      typeof call.id === "string" && call.id.length > 0
        ? call.id
        : `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    output.push({
      type: "function_call",
      call_id: callId,
      name: asString(fn.name),
      arguments: typeof fn.arguments === "string" ? fn.arguments : "",
    });
  }
  const { usage } = context;
  return {
    id: `resp_${context.session.slice(0, 16)}`,
    object: "response",
    created_at: Math.floor(context.started / 1000),
    status: "completed",
    model: context.model,
    output,
    usage: {
      input_tokens: usage.input,
      output_tokens: usage.output,
      total_tokens: usage.input + usage.output,
      input_tokens_details: { cached_tokens: usage.cacheRead },
    },
  };
}

/**
 * Codex remote compaction v2 only works on a native Responses host (ChatGPT backend).
 * Bridging to Chat Completions returns a normal message item and Codex aborts with
 * "expected exactly one compaction output item, got 0 from N".
 */
function remoteCompactionDecision(
  config: Config,
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
  requestId: string,
): RouteDecision | { error: string; status: number } {
  const providers = config.providers.filter((provider) => provider.type === "responses");
  const preferred =
    providers.find((provider) => provider.oauthSource === "codex") ??
    providers.find((provider) => {
      try {
        return new URL(provider.baseUrl).hostname.includes("chatgpt.com");
      } catch {
        return false;
      }
    }) ??
    providers[0];
  if (!preferred) {
    return {
      error:
        "Remote compaction requires a ChatGPT subscription (Responses) provider. Add chatgpt-subscription under Providers.",
      status: 400,
    };
  }
  const requestedRaw = typeof body.model === "string" ? body.model : "";
  const requested = requestedRaw.replace(/^jevonian\//, "");
  const model = preferred.models.some((entry) => entry.id === requested)
    ? requested
    : preferred.models.find((candidate) => candidate.id.length > 0)?.id;
  if (!model) {
    return {
      error: `Provider "${preferred.name}" has no models configured for remote compaction.`,
      status: 400,
    };
  }
  return {
    model,
    provider: preferred.name,
    phase: phaseOfModel(config, model),
    requestedModel: requestedRaw || model,
    virtual: false,
    routed: true,
    reason: "remote-compaction",
    session: resolveSessionKey(body, headers),
    requestId,
  };
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function openaiUsage(raw: unknown): Usage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  const details = (usage.prompt_tokens_details ?? {}) as Record<string, unknown>;
  return {
    input: number(usage.prompt_tokens),
    output: number(usage.completion_tokens),
    cacheRead: number(details.cached_tokens),
    cacheWrite: 0,
  };
}

function anthropicUsage(raw: unknown): Usage {
  const usage = (raw ?? {}) as Record<string, unknown>;
  return {
    input: number(usage.input_tokens),
    output: number(usage.output_tokens),
    cacheRead: number(usage.cache_read_input_tokens),
    cacheWrite: number(usage.cache_creation_input_tokens),
  };
}

function applyAnthropicEvent(event: Record<string, unknown>, usage: Usage): void {
  if (event.type === "message_start") {
    const message = (event.message ?? {}) as Record<string, unknown>;
    Object.assign(usage, anthropicUsage(message.usage));
    return;
  }
  if (event.type === "message_delta") {
    const delta = (event.usage ?? {}) as Record<string, unknown>;
    const output = number(delta.output_tokens);
    if (output > 0) usage.output = output;
  }
}

function record(
  meta: RequestMeta,
  status: number,
  usage: Usage,
  costUsd: number | null,
  pricingKnown: boolean,
  error?: string,
): void {
  // A canceled stream's transform `cancel` and a racing `flush` must not both write.
  if (meta.recorded) return;
  meta.recorded = true;
  // The trace ends with the turn, so the ledger row can carry the attempt history. A turn
  // that was never traced (a pinned model with no route decision) simply has no trace.
  const trace = meta.traceId
    ? finishRoute(meta.traceId, { status, ...(error ? { error } : {}) })
    : undefined;
  if (meta.store && status >= 200 && status < 300) {
    meta.store.observeCache(meta.session, {
      provider: meta.provider,
      model: meta.model,
      at: Date.now(),
      uncachedInputTokens:
        meta.usageKind === "anthropic" ? usage.input : Math.max(0, usage.input - usage.cacheRead),
      cacheReadTokens: usage.cacheRead,
      cacheWriteTokens: usage.cacheWrite,
      success: true,
    });
  }
  appendRecord({
    id: meta.id,
    ts: new Date().toISOString(),
    session: meta.session,
    path: meta.path,
    provider: meta.provider,
    model: meta.model,
    stream: meta.stream,
    status,
    latencyMs: Date.now() - meta.started,
    promptTokens: usage.input,
    completionTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd,
    pricingKnown,
    ...(meta.keyId ? { keyId: meta.keyId } : {}),
    ...(meta.keyName ? { keyName: meta.keyName } : {}),
    ...(meta.cache ? { cache: meta.cache } : {}),
    ...(meta.cacheKeep ? { cacheKeep: meta.cacheKeep } : {}),
    ...(meta.switchPenaltyUsd === undefined ? {} : { switchPenaltyUsd: meta.switchPenaltyUsd }),
    ...(meta.billing === "subscription" ? { billing: meta.billing } : {}),
    ...(meta.requestedModel ? { requestedModel: meta.requestedModel } : {}),
    ...(meta.phase ? { phase: meta.phase } : {}),
    ...(meta.routed === undefined ? {} : { routed: meta.routed }),
    ...(meta.reason ? { reason: meta.reason } : {}),
    ...(meta.brain ? { brain: meta.brain } : {}),
    ...(meta.confidence === undefined ? {} : { confidence: meta.confidence }),
    ...(meta.canonical ? { canonical: meta.canonical } : {}),
    ...(meta.effort ? { effort: meta.effort } : {}),
    ...(meta.effortNote ? { effortNote: meta.effortNote } : {}),
    ...(meta.skipped && meta.skipped.length > 0 ? { skipped: meta.skipped } : {}),
    ...(meta.retries ? { retries: meta.retries } : {}),
    ...(meta.savedTokens ? { savedTokens: meta.savedTokens } : {}),
    // Only a turn that needed more than one attempt carries the list: a clean turn stays as
    // small as it was, and a row with no field reads as "not recorded", never "0 tries".
    ...(trace && trace.tries.length > 1 ? { tries: trace.tries } : {}),
    ...(trace && trace.failovers > 0 ? { failovers: trace.failovers } : {}),
    ...(trace?.ttftMs === undefined ? {} : { ttftMs: trace.ttftMs }),
    ...(error ? { error } : {}),
  });
}

function decisionMeta(
  decision: RouteDecision,
  path: string,
  stream: boolean,
  started: number,
  id: string,
  keyId?: string,
  keyName?: string,
): RequestMeta {
  return {
    id,
    traceId: id,
    session: decision.session,
    path,
    provider: decision.provider,
    model: decision.model,
    stream,
    started,
    ...(keyId ? { keyId } : {}),
    ...(keyName ? { keyName } : {}),
    requestedModel: decision.requestedModel,
    phase: decision.phase,
    routed: decision.routed,
    reason: decision.reason,
    cache: decision.cache,
    switchPenaltyUsd: decision.switchPenaltyUsd,
    ...(decision.cacheKeep ? { cacheKeep: decision.cacheKeep } : {}),
    ...(decision.brain ? { brain: decision.brain } : {}),
    ...(decision.confidence === undefined ? {} : { confidence: decision.confidence }),
    ...(decision.canonical ? { canonical: decision.canonical } : {}),
    ...(decision.effort ? { effort: decision.effort } : {}),
    ...(decision.effortNote ? { effortNote: decision.effortNote } : {}),
    ...(decision.skipped && decision.skipped.length > 0 ? { skipped: decision.skipped } : {}),
  };
}

function decisionHeaders(decision: RouteDecision, retries = 0): Record<string, string> {
  return {
    "x-jevonian-model": decision.model,
    "x-jevonian-provider": decision.provider,
    "x-jevonian-phase": decision.phase,
    "x-jevonian-session": decision.session,
    "x-jevonian-reason": decision.reason,
    // Correlates a client's own logs with `/logs/:id` and the routing trace for this turn.
    "x-jevonian-request-id": decision.requestId,
    // Reported only when the turn needed one, so a healthy response stays uncluttered.
    ...(retries > 0 ? { "x-jevonian-retries": String(retries) } : {}),
    ...(decision.cache ? { "x-jevonian-cache-state": decision.cache.state } : {}),
    ...(decision.cacheKeep ? { "x-jevonian-cache-keep": decision.cacheKeep } : {}),
    ...(decision.brain ? { "x-jevonian-brain": decision.brain } : {}),
    ...(decision.brainChannel ? { "x-jevonian-brain-channel": decision.brainChannel } : {}),
    ...(decision.canonical ? { "x-jevonian-canonical": decision.canonical } : {}),
    ...(decision.effort ? { "x-jevonian-effort": decision.effort } : {}),
    ...(decision.effortNote ? { "x-jevonian-effort-note": decision.effortNote } : {}),
    // Skipped models are reported one header per model, never dropped silently.
    ...(decision.skipped && decision.skipped.length > 0
      ? { "x-jevonian-skipped": skippedHeader(decision.skipped) }
      : {}),
  };
}

/** One compact line per withheld model: `provider/model=context(...)`. */
function skippedHeader(skipped: RouteSkip[]): string {
  return skipped
    .map((entry) => `${entry.provider}/${entry.model}=${entry.reason}(${entry.detail})`)
    .join("; ");
}

function errorResponse(c: Context, meta: RequestMeta, status: number, message: string): Response {
  record(meta, status, emptyUsage(), null, true, message);
  return c.json({ error: { message, type: "jevonian_error" } }, status as 400);
}

/**
 * An SSE Response that keeps the socket warm during silent thinking and writes a
 * ledger row when the client hangs up before the stream finishes.
 */
function streamResponse(
  stream: ReadableStream<Uint8Array> | null,
  meta: RequestMeta,
  headers: Record<string, string>,
  contentType = "text/event-stream",
  onClientCancel?: () => void,
): Response {
  return new Response(
    streamWithKeepalive(stream, {
      onClientCancel:
        onClientCancel ?? (() => record(meta, 499, emptyUsage(), null, true, "client canceled")),
      // The first real chunk is the first byte a client can render, which is what makes a
      // first-token measurement meaningful. Keepalive comments never reach this callback.
      onFirstChunk: () => {
        if (meta.traceId) firstToken(meta.traceId);
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "no-store",
        ...headers,
      },
    },
  );
}

/** One line describing why an upstream attempt is being repeated. */
function describeRetryFailure(failure: RetryFailure): string {
  return describeFailure(failure);
}

/**
 * POSTs an outgoing body, repeating the call while the failure looks transient.
 *
 * A non-ok body is read as part of the attempt rather than by the caller: an unread body holds
 * the pooled socket the next attempt wants, and reading it here means a retried 502 leaves
 * nothing behind. An ok body is left untouched, because it may be an SSE stream.
 */
async function postUpstream(
  url: string,
  init: RequestInit,
  onRetry: (info: RetryAttempt) => void,
): Promise<{ response: Response; text: string }> {
  const retryBudget = configuredRetries();
  return withRetry(
    async () => {
      const response = await fetch(url, init);
      return { response, text: response.ok ? "" : await response.text() };
    },
    {
      attempts: retryBudget + 1,
      // Only a "the server could not answer" status is repeated here. A 429 is a verdict about
      // quota and belongs to the failover path, which knows how to route the turn elsewhere.
      retryWhen: ({ response }) => retryTransient(response),
      onRetry,
    },
  );
}

/** The result of trying to shrink a body that no configured model could hold. */
type CompactOutcome =
  | { ok: true; body: Record<string, unknown>; stats: CompactResult["stats"] }
  | { ok: false; error: string };

/** A provider's hard context rejection is actionable; other 400s must never rewrite history. */
export function isContextOverflowResponse(status: number, text: string): boolean {
  if (status !== 400 && status !== 413 && status !== 422) return false;
  return /context_length_exceeded|context window|prompt is too long|maximum context length|too many (input )?tokens|input is too long|input tokens exceed/i.test(
    text,
  );
}

/**
 * Shrinks a request body that no model's context window could hold. Compaction drops tool calls
 * and results Jev judges stale and keeps every word of prose verbatim; if the reduction is not
 * worth the churn, the original body is kept rather than sending a mangled history.
 */
async function compactForOverflow(
  config: Config,
  body: Record<string, unknown>,
): Promise<CompactOutcome> {
  const brains = config.routing.brains;
  if (brains.length === 0) return { ok: false, error: "no Jev brain is configured" };
  const messages = normalizeTranscript(body);
  if (messages.length === 0) return { ok: false, error: "the request has no messages to compact" };

  // Compaction asks its own questions, so it needs the raw System One shape rather than the
  // router's model-choice verdict.
  const asker: JevAsker = {
    ask: async (state, questions) => {
      let lastError = "no Jev brain answered";
      for (const brain of brains) {
        try {
          const { answers } = await askJevRaw(
            brain,
            state as unknown as Record<string, unknown>,
            questions,
          );
          return { answers: answers as JevResponse["answers"] };
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
      }
      throw new Error(lastError);
    },
  };

  try {
    const result = await compact(messages, asker, { preserveRecentMessages: 4 });
    if (reductionRatio(result) < 0.05) {
      return {
        ok: false,
        error: `compaction only reduced the history by ${(reductionRatio(result) * 100).toFixed(0)}%`,
      };
    }
    const rewritten = reencodeMessages(body, result.messages);
    if (compactionEstimate(rewritten) > compactionEstimate(body) * 0.9) {
      return { ok: false, error: "compaction did not sufficiently reduce the outgoing request" };
    }
    return { ok: true, body: rewritten, stats: result.stats };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function requestHeaders(c: Context): Record<string, string | undefined> {
  return Object.fromEntries(c.req.raw.headers.entries());
}

/**
 * Writes the router's chosen thinking level into an outgoing body, in the field the target wire
 * expects. A level the client set itself wins: the caller was explicit, and overriding an
 * instruction with a guess is worse than ignoring the router's choice.
 *
 * `none` is expressed as an explicit off rather than by omitting the field, because a model that
 * defaults to thinking would otherwise keep thinking.
 */
export function withEffort(
  body: Record<string, unknown>,
  effort: ReasoningEffort | undefined,
  wire: RequestKind,
  clientEffort?: string,
): Record<string, unknown> {
  const target = stripForeignEffort(body, wire);
  if (wire === "anthropic") {
    // Normalised on every Anthropic body, client-set levels included: newer models answer the
    // legacy shapes with a 400, and a request that cannot be sent is worse than a translated one.
    if (!effort || clientEffort) return normalizeAnthropicThinking(target);
    return anthropicWithEffort(target, effort);
  }
  if (!effort || clientEffort) return target;
  if (wire === "responses") {
    // The Responses wire spells "off" as a null reasoning object.
    if (effort === "none") return { ...target, reasoning: null };
    return { ...target, reasoning: { effort } };
  }
  return { ...target, reasoning_effort: effort };
}

/** The thinking-level field each wire uses. */
const EFFORT_FIELD: Record<RequestKind, string> = {
  anthropic: "thinking",
  openai: "reasoning_effort",
  responses: "reasoning",
};

const EFFORT_FIELDS = Object.values(EFFORT_FIELD);

/**
 * Drops thinking-level fields that do not belong to `wire`.
 *
 * A body can reach us spelled for a different wire than the endpoint it arrived on:
 * Codex sends the Chat Completions `reasoning_effort` on native `/v1/responses`
 * calls for custom model catalogs, and forwarding that spelling to a Responses
 * upstream is rejected outright with "Unsupported parameter: reasoning_effort".
 * Reducing every outgoing body to its own wire's field makes a mislabelled client
 * body routable instead of fatal, and keeps a wire from inheriting a spelling the
 * provider's schema does not have.
 */
export function stripForeignEffort(
  body: Record<string, unknown>,
  wire: RequestKind,
): Record<string, unknown> {
  const keep = EFFORT_FIELD[wire];
  const foreign = EFFORT_FIELDS.filter((field) => field !== keep && body[field] !== undefined);
  if (foreign.length === 0) return body;
  const next = { ...body };
  for (const field of foreign) delete next[field];
  return next;
}

/** Thinking budgets in tokens for the Anthropic wire, by depth. */
const EFFORT_BUDGET: Record<string, number> = {
  minimal: 1_024,
  low: 2_048,
  medium: 8_192,
  high: 16_384,
  xhigh: 24_576,
  max: 32_768,
  ultra: 32_768,
};

function effortBudget(effort: ReasoningEffort): number {
  return EFFORT_BUDGET[effort] ?? 32_768;
}

/**
 * A Chat Completions body (native, or folded from Responses) as an Anthropic Messages body.
 *
 * `chatToAnthropic` has no Chat-side thinking field to carry, so the client's own
 * `reasoning_effort` would be dropped and Claude would run without thinking even when the
 * client asked for `high`. The client's level is therefore applied here as if the router had
 * chosen it — it still wins over the router's choice — and written in the shape the model takes.
 * `max_tokens` is then made consistent with that thinking configuration.
 */
export function bridgedAnthropicBody(
  chatBody: Record<string, unknown>,
  options: {
    model: string;
    stream: boolean;
    effort?: ReasoningEffort;
    clientEffort?: ReasoningEffort;
    maxOutput?: number;
  },
): Record<string, unknown> {
  const base = { ...chatToAnthropic(chatBody), model: options.model, stream: options.stream };
  const effort = options.clientEffort ?? options.effort;
  const max = chatBody.max_completion_tokens ?? chatBody.max_tokens;
  return fitThinkingMaxTokens(withEffort(base, effort, "anthropic"), {
    clientSetMax: typeof max === "number" && max > 0,
    maxOutput: options.maxOutput,
  });
}

/** Writes `output_config.effort`, keeping any other `output_config` keys the body carries. */
function withOutputEffort(body: Record<string, unknown>, effort: string): Record<string, unknown> {
  return { ...body, output_config: { ...asRecord(body.output_config), effort } };
}

/**
 * The router's level in the shape the target Claude model accepts.
 *
 * Legacy models take a token budget. Adaptive models (Claude 4.6+) take
 * `thinking: {type: "adaptive"}` plus `output_config.effort`. "Off" stays an explicit
 * `disabled` where the model allows it, so a model that thinks by default cannot keep thinking
 * silently; always-on models reject `disabled`, so they get the lowest effort instead.
 */
function anthropicWithEffort(
  body: Record<string, unknown>,
  effort: ReasoningEffort,
): Record<string, unknown> {
  const support = anthropicThinkingSupport(body.model);
  if (!support.adaptive) {
    if (effort === "none") return { ...body, thinking: { type: "disabled" } };
    return { ...body, thinking: { type: "enabled", budget_tokens: effortBudget(effort) } };
  }
  if (effort === "none" && !support.rejectsDisabled) {
    return { ...body, thinking: { type: "disabled" } };
  }
  // Keep a client's `display` choice; everything else in `thinking` is the router's to set.
  const display = asRecord(body.thinking).display;
  return withOutputEffort(
    { ...body, thinking: { type: "adaptive", ...(display !== undefined ? { display } : {}) } },
    adaptiveEffort(effort, support),
  );
}

/**
 * Translates thinking shapes the target model rejects — typically sent by a client targeting an
 * older model — into the adaptive equivalent: `disabled` on always-on models becomes the lowest
 * effort, and a `budget_tokens` request on models without extended thinking becomes the nearest
 * effort level. An `output_config.effort` the client already set is kept.
 */
export function normalizeAnthropicThinking(body: Record<string, unknown>): Record<string, unknown> {
  const thinking = asRecord(body.thinking);
  const support = anthropicThinkingSupport(body.model);
  const disabled = thinking.type === "disabled" && support.rejectsDisabled;
  const enabled = thinking.type === "enabled" && support.rejectsEnabled;
  if (!disabled && !enabled) return body;

  const { budget_tokens: budget, type: _type, ...rest } = thinking;
  // `display` is invalid alongside `disabled` but valid with `adaptive`, so keep what remains.
  const next = { ...body, thinking: { ...rest, type: "adaptive" } };
  if (typeof asRecord(body.output_config).effort === "string") return next;
  let level: ReasoningEffort = "low";
  if (enabled && typeof budget === "number") {
    // The shallowest level whose budget covers the request, so thinking is never cut short.
    const match = Object.entries(EFFORT_BUDGET).find(([, tokens]) => tokens >= budget);
    level = match && isReasoningEffort(match[0]) ? match[0] : "max";
  }
  return withOutputEffort(next, adaptiveEffort(level, support));
}

/** Reads an adaptive `output_config.effort` back as a router level, or undefined. */
function adaptiveEffortInBody(
  body: Record<string, unknown>,
  hint?: ReasoningEffort,
): ReasoningEffort | undefined {
  const effort = asRecord(body.output_config).effort;
  if (typeof effort !== "string" || !isReasoningEffort(effort)) return undefined;
  // The router's own level wins when it is what was written (e.g. `minimal` sent as `low`);
  // `none` is excluded, because an always-on model sent `low` really does think.
  if (hint && hint !== "none") {
    const support = anthropicThinkingSupport(body.model);
    if (adaptiveEffort(hint, support) === effort) return hint;
  }
  return effort;
}

/**
 * The thinking level an outgoing body actually carries, read back from whichever field the wire
 * uses. This is what the log reports, so the ledger states the level the model was really sent
 * rather than the level the router meant to send — the two differ when the client set its own
 * level, or when the model takes no level at all.
 *
 * `hint` disambiguates budgets that collide (Anthropic takes tokens, and `max` and `ultra` share
 * a budget), so a level is never reported as a shallower one by accident.
 */
export function effortInBody(
  body: Record<string, unknown>,
  wire: RequestKind,
  hint?: ReasoningEffort,
): ReasoningEffort | undefined {
  if (wire === "anthropic") {
    const thinking = asRecord(body.thinking);
    if (thinking.type === "disabled") return "none";
    const adaptive = adaptiveEffortInBody(body, hint);
    if (adaptive) return adaptive;
    const budget = thinking.budget_tokens;
    if (typeof budget !== "number") return undefined;
    if (hint && EFFORT_BUDGET[hint] === budget) return hint;
    const match = Object.entries(EFFORT_BUDGET).find(([, tokens]) => tokens === budget);
    return match && isReasoningEffort(match[0]) ? match[0] : undefined;
  }
  if (wire === "responses") {
    if (body.reasoning === null) return "none";
    const effort = asRecord(body.reasoning).effort;
    return typeof effort === "string" && isReasoningEffort(effort) ? effort : undefined;
  }
  const effort = body.reasoning_effort;
  return typeof effort === "string" && isReasoningEffort(effort) ? effort : undefined;
}

/**
 * The thinking level the client asked for itself, in whatever field its wire uses. Checked
 * before the router's own choice so an explicit instruction is never overridden — and so the
 * log reports the client's level rather than the one the router would have applied.
 */
export function clientEffortOf(
  body: Record<string, unknown>,
  kind: RequestKind,
): ReasoningEffort | undefined {
  if (kind === "anthropic") {
    const thinking = asRecord(body.thinking);
    if (thinking.type === "disabled") return "none";
    // A client on adaptive thinking states its level in `output_config.effort`.
    const adaptive = adaptiveEffortInBody(body);
    if (adaptive) return adaptive;
    const budget = thinking.budget_tokens;
    if (typeof budget !== "number") return undefined;
    const match = Object.entries(EFFORT_BUDGET).find(([, tokens]) => tokens === budget);
    return match && isReasoningEffort(match[0]) ? match[0] : undefined;
  }
  return effortInBody(body, kind === "responses" ? "responses" : "openai");
}

function applyClaudeCodeSystem(body: Record<string, unknown>): Record<string, unknown> {
  const next = { ...body };
  injectClaudeCodeSystem(next);

  const model = typeof next.model === "string" ? next.model.toLowerCase() : "";
  const support = anthropicThinkingSupport(model);

  if (!support.adaptive) {
    // `context_management` and `output_config` are adaptive-thinking-only; a legacy model
    // rejects them outright.
    delete next.context_management;
    delete next.output_config;
    // An `adaptive` thinking shape (Claude 4.6+) must not reach a legacy model. Keep a
    // legacy-valid `enabled`/`disabled` shape: `withEffort` writes exactly that for these
    // models, and deleting it here — after `withEffort` ran — would silently discard the
    // thinking level the router chose.
    if (asRecord(next.thinking).type === "adaptive") delete next.thinking;

    if (Array.isArray(next.messages)) {
      next.messages = next.messages.map((m: unknown) => {
        if (
          typeof m === "object" &&
          m !== null &&
          (m as Record<string, unknown>).role === "system"
        ) {
          return {
            ...(m as Record<string, unknown>),
            role: "user",
          };
        }
        return m;
      });
    }
  }

  return next;
}

function injectClaudeCodeSystem(body: Record<string, unknown>): void {
  const system = body.system;
  const prompt = { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT };
  if (typeof system === "string") {
    // Native Anthropic clients still send a bare string; mark the user system
    // (or the Claude Code prompt alone) so OAuth turns get the same cache hits.
    body.system =
      system.length > 0
        ? [prompt, { type: "text", text: system, cache_control: { type: "ephemeral" } }]
        : [{ ...prompt, cache_control: { type: "ephemeral" } }];
    return;
  }
  if (Array.isArray(system)) {
    body.system = [prompt, ...system];
    return;
  }
  body.system = [{ ...prompt, cache_control: { type: "ephemeral" } }];
}

/** Anthropic `tools` as Chat Completions function tools. Server tools (no schema) are dropped. */
function anthropicToolsAsChat(body: Record<string, unknown>): Record<string, unknown> {
  const tools = (Array.isArray(body.tools) ? body.tools : []).flatMap((raw) => {
    const tool = asRecord(raw);
    const name = asString(tool.name);
    if (name.length === 0 || typeof tool.input_schema !== "object" || tool.input_schema === null) {
      return [];
    }
    return [
      {
        type: "function",
        function: {
          name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters: tool.input_schema,
        },
      },
    ];
  });
  const choice = asRecord(body.tool_choice);
  const toolChoice =
    choice.type === "any"
      ? "required"
      : choice.type === "none"
        ? "none"
        : choice.type === "tool" && asString(choice.name).length > 0
          ? { type: "function", function: { name: asString(choice.name) } }
          : choice.type === "auto"
            ? "auto"
            : undefined;
  return {
    ...(tools.length > 0 ? { tools } : {}),
    ...(tools.length > 0 && toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
  };
}

class DevinImageError extends Error {}

const DEVIN_INLINE_IMAGE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+$/i;

/** Devin's protobuf encoder accepts image_url parts containing inline base64 data URLs only. */
function devinImageUrl(url: unknown): string {
  const value = typeof url === "string" ? url : asRecord(url).url;
  if (typeof value !== "string" || !DEVIN_INLINE_IMAGE.test(value.replace(/\s/g, ""))) {
    throw new DevinImageError(
      "Devin only supports inline base64 images; remote URLs and file IDs are not supported",
    );
  }
  return value;
}

function devinAnthropicImage(block: Record<string, unknown>): Record<string, unknown> {
  const source = asRecord(block.source);
  if (
    source.type !== "base64" ||
    typeof source.media_type !== "string" ||
    typeof source.data !== "string"
  ) {
    throw new DevinImageError(
      "Devin only supports Anthropic inline base64 image sources, not remote URLs",
    );
  }
  return {
    type: "image_url",
    image_url: { url: devinImageUrl(`data:${source.media_type};base64,${source.data}`) },
  };
}

/** Fold each multimodal block separately: Devin encodes images per turn, not between text spans. */
function devinAnthropicMessages(body: Record<string, unknown>, model: string): unknown[] {
  const base = anthropicToChatRequest(body, model);
  const messages = Array.isArray(base.messages) ? base.messages : [];
  const incoming = Array.isArray(body.messages) ? body.messages : [];
  if (
    !incoming.some(
      (raw) =>
        Array.isArray(asRecord(raw).content) &&
        (asRecord(raw).content as unknown[]).some((block) => {
          const entry = asRecord(block);
          return (
            entry.type === "image" ||
            (entry.type === "tool_result" &&
              Array.isArray(entry.content) &&
              entry.content.some((part) => asRecord(part).type === "image"))
          );
        }),
    )
  ) {
    return messages;
  }
  const system = anthropicToChatRequest({ system: body.system, messages: [] }, model);
  const result: unknown[] = Array.isArray(system.messages) ? [...system.messages] : [];
  for (const raw of incoming) {
    const message = asRecord(raw);
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (!Array.isArray(message.content)) {
      result.push(
        ...(anthropicToChatRequest({ messages: [message] }, model).messages as unknown[]),
      );
      continue;
    }
    for (const rawBlock of message.content) {
      const block = asRecord(rawBlock);
      if (block.type === "image") {
        if (message.role !== "user")
          throw new DevinImageError("Devin only supports images in user messages");
        result.push({ role: "user", content: [devinAnthropicImage(block)] });
      } else if (block.type === "tool_result") {
        const parts = Array.isArray(block.content) ? block.content : [];
        if (parts.some((part) => asRecord(part).type === "image")) {
          throw new DevinImageError("Devin does not support images in Anthropic tool results");
        }
        result.push(
          ...(anthropicToChatRequest({ messages: [{ ...message, content: [block] }] }, model)
            .messages as unknown[]),
        );
      } else {
        result.push(
          ...(anthropicToChatRequest({ messages: [{ ...message, content: [block] }] }, model)
            .messages as unknown[]),
        );
      }
    }
  }
  return result;
}

function devinResponsesMessages(body: Record<string, unknown>, model: string): unknown[] {
  const converted = responsesToChatRequest(body, model);
  const input = Array.isArray(body.input) ? body.input : [];
  const hasImages = input.some(
    (raw) =>
      Array.isArray(asRecord(raw).content) &&
      (asRecord(raw).content as unknown[]).some((part) => asRecord(part).type === "input_image"),
  );
  if (!hasImages) return converted.messages as unknown[];
  const system = responsesToChatRequest({ instructions: body.instructions }, model);
  const messages: unknown[] = Array.isArray(system.messages) ? [...system.messages] : [];
  for (const raw of input) {
    const item = asRecord(raw);
    const content = Array.isArray(item.content) ? item.content : null;
    if (!content || !content.some((part) => asRecord(part).type === "input_image")) {
      messages.push(...(responsesToChatRequest({ input: [raw] }, model).messages as unknown[]));
      continue;
    }
    if (item.role === "assistant" || item.role === "system") {
      throw new DevinImageError("Devin only supports images in user messages");
    }
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (part.type === "input_image") {
        if (part.file_id !== undefined) {
          throw new DevinImageError(
            "Devin does not support Responses image file IDs; supply inline base64 image_url instead",
          );
        }
        messages.push({
          role: "user",
          content: [{ type: "image_url", image_url: { url: devinImageUrl(part.image_url) } }],
        });
      } else {
        messages.push(
          ...(responsesToChatRequest({ input: [{ ...item, content: [rawPart] }] }, model)
            .messages as unknown[]),
        );
      }
    }
  }
  return messages;
}

/** The Chat Completions body Devin's wire module encodes, keeping tools and image block order. */
function devinChatBody(
  body: Record<string, unknown>,
  clientKind: RequestKind,
  model: string,
): Record<string, unknown> {
  if (clientKind === "responses") {
    return {
      ...responsesToChatRequest(body, model),
      messages: devinResponsesMessages(body, model),
      model,
    };
  }
  if (clientKind === "anthropic") {
    return {
      ...anthropicToChatRequest(body, model),
      ...anthropicToolsAsChat(body),
      messages: devinAnthropicMessages(body, model),
      model,
    };
  }
  // The native Chat Completions path can carry image_url parts too; Devin's encoder silently
  // skips non-data URLs, so reject them before the request reaches the wire module.
  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    const message = asRecord(raw);
    const content = Array.isArray(message.content) ? message.content : [];
    for (const rawPart of content) {
      const part = asRecord(rawPart);
      if (part.type === "image_url") devinImageUrl(part.image_url);
    }
  }
  return { ...body, model };
}

/** The Chat Completions body Cursor's wire module encodes, mirroring `devinChatBody`. */
function cursorChatBody(
  body: Record<string, unknown>,
  clientKind: RequestKind,
  model: string,
): Record<string, unknown> {
  if (clientKind === "responses") {
    return {
      ...responsesToChatRequest(body, model),
      messages: devinResponsesMessages(body, model),
      model,
    };
  }
  if (clientKind === "anthropic") {
    return {
      ...anthropicToChatRequest(body, model),
      ...anthropicToolsAsChat(body),
      messages: devinAnthropicMessages(body, model),
      model,
    };
  }
  return { ...body, model };
}

/** Devin usage is exclusive; OpenAI-shaped client payloads expect inclusive prompt counts. */
function inclusiveUsage(usage: Usage): Usage {
  return { ...usage, input: usage.input + usage.cacheRead + usage.cacheWrite };
}

const DEVIN_ERROR_TYPES: Record<DevinErrorKind, string> = {
  quota: "rate_limit_error",
  rate_limit: "rate_limit_error",
  capacity: "overloaded_error",
  internal: "api_error",
  content_policy: "invalid_request_error",
  model_blocked: "invalid_request_error",
  auth: "authentication_error",
  other: "api_error",
};

/**
 * Whether a Devin refusal should send the turn to another provider.
 *
 * A quota or rate-limit verdict obviously should, and so should the ones describing a provider
 * that cannot run this model *now*: a model gated behind a bigger plan, an overloaded backend,
 * an internal fault, or credentials this host will not accept. Every one of those is a fact
 * about Devin, and another provider can usually take the turn. Only a content-policy refusal is
 * left out — that is a judgment about the request text, which is the client's to fix, and
 * re-sending the same prompt elsewhere is not a repair.
 */
function devinShouldFailover(error: DevinStreamError): boolean {
  return error.kind !== "content_policy";
}

/**
 * Records what a Devin refusal means for routing, so the next `decideRoute` walks past it.
 *
 * A quota refusal keeps the provider out until the stated reset, or until a live probe proves
 * the account is alive again. Everything short-lived — a bare rate limit, an overloaded
 * backend, an internal fault, a rejected credential — gets a cooldown instead, because benching
 * any of those indefinitely would take a working subscription out of the pool for a blip. A
 * plan gate is per-model, so it retires just that model and leaves the rest usable.
 */
function markDevinRefusal(provider: Provider, error: DevinStreamError, model: string): void {
  const cooldown = new Date(Date.now() + PROVIDER_COOLDOWN_MS).toISOString();
  // "Reached free model rate limit" caps the free tier only; paid models on the same account
  // keep working, so benching the whole provider would strand them for hours.
  const modelScoped = /\b(?:for this model|for the model|free model rate limit)\b/i.test(
    error.message,
  );
  switch (error.kind) {
    case "quota":
      markProviderSpent(provider, {
        label: "limit",
        ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}),
      });
      return;
    case "rate_limit":
      markProviderSpent(provider, {
        label: "rate-limit",
        resetsAt: error.resetsAt ?? cooldown,
        ...(modelScoped ? { model } : {}),
      });
      return;
    case "model_blocked":
      markProviderSpent(provider, { label: "model-blocked", model, resetsAt: cooldown });
      return;
    case "capacity":
    case "internal":
    case "auth":
      markProviderSpent(provider, { label: error.kind, resetsAt: cooldown });
      return;
    default:
      // `other` and `content_policy` carry no trustworthy verdict about the subscription, so
      // they are failed over (or not) without writing a bench that could outlive the cause.
      return;
  }
}

function devinErrorStatus(error: DevinStreamError): number {
  return error.status >= 400 && error.status <= 599 ? error.status : 502;
}

/** A classified Devin refusal, in the error envelope of the client's own wire. */
function devinErrorResponse(
  meta: RequestMeta,
  clientKind: RequestKind,
  error: DevinStreamError,
  headers: Record<string, string>,
): Response {
  const status = devinErrorStatus(error);
  record(meta, status, emptyUsage(), null, true, `${error.kind}: ${error.message}`.slice(0, 300));
  const type = DEVIN_ERROR_TYPES[error.kind] ?? "api_error";
  const payload =
    clientKind === "anthropic"
      ? { type: "error", error: { type, message: error.message } }
      : { error: { message: error.message, type, code: error.kind } };
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Adds `reasoning_content` as a leading thinking block, which `chatToAnthropicMessage` drops. */
function withThinkingBlock(
  message: Record<string, unknown>,
  completion: Record<string, unknown>,
): Record<string, unknown> {
  const choice = asRecord(asRecord((completion.choices as unknown[])?.[0]).message);
  const thinking = asString(choice.reasoning_content);
  if (thinking.length === 0) return message;
  const content = Array.isArray(message.content) ? message.content : [];
  return { ...message, content: [{ type: "thinking", thinking, signature: "" }, ...content] };
}

/**
 * Answers the client from a Devin stream that already passed the error-trailer peek. Devin
 * always streams upstream; a non-stream client gets the folded completion instead.
 */
type DevinOutcome = { kind: "response"; response: Response } | { kind: "failover" };

async function devinClientResponse(input: {
  c: Context<AppEnv>;
  meta: RequestMeta;
  provider: Provider;
  decision: RouteDecision;
  clientKind: RequestKind;
  clientStream: boolean;
  started: number;
  stream: ReadableStream<Uint8Array>;
  headers: Record<string, string>;
  token?: string;
  /**
   * Called when a non-stream Devin call ends in a refusal, before the error is surfaced.
   * Returning true tells the caller the turn was re-routed, so the error response must not be
   * written; the caller `continue`s the routing loop.
   */
  onFailover?: () => Promise<boolean>;
}): Promise<DevinOutcome> {
  const { c, meta, provider, decision, clientKind, clientStream, started, stream, headers, token } =
    input;
  const model = decision.model;
  const finalize = (finish: DevinFinish | undefined): void => {
    const usage = finish?.usage ?? emptyUsage();
    if (finish?.error) {
      // A streaming answer is already on the wire, so the refusal can only be recorded here.
      // Failover happens on the folded (non-stream) path below, where nothing has been sent.
      if (devinShouldFailover(finish.error)) markDevinRefusal(provider, finish.error, model);
      record(
        meta,
        devinErrorStatus(finish.error),
        usage,
        null,
        true,
        `${finish.error.kind}: ${finish.error.message}`.slice(0, 300),
      );
      return;
    }
    const cost = costOf(model, usage, new Date(), decision.provider, provider.type);
    record(meta, 200, usage, cost.usd, cost.known);
  };

  if (!clientStream) {
    const { completion, finish } = await devinChatCompletion(stream, model, token);
    if (finish.error) {
      if (devinShouldFailover(finish.error)) {
        markDevinRefusal(provider, finish.error, model);
        if (await input.onFailover?.()) {
          // The turn moved to another provider. No ledger row is written for this dead
          // attempt: the loop's next iteration records the turn under the new decision.
          return { kind: "failover" };
        }
      }
      return {
        kind: "response",
        response: devinErrorResponse(meta, clientKind, finish.error, headers),
      };
    }
    finalize(finish);
    if (clientKind === "anthropic") {
      const message = chatToAnthropicMessage(completion, model);
      return {
        kind: "response",
        response: c.json(
          {
            ...withThinkingBlock(message, completion),
            usage: {
              input_tokens: finish.usage.input,
              output_tokens: finish.usage.output,
              cache_read_input_tokens: finish.usage.cacheRead,
              cache_creation_input_tokens: finish.usage.cacheWrite,
            },
          },
          200,
          headers,
        ),
      };
    }
    if (clientKind === "responses") {
      return {
        kind: "response",
        response: c.json(
          chatJsonToResponse(completion, {
            model,
            session: decision.session,
            started,
            usage: inclusiveUsage(finish.usage),
          }),
          200,
          headers,
        ),
      };
    }
    return { kind: "response", response: c.json(completion, 200, headers) };
  }

  let finish: DevinFinish | undefined;
  if (clientKind === "openai") {
    const toChat = devinToChatStream(model, finalize, token);
    return {
      kind: "response",
      response: streamResponse(stream.pipeThrough(toChat), meta, headers),
    };
  }
  const toChat = devinToChatStream(
    model,
    (result) => {
      finish = result;
    },
    token,
  );
  // The ledger row is written after the last stage flushes, from Devin's exclusive usage: the
  // chat hop has no cache-write field, so letting a later stage's usage win would under-bill.
  const next =
    clientKind === "anthropic"
      ? chatToAnthropicStream(model, {
          usage: () => finish?.usage,
          onFinish: () => finalize(finish),
        })
      : chatToResponsesStream(model, () => finalize(finish));
  return {
    kind: "response",
    response: streamResponse(stream.pipeThrough(toChat).pipeThrough(next), meta, headers),
  };
}

const CURSOR_ERROR_TYPES: Record<CursorStreamError["kind"], string> = {
  auth: "authentication_error",
  region: "permission_error",
  quota: "rate_limit_error",
  rate_limit: "rate_limit_error",
  context: "invalid_request_error",
  invalid: "invalid_request_error",
  capacity: "overloaded_error",
  other: "api_error",
};

/**
 * Whether a Cursor refusal should send the turn to another provider. Everything Cursor says
 * about the account or the model right now — a regional block, a quota, an overload, a rejected
 * credential — is a fact another provider can usually take the turn for. Only a malformed
 * request is the client's to fix, so it is not failed over.
 */
function cursorShouldFailover(error: CursorStreamError): boolean {
  return error.kind !== "invalid" && error.kind !== "context";
}

function cursorErrorStatus(error: CursorStreamError): number {
  return error.status >= 400 && error.status <= 599 ? error.status : 502;
}

/** Records what a Cursor refusal means for routing, so the next `decideRoute` walks past it. */
function markCursorRefusal(provider: Provider, error: CursorStreamError): void {
  const cooldown = new Date(Date.now() + PROVIDER_COOLDOWN_MS).toISOString();
  switch (error.kind) {
    case "quota":
    case "rate_limit":
      markProviderSpent(provider, { label: "limit", resetsAt: cooldown });
      return;
    case "region":
      markProviderSpent(provider, { label: "region", resetsAt: cooldown });
      return;
    case "capacity":
    case "other":
      markProviderSpent(provider, { label: error.kind, resetsAt: cooldown });
      return;
    case "auth":
      // The token the keychain or auth.json handed out is rejected: drop the cache so the
      // next resolve re-reads it (and `cursor-agent status` can mint a fresh one).
      invalidateOAuthToken("cursor");
      markProviderSpent(provider, { label: "auth", resetsAt: cooldown });
      return;
    default:
      // `invalid` and `context` carry no verdict about the subscription.
      return;
  }
}

/** A classified Cursor refusal, in the error envelope of the client's own wire. */
function cursorErrorResponse(
  meta: RequestMeta,
  clientKind: RequestKind,
  error: CursorStreamError,
  headers: Record<string, string>,
): Response {
  const status = cursorErrorStatus(error);
  record(meta, status, emptyUsage(), null, true, `${error.kind}: ${error.message}`.slice(0, 300));
  const type = CURSOR_ERROR_TYPES[error.kind] ?? "api_error";
  if (clientKind === "anthropic") {
    return Response.json(
      { type: "error", error: { type, message: error.message } },
      { status, headers },
    );
  }
  if (clientKind === "responses") {
    return Response.json(
      { error: { type, code: error.kind, message: error.message } },
      { status, headers },
    );
  }
  return Response.json(
    { error: { type, code: error.kind, message: error.message } },
    { status, headers },
  );
}

/**
 * Answers the client from a Cursor Run that already produced its first event. Cursor always
 * streams upstream; a non-stream client gets the folded completion instead.
 */
type CursorOutcome = { kind: "response"; response: Response } | { kind: "failover" };

async function cursorClientResponse(input: {
  c: Context<AppEnv>;
  meta: RequestMeta;
  provider: Provider;
  decision: RouteDecision;
  clientKind: RequestKind;
  clientStream: boolean;
  started: number;
  events: AsyncIterable<CursorEvent>;
  headers: Record<string, string>;
  onFailover?: () => Promise<boolean>;
}): Promise<CursorOutcome> {
  const { c, meta, provider, decision, clientKind, clientStream, started, events, headers } = input;
  const model = decision.model;
  const finalize = (finish: CursorFinish | undefined): void => {
    const usage = finish?.usage ?? emptyUsage();
    if (finish?.error) {
      if (cursorShouldFailover(finish.error)) markCursorRefusal(provider, finish.error);
      record(
        meta,
        cursorErrorStatus(finish.error),
        usage,
        null,
        true,
        `${finish.error.kind}: ${finish.error.message}`.slice(0, 300),
      );
      return;
    }
    const cost = costOf(model, usage, new Date(), decision.provider, provider.type);
    record(meta, 200, usage, cost.usd, cost.known);
  };

  if (!clientStream) {
    const { completion, finish } = await cursorChatCompletion(model, events);
    if (finish.error) {
      if (cursorShouldFailover(finish.error)) {
        markCursorRefusal(provider, finish.error);
        if (await input.onFailover?.()) return { kind: "failover" };
      }
      return {
        kind: "response",
        response: cursorErrorResponse(meta, clientKind, finish.error, headers),
      };
    }
    finalize(finish);
    if (clientKind === "anthropic") {
      const message = chatToAnthropicMessage(completion, model);
      return {
        kind: "response",
        response: c.json(
          {
            ...withThinkingBlock(message, completion),
            usage: {
              input_tokens: finish.usage.input,
              output_tokens: finish.usage.output,
              cache_read_input_tokens: finish.usage.cacheRead,
              cache_creation_input_tokens: finish.usage.cacheWrite,
            },
          },
          200,
          headers,
        ),
      };
    }
    if (clientKind === "responses") {
      return {
        kind: "response",
        response: c.json(
          chatJsonToResponse(completion, {
            model,
            session: decision.session,
            started,
            usage: inclusiveUsage(finish.usage),
          }),
          200,
          headers,
        ),
      };
    }
    return { kind: "response", response: c.json(completion, 200, headers) };
  }

  // Stream the answer as Chat Completions, then translate to the client's own wire when it is
  // not OpenAI's.
  if (clientKind === "openai") {
    const toChat = cursorToChatStream(model, events, finalize);
    return { kind: "response", response: streamResponse(toChat, meta, headers) };
  }
  let finish: CursorFinish | undefined;
  const toChat = cursorToChatStream(model, events, (result) => {
    finish = result;
  });
  const next =
    clientKind === "anthropic"
      ? chatToAnthropicStream(model, {
          usage: () => finish?.usage,
          onFinish: () => finalize(finish),
        })
      : chatToResponsesStream(model, () => finalize(finish));
  return {
    kind: "response",
    response: streamResponse(toChat.pipeThrough(next), meta, headers),
  };
}

async function forward(
  c: Context<AppEnv>,
  config: Config,
  store: SessionStore,
  /** The wire the client speaks. The router may still reach the upstream on another one. */
  clientKind: RequestKind,
): Promise<Response> {
  const started = Date.now();
  const endpoint =
    clientKind === "openai"
      ? "/chat/completions"
      : clientKind === "anthropic"
        ? "/messages"
        : "/responses";

  let body: Record<string, unknown>;
  let decodedBytes: Uint8Array;
  try {
    // Codex sends the /v1/responses body zstd-compressed, so the encoding must
    // be decoded before the JSON can be parsed. Reading the raw bytes keeps the
    // original body available for the upstream request.
    const raw = new Uint8Array(await c.req.arrayBuffer());
    decodedBytes = decodeBody(raw, c.req.header("content-encoding"));
    body = JSON.parse(new TextDecoder().decode(decodedBytes)) as Record<string, unknown>;
  } catch {
    return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
  }

  // ChatGPT Desktop dual catalog: native models keep using OpenAI / the
  // ChatGPT subscription. Only `jevonian/*` (and bare `auto`) stay on Jevonian.
  // A caller holding a real Jevonian key is talking to Jevonian, so a concrete
  // model it names (swe-2-max, claude-opus-4-6-thinking, …) is routed locally
  // instead of being forwarded to OpenAI with that key.
  if (clientKind === "responses" || clientKind === "openai") {
    const model = typeof body.model === "string" ? body.model : "";
    const nativeRoute = c.get("jevoKey") ? false : shouldProxyNativeCodex(model, c.req.raw.headers);
    if (nativeRoute) {
      return proxyNativeCodex(c, nativeRoute, decodedBytes);
    }
    if (model && !isDesktopRoutedModel(model)) {
      const auth = c.req.header("authorization") ?? "";
      const token = auth.replace(/^Bearer\s+/i, "").trim();
      if ((LOCAL_CLIENT_KEYS as readonly string[]).includes(token)) {
        return c.json(
          {
            error: {
              message: "OpenAI models require signing in to ChatGPT or adding an OpenAI API key",
              type: "authentication_error",
            },
          },
          401,
        );
      }
    }
  }

  // Claude Desktop can only ask for the Claude ids it knows, so its gateway
  // profile stands in for Jevonian aliases under those ids. Translate back
  // before routing, so the turn is routed like any other Jevonian request.
  if (clientKind === "anthropic") {
    const stand_in = resolveClaudeGatewayModel(
      typeof body.model === "string" ? body.model : "",
      config,
      isClaudeGatewayRequest(c.req.raw.headers),
    );
    if (stand_in) body = { ...body, model: stand_in };
  }

  const clientStream = body.stream === true;
  const requestId = crypto.randomUUID();
  const keyId = c.get("keyId") as string | undefined;
  const keyName = c.get("keyName") as string | undefined;
  const incomingHeaders = requestHeaders(c);
  // The client's own session header, when it sent one. A resolved session key can be a
  // prompt fingerprint the client does not know, so both are kept for lookup.
  const clientSession =
    incomingHeaders["x-session-id"] ??
    incomingHeaders["x-jevonian-session"] ??
    incomingHeaders["x-opencode-session"];
  let decision: RouteDecision;
  {
    // Codex remote compaction must stay on a native Responses (ChatGPT) upstream.
    // Running it through decideRoute / brain can land on OpenRouter etc., and the
    // Chat Completions bridge then synthesizes a message item instead of `compaction`.
    const initial =
      clientKind === "responses" && isRemoteCompactionV2(body)
        ? remoteCompactionDecision(config, body, incomingHeaders, requestId)
        : await decideRoute({
            config,
            body,
            headers: incomingHeaders,
            store,
            kind: clientKind,
            requestId,
            keyId,
            keyName,
          });
    if ("error" in initial) {
      return c.json(
        { error: { message: initial.error, type: "jevonian_error" } },
        (initial.status ?? 400) as 400,
      );
    }
    decision = initial;
  }

  // The trace exists from the first decision on, so a turn is observable before its first
  // byte and a failed attempt is recorded even when the turn never reaches the ledger.
  beginRoute({
    requestId,
    session: decision.session,
    ...(clientSession && clientSession !== decision.session ? { clientSession } : {}),
    ...(keyId ? { keyId } : {}),
    ...(keyName ? { keyName } : {}),
    path: endpoint,
    requestedModel: decision.requestedModel,
    stream: clientStream,
    startedAt: started,
    phase: decision.phase,
    reason: decision.reason,
    ...(decision.cacheKeep ? { cacheKeep: decision.cacheKeep } : {}),
  });
  if (decision.order && decision.order.length > 0) weigh(requestId, decision.order);

  // A conservative token estimate can be a false positive. Try to compact proactively,
  // but if Jev is unavailable or there are no stale tool results, let the provider make the
  // final call instead of rejecting a request that might fit its actual context window.
  if (decision.contextOverflow && !isRemoteCompactionV2(body)) {
    const compacted = await compactForOverflow(config, body);
    if (compacted.ok) {
      const retry = await decideRoute({
        config,
        body: compacted.body,
        headers: incomingHeaders,
        store,
        kind: clientKind,
        requestId,
        keyId,
        keyName,
      });
      if (!("error" in retry)) {
        body = compacted.body;
        decision = retry;
        noteDecision(requestId, {
          phase: retry.phase,
          reason: retry.reason,
          ...(retry.cacheKeep ? { cacheKeep: retry.cacheKeep } : {}),
        });
        if (retry.order && retry.order.length > 0) weigh(requestId, retry.order);
      }
    }
  }

  let quotaFailovers = 0;
  let overflowRetries = 0;
  /** Passes through the routing loop: the count is what distinguishes initial from failover. */
  let attemptCount = 0;
  /**
   * Every provider/model this turn has already tried and been refused by. Failover keeps
   * walking the routing chain until `decideRoute` can only offer a target from this set —
   * which is the point where the client is genuinely out of options and the refusal is
   * worth surfacing. A fixed attempt cap is not enough: a routing chain with five healthy
   * subscriptions would still be cut off after two, and the client would see a rate-limit
   * error while three usable providers sat idle.
   */
  const triedTargets = new Set<string>([`${decision.provider} ${decision.model}`]);
  /**
   * Re-routes the turn after the current provider refused it for quota. Returns true when a
   * provider/model that has not been tried yet took the turn, so the caller should `continue`
   * the loop.
   */
  const quotaFailover = async (): Promise<boolean> => {
    // Remote compaction v2 only ChatGPT's Responses API can answer. Failover onto
    // OpenRouter/DeepSeek would bridge to Chat Completions and Codex would then
    // see "got 0 compaction items" — or our bridge guard. Keep the upstream error.
    if (clientKind === "responses" && isRemoteCompactionV2(body)) return false;
    const next = await decideRoute({
      config,
      body,
      headers: incomingHeaders,
      store,
      kind: clientKind,
      requestId,
    });
    if ("error" in next) return false;
    const target = `${next.provider} ${next.model}`;
    // The router may hand back the target we just gave up on when its own guard cannot see
    // the refusal yet (guard disabled, or a live probe still reporting headroom). Looping on
    // it would burn the turn; treating it as "nothing new" ends the chain honestly.
    if (triedTargets.has(target)) return false;
    triedTargets.add(target);
    decision = { ...next, reason: `${next.reason}:quota-failover` };
    quotaFailovers += 1;
    noteDecision(requestId, {
      phase: decision.phase,
      reason: decision.reason,
      ...(decision.cacheKeep ? { cacheKeep: decision.cacheKeep } : {}),
    });
    if (next.order && next.order.length > 0) weigh(requestId, next.order);
    return true;
  };
  while (true) {
    const meta = decisionMeta(decision, endpoint, clientStream, started, requestId, keyId, keyName);
    const provider: Provider | undefined = findProviderByName(config, decision.provider);
    if (!provider) {
      return errorResponse(c, meta, 404, `Provider "${decision.provider}" is not configured`);
    }
    // Every pass through this loop is one upstream attempt. The first is `initial`; a re-route
    // after a refusal or a context retry is a `failover`, which is what the waterfall draws.
    const attemptCause: TryCause = attemptCount === 0 ? "initial" : "failover";
    // Devin and Cursor can re-route from inside their response helpers, past the explicit
    // `endTry` calls below. Close whatever is still open so no attempt is left dangling;
    // `endTry` is a no-op when the previous attempt was already closed.
    if (attemptCount > 0) endTry(requestId, { fail: "refused" });
    attemptCount += 1;
    beginTry(requestId, {
      provider: decision.provider,
      model: decision.model,
      cause: attemptCause,
      ...(decision.effort ? { effort: decision.effort } : {}),
    });
    meta.store = store;
    meta.billing = provider.billing;

    const translated = provider.type === "responses" && clientKind === "openai";
    const geminiWire = provider.type === "gemini";
    const devinWire = provider.type === "devin";
    const cursorWire = provider.type === "cursor";
    const planned = planUpstreamWire({
      provider,
      client: clientKind,
      model: decision.model,
    });
    if ("error" in planned) {
      return errorResponse(c, meta, 400, planned.error);
    }
    const bridgeToAnthropic = planned.bridge === "to-anthropic";
    const bridgeToOpenAI = planned.bridge === "to-openai";
    if (clientKind === "responses" && isRemoteCompactionV2(body) && provider.type !== "responses") {
      return errorResponse(
        c,
        meta,
        400,
        `Remote compaction requires ChatGPT's Responses API; "${provider.name}" cannot serve it.`,
      );
    }
    let upstreamKind: RequestKind = planned.wire;
    // Devin and Cursor report exclusive usage (uncached input, cache reads, cache writes
    // apart), the same accounting Anthropic uses, so cache observation must not subtract reads
    // from input again.
    meta.usageKind = devinWire || cursorWire ? "anthropic" : upstreamKind;
    // Devin's and Cursor's RPCs only stream; WorkBuddy AI refuses non-stream chats.
    // Non-stream clients get the stream folded into one reply.
    const workbuddyWire = isWorkbuddyAiSource(provider.oauthSource);
    const upstreamStream =
      provider.type === "responses" || devinWire || cursorWire || workbuddyWire
        ? true
        : clientStream;

    let auth = await resolveProviderAuth(provider, upstreamKind, decision.session);
    if (auth.error) return errorResponse(c, meta, 400, auth.error);
    if (devinWire && !auth.token) {
      return errorResponse(c, meta, 400, `Missing Devin token for provider "${provider.name}"`);
    }
    if (cursorWire && !auth.token) {
      return errorResponse(c, meta, 400, `Missing Cursor token for provider "${provider.name}"`);
    }
    withSessionAffinity(auth.headers, provider, decision.session, incomingHeaders);

    saveBody(requestId, {
      kind: "request",
      at: new Date().toISOString(),
      path: endpoint,
      decision: {
        provider: decision.provider,
        model: decision.model,
        requestedModel: decision.requestedModel,
        phase: decision.phase,
        reason: decision.reason,
        cache: decision.cache,
        switchPenaltyUsd: decision.switchPenaltyUsd,
        brain: decision.brain,
        ...(decision.brainChannel ? { brainChannel: decision.brainChannel } : {}),
        ...(decision.canonical ? { canonical: decision.canonical } : {}),
      },
      body,
    });

    const maxOutput = effectiveCapabilities(
      decision.model,
      config.routing.capacities?.[decision.model],
    ).maxOutput;
    const bodyFor = (wire: RequestKind): Record<string, unknown> => {
      // The client's own level, in whatever field its wire uses. Detected per wire so the router
      // never overrides an explicit instruction, and so the log can say who chose the level.
      const clientEffort = clientEffortOf(body, clientKind);
      // Devin and Cursor, like Gemini, win over the OpenAI bridge: their wire modules encode a
      // Chat Completions body into Connect-RPC protobuf, so every client folds onto that body.
      // Effort is part of the model ids for both, so no effort field is written.
      if (devinWire) return devinChatBody(body, clientKind, decision.model);
      if (cursorWire) return cursorChatBody(body, clientKind, decision.model);
      if (wire === "anthropic" && bridgeToAnthropic) {
        // Responses clients fold through Chat Completions first (same two-hop as
        // Responses→Antigravity), then chatToAnthropic builds the Messages body.
        const chatBody =
          clientKind === "responses" ? responsesToChatRequest(body, decision.model) : body;
        return bridgedAnthropicBody(chatBody, {
          model: decision.model,
          stream: upstreamStream,
          effort: decision.effort,
          clientEffort,
          maxOutput,
        });
      }
      // Gemini must win over the OpenAI bridge: planUpstreamWire sets wire=openai +
      // bridge=to-openai for Responses→Antigravity so the body can be folded through
      // Chat Completions first, but the egress envelope is still Gemini (`contents`,
      // not `messages`). Returning the bridged chat body here used to POST OpenAI JSON
      // at generateContent and get INVALID_ARGUMENT Unknown name "messages".
      if (geminiWire) {
        const chatBody =
          clientKind === "responses"
            ? responsesToChatRequest(body, decision.model)
            : clientKind === "anthropic"
              ? anthropicToChatRequest(body, decision.model)
              : {
                  ...body,
                  messages: normalizeOpenAIMessages(
                    (Array.isArray(body.messages) ? body.messages : []) as Record<
                      string,
                      unknown
                    >[],
                  ),
                };
        return {
          project: auth.project ?? "default-cli-project",
          model: decision.model,
          userAgent: "antigravity",
          requestId: crypto.randomUUID(),
          request: chatToGemini(chatBody),
        };
      }
      if (wire === "openai" && bridgeToOpenAI) {
        if (clientKind === "responses") {
          return withEffort(
            {
              ...responsesToChatRequest(body, decision.model),
              stream: upstreamStream,
            },
            decision.effort,
            "openai",
            clientEffort,
          );
        }
        return withEffort(
          {
            ...anthropicToChatRequest(body, decision.model),
            // Reply is folded into one Anthropic message; an SSE dialect bridge is not wired yet.
            stream: false,
          },
          decision.effort,
          "openai",
          clientEffort,
        );
      }
      if (translated) {
        return withEffort(
          chatToResponses(body, decision.model),
          decision.effort,
          "responses",
          clientEffort,
        );
      }
      const native = withEffort(
        { ...body, model: decision.model },
        decision.effort,
        // The body is already in the client's own shape here, so the effort field
        // must use that wire's spelling. Mapping everything non-Anthropic to
        // "openai" wrote `reasoning_effort` into a native Responses body, which
        // the upstream rejects with "Unsupported parameter: reasoning_effort".
        wire,
        clientEffort,
      );
      // A router-written budget can exceed the client's own `max_tokens`, which Anthropic rejects.
      return wire === "anthropic"
        ? fitThinkingMaxTokens(native, { clientSetMax: true, maxOutput })
        : native;
    };

    let upstreamBody: Record<string, unknown>;
    try {
      upstreamBody = bodyFor(upstreamKind);
    } catch (error) {
      if (error instanceof DevinImageError) {
        record(meta, 400, emptyUsage(), null, true, error.message);
        const payload =
          clientKind === "anthropic"
            ? { type: "error", error: { type: "invalid_request_error", message: error.message } }
            : { error: { type: "invalid_request_error", message: error.message } };
        return c.json(payload, 400);
      }
      throw error;
    }
    // OpenAI Responses rejects empty call_id / name (minLength 1) and call_id
    // longer than 64 chars. Sanitize before egress — Cursor / bridged history
    // can leave "" or oversized ids on function_call(_output) items.
    if (upstreamKind === "responses") {
      upstreamBody = ensureResponsesCallIds(upstreamBody);
    }
    // Prompt hygiene runs last, so every wire's own assembly (the Chat fold, the Anthropic
    // bridge) sees the rewritten text. The Devin wire applies its built-ins again while
    // encoding; both passes are idempotent.
    upstreamBody = rewritePromptBodies(upstreamBody, config.promptPolicy);

    // OpenAI Chat Completions sanitizer: normalize Anthropic-style blocks (tool_use / tool_result)
    // inside `content` array into standard OpenAI tool_calls and tool messages.
    // Also sanitizes invalid array items that cause strict backends (e.g. Alibaba Cloud Model Studio)
    // to fail with "if content is list. item must be dict and key[type] should in dict".
    if (upstreamKind === "openai" && Array.isArray(upstreamBody.messages)) {
      upstreamBody.messages = normalizeOpenAIMessages(
        upstreamBody.messages as Record<string, unknown>[],
      );
    }

    // The token saver compresses prior tool results on the fully assembled upstream body, so
    // whichever wire the turn took — chat, Anthropic, Responses, or the Devin fold — gets the
    // same `rtk` filtering. The estimate lands on the ledger row written by `record`.
    if (config.tokenSaver.enabled) {
      const saved = await saveTokens(upstreamBody, config.tokenSaver);
      warnSaverUnavailable(config.tokenSaver, saved.stats.unavailable === true);
      if (saved.stats.savedTokens > 0) {
        upstreamBody = saved.body;
        meta.savedTokens = saved.stats.savedTokens;
      }
    }
    // DeepSeek / Kimi thinking mode: clients often drop `reasoning_content` after
    // tool calls. Restore it from the previous upstream response before egress.
    const passbackReasoning =
      upstreamKind === "openai" &&
      !devinWire &&
      needsReasoningPassback(decision.provider, decision.model, provider.baseUrl);
    if (passbackReasoning) {
      upstreamBody = repairReasoningContent(upstreamBody, decision.session).body;
    }
    const passbackMessages = Array.isArray(upstreamBody.messages)
      ? (upstreamBody.messages as Record<string, unknown>[])
      : [];

    // The log reports the level the model was actually sent, read back from the body rather than
    // from the router's intent: those differ when the client set its own level. `gemini` takes no
    // effort field and Devin / Cursor bake effort into their model ids, so nothing is recorded.
    const sentEffort =
      geminiWire || devinWire || cursorWire
        ? undefined
        : effortInBody(upstreamBody, upstreamKind, decision.effort);
    meta.effort = sentEffort;
    if (decision.effort && sentEffort && sentEffort !== decision.effort) {
      // The body carries a different level than the router chose — the client overrode it, and
      // the log should say so rather than silently disagreeing with the router's own choice.
      meta.effortNote = `client set "${sentEffort}"; router chose "${decision.effort}"`;
    } else if (decision.effortNote) {
      meta.effortNote = decision.effortNote;
    }

    if (provider.type === "responses") {
      upstreamBody.stream = upstreamStream;
      if (provider.auth === "oauth") upstreamBody.store = false;
    }
    if (workbuddyWire) {
      upstreamBody.stream = true;
    }
    if (
      clientKind === "openai" &&
      provider.type === "openai" &&
      clientStream &&
      provider.injectStreamUsage &&
      upstreamBody.stream_options === undefined
    ) {
      upstreamBody.stream_options = { include_usage: true };
    }

    const urlFor = (wire: RequestKind): string =>
      geminiWire
        ? geminiEndpoint(provider.baseUrl, upstreamStream)
        : upstreamUrlFor(provider, wire);
    // The Claude Code system prompt belongs to the Anthropic wire only.
    // WorkBuddy AI requires a leading system message on Chat Completions.
    const payloadFor = (wire: RequestKind): Record<string, unknown> => {
      const payload = wire === upstreamKind ? upstreamBody : bodyFor(wire);
      if (wire === "anthropic" && provider.auth === "oauth") return applyClaudeCodeSystem(payload);
      if (wire === "openai" && workbuddyWire) return ensureWorkbuddySystem(payload);
      return payload;
    };
    const upstreamUrl = devinWire ? devinChatUrl(provider.baseUrl) : urlFor(upstreamKind);
    // Built once per wire, not per attempt: a retry repeats the same bytes, which is the whole
    // point of retrying a POST that failed on the network.
    const payload = devinWire ? "" : JSON.stringify(payloadFor(upstreamKind));
    // Devin carries its session token inside the protobuf body, so its request is rebuilt when
    // a 401 forces a fresh token; everything else only swaps headers.
    const requestInit = (current: AuthResolution): RequestInit => {
      if (!devinWire) return { method: "POST", headers: current.headers, body: payload };
      const token = current.token ?? "";
      return {
        method: "POST",
        headers: devinHeaders(token, "stream"),
        body: buildDevinChatRequest(token, upstreamBody, decision.model, {
          // Stable per conversation, so Devin's prompt cache keeps hitting across turns.
          sessionId: decision.session,
          ...(maxOutput ? { maxOutput } : {}),
          builtins: config.promptPolicy.builtins,
        }) as Uint8Array<ArrayBuffer>,
      };
    };

    // A Cursor turn is a Connect stream that stays open both ways, so it is driven here rather
    // than through the shared POST path: the request body is built per attempt and the reply is
    // folded or relayed by `cursorClientResponse`.
    if (cursorWire) {
      const conversation = cursorConversation(upstreamBody);
      const attempt = await runCursor({
        token: auth.token ?? "",
        agentUrl: await resolveCursorAgentUrl(auth.token ?? "", provider.baseUrl),
        systemPrompt: conversation.system,
        messages: conversation.messages,
        tools: conversation.tools,
        model: cursorModelId(decision.model, decision.effort, false),
        lastUser: cursorLastUser(conversation.messages),
        requestId: crypto.randomUUID(),
      });
      if (attempt.error) {
        const refused = cursorShouldFailover(attempt.error);
        endTry(requestId, {
          status: cursorErrorStatus(attempt.error),
          fail: refused ? attempt.error.kind : `http-${cursorErrorStatus(attempt.error)}`,
        });
        if (refused) {
          markCursorRefusal(provider, attempt.error);
          if (await quotaFailover()) continue;
        }
        return cursorErrorResponse(meta, clientKind, attempt.error, {
          ...decisionHeaders(decision, meta.retries),
          ...(quotaFailovers > 0 ? { "x-jevonian-quota-failovers": String(quotaFailovers) } : {}),
        });
      }
      const delivered = await cursorClientResponse({
        c,
        meta,
        provider,
        decision,
        clientKind,
        clientStream,
        started,
        events: attempt.events,
        onFailover: quotaFailover,
        headers: {
          ...decisionHeaders(decision, meta.retries),
          ...(quotaFailovers > 0 ? { "x-jevonian-quota-failovers": String(quotaFailovers) } : {}),
        },
      });
      if (delivered.kind === "failover") continue;
      return delivered.response;
    }

    // A socket reset from a local proxy, a DNS timeout, or a gateway's brief 502 otherwise
    // costs the whole turn — and the same request almost always succeeds on a second attempt.
    // Every retry is counted onto the turn's ledger record, so a flaky network stays visible
    // instead of being laundered into an apparent success.
    const retryBudget = configuredRetries();
    const onRetry = ({ attempt, delayMs, failure }: RetryAttempt): void => {
      meta.retries = (meta.retries ?? 0) + 1;
      // The attempt that just failed is closed here, and the retry that follows is opened as
      // its own try, so the waterfall shows the transient failure rather than hiding it.
      endTry(requestId, { fail: describeRetryFailure(failure) });
      beginTry(requestId, {
        provider: decision.provider,
        model: decision.model,
        cause: "retry",
        ...(decision.effort ? { effort: decision.effort } : {}),
      });
      console.warn(
        `upstream retry ${attempt}/${retryBudget} for ${decision.provider} in ${delayMs}ms: ${describeRetryFailure(failure)}`,
      );
    };

    let upstream: Response;
    let failureText = "";
    try {
      ({ response: upstream, text: failureText } = await postUpstream(
        upstreamUrl,
        requestInit(auth),
        onRetry,
      ));
      if (
        upstream.status === 401 &&
        provider.auth === "oauth" &&
        provider.oauthSource &&
        provider.oauthSource !== "static"
      ) {
        invalidateOAuthToken(provider.oauthSource, provider.login);
        const refreshed = await resolveProviderAuth(provider, upstreamKind, decision.session);
        if (!refreshed.error) {
          auth = refreshed;
          ({ response: upstream, text: failureText } = await postUpstream(
            upstreamUrl,
            requestInit(auth),
            onRetry,
          ));
        }
      }
    } catch (error) {
      endTry(requestId, { fail: `fetch: ${describeFetchError(error)}`.slice(0, 120) });
      return errorResponse(c, meta, 502, `Upstream request failed: ${describeFetchError(error)}`);
    }

    captureQuotaHeaders(provider, upstream.headers);

    if (devinWire) {
      // Devin refuses in two ways: a non-200 status, or a 200 whose Connect stream opens with an
      // end-of-stream error trailer before any data. Both classify into one error, so quota
      // failover and the client-facing error share one path.
      let failure: DevinStreamError | undefined;
      let stream: ReadableStream<Uint8Array> | undefined;
      let policyRetried = false;
      if (!upstream.ok) {
        failure = classifyDevinError(upstream.status, failureText, auth.token);
      } else if (!upstream.body) {
        failure = { status: 502, kind: "other", message: "Devin returned an empty response body" };
      } else {
        const peeked = await peekDevinStream(upstream.body, auth.token);
        if ("error" in peeked) failure = peeked.error;
        else stream = peeked.stream;
      }
      // The wire neutralizes the prompt signatures we know about, but that list trails the
      // client. One retry without the client's system prompt clears wording we have not seen.
      if (failure?.kind === "content_policy" && !policyRetried) {
        policyRetried = true;
        upstreamBody = {
          ...upstreamBody,
          messages: stripAgentSystemMessages(
            Array.isArray(upstreamBody.messages) ? upstreamBody.messages : [],
          ),
        };
        meta.retries = (meta.retries ?? 0) + 1;
        console.warn(
          `devin content policy: retrying ${decision.provider}/${decision.model} without the client system prompt`,
        );
        try {
          ({ response: upstream, text: failureText } = await postUpstream(
            upstreamUrl,
            requestInit(auth),
            onRetry,
          ));
          failure = undefined;
          stream = undefined;
          if (!upstream.ok) {
            failure = classifyDevinError(upstream.status, failureText, auth.token);
          } else if (!upstream.body) {
            failure = {
              status: 502,
              kind: "other",
              message: "Devin returned an empty response body",
            };
          } else {
            const peeked = await peekDevinStream(upstream.body, auth.token);
            if ("error" in peeked) failure = peeked.error;
            else stream = peeked.stream;
          }
        } catch (error) {
          failure = {
            status: 502,
            kind: "other",
            message: `Upstream retry failed: ${describeFetchError(error)}`,
          };
        }
      }
      if (failure || !stream) {
        const error = failure ?? {
          status: 502,
          kind: "other" as const,
          message: "Devin returned no stream",
        };
        const refused = devinShouldFailover(error);
        endTry(requestId, {
          status: devinErrorStatus(error),
          fail: refused ? error.kind : `http-${devinErrorStatus(error)}`,
        });
        if (refused) {
          markDevinRefusal(provider, error, decision.model);
          if (await quotaFailover()) continue;
        }
        return devinErrorResponse(meta, clientKind, error, {
          ...decisionHeaders(decision, meta.retries),
          ...(quotaFailovers > 0 ? { "x-jevonian-quota-failovers": String(quotaFailovers) } : {}),
        });
      }
      const delivered = await devinClientResponse({
        c,
        meta,
        provider,
        decision,
        clientKind,
        clientStream,
        started,
        stream,
        token: auth.token,
        onFailover: quotaFailover,
        headers: {
          ...decisionHeaders(decision, meta.retries),
          ...(quotaFailovers > 0 ? { "x-jevonian-quota-failovers": String(quotaFailovers) } : {}),
        },
      });
      // A non-stream Devin call that was refused mid-answer is re-routed rather than returned,
      // so the client only sees an error once no alternative is left.
      if (delivered.kind === "failover") continue;
      return delivered.response;
    }

    if (!upstream.ok) {
      // Read during the attempt, not here: a body left unread would hold the pooled socket
      // that the next retry needs, and the last attempt's text is what gets reported.
      const text = failureText;
      if (
        overflowRetries === 0 &&
        !isRemoteCompactionV2(body) &&
        isContextOverflowResponse(upstream.status, text)
      ) {
        overflowRetries += 1;
        const shrunk = await compactForOverflow(config, body);
        if (shrunk.ok) {
          const retry = await decideRoute({
            config,
            body: shrunk.body,
            headers: incomingHeaders,
            store,
            kind: clientKind,
            requestId,
            keyId,
            keyName,
          });
          if (!("error" in retry)) {
            body = shrunk.body;
            decision = { ...retry, reason: `${retry.reason}:context-retry` };
            endTry(requestId, { status: upstream.status, fail: "context-overflow" });
            noteDecision(requestId, {
              phase: decision.phase,
              reason: decision.reason,
              ...(decision.cacheKeep ? { cacheKeep: decision.cacheKeep } : {}),
            });
            if (retry.order && retry.order.length > 0) weigh(requestId, retry.order);
            continue;
          }
        }
      }
      // Structured spend tokens (usage_limit_reached, GoUsageLimitError, …) mark the
      // provider exhausted. Claude subscription 429s usually only emit
      // `type: rate_limit_error` — not in that allow-list — but the unified rate-limit
      // headers on the same response already say the window is spent. After capturing
      // those headers, treat an exhausted health bit as the same failover trigger so
      // the next model in the phase chain (gpt-6-astra, …) gets the turn.
      const spent = captureUsageLimit(provider, upstream.status, text);
      // The response's own rate-limit headers may already have recorded the real window
      // (`5h` rejected, with its reset) a few lines above. That reading beats a synthetic
      // cooldown, so it is checked before one is invented.
      const exhausted = providerQuotaHealth(provider).status === "exhausted";
      // Beyond the allow-list: any provider-side refusal is worth trying elsewhere. The
      // client only sees an error once `quotaFailover` reports that no target outside
      // `triedTargets` is left, which is the honest "you really are out" signal.
      const refused = spent || exhausted || isProviderRefusal(upstream.status);
      if (refused && !spent && !exhausted && isRateLimitRefusal(upstream.status)) {
        // Nothing recorded this refusal, so bench the provider briefly: without it the next
        // turn's routing brain would pick the same host straight back up.
        markProviderSpent(provider, {
          label: "rate-limit",
          resetsAt: new Date(Date.now() + PROVIDER_COOLDOWN_MS).toISOString(),
        });
      }
      if (refused && (await quotaFailover())) {
        endTry(requestId, {
          status: upstream.status,
          fail: spent || exhausted ? "quota" : `http-${upstream.status}`,
        });
        continue;
      }
      endTry(requestId, { status: upstream.status, fail: `http-${upstream.status}` });
      record(meta, upstream.status, emptyUsage(), null, true, text.slice(0, 300));
      return new Response(text, {
        status: upstream.status,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "application/json",
          ...decisionHeaders(decision, meta.retries),
          ...(quotaFailovers > 0 ? { "x-jevonian-quota-failovers": String(quotaFailovers) } : {}),
        },
      });
    }

    // Follow the wire the upstream actually answered on. `bridgeToAnthropic` covers
    // both dual-wire hosts (Claude on OpenCode) and Anthropic-only OAuth subscriptions.
    // Responses clients take a second hop: Anthropic → Chat Completions → Responses.
    if (
      upstreamKind === "anthropic" &&
      bridgeToAnthropic &&
      (clientKind === "openai" || clientKind === "responses")
    ) {
      if (clientKind === "responses") {
        if (!upstreamStream) {
          const json = (await upstream.json()) as Record<string, unknown>;
          const usage = anthropicUsage(json.usage);
          const cost = costOf(decision.model, usage, new Date(), decision.provider);
          record(meta, 200, usage, cost.usd, cost.known);
          return c.json(
            chatJsonToResponse(anthropicToChat(json, decision.model), {
              model: decision.model,
              session: decision.session,
              started,
              usage,
            }),
            200,
            decisionHeaders(decision, meta.retries),
          );
        }
        // Usage is Anthropic's, captured by the first stage: the Chat hop has no cache-write
        // field, so letting the Responses stage's usage win zeroed cacheRead/cacheWrite and
        // under-billed cached turns. Recorded once, after the last stage flushes.
        const usage = emptyUsage();
        const toChat = anthropicToChatStream(decision.model, (finalUsage) => {
          Object.assign(usage, finalUsage);
        });
        const toResponses = chatToResponsesStream(decision.model, () => {
          const cost = costOf(decision.model, usage, new Date(), decision.provider);
          record(meta, 200, usage, cost.usd, cost.known);
        });
        const streamBody = upstream.body?.pipeThrough(toChat).pipeThrough(toResponses) ?? null;
        return streamResponse(streamBody, meta, decisionHeaders(decision, meta.retries));
      }
      if (!upstreamStream) {
        const json = (await upstream.json()) as Record<string, unknown>;
        const usage = anthropicUsage(json.usage);
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
        return c.json(
          anthropicToChat(json, decision.model),
          200,
          decisionHeaders(decision, meta.retries),
        );
      }
      const usage = emptyUsage();
      const transform = anthropicToChatStream(decision.model, (finalUsage) => {
        Object.assign(usage, finalUsage);
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
      });
      return streamResponse(
        upstream.body?.pipeThrough(transform) ?? null,
        meta,
        decisionHeaders(decision, meta.retries),
        "text/event-stream",
        () => {
          if (usage.output > 0 || usage.input > 0) {
            const cost = costOf(decision.model, usage, new Date(), decision.provider);
            record(meta, 200, usage, cost.usd, cost.known);
          } else {
            record(meta, 499, emptyUsage(), null, true, "client canceled");
          }
        },
      );
    }

    // Gemini must win over the OpenAI bridge on the way back too. planUpstreamWire
    // labels Antigravity as wire=openai + bridge=to-openai for Responses clients, but
    // the upstream still answers in Gemini shape. Parsing that as Chat Completions
    // yields empty `output: []` / a lone response.completed — Codex then shows "done"
    // with no assistant text.
    if (geminiWire) {
      if (clientKind === "responses") {
        // Antigravity answers in Gemini shape; fold to chat then to Responses SSE/JSON.
        if (!upstreamStream) {
          const json = (await upstream.json()) as Record<string, unknown>;
          const response = unwrapGemini(json);
          const chat = geminiChatCompletion(response, decision.model);
          const usage = geminiUsage(response.usageMetadata);
          const cost = costOf(decision.model, usage, new Date(), decision.provider);
          record(meta, 200, usage, cost.usd, cost.known);
          const choice = asRecord(asRecord((chat.choices as unknown[])?.[0]).message);
          return c.json(
            {
              id: `resp_${decision.session.slice(0, 16)}`,
              object: "response",
              created_at: Math.floor(started / 1000),
              status: "completed",
              model: decision.model,
              output: [
                {
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: asString(choice.content) }],
                },
              ],
              usage: {
                input_tokens: usage.input,
                output_tokens: usage.output,
                total_tokens: usage.input + usage.output,
              },
            },
            200,
            decisionHeaders(decision, meta.retries),
          );
        }
        // Stream Gemini → chat SSE → Responses SSE.
        const usage = emptyUsage();
        const toChat = geminiToChatStream(decision.model, (finalUsage) => {
          Object.assign(usage, finalUsage);
        });
        const toResponses = chatToResponsesStream(decision.model, (result) => {
          Object.assign(usage, result.usage);
          const cost = costOf(decision.model, usage, new Date(), decision.provider);
          record(meta, 200, usage, cost.usd, cost.known);
        });
        const body = upstream.body?.pipeThrough(toChat).pipeThrough(toResponses) ?? null;
        return streamResponse(body, meta, decisionHeaders(decision, meta.retries));
      }
      if (!upstreamStream) {
        const json = (await upstream.json()) as Record<string, unknown>;
        const response = unwrapGemini(json);
        const usage = geminiUsage(response.usageMetadata);
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
        return c.json(
          geminiChatCompletion(response, decision.model),
          200,
          decisionHeaders(decision, meta.retries),
        );
      }
      const usage = emptyUsage();
      const transform = geminiToChatStream(decision.model, (finalUsage) => {
        Object.assign(usage, finalUsage);
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
      });
      return streamResponse(
        upstream.body?.pipeThrough(transform) ?? null,
        meta,
        decisionHeaders(decision, meta.retries),
        "text/event-stream",
        () => {
          if (usage.output > 0 || usage.input > 0) {
            const cost = costOf(decision.model, usage, new Date(), decision.provider);
            record(meta, 200, usage, cost.usd, cost.known);
          } else {
            record(meta, 499, emptyUsage(), null, true, "client canceled");
          }
        },
      );
    }

    if (upstreamKind === "openai" && bridgeToOpenAI) {
      if (clientKind === "responses") {
        if (clientStream) {
          const usage = emptyUsage();
          const transform = chatToResponsesStream(decision.model, (result) => {
            Object.assign(usage, result.usage);
            const cost = costOf(decision.model, usage, new Date(), decision.provider);
            record(meta, 200, usage, cost.usd, cost.known);
          });
          return streamResponse(
            upstream.body?.pipeThrough(transform) ?? null,
            meta,
            decisionHeaders(decision, meta.retries),
            "text/event-stream",
            () => {
              if (usage.output > 0 || usage.input > 0) {
                const cost = costOf(decision.model, usage, new Date(), decision.provider);
                record(meta, 200, usage, cost.usd, cost.known);
              } else {
                record(meta, 499, emptyUsage(), null, true, "client canceled");
              }
            },
          );
        }
        const json = (await upstream.json()) as Record<string, unknown>;
        const usage = openaiUsage(json.usage);
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
        return c.json(
          chatJsonToResponse(json, {
            model: decision.model,
            session: decision.session,
            started,
            usage,
          }),
          200,
          decisionHeaders(decision, meta.retries),
        );
      }
      const json = (await upstream.json()) as Record<string, unknown>;
      const usage = openaiUsage(json.usage);
      const cost = costOf(decision.model, usage, new Date(), decision.provider);
      record(meta, 200, usage, cost.usd, cost.known);
      return c.json(
        chatToAnthropicMessage(json, decision.model),
        200,
        decisionHeaders(decision, meta.retries),
      );
    }

    if (!upstreamStream && upstreamKind !== "responses") {
      let json = (await upstream.json()) as Record<string, unknown>;
      if (passbackReasoning && clientKind === "openai") {
        rememberFromChatCompletion(json, passbackMessages, decision.session);
      }
      if (clientKind === "openai") {
        json = sanitizeOpenAIChatResponse(json);
      }
      const usage = clientKind === "openai" ? openaiUsage(json.usage) : anthropicUsage(json.usage);
      const cost = costOf(decision.model, usage, new Date(), decision.provider);
      record(meta, 200, usage, cost.usd, cost.known);
      return c.json(json, 200, decisionHeaders(decision, meta.retries));
    }

    // WorkBuddy forces upstream streaming; fold SSE → JSON for non-stream OpenAI clients.
    if (workbuddyWire && upstreamStream && !clientStream && upstreamKind === "openai") {
      const json = await foldOpenAIChatStream(upstream.body, decision.model);
      const sanitized = sanitizeOpenAIChatResponse(json);
      if (passbackReasoning) {
        rememberFromChatCompletion(sanitized, passbackMessages, decision.session);
      }
      const usage = openaiUsage(sanitized.usage);
      const cost = costOf(decision.model, usage, new Date(), decision.provider);
      record(meta, 200, usage, cost.usd, cost.known);
      return c.json(sanitized, 200, decisionHeaders(decision, meta.retries));
    }

    if (upstreamKind === "responses") {
      if (translated) {
        if (clientStream) {
          const transform = responsesToChatStream(decision.model, (result) => {
            if (result.failure) {
              record(meta, 502, result.usage, null, true, result.failure);
              return;
            }
            const cost = costOf(decision.model, result.usage, new Date(), decision.provider);
            record(meta, 200, result.usage, cost.usd, cost.known);
          });
          return streamResponse(
            upstream.body?.pipeThrough(transform) ?? null,
            meta,
            decisionHeaders(decision, meta.retries),
          );
        }
        const text = await upstream.text();
        const { events } = splitSseEvents(text);
        const completed = [...events]
          .reverse()
          .find((event) => event.type === "response.completed");
        const failure = responsesErrorMessage(events);
        if (!completed || failure) {
          const message = failure ?? "upstream stream ended before completion";
          // The folded stream carries a `response.failed` rather than an HTTP error, so the
          // refusal hides inside a 200. Read it like the body it is: a quota verdict still
          // fails the provider over, while a truncation is surfaced as before.
          if (messageSpendSignal(message)) {
            markProviderSpent(provider, { label: "limit" });
            if (await quotaFailover()) continue;
          }
          record(meta, 502, emptyUsage(), null, true, message);
          return c.json({ error: { message, type: "jevonian_error" } }, 502);
        }
        const response = asRecord(completed.response);
        const result = chatResultFromResponse(response);
        const cost = costOf(decision.model, result.usage, new Date(), decision.provider);
        record(meta, 200, result.usage, cost.usd, cost.known);
        return c.json(
          chatCompletionFrom(
            result,
            decision.model,
            `chatcmpl-${decision.session.slice(0, 16)}`,
            Math.floor(started / 1000),
          ),
          200,
          decisionHeaders(decision, meta.retries),
        );
      }

      if (!clientStream) {
        const text = await upstream.text();
        const { events } = splitSseEvents(text);
        const completed = [...events]
          .reverse()
          .find((event) => event.type === "response.completed");
        const failure = responsesErrorMessage(events);
        if (!completed || failure) {
          const message = failure ?? "upstream stream ended before completion";
          if (messageSpendSignal(message)) {
            markProviderSpent(provider, { label: "limit" });
            if (await quotaFailover()) continue;
          }
          record(meta, 502, emptyUsage(), null, true, message);
          return c.json({ error: { message, type: "jevonian_error" } }, 502);
        }
        const response = repairResponsesOutput(asRecord(completed.response), events);
        const usage = responsesUsage(response.usage);
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
        return c.json(response, 200, decisionHeaders(decision, meta.retries));
      }

      const usage = emptyUsage();
      const transform = responsesPassthroughRepairStream((response) => {
        Object.assign(usage, responsesUsage(response.usage));
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
      });
      return streamResponse(
        upstream.body?.pipeThrough(transform) ?? null,
        meta,
        decisionHeaders(decision, meta.retries),
        upstream.headers.get("content-type") ?? "text/event-stream",
      );
    }

    const usage = emptyUsage();
    const decoder = new TextDecoder();
    let buffer = "";
    let hasDelivered = false;
    let finished = false;
    let charsOut = 0;

    const consume = (text: string): void => {
      buffer += text;
      let index = buffer.indexOf("\n\n");
      while (index !== -1) {
        const event = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            finished = true;
            continue;
          }
          if (data.length === 0) continue;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (clientKind === "openai") {
              if (parsed.usage !== undefined) {
                Object.assign(usage, openaiUsage(parsed.usage));
              }
              const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
              if (choices && choices.length > 0) {
                const choice = choices[0];
                const delta = choice.delta as Record<string, unknown> | undefined;
                if (delta) {
                  // A `role`-only or empty first delta is not delivered content — count only
                  // fields a client actually renders, so a cancel right after the opener still
                  // reads as an abandoned request rather than a finished turn.
                  const isContent =
                    typeof delta.content === "string" ||
                    typeof delta.reasoning_content === "string" ||
                    delta.tool_calls !== undefined;
                  if (isContent) hasDelivered = true;
                  if (typeof delta.content === "string") charsOut += delta.content.length;
                  if (typeof delta.reasoning_content === "string")
                    charsOut += delta.reasoning_content.length;
                  if (delta.tool_calls) charsOut += JSON.stringify(delta.tool_calls).length;
                }
                if (choice.finish_reason) {
                  hasDelivered = true;
                  finished = true;
                }
              }
            }
            if (clientKind === "anthropic") {
              applyAnthropicEvent(parsed, usage);
              if (parsed.type === "content_block_delta" || parsed.type === "message_delta") {
                hasDelivered = true;
              }
              if (parsed.type === "message_stop") {
                hasDelivered = true;
                finished = true;
              }
            }
          } catch {
            continue;
          }
        }
        index = buffer.indexOf("\n\n");
      }
    };

    const finalize = (status = 200, error?: string): void => {
      consume(decoder.decode());
      if (usage.output === 0 && charsOut > 0) {
        usage.output = Math.max(1, Math.round(charsOut / 3.5));
      }
      const cost = costOf(decision.model, usage, new Date(), decision.provider);
      record(meta, status, usage, cost.usd, cost.known, error);
    };

    const usageTransform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        consume(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        finalize(200);
      },
    });

    let stream = upstream.body;
    if (passbackReasoning && clientKind === "openai" && stream) {
      stream = stream.pipeThrough(reasoningCaptureTransform(passbackMessages, decision.session));
    }
    if (clientKind === "openai" && stream) {
      stream = stream.pipeThrough(sanitizeOpenAIChatStream());
    }
    stream = stream?.pipeThrough(usageTransform) ?? null;

    const onCancel = (): void => {
      if (finished || hasDelivered) {
        finalize(200);
      } else {
        finalize(499, "client canceled");
      }
    };

    return streamResponse(
      stream,
      meta,
      decisionHeaders(decision, meta.retries),
      upstream.headers.get("content-type") ?? "text/event-stream",
      onCancel,
    );
  }
}

export function handleOpenAI(
  c: Context<AppEnv>,
  config: Config,
  store: SessionStore,
): Promise<Response> {
  return forward(c, config, store, "openai");
}

export function handleAnthropic(
  c: Context<AppEnv>,
  config: Config,
  store: SessionStore,
): Promise<Response> {
  return forward(c, config, store, "anthropic");
}

export function handleResponses(
  c: Context<AppEnv>,
  config: Config,
  store: SessionStore,
): Promise<Response> {
  return forward(c, config, store, "responses");
}
