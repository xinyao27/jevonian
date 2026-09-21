import { identityFrom, type ModelIdentity } from "./identity";
import { canonicalModelId } from "./models";
import type { CatalogIdentity } from "./modelsdev";
import { loadIdentities, OFFICIAL_PROVIDERS } from "./modelsdev";

/** A catalog row with the catalog key it was stored under. */
export interface StoredIdentity {
  key: string;
  /** The bare model segment of the key. */
  model: string;
  identity: ModelIdentity;
  /** The catalog lists this row under a vendor id, not a reseller id. */
  official: boolean;
}

/** The raw snapshot materialized for lookup: rows, canonical fallbacks, official winners. */
export interface IdentitySnapshot {
  rows: StoredIdentity[];
  /** Rows sharing a canonical id, so a differently spelled tier entry still finds its label. */
  byCanonical: Map<string, StoredIdentity[]>;
  /** Vendor ids that publish a model under a given comparable label. */
  officialByLabel: Map<string, Set<string>>;
  /** Rows grouped by label, for diagnostics and gap analysis. */
  byLabel: Map<string, StoredIdentity[]>;
}

const snapshots = new WeakMap<object, IdentitySnapshot>();

/** The raw snapshot materialized once: canonical groups, official vendors, label rows. */
export function identitySnapshot(): IdentitySnapshot {
  const raw = loadIdentities();
  const cached = snapshots.get(raw);
  if (cached) return cached;

  const rows: StoredIdentity[] = [];
  for (const [key, entry] of Object.entries(raw)) {
    const model = key.slice(key.lastIndexOf("/") + 1) || key;
    const identity = identityFrom(model, entry as CatalogIdentity | undefined);
    const vendor = key.includes("/") ? key.slice(0, key.indexOf("/")) : "";
    rows.push({
      key,
      model,
      identity,
      official: Boolean(vendor) && OFFICIAL_PROVIDERS.has(vendor),
    });
  }

  const byCanonical = new Map<string, StoredIdentity[]>();
  for (const row of rows) {
    const canonical = canonicalModelId(row.model);
    if (canonical.length === 0) continue;
    const list = byCanonical.get(canonical) ?? [];
    list.push(row);
    byCanonical.set(canonical, list);
  }

  const officialByLabel = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!row.official || !row.identity.label) continue;
    const vendor = row.key.includes("/") ? row.key.slice(0, row.key.indexOf("/")) : "";
    if (!vendor) continue;
    const label = row.identity.label;
    const set = officialByLabel.get(label) ?? new Set<string>();
    set.add(vendor);
    officialByLabel.set(label, set);
  }

  const byLabel = new Map<string, StoredIdentity[]>();
  for (const row of rows) {
    if (!row.identity.label) continue;
    const list = byLabel.get(row.identity.label) ?? [];
    list.push(row);
    byLabel.set(row.identity.label, list);
  }

  const snapshot: IdentitySnapshot = { rows, byCanonical, officialByLabel, byLabel };
  snapshots.set(raw, snapshot);
  return snapshot;
}

/** All catalog rows sharing a comparable label, for diagnostics. */
export function identityRowsForLabel(label: string): StoredIdentity[] {
  return identitySnapshot().byLabel.get(label) ?? [];
}

/** Resolved lookup helpers shared by routing and diagnostics. */
export const identityCache = {
  snapshot: identitySnapshot,
  rowsForLabel: identityRowsForLabel,
};
