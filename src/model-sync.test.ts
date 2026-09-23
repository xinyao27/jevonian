import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  appendDiscoveredModels,
  parseConfig,
  parseModelSync,
  reconcileExcludeModels,
  saveConfig,
  type Config,
  type Provider,
} from "./config";
import {
  loadModelSyncState,
  runModelSync,
  saveModelSyncState,
  scheduleModelSync,
  syncProviderModels,
} from "./model-sync";

let dir = "";
let previousConfig: string | undefined;
let previousData: string | undefined;
let previousSync: string | undefined;

function provider(partial: Partial<Provider> & Pick<Provider, "name" | "models">): Provider {
  return {
    type: "openai",
    baseUrl: "https://example.com/v1",
    auth: "api-key",
    billing: "api",
    injectStreamUsage: true,
    ...partial,
  };
}

function config(providers: Provider[]): Config {
  return parseConfig({ providers });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-model-sync-"));
  previousConfig = process.env.JEVONIAN_CONFIG;
  previousData = process.env.JEVONIAN_DATA_DIR;
  previousSync = process.env.JEVONIAN_MODEL_SYNC_STATE;
  process.env.JEVONIAN_CONFIG = join(dir, "config.json");
  process.env.JEVONIAN_DATA_DIR = join(dir, "data");
  process.env.JEVONIAN_MODEL_SYNC_STATE = join(dir, "model-sync.json");
});

afterEach(() => {
  if (previousConfig === undefined) delete process.env.JEVONIAN_CONFIG;
  else process.env.JEVONIAN_CONFIG = previousConfig;
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  if (previousSync === undefined) delete process.env.JEVONIAN_MODEL_SYNC_STATE;
  else process.env.JEVONIAN_MODEL_SYNC_STATE = previousSync;
  rmSync(dir, { recursive: true, force: true });
});

describe("appendDiscoveredModels", () => {
  it("appends unknown ids without reordering or rewriting pins", () => {
    const base = provider({
      name: "codex",
      models: [{ id: "gpt-6-astra", wire: "responses" }],
    });
    const { provider: next, added } = appendDiscoveredModels(base, [
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
    ]);
    expect(added).toEqual(["gpt-6-sol", "gpt-6-luna"]);
    expect(next.models).toEqual([
      { id: "gpt-6-astra", wire: "responses" },
      { id: "gpt-6-sol" },
      { id: "gpt-6-luna" },
    ]);
  });

  it("skips ids named in excludeModels", () => {
    const base = provider({
      name: "codex",
      models: [{ id: "gpt-6-astra" }],
      excludeModels: ["gpt-6-sol"],
    });
    const { added } = appendDiscoveredModels(base, ["gpt-6-sol", "gpt-6-luna"]);
    expect(added).toEqual(["gpt-6-luna"]);
  });
});

describe("reconcileExcludeModels", () => {
  it("records removals and clears re-selected ids", () => {
    const previous = provider({
      name: "codex",
      models: [{ id: "a" }, { id: "b" }],
      excludeModels: ["old"],
    });
    expect(reconcileExcludeModels(previous, ["a", "c"])).toEqual(["old", "b"]);
    expect(reconcileExcludeModels(previous, ["a", "b", "old"])).toBeUndefined();
  });
});

