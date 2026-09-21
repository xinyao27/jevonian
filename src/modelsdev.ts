import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ProviderType } from "./config";
import { dataDir } from "./paths";
import type { ModelPrice } from "./pricing";
import { typeFromNpm } from "./providers";

export const MODELS_DEV_URL = process.env.JEVONIAN_MODELS_DEV_URL ?? "https://models.dev/api.json";

export const OFFICIAL_PROVIDERS = new Set([
  "alibaba",
  "anthropic",
  "deepseek",
  "google",
  "meta",
  "minimax",
  "mistral",
  "moonshotai",
  "openai",
  "qwen",
  "tencent",
  "xai",
  "xiaomi",
  "zai",
]);

export interface PricingSnapshot {
  fetchedAt: string;
  source: string;
  models: Record<string, ModelPrice>;
  providers: Record<string, ProviderMeta>;
  /** Window and thinking support per model id, keyed like `models` (id and bare id). */
  capabilities?: Record<string, CatalogCapabilities>;
  /** Vendor name and brand line per model id, keyed like `models` (id and bare id). */
  identities?: Record<string, CatalogIdentity>;
}

/** What the catalog states about a model's limits. Absent fields mean "not stated". */
export interface CatalogCapabilities {
  contextWindow?: number;
  maxOutput?: number;
  efforts?: string[];
}

export interface ProviderMeta {
  id: string;
  name: string;
  api?: string;
  env: string[];
  type: ProviderType;
}

/**
 * What the catalog states about a model's identity. `name` is the vendor's own label
 * ("DeepSeek V4.1 Flash"), which is the one field that survives a provider renaming a model —
 * official `deepseek-flash` and a reseller's `deepseek-v4.1-flash` carry the same name, so
 * identity can be resolved without hand-written aliases. `family` is a coarser brand line and
 * is kept for diagnostics only: it is far too wide to route on.
 */
