import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { ledgerPath } from "./paths";

export interface LedgerRecord {
  id?: string;
  requestId?: string;
  ts: string;
  session: string;
  path: string;
  provider: string;
  model: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number | null;
  pricingKnown: boolean;
  kind?: "request" | "brain";
  billing?: string;
  requestedModel?: string;
  phase?: string;
  routed?: boolean;
  reason?: string;
  brain?: string;
  confidence?: number;
  canonical?: string;
  /** The thinking level actually sent upstream, read back from the outgoing body. */
  effort?: string;
  /** Why that level differs from what the router chose, when it does. */
  effortNote?: string;
  /** Models code withheld from the brain's choice, each with its reason. */
  skipped?: Array<{ model: string; provider: string; reason: string; detail: string }>;
  /** Probabilistic routing estimate, not the measured hit rate for this response. */
  cache?: import("./routing").CacheAffinity;
  switchPenaltyUsd?: number | null;
  /**
   * Transient upstream failures that were retried before this record was written. Absent when
   * the first attempt succeeded, so a clean turn carries no field at all.
   */
  retries?: number;
  error?: string;
  /** Jevonian key ID that authorized the request, or "local" / "unauthenticated". */
  keyId?: string;
  /** Snapshot of the key name when the request was made (for display even if revoked). */
  keyName?: string;
}

let cachedRecords: { path: string; mtimeMs: number; size: number; records: LedgerRecord[] } | null =
  null;

type LedgerListener = (record: LedgerRecord) => void;
const ledgerListeners = new Set<LedgerListener>();

export function subscribeLedger(listener: LedgerListener): () => void {
  ledgerListeners.add(listener);
  return () => {
    ledgerListeners.delete(listener);
  };
}

export function resetLedgerCache(): void {
  cachedRecords = null;
}

export function appendRecord(record: LedgerRecord): void {
  const path = ledgerPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
  // Incrementally append to cache if currently populated and matches this path
  if (cachedRecords && cachedRecords.path === path) {
    cachedRecords.records.push(record);
  }
  for (const listener of ledgerListeners) {
    try {
      listener(record);
    } catch {
      // Ignore listener error
    }
  }
}

export function readRecords(): LedgerRecord[] {
  const path = ledgerPath();
  if (!existsSync(path)) {
    cachedRecords = null;
    return [];
  }
  try {
    const st = statSync(path);
    if (
      cachedRecords &&
      cachedRecords.path === path &&
      cachedRecords.mtimeMs === st.mtimeMs &&
      cachedRecords.size === st.size
    ) {
      return cachedRecords.records;
    }
    const lines = readFileSync(path, "utf8").split("\n");
    const records: LedgerRecord[] = [];
    for (const line of lines) {
      if (!line) continue;
      try {
        records.push(JSON.parse(line) as LedgerRecord);
      } catch {
        // ignore malformed line
      }
    }
    cachedRecords = { path, mtimeMs: st.mtimeMs, size: st.size, records };
    return records;
  } catch {
    return [];
  }
}
