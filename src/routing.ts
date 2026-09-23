import { saveBody } from "./bodies";
import { askJev, consumeAskJevFailure, type BrainVerdict } from "./brain";
import {
  clampEffort,
  effectiveCapabilities,
  effortRank,
  fitsContext,
  isReasoningEffort,
  type ModelCapabilities,
  type ReasoningEffort,
} from "./capabilities";
import { estimateTokens as compactionTokens } from "./compaction";
import {
  BUILTIN_ROUTING_IDS,
  isBuiltinRoutingId,
  isRoutingId,
  providerHasModel,
  providerModelIds,
  type BrainConfig,
  type Config,
  type RoutingEntry,
  type RoutingTiers,
} from "./config";
import { benchmarkFocusFor, benchmarksCoverageOf, leaderboardViewFor } from "./leaderboard";
import { appendRecord } from "./ledger";
import { canonicalVariants } from "./models";
import { costOf, isDeepSeekPeak, priceFor, type Usage } from "./pricing";
import { captureUsageLimit, providerQuotaHealth, type QuotaStatus } from "./quota";
import { configuredRetries, withRetry } from "./retry";
import { sessionFingerprint } from "./session";
import { canServeClient } from "./wire";

/** A routing id chosen for a turn — builtin or custom. */
export type Phase = string;
export type RequestKind = "openai" | "anthropic" | "responses";

/** Built-in routing ids, in the order clients should list them when no customs exist. */
const VIRTUAL_BUILTINS: readonly string[] = [...BUILTIN_ROUTING_IDS];

/**
 * The `jevonian/*` aliases clients can request when only builtins are known.
 *
 * Prefer `virtualModels(config)` once a config is available so custom routings appear too.
 */
export const VIRTUAL_MODELS: readonly string[] = [
  "jevonian/auto",
  ...VIRTUAL_BUILTINS.map((phase) => `jevonian/${phase}`),
];

/**
 * Models advertised on the OpenAI-compatible `/v1/models` listing.
 *
 * Prefer aliases over upstream ids so a discovering client does not pin itself
 * to one provider behind the router. Upstream names are only used when routing
 * is off and no alias exists.
 */
export function virtualModels(config: Config): string[] {
  return ["jevonian/auto", ...config.routing.routings.map((entry) => `jevonian/${entry.id}`)];
}

export function clientModels(config: Config): string[] {
  if (config.routing.mode === "auto") return virtualModels(config);

  const baseline = config.routing.baselineModel;
  if (baseline) return [baseline];

  const declared = config.providers.flatMap((provider) => providerModelIds(provider));
  return [...new Set(declared)];
}

/**
 * Models Jevonian injects into ChatGPT / Claude Desktop pickers.
 *
 * Mirrors Ollama's Apps integration: keep the host's native models visible, and
 * add only `jevonian/auto` as the routed entry. Phase aliases stay available on
 * `/v1/models` for agents that talk to Jevonian directly.
 */
export function desktopModels(config: Config): string[] {
  if (config.routing.mode === "auto") return ["jevonian/auto"];
  return clientModels(config);
}

/**
 * Models Claude Code's tier remaps can point at.
 *
 * Unlike Desktop (one Auto stand-in), Claude Code remaps opus/sonnet/haiku via
 * env vars the Ollama way — so the offer list can include `jevonian/utility`
 * for the haiku tier when routing is on.
 */
export function claudeCodeModels(config: Config): string[] {
  return clientModels(config);
}

/** True when a desktop request should be served by Jevonian rather than the native upstream. */
export function isDesktopRoutedModel(model: string): boolean {
  const id = model.trim();
  if (id.length === 0) return false;
  return id === "jevonian/auto" || id === "auto" || id.startsWith("jevonian/");
}

