import { readRecords, type LedgerRecord } from "./ledger";

export type ActivityTimeRange = "today" | "24h" | "7d" | "30d" | "all";

export interface ActivityFilter {
  range?: ActivityTimeRange;
  keyId?: string;
}

export interface ActivitySummary {
  totalSpendUsd: number;
  apiSpendUsd: number;
  subscriptionValueUsd: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  totalRequests: number;
  successfulRequests: number;
  errorRequests: number;
  avgLatencyMs: number;
}

export interface ActivitySeriesPoint {
  timestamp: string;
  label: string;
  spendUsd: number;
  subscriptionUsd: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requests: number;
  errorRequests: number;
}

export interface ActivityModelStat {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  spendUsd: number;
  subscriptionUsd: number;
  percentSpend: number;
}

export interface ActivityKeyStat {
  id: string;
  name: string;
  requests: number;
  spendUsd: number;
  subscriptionUsd: number;
}

export interface ActivityReport {
  range: ActivityTimeRange;
  keyId: string;
  startTime: string;
  endTime: string;
  summary: ActivitySummary;
  series: ActivitySeriesPoint[];
  models: ActivityModelStat[];
  keys: ActivityKeyStat[];
}

function getTimeBounds(
  range: ActivityTimeRange,
  now: Date,
): { start: Date; end: Date; bucketHours: number } {
  const end = new Date(now);
  const start = new Date(now);

  if (range === "today") {
    start.setHours(0, 0, 0, 0);
    return { start, end, bucketHours: 1 };
  }
  if (range === "24h") {
    start.setTime(now.getTime() - 24 * 3600 * 1000);
    return { start, end, bucketHours: 1 };
  }
  if (range === "7d") {
    start.setTime(now.getTime() - 7 * 24 * 3600 * 1000);
    start.setHours(0, 0, 0, 0);
    return { start, end, bucketHours: 24 };
  }
  if (range === "30d") {
    start.setTime(now.getTime() - 30 * 24 * 3600 * 1000);
    start.setHours(0, 0, 0, 0);
    return { start, end, bucketHours: 24 };
  }
  // "all" - start will be determined by oldest record or 30 days ago
  start.setTime(now.getTime() - 90 * 24 * 3600 * 1000);
  start.setHours(0, 0, 0, 0);
  return { start, end, bucketHours: 24 };
}

function formatLabel(d: Date, bucketHours: number): string {
  if (bucketHours === 1) {
    const hours = d.getHours().toString().padStart(2, "0");
    return `${hours}:00`;
  }
  const month = d.toLocaleString("en-US", { month: "short" });
  const day = d.getDate();
  return `${month} ${day}`;
}

