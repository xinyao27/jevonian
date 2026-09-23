import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { isReasoningEffort } from "./capabilities";
import { getCredential } from "./credentials";
import type { OAuthSource } from "./oauth";
import { hasOAuthCredential } from "./oauth";
import { configPath } from "./paths";
import {
  canServeClient,
  normalizeProviderType,
  providerSpeaks,
  type ModelEntry,
  type UpstreamWire,
} from "./wire";

/** @deprecated Prefer `providerSpeaks` from `./wire`. */
export const providerSupports = providerSpeaks;
/** @deprecated Prefer `canServeClient` from `./wire`. */
export const providerAcceptsClient = canServeClient;

export type { ModelEntry, UpstreamWire };
export type ProviderType = "openai" | "anthropic" | "responses" | "both" | "gemini";
export type ProviderAuth = "api-key" | "oauth";
export type ProviderBilling = "api" | "subscription";

export interface ProviderQuotaSpec {
  fiveHourUsd?: number;
  weeklyUsd?: number;
  monthlyUsd?: number;
}

export interface Provider {
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  auth: ProviderAuth;
  oauthSource?: OAuthSource;
  billing: ProviderBilling;
  quota?: ProviderQuotaSpec;
  /** Model ids with optional per-model wire pins. Bare strings in JSON become `{ id }`. */
  models: ModelEntry[];
  injectStreamUsage: boolean;
  headers?: Record<string, string>;
  /**
   * Background discovery opt-in/out. Explicit `false` always skips; explicit `true` always
   * syncs. When absent, only native OAuth subscription sources (Codex, Claude Code,
   * Antigravity) sync — those catalogs are the intended full list. API keys and reseller
   * subscriptions keep a curated picker until the operator turns sync on.
   */
  syncModels?: boolean;
  /**
   * Model ids discovery must never re-add. Removing an id from `models` is otherwise temporary:
   * the next sync would see it as new and append it again, so a deliberate removal is recorded
   * here instead.
   */
  excludeModels?: string[];
}

/**
 * Whether background discovery may append this provider's newly released models.
 * See `Provider.syncModels` for the absent / true / false rules.
 */
export function providerSyncsModels(provider: Provider): boolean {
  if (provider.syncModels === false) return false;
  if (provider.syncModels === true) return true;
  return providerSyncsByDefault(provider);
}

/**
 * OAuth sources whose discovered catalog is the intended full list, so they sync without an
 * explicit `syncModels`. Exposed to the dashboard so the form's default is not a second copy.
 */
export const MODEL_SYNC_DEFAULT_SOURCES: readonly OAuthSource[] = [
  "codex",
  "claude-code",
  "antigravity",
];

export function providerSyncsByDefault(provider: Pick<Provider, "oauthSource">): boolean {
  return (
    provider.oauthSource !== undefined && MODEL_SYNC_DEFAULT_SOURCES.includes(provider.oauthSource)
  );
}

export function modelIdOf(entry: ModelEntry): string {
  return entry.id;
}