export function isVirtualModel(model: string, config?: Config): boolean {
  const id = model.replace(/^jevonian\//, "");
  if (id === "auto") return true;
  if (config) return config.routing.routings.some((entry) => entry.id === id);
  return (VIRTUAL_BUILTINS as readonly string[]).includes(id);
}

const FAILURE_PATTERN =
  /(\berror\b|\berrors\b|\bfailed\b|\bfailure\b|exception|traceback|assertionerror|npm err|exit code [1-9]|\bFAIL\b|✗)/i;

export interface CacheObservation {
  provider: string;
  model: string;
  at: number;
  /** On-wire input tokens excluding cache reads/writes when the adapter can distinguish them. */
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** A successful request is required: failed usage cannot establish a reusable prefix. */
  success: boolean;
}

export type CacheAffinityState = "hot" | "warm" | "stale" | "unknown";
export type CachePrefixMatch = "extends" | "changed" | "unknown";

export interface CacheAffinity {
  state: CacheAffinityState;
  prefixMatch: CachePrefixMatch;
  observedHitRatio: number;
  expectedReadTokens: number;
  expectedUncachedTokens: number;
  effectiveInputCostUsd: number | null;
  costKnown: boolean;
  confidence: number;
}

export interface SessionState {
  phase: Phase;
  model: string;
  provider: string;
  turns: number;
  updatedAt: number;
  cache?: CacheObservation;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionState>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get(key: string, now: number): SessionState | undefined {
    const state = this.sessions.get(key);
    if (!state) return undefined;
    if (now - state.updatedAt > this.ttlMs) {
      this.sessions.delete(key);
      return undefined;
    }
    return state;
  }

  set(key: string, state: SessionState): void {
    this.sessions.set(key, state);
  }

  observeCache(key: string, observation: CacheObservation): void {
    const state = this.sessions.get(key);
    if (!state || !observation.success) return;
    if (state.provider !== observation.provider || state.model !== observation.model) return;
    if (state.cache && state.cache.at > observation.at) return;
    this.sessions.set(key, { ...state, cache: observation });
  }

  get size(): number {
    return this.sessions.size;
  }
}

export interface PhaseSignals {
  phase: Phase;
  consecutiveFailures: number;
  hasToolResults: boolean;
  hasTools: boolean;
  recentToolResults: string[];
}

export function extractUserQuery(text: string): string {
  const match = text.match(/<user_query>([\s\S]*?)<\/user_query>/i);
  if (match?.[1]) return match[1].trim();
  return text.trim();
}

// A tag that wraps its own content, e.g. `<user_info>…</user_info>`. Only paired forms
// count, so a lone `<div>` in pasted code never deletes the text that follows it.
const PAIRED_TAG = /<([a-z][a-z0-9_:-]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// An opening tag left dangling: never closed, or its closing tag fell outside a length cap.
// Everything from it onward is the injected block's tail.
const OPEN_TAG = /<([a-z][a-z0-9_:-]*)\b[^>]*>/gi;

// Standard HTML elements are markup the user is talking about, never an agent's context
// envelope. This is a spec, not a per-agent list — agents that need an envelope pick a name
// outside it (`<user_info>`, `<system-reminder>`, `<environment_context>`).
const HTML_ELEMENTS = new Set([
  "html",
  "head",
  "body",
  "title",
  "meta",
  "link",
  "script",
  "style",
  "div",
  "span",
  "p",
  "a",
  "img",
  "br",
  "hr",
  "em",
  "strong",
  "b",
  "i",
  "u",
  "s",
  "small",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "code",
  "kbd",
  "samp",
  "var",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "td",
  "th",
  "section",
  "article",
  "aside",
  "nav",
  "header",
  "footer",
  "main",
  "figure",
  "figcaption",
  "form",
  "input",
  "textarea",
  "button",
  "select",
  "option",
  "label",
  "fieldset",
  "legend",
  "iframe",
  "video",
  "audio",
  "source",
  "track",
  "canvas",
  "svg",
  "path",
  "g",
  "defs",
  "use",
  "details",
  "summary",
  "dialog",
  "template",
  "slot",
  "picture",
  "map",
  "area",
  "object",
]);

function isMarkupElement(name: string): boolean {
  return HTML_ELEMENTS.has(name.toLowerCase());
}

function stripContextBlocks(text: string): string {
  const stripped = text.replace(PAIRED_TAG, (match, name: string) =>
    isMarkupElement(name) ? match : " ",
  );
  OPEN_TAG.lastIndex = 0;
  let hit = OPEN_TAG.exec(stripped);
  while (hit !== null) {
    if (!isMarkupElement(hit[1] ?? "")) return stripped.slice(0, hit.index);
    hit = OPEN_TAG.exec(stripped);
  }
  return stripped;
}

// True when nothing but injected context remains: Cursor's `<user_info>`, Claude Code's
// `<system-reminder>`, Codex's `<environment_context>`, any agent's preamble. Deliberately
// shape-based — no per-agent tag list, and no length cap in front of it. Capping happens at
// the state boundary instead, because a capped payload loses its closing tag.
function isContextOnly(text: string): boolean {
  return stripContextBlocks(text).replace(/\s+/g, "").length === 0;
}

// The user's actual ask. An explicit ask marker wins; otherwise the message itself, or ""
// when it carries nothing but injected context.
function resolveAsk(text: string): string {
  const explicit = extractUserQuery(text);
  if (explicit !== text.trim()) return explicit;
  return isContextOnly(text) ? "" : explicit;
}

// Openers that carry no task: a session goal should not be "hi" while the real ask sits
// unread further down the transcript.
const GREETING =
  /^(hi|hey|hello|yo|ok|okay|thanks|thank you|你好|嗨|哈喽|在吗|谢谢|继续|好的|嗯)[\s!,.。！？?~]*$/i;

function userMessages(body: Record<string, unknown>, kind: RequestKind): string[] {
  const texts: string[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (message.role !== "user") continue;
    if (kind === "anthropic") {
      // Anthropic allows `content` to be a plain string as well as a block array.
      if (typeof message.content === "string") {
        texts.push(message.content);
        continue;
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        const record = asRecord(block);
        if (record.type === "text" && typeof record.text === "string") texts.push(record.text);
      }
      continue;
    }
    texts.push(stringifyContent(message.content));
  }
  const input = Array.isArray(body.input) ? body.input : [];
  for (const raw of input) {
    const item = asRecord(raw);
    if (item.type === "message" && item.role === "user") texts.push(stringifyContent(item.content));
  }
  if (typeof body.input === "string") texts.push(body.input);
  return texts.filter((text) => text.trim().length > 0);
}

function messageText(message: Record<string, unknown>, kind: RequestKind): string {
  if (kind === "anthropic") {
    if (typeof message.content === "string") return message.content;
    const content = Array.isArray(message.content) ? message.content : [];
    return content
      .flatMap((block) => {
        const record = asRecord(block);
        return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
      })
      .join("\n");
  }
  return stringifyContent(message.content);
}

function assistantMessages(body: Record<string, unknown>, kind: RequestKind): string[] {
  const texts: string[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (message.role !== "assistant") continue;
    const text = messageText(message, kind).trim();
    if (text.length > 0) texts.push(text);
  }
  const input = Array.isArray(body.input) ? body.input : [];
  for (const raw of input) {
    const item = asRecord(raw);
    if (item.type === "message" && item.role === "assistant") {
      const text = stringifyContent(item.content).trim();
      if (text.length > 0) texts.push(text);
    }
  }
  return texts;
}

function recentMessages(
  body: Record<string, unknown>,
  kind: RequestKind,
  limit = 4,
): Array<{ role: string; text: string }> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = Array.isArray(body.input) ? body.input : [];
  const source = messages.length > 0 ? messages : input;
  const out: Array<{ role: string; text: string }> = [];
  for (const raw of source) {
    const message = asRecord(raw);
    const role = typeof message.role === "string" ? message.role : "";
    if (role !== "user" && role !== "assistant") continue;
    const text = resolveAsk(messageText(message, kind)).replace(/\s+/g, " ").trim().slice(0, 200);
    if (text.length === 0) continue;
    out.push({ role, text });
  }
  return out.slice(-limit);
}

/**
 * Shell-like tools. Their arguments routinely contain `; curl …` / heredocs / pipes that
 * Cloudflare WAF in front of TypeSafe treats as an exploit, returning a 403 HTML interstitial
 * and collapsing every brain channel into "unavailable". The brain only needs the tool name
 * to know work is in flight — raw commands are noise and a stability risk.
 */
const SHELL_TOOL_NAME = /^(shell|bash|local_shell)$/i;

function formatToolCallForBrain(name: string, args: string): string {
  if (SHELL_TOOL_NAME.test(name)) return `${name}(<command redacted>)`;
  return `${name}(${args.slice(0, 80)})`;
}

function recentToolCalls(body: Record<string, unknown>, kind: RequestKind, limit = 3): string[] {
  const calls: string[] = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of messages) {
    const message = asRecord(raw);
    if (message.role !== "assistant") continue;
    if (kind === "anthropic") {
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        const record = asRecord(block);
        if (record.type !== "tool_use") continue;
        const name = typeof record.name === "string" ? record.name : "tool";
        const args = JSON.stringify(record.input ?? {});
        calls.push(formatToolCallForBrain(name, args));
      }
      continue;
    }
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const rawCall of toolCalls) {
      const call = asRecord(rawCall);
      const fn = asRecord(call.function);
      const name = typeof fn.name === "string" ? fn.name : "tool";
      const args =
        typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {});
      calls.push(formatToolCallForBrain(name, args));
    }
  }
  // Responses shape (Codex and other /v1/responses clients): tool calls are top-level
  // items, not assistant message fields, so the message loop above never sees them.
  const input = Array.isArray(body.input) ? body.input : [];
  for (const raw of input) {
    const item = asRecord(raw);
    if (item.type === "function_call") {
      const name = typeof item.name === "string" ? item.name : "tool";
      const args = typeof item.arguments === "string" ? item.arguments : "{}";
      calls.push(formatToolCallForBrain(name, args));
      continue;
    }
    if (item.type === "local_shell_call") {
      const action = asRecord(item.action);
      calls.push(formatToolCallForBrain("shell", JSON.stringify(action.command ?? "command")));
    }
  }
  return calls.slice(-limit);
}

function sessionGoal(body: Record<string, unknown>, kind: RequestKind): string {
  let fallback = "";
  for (const text of userMessages(body, kind)) {
    const query = resolveAsk(text);
    if (query.length === 0) continue;
    if (fallback.length === 0) fallback = query;
    const compact = query.replace(/\s+/g, " ").trim();
    if (compact.length < 12 || GREETING.test(compact)) continue;
    return compact.slice(0, 400);
  }
  return fallback.slice(0, 400);
}

/**
 * The conversation's size in tokens. Uses the compaction estimator rather than a
 * characters-per-token ratio: the ratio undercounts JSON-heavy agent transcripts by up to 40%,
 * which would let a model with a small window through the filter and then fail mid-turn.
 */
function compactionEstimate(body: Record<string, unknown>): number {
  return compactionTokens(JSON.stringify(body.messages ?? body.input ?? ""));
}

function requestTokens(
  body: Record<string, unknown>,
  measure: (body: Record<string, unknown>) => number,
): number {
  return measure(body);
}

