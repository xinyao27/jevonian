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
import { resolveProviderAuth, withSessionAffinity } from "./auth";
import { saveBody } from "./bodies";
import { decodeBody } from "./body-encoding";
import { askJevRaw } from "./brain";
import { effectiveCapabilities, isReasoningEffort, type ReasoningEffort } from "./capabilities";
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
import { captureQuotaHeaders, captureUsageLimit } from "./quota";
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
  decideRoute,
  isDesktopRoutedModel,
  phaseOfModel,
  resolveSessionKey,
  type RequestKind,
  type RouteDecision,
  type RouteSkip,
  type SessionStore,
} from "./routing";
import type { AppEnv } from "./server";
import { planUpstreamWire, upstreamUrlFor } from "./wire";

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
    // Reported only when the turn needed one, so a healthy response stays uncluttered.
    ...(retries > 0 ? { "x-jevonian-retries": String(retries) } : {}),
    ...(decision.cache ? { "x-jevonian-cache-state": decision.cache.state } : {}),
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

/**
 * Shrinks a request body that no model's context window could hold. Compaction drops tool calls
 * and results Jev judges stale and keeps every word of prose verbatim; if the reduction is not
 * worth the churn, the original body is kept rather than sending a mangled history.
 */
async function compactForOverflow(
  config: Config,
  body: Record<string, unknown>,
): Promise<CompactOutcome> {
  const brain = config.routing.brains[0];
  if (!brain) return { ok: false, error: "no Jev brain is configured" };
  const messages = normalizeTranscript(body);
  if (messages.length === 0) return { ok: false, error: "the request has no messages to compact" };

  // Compaction asks its own questions, so it needs the raw System One shape rather than the
  // router's model-choice verdict.
  const asker: JevAsker = {
    ask: async (state, questions) => {
      const { answers } = await askJevRaw(
        brain,
        state as unknown as Record<string, unknown>,
        questions,
      );
      return { answers: answers as JevResponse["answers"] };
    },
  };

  try {
    const result = await compact(messages, asker, { preserveRecentMessages: 4 });
    if (reductionRatio(result) < 0.25) {
      return {
        ok: false,
        error: `compaction only reduced the history by ${(reductionRatio(result) * 100).toFixed(0)}%`,
      };
    }
    return { ok: true, body: reencodeMessages(body, result.messages), stats: result.stats };
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
  return next;
}

function injectClaudeCodeSystem(body: Record<string, unknown>): void {
  const system = body.system;
  const prompt = { type: "text", text: CLAUDE_CODE_SYSTEM_PROMPT };
  if (typeof system === "string") {
    body.system = system.length > 0 ? [prompt, { type: "text", text: system }] : [prompt];
    return;
  }
  if (Array.isArray(system)) {
    body.system = [prompt, ...system];
    return;
  }
  body.system = [prompt];
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
  if (clientKind === "responses" || clientKind === "openai") {
    const model = typeof body.model === "string" ? body.model : "";
    const nativeRoute = shouldProxyNativeCodex(model, c.req.raw.headers);
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
  let decision: RouteDecision;
  {
    // Codex remote compaction must stay on a native Responses (ChatGPT) upstream.
    // Running it through decideRoute / brain can land on OpenRouter etc., and the
    // Chat Completions bridge then synthesizes a message item instead of `compaction`.
    const initial =
      clientKind === "responses" && isRemoteCompactionV2(body)
        ? remoteCompactionDecision(config, body, incomingHeaders)
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

  // Every model was too small for this conversation. Rather than let the upstream reject the
  // turn, compaction rewrites the message list — dropping tool calls and results Jev judges
  // stale, keeping all prose verbatim — and routing runs again on the smaller history.
  let compacted: CompactOutcome | undefined;
  if (decision.contextOverflow) {
    compacted = await compactForOverflow(config, body);
    if (compacted.ok) {
      const retryBody = { ...body, ...compacted.body };
      const retry = await decideRoute({
        config,
        body: retryBody,
        headers: incomingHeaders,
        store,
        kind: clientKind,
        requestId,
        keyId,
        keyName,
      });
      if ("error" in retry) {
        return c.json(
          { error: { message: retry.error, type: "jevonian_error" } },
          (retry.status ?? 400) as 400,
        );
      }
      body = retryBody;
      decision = retry;
    } else {
      return c.json(
        {
          error: {
            message: `Context too large for every configured model, and compaction failed: ${compacted.error}`,
            type: "context_length_exceeded",
          },
        },
        400 as const,
      );
    }
  }

  let quotaFailovers = 0;
  while (true) {
    const meta = decisionMeta(decision, endpoint, clientStream, started, requestId, keyId, keyName);
    const provider: Provider | undefined = findProviderByName(config, decision.provider);
    if (!provider) {
      return errorResponse(c, meta, 404, `Provider "${decision.provider}" is not configured`);
    }
    meta.store = store;
    meta.billing = provider.billing;

    const translated = provider.type === "responses" && clientKind === "openai";
    const geminiWire = provider.type === "gemini";
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
    meta.usageKind = upstreamKind;
    const upstreamStream = provider.type === "responses" ? true : clientStream;

    let auth = await resolveProviderAuth(provider, upstreamKind);
    if (auth.error) return errorResponse(c, meta, 400, auth.error);
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

    const bodyFor = (wire: RequestKind): Record<string, unknown> => {
      // The client's own level, in whatever field its wire uses. Detected per wire so the router
      // never overrides an explicit instruction, and so the log can say who chose the level.
      const clientEffort = clientEffortOf(body, clientKind);
      const maxOutput = effectiveCapabilities(
        decision.model,
        config.routing.capacities?.[decision.model],
      ).maxOutput;
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
              : body;
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

    let upstreamBody: Record<string, unknown> = bodyFor(upstreamKind);
    // OpenAI Responses rejects empty call_id / name (minLength 1) and call_id
    // longer than 64 chars. Sanitize before egress — Cursor / bridged history
    // can leave "" or oversized ids on function_call(_output) items.
    if (upstreamKind === "responses") {
      upstreamBody = ensureResponsesCallIds(upstreamBody);
    }
    // DeepSeek / Kimi thinking mode: clients often drop `reasoning_content` after
    // tool calls. Restore it from the previous upstream response before egress.
    const passbackReasoning =
      upstreamKind === "openai" &&
      needsReasoningPassback(decision.provider, decision.model, provider.baseUrl);
    if (passbackReasoning) {
      upstreamBody = repairReasoningContent(upstreamBody, decision.session).body;
    }
    const passbackMessages = Array.isArray(upstreamBody.messages)
      ? (upstreamBody.messages as Record<string, unknown>[])
      : [];

    // The log reports the level the model was actually sent, read back from the body rather than
    // from the router's intent: those differ when the client set its own level. `gemini` takes no
    // effort field, so nothing is recorded for it.
    const sentEffort = geminiWire
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
    const payloadFor = (wire: RequestKind): Record<string, unknown> => {
      const payload = wire === upstreamKind ? upstreamBody : bodyFor(wire);
      return wire === "anthropic" && provider.auth === "oauth"
        ? applyClaudeCodeSystem(payload)
        : payload;
    };
    const upstreamUrl = urlFor(upstreamKind);
    // Built once per wire, not per attempt: a retry repeats the same bytes, which is the whole
    // point of retrying a POST that failed on the network.
    const payload = JSON.stringify(payloadFor(upstreamKind));

    // A socket reset from a local proxy, a DNS timeout, or a gateway's brief 502 otherwise
    // costs the whole turn — and the same request almost always succeeds on a second attempt.
    // Every retry is counted onto the turn's ledger record, so a flaky network stays visible
    // instead of being laundered into an apparent success.
    const retryBudget = configuredRetries();
    const onRetry = ({ attempt, delayMs, failure }: RetryAttempt): void => {
      meta.retries = (meta.retries ?? 0) + 1;
      console.warn(
        `upstream retry ${attempt}/${retryBudget} for ${decision.provider} in ${delayMs}ms: ${describeRetryFailure(failure)}`,
      );
    };

    let upstream: Response;
    let failureText = "";
    try {
      ({ response: upstream, text: failureText } = await postUpstream(
        upstreamUrl,
        { method: "POST", headers: auth.headers, body: payload },
        onRetry,
      ));
      if (
        upstream.status === 401 &&
        provider.auth === "oauth" &&
        provider.oauthSource &&
        provider.oauthSource !== "static"
      ) {
        invalidateOAuthToken(provider.oauthSource);
        const refreshed = await resolveProviderAuth(provider, upstreamKind);
        if (!refreshed.error) {
          auth = refreshed;
          ({ response: upstream, text: failureText } = await postUpstream(
            upstreamUrl,
            { method: "POST", headers: auth.headers, body: payload },
            onRetry,
          ));
        }
      }
    } catch (error) {
      return errorResponse(c, meta, 502, `Upstream request failed: ${describeFetchError(error)}`);
    }

    captureQuotaHeaders(provider, upstream.headers);

    if (!upstream.ok) {
      // Read during the attempt, not here: a body left unread would hold the pooled socket
      // that the next retry needs, and the last attempt's text is what gets reported.
      const text = failureText;
      const limited = captureUsageLimit(provider, upstream.status, text);
      // Remote compaction v2 only ChatGPT's Responses API can answer. Failover onto
      // OpenRouter/DeepSeek would bridge to Chat Completions and Codex would then
      // see "got 0 compaction items" — or our bridge guard. Keep the upstream error.
      const remoteCompact = clientKind === "responses" && isRemoteCompactionV2(body);
      if (limited && !remoteCompact && quotaFailovers < 2) {
        const next = await decideRoute({
          config,
          body,
          headers: incomingHeaders,
          store,
          kind: clientKind,
          requestId,
        });
        if (
          !("error" in next) &&
          (next.provider !== decision.provider || next.model !== decision.model)
        ) {
          decision = {
            ...next,
            reason: `${next.reason}:quota-failover`,
          };
          quotaFailovers += 1;
          continue;
        }
      }
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
        return new Response(streamBody, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            ...decisionHeaders(decision, meta.retries),
          },
        });
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
      return new Response(upstream.body?.pipeThrough(transform) ?? null, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          ...decisionHeaders(decision, meta.retries),
        },
      });
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
        return new Response(body, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
            ...decisionHeaders(decision, meta.retries),
          },
        });
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
      return new Response(upstream.body?.pipeThrough(transform) ?? null, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          ...decisionHeaders(decision, meta.retries),
        },
      });
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
          return new Response(upstream.body?.pipeThrough(transform) ?? null, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              ...decisionHeaders(decision, meta.retries),
            },
          });
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
      const json = (await upstream.json()) as Record<string, unknown>;
      if (passbackReasoning && clientKind === "openai") {
        rememberFromChatCompletion(json, passbackMessages, decision.session);
      }
      const usage = clientKind === "openai" ? openaiUsage(json.usage) : anthropicUsage(json.usage);
      const cost = costOf(decision.model, usage, new Date(), decision.provider);
      record(meta, 200, usage, cost.usd, cost.known);
      return c.json(json, 200, decisionHeaders(decision, meta.retries));
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
          return new Response(upstream.body?.pipeThrough(transform) ?? null, {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "cache-control": "no-store",
              ...decisionHeaders(decision, meta.retries),
            },
          });
        }
        const text = await upstream.text();
        const { events } = splitSseEvents(text);
        const completed = [...events]
          .reverse()
          .find((event) => event.type === "response.completed");
        const failure = responsesErrorMessage(events);
        if (!completed || failure) {
          const message = failure ?? "upstream stream ended before completion";
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
      return new Response(upstream.body?.pipeThrough(transform) ?? null, {
        status: 200,
        headers: {
          "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
          "cache-control": "no-store",
          ...decisionHeaders(decision, meta.retries),
        },
      });
    }

    const usage = emptyUsage();
    const decoder = new TextDecoder();
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
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (clientKind === "openai" && parsed.usage !== undefined) {
              Object.assign(usage, openaiUsage(parsed.usage));
            }
            if (clientKind === "anthropic") {
              applyAnthropicEvent(parsed, usage);
            }
          } catch {
            continue;
          }
        }
        index = buffer.indexOf("\n\n");
      }
    };

    const usageTransform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
        consume(decoder.decode(chunk, { stream: true }));
      },
      flush() {
        consume(decoder.decode());
        const cost = costOf(decision.model, usage, new Date(), decision.provider);
        record(meta, 200, usage, cost.usd, cost.known);
      },
    });

    let stream = upstream.body;
    if (passbackReasoning && clientKind === "openai" && stream) {
      stream = stream.pipeThrough(reasoningCaptureTransform(passbackMessages, decision.session));
    }
    stream = stream?.pipeThrough(usageTransform) ?? null;

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-store",
        ...decisionHeaders(decision, meta.retries),
      },
    });
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
