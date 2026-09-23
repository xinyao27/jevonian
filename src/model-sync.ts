import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { discoverProviderModels } from "./catalog";
import {
  appendDiscoveredModels,
  MIN_MODEL_SYNC_INTERVAL_MINUTES,
  providerSyncsModels,
  type Config,
  type Provider,
} from "./config";
import { modelSyncStatePath } from "./paths";

/**
 * How often `serve` wakes to ask "is a pass due?". It is the smallest interval the config
 * accepts, so any `modelSync.intervalMinutes` is honoured to within one tick; whether a pass
 * actually runs is decided by `isModelSyncFresh` against the configured interval.
 */
export const MODEL_SYNC_POLL_MS = MIN_MODEL_SYNC_INTERVAL_MINUTES * 60 * 1_000;

export type ModelSyncSkip =
  /** `syncModels: false` on the provider. */
  | "opted-out"
  /** No `syncModels` and not an OAuth source that syncs by default (API key / reseller). */
  | "default-off";

export interface ProviderSyncResult {
  provider: string;
  /** Ids this pass appended, in discovery order. */
  added: string[];
  skipped?: ModelSyncSkip;
  error?: string;
}

export interface ModelSyncResult {
  checkedAt: string;
  providers: ProviderSyncResult[];
  /** Total ids appended across every provider. */
  added: number;
  /** True when the merged config differs from the one passed in. */
  changed: boolean;
}

interface ModelSyncState {
  checkedAt: string;
  added: number;
  providers: ProviderSyncResult[];
}

/**
 * One discovery pass over the configured providers, merged append-only.
 *
 * Discovery is the only writer of new ids: it never removes, reorders, or rewrites an existing
 * entry, so a per-model wire pin, a manual removal (`excludeModels`), and the operator's chosen
 * order all survive. A provider that fails discovery contributes its error and nothing else —
 * a network blip must not shrink a working model list.
 */