export function computeActivityReport(
  filter: ActivityFilter = {},
  now = new Date(),
): ActivityReport {
  const range = filter.range ?? "30d";
  const selectedKeyId = filter.keyId && filter.keyId.trim() ? filter.keyId.trim() : "all";

  const allRecords = readRecords();
  const bounds = getTimeBounds(range, now);

  if (range === "all" && allRecords.length > 0) {
    const firstTs = new Date(allRecords[0].ts);
    if (!Number.isNaN(firstTs.getTime()) && firstTs.getTime() < bounds.start.getTime()) {
      bounds.start = new Date(firstTs);
      bounds.start.setHours(0, 0, 0, 0);
    }
  }

  const startMs = bounds.start.getTime();
  const endMs = bounds.end.getTime();

  // Filter records within time window and key filter
  const windowRecords: LedgerRecord[] = [];
  const keyStatsMap = new Map<string, ActivityKeyStat>();

  for (const record of allRecords) {
    if (record.kind === "brain") continue;
    const recTime = new Date(record.ts).getTime();
    if (Number.isNaN(recTime)) continue;
    if (recTime < startMs || recTime > endMs) continue;

    const rKeyId = record.keyId ?? "";
    if (rKeyId) {
      const existingKey = keyStatsMap.get(rKeyId) ?? {
        id: rKeyId,
        name: record.keyName ?? rKeyId,
        requests: 0,
        spendUsd: 0,
        subscriptionUsd: 0,
      };
      existingKey.requests += 1;
      const cost = record.costUsd ?? 0;
      if (record.billing === "subscription") {
        existingKey.subscriptionUsd += cost;
      } else {
        existingKey.spendUsd += cost;
      }
      keyStatsMap.set(rKeyId, existingKey);
    }

    if (selectedKeyId !== "all" && rKeyId !== selectedKeyId) continue;

    windowRecords.push(record);
  }

  // Calculate overall summary
  let apiSpendUsd = 0;
  let subscriptionValueUsd = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let cacheReadTokens = 0;
  let totalLatencyMs = 0;
  let successfulRequests = 0;
  let errorRequests = 0;

  const modelMap = new Map<
    string,
    {
      requests: number;
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens: number;
      spendUsd: number;
      subscriptionUsd: number;
    }
  >();

  for (const r of windowRecords) {
    const cost = r.costUsd ?? 0;
    if (r.billing === "subscription") {
      subscriptionValueUsd += cost;
    } else {
      apiSpendUsd += cost;
    }

    promptTokens += r.promptTokens;
    completionTokens += r.completionTokens;
    cacheReadTokens += r.cacheReadTokens;
    totalLatencyMs += r.latencyMs;

    if (r.status >= 200 && r.status < 400 && !r.error) {
      successfulRequests += 1;
    } else {
      errorRequests += 1;
    }

    const modelName = r.model || "unknown";
    const m = modelMap.get(modelName) ?? {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      spendUsd: 0,
      subscriptionUsd: 0,
    };
    m.requests += 1;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.cacheReadTokens += r.cacheReadTokens;
    if (r.billing === "subscription") {
      m.subscriptionUsd += cost;
    } else {
      m.spendUsd += cost;
    }
    modelMap.set(modelName, m);
  }

  const totalRequests = windowRecords.length;
  const totalTokens = promptTokens + completionTokens + cacheReadTokens;
  const totalSpendUsd = Number((apiSpendUsd + subscriptionValueUsd).toFixed(6));
  const avgLatencyMs = totalRequests > 0 ? Math.round(totalLatencyMs / totalRequests) : 0;

  // Build time series buckets
  const bucketMs = bounds.bucketHours * 3600 * 1000;
  const series: ActivitySeriesPoint[] = [];
  let curTime = bounds.start.getTime();

  while (curTime <= endMs) {
    const bucketStart = curTime;
    const bucketDate = new Date(bucketStart);

    series.push({
      timestamp: bucketDate.toISOString(),
      label: formatLabel(bucketDate, bounds.bucketHours),
      spendUsd: 0,
      subscriptionUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadTokens: 0,
      totalTokens: 0,
      requests: 0,
      errorRequests: 0,
    });

    curTime += bucketMs;
  }

  // Populate series with records
  for (const r of windowRecords) {
    const rMs = new Date(r.ts).getTime();
    const bucketIndex = Math.floor((rMs - startMs) / bucketMs);
    if (bucketIndex >= 0 && bucketIndex < series.length) {
      const pt = series[bucketIndex];
      const cost = r.costUsd ?? 0;
      if (r.billing === "subscription") {
        pt.subscriptionUsd = Number((pt.subscriptionUsd + cost).toFixed(6));
      } else {
        pt.spendUsd = Number((pt.spendUsd + cost).toFixed(6));
      }
      pt.promptTokens += r.promptTokens;
      pt.completionTokens += r.completionTokens;
      pt.cacheReadTokens += r.cacheReadTokens;
      pt.totalTokens += r.promptTokens + r.completionTokens + r.cacheReadTokens;
      pt.requests += 1;
      if (r.status < 200 || r.status >= 400 || r.error) {
        pt.errorRequests += 1;
      }
    }
  }

  // Format models list
  const models: ActivityModelStat[] = Array.from(modelMap.entries())
    .map(([model, s]) => {
      const mSpend = Number(s.spendUsd.toFixed(6));
      const mSub = Number(s.subscriptionUsd.toFixed(6));
      const mTotal = mSpend + mSub;
      const percentSpend =
        totalSpendUsd > 0 ? Number(((mTotal / totalSpendUsd) * 100).toFixed(1)) : 0;
      return {
        model,
        requests: s.requests,
        promptTokens: s.promptTokens,
        completionTokens: s.completionTokens,
        cacheReadTokens: s.cacheReadTokens,
        totalTokens: s.promptTokens + s.completionTokens + s.cacheReadTokens,
        spendUsd: mSpend,
        subscriptionUsd: mSub,
        percentSpend,
      };
    })
    .sort(
      (a, b) =>
        b.spendUsd + b.subscriptionUsd - (a.spendUsd + a.subscriptionUsd) ||
        b.requests - a.requests,
    );

  // Format keys list
  const keys: ActivityKeyStat[] = Array.from(keyStatsMap.values())
    .map((k) => ({
      ...k,
      spendUsd: Number(k.spendUsd.toFixed(6)),
      subscriptionUsd: Number(k.subscriptionUsd.toFixed(6)),
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd || b.requests - a.requests);

  return {
    range,
    keyId: selectedKeyId,
    startTime: bounds.start.toISOString(),
    endTime: bounds.end.toISOString(),
    summary: {
      totalSpendUsd,
      apiSpendUsd: Number(apiSpendUsd.toFixed(6)),
      subscriptionValueUsd: Number(subscriptionValueUsd.toFixed(6)),
      totalTokens,
      promptTokens,
      completionTokens,
      cacheReadTokens,
      totalRequests,
      successfulRequests,
      errorRequests,
      avgLatencyMs,
    },
    series,
    models,
    keys,
  };
}