describe("syncProviderModels", () => {
  it("appends discoveries, honors opt-out, and keeps lists on failure", async () => {
    const cfg = config([
      provider({
        name: "codex",
        models: [{ id: "gpt-6-astra" }],
        auth: "oauth",
        oauthSource: "codex",
        billing: "subscription",
      }),
      provider({ name: "openrouter", models: [{ id: "kept" }] }),
      provider({
        name: "broken",
        models: [{ id: "still-here" }],
        auth: "oauth",
        oauthSource: "claude-code",
        billing: "subscription",
      }),
    ]);
    const { config: next, result } = await syncProviderModels(cfg, {
      discover: async (entry) => {
        if (entry.name === "broken") throw new Error("boom");
        return { models: ["gpt-6-astra", "gpt-6-sol"] };
      },
      now: () => Date.parse("2026-09-23T02:00:00.000Z"),
    });
    expect(result.added).toBe(1);
    expect(result.changed).toBe(true);
    expect(result.providers).toEqual([
      { provider: "codex", added: ["gpt-6-sol"] },
      { provider: "openrouter", added: [], skipped: "default-off" },
      { provider: "broken", added: [], error: "boom" },
    ]);
    expect(next.providers.map((entry) => entry.models.map((model) => model.id))).toEqual([
      ["gpt-6-astra", "gpt-6-sol"],
      ["kept"],
      ["still-here"],
    ]);
  });

  it("reports an explicit opt-out separately from the API default", async () => {
    const cfg = config([
      provider({
        name: "codex",
        models: [{ id: "a" }],
        auth: "oauth",
        oauthSource: "codex",
        billing: "subscription",
        syncModels: false,
      }),
    ]);
    const { result } = await syncProviderModels(cfg, {
      discover: async () => ({ models: ["a", "b"] }),
    });
    expect(result.providers).toEqual([{ provider: "codex", added: [], skipped: "opted-out" }]);
  });

  it("syncs an API provider only when syncModels is explicitly true", async () => {
    const cfg = config([provider({ name: "deepseek", models: [{ id: "old" }], syncModels: true })]);
    const { result } = await syncProviderModels(cfg, {
      discover: async () => ({ models: ["old", "new"] }),
    });
    expect(result.providers[0]?.added).toEqual(["new"]);
  });
});

describe("runModelSync", () => {
  it("re-reads disk before save so a concurrent edit is not clobbered", async () => {
    const initial = config([
      provider({
        name: "codex",
        models: [{ id: "gpt-6-astra" }],
        auth: "oauth",
        oauthSource: "codex",
        billing: "subscription",
      }),
    ]);
    saveConfig(initial);
    let loads = 0;
    const outcome = await runModelSync({
      load: () => {
        loads += 1;
        if (loads === 1) return initial;
        // Dashboard added a model and renamed nothing while discovery was in flight.
        return config([
          provider({
            name: "codex",
            models: [{ id: "gpt-6-astra" }, { id: "manual-pin" }],
            auth: "oauth",
            oauthSource: "codex",
            billing: "subscription",
          }),
        ]);
      },
      save: saveConfig,
      discover: async () => ({ models: ["gpt-6-astra", "gpt-6-sol"] }),
      now: () => Date.parse("2026-09-23T02:00:00.000Z"),
    });
    expect(outcome?.result.changed).toBe(true);
    expect(outcome?.config?.providers[0]?.models.map((model) => model.id)).toEqual([
      "gpt-6-astra",
      "manual-pin",
      "gpt-6-sol",
    ]);
    const written = JSON.parse(readFileSync(process.env.JEVONIAN_CONFIG ?? "", "utf8")) as {
      providers: Array<{ models: string[] }>;
    };
    expect(written.providers[0]?.models).toEqual(["gpt-6-astra", "manual-pin", "gpt-6-sol"]);
  });

  it("counts only ids that landed on the fresh config", async () => {
    const codex = (models: string[]) =>
      provider({
        name: "codex",
        models: models.map((id) => ({ id })),
        auth: "oauth",
        oauthSource: "codex",
        billing: "subscription",
      });
    let loads = 0;
    const outcome = await runModelSync({
      load: () => {
        loads += 1;
        // The operator added gpt-6-sol by hand while discovery was in flight.
        return config([loads === 1 ? codex(["gpt-6-astra"]) : codex(["gpt-6-astra", "gpt-6-sol"])]);
      },
      save: () => {
        throw new Error("nothing new landed, so nothing should be saved");
      },
      discover: async () => ({ models: ["gpt-6-astra", "gpt-6-sol"] }),
    });
    expect(outcome?.result.added).toBe(0);
    expect(outcome?.result.changed).toBe(false);
    expect(outcome?.result.providers).toEqual([{ provider: "codex", added: [] }]);
  });
});