/** The thinking level the caller demanded, if any. */
function headerEffort(headers: Record<string, string | undefined>): ReasoningEffort | undefined {
  const raw = firstHeader(headers, ["x-jevonian-effort", "x-reasoning-effort"]);
  return raw && isReasoningEffort(raw) ? raw : undefined;
}

export function fullTranscript(body: Record<string, unknown>, kind: RequestKind): string {
  const messages = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : [];
  const lines: string[] = [];
  for (const raw of messages) {
    const message = asRecord(raw);
    const role =
      typeof message.role === "string"
        ? message.role
        : typeof message.type === "string"
          ? message.type
          : "item";
    const text = messageText(message, kind).trim();
    if (text.length > 0) lines.push(`[${role}] ${text.slice(0, 64_000)}`);
  }
  const system = typeof body.system === "string" ? body.system : body.instructions;
  const prefix = typeof system === "string" && system.length > 0 ? `[system] ${system}\n` : "";
  return (prefix + lines.join("\n")).slice(0, 400_000);
}

function messageCount(body: Record<string, unknown>): number {
  if (Array.isArray(body.messages)) return body.messages.length;
  if (Array.isArray(body.input)) return body.input.length;
  if (typeof body.input === "string") return 1;
  return 0;
}

export function lastUserMessage(body: Record<string, unknown>, kind: RequestKind): string {
  const texts = userMessages(body, kind);
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    // A trailing injected block (Codex's <environment_context>, Claude Code's
    // <system-reminder>) resolves to "", so the search keeps walking back to the ask.
    const query = resolveAsk(texts[index] ?? "");
    if (query.length > 0) return query.slice(0, 3_000);
  }
  return "";
}

export type BrainSource = "jev" | "jev-low-confidence" | "heuristic";

export interface RouteDecision {
  model: string;
  provider: string;
  phase: Phase;
  requestedModel: string;
  canonical?: string;
  virtual: boolean;
  routed: boolean;
  reason: string;
  session: string;
  brain?: BrainSource;
  brainChannel?: string;
  confidence?: number;
  /** The thinking level to send upstream, already clamped to what the model accepts. */
  effort?: ReasoningEffort;
  /** Why the chosen model's effort was reduced from what the brain asked for. */
  effortNote?: string;
  /**
   * Models code withheld from the brain's choice, with the reason. Never silent: a model that
   * disappears from the candidate list because its context window is too small, or because it
   * cannot think as deeply as asked, is reported here.
   */
  skipped?: RouteSkip[];
  /**
   * No candidate's window could hold the conversation, so the decision was made against models
   * that will very likely reject the turn. The caller should compact and route again.
   */
  contextOverflow?: boolean;
  /** Cache evidence used for the winning candidate, when automatic routing chose it. */
  cache?: CacheAffinity;
  /** Difference from the model that served the previous turn; positive means switching costs more. */
  switchPenaltyUsd?: number | null;
}

export interface RouteSkip {
  model: string;
  provider: string;
  reason: "context" | "effort";
  detail: string;
}

export interface CacheCandidateView {
  model: string;
  provider: string;
  canonical?: string;
  cache: CacheAffinity;
  /** Difference from the previous model's effective input cost; positive means switching costs more. */
  switchPenaltyUsd?: number | null;
}

export interface RouteInput {
  config: Config;
  body: Record<string, unknown>;
  headers: Record<string, string | undefined>;
  store: SessionStore;
  kind: RequestKind;
  requestId?: string;
  keyId?: string;
  keyName?: string;
  now?: number;
  /** Provider cache TTL when known. Unknown providers use a conservative default. */
  cacheTtlMs?: number;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((block) => {
        const record = asRecord(block);
        if (typeof record.text === "string") return record.text;
        return JSON.stringify(record);
      })
      .join("\n");
  }
  return value === undefined ? "" : JSON.stringify(value);
}

export function classifyPhase(body: Record<string, unknown>, kind: RequestKind): PhaseSignals {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const input = Array.isArray(body.input) ? body.input : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const toolResults: string[] = [];

  if (kind === "responses") {
    for (const raw of input) {
      const item = asRecord(raw);
      if (item.type === "function_call_output") toolResults.push(stringifyContent(item.output));
      if (item.type === "message" && item.role === "tool") {
        toolResults.push(stringifyContent(item.content));
      }
    }
  }

  for (const raw of messages) {
    const message = asRecord(raw);
    if (kind === "openai") {
      if (message.role === "tool") toolResults.push(stringifyContent(message.content));
      continue;
    }
    if (kind === "responses") continue;
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      const record = asRecord(block);
      if (record.type === "tool_result") toolResults.push(stringifyContent(record.content));
    }
  }

  let consecutiveFailures = 0;
  for (let index = toolResults.length - 1; index >= 0; index -= 1) {
    if (FAILURE_PATTERN.test(toolResults[index] ?? "")) {
      consecutiveFailures += 1;
    } else {
      break;
    }
  }

  const hasToolResults = toolResults.length > 0;
  const phase: Phase = hasToolResults ? "execute" : "plan";
  // Keep signal, not harness boilerplate: when the tail is failing, the failure is what
  // Jev needs to see, so drop the trailing successes instead of the failures.
  const failed = toolResults.slice(-4).filter((result) => FAILURE_PATTERN.test(result));
  const recent = (failed.length > 0 ? failed : toolResults).slice(-2);
  const recentToolResults = recent.map((result) =>
    result
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 300),
  );
  return {
    phase,
    consecutiveFailures,
    hasToolResults,
    hasTools: tools.length > 0,
    recentToolResults,
  };
}

export function deriveRoutings(config: Config): RoutingEntry[] {
  const declared = config.routing.routings.map((entry) => ({
    ...entry,
    models: [...entry.models],
    ...(entry.providers
      ? {
          providers: Object.fromEntries(
            Object.entries(entry.providers).map(([model, providers]) => [model, [...providers]]),
          ),
        }
      : {}),
  }));

  const available = [
    ...new Set(config.providers.flatMap((provider) => providerModelIds(provider))),
  ];
  const priced = available
    .flatMap((model) => {
      const price = priceFor(model);
      return price ? [{ model, output: price.output, experimental: isExperimental(model) }] : [];
    })
    .sort((left, right) => right.output - left.output);
  // A model the catalog has no price for is still a real candidate — a vendor ships an id
  // before models.dev lists it, and withholding it would keep a brand-new flagship unreachable
  // until the snapshot catches up. Cost is the only ranking signal available, and an unpriced
  // model has none, so it forms a second tier behind every priced model — and only for the
  // `expensive` direction. A cheap pick is a cost claim ("this is the inexpensive one"), which
  // an unknown price cannot back; a cheap routing with no priced candidate left falls through
  // to the reuse fallback below instead of being pinned to an unknown.
  const unpriced = available
    .filter((model) => !priceFor(model))
    .map((model) => ({ model, output: 0, experimental: isExperimental(model) }));

  const pick = (exclude: Set<string>, direction: "expensive" | "cheap"): string | undefined => {
    const tiers = direction === "expensive" ? [priced, unpriced] : [priced];
    for (const tier of tiers) {
      const ordered = direction === "expensive" ? tier : [...tier].reverse();
      const stable = ordered.find(
        (candidate) => !candidate.experimental && !exclude.has(candidate.model),
      );
      if (stable) return stable.model;
      const any = ordered.find((candidate) => !exclude.has(candidate.model));
      if (any) return any.model;
    }
    return undefined;
  };

  const used = new Set<string>();
  const fill = (entry: RoutingEntry, direction: "expensive" | "cheap"): void => {
    if (entry.models.length > 0) {
      for (const model of entry.models) used.add(model);
      return;
    }
    const candidate = pick(used, direction);
    if (candidate) {
      entry.models = [candidate];
      delete entry.providers;
      used.add(candidate);
    }
  };

  for (const entry of declared) {
    if (entry.id === "plan") fill(entry, "expensive");
    else fill(entry, "cheap");
  }
  // A custom/chat routing with nothing left still needs a fallback so explicit aliases work.
  for (const entry of declared) {
    if (entry.models.length > 0) continue;
    const fallback =
      declared.find((candidate) => candidate.models.length > 0)?.models[0] ?? available[0];
    if (fallback) {
      entry.models = [fallback];
      delete entry.providers;
    }
  }
  return declared;
}