export interface CatalogIdentity {
  name?: string;
  family?: string;
  releaseDate?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function bare(modelId: string): string {
  return modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Reasoning levels models.dev lists, plus the boolean `thinking`/`reasoning` flags. */
function reasoningEfforts(record: Record<string, unknown>): string[] | undefined {
  const listed = record.reasoning;
  if (Array.isArray(listed)) {
    const values = listed.filter((entry): entry is string => typeof entry === "string");
    if (values.length > 0) return values;
  }
  // Newer models.dev rows: reasoning_options: [{ type: "effort", values: ["low","medium","high"] }]
  // Gemini 3.8 Flash is in this shape — and notably omits `none`, because reasoning is mandatory.
  const options = record.reasoning_options;
  if (Array.isArray(options)) {
    for (const raw of options) {
      const option = asRecord(raw);
      if (option.type !== "effort" || !Array.isArray(option.values)) continue;
      const values = option.values.filter((entry): entry is string => typeof entry === "string");
      if (values.length > 0) return values;
    }
  }
  if (record.thinking === true || listed === true) {
    // Boolean "has reasoning" without a level list: allow thinking levels, but not an explicit
    // off — sending `reasoning_effort: "none"` to OpenRouter's Gemini endpoints is rejected
    // with "Reasoning is mandatory for this endpoint and cannot be disabled."
    return ["minimal", "low", "medium", "high", "max"];
  }
  return undefined;
}

/**
 * Limits models.dev states for one model. Extracted separately from pricing so a model with
 * no published cost still contributes its context window.
 */
export function catalogCapabilities(modelRaw: unknown): CatalogCapabilities | undefined {
  const record = asRecord(modelRaw);
  const limit = asRecord(record.limit);
  const contextWindow = number(limit.context);
  const maxOutput = number(limit.output);
  const efforts = reasoningEfforts(record);
  const caps: CatalogCapabilities = {
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutput === undefined ? {} : { maxOutput }),
    ...(efforts ? { efforts } : {}),
  };
  return Object.keys(caps).length > 0 ? caps : undefined;
}

/**
 * Every model in the catalog mapped to its stated limits, keyed the way pricing is keyed so
 * a lookup by configured provider, by vendor-qualified id, or by bare id all resolve.
 */
export function mapCapabilities(payload: unknown): Record<string, CatalogCapabilities> {
  const providers = asRecord(payload);
  const table: Record<string, CatalogCapabilities> = {};

  const merge = (key: string, caps: CatalogCapabilities): void => {
    const existing = table[key];
    if (!existing) {
      table[key] = caps;
      return;
    }
    table[key] = {
      contextWindow: existing.contextWindow ?? caps.contextWindow,
      maxOutput: existing.maxOutput ?? caps.maxOutput,
      efforts: existing.efforts ?? caps.efforts,
    };
  };

  for (const [providerId, providerRaw] of Object.entries(providers)) {
    const models = asRecord(asRecord(providerRaw).models);
    for (const [modelId, modelRaw] of Object.entries(models)) {
      const caps = catalogCapabilities(modelRaw);
      if (!caps) continue;
      merge(`${providerId}/${modelId}`, caps);
      // A snapshot read does not re-derive the configured provider name, so also index the
      // short provider key and the bare id — the same three shapes priceFor resolves.
      const providerKey = providerId.slice(providerId.lastIndexOf("/") + 1);
      merge(`${providerKey}/${bare(modelId)}`, caps);
      merge(bare(modelId), caps);
    }
  }
  return table;
}

/**
 * Every model's vendor label and brand line, keyed the way pricing and capabilities are keyed so
 * identity resolves from a configured provider, from a vendor-qualified id, or from a bare id.
 * Official providers win a bare key, mirroring `mapModelsDev`: the official entry is the one that
 * names the model rather than reselling it.
 */
export function mapIdentities(payload: unknown): Record<string, CatalogIdentity> {
  const providers = asRecord(payload);
  const table: Record<string, CatalogIdentity> = {};
  const official = new Set<string>();

  const add = (key: string, identity: CatalogIdentity, providerId: string): void => {
    if (table[key] && official.has(key) && !OFFICIAL_PROVIDERS.has(providerId)) return;
    if (!table[key] || OFFICIAL_PROVIDERS.has(providerId)) {
      table[key] = identity;
      if (OFFICIAL_PROVIDERS.has(providerId)) official.add(key);
    }
  };

  for (const [providerId, providerRaw] of Object.entries(providers)) {
    const models = asRecord(asRecord(providerRaw).models);
    for (const [modelId, modelRaw] of Object.entries(models)) {
      const record = asRecord(modelRaw);
      const name = typeof record.name === "string" && record.name.length > 0 ? record.name : "";
      const family =
        typeof record.family === "string" && record.family.length > 0 ? record.family : "";
      const releaseDate =
        typeof record.release_date === "string" && record.release_date.length > 0
          ? record.release_date
          : "";
      if (!name && !family && !releaseDate) continue;
      const identity: CatalogIdentity = {
        ...(name ? { name } : {}),
        ...(family ? { family } : {}),
        ...(releaseDate ? { releaseDate } : {}),
      };
      const bareKey = bare(modelId);
      const providerKey = providerId.slice(providerId.lastIndexOf("/") + 1);
      add(`${providerId}/${modelId}`, identity, providerId);
      add(`${providerKey}/${bareKey}`, identity, providerId);
      add(bareKey, identity, providerId);
    }
  }
  return table;
}

export function mapModelsDev(payload: unknown): Record<string, ModelPrice> {
  const providers = asRecord(payload);
  const table: Record<string, ModelPrice> = {};
  for (const [providerId, providerRaw] of Object.entries(providers)) {
    const models = asRecord(asRecord(providerRaw).models);
    for (const [modelId, modelRaw] of Object.entries(models)) {
      const cost = asRecord(asRecord(modelRaw).cost);
      if (typeof cost.input !== "number" || typeof cost.output !== "number") continue;
      const entry: ModelPrice = {
        provider: providerId,
        input: cost.input,
        output: cost.output,
        ...(typeof cost.cache_read === "number" ? { cacheRead: cost.cache_read } : {}),
        ...(typeof cost.cache_write === "number" ? { cacheWrite: cost.cache_write } : {}),
      };
      const qualifiedKey = `${providerId}/${modelId}`;
      if (!table[qualifiedKey]) table[qualifiedKey] = entry;

      const bareKey = bare(modelId);
      const preferBare =
        !table[bareKey] ||
        (!OFFICIAL_PROVIDERS.has(table[bareKey]?.provider ?? "") &&
          OFFICIAL_PROVIDERS.has(providerId));
      if (preferBare && bareKey !== qualifiedKey) table[bareKey] = entry;

      // Price lookup qualifies by the configured provider name only, so also register
      // the bare provider name — models.dev nests resellers under their own ids
      // (`nano-gpt/google/gemini-3.8-flash`) and those would otherwise never match.
      const providerKey = providerId.slice(providerId.lastIndexOf("/") + 1);
      const aliasKey = `${providerKey}/${bareKey}`;
      if (aliasKey !== qualifiedKey && !table[aliasKey]) table[aliasKey] = entry;
    }
  }
  return table;
}

export function mapModelsDevProviders(payload: unknown): Record<string, ProviderMeta> {
  const providers = asRecord(payload);
  const meta: Record<string, ProviderMeta> = {};
  for (const [providerId, providerRaw] of Object.entries(providers)) {
    const value = asRecord(providerRaw);
    const env = Array.isArray(value.env)
      ? value.env.filter((item): item is string => typeof item === "string")
      : [];
    meta[providerId] = {
      id: providerId,
      name: typeof value.name === "string" ? value.name : providerId,
      ...(typeof value.api === "string" ? { api: value.api } : {}),
      env,
      type: typeFromNpm(typeof value.npm === "string" ? value.npm : undefined),
    };
  }
  return meta;
}

export function pricingPath(): string {
  return join(dataDir(), "pricing.json");
}

/** The parsed snapshot file, cached until its mtime or size changes. */
let snapshotCache:
  | {
      path: string;
      mtimeMs: number;
      size: number;
      snapshot: Partial<PricingSnapshot>;
    }
  | undefined;

function loadSnapshotFile(): Partial<PricingSnapshot> {
  const path = pricingPath();
  if (!existsSync(path)) return {};
  try {
    const stat = statSync(path);
    if (
      snapshotCache &&
      snapshotCache.path === path &&
      snapshotCache.mtimeMs === stat.mtimeMs &&
      snapshotCache.size === stat.size
    ) {
      return snapshotCache.snapshot;
    }
    const snapshot = JSON.parse(readFileSync(path, "utf8")) as Partial<PricingSnapshot>;
    if (typeof snapshot !== "object" || snapshot === null) return {};
    snapshotCache = { path, mtimeMs: stat.mtimeMs, size: stat.size, snapshot };
    return snapshot;
  } catch {
    return {};
  }
}

export function loadPricingSnapshot(): Record<string, ModelPrice> | null {
  const snapshot = loadSnapshotFile();
  if (typeof snapshot.models !== "object" || snapshot.models === null) return null;
  return snapshot.models as Record<string, ModelPrice>;
}

export function loadProviderMeta(): Record<string, ProviderMeta> {
  return (loadSnapshotFile().providers ?? {}) as Record<string, ProviderMeta>;
}

/** Stated limits from the cached snapshot. Empty when no snapshot has been written yet. */
export function loadCapabilities(): Record<string, CatalogCapabilities> {
  return (loadSnapshotFile().capabilities ?? {}) as Record<string, CatalogCapabilities>;
}

/** Vendor names from the cached snapshot. Empty when no snapshot has been written yet. */
export function loadIdentities(): Record<string, CatalogIdentity> {
  return (loadSnapshotFile().identities ?? {}) as Record<string, CatalogIdentity>;
}

export function savePricingSnapshot(
  models: Record<string, ModelPrice>,
  providers: Record<string, ProviderMeta> = {},
  capabilities: Record<string, CatalogCapabilities> = {},
  identities: Record<string, CatalogIdentity> = {},
): PricingSnapshot {
  const snapshot: PricingSnapshot = {
    fetchedAt: new Date().toISOString(),
    source: MODELS_DEV_URL,
    models,
    providers,
    capabilities,
    identities,
  };
  const path = pricingPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot)}\n`);
  return snapshot;
}

export async function refreshPricing(): Promise<{
  models: number;
  providers: number;
  capabilities: number;
  identities: number;
  fetchedAt: string;
  source: string;
}> {
  const response = await fetch(MODELS_DEV_URL);
  if (!response.ok) throw new Error(`models.dev responded with HTTP ${response.status}`);
  const payload = await response.json();
  const models = mapModelsDev(payload);
  const providers = mapModelsDevProviders(payload);
  const capabilities = mapCapabilities(payload);
  const identities = mapIdentities(payload);
  const snapshot = savePricingSnapshot(models, providers, capabilities, identities);
  return {
    models: Object.keys(models).length,
    providers: Object.keys(providers).length,
    capabilities: Object.keys(capabilities).length,
    identities: Object.keys(identities).length,
    fetchedAt: snapshot.fetchedAt,
    source: snapshot.source,
  };
}
