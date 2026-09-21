import { needsAnthropicWire } from "./anthropic";
import type { Provider, ProviderType } from "./config";

/**
 * Client ↔ provider wires.
 *
 * Three questions, answered in one place:
 *
 * 1. `providerSpeaks`  — does the host accept this wire natively (no body translation)?
 * 2. `canServeClient`  — may routing pick this provider for a client on that wire?
 * 3. `planUpstreamWire` — which wire to hit, and whether to translate the body?
 *
 * Wire choice is model-level: each `ModelEntry` may declare `wire`. When omitted, inference
 * from provider type + host + model id fills in. There is no runtime "read the 400 and flip".
 */

export type ClientWire = "openai" | "anthropic" | "responses";
export type UpstreamWire = ClientWire;

/** A configured model id, optionally pinned to the wire(s) it may use on this provider. */
export interface ModelEntry {
  id: string;
  /** Omit to infer from provider type, host, and model id. */
  wire?: UpstreamWire | UpstreamWire[];
}

/** Hosts that natively expose both Chat Completions and Anthropic Messages on one key. */
const NATIVE_DUAL_WIRE_HOSTS = ["openrouter.ai", "api.deepseek.com"] as const;

/**
 * Hosts that also speak the OpenAI Responses API (`/responses`) on the same key.
 * Codex / ChatGPT Desktop can stay on that wire instead of being bridged through Chat Completions.
 */
const NATIVE_RESPONSES_HOSTS = ["opencode.ai"] as const;

/**
 * Hosts that advertise `both` but reject non-Claude model ids on `/messages`.
 * Those still need an Anthropic→OpenAI body bridge for DeepSeek/OSS models.
 */
const MESSAGES_CLAUDE_ONLY_HOSTS = ["opencode.ai", "commandcode.ai"] as const;

/** DeepSeek stores the OpenAI root in config; Anthropic lives under `/anthropic`. */
const SPLIT_ANTHROPIC_PATH_HOSTS = ["api.deepseek.com"] as const;