/** @deprecated Prefer `deriveRoutings`. Returns the four builtin model lists after auto-fill. */
export function deriveTiers(config: Config): RoutingTiers {
  const routings = deriveRoutings(config);
  const tiers: RoutingTiers = {
    plan: [],
    execute: [],
    utility: [],
    chat: [],
  };
  for (const entry of routings) {
    if (isBuiltinRoutingId(entry.id)) tiers[entry.id] = [...entry.models];
  }
  return tiers;
}

export function routingById(config: Config, id: string): RoutingEntry | undefined {
  return deriveRoutings(config).find((entry) => entry.id === id);
}

function isExperimental(model: string): boolean {
  return /(exp|experimental|preview|beta)/i.test(model);
}

export interface TierPick {
  model: string;
  provider: string;
  canonical?: string;
  quota?: QuotaStatus;
}

export function tierEntryCandidates(config: Config, model: string, kind?: RequestKind): TierPick[] {
  const picks: TierPick[] = [];
  const seen = new Set<string>();
  const add = (provider: string, resolved: string, canonical?: string): void => {
    const id = `${provider}/${resolved}`;
    if (seen.has(id)) return;
    seen.add(id);
    picks.push({ provider, model: resolved, ...(canonical ? { canonical } : {}) });
  };

  const preferred = config.providers.filter(
    (provider) =>
      providerHasModel(provider, model) && (kind === undefined || canServeClient(provider, kind)),
  );
  const exact =
    preferred.length > 0
      ? preferred
      : config.providers.filter((provider) => providerHasModel(provider, model));
  for (const provider of exact) add(provider.name, model);

  // Exact spelling is not the whole catalog: OpenRouter may list the same model as
  // `deepseek/deepseek-v4.1-flash` while OpenCode lists `deepseek-v4.1-flash`. Always absorb
  // canonical/identity variants so a spent exact match cannot hide healthier resellers.
  for (const variant of canonicalVariants(config, model, kind)) {
    add(variant.provider, variant.model, model);
  }
  return picks;
}

/**
 * A routing's named providers for one model, applied to the discovered picks.
 *
 * The list is an allow-list, not just a hint: naming providers restricts the model to them, so
 * deleting a provider actually stops the router using it. Absent means every provider that
 * serves the model, in config order; an empty list withholds the model, so removing the last
 * provider is honest rather than a silent fallback to "all". A named provider that no longer
 * serves this model is dropped here, never reordered around: the UI surfaces it so the stale
 * name can be removed deliberately.
 */
export function applyProviderPreference(
  picks: TierPick[],
  preferred?: readonly string[],
): TierPick[] {
  if (preferred === undefined) return picks;
  if (preferred.length === 0) return [];
  const remaining = picks.filter((pick) => preferred.includes(pick.provider));
  const ordered: TierPick[] = [];
  for (const name of preferred) {
    const index = remaining.findIndex((pick) => pick.provider === name);
    if (index < 0) continue;
    ordered.push(remaining.splice(index, 1)[0]!);
  }
  return ordered;
}

/** The models a routing declares, each expanded to providers and filtered by that routing's list. */
export function routingCandidates(
  config: Config,
  entry: Pick<RoutingEntry, "models" | "providers">,
  kind?: RequestKind,
): TierPick[] {
  return entry.models.flatMap((model) =>
    applyProviderPreference(tierEntryCandidates(config, model, kind), entry.providers?.[model]),
  );
}

/** The models a tier declares, in order, each paired with the provider that serves it. */
export function tierCandidates(config: Config, tier: string[], kind?: RequestKind): TierPick[] {
  return tier.flatMap((model) => tierEntryCandidates(config, model, kind));
}

/**
 * A candidate paired with what it can actually do. Routing needs this before the brain sees
 * anything: offering a model whose window cannot hold the conversation, or that cannot think
 * as deeply as the turn needs, only produces a broken turn.
 */
export interface CapableCandidate extends TierPick {
  capabilities: ModelCapabilities;
}

export function capableCandidates(config: Config, candidates: TierPick[]): CapableCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    capabilities: effectiveCapabilities(
      candidate.model,
      config.routing.capacities?.[candidate.model],
    ),
  }));
}

/**
 * Splits candidates into the ones the brain may choose from and the ones code withholds,
 * keeping the reason for each. Two things disqualify a model, both answerable from arithmetic
 * rather than judgement, so neither is left to the brain:
 *
 * - the conversation cannot fit its context window, and compaction has already been tried (or
 *   is impossible) — sending it would fail mid-turn;
 * - no thinking level it accepts is at least as deep as the one asked for, when the caller
 *   demanded a floor.
 *
 * A model whose capabilities are unknown is never withheld: silence is not evidence.
 */
export function partitionByCapability(
  candidates: CapableCandidate[],
  tokens: number,
  options: { minEffort?: ReasoningEffort; requiredEffort?: boolean } = {},
): { usable: CapableCandidate[]; skipped: RouteSkip[] } {
  const usable: CapableCandidate[] = [];
  const skipped: RouteSkip[] = [];
  for (const candidate of candidates) {
    const { contextWindow, efforts } = candidate.capabilities;
    if (!fitsContext(contextWindow, tokens)) {
      skipped.push({
        model: candidate.model,
        provider: candidate.provider,
        reason: "context",
        detail: `~${tokens} tokens exceeds the ${contextWindow} window`,
      });
      continue;
    }
    if (options.requiredEffort && options.minEffort && efforts && efforts.length > 0) {
      const deepest = deepestEffort(efforts);
      if (effortRank(deepest) < effortRank(options.minEffort)) {
        skipped.push({
          model: candidate.model,
          provider: candidate.provider,
          reason: "effort",
          detail: `supports up to "${deepest}", needs "${options.minEffort}"`,
        });
        continue;
      }
    }
    usable.push(candidate);
  }
  return { usable, skipped };
}

/** The first model in a tier that resolves to a configured provider. */
export function firstFromTier(
  config: Config,
  tier: string[],
  kind?: RequestKind,
): TierPick | undefined {
  return tierCandidates(config, tier, kind)[0];
}

/**
 * The model a brain asked for, resolved against the candidates code offered. Brains answer
 * with an id; anything unrecognised falls back to the first candidate so a turn still lands.
 */
export function resolveCandidate(
  model: string | undefined,
  candidates: TierPick[],
): TierPick | undefined {
  if (!candidates[0]) return undefined;
  // A brain that answers "none_of_the_above" means it cannot judge: take the safest listed
  // option rather than letting the turn fail.
  if (!model || model === "none_of_the_above") return candidates[0];
  return (
    candidates.find((candidate) => candidate.model === model) ??
    candidates.find((candidate) => candidate.canonical === model) ??
    candidates[0]
  );
}

