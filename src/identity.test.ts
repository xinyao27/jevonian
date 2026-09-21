import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { parseConfig } from "./config";
import { identityFrom, normalizeModelName, servingMode } from "./identity";
import { canonicalVariants, identityGaps, identityKeyOf, identityOf, isOfficial } from "./models";
import { savePricingSnapshot } from "./modelsdev";

let dir = "";
let previousData = "";
let previousConfig = "";

function configWith(providers: Array<{ name: string; models: string[]; baseUrl?: string }>) {
  return parseConfig({
    providers: providers.map((provider) => ({
      name: provider.name,
      type: "openai",
      baseUrl: provider.baseUrl ?? `https://${provider.name}.example.com/v1`,
      models: provider.models,
    })),
  });
}

function seedIdentities() {
  savePricingSnapshot(
    {},
    {},
    {},
    {
      "deepseek/deepseek-flash": { name: "DeepSeek V4.1 Flash", family: "deepseek-flash" },
      "deepseek/deepseek-v4-flash": { name: "DeepSeek V4 Flash", family: "deepseek-flash" },
      "deepseek/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", family: "deepseek-flash" },
      "opencode-go/deepseek-v4.1-flash": { name: "DeepSeek V4.1 Flash", family: "deepseek-flash" },
      "moonshotai/kimi-k3": { name: "Kimi K3", family: "kimi-k3" },
      "openai/gpt-5.4": { name: "GPT 5.4", family: "gpt" },
      "openai/gpt-5.4-mini": { name: "GPT 5.4 Mini", family: "gpt-mini" },
    },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-identity-"));
  previousData = process.env.JEVONIAN_DATA_DIR ?? "";
  previousConfig = process.env.JEVONIAN_CONFIG ?? "";
  process.env.JEVONIAN_DATA_DIR = dir;
  delete process.env.JEVONIAN_CONFIG;
  seedIdentities();
});

afterEach(() => {
  if (previousData) process.env.JEVONIAN_DATA_DIR = previousData;
  else delete process.env.JEVONIAN_DATA_DIR;
  if (previousConfig) process.env.JEVONIAN_CONFIG = previousConfig;
  else delete process.env.JEVONIAN_CONFIG;
  rmSync(dir, { recursive: true, force: true });
});

describe("servingMode", () => {
  it("defaults to standard", () => {
    expect(servingMode("deepseek-flash")).toBe("standard");
    expect(servingMode("opencode/deepseek-v4.1-flash")).toBe("standard");
    expect(servingMode("gpt-5.6")).toBe("standard");
  });

  it("detects mode suffixes on either separator", () => {
    expect(servingMode("deepseek-v4-flash:free")).toBe("free");
    expect(servingMode("deepseek-v4-flash-free")).toBe("free");
    expect(servingMode("deepseek/deepseek-v4-flash:batch")).toBe("batch");
    expect(servingMode("kimi-k3:fast")).toBe("fast");
    expect(servingMode("claude-sonnet-4-6-think")).toBe("thinking");
    expect(servingMode("claude-sonnet-4-6:thinking")).toBe("thinking");
  });

  it("does not treat model words as modes", () => {
    expect(servingMode("kimi-k2.7-code")).toBe("standard");
    expect(servingMode("kimi-k3")).toBe("standard");
    expect(servingMode("deepseek-v4-flash-vision-exp")).toBe("standard");
  });
});

describe("normalizeModelName", () => {
  it("folds case and punctuation but keeps version tokens", () => {
    expect(normalizeModelName("DeepSeek V4.1 Flash")).toBe("deepseek v4.1 flash");
    expect(normalizeModelName("GPT 5.4 Mini")).toBe("gpt 5.4 mini");
    expect(normalizeModelName("Claude-Sonnet 4.6")).toBe("claude sonnet 4.6");
  });

  it("strips reseller qualifiers and vendor prefixes", () => {
    expect(normalizeModelName("Kimi K3 Fast (Fireworks AI)")).toBe("kimi k3 fast");
    expect(normalizeModelName("DeepSeek: DeepSeek Flash Latest")).toBe("deepseek flash latest");
    expect(normalizeModelName("OpenAI: GPT-5 Pro")).toBe("gpt 5 pro");
    expect(normalizeModelName("Qwen: QvQ Max")).toBe("qvq max");
    // Dashes join a compound name; they are not a vendor prefix.
    expect(normalizeModelName("Moonshot AI - Kimi K3")).toBe("moonshot ai kimi k3");
  });

  it("keeps qualifiers that carry identity", () => {
    expect(normalizeModelName("GPT 5.4 Mini")).toBe("gpt 5.4 mini");
    expect(normalizeModelName("Kimi K2.7 Code")).toBe("kimi k2.7 code");
  });
});