export function providerModelIds(provider: Provider): string[] {
  return provider.models
    .map((entry) => (typeof entry === "string" ? entry : entry?.id))
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

export function providerHasModel(provider: Provider, model: string): boolean {
  return providerModelIds(provider).includes(model);
}

/**
 * Append discovered model ids to a provider without dropping anything already configured.
 * Discovery can only add: an id already present keeps its position and its per-model wire pin,
 * and an id named in `excludeModels` is never re-added — so a manual removal sticks instead of
 * being undone by the next sync.
 */
export function appendDiscoveredModels(
  provider: Provider,
  discovered: string[],
): { provider: Provider; added: string[] } {
  const known = new Set(providerModelIds(provider));
  const excluded = new Set(provider.excludeModels ?? []);
  const added: string[] = [];
  for (const raw of discovered) {
    const id = raw.trim();
    if (id.length === 0 || known.has(id) || excluded.has(id)) continue;
    known.add(id);
    added.push(id);
  }
  if (added.length === 0) return { provider, added };
  return {
    provider: { ...provider, models: [...provider.models, ...added.map((id) => ({ id }))] },
    added,
  };
}

/**
 * Keep deliberate removals sticky across discovery. Ids dropped from `models` join
 * `excludeModels`; ids that are selected again leave the exclusion list so a later
 * sync can stop treating them as banned.
 */
export function reconcileExcludeModels(
  previous: Provider | undefined,
  nextModelIds: string[],
  explicit?: string[],
): string[] | undefined {
  const selected = new Set(nextModelIds);
  const excluded = new Set<string>();
  if (explicit) {
    for (const raw of explicit) {
      const id = raw.trim();
      if (id.length > 0 && !selected.has(id)) excluded.add(id);
    }
  } else {
    for (const id of previous?.excludeModels ?? []) {
      if (!selected.has(id)) excluded.add(id);
    }
    for (const id of previous ? providerModelIds(previous) : []) {
      if (!selected.has(id)) excluded.add(id);
    }
  }
  return excluded.size > 0 ? [...excluded] : undefined;
}

/** Build model entries from bare ids (tests and CLI helpers). */
export function modelEntries(...ids: string[]): ModelEntry[] {
  return ids.map((id) => ({ id }));
}

/** Built-in routing ids that cannot be deleted. */
export const BUILTIN_ROUTING_IDS = ["plan", "execute", "utility", "chat"] as const;
export type BuiltinRoutingId = (typeof BUILTIN_ROUTING_IDS)[number];

/**
 * A routing category the brain (or an explicit `jevonian/<id>` request) can choose.
 * Built-ins keep stable ids; users may add custom entries with their own slug.
 */
export interface RoutingEntry {
  id: string;
  label: string;
  description: string;
  /** Fallback chain: first model with a healthy provider wins; later entries wait. */
  models: string[];
  /**
   * Which providers may serve each model within this routing, in preference order. The list is
   * an allow-list, so removing a provider stops the router using it. A model with no key here
   * uses every configured provider that serves it, in config order; an explicit empty list
   * withholds the model instead — never a silent fallback to "all", which would make deleting
   * the last provider look like it did nothing.
   */
  providers?: Record<string, string[]>;
}

/** @deprecated Prefer `RoutingEntry[]`. Kept for migration and a few call sites that still want the four builtins as a record. */
export interface RoutingTiers {
  plan: string[];
  execute: string[];
  utility: string[];
  chat: string[];
}

export interface BrainConfig {
  channel: string;
  baseUrl?: string;
  /**
   * Cloudflare Workers AI account id. Used with the `cloudflare` brain channel to build
   * `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run`.
   */
  accountId?: string;
  apiKeyEnv?: string;
  model?: string;
  timeoutMs: number;
  minConfidence: number;
  fullPrompt?: boolean;
}

export interface QuotaGuardConfig {
  enabled: boolean;
  lowPercent: number;
}

/**
 * What a model can do, when the catalog does not say. Any field left out stays unknown, and
 * an unknown limit never filters a model out — only a *stated* limit that is too small does.
 */
export interface ModelCapacityConfig {
  contextWindow?: number;
  maxOutput?: number;
  efforts?: string[];
}

export interface RoutingConfig {
  mode: "auto" | "off";
  /** Ordered routing categories; the brain picks among these on auto. */
  routings: RoutingEntry[];
  /**
   * Model lists for the four builtins, mirrored from `routings` for older configs/callers.
   * Prefer editing `routings`.
   */
  tiers: RoutingTiers;
  sessionTtlMinutes: number;
  baselineModel?: string;
  quotaGuard: QuotaGuardConfig;
  brains: BrainConfig[];
  /** Per-model overrides, keyed by model id as written in a routing. */
  capacities?: Record<string, ModelCapacityConfig>;
  /**
   * Default thinking level when the brain does not pick one, or when the chosen model cannot
   * honour its choice. `undefined` leaves the upstream default in place.
   */
  defaultEffort?: string;
  /**
   * Ask the brain to choose a thinking level alongside the model. Off means the router only
   * uses `defaultEffort` and never offers the brain the extra decision.
   */
  brainPicksEffort: boolean;
}

export const DEFAULT_ROUTING_COPY: Record<
  BuiltinRoutingId,
  { label: string; description: string }
> = {
  plan: { label: "Plan", description: "planning, coordination, review" },
  execute: { label: "Execute", description: "implementation, debugging, tool loops" },
  utility: { label: "Background", description: "background calls, titles, summaries" },
  chat: { label: "Chit-chat", description: "casual chat, greetings, small talk" },
};

export function isBuiltinRoutingId(id: string): id is BuiltinRoutingId {
  return (BUILTIN_ROUTING_IDS as readonly string[]).includes(id);
}

/** A slug safe for `jevonian/<id>` aliases: lowercase letters, digits, hyphens. */
export function isRoutingId(value: string): boolean {
  return /^[a-z][a-z0-9-]{0,63}$/.test(value) && value !== "auto";
}

export function emptyRoutingTiers(): RoutingTiers {
  return { plan: [], execute: [], utility: [], chat: [] };
}

/**
 * Drop provider lists for models no longer in the routing, and dedupe names within each list.
 * An empty list is kept: it is how a routing says "no provider serves this model here", which
 * must survive a round-trip instead of quietly reverting to every provider.
 */
export function pruneProviderOrder(
  models: string[],
  order: Record<string, string[]> | undefined,
): Record<string, string[]> | undefined {
  if (!order) return undefined;
  const kept: Record<string, string[]> = {};
  for (const model of models) {
    const list = order[model];
    if (list === undefined) continue;
    const providers: string[] = [];
    for (const name of list) {
      if (name.length > 0 && !providers.includes(name)) providers.push(name);
    }
    kept[model] = providers;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Pull the four builtin model lists out of a routings array. */
export function tiersFromRoutings(routings: RoutingEntry[]): RoutingTiers {
  const tiers = emptyRoutingTiers();
  for (const entry of routings) {
    if (isBuiltinRoutingId(entry.id)) tiers[entry.id] = [...entry.models];
  }
  return tiers;
}

/** Ensure the four builtins exist, then append any custom entries. */
export function defaultRoutings(models: Partial<RoutingTiers> = {}): RoutingEntry[] {
  return BUILTIN_ROUTING_IDS.map((id) => ({
    id,
    label: DEFAULT_ROUTING_COPY[id].label,
    description: DEFAULT_ROUTING_COPY[id].description,
    models: [...(models[id] ?? [])],
  }));
}

/**
 * Sync builtin model lists on `routings` from a tiers record (used when older code/UI still
 * patches tiers). Custom routings are left alone.
 */
export function applyTiersToRoutings(
  routings: RoutingEntry[],
  tiers: RoutingTiers,
): RoutingEntry[] {
  const next = routings.map((entry) => {
    if (!isBuiltinRoutingId(entry.id)) return entry;
    const models = [...tiers[entry.id]];
    const providers = pruneProviderOrder(models, entry.providers);
    return {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      models,
      ...(providers ? { providers } : {}),
    };
  });
  for (const id of BUILTIN_ROUTING_IDS) {
    if (!next.some((entry) => entry.id === id)) {
      next.push({
        id,
        label: DEFAULT_ROUTING_COPY[id].label,
        description: DEFAULT_ROUTING_COPY[id].description,
        models: [...tiers[id]],
      });
    }
  }
  // Builtins first, in canonical order, then customs in existing order.
  const builtins = BUILTIN_ROUTING_IDS.map((id) => next.find((entry) => entry.id === id)!);
  const customs = next.filter((entry) => !isBuiltinRoutingId(entry.id));
  return [...builtins, ...customs];
}

/** Keep `tiers` mirrored from `routings` so both views stay consistent after edits. */
export function syncRoutingViews(routing: RoutingConfig): RoutingConfig {
  return {
    ...routing,
    tiers: tiersFromRoutings(routing.routings),
  };
}

export interface TunnelConfig {
  enabled: boolean;
  provider: "cloudflare" | "ngrok" | "custom";
  command?: string;
  url?: string;
  publicPort?: number;
}

export const DEFAULT_TUNNEL: TunnelConfig = {
  enabled: false,
  provider: "cloudflare",
};

/**
 * Background discovery of provider model lists. A vendor ships a new model id and the agent's
 * config still names yesterday's list, so the turn never reaches the new model until someone
 * re-runs setup. This appends what discovery finds; it never removes or reorders.
 */
export interface ModelSyncConfig {
  enabled: boolean;
  /** Minutes between discovery passes. Clamped to at least 15. */
  intervalMinutes: number;
}

export const DEFAULT_MODEL_SYNC: ModelSyncConfig = {
  enabled: true,
  intervalMinutes: 12 * 60,
};

export const MIN_MODEL_SYNC_INTERVAL_MINUTES = 15;

export function parseModelSync(raw: unknown): ModelSyncConfig {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const intervalMinutes = value.intervalMinutes;
  return {
    enabled: value.enabled !== false,
    // An out-of-range number is a too-eager setting, not a missing one: clamp it rather than
    // silently jumping back to the 12h default.
    intervalMinutes:
      typeof intervalMinutes === "number" && Number.isFinite(intervalMinutes)
        ? Math.max(MIN_MODEL_SYNC_INTERVAL_MINUTES, Math.floor(intervalMinutes))
        : DEFAULT_MODEL_SYNC.intervalMinutes,
  };
}

export interface Config {
  listen: { host: string; port: number };
  defaultProvider?: string;
  providers: Provider[];
  modelAliases?: Record<string, string[]>;
  tunnel: TunnelConfig;
  routing: RoutingConfig;
  modelSync: ModelSyncConfig;
}

export const DEFAULT_QUOTA_GUARD: QuotaGuardConfig = {
  enabled: true,
  lowPercent: 10,
};

export const DEFAULT_BRAIN: BrainConfig = {
  channel: "typesafe",
  timeoutMs: 8_000,
  minConfidence: 0.6,
};

export const DEFAULT_ROUTING: RoutingConfig = {
  mode: "auto",
  routings: defaultRoutings(),
  tiers: emptyRoutingTiers(),
  sessionTtlMinutes: 720,
  quotaGuard: DEFAULT_QUOTA_GUARD,
  brains: [],
  brainPicksEffort: true,
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function parseWireValue(value: unknown): UpstreamWire | UpstreamWire[] | undefined {
  const one = (raw: unknown): UpstreamWire | undefined => {
    if (raw === "openai" || raw === "anthropic" || raw === "responses") return raw;
    return undefined;
  };
  if (Array.isArray(value)) {
    const wires = value.flatMap((item) => {
      const wire = one(item);
      return wire ? [wire] : [];
    });
    return wires.length > 0 ? wires : undefined;
  }
  return one(value);
}

/** Accept `"id"` or `{ id, wire? }` so existing configs keep working. */
export function parseModelEntries(value: unknown): ModelEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ModelEntry[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) {
      entries.push({ id: item });
      continue;
    }
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id =
      typeof record.id === "string"
        ? record.id
        : typeof record.model === "string"
          ? record.model
          : "";
    if (id.length === 0) continue;
    const wire = parseWireValue(record.wire);
    entries.push(wire ? { id, wire } : { id });
  }
  return entries;
}

/**
 * Merge a save payload onto existing entries so a UI that posts bare ids does not
 * wipe per-model wire pins.
 */
export function mergeModelEntries(
  existing: ModelEntry[] | undefined,
  incoming: unknown,
): ModelEntry[] {
  const parsed = parseModelEntries(incoming);
  const previous = new Map((existing ?? []).map((entry) => [entry.id, entry]));
  return parsed.map((entry) => {
    if (entry.wire !== undefined) return entry;
    const prior = previous.get(entry.id);
    return prior?.wire !== undefined ? { id: entry.id, wire: prior.wire } : entry;
  });
}

/** Compact serialization: bare id when no wire pin, object when pinned. */
export function serializeModelEntry(entry: ModelEntry): string | ModelEntry {
  if (entry.wire === undefined) return entry.id;
  return entry;
}

function parseProviderType(value: unknown, index: number): ProviderType {
  const type = value ?? "openai";
  if (
    type !== "openai" &&
    type !== "anthropic" &&
    type !== "responses" &&
    type !== "both" &&
    type !== "gemini"
  ) {
    throw new Error(
      `providers[${index}].type must be "openai", "anthropic", "responses", "both", or "gemini"`,
    );
  }
  return type;
}

/** Hosts that expose both OpenAI and Anthropic wires — see `normalizeProviderType` in wire.ts. */
export function effectiveProviderType(type: ProviderType, baseUrl: string): ProviderType {
  return normalizeProviderType(type, baseUrl);
}

function parseOAuthSource(value: unknown): OAuthSource | undefined {
  if (value === "claude-code" || value === "codex" || value === "antigravity" || value === "static")
    return value;
  return undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function parseQuota(raw: unknown): ProviderQuotaSpec | undefined {
  const value = asRecord(raw);
  const quota: ProviderQuotaSpec = {};
  const fiveHourUsd = positiveNumber(value.fiveHourUsd);
  const weeklyUsd = positiveNumber(value.weeklyUsd);
  const monthlyUsd = positiveNumber(value.monthlyUsd);
  if (fiveHourUsd !== undefined) quota.fiveHourUsd = fiveHourUsd;
  if (weeklyUsd !== undefined) quota.weeklyUsd = weeklyUsd;
  if (monthlyUsd !== undefined) quota.monthlyUsd = monthlyUsd;
  return Object.keys(quota).length > 0 ? quota : undefined;
}

function parseProvider(raw: unknown, index: number): Provider {
  const value = asRecord(raw);
  const name = value.name;
  const baseUrl = value.baseUrl;
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`providers[${index}].name must be a non-empty string`);
  }
  if (typeof baseUrl !== "string" || baseUrl.length === 0) {
    throw new Error(`providers[${index}].baseUrl must be a non-empty string`);
  }
  const type = normalizeProviderType(parseProviderType(value.type, index), baseUrl);
  const headers =
    value.headers === undefined ? undefined : (asRecord(value.headers) as Record<string, string>);
  const auth: ProviderAuth = value.auth === "oauth" ? "oauth" : "api-key";
  const oauthSource = auth === "oauth" ? parseOAuthSource(value.oauthSource) : undefined;
  const quota = parseQuota(value.quota);
  const excludeModels = stringArray(value.excludeModels);
  return {
    name,
    type,
    baseUrl,
    ...(typeof value.apiKey === "string" ? { apiKey: value.apiKey } : {}),
    ...(typeof value.apiKeyEnv === "string" ? { apiKeyEnv: value.apiKeyEnv } : {}),
    auth,
    ...(oauthSource ? { oauthSource } : {}),
    billing: value.billing === "subscription" ? "subscription" : "api",
    ...(quota ? { quota } : {}),
    models: parseModelEntries(value.models),
    injectStreamUsage: value.injectStreamUsage !== false,
    ...(headers ? { headers } : {}),
    ...(value.syncModels === false
      ? { syncModels: false }
      : value.syncModels === true
        ? { syncModels: true }
        : {}),
    ...(excludeModels.length > 0 ? { excludeModels } : {}),
  };
}

function parseBrain(raw: unknown): BrainConfig {
  const value = asRecord(raw);
  const timeoutMs = value.timeoutMs;
  const minConfidence = value.minConfidence;
  const accountId =
    typeof value.accountId === "string" && value.accountId.trim() ? value.accountId.trim() : "";
  return {
    channel: typeof value.channel === "string" && value.channel ? value.channel : "typesafe",
    ...(typeof value.baseUrl === "string" ? { baseUrl: value.baseUrl } : {}),
    ...(accountId ? { accountId } : {}),
    ...(typeof value.apiKeyEnv === "string" ? { apiKeyEnv: value.apiKeyEnv } : {}),
    ...(typeof value.model === "string" ? { model: value.model } : {}),
    timeoutMs: typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : DEFAULT_BRAIN.timeoutMs,
    minConfidence:
      typeof minConfidence === "number" && minConfidence >= 0 && minConfidence <= 1
        ? minConfidence
        : DEFAULT_BRAIN.minConfidence,
    ...(value.fullPrompt === true ? { fullPrompt: true } : {}),
  };
}

/** Accept a full URL or a bare hostname; strip trailing slashes. */
export function normalizeTunnelUrl(raw: string): string | undefined {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // hostname or hostname/path without a scheme — assume https
  if (/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:[/:].*)?$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return undefined;
}

export function parseTunnel(raw: unknown): TunnelConfig {
  const value = asRecord(raw);
  const provider =
    value.provider === "ngrok" || value.provider === "custom" ? value.provider : "cloudflare";
  const command =
    typeof value.command === "string" && value.command.trim() ? value.command : undefined;
  const url = typeof value.url === "string" ? normalizeTunnelUrl(value.url) : undefined;
  const publicPort =
    typeof value.publicPort === "number" &&
    Number.isInteger(value.publicPort) &&
    value.publicPort > 0
      ? value.publicPort
      : undefined;
  return {
    enabled: value.enabled === true,
    provider,
    ...(command ? { command } : {}),
    ...(url ? { url } : {}),
    ...(publicPort ? { publicPort } : {}),
  };
}

function parseQuotaGuard(raw: unknown): QuotaGuardConfig {
  const value = asRecord(raw);
  const lowPercent = value.lowPercent;
  return {
    enabled: value.enabled !== false,
    lowPercent:
      typeof lowPercent === "number" && lowPercent >= 0 && lowPercent <= 100
        ? lowPercent
        : DEFAULT_QUOTA_GUARD.lowPercent,
  };
}

/**
 * Parse optional per-model provider maps on a routing entry, in preference order.
 *
 * An explicit empty array is preserved rather than dropped: it is how a routing withholds a
 * model, so discarding it would turn "remove every provider" back into "use all of them".
 */
export function parseProviderOrder(raw: unknown): Record<string, string[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = asRecord(raw);
  const out: Record<string, string[]> = {};
  for (const [model, list] of Object.entries(value)) {
    if (model.length === 0) continue;
    if (!Array.isArray(list)) continue;
    out[model] = stringArray(list).filter((name) => name.length > 0);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseRoutingEntry(raw: unknown, index: number): RoutingEntry {
  const value = asRecord(raw);
  const id = value.id;
  if (typeof id !== "string" || !isRoutingId(id)) {
    throw new Error(
      `routing.routings[${index}].id must be a slug (lowercase letters, digits, hyphens; not "auto")`,
    );
  }
  const label = value.label;
  if (typeof label !== "string" || label.trim().length === 0) {
    throw new Error(`routing.routings[${index}].label must be a non-empty string`);
  }
  const description = typeof value.description === "string" ? value.description : "";
  const models = stringArray(value.models);
  // `providerOrder` is the field's older name; both spellings load so a config written by an
  // earlier build keeps its per-model provider pins.
  const providers = pruneProviderOrder(
    models,
    parseProviderOrder(value.providers ?? value.providerOrder),
  );
  return {
    id,
    label: label.trim(),
    description,
    models,
    ...(providers ? { providers } : {}),
  };
}

/**
 * Build the routings list from either the new `routings` array or a legacy `tiers` object.
 * Builtins are always present; custom entries append after them.
 */
export function parseRoutings(rawRoutings: unknown, rawTiers: unknown): RoutingEntry[] {
  const tiers = asRecord(rawTiers);
  const legacyModels: RoutingTiers = {
    plan: stringArray(tiers.plan),
    execute: stringArray(tiers.execute),
    utility: stringArray(tiers.utility),
    chat: stringArray(tiers.chat),
  };

  if (Array.isArray(rawRoutings) && rawRoutings.length > 0) {
    const parsed = rawRoutings.map(parseRoutingEntry);
    const seen = new Set<string>();
    for (const entry of parsed) {
      if (seen.has(entry.id)) {
        throw new Error(`routing.routings: duplicate id "${entry.id}"`);
      }
      seen.add(entry.id);
    }
    // Fill any missing builtins from defaults (or legacy tiers if present).
    const merged = defaultRoutings(legacyModels).map((builtin) => {
      const override = parsed.find((entry) => entry.id === builtin.id);
      return override ?? builtin;
    });
    const customs = parsed.filter((entry) => !isBuiltinRoutingId(entry.id));
    return [...merged, ...customs];
  }

  return defaultRoutings(legacyModels);
}

function parseRouting(raw: unknown): RoutingConfig {
  const value = asRecord(raw);
  const mode = value.mode ?? DEFAULT_ROUTING.mode;
  if (mode !== "auto" && mode !== "off") {
    throw new Error('routing.mode must be "auto" or "off"');
  }
  const sessionTtlMinutes = value.sessionTtlMinutes;
  const routings = parseRoutings(value.routings, value.tiers);
  return {
    mode,
    routings,
    tiers: tiersFromRoutings(routings),
    sessionTtlMinutes:
      typeof sessionTtlMinutes === "number" && sessionTtlMinutes > 0
        ? sessionTtlMinutes
        : DEFAULT_ROUTING.sessionTtlMinutes,
    ...(typeof value.baselineModel === "string" ? { baselineModel: value.baselineModel } : {}),
    ...(parseCapacities(value.capacities) ? { capacities: parseCapacities(value.capacities) } : {}),
    ...(typeof value.defaultEffort === "string" && isReasoningEffort(value.defaultEffort)
      ? { defaultEffort: value.defaultEffort }
      : {}),
    quotaGuard: parseQuotaGuard(value.quotaGuard),
    brains: parseBrains(value.brains, value.brain),
    brainPicksEffort: value.brainPicksEffort !== false,
  };
}

export function parseCapacities(raw: unknown): Record<string, ModelCapacityConfig> | undefined {
  const value = asRecord(raw);
  const entries: Array<[string, ModelCapacityConfig]> = [];
  for (const [model, rawCapacity] of Object.entries(value)) {
    const capacity = asRecord(rawCapacity);
    const contextWindow = capacity.contextWindow;
    const maxOutput = capacity.maxOutput;
    const efforts = stringArray(capacity.efforts).filter(isReasoningEffort);
    if (
      (typeof contextWindow !== "number" || contextWindow <= 0) &&
      (typeof maxOutput !== "number" || maxOutput <= 0) &&
      efforts.length === 0
    ) {
      continue;
    }
    entries.push([
      model,
      {
        ...(typeof contextWindow === "number" && contextWindow > 0 ? { contextWindow } : {}),
        ...(typeof maxOutput === "number" && maxOutput > 0 ? { maxOutput } : {}),
        ...(efforts.length > 0 ? { efforts } : {}),
      },
    ]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function parseBrains(rawBrains: unknown, rawBrain: unknown): BrainConfig[] {
  if (Array.isArray(rawBrains)) {
    return rawBrains.map((entry) => parseBrain(entry));
  }
  const legacy = asRecord(rawBrain);
  if (Object.keys(legacy).length > 0) return [parseBrain(legacy)];
  return [];
}

export function parseConfig(raw: unknown): Config {
  const value = asRecord(raw);
  const listen = asRecord(value.listen);
  const host = typeof listen.host === "string" ? listen.host : "127.0.0.1";
  const port =
    typeof listen.port === "number" && Number.isInteger(listen.port) ? listen.port : 8787;
  const providers = Array.isArray(value.providers) ? value.providers.map(parseProvider) : [];
  const tunnel = parseTunnel(value.tunnel);
  const aliases = asRecord(value.modelAliases);
  const modelAliases: Record<string, string[]> = {};
  for (const [canonical, entry] of Object.entries(aliases)) {
    const models = stringArray(entry);
    if (models.length > 0) modelAliases[canonical] = models;
  }
  return {
    listen: { host, port },
    ...(typeof value.defaultProvider === "string"
      ? { defaultProvider: value.defaultProvider }
      : {}),
    providers,
    ...(Object.keys(modelAliases).length > 0 ? { modelAliases } : {}),
    tunnel,
    routing: parseRouting(value.routing),
    modelSync: parseModelSync(value.modelSync),
  };
}

export function loadConfig(): Config | null {
  const path = configPath();
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return parseConfig(raw);
}

export function writeExampleConfig(): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const example: Config = {
    listen: { host: "127.0.0.1", port: 8787 },
    defaultProvider: "deepseek",
    tunnel: { enabled: false, provider: "cloudflare" },
    providers: [
      {
        name: "deepseek",
        type: "both",
        baseUrl: "https://api.deepseek.com/v1",
        apiKeyEnv: "DEEPSEEK_API_KEY",
        auth: "api-key",
        billing: "api",
        models: modelEntries("deepseek-v4.1-flash", "deepseek-v4-pro"),
        injectStreamUsage: true,
      },
    ],
    routing: {
      mode: "auto",
      routings: defaultRoutings({
        plan: ["deepseek-v4-pro"],
        execute: ["deepseek-v4.1-flash"],
        utility: ["deepseek-v4.1-flash"],
        chat: ["deepseek-v4.1-flash"],
      }),
      tiers: {
        plan: ["deepseek-v4-pro"],
        execute: ["deepseek-v4.1-flash"],
        utility: ["deepseek-v4.1-flash"],
        chat: ["deepseek-v4.1-flash"],
      },
      sessionTtlMinutes: 720,
      baselineModel: "deepseek-v4-pro",
      quotaGuard: { enabled: true, lowPercent: 10 },
      brains: [],
      brainPicksEffort: true,
    },
    modelSync: { enabled: true, intervalMinutes: 720 },
  };
  writeFileSync(path, `${JSON.stringify(example, null, 2)}\n`);
  return path;
}

export function saveConfig(config: Config): string {
  const path = configPath();
  mkdirSync(dirname(path), { recursive: true });
  const serializable = {
    ...config,
    providers: config.providers.map((provider) => ({
      ...provider,
      models: provider.models.map(serializeModelEntry),
    })),
  };
  writeFileSync(path, `${JSON.stringify(serializable, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export type ApiKeySource = "inline" | "credentials" | `env:${string}` | `oauth:${string}` | "none";

export function apiKeySource(provider: Provider): ApiKeySource {
  if (provider.auth === "oauth" && provider.oauthSource && provider.oauthSource !== "static") {
    return hasOAuthCredential(provider.oauthSource) ? `oauth:${provider.oauthSource}` : "none";
  }
  if (provider.apiKey) return "inline";
  if (getCredential(provider.name)) {
    return provider.auth === "oauth" ? "oauth:static" : "credentials";
  }
  if (provider.apiKeyEnv && process.env[provider.apiKeyEnv]) return `env:${provider.apiKeyEnv}`;
  return "none";
}

export function resolveApiKey(provider: Provider): string | undefined {
  if (provider.apiKey) return provider.apiKey;
  const stored = getCredential(provider.name);
  if (stored) return stored;
  if (provider.apiKeyEnv) return process.env[provider.apiKeyEnv];
  return undefined;
}

export function findProviderByName(config: Config, name: string): Provider | undefined {
  return config.providers.find((provider) => provider.name === name);
}

export function resolveProvider(config: Config, model: string): Provider | undefined {
  const exact = config.providers.find((provider) => providerHasModel(provider, model));
  if (exact) return exact;
  if (config.defaultProvider) {
    return config.providers.find((provider) => provider.name === config.defaultProvider);
  }
  return config.providers[0];
}
