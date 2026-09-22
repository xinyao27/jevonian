import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { normalizeModelName } from "./identity";
import { identityOf } from "./models";
import { leaderboardPath } from "./paths";

/** 12 hours cache freshness TTL — same window as pricing. */
export const LEADERBOARD_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;

/**
 * Unified model catalog from models.dev (not the provider-nested api.json).
 * Each row may carry a `benchmarks` array already keyed by stable ids like
 * `openai/gpt-5.5` / `anthropic/claude-opus-5`.
 */
export const MODELS_DEV_MODELS_URL =
  process.env.JEVONIAN_MODELS_DEV_MODELS_URL ?? "https://models.dev/models.json";

const EFFORT_TOKENS = [
  "xhigh",
  "ultra",
  "max",
  "high",
  "medium",
  "low",
  "minimal",
  "none",
] as const;

/** Quant / packaging noise on open-weight labels. */
const NOISE_TOKENS = new Set([
  "mxfp4",
  "gguf",
  "awq",
  "gptq",
  "int4",
  "int8",
  "fp8",
  "fp16",
  "bf16",
  "autoround",
  "mixed",
  "preview",
  "exp",
  "latest",
  "instruct",
  "chat",
  "base",
  "hf",
  "mlx",
  "ggml",
]);

/**
 * Soft preference keys for routing. Matched against slugified models.dev benchmark
 * names (and prefixes — `terminal-bench` also hits `terminal-bench-hard`).
 */
export const BENCHMARK_FOCUS_BOARDS = [
  "swe-bench-verified",
  "swe-bench-pro",
  "terminal-bench",
  "terminal-bench-hard",
  "toolathlon",
  "aider-polyglot",
  "artificial-analysis-coding-index",
  "artificial-analysis-coding-agent-index",
  "osworld-verified",
  "mcp-atlas",
  "agents-last-exam",
] as const;

export type BenchmarkFocusBoard = (typeof BENCHMARK_FOCUS_BOARDS)[number];
export type BenchmarkDomain = "code" | "agent" | "tools" | "general";
export type LeaderboardMatchKind = "exact" | "tokens" | "soft";

export interface BenchmarkRecord {
  /** Slug of the models.dev benchmark name. */
  boardId: string;
  name: string;
  score: number;
  higherIsBetter: true;
  metric?: string;
  variant?: string;
  harness?: string;
  version?: string;
  dataset?: string;
  source?: string;
  date?: string;
  effort?: string;
}

export interface CatalogBenchmarkModel {
  id: string;
  name: string;
  normalizedName: string;
  benchmarks: BenchmarkRecord[];
}

export interface LeaderboardSnapshot {
  fetchedAt: string;
  source: string;
  /** Unified models that carry at least one benchmark. */
  models: Record<string, CatalogBenchmarkModel>;
  /** @deprecated older HF / arena shapes — ignored when `models` is present. */
  boards?: Record<string, unknown>;
  categories?: Record<string, unknown>;
}

