import { describe, expect, it } from "vite-plus/test";

import type { Provider } from "./config";
import { modelEntries } from "./config";
import {
  canServeClient,
  inferModelWires,
  normalizeProviderType,
  planUpstreamWire,
  providerSpeaks,
  upstreamUrlFor,
  wiresOf,
} from "./wire";

function provider(
  partial: Partial<Provider> & Pick<Provider, "name" | "type" | "baseUrl">,
): Provider {
  return {
    auth: "api-key",
    billing: "api",
    models: [],
    injectStreamUsage: true,
    ...partial,
  };
}

describe("normalizeProviderType", () => {
  it("promotes OpenRouter and DeepSeek openai → both", () => {
    expect(normalizeProviderType("openai", "https://openrouter.ai/api/v1")).toBe("both");
    expect(normalizeProviderType("openai", "https://api.deepseek.com/v1")).toBe("both");
  });

  it("leaves unrelated openai hosts alone", () => {
    expect(normalizeProviderType("openai", "https://api.example.com/v1")).toBe("openai");
  });
});

describe("providerSpeaks vs canServeClient", () => {
  it("speaks = native only; canServe = native or bridgeable", () => {
    const openaiOnly = provider({
      name: "chat",
      type: "openai",
      baseUrl: "https://api.example.com/v1",
    });
    expect(providerSpeaks(openaiOnly, "openai")).toBe(true);
    expect(providerSpeaks(openaiOnly, "anthropic")).toBe(false);
    expect(canServeClient(openaiOnly, "anthropic")).toBe(true);
    expect(canServeClient(openaiOnly, "responses")).toBe(true);

    const both = provider({
      name: "dual",
      type: "both",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(providerSpeaks(both, "openai")).toBe(true);
    expect(providerSpeaks(both, "anthropic")).toBe(true);
    expect(canServeClient(both, "anthropic")).toBe(true);
  });
});

describe("planUpstreamWire", () => {
  it("bridges Anthropic clients onto pure OpenAI hosts", () => {
    const plan = planUpstreamWire({
      provider: provider({
        name: "chat",
        type: "openai",
        baseUrl: "https://api.example.com/v1",
        models: modelEntries("deepseek-v4.1-flash"),
      }),
      client: "anthropic",
      model: "deepseek-v4.1-flash",
    });
    expect(plan).toEqual({ wire: "openai", bridge: "to-openai" });
  });

  it("keeps Anthropic on DeepSeek / OpenRouter (native dual-wire)", () => {
    for (const baseUrl of ["https://api.deepseek.com/v1", "https://openrouter.ai/api/v1"]) {
      const plan = planUpstreamWire({
        provider: provider({
          name: "dual",
          type: "both",
          baseUrl,
          models: modelEntries("deepseek-v4.1-flash"),
        }),
        client: "anthropic",
        model: "deepseek-v4.1-flash",
      });
      expect(plan).toEqual({ wire: "anthropic", bridge: "none" });
    }
  });

  it("bridges Anthropic → OpenAI on OpenCode when the model is not Claude", () => {
    const plan = planUpstreamWire({
      provider: provider({
        name: "opencode-go",
        type: "both",
        baseUrl: "https://opencode.ai/zen/go/v1",
        models: modelEntries("deepseek-v4.1-flash"),
      }),
      client: "anthropic",
      model: "deepseek-v4.1-flash",
    });
    expect(plan).toEqual({ wire: "openai", bridge: "to-openai" });
  });

  it("sends Claude models to Anthropic on both providers", () => {
    const plan = planUpstreamWire({
      provider: provider({
        name: "opencode-go",
        type: "both",
        baseUrl: "https://opencode.ai/zen/go/v1",
        models: modelEntries("claude-sonnet-4-5"),
      }),
      client: "openai",
      model: "claude-sonnet-4-5",
    });
    expect(plan).toEqual({ wire: "anthropic", bridge: "to-anthropic" });
  });

  it("honors an explicit per-model wire pin over inference", () => {
    const pinned = provider({
      name: "opencode-go",
      type: "both",
      baseUrl: "https://opencode.ai/zen/go/v1",
      models: [{ id: "deepseek-v4.1-flash", wire: "openai" }],
    });
    expect(wiresOf(pinned, "deepseek-v4.1-flash")).toEqual(["openai"]);
    expect(
      planUpstreamWire({
        provider: pinned,
        client: "responses",
        model: "deepseek-v4.1-flash",
      }),
    ).toEqual({ wire: "openai", bridge: "to-openai" });
  });

  it("bridges Responses clients onto OpenAI / both / Gemini hosts", () => {
    const openrouter = provider({
      name: "openrouter",
      type: "both",
      baseUrl: "https://openrouter.ai/api/v1",
      models: modelEntries("openai/gpt-6-astra"),
    });
    const gemini = provider({
      name: "antigravity",
      type: "gemini",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      models: modelEntries("gemini-3.8-flash"),
    });
    expect(canServeClient(openrouter, "responses")).toBe(true);
    expect(canServeClient(gemini, "responses")).toBe(true);
    expect(
      planUpstreamWire({ provider: openrouter, client: "responses", model: "openai/gpt-6-astra" }),
    ).toEqual({ wire: "openai", bridge: "to-openai" });
    expect(
      planUpstreamWire({ provider: gemini, client: "responses", model: "gemini-3.8-flash" }),
    ).toEqual({ wire: "openai", bridge: "to-openai" });
  });

  it("keeps Responses clients on OpenCode's native /responses wire", () => {
    const opencode = provider({
      name: "opencode-go",
      type: "both",
      baseUrl: "https://opencode.ai/zen/go/v1",
      models: modelEntries("deepseek-v4.1-flash"),
    });
    expect(inferModelWires(opencode, "deepseek-v4.1-flash")).toEqual(["openai", "responses"]);
    expect(
      planUpstreamWire({
        provider: opencode,
        client: "responses",
        model: "deepseek-v4.1-flash",
      }),
    ).toEqual({ wire: "responses", bridge: "none" });
    expect(upstreamUrlFor(opencode, "responses")).toBe("https://opencode.ai/zen/go/v1/responses");
  });
});

describe("upstreamUrlFor", () => {
  it("keeps OpenRouter Anthropic on the shared /api/v1 root", () => {
    const openrouter = provider({
      name: "openrouter",
      type: "both",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    expect(upstreamUrlFor(openrouter, "anthropic")).toBe("https://openrouter.ai/api/v1/messages");
    expect(upstreamUrlFor(openrouter, "openai")).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
  });

  it("rewrites DeepSeek Anthropic onto /anthropic/v1/messages", () => {
    const deepseek = provider({
      name: "deepseek",
      type: "both",
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(upstreamUrlFor(deepseek, "anthropic")).toBe(
      "https://api.deepseek.com/anthropic/v1/messages",
    );
    expect(upstreamUrlFor(deepseek, "openai")).toBe("https://api.deepseek.com/v1/chat/completions");
  });
});