/** The routing a model is declared under. Reporting only — routing never branches on it. */
export function phaseOfModel(config: Config, model: string): Phase {
  const routings = deriveRoutings(config);
  for (const entry of routings) {
    if (entry.models.includes(model)) return entry.id;
  }
  return "execute";
}

function firstHeader(
  headers: Record<string, string | undefined>,
  names: string[],
): string | undefined {
  for (const name of names) {
    const value = headers[name];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function stringField(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataUserId(body: Record<string, unknown>): string | undefined {
  const metadata = asRecord(body.metadata);
  return typeof metadata.user_id === "string" && metadata.user_id.length > 0
    ? metadata.user_id
    : undefined;
}

function normalizeRoutingId(value: string | undefined, config: Config): string | undefined {
  if (!value) return undefined;
  if (config.routing.routings.some((entry) => entry.id === value)) return value;
  // Allow an explicit alias for a routing that only exists after deriveRoutings fills it.
  if (isRoutingId(value) && deriveRoutings(config).some((entry) => entry.id === value)) {
    return value;
  }
  return undefined;
}

export function resolveSessionKey(
  body: Record<string, unknown>,
  headers: Record<string, string | undefined>,
): string {
  const explicit =
    firstHeader(headers, ["x-session-id", "x-jevonian-session", "x-opencode-session"]) ??
    stringField(body, "previous_response_id") ??
    stringField(body, "prompt_cache_key") ??
    metadataUserId(body) ??
    stringField(body, "user");
  if (explicit) return explicit;
  return sessionFingerprint({
    system: body.system ?? body.instructions,
    tools: body.tools,
    messages: body.messages ?? body.input,
  });
}

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;

function cacheAffinity(input: {
  previous: SessionState | undefined;
  candidate: TierPick;
  now: number;
  estimatedTokens: number;
  cacheTtlMs?: number;
}): CacheAffinity {
  const previous = input.previous;
  const observation = previous?.cache;
  const ttl = Math.max(1, input.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS);
  if (!observation || !observation.success) {
    return {
      state: "unknown",
      prefixMatch: "unknown",
      observedHitRatio: 0,
      expectedReadTokens: 0,
      expectedUncachedTokens: input.estimatedTokens,
      effectiveInputCostUsd: null,
      costKnown: false,
      confidence: 0,
    };
  }
  const sameTarget =
    observation.provider === input.candidate.provider &&
    observation.model === input.candidate.model;
  const age = Math.max(0, input.now - observation.at);
  const total =
    observation.uncachedInputTokens + observation.cacheReadTokens + observation.cacheWriteTokens;
  const observedHitRatio = total > 0 ? observation.cacheReadTokens / total : 0;
  // Session identity is not proof that the on-wire prefix is unchanged.
  const prefixMatch: CachePrefixMatch = "unknown";
  const recency = Math.max(0, Math.min(1, 1 - age / ttl));
  const confidence = sameTarget ? recency * 0.5 : 0;
  const expectedReadTokens = sameTarget
    ? Math.round(Math.min(input.estimatedTokens, observation.cacheReadTokens) * recency)
    : 0;
  const expectedUncachedTokens = Math.max(0, input.estimatedTokens - expectedReadTokens);
  const state: CacheAffinityState = !sameTarget
    ? "unknown"
    : age >= ttl
      ? "stale"
      : expectedReadTokens > 0
        ? "hot"
        : observation.cacheWriteTokens > 0
          ? "warm"
          : sameTarget
            ? "warm"
            : "unknown";
  return {
    state,
    prefixMatch,
    observedHitRatio,
    expectedReadTokens,
    expectedUncachedTokens,
    effectiveInputCostUsd: null,
    costKnown: false,
    confidence,
  };
}

function cacheCostAffinity(candidate: TierPick, affinity: CacheAffinity, at: Date): CacheAffinity {
  const price = priceFor(candidate.model, candidate.provider);
  if (!price) return affinity;
  const rates =
    price.peakRule === "deepseek" && isDeepSeekPeak(at) && price.peak ? price.peak : price;
  const inputRate = rates.input;
  const cacheReadRate = rates.cacheRead;
  if (affinity.expectedReadTokens > 0 && cacheReadRate === undefined) return affinity;
  const usd =
    (affinity.expectedUncachedTokens * inputRate +
      affinity.expectedReadTokens * (cacheReadRate ?? 0)) /
    1_000_000;
  return {
    ...affinity,
    effectiveInputCostUsd: usd,
    costKnown: true,
  };
}

function cacheCandidates(
  candidates: TierPick[],
  previous: SessionState | undefined,
  now: number,
  estimatedTokens: number,
  cacheTtlMs?: number,
): CacheCandidateView[] {
  return candidates.map((candidate) => {
    const base = cacheAffinity({ previous, candidate, now, estimatedTokens, cacheTtlMs });
    return {
      model: candidate.model,
      provider: candidate.provider,
      ...(candidate.canonical ? { canonical: candidate.canonical } : {}),
      cache: cacheCostAffinity(candidate, base, new Date(now)),
    };
  });
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function recordBrainCall(input: {
  config: Config;
  session: string;
  requestId?: string;
  keyId?: string;
  keyName?: string;
  started: number;
  state?: Record<string, unknown>;
  verdict: BrainVerdict | undefined;
  brain: BrainConfig;
  error?: string;
}): void {
  if (input.config.routing.mode !== "auto") return;
  const brain = input.brain;
  const usage = input.verdict?.usage ?? emptyUsage();
  // The verdict carries the *routed* model; the brain's own model id comes from the response.
  const model = input.verdict?.modelName ?? brain.model ?? "jev";
  const cost = costOf(model, usage, new Date());
  const id = crypto.randomUUID();
  saveBody(id, {
    kind: "brain",
    at: new Date().toISOString(),
    channel: brain.channel,
    model,
    ...(input.state ? { state: input.state } : {}),
    ...(input.verdict
      ? {
          verdict: {
            model: input.verdict.model,
            confidence: input.verdict.confidence,
            ...(input.verdict.probabilities ? { probabilities: input.verdict.probabilities } : {}),
            ...(input.verdict.effort ? { effort: input.verdict.effort } : {}),
            ...(input.verdict.effortProbabilities
              ? { effortProbabilities: input.verdict.effortProbabilities }
              : {}),
          },
        }
      : {}),
  });
  appendRecord({
    id,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.keyId ? { keyId: input.keyId } : {}),
    ...(input.keyName ? { keyName: input.keyName } : {}),
    ts: new Date().toISOString(),
    session: input.session,
    path: "/brain",
    provider: `brain:${brain.channel}`,
    model,
    stream: false,
    status: input.verdict ? 200 : 502,
    latencyMs: Date.now() - input.started,
    promptTokens: usage.input,
    completionTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    costUsd: cost.usd,
    pricingKnown: cost.known,
    kind: "brain",
    reason: "routing-brain",
    ...(input.verdict ? {} : { error: input.error?.trim() ? input.error : "brain unavailable" }),
  });
}

export async function decideRoute(
  input: RouteInput,
): Promise<RouteDecision | { error: string; status?: number }> {
  const { config, body, headers, store, kind } = input;
  const now = input.now ?? Date.now();
  const requestedRaw = typeof body.model === "string" ? body.model : "";
  const requestedModel = requestedRaw.replace(/^jevonian\//, "");
  const pinned = config.providers.some((candidate) => providerHasModel(candidate, requestedModel));
  const virtual = isVirtualModel(requestedModel, config) && !pinned;
  const session = resolveSessionKey(body, headers);

  if (!virtual) {
    // A pinned model is not a routing decision: no brain runs, so there is no phase to claim.
    const matches = config.providers.filter((candidate) =>
      providerHasModel(candidate, requestedModel),
    );
    const guard = config.routing.quotaGuard;
    const byWire = matches.find((candidate) => canServeClient(candidate, kind)) ?? matches[0];
    const exact =
      guard.enabled && matches.length > 1
        ? (matches.find((candidate) => {
            if (!canServeClient(candidate, kind)) return false;
            const status = providerQuotaHealth(candidate, {
              lowPercent: guard.lowPercent,
              now,
            }).status;
            return status !== "low" && status !== "exhausted";
          }) ?? byWire)
        : byWire;
    if (exact) {
      return {
        model: requestedModel,
        provider: exact.name,
        phase: phaseOfModel(config, requestedModel),
        requestedModel: requestedRaw,
        virtual: false,
        routed: false,
        reason: "pinned-model",
        session,
      };
    }

    const variants = canonicalVariants(config, requestedModel, kind);
    if (variants.length > 0) {
      const guard = config.routing.quotaGuard;
      const acceptable = guard.enabled
        ? variants.find((variant) => {
            const target = config.providers.find(
              (candidate) => candidate.name === variant.provider,
            );
            if (!target) return false;
            const status = providerQuotaHealth(target, {
              lowPercent: guard.lowPercent,
              now,
            }).status;
            return status !== "low" && status !== "exhausted";
          })
        : undefined;
      const chosen = acceptable ?? variants[0];
      if (chosen) {
        return {
          model: chosen.model,
          provider: chosen.provider,
          phase: phaseOfModel(config, chosen.model),
          requestedModel: requestedRaw,
          canonical: requestedModel,
          virtual: false,
          routed: false,
          reason: "canonical-model",
          session,
        };
      }
    }

    const fallback =
      config.providers.find((candidate) => candidate.name === config.defaultProvider) ??
      config.providers[0];
    if (!fallback) return { error: `No provider configured for model "${requestedRaw}"` };
    return {
      model: requestedModel,
      provider: fallback.name,
      phase: phaseOfModel(config, requestedModel),
      requestedModel: requestedRaw,
      virtual: false,
      routed: false,
      reason: "pinned-model",
      session,
    };
  }

  if (config.routing.mode === "off") {
    return {
      error: `Model "${requestedRaw}" is a virtual model, but routing is off. Configure routing.mode = "auto" or request a real model.`,
    };
  }

  const signals = classifyPhase(body, kind);
  const routings = deriveRoutings(config);
  const explicitPhase =
    normalizeRoutingId(firstHeader(headers, ["x-jevonian-phase", "x-jevonian-tier"]), config) ??
    (requestedModel === "auto" ? undefined : normalizeRoutingId(requestedModel, config));

  const previous = store.get(session, now);
  const turns = (previous?.turns ?? 0) + 1;
  const candidatesFor = (target: Phase): TierPick[] => {
    const entry = routings.find((routing) => routing.id === target);
    return entry ? routingCandidates(config, entry, kind) : [];
  };

  let phase: Phase;
  // Assigned on every path before the decision is returned; the initial value only satisfies
  // the compiler's flow analysis across the brain loop.
  let reason = "";
  let brain: BrainSource = "jev";
  let brainChannel: string | undefined;
  let confidence: number | undefined;
  let picked: TierPick | undefined;

  if (explicitPhase) {
    phase = explicitPhase;
    reason = `explicit:${explicitPhase}`;
    const tier = candidatesFor(phase);
    const guard = config.routing.quotaGuard;
    const healthy = guard.enabled
      ? tier.filter((candidate) => {
          const target = config.providers.find((entry) => entry.name === candidate.provider);
          if (!target) return false;
          return (
            providerQuotaHealth(target, { lowPercent: guard.lowPercent, now }).status !==
            "exhausted"
          );
        })
      : tier;
    // Aggregated routing: a spent utility/chat tier (OpenCode's haiku probe lands here)
    // must not pin the client to that subscription — widen to any healthy model.
    let pool = healthy.length > 0 ? healthy : tier;
    if (guard.enabled && healthy.length === 0) {
      const fallback: TierPick[] = [];
      const seen = new Set<string>();
      const absorb = (candidate: TierPick): void => {
        const key = `${candidate.provider}/${candidate.model}`;
        if (seen.has(key)) return;
        seen.add(key);
        const targetProvider = config.providers.find((entry) => entry.name === candidate.provider);
        if (!targetProvider) return;
        if (
          providerQuotaHealth(targetProvider, { lowPercent: guard.lowPercent, now }).status ===
          "exhausted"
        ) {
          return;
        }
        fallback.push(candidate);
      };
      // Prefer light routings first when the pinned one is fully spent.
      const fallbackOrder = [
        ...routings.filter((entry) => entry.id === "utility" || entry.id === "chat"),
        ...routings.filter((entry) => entry.id !== "utility" && entry.id !== "chat"),
      ];
      for (const entry of fallbackOrder) {
        for (const candidate of candidatesFor(entry.id)) absorb(candidate);
      }
      if (fallback.length > 0) {
        pool = fallback;
        // Only a spent tier is a quota fallback. A routing with no candidate at all — every
        // model removed, or every provider removed — widened for a different reason, and saying
        // "quota" there would send someone looking at usage meters that are not the cause.
        reason = tier.length > 0 ? `${reason}:quota-fallback` : `${reason}:no-candidate`;
      }
    } else if (guard.enabled && healthy.length > 0 && healthy.length < tier.length) {
      reason = `${reason}:quota-skip`;
    }
    picked = pool[0];
    if (!picked) {
      return {
        error: `No models available for routing. Configure routing.routings or add models to a provider.`,
      };
    }
    store.set(session, {
      phase,
      model: picked.model,
      provider: picked.provider,
      turns,
      updatedAt: now,
      ...(previous?.cache ? { cache: previous.cache } : {}),
    });
    return {
      model: picked.model,
      provider: picked.provider,
      phase,
      requestedModel: requestedRaw,
      ...(picked.canonical ? { canonical: picked.canonical } : {}),
      virtual: true,
      routed: true,
      reason,
      session,
    };
  }

  const brains = config.routing.brains;
  if (brains.length === 0) {
    return {
      error:
        "No Jev brain is configured. Add one under Providers → Routing brain, or request an explicit routing (jevonian/plan, …) or a concrete model.",
      status: 400,
    };
  }

  // Code narrows each routing's pool; Jev picks the routing. Quota is arithmetic, so it is
  // resolved before the brain sees anything: an exhausted provider is never an option.
  const guard = config.routing.quotaGuard;
  const statuses = new Map<string, QuotaStatus>();
  const statusOf = (providerName: string): QuotaStatus => {
    const cached = statuses.get(providerName);
    if (cached) return cached;
    const provider = config.providers.find((candidate) => candidate.name === providerName);
    const status: QuotaStatus = provider
      ? providerQuotaHealth(provider, { lowPercent: guard.lowPercent, now }).status
      : "unknown";
    statuses.set(providerName, status);
    return status;
  };

  const conversationTokens = requestTokens(body, compactionEstimate);
  const requestedEffort = headerEffort(headers);
  const brainPicksEffort = config.routing.brainPicksEffort;
  const defaultEffort = brainEffort(config.routing.defaultEffort);
  const minEffort = requestedEffort ?? (brainPicksEffort ? undefined : defaultEffort);

  type RoutingOffer = {
    id: string;
    label: string;
    description: string;
    candidates: CapableCandidate[];
    offeredToBrain: CacheCandidateView[];
    skipped: RouteSkip[];
  };

  const allSkipped: RouteSkip[] = [];
  const offers: RoutingOffer[] = [];
  const buildOffer = (entry: (typeof routings)[number], pool: TierPick[]): void => {
    const capable = capableCandidates(config, pool);
    const { usable, skipped } = partitionByCapability(capable, conversationTokens, {
      ...(minEffort ? { minEffort } : {}),
      requiredEffort: true,
    });
    allSkipped.push(...skipped);
    const offered = usable.length > 0 ? usable : capable;
    const offeredToBrain = cacheCandidates(
      offered,
      previous,
      now,
      conversationTokens,
      input.cacheTtlMs,
    );
    offers.push({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      candidates: offered,
      offeredToBrain,
      skipped,
    });
  };

  for (const entry of routings) {
    const declared = candidatesFor(entry.id);
    const healthy = guard.enabled
      ? declared.filter((candidate) => statusOf(candidate.provider) !== "exhausted")
      : declared;
    // Skip a routing whose every provider is spent when other routings still have room —
    // matching the old flat-pool filter. Exhausted fallbacks are only used when nothing is left.
    if (healthy.length === 0) continue;
    buildOffer(entry, healthy);
  }
  if (offers.length === 0) {
    for (const entry of routings) {
      const declared = candidatesFor(entry.id);
      if (declared.length === 0) continue;
      buildOffer(entry, declared);
    }
  }

  if (offers.length === 0) {
    return {
      error: `No models available for routing. Configure routing.routings or add models to a provider.`,
    };
  }

  // The same model can sit in several routings; collapse skip notes so headers stay readable.
  const skippedSeen = new Set<string>();
  const skipped: RouteSkip[] = [];
  for (const entry of allSkipped) {
    const key = `${entry.provider}/${entry.model}/${entry.reason}`;
    if (skippedSeen.has(key)) continue;
    skippedSeen.add(key);
    skipped.push(entry);
  }

  const contextOverflow =
    offers.every((offer) => offer.candidates.length === 0) ||
    (allSkipped.some((entry) => entry.reason === "context") &&
      offers.every((offer) => offer.skipped.some((entry) => entry.reason === "context")));

  // Attach switch penalties relative to the previous turn's model, when it still appears.
  const flatOffered: CacheCandidateView[] = [];
  const seenFlat = new Set<string>();
  for (const offer of offers) {
    for (const candidate of offer.offeredToBrain) {
      const key = `${candidate.provider}/${candidate.model}`;
      if (seenFlat.has(key)) continue;
      seenFlat.add(key);
      flatOffered.push(candidate);
    }
  }
  const previousCandidate = previous
    ? flatOffered.find(
        (candidate) =>
          candidate.provider === previous.provider && candidate.model === previous.model,
      )
    : undefined;
  if (previousCandidate) {
    for (const candidate of offers.flatMap((offer) => offer.offeredToBrain)) {
      if (
        candidate.cache.effectiveInputCostUsd !== null &&
        previousCandidate.cache.effectiveInputCostUsd !== null
      ) {
        candidate.switchPenaltyUsd =
          candidate.cache.effectiveInputCostUsd - previousCandidate.cache.effectiveInputCostUsd;
      } else {
        candidate.switchPenaltyUsd = null;
      }
    }
  }

  const constraints = {
    estimated_tokens: conversationTokens,
    ...(minEffort ? { requested_effort: minEffort } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
  };

  const goal = sessionGoal(body, kind);
  const lastAssistant = assistantMessages(body, kind).at(-1)?.replace(/\s+/g, " ").trim() ?? "";
  const benchmarkFocus = benchmarkFocusFor({
    consecutiveFailures: signals.consecutiveFailures,
    hasToolResults: signals.hasToolResults,
    hasTools: signals.hasTools,
  });

  const firstModelViews = offers.map((offer) => {
    const first = offer.offeredToBrain[0];
    return first ? leaderboardViewFor(first.model) : undefined;
  });
  const benchmarksCoverage = benchmarksCoverageOf(firstModelViews);
  // Soft evidence only. When nobody has scores, omit focus entirely so Jev cannot
  // treat "missing benchmarks" as a reason to reject a routing.
  const includeBenchmarkHints = benchmarksCoverage !== "none";

  const brainState = {
    last_user_message: lastUserMessage(body, kind),
    ...(lastAssistant ? { last_assistant_message: lastAssistant.slice(0, 500) } : {}),
    ...(goal ? { session_goal: goal } : {}),
    recent_messages: recentMessages(body, kind),
    recent_tool_calls: recentToolCalls(body, kind),
    recent_tool_results: signals.recentToolResults,
    has_tool_results: signals.hasToolResults,
    has_tools: signals.hasTools,
    consecutive_failures: signals.consecutiveFailures,
    ...(previous ? { previous_model: previous.model, previous_routing: previous.phase } : {}),
    session_turns: turns,
    message_count: messageCount(body),
    ...(includeBenchmarkHints
      ? { benchmark_focus: benchmarkFocus, benchmarks_coverage: benchmarksCoverage }
      : {}),
    ...constraints,
  };

  const applyVerdict = (verdict: BrainVerdict, channel: string, source: BrainSource): void => {
    confidence = verdict.confidence;
    brain = source;
    brainChannel = channel;
    reason = `brain:${verdict.model ?? "unset"}`;
  };

  const routingPayload = offers.map((offer) => {
    const focus = includeBenchmarkHints
      ? benchmarkFocusFor({
          consecutiveFailures: signals.consecutiveFailures,
          hasToolResults: signals.hasToolResults,
          hasTools: signals.hasTools,
          routingId: offer.id,
        })
      : undefined;
    return {
      id: offer.id,
      label: offer.label,
      description: offer.description,
      ...(focus ? { benchmark_focus: focus } : {}),
      // Listed preferred-first so Jev can weigh order; preference_rank makes that explicit.
      // Benchmark scores only attach to the first model — that is the one this routing would
      // actually serve. Scores on fallbacks would mislead the brain into picking a routing
      // for a model it will never run. Missing benchmarks are omitted, never a zero score.
      models: offer.offeredToBrain.map((candidate, index) => {
        const benchmarks = index === 0 ? leaderboardViewFor(candidate.model) : undefined;
        return {
          ...candidate,
          preference_rank: index + 1,
          ...(benchmarks ? { benchmarks } : {}),
        };
      }),
    };
  });

  const wantsTranscript = brains.some((entry) => entry.fullPrompt === true);
  const transcript = wantsTranscript ? fullTranscript(body, kind) : undefined;
  // Walk every configured channel once per round. Channel order is failover (typesafe →
  // openrouter), not a second opinion. When every channel fails, repeat the whole round with
  // the same transient backoff as upstream calls — a brief brain outage used to 502 Cursor
  // immediately, which freezes the agent behind a misleading "API key rate limit" toast.
  //
  // Non-retryable channel failures (402 billing, 403 WAF) are skipped for the rest of this
  // turn so we do not hammer an empty OpenRouter key or a blocked TypeSafe payload.
  const brainBudget = configuredRetries();
  const skipChannels = new Set<string>();
  for (const entry of brains) {
    // Same OpenRouter key often powers both the model provider and the brain channel. If the
    // provider is already known spent, do not burn another 402 on the decisions endpoint.
    const linked = config.providers.find((provider) => provider.name === entry.channel);
    if (
      linked &&
      providerQuotaHealth(linked, { lowPercent: guard.lowPercent, now }).status === "exhausted"
    ) {
      skipChannels.add(entry.channel);
    }
  }
  let best = await withRetry(
    async () => {
      for (const entry of brains) {
        if (skipChannels.has(entry.channel)) continue;
        const brainStarted = Date.now();
        const ready: Record<string, unknown> = {
          ...brainState,
          routings: routingPayload,
          // Keep a flat candidates list for older brain stubs / probes that still read it.
          candidates: flatOffered,
          ...(brainPicksEffort ? {} : { picks_effort: false }),
        };
        const state = entry.fullPrompt && transcript ? { ...ready, transcript } : ready;
        const verdict = await askJev({
          brain: entry,
          state,
          ...(brainPicksEffort ? {} : { modelOnly: true }),
        });
        const failure = verdict ? undefined : consumeAskJevFailure();
        recordBrainCall({
          config,
          session,
          ...(input.requestId ? { requestId: input.requestId } : {}),
          ...(input.keyId ? { keyId: input.keyId } : {}),
          ...(input.keyName ? { keyName: input.keyName } : {}),
          started: brainStarted,
          state,
          verdict,
          brain: entry,
          ...(failure?.error ? { error: failure.error } : {}),
        });
        if (!verdict) {
          // 402 = no credits; 403 = WAF/auth. Retrying the same payload against the same
          // host cannot recover within this turn.
          if (failure?.status === 402 || failure?.status === 403) {
            skipChannels.add(entry.channel);
          }
          if (failure?.status === 402) {
            const linked = config.providers.find((provider) => provider.name === entry.channel);
            if (linked) {
              captureUsageLimit(linked, 402, failure.error);
              console.warn(
                `brain ${entry.channel}: billing exhausted — routing will skip provider "${linked.name}"`,
              );
            }
          }
          continue;
        }
        const source: BrainSource =
          verdict.confidence < entry.minConfidence ? "jev-low-confidence" : "jev";
        applyVerdict(verdict, entry.channel, source);
        if (source === "jev-low-confidence") reason = `${reason}:brain-low-confidence`;
        return { verdict, channel: entry.channel };
      }
      return undefined;
    },
    {
      attempts: brainBudget + 1,
      retryWhen: (outcome) => (outcome === undefined ? { status: 502 } : undefined),
      onRetry: ({ attempt, delayMs }) => {
        console.warn(
          `brain unavailable retry ${attempt}/${brainBudget} in ${delayMs}ms: all ${brains.length} channel(s) failed`,
        );
      },
    },
  );
  if (!best) {
    // Prefer staying up over failing the agent. Cursor maps a brain 502 into a misleading
    // "User Provided API Key Rate Limit Exceeded" toast that freezes the turn; a heuristic
    // pick from classifyPhase is far cheaper than that. Channel failures are already in the
    // ledger as /brain 502 rows.
    const preferred =
      offers.find((entry) => entry.id === signals.phase) ??
      (signals.hasToolResults ? offers.find((entry) => entry.id === "execute") : undefined) ??
      offers.find((entry) => entry.id === "plan") ??
      offers[0];
    if (!preferred?.candidates[0]) {
      return {
        error: `Jev brain unavailable: all ${brains.length} configured brain(s) failed.`,
        status: 502,
      };
    }
    console.warn(
      `brain unavailable: falling back to heuristic routing "${preferred.id}" after ${brains.length} channel(s) failed`,
    );
    best = {
      verdict: { model: preferred.id, confidence: 0 },
      channel: "heuristic",
    };
    applyVerdict(best.verdict, "heuristic", "heuristic");
    reason = `brain-fallback:${preferred.id}`;
  }

  // The brain answers with a routing id; the model is the first healthy entry in that pool.
  const chosenRoutingId =
    best?.verdict.model && best.verdict.model !== "none_of_the_above"
      ? best.verdict.model
      : undefined;
  const offer = offers.find((entry) => entry.id === chosenRoutingId) ?? offers[0];
  if (!offer) {
    return {
      error: `Jev chose "${best?.verdict.model ?? "nothing"}", which is not an available routing.`,
      status: 502,
    };
  }
  phase = offer.id;
  const chosen = offer.candidates[0];
  if (!chosen) {
    return {
      error: `Routing "${offer.id}" has no available models.`,
      status: 502,
    };
  }
  const chosenCandidate = offer.offeredToBrain.find(
    (candidate) => candidate.provider === chosen.provider && candidate.model === chosen.model,
  );
  const declaredProviders = new Set(
    routings.flatMap((entry) =>
      routingCandidates(config, entry, kind).map((candidate) => candidate.provider),
    ),
  );
  const usedProviders = new Set(offer.candidates.map((candidate) => candidate.provider));
  if ([...declaredProviders].some((provider) => !usedProviders.has(provider))) {
    reason = `${reason}:quota-skip`;
  }
  if (skipped.some((entry) => entry.reason === "context")) reason = `${reason}:context-skip`;
  if (skipped.some((entry) => entry.reason === "effort")) reason = `${reason}:effort-skip`;
  if (chosen.canonical) reason = `${reason}:canonical:${chosen.canonical}`;
  if (chosenCandidate?.cache.state === "hot") reason = `${reason}:cache-hot`;
  if (chosenCandidate?.cache.state === "stale") reason = `${reason}:cache-stale`;

  const wanted = brainPicksEffort ? brainEffort(best?.verdict.effort) : undefined;
  const appliedEffort = clampEffort(
    wanted ?? requestedEffort ?? defaultEffort,
    effectiveCapabilities(chosen.model, config.routing.capacities?.[chosen.model]).efforts,
  );
  const effortNote =
    wanted && appliedEffort && wanted !== appliedEffort
      ? `clamped "${wanted}" to "${appliedEffort}"`
      : requestedEffort && appliedEffort && requestedEffort !== appliedEffort
        ? `requested "${requestedEffort}", model supports "${appliedEffort}"`
        : undefined;
  if (effortNote) reason = `${reason}:effort-clamped`;

  store.set(session, {
    phase,
    model: chosen.model,
    provider: chosen.provider,
    turns,
    updatedAt: now,
    ...(previous?.cache ? { cache: previous.cache } : {}),
  });
  return {
    model: chosen.model,
    provider: chosen.provider,
    phase,
    requestedModel: requestedRaw,
    ...(chosen.canonical ? { canonical: chosen.canonical } : {}),
    virtual: true,
    routed: true,
    reason,
    session,
    brain,
    ...(brainChannel ? { brainChannel } : {}),
    ...(confidence === undefined ? {} : { confidence }),
    ...(appliedEffort ? { effort: appliedEffort } : {}),
    ...(effortNote ? { effortNote } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(contextOverflow ? { contextOverflow: true } : {}),
    ...(chosenCandidate ? { cache: chosenCandidate.cache } : {}),
    ...(chosenCandidate?.switchPenaltyUsd === undefined
      ? {}
      : { switchPenaltyUsd: chosenCandidate.switchPenaltyUsd }),
  };
}

/** The deepest level in a set, regardless of the order the catalogue listed it in. */
function deepestEffort(efforts: ReasoningEffort[]): ReasoningEffort {
  return efforts.reduce((best, effort) => (effortRank(effort) > effortRank(best) ? effort : best));
}

/** The brain's effort answer, when it is one we recognise. */
function brainEffort(value: string | undefined): ReasoningEffort | undefined {
  return value && isReasoningEffort(value) ? value : undefined;
}
