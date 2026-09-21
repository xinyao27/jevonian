import { describe, expect, it } from "vite-plus/test";

import { resolveProviderAuth, withOpenRouterAttribution, withSessionAffinity } from "./auth";
import { parseConfig, type Provider } from "./config";

function provider(baseUrl: string): Provider {
  const config = parseConfig({
    providers: [{ name: "p", type: "both", baseUrl, apiKey: "test", models: ["m"] }],
  });
  const parsed = config.providers[0];
  if (!parsed) throw new Error("missing provider");
  return parsed;
}

describe("withSessionAffinity", () => {
  it("adds x-opencode-session for opencode providers", () => {
    const headers: Record<string, string> = {};
    withSessionAffinity(headers, provider("https://opencode.ai/zen/go/v1"), "sess-1", {});
    expect(headers["x-opencode-session"]).toBe("sess-1");

    const forwarded: Record<string, string> = {};
    withSessionAffinity(forwarded, provider("https://opencode.ai/zen/go/v1"), "sess-2", {
      "x-opencode-session": "client-session",
    });
    expect(forwarded["x-opencode-session"]).toBe("client-session");
  });

  it("leaves other providers untouched", () => {
    const headers: Record<string, string> = {};
    withSessionAffinity(headers, provider("https://api.deepseek.com/v1"), "sess-1", {});
    expect(headers["x-opencode-session"]).toBeUndefined();
  });
});

describe("withOpenRouterAttribution", () => {
  it("adds OpenRouter app attribution", () => {
    const headers: Record<string, string> = {};
    withOpenRouterAttribution(headers, "https://openrouter.ai/api/v1");
    expect(headers).toMatchObject({
      "HTTP-Referer": "https://github.com/xinyao27/jevonian",
      "X-Title": "Jevonian",
    });
  });

  it("leaves other providers untouched", () => {
    const headers: Record<string, string> = {};
    withOpenRouterAttribution(headers, "https://api.deepseek.com/v1");
    expect(headers["HTTP-Referer"]).toBeUndefined();
    expect(headers["X-Title"]).toBeUndefined();
  });

  it("keeps caller-provided attribution", () => {
    const headers: Record<string, string> = {
      "HTTP-Referer": "https://example.com/app",
      "X-Title": "Example",
    };
    withOpenRouterAttribution(headers, "https://openrouter.ai/api/v1");
    expect(headers["HTTP-Referer"]).toBe("https://example.com/app");
    expect(headers["X-Title"]).toBe("Example");
  });
});

describe("resolveProviderAuth", () => {
  it("attributes OpenRouter model calls to Jevonian", async () => {
    const auth = await resolveProviderAuth(provider("https://openrouter.ai/api/v1"), "openai");
    expect(auth.headers["HTTP-Referer"]).toBe("https://github.com/xinyao27/jevonian");
    expect(auth.headers["X-Title"]).toBe("Jevonian");
  });
});
