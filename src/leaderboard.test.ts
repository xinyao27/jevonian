import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  benchmarkFocusFor,
  boardIdFromName,
  boardMatchesPrefer,
  benchmarksCoverageOf,
  effortFromVariant,
  findCatalogBenchmarkModel,
  leaderboardViewFor,
  mapModelsDevBenchmarks,
  refreshLeaderboard,
  saveLeaderboardSnapshot,
  type LeaderboardSnapshot,
} from "./leaderboard";

let dir = "";
let previousData: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-leaderboard-"));
  previousData = process.env.JEVONIAN_DATA_DIR;
  process.env.JEVONIAN_DATA_DIR = dir;
});

afterEach(() => {
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  rmSync(dir, { recursive: true, force: true });
});

function seedSnapshot(): LeaderboardSnapshot {
  return {
    fetchedAt: "2026-09-15T20:00:00.000Z",
    source: "test",
    models: {
      "anthropic/claude-opus-5": {
        id: "anthropic/claude-opus-5",
        name: "Claude Opus 5",
        normalizedName: "claude opus 5",
        benchmarks: [
          {
            boardId: "swe-bench-verified",
            name: "SWE-Bench Verified",
            score: 96,
            higherIsBetter: true,
            metric: "resolved",
          },
          {
            boardId: "terminal-bench",
            name: "Terminal-Bench",
            score: 78.2,
            higherIsBetter: true,
            metric: "success rate",
          },
          {
            boardId: "terminal-bench",
            name: "Terminal-Bench",
            score: 84.1,
            higherIsBetter: true,
            metric: "pass@1",
            variant: "xhigh",
            effort: "xhigh",
            harness: "Codex",
          },
        ],
      },
      "openai/gpt-5.5": {
        id: "openai/gpt-5.5",
        name: "GPT-5.5",
        normalizedName: "gpt 5.5",
        benchmarks: [
          {
            boardId: "swe-bench-pro",
            name: "SWE-Bench Pro",
            score: 58.6,
            higherIsBetter: true,
            metric: "resolve rate",
          },
        ],
      },
      "zai/glm-5.1-mxfp4": {
        id: "zai/glm-5.1-mxfp4",
        name: "GLM 5.1 MXFP4 Autoround",
        normalizedName: "glm 5.1 mxfp4 autoround",
        benchmarks: [
          {
            boardId: "swe-bench-verified",
            name: "SWE-Bench Verified",
            score: 70,
            higherIsBetter: true,
          },
        ],
      },
    },
  };
}

describe("boardIdFromName / effortFromVariant", () => {
  it("slugifies benchmark names and parses effort variants", () => {
    expect(boardIdFromName("SWE-Bench Verified")).toBe("swe-bench-verified");
    expect(boardIdFromName("Agents' Last Exam")).toBe("agents-last-exam");
    expect(effortFromVariant("reasoning effort xhigh")).toBe("xhigh");
    expect(effortFromVariant("max effort")).toBe("max");
    expect(effortFromVariant("no tools")).toBeUndefined();
  });
});

describe("mapModelsDevBenchmarks", () => {
  it("keeps only models that publish benchmark rows", () => {
    const models = mapModelsDevBenchmarks({
      "anthropic/claude-opus-5": {
        id: "anthropic/claude-opus-5",
        name: "Claude Opus 5",
        benchmarks: [
          { name: "SWE-Bench Verified", score: 96, metric: "resolved" },
          { name: "Terminal-Bench", score: 80, variant: "xhigh" },
        ],
      },
      "skip/no-bench": { id: "skip/no-bench", name: "Skip", benchmarks: [] },
    });
    expect(Object.keys(models)).toEqual(["anthropic/claude-opus-5"]);
    expect(models["anthropic/claude-opus-5"]?.benchmarks[1]?.effort).toBe("xhigh");
  });
});

describe("lookup / leaderboardViewFor", () => {
  it("matches unified ids and bare ids for commercial models", () => {
    saveLeaderboardSnapshot(seedSnapshot());

    expect(findCatalogBenchmarkModel("claude-opus-5")?.entry.id).toBe("anthropic/claude-opus-5");
    expect(findCatalogBenchmarkModel("anthropic/claude-opus-5")?.match).toBe("exact");
    expect(findCatalogBenchmarkModel("openai/gpt-5.5")?.entry.benchmarks[0]?.score).toBe(58.6);

    const view = leaderboardViewFor("claude-opus-5");
    const byBoard = view?.by_board as Record<string, Record<string, unknown>>;
    expect(byBoard["swe-bench-verified"]?.score).toBe(96);
    // Headline prefers the higher Terminal-Bench score (xhigh variant).
    expect(byBoard["terminal-bench"]?.score).toBe(84.1);
    expect(view?.best_board).toBeUndefined();
    const byEffort = view?.by_effort as Record<string, Record<string, Record<string, unknown>>>;
    expect(byEffort.xhigh?.["terminal-bench"]?.score).toBe(84.1);
  });

  it("soft-matches after dropping quant noise tokens", () => {
    saveLeaderboardSnapshot(seedSnapshot());
    expect(findCatalogBenchmarkModel("glm-5.1")?.entry.id).toBe("zai/glm-5.1-mxfp4");
    expect(findCatalogBenchmarkModel("glm-5.1")?.match).toBe("soft");
  });
});

describe("benchmarkFocusFor / coverage", () => {
  it("prioritizes terminal/SWE after tool failures without prefer_signals", () => {
    const focus = benchmarkFocusFor({
      consecutiveFailures: 2,
      hasToolResults: true,
      hasTools: true,
    });
    expect(focus.prefer_boards).toEqual(
      expect.arrayContaining(["terminal-bench", "swe-bench-verified"]),
    );
    expect(focus).not.toHaveProperty("prefer_signals");
    expect(boardMatchesPrefer("terminal-bench-hard", "terminal-bench")).toBe(true);
  });

  it("reports coverage honestly", () => {
    expect(benchmarksCoverageOf([undefined, undefined])).toBe("none");
    expect(benchmarksCoverageOf([{ a: 1 }, undefined])).toBe("partial");
    expect(benchmarksCoverageOf([{ a: 1 }, { b: 2 }])).toBe("full");
  });
});

describe("refreshLeaderboard empty fetch", () => {
  it("keeps the prior snapshot when the fetch yields nothing usable", async () => {
    const prior = seedSnapshot();
    saveLeaderboardSnapshot(prior);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const result = await refreshLeaderboard({ force: true });
      expect(result.cached).toBe(true);
      expect(result.snapshot.fetchedAt).toBe(prior.fetchedAt);
      expect(result.snapshot.models["anthropic/claude-opus-5"]).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
