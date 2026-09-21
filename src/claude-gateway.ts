import type { Config } from "./config";
import { desktopModels } from "./routing";

/**
 * Claude Desktop's third-party ("gateway") mode is not a generic Anthropic
 * client. Its model picker is driven by a registry of Claude models the app
 * ships with: a discovered row is kept only when the app already knows the id,
 * and a configured row is dropped when the id is not an Anthropic model. A
 * gateway therefore cannot invent ids like `jevonian/auto` — it has to stand in
 * for a Claude model, the same way Ollama does.
 *
 * So Jevonian maps the models it injects into the desktop picker onto the
 * ids the app knows how to render, and translates those ids back to Jevonian
 * aliases when a request arrives. ChatGPT Desktop gets a dual catalog
 * (native + `jevonian/auto`); Claude's third-party gateway can only show the
 * injected stand-ins — one slot for Auto, the same way Ollama limits the list.
 */
export type ClaudeGatewayFamily = "sonnet" | "opus" | "haiku" | "fable" | "mythos";

export interface ClaudeGatewaySlot {
  /** The id Claude Desktop sends back in `/v1/messages`. */
  id: string;
  /** The Jevonian model this slot routes to. */
  model: string;
  /** What the picker shows instead of the underlying Claude name. */
  label: string;
  family: ClaudeGatewayFamily;
  createdAt: string;
}

/**
 * Claude ids that are valid for a third-party gateway. The app ships runtime
 * details — context window, effort levels, capability flags — for exactly these
 * ids, so standing in for one keeps the picker's per-model settings working.
 */
const SLOT_TEMPLATES: ReadonlyArray<{
  id: string;
  family: ClaudeGatewayFamily;
  createdAt: string;
}> = [
  { id: "claude-sonnet-5", family: "sonnet", createdAt: "2026-06-30T00:00:00Z" },
  { id: "claude-opus-5", family: "opus", createdAt: "2026-07-24T00:00:00Z" },
  { id: "claude-sonnet-4-6", family: "sonnet", createdAt: "2025-11-18T00:00:00Z" },
  { id: "claude-haiku-4-5-20251001", family: "haiku", createdAt: "2025-10-01T00:00:00Z" },
];

/** `jevonian/auto` reads as "Jevonian Auto"; other ids keep their own words. */
function labelFor(model: string): string {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const words = tail
    .split(/[-_.\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));
  return ["Jevonian", ...words].join(" ");
}

/**
 * Pairs the models a client is offered with the Claude ids the app accepts.
 * More models than slots is fine: the surplus still reaches a client under its
 * own id, it just does not get a Claude stand-in.
 */
export function claudeGatewaySlots(models: readonly string[]): ClaudeGatewaySlot[] {
  return models.slice(0, SLOT_TEMPLATES.length).map((model, index) => {
    const template = SLOT_TEMPLATES[index];
    return {
      id: template.id,
      model,
      label: labelFor(model),
      family: template.family,
      createdAt: template.createdAt,
    };
  });
}

/**
 * Claude Desktop treats the config's model list as authoritative when model
 * discovery is switched off, which is the path the app's own setup error
 * recommends ("add entries under Models to skip discovery"). Declaring the list
 * means the app never has to parse a gateway model list, and every id it can
 * send is one we know how to route.
 */
export function claudeGatewayProfileModels(
  models: readonly string[],
): Array<Record<string, unknown>> {
  const defaults = new Set<string>();
  return claudeGatewaySlots(models).map((slot) => {
    const isDefault = !defaults.has(slot.family);
    defaults.add(slot.family);
    return {
      name: slot.id,
      labelOverride: slot.label,
      anthropicFamilyTier: slot.family,
      ...(isDefault ? { isFamilyDefault: true } : {}),
    };
  });
}

/**
 * True for the requests Claude Desktop's gateway client makes. It is the only
 * client pointed at Jevonian that speaks the Anthropic wire, and it stamps
 * every call with the API version.
 */
export function isClaudeGatewayRequest(headers: Headers): boolean {
  const version = headers.get("anthropic-version");
  return version !== null && version.trim() !== "";
}

/**
 * The Anthropic model-list page. A gateway client parses `data` entries for
 * `anthropic_family_tier`, and ignores rows without a tier it recognises, so
 * the tier is what makes an entry visible at all.
 */
export function claudeGatewayModels(models: readonly string[]): Record<string, unknown> {
  const data = claudeGatewaySlots(models).map((slot) => ({
    id: slot.id,
    type: "model",
    display_name: slot.label,
    created_at: slot.createdAt,
    anthropic_family_tier: slot.family,
  }));
  return {
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more: false,
  };
}

/**
 * Turns a Claude stand-in id back into the model it stands for. Returns
 * undefined when the id is not one of ours, so a client asking for a real
 * Claude model — or a provider that genuinely serves that id — is left alone
 * when routing is off.
 *
 * In `auto` mode these ids ARE the aggregated surface (OpenCode / Claude Desktop
 * health checks send `claude-haiku-4-5-20251001` for "Jevonian Utility"). A
 * provider that happens to catalog the same snapshot — OpenCode Go especially —
 * must not steal the request into a pinned pass-through, or the probe lands on
 * an exhausted subscription instead of running through jevonian/* routing.
 */
export function resolveClaudeGatewayModel(
  requested: string,
  config: Config,
  fromGateway: boolean,
): string | undefined {
  const slot = claudeGatewaySlots(desktopModels(config)).find(
    (candidate) => candidate.id === requested,
  );
  if (!slot) return undefined;
  if (config.routing.mode === "auto") return slot.model;
  if (!fromGateway) return undefined;
  // Manual mode: an explicitly configured provider model keeps the user's pin.
  const pinned = config.providers.some((provider) =>
    provider.models.some((entry) => entry.id === requested),
  );
  return pinned ? undefined : slot.model;
}