describe("parseModelSync", () => {
  it("clamps a too-short interval instead of resetting it to the default", () => {
    expect(parseModelSync({ intervalMinutes: 5 })).toEqual({ enabled: true, intervalMinutes: 15 });
    expect(parseModelSync({ intervalMinutes: 90.7 }).intervalMinutes).toBe(90);
    expect(parseModelSync({ enabled: false }).enabled).toBe(false);
    expect(parseModelSync({ intervalMinutes: "soon" }).intervalMinutes).toBe(720);
    expect(parseModelSync(null)).toEqual({ enabled: true, intervalMinutes: 720 });
  });
});

describe("loadModelSyncState", () => {
  it("drops malformed provider entries from a hand-edited state file", () => {
    writeFileSync(
      process.env.JEVONIAN_MODEL_SYNC_STATE ?? "",
      JSON.stringify({
        checkedAt: "2026-09-23T02:00:00.000Z",
        added: 1,
        providers: [
          { provider: "codex", added: ["gpt-6-sol", 3], skipped: "bogus" },
          { added: ["orphan"] },
          "garbage",
        ],
      }),
    );
    expect(loadModelSyncState()?.providers).toEqual([{ provider: "codex", added: ["gpt-6-sol"] }]);
  });
});

describe("scheduleModelSync", () => {
  const start = Date.parse("2026-09-23T02:00:00.000Z");
  const codexConfig = (intervalMinutes = 60, enabled = true) =>
    parseConfig({
      modelSync: { enabled, intervalMinutes },
      providers: [
        {
          name: "codex",
          type: "responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          auth: "oauth",
          oauthSource: "codex",
          billing: "subscription",
          models: ["gpt-6-astra"],
        },
      ],
    });

  it("runs on boot, skips while fresh, and runs again once the interval elapses", async () => {
    let clock = start;
    let stored = codexConfig();
    let discoveries = 0;
    const seen: Config[] = [];
    const schedule = scheduleModelSync({
      load: () => stored,
      save: (next) => {
        stored = next;
      },
      onConfig: (next) => seen.push(next),
      now: () => clock,
      intervalMs: 60 * 60 * 1_000,
      discover: async () => {
        discoveries += 1;
        return { models: discoveries === 1 ? ["gpt-6-astra", "gpt-6-sol"] : ["gpt-6-luna"] };
      },
    });
    try {
      await schedule.ready;
      expect(discoveries).toBe(1);
      expect(providerIds(stored)).toEqual(["gpt-6-astra", "gpt-6-sol"]);
      expect(seen).toHaveLength(1);

      clock = start + 30 * 60_000;
      await schedule.tick();
      expect(discoveries).toBe(1);

      clock = start + 61 * 60_000;
      await schedule.tick();
      expect(discoveries).toBe(2);
      expect(providerIds(stored)).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
    } finally {
      schedule.stop();
    }
  });

  it("does not re-probe on restart when the last pass is still fresh", async () => {
    saveModelSyncState({
      checkedAt: new Date(start).toISOString(),
      providers: [],
      added: 0,
      changed: false,
    });
    let discoveries = 0;
    const schedule = scheduleModelSync({
      load: () => codexConfig(),
      save: () => {},
      now: () => start + 10 * 60_000,
      discover: async () => {
        discoveries += 1;
        return { models: [] };
      },
    });
    try {
      await schedule.ready;
      expect(discoveries).toBe(0);
    } finally {
      schedule.stop();
    }
  });

  it("reads the master switch on every tick", async () => {
    let enabled = false;
    let discoveries = 0;
    const logs: string[] = [];
    const schedule = scheduleModelSync({
      load: () => codexConfig(60, enabled),
      save: () => {},
      log: (message) => logs.push(message),
      now: () => start,
      discover: async () => {
        discoveries += 1;
        return { models: [] };
      },
    });
    try {
      await schedule.ready;
      expect(discoveries).toBe(0);
      expect(logs).toContain("models: auto-sync disabled");
      enabled = true;
      await schedule.tick();
      expect(discoveries).toBe(1);
    } finally {
      schedule.stop();
    }
  });
});

function providerIds(cfg: Config): string[] {
  return cfg.providers[0]?.models.map((model) => model.id) ?? [];
}
