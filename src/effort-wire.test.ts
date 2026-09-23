import { describe, expect, it } from "vite-plus/test";

import {
  anthropicThinkingSupport,
  BRIDGED_THINKING_MAX_TOKENS,
  fitThinkingMaxTokens,
  THINKING_HEADROOM,
} from "./anthropic-thinking";
import { responsesToChatRequest } from "./responses";
import {
  bridgedAnthropicBody,
  clientEffortOf,
  effortInBody,
  normalizeAnthropicThinking,
  stripForeignEffort,
  withEffort,
} from "./upstream";

describe("withEffort", () => {
  it("writes reasoning_effort on the OpenAI wire", () => {
    expect(withEffort({ model: "m" }, "high", "openai")).toEqual({
      model: "m",
      reasoning_effort: "high",
    });
  });

  it("writes a token budget on the Anthropic wire", () => {
    expect(withEffort({ model: "m" }, "medium", "anthropic")).toEqual({
      model: "m",
      thinking: { type: "enabled", budget_tokens: 8_192 },
    });
  });

  it("disables thinking explicitly on the Anthropic wire when the level is none", () => {
    // Written rather than omitted: a model that thinks by default would otherwise keep thinking.
    expect(withEffort({ model: "m" }, "none", "anthropic")).toEqual({
      model: "m",
      thinking: { type: "disabled" },
    });
  });

  it("writes a reasoning object on the Responses wire", () => {
    expect(withEffort({ model: "m" }, "low", "responses")).toEqual({
      model: "m",
      reasoning: { effort: "low" },
    });
  });

  it("turns reasoning off explicitly rather than omitting it", () => {
    // A model that defaults to thinking would keep thinking if the field were merely absent.
    expect(withEffort({ model: "m" }, "none", "responses")).toEqual({
      model: "m",
      reasoning: null,
    });
    expect(withEffort({ model: "m" }, "none", "openai")).toEqual({
      model: "m",
      reasoning_effort: "none",
    });
  });

  it("spells effort per wire when the body keeps the client's shape", () => {
    // A native Responses request must get `reasoning`, never `reasoning_effort`:
    // sending the OpenAI spelling on that wire is rejected upstream with
    // "Unsupported parameter: reasoning_effort".
    expect(withEffort({ model: "m" }, "medium", "responses")).toEqual({
      model: "m",
      reasoning: { effort: "medium" },
    });
    expect(withEffort({ model: "m" }, "medium", "openai")).toEqual({
      model: "m",
      reasoning_effort: "medium",
    });
  });

  it("leaves the body alone when the router has no level to apply", () => {
    expect(withEffort({ model: "m" }, undefined, "openai")).toEqual({ model: "m" });
  });

  it("never overrides a level the client set itself", () => {
    const body = { model: "m", reasoning_effort: "max" };
    expect(withEffort(body, "low", "openai", "max")).toBe(body);
  });

  it("drops a level spelled for another wire instead of forwarding it", () => {
    // Codex has sent the Chat Completions `reasoning_effort` on native
    // `/v1/responses` calls; a Responses upstream answers that spelling with
    // "Unsupported parameter: reasoning_effort", so it must not survive.
    expect(stripForeignEffort({ model: "m", reasoning_effort: "low" }, "responses")).toEqual({
      model: "m",
    });
    expect(withEffort({ model: "m", reasoning_effort: "low" }, "none", "responses")).toEqual({
      model: "m",
      reasoning: null,
    });
    // And the same in reverse: a Responses body must not carry `reasoning` to a
    // Chat Completions endpoint, nor either spelling to Anthropic.
    expect(stripForeignEffort({ model: "m", reasoning: { effort: "low" } }, "openai")).toEqual({
      model: "m",
    });
    expect(
      stripForeignEffort({ model: "m", reasoning_effort: "low", thinking: undefined }, "anthropic"),
    ).toEqual({ model: "m", thinking: undefined });
  });

  it("leaves the wire's own spelling in place", () => {
    const body = { model: "m", reasoning_effort: "low" };
    expect(stripForeignEffort(body, "openai")).toBe(body);
  });

  it("maps deeper levels to larger budgets", () => {
    const budget = (effort: Parameters<typeof withEffort>[1]) => {
      const out = withEffort({}, effort, "anthropic") as {
        thinking?: { budget_tokens: number };
      };
      return out.thinking?.budget_tokens ?? 0;
    };
    expect(budget("minimal")).toBeLessThan(budget("low"));
    expect(budget("low")).toBeLessThan(budget("medium"));
    expect(budget("medium")).toBeLessThan(budget("high"));
    expect(budget("high")).toBeLessThan(budget("max"));
  });
});

