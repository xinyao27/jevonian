/**
 * Thinking configuration per Claude model.
 *
 * Anthropic moved from extended thinking (`thinking: {type: "enabled", budget_tokens}`) to
 * adaptive thinking (`thinking: {type: "adaptive"}` steered by `output_config.effort`). Newer
 * models reject the legacy shapes with a 400:
 *
 * - Claude 4.7+ (and Sonnet 5) reject `type: "enabled"`;
 * - always-on models (Fable, Mythos, Opus 5.5+) also reject `type: "disabled"` —
 *   "thinking.type.disabled is not supported for this model".
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 * @see https://platform.claude.com/docs/en/build-with-claude/effort
 */

import type { ReasoningEffort } from "./capabilities";

export interface AnthropicThinkingSupport {
  /** Accepts `thinking: {type: "adaptive"}` and `output_config.effort`. */
  adaptive: boolean;
  /** Rejects `thinking: {type: "enabled", budget_tokens}`. */
  rejectsEnabled: boolean;
  /** Thinking is always on: `thinking: {type: "disabled"}` is rejected. */
  rejectsDisabled: boolean;
  /** Accepts `output_config.effort: "xhigh"`. */
  xhigh: boolean;
}

const LEGACY: AnthropicThinkingSupport = {
  adaptive: false,
  rejectsEnabled: false,
  rejectsDisabled: false,
  xhigh: false,
};

const MODEL_ID = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[-.](\d{1,2}))?(?=$|[^0-9])/;

/**
 * What a Claude model accepts for `thinking`, derived from its id. Unknown or pre-4.6 ids keep
 * the legacy extended-thinking behaviour, so nothing changes for models we cannot place.
 */
export function anthropicThinkingSupport(model: unknown): AnthropicThinkingSupport {
  if (typeof model !== "string") return LEGACY;
  const id = model.toLowerCase();
  const match = MODEL_ID.exec(id);
  if (!match) return LEGACY;
  const family = match[1];
  const version = Number(match[2]) + (match[3] ? Number(match[3]) / 10 : 0);

  if (family === "fable" || family === "mythos") {
    // Mythos Preview still accepts extended thinking; every Fable/Mythos rejects "disabled".
    const preview = id.includes("preview");
    return { adaptive: true, rejectsEnabled: !preview, rejectsDisabled: true, xhigh: !preview };
  }
  if (version < 4.6) return LEGACY;
  return {
    adaptive: true,
    rejectsEnabled: version >= 4.7,
    // Opus 5.5 is always on; later generations are assumed to follow it rather than risk a 400.
    rejectsDisabled: (family === "opus" && version >= 5.5) || version >= 6,
    xhigh: version >= 4.7,
  };
}

/** Room left for the visible answer on top of a legacy thinking budget. */
export const THINKING_HEADROOM = 4_096;

/**
 * Default `max_tokens` for a bridged request with thinking on when the client stated none. The
 * bridge's plain default (4_096) is sized for a bare answer; adaptive thinking spends from the
 * same `max_tokens` pool, so at that size a thinking turn routinely stops at `max_tokens` with a
 * truncated or missing answer. 16k leaves room for moderate thinking plus a full reply and is
 * within every current Claude model's output cap.
 */
export const BRIDGED_THINKING_MAX_TOKENS = 16_384;

export interface MaxTokensOptions {
  /** The client set `max_tokens` (or its equivalent) itself; never shrink or re-default it. */
  clientSetMax: boolean;
  /** The model's stated output cap, when known. */
  maxOutput?: number;
}

/**
 * Makes `max_tokens` consistent with the body's thinking configuration.
 *
 * - Extended thinking requires `max_tokens > budget_tokens`, else Anthropic answers 400; the
 *   bridge default (4_096) is below most router budgets. `max_tokens` is raised to the budget
 *   plus {@link THINKING_HEADROOM}; if that exceeds the model's cap, the budget shrinks instead.
 * - Adaptive thinking has no such rule, but a bridged default is raised to
 *   {@link BRIDGED_THINKING_MAX_TOKENS} so the thinking pass does not starve the answer.
 */
export function fitThinkingMaxTokens(
  body: Record<string, unknown>,
  options: MaxTokensOptions,
): Record<string, unknown> {
  const thinking =
    typeof body.thinking === "object" && body.thinking !== null
      ? (body.thinking as Record<string, unknown>)
      : {};
  const current = typeof body.max_tokens === "number" ? body.max_tokens : 0;
  const cap = options.maxOutput && options.maxOutput > 0 ? options.maxOutput : undefined;
  const capped = (value: number): number => (cap ? Math.min(value, cap) : value);

  if (thinking.type === "enabled" && typeof thinking.budget_tokens === "number") {
    let budget = thinking.budget_tokens;
    if (current > budget) return body;
    let max = budget + THINKING_HEADROOM;
    if (cap && max > cap) {
      // Anthropic's floor for a thinking budget is 1_024 tokens.
      max = cap;
      budget = Math.max(1_024, Math.min(budget, cap - THINKING_HEADROOM));
    }
    return { ...body, max_tokens: max, thinking: { ...thinking, budget_tokens: budget } };
  }
  if (thinking.type === "adaptive" && !options.clientSetMax) {
    const max = capped(BRIDGED_THINKING_MAX_TOKENS);
    return current >= max ? body : { ...body, max_tokens: max };
  }
  return body;
}

/** The `output_config.effort` value for a router level: low, medium, high, xhigh or max. */
export function adaptiveEffort(
  effort: ReasoningEffort,
  support: AnthropicThinkingSupport,
): "low" | "medium" | "high" | "xhigh" | "max" {
  switch (effort) {
    case "none":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return support.xhigh ? "xhigh" : "high";
    default:
      return "max";
  }
}
