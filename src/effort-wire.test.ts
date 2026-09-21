import { describe, expect, it } from "vite-plus/test";

import { clientEffortOf, effortInBody, stripForeignEffort, withEffort } from "./upstream";

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

describe("client override", () => {
  it("leaves the client's level in place when it conflicts with the router", () => {
    const body = { reasoning_effort: "max" };
    const out = withEffort(body, "low", "openai", clientEffortOf(body, "openai"));
    expect(out).toBe(body);
    // And the log reports the client's level, because that is what the model was sent.
    expect(effortInBody(out, "openai", "low")).toBe("max");
  });
});
