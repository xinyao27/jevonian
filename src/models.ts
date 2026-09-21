import type { Config, Provider } from "./config";
import { providerHasModel } from "./config";
import { identityFrom, identityKey, type ModelIdentity } from "./identity";
import { identityCache } from "./identityIndex";
import { OFFICIAL_PROVIDERS, type CatalogIdentity } from "./modelsdev";
import { canServeClient, type ClientWire } from "./wire";

export interface ModelVariant {
  provider: string;
  model: string;
  /** Same vendor label and serving mode as the requested id — not guessed from spelling. */
  viaIdentity?: boolean;
  /** The configured provider is the vendor that owns this model, not a reseller of it. */
  official?: boolean;
}

export interface CanonicalModel {
  id: string;
  variants: ModelVariant[];
  /** The catalog's label for this model, when it names one. */
  name?: string;
  /** The catalog's brand line. Diagnostics only: it spans many distinct models. */
  family?: string;
}

const DATE_SUFFIX = /-\d{8}$/;
const SERVICE_TIER_SUFFIX = /-tiered$/;

export function canonicalModelId(model: string): string {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return tail
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(DATE_SUFFIX, "")
    .replace(SERVICE_TIER_SUFFIX, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The catalog indexed for identity lookup, cached per snapshot object. Keys cover the three
 * shapes pricing resolves (qualified, provider-qualified bare, bare) plus a canonical-id
 * fallback, so a tier written `deepseek-v4-1-flash` finds the catalog's `deepseek-v4.1-flash`
 * entry. A label that names the model beats a brand-line-only entry.
 */
const identityCaches = new WeakMap<object, IdentityCatalog>();

interface IdentityCatalog {
  byKey: Map<string, CatalogIdentity>;
  byBare: Map<string, CatalogIdentity>;
  byCanonical: Map<string, CatalogIdentity>;
}

function identityCatalog(): IdentityCatalog {
  const snapshot = identityCache.snapshot();
  const cached = identityCaches.get(snapshot);
  if (cached) return cached;
  const byKey = new Map<string, CatalogIdentity>();
  const byBare = new Map<string, CatalogIdentity>();
  const byCanonical = new Map<string, CatalogIdentity>();
  const claim = (map: Map<string, CatalogIdentity>, key: string, identity: CatalogIdentity) => {
    const existing = map.get(key);
    // Prefer an entry that actually names the model, and among those an official vendor's —
    // resellers often ship the same id as the vendor with a reseller-flavoured label.
    const better =
      !existing ||
      (!existing.name && Boolean(identity.name)) ||
      (existing.name && identity.name && OFFICIAL_PROVIDERS.has(identityOfVendor(key)));
    if (better) map.set(key, identity);
  };
  for (const row of snapshot.rows) {
    const identity = toCatalog(row.identity);
    claim(byKey, row.key, identity);
    claim(byBare, row.model, identity);
    const canonical = canonicalModelId(row.model);
    if (canonical.length > 0) claim(byCanonical, canonical, identity);
  }
  const catalog: IdentityCatalog = { byKey, byBare, byCanonical };
  identityCaches.set(snapshot, catalog);
  return catalog;
}

function identityOfVendor(key: string): string {
  return key.includes("/") ? key.slice(0, key.indexOf("/")) : "";
}

/**
 * What the catalog states about one model id: its vendor label, brand line, and serving mode.
 * Lookup order mirrors pricing: the id as written, its bare form, then the canonical id — the
 * last one is what lets `deepseek-v4-1-flash` find `DeepSeek V4.1 Flash`.
 */
export function identityOf(model: string): ModelIdentity {
  const catalog = identityCatalog();
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const stated =
    catalog.byKey.get(model) ??
    catalog.byBare.get(tail) ??
    catalog.byCanonical.get(canonicalModelId(model));
  return identityFrom(model, stated);
}

function toCatalog(identity: ModelIdentity): CatalogIdentity {
  return {
    ...(identity.displayName ? { name: identity.displayName } : {}),
    ...(identity.family ? { family: identity.family } : {}),
    ...(identity.releaseDate ? { releaseDate: identity.releaseDate } : {}),
  };
}

/** The identity key a model resolves to, or `undefined` when the catalog does not name it. */
export function identityKeyOf(model: string): string | undefined {
  return identityKey(identityOf(model));
}

/**
 * Whether a configured provider is the vendor that owns the requested model. A provider counts as
 * official when the catalog lists the same identity under a vendor id the provider advertises as
 * its own endpoint — `deepseek` for `DeepSeek V4.1 Flash` — resolved through provider metadata
 * first and a tail-segment fallback second.
 */
export function isOfficial(config: Config, providerName: string, requested: string): boolean {
  const identity = identityOf(requested);
  if (!identity.label) return false;
  const winners = identityCache.snapshot().officialByLabel.get(identity.label);
  if (!winners || winners.size === 0) return false;
  const provider = config.providers.find((candidate) => candidate.name === providerName);
  if (!provider) return false;
  for (const vendor of winners) {
    if (matchesVendor(provider, vendor)) return true;
  }
  return false;
}

/**
 * A tier entry's catalog identity and the configured endpoints that serve that identity.
 * Successful automatic matches are included so doctor can explain why no alias is needed.
 */
export interface IdentityGap {
  model: string;
  identity: ModelIdentity;
  official: Array<{ provider: string; model: string }>;
  sameModel: Array<{ provider: string; model: string; official: boolean }>;
  suggestion?: string;
}

/**
 * Reports same-identity endpoints in configuration order, retaining their actual wire ids.
 * Official status belongs to the configured provider, not to whichever catalog row supplied
 * the label. Pure computation: no network, no config writes.
 */
export function identityGaps(config: Config, models: string[]): IdentityGap[] {
  const gaps: IdentityGap[] = [];
  for (const model of models) {
    const identity = identityOf(model);
    if (!identity.label) continue;
    const sameModel: Array<{ provider: string; model: string; official: boolean }> = [];
    const official: Array<{ provider: string; model: string }> = [];
    for (const provider of config.providers) {
      for (const candidate of provider.models) {
        if (identityKeyOf(candidate.id) !== identityKey(identity)) continue;
        const entry = {
          provider: provider.name,
          model: candidate.id,
          official: isOfficial(config, provider.name, model),
        };
        sameModel.push(entry);
        if (entry.official) official.push({ provider: entry.provider, model: entry.model });
      }
    }
    if (sameModel.length === 0) continue;
    gaps.push({
      model,
      identity,
      official,
      sameModel,
      suggestion: suggestionFor(config, model, official),
    });
  }
  return gaps;
}

function suggestionFor(
  config: Config,
  model: string,
  official: Array<{ provider: string; model: string }>,
): string | undefined {
  const pinned = config.modelAliases?.[model] ?? [];
  const target = official[0] ?? null;
  if (!target) return undefined;
  const exact = `${target.provider}/${target.model}`;
  if (pinned.includes(exact)) return undefined;
  if (
    canonicalVariants(config, model).some(
      (variant) => variant.provider === target.provider && variant.model === target.model,
    )
  )
    return undefined;
  return `modelAliases: { "${model}": ["${exact}"] }`;
}

function matchesVendorName(name: string, baseUrl: string, vendor: string): boolean {
  if (name === vendor) return true;
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host.length > 0 && (host === vendor || host.endsWith(`.${vendor}`));
  } catch {
    return false;
  }
}

function matchesVendor(provider: Provider, vendor: string): boolean {
  return matchesVendorName(provider.name, provider.baseUrl, vendor);
}
const aliasCache = new WeakMap<Config, Map<string, ModelVariant[]>>();
function aliasIndex(config: Config): Map<string, ModelVariant[]> {
  const cached = aliasCache.get(config);
  if (cached) return cached;
  const index = new Map<string, ModelVariant[]>();
  for (const [canonical, entries] of Object.entries(config.modelAliases ?? {})) {
    const key = canonicalModelId(canonical);
    if (key.length === 0) continue;
    const variants = index.get(key) ?? [];
    for (const entry of entries) {
      const slash = entry.indexOf("/");
      const providerName = slash > 0 ? entry.slice(0, slash) : "";
      const provider = config.providers.find((candidate) => candidate.name === providerName);
      if (provider) {
        variants.push({ provider: provider.name, model: entry.slice(slash + 1) });
        continue;
      }
      for (const candidate of config.providers) {
        if (providerHasModel(candidate, entry)) {
          variants.push({ provider: candidate.name, model: entry });
        }
      }
    }
    index.set(key, variants);
  }
  aliasCache.set(config, index);
  return index;
}

export function canonicalVariants(
  config: Config,
  requested: string,
  kind?: ClientWire,
): ModelVariant[] {
  const key = canonicalModelId(requested);
  if (key.length === 0) return [];
  // A provider may serve the same model under an unrelated id — the official `deepseek-flash` is
  // the model every reseller spells `deepseek-v4.1-flash`. The catalog's own label identifies it,
  // and the serving mode keeps promo, batch, fast and thinking routes out of the pool. Providers
  // are still tried in config order: identity widens who can serve the turn, it never reorders
  // who wins it.
  const identity = identityKeyOf(requested);
  const variants: ModelVariant[] = [];
  const seen = new Set<string>();
  const push = (provider: Provider, model: string, viaIdentity = false): void => {
    if (kind && !canServeClient(provider, kind)) return;
    const id = `${provider.name}/${model}`;
    if (seen.has(id)) return;
    seen.add(id);
    variants.push({
      provider: provider.name,
      model,
      ...(viaIdentity ? { viaIdentity: true } : {}),
      ...(isOfficial(config, provider.name, requested) ? { official: true } : {}),
    });
  };
  for (const variant of aliasIndex(config).get(key) ?? []) {
    const provider = config.providers.find((candidate) => candidate.name === variant.provider);
    if (provider) push(provider, variant.model);
  }
  for (const provider of config.providers) {
    for (const model of provider.models) {
      if (canonicalModelId(model.id) === key) {
        push(provider, model.id);
      } else if (identity && identityKeyOf(model.id) === identity) {
        push(provider, model.id, true);
      }
    }
  }
  return variants;
}

/**
 * Every canonical id with the providers that serve it, in the order routing would try them:
 * alias-pinned variants first, then providers in config order. Clients read this to see both
 * who can serve a model and who wins the turn.
 */
export function canonicalModels(config: Config): CanonicalModel[] {
  const ids = new Set<string>();
  for (const provider of config.providers) {
    for (const model of provider.models) {
      const id = canonicalModelId(model.id);
      if (id.length > 0) ids.add(id);
    }
  }
  for (const id of aliasIndex(config).keys()) ids.add(id);
  return [...ids]
    .sort((left, right) => left.localeCompare(right))
    .map((id) => ({ id, variants: canonicalVariants(config, id), ...identityLabels(id) }))
    .filter((entry) => entry.variants.length > 0);
}

/** The catalog's label and brand line for a canonical id, when the catalog names one. */
function identityLabels(id: string): { name?: string; family?: string } {
  const identity = identityOf(id);
  return {
    ...(identity.displayName ? { name: identity.displayName } : {}),
    ...(identity.family ? { family: identity.family } : {}),
  };
}