describe("identity resolution", () => {
  it("links the official id to reseller spellings", () => {
    expect(identityKeyOf("deepseek-v4-1-flash")).toBe("deepseek v4.1 flash@standard");
    expect(identityKeyOf("deepseek-flash")).toBe("deepseek v4.1 flash@standard");
    expect(identityKeyOf("opencode/deepseek-v4.1-flash")).toBe("deepseek v4.1 flash@standard");
  });

  it("keeps serving modes apart", () => {
    expect(identityKeyOf("deepseek-v4-flash:free")).not.toBe(identityKeyOf("deepseek-v4-flash"));
    expect(identityKeyOf("kimi-k3:fast")).not.toBe(identityKeyOf("kimi-k3"));
  });

  it("never merges distinct versions", () => {
    expect(identityKeyOf("gpt-5.4")).not.toBe(identityKeyOf("gpt-5.4-mini"));
    expect(identityKeyOf("deepseek-v4-flash")).not.toBe(identityKeyOf("deepseek-flash"));
  });

  it("resolves the official endpoint without a hand-written alias", () => {
    const config = configWith([
      { name: "deepseek", models: ["deepseek-flash", "deepseek-v4-pro"] },
      { name: "opencode-go", models: ["deepseek-v4.1-flash"] },
      { name: "commandcode", models: ["deepseek/deepseek-v4.1-flash"] },
    ]);
    const variants = canonicalVariants(config, "deepseek-v4-1-flash");
    expect(variants[0]).toEqual({
      provider: "deepseek",
      model: "deepseek-flash",
      viaIdentity: true,
      official: true,
    });
    expect(variants.map((variant) => `${variant.provider}/${variant.model}`)).toContain(
      "opencode-go/deepseek-v4.1-flash",
    );
  });

  it("marks the vendor owner as official", () => {
    const config = configWith([
      { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-flash"] },
      { name: "opencode-go", models: ["deepseek-v4.1-flash"] },
    ]);
    expect(isOfficial(config, "deepseek", "deepseek-v4-1-flash")).toBe(true);
    expect(isOfficial(config, "opencode-go", "deepseek-v4-1-flash")).toBe(false);
    expect(isOfficial(config, "missing", "deepseek-v4-1-flash")).toBe(false);
  });

  it("does not suggest an alias when identity routing already reaches the vendor", () => {
    const config = configWith([
      { name: "deepseek", baseUrl: "https://api.deepseek.com/v1", models: ["deepseek-flash"] },
      { name: "opencode-go", models: ["deepseek-v4.1-flash"] },
    ]);
    const [gap] = identityGaps(config, ["deepseek-v4-1-flash"]);
    expect(gap?.identity.displayName).toBe("DeepSeek V4.1 Flash");
    expect(gap?.official).toContainEqual({ provider: "deepseek", model: "deepseek-flash" });
    expect(gap?.suggestion).toBeUndefined();
  });

  it("reports only configured model ids and never marks a reseller as the vendor", () => {
    const config = configWith([
      { name: "openrouter", models: ["deepseek/deepseek-v4.1-flash"] },
      { name: "deepseek", models: ["deepseek-flash"] },
      { name: "commandcode", models: ["deepseek/deepseek-v4.1-flash"] },
    ]);
    const [gap] = identityGaps(config, ["deepseek-v4-1-flash"]);
    expect(gap?.sameModel).toEqual([
      { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash", official: false },
      { provider: "deepseek", model: "deepseek-flash", official: true },
      { provider: "commandcode", model: "deepseek/deepseek-v4.1-flash", official: false },
    ]);
    expect(gap?.official).toEqual([{ provider: "deepseek", model: "deepseek-flash" }]);
  });

  it("stays silent when the catalog is missing", () => {
    const config = configWith([
      { name: "mystery", models: ["gpt-6-astra"] },
      { name: "other", models: ["gpt-6-astra-clone"] },
    ]);
    expect(identityKeyOf("gpt-6-astra")).toBeUndefined();
    expect(canonicalVariants(config, "gpt-6-astra")).toEqual([
      { provider: "mystery", model: "gpt-6-astra" },
    ]);
    expect(identityGaps(config, ["gpt-6-astra"])).toEqual([]);
    expect(identityOf("gpt-6-astra").mode).toBe("standard");
  });
});

describe("identityFrom", () => {
  it("keeps display name and family separate from the comparable label", () => {
    const parsed = identityFrom("deepseek-flash", {
      name: "DeepSeek V4.1 Flash",
      family: "deepseek-flash",
    });
    expect(parsed.label).toBe("deepseek v4.1 flash");
    expect(parsed.displayName).toBe("DeepSeek V4.1 Flash");
    expect(parsed.family).toBe("deepseek-flash");
  });
});
