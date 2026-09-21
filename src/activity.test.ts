import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { computeActivityReport } from "./activity";
import { appendRecord, resetLedgerCache } from "./ledger";

describe("activity report", () => {
  let tempDir: string;
  const previousDataDir = process.env.JEVONIAN_DATA_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "jev-activity-test-"));
    process.env.JEVONIAN_DATA_DIR = tempDir;
    resetLedgerCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.JEVONIAN_DATA_DIR;
    else process.env.JEVONIAN_DATA_DIR = previousDataDir;
    resetLedgerCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("aggregates spend, tokens, requests, and series correctly", () => {
    const fixedNow = new Date("2026-09-21T12:00:00.000Z");

    appendRecord({
      ts: "2026-09-21T10:00:00.000Z",
      session: "s1",
      path: "/chat/completions",
      provider: "openrouter",
      model: "gpt-4o",
      stream: false,
      status: 200,
      latencyMs: 500,
      promptTokens: 1000,
      completionTokens: 200,
      cacheReadTokens: 500,
      cacheWriteTokens: 0,
      costUsd: 0.015,
      pricingKnown: true,
      billing: "api",
      keyId: "k1",
      keyName: "key-1",
    });

    appendRecord({
      ts: "2026-09-21T11:00:00.000Z",
      session: "s2",
      path: "/chat/completions",
      provider: "claude-sub",
      model: "claude-3-5-sonnet",
      stream: false,
      status: 200,
      latencyMs: 700,
      promptTokens: 2000,
      completionTokens: 400,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.024,
      pricingKnown: true,
      billing: "subscription",
      keyId: "k2",
      keyName: "key-2",
    });

    const report = computeActivityReport({ range: "24h" }, fixedNow);

    expect(report.summary.totalRequests).toBe(2);
    expect(report.summary.apiSpendUsd).toBe(0.015);
    expect(report.summary.subscriptionValueUsd).toBe(0.024);
    expect(report.summary.totalTokens).toBe(1000 + 200 + 500 + 2000 + 400);
    expect(report.summary.promptTokens).toBe(3000);
    expect(report.summary.completionTokens).toBe(600);
    expect(report.summary.cacheReadTokens).toBe(500);
    expect(report.models.length).toBe(2);
    expect(report.keys.length).toBe(2);

    // Test key filter
    const key1Report = computeActivityReport({ range: "24h", keyId: "k1" }, fixedNow);
    expect(key1Report.summary.totalRequests).toBe(1);
    expect(key1Report.summary.apiSpendUsd).toBe(0.015);
    expect(key1Report.summary.subscriptionValueUsd).toBe(0);
    expect(key1Report.models.length).toBe(1);
    expect(key1Report.models[0].model).toBe("gpt-4o");
  });
});