export async function syncProviderModels(
  config: Config,
  options: {
    discover?: (provider: Provider) => Promise<{ models: string[]; error?: string }>;
    now?: () => number;
  } = {},
): Promise<{ config: Config; result: ModelSyncResult }> {
  const discover = options.discover ?? discoverProviderModels;
  const now = options.now ?? Date.now;
  const providers: Provider[] = [];
  const results: ProviderSyncResult[] = [];
  let added = 0;

  for (const provider of config.providers) {
    if (!providerSyncsModels(provider)) {
      providers.push(provider);
      results.push({
        provider: provider.name,
        added: [],
        skipped: provider.syncModels === false ? "opted-out" : "default-off",
      });
      continue;
    }
    try {
      const entry = await discover(provider);
      const merged = appendDiscoveredModels(provider, entry.models);
      providers.push(merged.provider);
      added += merged.added.length;
      results.push({
        provider: provider.name,
        added: merged.added,
        ...(entry.error ? { error: entry.error } : {}),
      });
    } catch (error) {
      providers.push(provider);
      results.push({
        provider: provider.name,
        added: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    config: { ...config, providers },
    result: {
      checkedAt: new Date(now()).toISOString(),
      providers: results,
      added,
      changed: added > 0,
    },
  };
}

/**
 * Run discovery and persist the merged config, re-reading from disk first so a dashboard edit
 * made while discovery was in flight is not clobbered by a stale snapshot.
 *
 * The loader is called twice on purpose: the first read decides what to probe, the second is
 * merged onto. `save` receives that merged config, and the returned result reports only the ids
 * that actually landed on it — an id the operator added (or a provider they deleted) while
 * discovery ran is not counted as appended.
 */
export async function runModelSync(options: {
  load: () => Config | null;
  save: (config: Config) => void;
  discover?: (provider: Provider) => Promise<{ models: string[]; error?: string }>;
  now?: () => number;
}): Promise<{ config: Config | null; result: ModelSyncResult } | null> {
  const planned = options.load();
  if (!planned || planned.providers.length === 0) return null;

  const { result } = await syncProviderModels(planned, {
    ...(options.discover ? { discover: options.discover } : {}),
    ...(options.now ? { now: options.now } : {}),
  });

  const fresh = options.load() ?? planned;
  const landed = new Map<string, string[]>();
  const providers = fresh.providers.map((provider) => {
    const entry = result.providers.find((candidate) => candidate.provider === provider.name);
    if (!entry || entry.added.length === 0) return provider;
    const merged = appendDiscoveredModels(provider, entry.added);
    landed.set(provider.name, merged.added);
    return merged.provider;
  });

  const perProvider = result.providers.map((entry) => ({
    ...entry,
    added: landed.get(entry.provider) ?? [],
  }));
  const added = perProvider.reduce((sum, entry) => sum + entry.added.length, 0);
  const next: Config = { ...fresh, providers };
  const changed = added > 0;
  const settled: ModelSyncResult = { ...result, providers: perProvider, added, changed };
  if (changed) options.save(next);
  saveModelSyncState(settled);
  return { config: next, result: settled };
}

export function saveModelSyncState(result: ModelSyncResult): void {
  const path = modelSyncStatePath();
  const state: ModelSyncState = {
    checkedAt: result.checkedAt,
    added: result.added,
    providers: result.providers,
  };
  try {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(temporary, path);
  } catch {
    // Status reporting is best effort and must never fail a sync.
  }
}

export function loadModelSyncState(): ModelSyncState | null {
  const path = modelSyncStatePath();
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof raw.checkedAt !== "string") return null;
    return {
      checkedAt: raw.checkedAt,
      added: typeof raw.added === "number" ? raw.added : 0,
      providers: Array.isArray(raw.providers) ? raw.providers.flatMap(parseProviderSyncResult) : [],
    };
  } catch {
    return null;
  }
}

/** The state file is hand-editable and outlives versions, so every entry is re-validated. */
function parseProviderSyncResult(raw: unknown): ProviderSyncResult[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const value = raw as Record<string, unknown>;
  if (typeof value.provider !== "string") return [];
  const added = Array.isArray(value.added)
    ? value.added.filter((id): id is string => typeof id === "string")
    : [];
  const skipped =
    value.skipped === "opted-out" || value.skipped === "default-off" ? value.skipped : undefined;
  return [
    {
      provider: value.provider,
      added,
      ...(skipped ? { skipped } : {}),
      ...(typeof value.error === "string" ? { error: value.error } : {}),
    },
  ];
}

export function isModelSyncFresh(intervalMinutes: number, now = Date.now()): boolean {
  const state = loadModelSyncState();
  if (!state) return false;
  const checked = Date.parse(state.checkedAt);
  if (!Number.isFinite(checked)) return false;
  return now - checked < intervalMinutes * 60_000;
}

/**
 * Background discovery for `serve`. Wakes every `MODEL_SYNC_POLL_MS` and runs a pass only when
 * the last one (recorded on disk) is older than `modelSync.intervalMinutes`, so a restart —
 * including every `pnpm dev` HMR reload — does not re-probe every provider. Config is re-read
 * on every tick so a dashboard toggle or interval change applies without a restart.
 *
 * Returns the in-flight boot tick (so tests can await it) and a `stop` that clears the timer.
 */
export function scheduleModelSync(options: {
  load: () => Config | null;
  save: (config: Config) => void;
  onConfig?: (config: Config) => void;
  log?: (message: string) => void;
  intervalMs?: number;
  now?: () => number;
  discover?: (provider: Provider) => Promise<{ models: string[]; error?: string }>;
}): { ready: Promise<void>; tick: () => Promise<void>; stop: () => void } {
  const log = options.log ?? (() => {});
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? MODEL_SYNC_POLL_MS;
  let inFlight = false;

  const run = async (reason: "boot" | "poll"): Promise<void> => {
    const config = options.load();
    if (!config) return;
    if (!config.modelSync.enabled) {
      if (reason === "boot") log("models: auto-sync disabled");
      return;
    }
    if (inFlight) return;
    if (isModelSyncFresh(config.modelSync.intervalMinutes, now())) return;
    inFlight = true;
    try {
      const outcome = await runModelSync({
        load: options.load,
        save: options.save,
        now,
        ...(options.discover ? { discover: options.discover } : {}),
      });
      if (!outcome) return;
      const { result, config: next } = outcome;
      for (const entry of result.providers) {
        if (entry.error) log(`models: ${entry.provider} discovery failed (${entry.error})`);
        else if (entry.added.length > 0)
          log(`models: ${entry.provider} +${entry.added.length} (${entry.added.join(", ")})`);
      }
      if (result.changed && next) options.onConfig?.(next);
      else if (reason === "boot") log("models: up to date");
    } catch (error) {
      log(`models: sync failed (${error instanceof Error ? error.message : String(error)})`);
    } finally {
      inFlight = false;
    }
  };

  const ready = run("boot");
  const timer = setInterval(() => void run("poll"), intervalMs);
  timer.unref?.();
  return { ready, tick: () => run("poll"), stop: () => clearInterval(timer) };
}