export function boardIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/τ/g, "tau")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function effortFromVariant(variant: string | undefined): string | undefined {
  if (!variant) return undefined;
  const lower = variant.toLowerCase();
  for (const effort of EFFORT_TOKENS) {
    if (new RegExp(`(^|[^a-z])${effort}([^a-z]|$)`).test(lower)) return effort;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bare(id: string): string {
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

function tokensOf(label: string): string[] {
  return label
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function sameTokenSet(left: string, right: string): boolean {
  const a = tokensOf(left);
  const b = tokensOf(right);
  if (a.length === 0 || a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((token) => set.has(token));
}

export function softNormalizeLabel(label: string): string {
  return tokensOf(label)
    .filter((token) => {
      if (NOISE_TOKENS.has(token)) return false;
      if (/^\d{8}$/.test(token)) return false;
      return true;
    })
    .join(" ");
}

function matchQuality(entryLabel: string, query: string): LeaderboardMatchKind | undefined {
  if (entryLabel === query) return "exact";
  if (sameTokenSet(entryLabel, query)) return "tokens";
  const softEntry = softNormalizeLabel(entryLabel);
  const softQuery = softNormalizeLabel(query);
  if (softEntry && softQuery && (softEntry === softQuery || sameTokenSet(softEntry, softQuery))) {
    return "soft";
  }
  return undefined;
}

const MATCH_RANK: Record<LeaderboardMatchKind, number> = {
  exact: 0,
  tokens: 1,
  soft: 2,
};

let cachedSnapshot:
  | {
      path: string;
      mtimeMs: number;
      snapshot: LeaderboardSnapshot;
    }
  | undefined;

export function loadLeaderboardSnapshot(): LeaderboardSnapshot | null {
  const path = leaderboardPath();
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (cachedSnapshot && cachedSnapshot.path === path && cachedSnapshot.mtimeMs === stat.mtimeMs) {
      return cachedSnapshot.snapshot;
    }
    const raw = JSON.parse(readFileSync(path, "utf8")) as LeaderboardSnapshot;
    if (!raw || typeof raw !== "object") return null;
    // Older HF/arena snapshots have `boards`/`categories` but no unified `models`.
    if (!raw.models || typeof raw.models !== "object") return null;
    cachedSnapshot = { path, mtimeMs: stat.mtimeMs, snapshot: raw };
    return raw;
  } catch {
    return null;
  }
}

export function saveLeaderboardSnapshot(snapshot: LeaderboardSnapshot): void {
  const path = leaderboardPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`);
  cachedSnapshot = undefined;
}

export function isLeaderboardFresh(now = Date.now()): boolean {
  const snap = loadLeaderboardSnapshot();
  if (!snap?.fetchedAt) return false;
  const fetched = Date.parse(snap.fetchedAt);
  return Number.isFinite(fetched) && now - fetched < LEADERBOARD_CACHE_TTL_MS;
}

export function mapModelsDevBenchmarks(payload: unknown): Record<string, CatalogBenchmarkModel> {
  const root = asRecord(payload);
  const models: Record<string, CatalogBenchmarkModel> = {};

  for (const [key, raw] of Object.entries(root)) {
    const item = asRecord(raw);
    const id = typeof item.id === "string" && item.id ? item.id : key;
    const name = typeof item.name === "string" ? item.name : id;
    const list = Array.isArray(item.benchmarks) ? item.benchmarks : [];
    const benchmarks: BenchmarkRecord[] = [];
    for (const entry of list) {
      const row = asRecord(entry);
      const benchName = typeof row.name === "string" ? row.name : "";
      const score = number(row.score);
      if (!benchName || score === undefined) continue;
      const variant = typeof row.variant === "string" ? row.variant : undefined;
      benchmarks.push({
        boardId: boardIdFromName(benchName),
        name: benchName,
        score,
        higherIsBetter: true,
        ...(typeof row.metric === "string" ? { metric: row.metric } : {}),
        ...(variant ? { variant } : {}),
        ...(typeof row.harness === "string" ? { harness: row.harness } : {}),
        ...(typeof row.version === "string" ? { version: row.version } : {}),
        ...(typeof row.dataset === "string" ? { dataset: row.dataset } : {}),
        ...(typeof row.source === "string" ? { source: row.source } : {}),
        ...(typeof row.date === "string" ? { date: row.date } : {}),
        ...(effortFromVariant(variant) ? { effort: effortFromVariant(variant) } : {}),
      });
    }
    if (benchmarks.length === 0) continue;
    models[id] = {
      id,
      name,
      normalizedName: normalizeModelName(name),
      benchmarks,
    };
  }

  return models;
}

export async function fetchModelsDevBenchmarks(
  signal?: AbortSignal,
): Promise<Record<string, CatalogBenchmarkModel>> {
  const response = await fetch(MODELS_DEV_MODELS_URL, {
    headers: {
      accept: "application/json",
      "user-agent": "jevonian-catalog-sync",
    },
    signal: signal ?? AbortSignal.timeout(45_000),
  });
  if (!response.ok) {
    throw new Error(`models.dev models.json responded with HTTP ${response.status}`);
  }
  return mapModelsDevBenchmarks(await response.json());
}

export async function refreshLeaderboard(options: { force?: boolean } = {}): Promise<{
  snapshot: LeaderboardSnapshot;
  cached: boolean;
}> {
  if (!options.force && isLeaderboardFresh()) {
    const existing = loadLeaderboardSnapshot();
    if (existing) return { snapshot: existing, cached: true };
  }

  const existing = loadLeaderboardSnapshot();
  let models: Record<string, CatalogBenchmarkModel>;
  try {
    models = await fetchModelsDevBenchmarks();
  } catch (error) {
    if (existing && Object.keys(existing.models ?? {}).length > 0) {
      return { snapshot: existing, cached: true };
    }
    throw error;
  }

  if (Object.keys(models).length === 0) {
    if (existing && Object.keys(existing.models ?? {}).length > 0) {
      return { snapshot: existing, cached: true };
    }
    throw new Error("models.dev models.json returned no benchmarked models");
  }

  const snapshot: LeaderboardSnapshot = {
    fetchedAt: new Date().toISOString(),
    source: MODELS_DEV_MODELS_URL,
    models,
  };
  saveLeaderboardSnapshot(snapshot);
  return { snapshot, cached: false };
}

function labelForModel(model: string): string {
  const identity = identityOf(model);
  const idBare = bare(model);
  return identity.label ?? normalizeModelName(idBare);
}

function queryKeysForModel(model: string): {
  ids: string[];
  labels: string[];
} {
  const idBare = bare(model);
  const ids = [model, idBare];
  if (model.includes("/") && model !== idBare) ids.push(model);
  const labels = [labelForModel(model), normalizeModelName(idBare)];
  return {
    ids: [...new Set(ids.filter(Boolean))],
    labels: [...new Set(labels.filter(Boolean))],
  };
}

export function findCatalogBenchmarkModel(
  model: string,
): { entry: CatalogBenchmarkModel; match: LeaderboardMatchKind } | undefined {
  const snapshot = loadLeaderboardSnapshot();
  if (!snapshot) return undefined;

  const { ids, labels } = queryKeysForModel(model);
  const values = Object.values(snapshot.models);

  for (const id of ids) {
    const direct = snapshot.models[id];
    if (direct) return { entry: direct, match: "exact" };
  }

  for (const id of ids) {
    const needle = bare(id).toLowerCase();
    const hit = values.find((entry) => bare(entry.id).toLowerCase() === needle);
    if (hit) return { entry: hit, match: "exact" };
  }

  let best: { entry: CatalogBenchmarkModel; match: LeaderboardMatchKind } | undefined;
  for (const label of labels) {
    for (const entry of values) {
      const match = matchQuality(entry.normalizedName, label);
      if (!match) continue;
      if (!best || MATCH_RANK[match] < MATCH_RANK[best.match]) {
        best = { entry, match };
      }
    }
  }
  return best;
}

function pickHeadline(records: BenchmarkRecord[]): BenchmarkRecord {
  // Prefer a row without effort/variant when scores are close; otherwise highest score.
  const sorted = [...records].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    const leftPlain = !left.effort && !left.variant ? 0 : 1;
    const rightPlain = !right.effort && !right.variant ? 0 : 1;
    return leftPlain - rightPlain;
  });
  return sorted[0]!;
}

function recordView(record: BenchmarkRecord): Record<string, unknown> {
  return {
    name: record.name,
    score: Number(record.score.toFixed(4)),
    higher_is_better: record.higherIsBetter,
    ...(record.metric ? { metric: record.metric } : {}),
    ...(record.effort ? { effort: record.effort } : {}),
    ...(record.variant ? { variant: record.variant } : {}),
    ...(record.harness ? { harness: record.harness } : {}),
    ...(record.version ? { version: record.version } : {}),
    ...(record.dataset ? { dataset: record.dataset } : {}),
    ...(record.source ? { source: record.source } : {}),
    ...(record.date ? { date: record.date } : {}),
  };
}

/**
 * Compact evidence for the brain. Scores only — models.dev does not publish ranks.
 * No cross-board `best_*` (different metrics are not comparable).
 */
export function leaderboardViewFor(model: string): Record<string, unknown> | undefined {
  const hit = findCatalogBenchmarkModel(model);
  if (!hit) return undefined;

  const byName = new Map<string, BenchmarkRecord[]>();
  for (const record of hit.entry.benchmarks) {
    const list = byName.get(record.boardId) ?? [];
    list.push(record);
    byName.set(record.boardId, list);
  }

  const byBoard: Record<string, Record<string, unknown>> = {};
  const byEffort: Record<string, Record<string, Record<string, unknown>>> = {};

  for (const [boardId, records] of byName) {
    const headline = pickHeadline(records);
    byBoard[boardId] = recordView(headline);
    for (const record of records) {
      if (!record.effort) continue;
      const bucket = (byEffort[record.effort] ??= {});
      const existing = bucket[boardId];
      if (!existing || (typeof existing.score === "number" && record.score > existing.score)) {
        bucket[boardId] = recordView(record);
      }
    }
  }

  return {
    label: hit.entry.normalizedName,
    model_id: hit.entry.id,
    match: hit.match,
    by_board: byBoard,
    ...(Object.keys(byEffort).length > 0 ? { by_effort: byEffort } : {}),
  };
}

/** True when `boardId` is the prefer key or a more specific variant of it. */
export function boardMatchesPrefer(boardId: string, prefer: string): boolean {
  return boardId === prefer || boardId.startsWith(`${prefer}-`);
}

/**
 * Which boards this turn should weigh most heavily.
 * Soft hint for Jev — not a hard filter. Prefer boards only (no duplicate signals).
 */
export function benchmarkFocusFor(input: {
  consecutiveFailures: number;
  hasToolResults: boolean;
  hasTools: boolean;
  routingId?: string;
}): {
  prefer_domain: BenchmarkDomain | "general";
  prefer_boards: BenchmarkFocusBoard[];
  reason: string;
} {
  if (input.consecutiveFailures > 0) {
    return {
      prefer_domain: "agent",
      prefer_boards: [
        "terminal-bench",
        "terminal-bench-hard",
        "swe-bench-verified",
        "toolathlon",
        "artificial-analysis-coding-agent-index",
      ],
      reason: "recent tool failures — terminal / SWE / agent coding indices first",
    };
  }
  if (input.routingId === "chat") {
    return {
      prefer_domain: "general",
      prefer_boards: [
        "agents-last-exam",
        "artificial-analysis-coding-agent-index",
        "osworld-verified",
      ],
      reason: "chat routing — agent quality over pure coding benches",
    };
  }
  if (input.hasTools || input.hasToolResults || input.routingId === "execute") {
    return {
      prefer_domain: "code",
      prefer_boards: [
        "swe-bench-verified",
        "swe-bench-pro",
        "terminal-bench",
        "aider-polyglot",
        "toolathlon",
        "artificial-analysis-coding-index",
      ],
      reason: "agentic / tool turn — SWE, terminal, aider, tool-use boards",
    };
  }
  if (input.routingId === "plan") {
    return {
      prefer_domain: "code",
      prefer_boards: [
        "swe-bench-verified",
        "swe-bench-pro",
        "artificial-analysis-coding-agent-index",
        "mcp-atlas",
      ],
      reason: "planning turn — SWE and agent boards over chat defaults",
    };
  }
  return {
    prefer_domain: "code",
    prefer_boards: [
      "swe-bench-verified",
      "swe-bench-pro",
      "terminal-bench",
      "artificial-analysis-coding-index",
    ],
    reason: "default — coding boards from models.dev",
  };
}

export function benchmarksCoverageOf(
  views: Array<Record<string, unknown> | undefined>,
): "full" | "partial" | "none" {
  if (views.length === 0) return "none";
  const hits = views.filter(Boolean).length;
  if (hits === 0) return "none";
  if (hits === views.length) return "full";
  return "partial";
}

/** Unique board ids present in the snapshot (for status / diagnostics). */
export function snapshotBoardIds(
  snapshot: LeaderboardSnapshot | null = loadLeaderboardSnapshot(),
): string[] {
  if (!snapshot) return [];
  const ids = new Set<string>();
  for (const model of Object.values(snapshot.models)) {
    for (const record of model.benchmarks) ids.add(record.boardId);
  }
  return [...ids].sort();
}
