import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { readRecords } from "./ledger";
import { dataDir } from "./paths";

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
  requests: number;
  /** Credit limit in USD. Requests with this key fail when actual API spend exceeds this. */
  limitUsd?: number | null;
}

export interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  requests: number;
  limitUsd?: number | null;
  spendUsd?: number;
  subscriptionUsd?: number;
}

export function keysPath(): string {
  return join(dataDir(), "keys.json");
}

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function load(): ApiKeyRecord[] {
  const path = keysPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item) => {
      const record = item as Partial<ApiKeyRecord>;
      if (typeof record.id !== "string" || typeof record.hash !== "string") return [];
      return [
        {
          id: record.id,
          name: typeof record.name === "string" ? record.name : record.id,
          prefix: typeof record.prefix === "string" ? record.prefix : "sk-jev-",
          hash: record.hash,
          createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
          ...(typeof record.lastUsedAt === "string" ? { lastUsedAt: record.lastUsedAt } : {}),
          requests: typeof record.requests === "number" ? record.requests : 0,
          limitUsd:
            typeof record.limitUsd === "number" && Number.isFinite(record.limitUsd)
              ? record.limitUsd
              : null,
        },
      ];
    });
  } catch {
    return [];
  }
}

function save(records: ApiKeyRecord[]): void {
  const path = keysPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function summary(record: ApiKeyRecord): ApiKeySummary {
  return {
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    createdAt: record.createdAt,
    ...(record.lastUsedAt ? { lastUsedAt: record.lastUsedAt } : {}),
    requests: record.requests,
    ...(record.limitUsd !== undefined ? { limitUsd: record.limitUsd } : {}),
  };
}

export function listKeys(): ApiKeySummary[] {
  return load()
    .map(summary)
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function listKeysWithUsage(): ApiKeySummary[] {
  const keys = listKeys();
  const records = readRecords();
  const usageByKey = new Map<string, { apiUsd: number; subscriptionUsd: number }>();

  for (const record of records) {
    if (!record.keyId || record.kind === "brain") continue;
    const current = usageByKey.get(record.keyId) ?? { apiUsd: 0, subscriptionUsd: 0 };
    const cost = record.costUsd ?? 0;
    if (record.billing === "subscription") {
      current.subscriptionUsd += cost;
    } else {
      current.apiUsd += cost;
    }
    usageByKey.set(record.keyId, current);
  }

  return keys.map((key) => {
    const usage = usageByKey.get(key.id) ?? { apiUsd: 0, subscriptionUsd: 0 };
    return {
      ...key,
      spendUsd: Number(usage.apiUsd.toFixed(6)),
      subscriptionUsd: Number(usage.subscriptionUsd.toFixed(6)),
    };
  });
}

export function keySpendUsd(keyId: string): number {
  const records = readRecords();
  let spend = 0;
  for (const record of records) {
    if (record.keyId === keyId && record.billing !== "subscription" && record.kind !== "brain") {
      spend += record.costUsd ?? 0;
    }
  }
  return Number(spend.toFixed(6));
}

export function hasKeys(): boolean {
  return load().length > 0;
}

export function createKey(
  name: string,
  limitUsd?: number | null,
): { key: string; record: ApiKeySummary } {
  const key = `sk-jev-${randomBytes(24).toString("hex")}`;
  const record: ApiKeyRecord = {
    id: randomBytes(6).toString("hex"),
    name: name.trim() || "default",
    prefix: key.slice(0, 11),
    hash: hashKey(key),
    createdAt: new Date().toISOString(),
    requests: 0,
    ...(typeof limitUsd === "number" && Number.isFinite(limitUsd) && limitUsd > 0
      ? { limitUsd }
      : { limitUsd: null }),
  };
  save([...load(), record]);
  return { key, record: summary(record) };
}

export function updateKey(
  id: string,
  patch: { name?: string; limitUsd?: number | null },
): ApiKeySummary | undefined {
  const records = load();
  const record = records.find((item) => item.id === id);
  if (!record) return undefined;
  if (typeof patch.name === "string" && patch.name.trim()) {
    record.name = patch.name.trim();
  }
  if (patch.limitUsd !== undefined) {
    record.limitUsd =
      typeof patch.limitUsd === "number" && Number.isFinite(patch.limitUsd) && patch.limitUsd > 0
        ? patch.limitUsd
        : null;
  }
  save(records);
  return summary(record);
}

export function revokeKey(id: string): boolean {
  const records = load();
  const next = records.filter((record) => record.id !== id);
  if (next.length === records.length) return false;
  save(next);
  return true;
}

export function verifyKey(key: string): ApiKeyRecord | undefined {
  if (!key) return undefined;
  const hash = hashKey(key);
  const records = load();
  const record = records.find((item) => item.hash === hash);
  if (!record) return undefined;
  record.requests += 1;
  record.lastUsedAt = new Date().toISOString();
  save(records);
  return record;
}

export function tokenFromHeaders(headers: Headers): string {
  const authorization = headers.get("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) return authorization.slice(7).trim();
  const apiKey = headers.get("x-api-key");
  return apiKey?.trim() ?? "";
}
