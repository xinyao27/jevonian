import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  createKey,
  hasKeys,
  keySpendUsd,
  listKeys,
  listKeysWithUsage,
  revokeKey,
  updateKey,
  verifyKey,
} from "./keys";
import { appendRecord, resetLedgerCache } from "./ledger";

describe("api keys and spend tracking", () => {
  let tempDir: string;
  const previousDataDir = process.env.JEVONIAN_DATA_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "jev-keys-test-"));
    process.env.JEVONIAN_DATA_DIR = tempDir;
    resetLedgerCache();
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.JEVONIAN_DATA_DIR;
    else process.env.JEVONIAN_DATA_DIR = previousDataDir;
    resetLedgerCache();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates, lists, and revokes keys", () => {
    expect(hasKeys()).toBe(false);
    const { key, record } = createKey("test-agent", 25.5);
    expect(record.name).toBe("test-agent");
    expect(record.limitUsd).toBe(25.5);
    expect(hasKeys()).toBe(true);

    const verified = verifyKey(key);
    expect(verified).toBeDefined();
    expect(verified?.id).toBe(record.id);

    const updated = updateKey(record.id, { name: "renamed", limitUsd: 50 });
    expect(updated?.name).toBe("renamed");
    expect(updated?.limitUsd).toBe(50);

    const keys = listKeys();
    expect(keys.length).toBe(1);
    expect(keys[0].name).toBe("renamed");

    expect(revokeKey(record.id)).toBe(true);
    expect(listKeys().length).toBe(0);
  });

  it("calculates key spend and includes it in listKeysWithUsage", () => {
    const { record } = createKey("agent-a");
    const now = new Date().toISOString();

    appendRecord({
      ts: now,
      session: "s1",
      path: "/chat/completions",
      provider: "openrouter",
      model: "gpt-4o",
      stream: false,
      status: 200,
      latencyMs: 300,
      promptTokens: 100,
      completionTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.05,
      pricingKnown: true,
      keyId: record.id,
      keyName: record.name,
      billing: "api",
    });

    appendRecord({
      ts: now,
      session: "s2",
      path: "/chat/completions",
      provider: "chatgpt",
      model: "o1",
      stream: false,
      status: 200,
      latencyMs: 400,
      promptTokens: 200,
      completionTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.12,
      pricingKnown: true,
      keyId: record.id,
      keyName: record.name,
      billing: "subscription",
    });

    expect(keySpendUsd(record.id)).toBe(0.05);

    const withUsage = listKeysWithUsage();
    expect(withUsage.length).toBe(1);
    expect(withUsage[0].spendUsd).toBe(0.05);
    expect(withUsage[0].subscriptionUsd).toBe(0.12);
  });
});