describe("effortInBody", () => {
  it("reads back the level from each wire's own field", () => {
    expect(effortInBody({ reasoning_effort: "high" }, "openai")).toBe("high");
    expect(effortInBody({ reasoning: { effort: "low" } }, "responses")).toBe("low");
    expect(effortInBody({ reasoning: null }, "responses")).toBe("none");
    expect(effortInBody({ thinking: { type: "disabled" } }, "anthropic")).toBe("none");
    expect(effortInBody({ thinking: { type: "enabled", budget_tokens: 2_048 } }, "anthropic")).toBe(
      "low",
    );
  });

  it("round-trips every level through each wire", () => {
    for (const wire of ["openai", "responses", "anthropic"] as const) {
      for (const level of ["none", "minimal", "low", "medium", "high", "max"] as const) {
        const body = withEffort({}, level, wire);
        expect(effortInBody(body, wire, level), `${wire}/${level}`).toBe(level);
      }
    }
  });

  it("uses the hint to tell apart budgets that collide", () => {
    // `max` and `ultra` share an Anthropic budget, so the inverse alone cannot name them.
    const body = withEffort({}, "ultra", "anthropic");
    expect(effortInBody(body, "anthropic", "ultra")).toBe("ultra");
    expect(effortInBody(body, "anthropic", "max")).toBe("max");
  });

  it("finds nothing when the body carries no level", () => {
    expect(effortInBody({}, "openai")).toBeUndefined();
    expect(effortInBody({}, "anthropic")).toBeUndefined();
    expect(effortInBody({}, "responses")).toBeUndefined();
  });
});

describe("clientEffortOf", () => {
  it("detects the client's own level on every wire", () => {
    // Each wire puts the request-side level in its own field; all three must be recognised,
    // or the router would override the client and misreport what it sent.
    expect(clientEffortOf({ reasoning_effort: "high" }, "openai")).toBe("high");
    expect(clientEffortOf({ reasoning: { effort: "low" } }, "responses")).toBe("low");
    expect(clientEffortOf({ thinking: { budget_tokens: 16_384 } }, "anthropic")).toBe("high");
    expect(clientEffortOf({ thinking: { type: "disabled" } }, "anthropic")).toBe("none");
  });

  it("finds nothing when the client expressed no preference", () => {
    expect(clientEffortOf({}, "openai")).toBeUndefined();
    expect(clientEffortOf({}, "anthropic")).toBeUndefined();
  });
});

