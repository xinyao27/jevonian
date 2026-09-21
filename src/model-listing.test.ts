import { describe, expect, it } from "vite-plus/test";

import { parseConfig, type Config } from "./config";
import { modelsPayload } from "./server";

const config = (routing: Record<string, unknown> = {}, providers: unknown[] = []) =>
  parseConfig({
    providers:
      providers.length > 0
        ? providers
        : [
            {
              name: "sub",
              type: "responses",
              baseUrl: "http://127.0.0.1:1/v1",
              apiKey: "test",
              models: ["gpt-6-astra", "gemini-3.8-flash-tiered", "deepseek-v4.1-flash"],
            },
          ],
    routing: { mode: "auto", tiers: { plan: ["gpt-6-astra"] }, ...routing },
  }) as Config;

const ids = (config_: Config): string[] =>
  modelsPayload(config_).map((model) => model.id as string);

describe("the models Jevonian advertises", () => {
  it("offers its own aliases, not the provider models behind them", () => {
    // A picker fed provider ids suggests those instead of the routing aliases: ChatGPT
    // Desktop listed `gpt-6-astra`, `deepseek-v4-1-flash` and `gemini-3-8-flash` where
    // `jevonian/auto` was meant to appear.
    const listed = ids(config());
    expect(listed).toEqual([
      "jevonian/auto",
      "jevonian/plan",
      "jevonian/execute",
      "jevonian/utility",
      "jevonian/chat",
    ]);
    expect(listed).not.toContain("gpt-6-astra");
    expect(listed).not.toContain("deepseek-v4-1-flash");
  });

  it("marks every row as offered by Jevonian", () => {
    for (const model of modelsPayload(config())) {
      expect(model.object).toBe("model");
      expect(model.owned_by).toBe("jevonian");
    }
  });

  it("names the pinned model when routing is off", () => {
    expect(ids(config({ mode: "off", baselineModel: "gpt-6-astra" }))).toEqual(["gpt-6-astra"]);
  });

  it("lists the configured providers' models when routing is off and nothing is pinned", () => {
    // With the router out of the way there is no alias to offer, so the listing is the
    // catalog the user configured — deduplicated, since two providers may share a model.
    const listed = ids(
      config({ mode: "off", baselineModel: undefined }, [
        {
          name: "one",
          type: "openai",
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "test",
          models: ["shared", "only-one"],
        },
        {
          name: "two",
          type: "openai",
          baseUrl: "http://127.0.0.1:2/v1",
          apiKey: "test",
          models: ["shared", "only-two"],
        },
      ]),
    );
    expect(listed).toEqual(["shared", "only-one", "only-two"]);
  });
});
