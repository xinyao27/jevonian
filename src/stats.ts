import type { Config } from "./config";
import type { LedgerRecord } from "./ledger";
import { costOf, priceFor, type Usage } from "./pricing";
import { deriveTiers } from "./routing";

export interface ModelStat {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  unpriced: number;
}

export interface PhaseStat {
  phase: string;
  requests: number;
  costUsd: number;
}

export interface StatsSummary {
  requests: number;
  sessions: number;
  costUsd: number;
  apiUsd: number;
  subscriptionUsd: number;
  subscriptionRequests: number;
  brainUsd: number;
  brainRequests: number;
  baselineUsd: number;
  apiBaselineUsd: number;
  subscriptionBaselineUsd: number;
  baselineModel?: string;
  savingsUsd: number;
  savingsPct: number;
  cacheHitRate: number;
  unpriced: number;
  byModel: ModelStat[];
  byPhase: PhaseStat[];
}

export function usageOf(record: LedgerRecord): Usage {
  return {
    input: record.promptTokens,
    output: record.completionTokens,
    cacheRead: record.cacheReadTokens,
    cacheWrite: record.cacheWriteTokens,
  };
}

export function baselineModelOf(
  config: Config | null,
  records: LedgerRecord[],
): string | undefined {
  if (config?.routing.baselineModel) return config.routing.baselineModel;
  if (config) {
    const tiers = deriveTiers(config);
    if (tiers.plan[0]) return tiers.plan[0];
  }
  const priced = [...new Set(records.map((record) => record.model))]
    .flatMap((model) => {
      const price = priceFor(model);
      return price ? [{ model, output: price.output }] : [];
    })
    .sort((left, right) => right.output - left.output);
  return priced[0]?.model;
}

export function summarize(records: LedgerRecord[], config: Config | null): StatsSummary {
  const baselineModel = baselineModelOf(config, records);
  const byModel = new Map<string, ModelStat>();
  const byPhase = new Map<string, PhaseStat>();
  let costUsd = 0;
  let apiUsd = 0;
  let subscriptionUsd = 0;
  let subscriptionRequests = 0;
  let brainUsd = 0;
  let brainRequests = 0;
  let baselineUsd = 0;
  let apiBaselineUsd = 0;
  let subscriptionBaselineUsd = 0;
  let cacheReadTokens = 0;
  let promptTokens = 0;
  let unpriced = 0;

  const baselineProvider = config?.providers.find((provider) =>
    provider.models.some((entry) => entry.id === (baselineModel ?? "")),
  )?.name;

  for (const record of records) {
    const row = byModel.get(record.model) ?? {
      model: record.model,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      costUsd: 0,
      unpriced: 0,
    };
    row.requests += 1;
    row.promptTokens += record.promptTokens;
    row.completionTokens += record.completionTokens;
    row.cacheReadTokens += record.cacheReadTokens;
    if (record.costUsd === null) {
      row.unpriced += 1;
      unpriced += 1;
    } else {
      row.costUsd += record.costUsd;
      costUsd += record.costUsd;
    }
    if (record.kind === "brain") {
      brainRequests += 1;
      brainUsd += record.costUsd ?? 0;
    } else if (record.billing === "subscription") {
      subscriptionRequests += 1;
      subscriptionUsd += record.costUsd ?? 0;
    } else {
      apiUsd += record.costUsd ?? 0;
    }
    byModel.set(record.model, row);

    const phase = byPhase.get(record.phase ?? "-") ?? {
      phase: record.phase ?? "-",
      requests: 0,
      costUsd: 0,
    };
    phase.requests += 1;
    phase.costUsd += record.costUsd ?? 0;
    byPhase.set(phase.phase, phase);

    cacheReadTokens += record.cacheReadTokens;
    promptTokens += record.promptTokens;
    if (baselineModel && record.kind !== "brain") {
      const estimate = costOf(
        baselineModel,
        usageOf(record),
        new Date(record.ts),
        baselineProvider,
      ).usd;
      if (estimate !== null) {
        baselineUsd += estimate;
        if (record.billing === "subscription") subscriptionBaselineUsd += estimate;
        else apiBaselineUsd += estimate;
      }
    }
  }

  const savingsUsd = apiBaselineUsd - apiUsd;
  return {
    requests: records.length,
    sessions: new Set(records.map((record) => record.session)).size,
    costUsd,
    apiUsd,
    subscriptionUsd,
    subscriptionRequests,
    brainUsd,
    brainRequests,
    baselineUsd,
    apiBaselineUsd,
    subscriptionBaselineUsd,
    ...(baselineModel ? { baselineModel } : {}),
    savingsUsd,
    savingsPct: apiBaselineUsd > 0 ? (savingsUsd / apiBaselineUsd) * 100 : 0,
    cacheHitRate:
      cacheReadTokens + promptTokens > 0 ? cacheReadTokens / (cacheReadTokens + promptTokens) : 0,
    unpriced,
    byModel: [...byModel.values()].sort((left, right) => right.costUsd - left.costUsd),
    byPhase: [...byPhase.values()].sort((left, right) => right.costUsd - left.costUsd),
  };
}
