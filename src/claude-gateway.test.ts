import { describe, expect, it } from "vite-plus/test";

import {
  claudeGatewayModels,
  claudeGatewayProfileModels,
  claudeGatewaySlots,
  isClaudeGatewayRequest,
  resolveClaudeGatewayModel,
} from "./claude-gateway";
import { parseConfig, type Config } from "./config";
import { desktopModels } from "./routing";

const config = (routing: Record<string, unknown> = {}, providers: unknown[] = []) =>
  parseConfig({
    defaultProvider: providers.length > 0 ? undefined : "sub",
    providers:
      providers.length > 0
        ? providers
        : [
            {
              name: "sub",
              type: "openai",
              baseUrl: "http://127.0.0.1:1/v1",
              apiKey: "test",
              models: ["m"],
            },
          ],
    routing: { mode: "auto", tiers: { plan: ["m"] }, ...routing },
  }) as Config;

describe("Claude Desktop gateway stand-ins", () => {
  it("maps only jevonian/auto onto a Claude stand-in id", () => {
    // Ollama-style desktop inject: keep one Auto slot, not every phase alias.
    const slots = claudeGatewaySlots(desktopModels(config()));
    expect(slots.map((slot) => slot.id)).toEqual(["claude-sonnet-5"]);
    expect(slots.map((slot) => slot.model)).toEqual(["jevonian/auto"]);
    expect(slots.map((slot) => slot.label)).toEqual(["Jevonian Auto"]);
  });

  it("declares one family default per tier, which is what the picker folds on", () => {
    const models = claudeGatewayProfileModels(desktopModels(config()));
    expect(models).toEqual([
      {
        name: "claude-sonnet-5",
        labelOverride: "Jevonian Auto",
        anthropicFamilyTier: "sonnet",
        isFamilyDefault: true,
      },
    ]);
  });

  it("advertises a tier on every row, because the app drops rows without one", () => {
    // The picker keeps a discovered row only when it knows the id or the row
    // states a family it recognises, so a Jevonian alias without a tier would
    // vanish and the connection test would report "no models".
    const page = claudeGatewayModels(desktopModels(config()));
    const rows = page.data as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.type).toBe("model");
      expect(typeof row.anthropic_family_tier).toBe("string");
      expect(typeof row.display_name).toBe("string");
      expect(typeof row.created_at).toBe("string");
    }
    expect(page.first_id).toBe("claude-sonnet-5");
    expect(page.last_id).toBe("claude-sonnet-5");
    expect(page.has_more).toBe(false);
  });

  it("only stands in for a client that identified itself as the gateway when routing is off", () => {
    const cfg = config({ mode: "off", baselineModel: "deepseek-v4-1-flash" });
    expect(isClaudeGatewayRequest(new Headers({ "anthropic-version": "2023-06-01" }))).toBe(true);
    expect(isClaudeGatewayRequest(new Headers())).toBe(false);

    expect(resolveClaudeGatewayModel("claude-sonnet-5", cfg, true)).toBe("deepseek-v4-1-flash");
    // A Codex or Cursor client must never be silently re-routed by a Claude id.
    expect(resolveClaudeGatewayModel("claude-sonnet-5", cfg, false)).toBeUndefined();
    expect(resolveClaudeGatewayModel("jevonian/auto", cfg, true)).toBeUndefined();
  });

  it("maps the Auto stand-in to jevonian/auto even when a provider catalogs Claude ids", () => {
    const withOpenCodeGo = config({ mode: "auto" }, [
      {
        name: "opencode-go",
        type: "both",
        baseUrl: "https://opencode.ai/zen/go/v1",
        apiKey: "test",
        models: ["claude-haiku-4-5-20251001", "claude-sonnet-4-6", "claude-sonnet-5"],
      },
    ]);
    // Desktop inject only maps Auto → claude-sonnet-5. Other Claude ids are not stand-ins.
    expect(resolveClaudeGatewayModel("claude-sonnet-5", withOpenCodeGo, true)).toBe(
      "jevonian/auto",
    );
    expect(resolveClaudeGatewayModel("claude-sonnet-5", withOpenCodeGo, false)).toBe(
      "jevonian/auto",
    );
    expect(
      resolveClaudeGatewayModel("claude-haiku-4-5-20251001", withOpenCodeGo, true),
    ).toBeUndefined();
  });

  it("leaves a provider-pinned Claude id alone when routing is off", () => {
    const pinned = config({ mode: "off", baselineModel: "deepseek-v4-1-flash" }, [
      {
        name: "anthropic",
        type: "anthropic",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "test",
        models: ["claude-sonnet-5"],
      },
    ]);
    // Manual mode: the user configured that exact model, so the stand-in must not intercept it.
    expect(resolveClaudeGatewayModel("claude-sonnet-5", pinned, true)).toBeUndefined();
  });

  it("offers upstream names when routing is off", () => {
    const manual = config({ mode: "off", baselineModel: "deepseek-v4-1-flash" });
    expect(claudeGatewaySlots(desktopModels(manual)).map((slot) => slot.model)).toEqual([
      "deepseek-v4-1-flash",
    ]);
    expect(claudeGatewaySlots(desktopModels(manual))[0].label).toBe("Jevonian Deepseek V4 1 Flash");
  });
});
