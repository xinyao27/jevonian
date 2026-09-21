import { canonicalModelId } from "./models";
import { loadCapabilities } from "./modelsdev";

/**
 * What a model can actually do. Routing needs this before it can decide: a model whose
 * context window cannot hold the conversation, or that cannot honour the requested thinking
 * level, is not a candidate — offering it to the brain would only produce a broken turn.
 */
export interface ModelCapabilities {
  /** Total context window in tokens. `undefined` means "unknown", not "unlimited". */
  contextWindow?: number;
  /** Max tokens the model will emit in one response, when the source states it. */
  maxOutput?: number;
  /** Thinking levels this model accepts, cheapest first. `undefined` means "unknown". */
  efforts?: ReasoningEffort[];
}

/**
 * Thinking depth, lowest to highest, with the depth each level actually represents. The
 * catalogue's vocabularies are not evenly spaced: `none` is off rather than a shallow think,
 * and `xhigh`/`ultra` sit above `max` at different vendors. Mapping every name onto an even
 * index would make `max` and `low` equidistant from `high`, which is not true of the work done.
 */
const EFFORT_DEPTH: Record<string, number> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
  ultra: 8,
};

export const REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export function isReasoningEffort(value: string): value is ReasoningEffort {
  return Object.hasOwn(EFFORT_DEPTH, value);
}

/** How deep a level thinks. Used to clamp a request to what a model accepts. */
export function effortRank(effort: ReasoningEffort): number {
  return EFFORT_DEPTH[effort] ?? 0;
}

/**
 * The catalog's stated limits, indexed at load time. The snapshot cannot be re-derived here
 * because the configured provider name is not recoverable from a stored key, so this trusts
 * the three shapes `mapCapabilities` wrote.
 */
function catalogIndex(): Map<string, ModelCapabilities> {
  const snapshot = loadCapabilities();
  const cached = catalogs.get(snapshot);
  if (cached) return cached;

  const index = new Map<string, ModelCapabilities>();
  for (const [key, caps] of Object.entries(snapshot)) {
    index.set(key, toCapabilities(caps));
  }
  catalogs.set(snapshot, index);
  return index;
}

const catalogs = new WeakMap<object, Map<string, ModelCapabilities>>();

function toCapabilities(caps: {
  contextWindow?: number;
  maxOutput?: number;
  efforts?: string[];
}): ModelCapabilities {
  const efforts = caps.efforts?.filter(isReasoningEffort) ?? [];
  return {
    ...(caps.contextWindow === undefined ? {} : { contextWindow: caps.contextWindow }),
    ...(caps.maxOutput === undefined ? {} : { maxOutput: caps.maxOutput }),
    ...(efforts.length > 0 ? { efforts } : {}),
  };
}

/**
 * Capabilities for one model id, as the catalog states them. Missing metadata yields `{}` —
 * an unknown model is never filtered out, because silence is not evidence of a small window.
 */
export function modelCapabilities(model: string): ModelCapabilities {
  const index = catalogIndex();
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  return index.get(model) ?? index.get(tail) ?? index.get(canonicalModelId(model)) ?? {};
}

/**
 * Effective capabilities for one model: the catalog's statement, with the user's config
 * layered over it field by field. Config wins where it speaks, because a user who measured
 * their own provider's limit knows better than a shared catalog.
 */
export function effectiveCapabilities(
  model: string,
  override?: { contextWindow?: number; maxOutput?: number; efforts?: string[] },
): ModelCapabilities {
  const stated = modelCapabilities(model);
  const efforts = (override?.efforts ?? stated.efforts)?.filter(isReasoningEffort);
  return {
    contextWindow: override?.contextWindow ?? stated.contextWindow,
    maxOutput: override?.maxOutput ?? stated.maxOutput,
    ...(efforts && efforts.length > 0 ? { efforts } : {}),
  };
}

/**
 * The thinking level to actually use, given what the model accepts. A brain may ask for a
 * level the chosen model does not offer — the model was picked on merit, so its nearest
 * supported level is a better answer than discarding the decision.
 *
 * Nearest has a bias: the shallowest supported level *at least as deep* as the request wins,
 * because under-thinking silently degrades an answer while over-thinking only costs tokens.
 * No stated levels means the request passes through untouched.
 */
export function clampEffort(
  requested: ReasoningEffort | undefined,
  supports: ReasoningEffort[] | undefined,
): ReasoningEffort | undefined {
  if (!supports || supports.length === 0) return requested;
  if (requested && supports.includes(requested)) return requested;
  if (!requested) {
    // No opinion: take the middle supported level rather than an extreme.
    return supports[Math.floor((supports.length - 1) / 2)];
  }
  const target = effortRank(requested);
  const deeper = supports.filter((effort) => effortRank(effort) >= target);
  if (deeper.length > 0) {
    return deeper.reduce((best, effort) => (effortRank(effort) < effortRank(best) ? effort : best));
  }
  // Nothing that deep exists: take the deepest level the model has.
  return supports.reduce((best, effort) => (effortRank(effort) > effortRank(best) ? effort : best));
}

/** True when the model's stated window cannot hold `tokens`. Unknown windows always fit. */
export function fitsContext(window: number | undefined, tokens: number): boolean {
  if (window === undefined) return true;
  // Leave headroom for the response and for the estimate being approximate.
  return tokens <= Math.floor(window * 0.9);
}
