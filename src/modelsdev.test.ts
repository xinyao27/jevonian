import { describe, expect, it } from "vite-plus/test";

import { clampEffort } from "./capabilities";
import { catalogCapabilities, mapCapabilities, mapModelsDev } from "./modelsdev";

const payload = {
  deepseek: {
    id: "deepseek",
    models: {
      "deepseek-v4-pro": { cost: { input: 0.435, output: 0.87, cache_read: 0.003625 } },
      "deepseek-flash": { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
      "deepseek-embed": { cost: null },
    },
  },
  reseller: {
    id: "reseller",
    models: {
      "deepseek/deepseek-v4-pro": { cost: { input: 9, output: 9 } },
      "glm-5.2": { cost: { input: 1.4, output: 4.4 } },
    },
  },
};

describe("mapModelsDev", () => {
  it("maps costs and skips models without cost", () => {
    const table = mapModelsDev(payload);
    expect(table["deepseek/deepseek-v4-pro"]?.input).toBe(0.435);
    expect(table["deepseek-v4-pro"]?.input).toBe(0.435);
    expect(table["deepseek-embed"]).toBeUndefined();
  });

  it("keeps prefixed ids as-is and indexes a bare alias", () => {
    const table = mapModelsDev(payload);
    expect(table["deepseek/deepseek-v4-pro"]?.output).toBe(0.87);
    expect(table["deepseek-v4-pro"]?.output).toBe(0.87);
    expect(table["glm-5.2"]?.output).toBe(4.4);
  });

  it("prefers official providers for bare ids over resellers", () => {
    const table = mapModelsDev({
      reseller: { models: { "deepseek/deepseek-v4-pro": { cost: { input: 99, output: 99 } } } },
      deepseek: { models: { "deepseek-v4-pro": { cost: { input: 0.435, output: 0.87 } } } },
    });
    expect(table["deepseek-v4-pro"]?.input).toBe(0.435);
    expect(table["deepseek/deepseek-v4-pro"]?.input).toBe(0.435);
    expect(table["reseller/deepseek/deepseek-v4-pro"]?.input).toBe(99);
  });

  it("prefers the owner provider for prefixed ids over resellers", () => {
    const table = mapModelsDev({
      "llmgateway-providers": {
        models: { "anthropic/claude-fable-5-1": { cost: { input: 1, output: 1 } } },
      },
      anthropic: { models: { "claude-fable-5-1": { cost: { input: 10, output: 50 } } } },
    });
    expect(table["anthropic/claude-fable-5-1"]?.input).toBe(10);
    expect(table["claude-fable-5-1"]?.input).toBe(10);
    expect(table["llmgateway-providers/anthropic/claude-fable-5-1"]?.input).toBe(1);
  });

  it("ignores malformed payloads", () => {
    expect(mapModelsDev(null)).toEqual({});
    expect(mapModelsDev({ provider: { models: { model: {} } } })).toEqual({});
  });
});

describe("catalogCapabilities reasoning", () => {
  it("reads effort values from reasoning_options (Gemini 3.8 Flash shape)", () => {
    const caps = catalogCapabilities({
      reasoning: true,
      reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
      limit: { context: 1_000_000, output: 65_536 },
    });
    expect(caps?.efforts).toEqual(["low", "medium", "high"]);
    // Brain "none" for chat must clamp up — OpenRouter rejects disabling reasoning.
    expect(clampEffort("none", caps?.efforts as ("low" | "medium" | "high")[])).toBe("low");
  });

  it("treats reasoning: true without options as thinking-capable, not disableable", () => {
    const caps = catalogCapabilities({ reasoning: true, limit: { context: 1000 } });
    expect(caps?.efforts).toEqual(["minimal", "low", "medium", "high", "max"]);
    expect(caps?.efforts).not.toContain("none");
  });

  it("indexes reasoning_options through mapCapabilities", () => {
    const table = mapCapabilities({
      openrouter: {
        models: {
          "google/gemini-3.8-flash": {
            reasoning: true,
            reasoning_options: [{ type: "effort", values: ["low", "medium", "high"] }],
            limit: { context: 1048576, output: 65536 },
          },
        },
      },
    });
    expect(table["openrouter/google/gemini-3.8-flash"]?.efforts).toEqual(["low", "medium", "high"]);
    expect(table["gemini-3.8-flash"]?.efforts).toEqual(["low", "medium", "high"]);
  });
});
