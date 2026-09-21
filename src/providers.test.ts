import { describe, expect, it } from "vite-plus/test";

import { parseConfig } from "./config";
import { findPreset, normalizeBaseUrl, PRESETS, typeFromNpm } from "./providers";
import { canServeClient, providerSpeaks } from "./wire";

describe("providers", () => {
  it("has the expected preset fields", () => {
    for (const preset of PRESETS) {
      expect(preset.id.length).toBeGreaterThan(0);
      expect(preset.baseUrl.startsWith("https://")).toBe(true);
      expect(preset.hint.length).toBeGreaterThan(0);
      expect(preset.keysUrl?.startsWith("https://")).toBe(true);
      if (preset.auth === "oauth") {
        expect(preset.oauthSource).toBeDefined();
        expect(preset.billing).toBe("subscription");
      } else {
        expect(preset.apiKeyEnv?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it("finds presets by id", () => {
    expect(findPreset("deepseek")?.type).toBe("both");
    expect(findPreset("anthropic")?.type).toBe("anthropic");
    expect(findPreset("openrouter")?.type).toBe("both");
    expect(findPreset("opencode-go")?.type).toBe("both");
    expect(findPreset("commandcode")?.type).toBe("both");
    expect(findPreset("nope")).toBeUndefined();
  });

  it("routes dual-wire providers on either protocol", () => {
    const config = parseConfig({
      providers: [{ name: "dual", type: "both", baseUrl: "https://example.com/v1", models: ["m"] }],
    });
    const provider = config.providers[0];
    if (!provider) throw new Error("missing provider");
    expect(providerSpeaks(provider, "openai")).toBe(true);
    expect(providerSpeaks(provider, "anthropic")).toBe(true);
    expect(providerSpeaks(provider, "responses")).toBe(false);
  });

  it("lets Anthropic clients reach OpenAI-wire providers via bridge", () => {
    const config = parseConfig({
      providers: [
        { name: "chat", type: "openai", baseUrl: "https://example.com/v1", models: ["m"] },
      ],
    });
    const provider = config.providers[0];
    if (!provider) throw new Error("missing provider");
    expect(providerSpeaks(provider, "anthropic")).toBe(false);
    expect(canServeClient(provider, "anthropic")).toBe(true);
  });

  it("maps npm packages to protocol types", () => {
    expect(typeFromNpm("@ai-sdk/anthropic")).toBe("anthropic");
    expect(typeFromNpm("@ai-sdk/openai-compatible")).toBe("openai");
    expect(typeFromNpm(undefined)).toBe("openai");
  });

  it("normalizes base urls", () => {
    expect(normalizeBaseUrl(" https://api.example.com/v1/// ")).toBe("https://api.example.com/v1");
  });
});