function hostOf(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

function hostMatches(baseUrl: string, suffixes: readonly string[]): boolean {
  const host = hostOf(baseUrl);
  if (!host) return false;
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** True when the configured type understates a host that speaks both wires. */
export function isNativeDualWireHost(baseUrl: string): boolean {
  return hostMatches(baseUrl, NATIVE_DUAL_WIRE_HOSTS);
}

/** True when the host accepts `/responses` natively (no Chat Completions bridge). */
export function isNativeResponsesHost(baseUrl: string): boolean {
  return hostMatches(baseUrl, NATIVE_RESPONSES_HOSTS);
}

export function messagesRejectsNonClaude(provider: Provider): boolean {
  return hostMatches(provider.baseUrl, MESSAGES_CLAUDE_ONLY_HOSTS);
}

function hasSplitAnthropicPath(baseUrl: string): boolean {
  return hostMatches(baseUrl, SPLIT_ANTHROPIC_PATH_HOSTS);
}

/**
 * Promote legacy `type: "openai"` entries for hosts that also speak Anthropic.
 * Call sites should never special-case these hosts for candidate filtering.
 */
export function normalizeProviderType(type: ProviderType, baseUrl: string): ProviderType {
  if (type === "openai" && isNativeDualWireHost(baseUrl)) return "both";
  return type;
}

/** Native wire support — no translation. */
export function providerSpeaks(provider: Provider, wire: ProviderType): boolean {
  if (provider.type === "both") return wire === "openai" || wire === "anthropic";
  if (provider.type === "gemini") return wire === "openai";
  if (wire === "openai") return provider.type === "openai" || provider.type === "responses";
  return provider.type === wire;
}

/**
 * Routing filter: can this provider serve a client on `client`?
 * Includes bridgeable OpenAI-only providers for Anthropic clients, and Chat
 * Completions / Gemini hosts for Responses clients (ChatGPT Desktop / Codex).
 */
export function canServeClient(provider: Provider, client: ClientWire): boolean {
  if (providerSpeaks(provider, client)) return true;
  if (client === "anthropic" && provider.type === "openai") return true;
  if (
    client === "responses" &&
    (provider.type === "openai" || provider.type === "both" || provider.type === "gemini")
  ) {
    return true;
  }
  return false;
}

export type WireBridge = "none" | "to-openai" | "to-anthropic";

export interface WirePlan {
  wire: UpstreamWire;
  bridge: WireBridge;
}

/** Normalize a declared wire field to a list. */
export function asWireList(wire: UpstreamWire | UpstreamWire[] | undefined): UpstreamWire[] {
  if (wire === undefined) return [];
  return Array.isArray(wire) ? wire : [wire];
}

/**
 * Default wires when a model entry omits `wire`. Mirrors the historical host/model heuristics
 * so bare string configs keep the same behavior — without runtime error scraping.
 */
export function inferModelWires(provider: Provider, modelId: string): UpstreamWire[] {
  switch (provider.type) {
    case "anthropic":
      return ["anthropic"];
    case "responses":
      return ["responses"];
    case "gemini":
    case "openai":
      return ["openai"];
    case "both": {
      if (needsAnthropicWire(modelId)) return ["anthropic"];
      const wires: UpstreamWire[] = ["openai"];
      if (isNativeResponsesHost(provider.baseUrl)) wires.push("responses");
      // DeepSeek / OpenRouter speak Anthropic natively for non-Claude models too.
      if (!messagesRejectsNonClaude(provider)) wires.push("anthropic");
      return wires;
    }
  }
}

/** Declared wires for a model, or inferred when the entry omits `wire`. */
export function wiresOf(provider: Provider, modelId: string): UpstreamWire[] {
  const entry = provider.models.find((model) => model.id === modelId);
  const declared = asWireList(entry?.wire);
  if (declared.length > 0) return declared;
  return inferModelWires(provider, modelId);
}

/**
 * Decide the upstream wire and whether the body must be translated.
 *
 * Preference: honor the model's declared (or inferred) wires. Prefer the client's own wire
 * when the model lists it; otherwise bridge onto a wire the model does speak.
 */
export function planUpstreamWire(input: {
  provider: Provider;
  client: ClientWire;
  model: string;
}): WirePlan | { error: string } {
  const { provider, client, model } = input;

  if (provider.type === "gemini") {
    // Gemini speaks its own envelope built from a Chat Completions body. A Responses
    // client must be translated to that body first (same bridge as OpenAI hosts).
    return {
      wire: "openai",
      bridge: client === "responses" ? "to-openai" : "none",
    };
  }
  if (provider.type === "responses") {
    if (client !== "openai" && client !== "responses") {
      return { error: `Provider "${provider.name}" speaks responses, not ${client}` };
    }
    return { wire: "responses", bridge: "none" };
  }

  if (!canServeClient(provider, client)) {
    return {
      error: `Provider "${provider.name}" speaks the ${provider.type} protocol, not ${client}`,
    };
  }

  const wires = wiresOf(provider, model);

  if (client === "responses") {
    if (wires.includes("responses")) return { wire: "responses", bridge: "none" };
    if (wires.includes("openai")) return { wire: "openai", bridge: "to-openai" };
    return {
      error: `Model "${model}" on "${provider.name}" cannot serve Responses clients`,
    };
  }

  if (client === "anthropic") {
    if (wires.includes("anthropic")) return { wire: "anthropic", bridge: "none" };
    if (wires.includes("openai")) return { wire: "openai", bridge: "to-openai" };
    return {
      error: `Model "${model}" on "${provider.name}" cannot serve Anthropic clients`,
    };
  }

  // client === "openai"
  if (wires.includes("openai")) return { wire: "openai", bridge: "none" };
  if (wires.includes("anthropic")) return { wire: "anthropic", bridge: "to-anthropic" };
  return {
    error: `Model "${model}" on "${provider.name}" cannot serve OpenAI clients`,
  };
}

function endpointFor(type: ProviderType, wire: UpstreamWire): string {
  if (type === "anthropic") return "/messages";
  if (type === "responses") return "/responses";
  if (type === "both") {
    if (wire === "anthropic") return "/messages";
    if (wire === "responses") return "/responses";
    return "/chat/completions";
  }
  if (wire === "anthropic") return "/messages";
  if (wire === "responses") return "/responses";
  return "/chat/completions";
}

/** Resolve the upstream URL for a provider wire (DeepSeek Anthropic uses a split root). */
export function upstreamUrlFor(provider: Provider, wire: UpstreamWire): string {
  const base = provider.baseUrl.replace(/\/+$/, "");
  if (wire === "anthropic" && hasSplitAnthropicPath(provider.baseUrl)) {
    const root = base
      .replace(/\/v1\/messages$/i, "")
      .replace(/\/anthropic$/i, "")
      .replace(/\/v1$/i, "");
    return `${root}/anthropic/v1/messages`;
  }
  return `${base}${endpointFor(provider.type, wire)}`;
}
