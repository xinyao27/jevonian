import { describe, expect, it } from "vite-plus/test";

import { costOf, isDeepSeekPeak, priceFor, usePriceTable } from "./pricing";

const usage = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("priceFor", () => {
  it("resolves vendor-prefixed model ids to the bare id", () => {
    expect(priceFor("deepseek/deepseek-v4.1-flash")?.output).toBe(0.6);
  });

  it("returns undefined for unknown models", () => {
    expect(priceFor("no-such-model")).toBeUndefined();
  });

  it("falls back to the base id when upstream adds a service tier", () => {
    usePriceTable({ "gemini-3.8-flash": { provider: "google", input: 0.75, output: 3.75 } });
    expect(priceFor("gemini-3.8-flash-tiered")?.input).toBe(0.75);
  });

  it("strips reasoning variants for models that do not price them separately", () => {
    usePriceTable({ "claude-opus-4-6": { provider: "anthropic", input: 5, output: 25 } });
    expect(priceFor("claude-opus-4-6-thinking")?.output).toBe(25);
  });

  it("keeps the literal id so reseller variants do not win", () => {
    usePriceTable({
      "gemini-3.8-flash": { provider: "google", input: 0.75, output: 3.75 },
      "gemini-3-8-flash": { provider: "venice", input: 0.9375, output: 4.6875 },
    });
    expect(priceFor("gemini-3.8-flash-tiered")?.provider).toBe("google");
  });

  it("prefers an exact match over a stripped base id", () => {
    usePriceTable({
      "gemini-3.6-flash": { provider: "google", input: 0.75, output: 3.75 },
      "gemini-3.6-flash-tiered": { provider: "google", input: 1, output: 2 },
    });
    expect(priceFor("gemini-3.6-flash-tiered")?.input).toBe(1);
  });

  it("leaves suffixes that are part of the model name alone", () => {
    usePriceTable({ "gemini-3.1-flash-lite": { provider: "google", input: 0.25, output: 1.5 } });
    expect(priceFor("gemini-3.1-flash-lite")?.input).toBe(0.25);
  });

  it("bills a named non-official provider at its own qualified rate", () => {
    usePriceTable({
      "gemini-3.8-flash": { provider: "google", input: 0.75, output: 3.75 },
      "imgproxy/gemini-3.8-flash": { provider: "imgproxy", input: 1.5, output: 7.5 },
    });
    expect(priceFor("gemini-3.8-flash", "google")?.provider).toBe("google");
    // A named non-official provider bills its own qualified listing, not the vendor list price.
    expect(priceFor("gemini-3.8-flash", "imgproxy")?.provider).toBe("imgproxy");
  });

  it("keeps an official provider's own rate over a reseller listing", () => {
    usePriceTable({
      "deepseek-v4-pro": { provider: "reseller", input: 9, output: 9 },
      "deepseek/deepseek-v4-pro": { provider: "deepseek", input: 0.435, output: 0.87 },
    });
    expect(priceFor("deepseek-v4-pro", "deepseek")?.provider).toBe("deepseek");
  });

  it("prefers the configured provider over an unrelated official vendor", () => {
    usePriceTable({
      "gemini-3.8-flash": { provider: "google", input: 0.75, output: 3.75 },
      "opencode/gemini-3.8-flash": { provider: "opencode", input: 1.5, output: 7.5 },
    });
    expect(priceFor("gemini-3.8-flash", "opencode")?.provider).toBe("opencode");
  });
});

describe("isDeepSeekPeak", () => {
  it("is off-peak on weekends", () => {
    expect(isDeepSeekPeak(new Date("2026-09-19T02:00:00Z"))).toBe(false);
  });

  it("is peak on weekday mornings UTC", () => {
    expect(isDeepSeekPeak(new Date("2026-09-18T02:00:00Z"))).toBe(true);
  });

  it("is off-peak outside the peak windows", () => {
    expect(isDeepSeekPeak(new Date("2026-09-18T12:00:00Z"))).toBe(false);
  });
});

describe("costOf", () => {
  it("bills DeepSeek V4.1 Flash at the off-peak list price", () => {
    const { usd, known } = costOf("deepseek-v4.1-flash", usage, new Date("2026-09-19T12:00:00Z"));
    expect(known).toBe(true);
    expect(usd).toBeCloseTo(0.15, 10);
  });

  it("bills double during DeepSeek peak hours", () => {
    const { usd } = costOf("deepseek-v4.1-flash", usage, new Date("2026-09-18T02:00:00Z"));
    expect(usd).toBeCloseTo(0.3, 10);
  });

  it("adds cache reads and writes for models that price them", () => {
    const { usd } = costOf(
      "claude-fable-5-1",
      { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      new Date("2026-09-19T12:00:00Z"),
    );
    expect(usd).toBeCloseTo(10 + 50 + 0.25 + 12.5, 10);
  });

  it("marks unknown models as unpriced", () => {
    expect(costOf("no-such-model", usage, new Date()).known).toBe(false);
  });

  it("prefers provider-qualified prices for a given provider", () => {
    usePriceTable({
      "deepseek/deepseek-v4-pro": { provider: "deepseek", input: 0.5, output: 1 },
      "reseller/deepseek-v4-pro": { provider: "reseller", input: 99, output: 99 },
    });
    expect(priceFor("deepseek-v4-pro", "deepseek")?.input).toBe(0.5);
    expect(priceFor("deepseek-v4-pro", "reseller")?.input).toBe(99);
  });
});
