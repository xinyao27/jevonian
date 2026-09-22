import {
  isLeaderboardFresh,
  loadLeaderboardSnapshot,
  refreshLeaderboard,
  snapshotBoardIds,
  LEADERBOARD_CACHE_TTL_MS,
} from "./leaderboard";
import {
  isPricingFresh,
  loadPricingSnapshot,
  pricingFetchedAt,
  refreshPricing,
  PRICING_CACHE_TTL_MS,
} from "./modelsdev";
import { initPricing } from "./pricing";

/** Shared 12h TTL for models.dev pricing (api.json) and benchmarks (models.json). */
export const CATALOG_CACHE_TTL_MS = Math.min(PRICING_CACHE_TTL_MS, LEADERBOARD_CACHE_TTL_MS);

/** How often serve re-checks TTL (refresh only when stale / missing). */
export const CATALOG_POLL_MS = 60 * 60 * 1_000;

export interface CatalogSyncResult {
  pricing: {
    models: number;
    fetchedAt: string;
    source: string;
    cached: boolean;
    error?: string;
  };
  leaderboard: {
    boards: number;
    models: number;
    fetchedAt: string;
    source: string;
    cached: boolean;
    error?: string;
  };
}

export function catalogStatus(now = Date.now()): {
  pricing: {
    present: boolean;
    fresh: boolean;
    fetchedAt?: string;
    ttlMs: number;
  };
  leaderboard: {
    present: boolean;
    fresh: boolean;
    fetchedAt?: string;
    boards: string[];
    models: number;
    ttlMs: number;
  };
} {
  const pricingSnap = loadPricingSnapshot();
  const board = loadLeaderboardSnapshot();
  return {
    pricing: {
      present: Boolean(pricingSnap && Object.keys(pricingSnap).length > 0),
      fresh: isPricingFresh(now),
      ...(pricingFetchedAt() ? { fetchedAt: pricingFetchedAt() } : {}),
      ttlMs: PRICING_CACHE_TTL_MS,
    },
    leaderboard: {
      present: Boolean(board),
      fresh: isLeaderboardFresh(now),
      ...(board?.fetchedAt ? { fetchedAt: board.fetchedAt } : {}),
      boards: snapshotBoardIds(board),
      models: board ? Object.keys(board.models).length : 0,
      ttlMs: LEADERBOARD_CACHE_TTL_MS,
    },
  };
}

/**
 * Refresh pricing and leaderboard. Fresh local snapshots are reused unless `force` is set.
 * Partial failure keeps the other source's result (and any prior on-disk data).
 */
export async function refreshCatalogCaches(
  options: { force?: boolean } = {},
): Promise<CatalogSyncResult> {
  const force = options.force === true;

  const [pricingSettled, leaderboardSettled] = await Promise.allSettled([
    refreshPricing({ force }),
    refreshLeaderboard({ force }),
  ]);

  if (pricingSettled.status === "fulfilled" && !pricingSettled.value.cached) {
    initPricing();
  }

  const pricing: CatalogSyncResult["pricing"] =
    pricingSettled.status === "fulfilled"
      ? {
          models: pricingSettled.value.models,
          fetchedAt: pricingSettled.value.fetchedAt,
          source: pricingSettled.value.source,
          cached: pricingSettled.value.cached,
        }
      : {
          models: Object.keys(loadPricingSnapshot() ?? {}).length,
          fetchedAt: pricingFetchedAt() ?? "",
          source: "models.dev",
          cached: true,
          error:
            pricingSettled.reason instanceof Error
              ? pricingSettled.reason.message
              : String(pricingSettled.reason),
        };

  const snap =
    leaderboardSettled.status === "fulfilled"
      ? leaderboardSettled.value.snapshot
      : loadLeaderboardSnapshot();
  const modelCount = snap ? Object.keys(snap.models).length : 0;
  const boardCount = snapshotBoardIds(snap).length;

  const leaderboard: CatalogSyncResult["leaderboard"] =
    leaderboardSettled.status === "fulfilled"
      ? {
          boards: boardCount,
          models: modelCount,
          fetchedAt: leaderboardSettled.value.snapshot.fetchedAt,
          source: leaderboardSettled.value.snapshot.source,
          cached: leaderboardSettled.value.cached,
        }
      : {
          boards: boardCount,
          models: modelCount,
          fetchedAt: snap?.fetchedAt ?? "",
          source: snap?.source ?? "models.dev/models.json",
          cached: true,
          error:
            leaderboardSettled.reason instanceof Error
              ? leaderboardSettled.reason.message
              : String(leaderboardSettled.reason),
        };

  return { pricing, leaderboard };
}

function logCatalogResult(result: CatalogSyncResult, log: (message: string) => void): void {
  if (!result.pricing.cached) {
    log(`catalog: pricing fetched ${result.pricing.models} models from ${result.pricing.source}`);
  } else if (result.pricing.error) {
    log(`catalog: pricing refresh failed (${result.pricing.error}); keeping local snapshot`);
  }
  if (!result.leaderboard.cached) {
    log(
      `catalog: benchmarks fetched ${result.leaderboard.models} models (${result.leaderboard.boards} boards) from models.dev`,
    );
  } else if (result.leaderboard.error) {
    log(`catalog: benchmark refresh failed (${result.leaderboard.error}); keeping local snapshot`);
  }
}

/**
 * Background sync used by `serve`: fetch when a snapshot is missing or older than 12h.
 * Re-checks on an interval so long-lived processes pick up TTL expiry without a restart.
 */
export function scheduleCatalogSync(
  options: {
    log?: (message: string) => void;
    intervalMs?: number;
  } = {},
): void {
  const log = options.log ?? (() => {});
  const intervalMs = options.intervalMs ?? CATALOG_POLL_MS;
  let inFlight = false;

  const run = (reason: "boot" | "poll"): void => {
    const status = catalogStatus();
    const needsPricing = !status.pricing.present || !status.pricing.fresh;
    const needsBoard = !status.leaderboard.present || !status.leaderboard.fresh;
    if (!needsPricing && !needsBoard) {
      if (reason === "boot") {
        log(
          `catalog: using local snapshots (pricing ${status.pricing.fetchedAt ?? "unknown"}, benchmarks ${status.leaderboard.fetchedAt ?? "unknown"} / ${status.leaderboard.models} models)`,
        );
      }
      return;
    }
    if (inFlight) return;
    inFlight = true;
    void refreshCatalogCaches({ force: false })
      .then((result) => logCatalogResult(result, log))
      .catch((error) => {
        log(`catalog: refresh failed (${error instanceof Error ? error.message : String(error)})`);
      })
      .finally(() => {
        inFlight = false;
      });
  };

  run("boot");
  const timer = setInterval(() => run("poll"), intervalMs);
  timer.unref?.();
}