describe("adaptive thinking on newer Claude models", () => {
  it("classifies models by what they accept", () => {
    expect(anthropicThinkingSupport("claude-sonnet-4-5-20250929").adaptive).toBe(false);
    expect(anthropicThinkingSupport("claude-opus-4-5-20251101").adaptive).toBe(false);
    expect(anthropicThinkingSupport("claude-haiku-4-5-20251001").adaptive).toBe(false);
    expect(anthropicThinkingSupport("claude-opus-4-6")).toMatchObject({
      adaptive: true,
      rejectsEnabled: false,
      rejectsDisabled: false,
    });
    expect(anthropicThinkingSupport("claude-opus-4-7")).toMatchObject({
      rejectsEnabled: true,
      rejectsDisabled: false,
    });
    expect(anthropicThinkingSupport("claude-sonnet-5").rejectsDisabled).toBe(false);
    expect(anthropicThinkingSupport("claude-opus-5").rejectsDisabled).toBe(false);
    for (const model of [
      "claude-opus-5-5",
      "claude-fable-5",
      "claude-fable-5-1",
      "claude-mythos-5",
    ]) {
      expect(anthropicThinkingSupport(model), model).toMatchObject({
        adaptive: true,
        rejectsEnabled: true,
        rejectsDisabled: true,
      });
    }
    expect(anthropicThinkingSupport("claude-mythos-preview").rejectsEnabled).toBe(false);
    expect(anthropicThinkingSupport("gpt-5").adaptive).toBe(false);
  });

  it("writes adaptive thinking with output_config.effort instead of a budget", () => {
    expect(withEffort({ model: "claude-opus-4-7" }, "medium", "anthropic")).toEqual({
      model: "claude-opus-4-7",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
    // Opus 4.6 lacks xhigh, so it falls back to high rather than being rejected.
    expect(withEffort({ model: "claude-opus-4-6" }, "xhigh", "anthropic")).toMatchObject({
      output_config: { effort: "high" },
    });
    expect(withEffort({ model: "claude-opus-4-8" }, "ultra", "anthropic")).toMatchObject({
      output_config: { effort: "max" },
    });
  });

  it("never sends disabled to an always-on model", () => {
    expect(withEffort({ model: "claude-fable-5-1" }, "none", "anthropic")).toEqual({
      model: "claude-fable-5-1",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
    // Models that accept an explicit off still get it.
    expect(withEffort({ model: "claude-sonnet-5" }, "none", "anthropic")).toEqual({
      model: "claude-sonnet-5",
      thinking: { type: "disabled" },
    });
  });

  it("translates a client's disabled thinking for always-on models", () => {
    const body = { model: "claude-opus-5-5", thinking: { type: "disabled" } };
    const out = withEffort(body, "high", "anthropic", clientEffortOf(body, "anthropic"));
    expect(out).toEqual({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
    });
  });

  it("translates a client's budget_tokens for models without extended thinking", () => {
    const body = {
      model: "claude-opus-4-7",
      thinking: { type: "enabled", budget_tokens: 10_000, display: "summarized" },
      output_config: { format: { type: "json_schema" } },
    };
    expect(withEffort(body, undefined, "anthropic")).toEqual({
      model: "claude-opus-4-7",
      thinking: { type: "adaptive", display: "summarized" },
      output_config: { format: { type: "json_schema" }, effort: "high" },
    });
  });

  it("leaves shapes the model accepts untouched", () => {
    const legacy = { model: "claude-sonnet-4-5", thinking: { type: "disabled" } };
    expect(normalizeAnthropicThinking(legacy)).toBe(legacy);
    const accepted = {
      model: "claude-opus-4-6",
      thinking: { type: "enabled", budget_tokens: 2_048 },
    };
    expect(normalizeAnthropicThinking(accepted)).toBe(accepted);
  });

  it("reads the adaptive level back for the log and the client override", () => {
    const body = withEffort({ model: "claude-opus-4-7" }, "minimal", "anthropic");
    expect(effortInBody(body, "anthropic", "minimal")).toBe("minimal");
    expect(effortInBody(body, "anthropic")).toBe("low");
    expect(
      clientEffortOf({ model: "claude-opus-4-7", output_config: { effort: "xhigh" } }, "anthropic"),
    ).toBe("xhigh");
  });
});

describe("fitThinkingMaxTokens", () => {
  it("raises max_tokens above a legacy thinking budget", () => {
    // Anthropic requires max_tokens > budget_tokens; the bridge default of 4_096 is below it.
    const body = { max_tokens: 4_096, thinking: { type: "enabled", budget_tokens: 16_384 } };
    expect(fitThinkingMaxTokens(body, { clientSetMax: false })).toEqual({
      max_tokens: 16_384 + THINKING_HEADROOM,
      thinking: { type: "enabled", budget_tokens: 16_384 },
    });
    // Even a client's own max_tokens is raised: the alternative is a guaranteed 400.
    expect(fitThinkingMaxTokens(body, { clientSetMax: true }).max_tokens).toBe(
      16_384 + THINKING_HEADROOM,
    );
  });

  it("shrinks the budget instead of exceeding the model's output cap", () => {
    const body = { max_tokens: 4_096, thinking: { type: "enabled", budget_tokens: 32_768 } };
    expect(fitThinkingMaxTokens(body, { clientSetMax: false, maxOutput: 16_000 })).toEqual({
      max_tokens: 16_000,
      thinking: { type: "enabled", budget_tokens: 16_000 - THINKING_HEADROOM },
    });
  });

  it("keeps a max_tokens that already covers the budget", () => {
    const body = { max_tokens: 64_000, thinking: { type: "enabled", budget_tokens: 16_384 } };
    expect(fitThinkingMaxTokens(body, { clientSetMax: true })).toBe(body);
  });

  it("gives adaptive thinking a roomier default only when the client set none", () => {
    const body = { max_tokens: 4_096, thinking: { type: "adaptive" } };
    expect(fitThinkingMaxTokens(body, { clientSetMax: false }).max_tokens).toBe(
      BRIDGED_THINKING_MAX_TOKENS,
    );
    expect(fitThinkingMaxTokens(body, { clientSetMax: false, maxOutput: 8_000 }).max_tokens).toBe(
      8_000,
    );
    expect(fitThinkingMaxTokens(body, { clientSetMax: true })).toBe(body);
  });

  it("leaves bodies without thinking alone", () => {
    const body = { max_tokens: 4_096, thinking: { type: "disabled" } };
    expect(fitThinkingMaxTokens(body, { clientSetMax: false })).toBe(body);
  });
});

describe("bridgedAnthropicBody", () => {
  const chat = { messages: [{ role: "user", content: "hi" }] };

  it("carries a Chat client's reasoning_effort into legacy thinking", () => {
    const body = { ...chat, reasoning_effort: "high" };
    const out = bridgedAnthropicBody(body, {
      model: "claude-sonnet-4-5-20250929",
      stream: false,
      effort: "low",
      clientEffort: clientEffortOf(body, "openai"),
    });
    expect(out.thinking).toEqual({ type: "enabled", budget_tokens: 16_384 });
    expect(out.max_tokens).toBe(16_384 + THINKING_HEADROOM);
    expect(out).not.toHaveProperty("reasoning_effort");
  });

  it("carries a Responses client's reasoning.effort into adaptive thinking", () => {
    // Codex sends `reasoning: {effort: "high"}`; it used to be detected (so the router skipped
    // its own level) and then dropped by chatToAnthropic, leaving Claude with no thinking.
    const responses = { input: "hi", reasoning: { effort: "high" } };
    const out = bridgedAnthropicBody(responsesToChatRequest(responses, "claude-opus-4-7"), {
      model: "claude-opus-4-7",
      stream: true,
      clientEffort: clientEffortOf(responses, "responses"),
    });
    expect(out.thinking).toEqual({ type: "adaptive" });
    expect(out.output_config).toEqual({ effort: "high" });
    expect(out.max_tokens).toBe(BRIDGED_THINKING_MAX_TOKENS);
  });

  it("falls back to the router's level and respects the client's max_tokens", () => {
    const out = bridgedAnthropicBody(
      { ...chat, max_tokens: 2_000 },
      { model: "claude-opus-4-7", stream: false, effort: "medium" },
    );
    expect(out.output_config).toEqual({ effort: "medium" });
    expect(out.max_tokens).toBe(2_000);
  });
});

describe("client override", () => {
  it("leaves the client's level in place when it conflicts with the router", () => {
    const body = { reasoning_effort: "max" };
    const out = withEffort(body, "low", "openai", clientEffortOf(body, "openai"));
    expect(out).toBe(body);
    // And the log reports the client's level, because that is what the model was sent.
    expect(effortInBody(out, "openai", "low")).toBe("max");
  });
});
