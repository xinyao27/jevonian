import type { CatalogIdentity } from "./modelsdev";

/**
 * Identity is how a request for "the DeepSeek V4.1 Flash" finds the official
 * `deepseek-flash` endpoint and every reseller that spells it `deepseek-v4.1-flash`, without a
 * hand-written alias in every config.
 *
 * Two entries only serve the same model when both halves agree:
 *
 * - the **model**, taken from the catalog's own label ("DeepSeek V4.1 Flash"), which survives a
 *   provider renaming a model, after stripping qualifiers resellers add (a trailing
 *   `(Fireworks AI)`, a leading `DeepSeek:`);
 * - the **serving mode**, taken from the id's suffix (`:free`, `-batch`, `:fast`, `:thinking`),
 *   which the label does not carry. A paid request must never land on a promo route, and a
 *   standard request must never land on a faster, differently priced one.
 *
 * Anything in the label is identity — `Mini`, `Nano`, `Pro`, `Code`, `Highspeed` are separate
 * models, not modes, and stay separate. Only suffixes the label does not mention become modes.
 */
export type ServingMode = "standard" | "free" | "batch" | "fast" | "thinking";

/**
 * Suffix tokens that describe *how* a model is served rather than *which* model it is. Matching is
 * on the id's own tokens so `deepseek-v4-flash-free`, `deepseek-v4-flash:free` and
 * `kimi-k3:fast` all resolve.
 */
const MODE_TOKENS: Array<{ mode: ServingMode; pattern: RegExp }> = [
  { mode: "thinking", pattern: /(^|[:@-])(thinking|think)(-|$|[:@])/ },
  { mode: "batch", pattern: /(^|[:@-])batch(-|$|[:@])/ },
  { mode: "free", pattern: /(^|[:@-])free(-|$|[:@])/ },
  { mode: "fast", pattern: /(^|[:@-])fast(-|$|[:@])/ },
];

/** The serving mode an id or label declares. Absent evidence means the standard mode. */
export function servingMode(model: string): ServingMode {
  const tail = (
    model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model
  ).toLowerCase();
  for (const { mode, pattern } of MODE_TOKENS) {
    if (pattern.test(tail)) return mode;
  }
  return "standard";
}

/**
 * A vendor label reduced to its comparable form: qualifiers resellers wrap around it removed,
 * punctuation dropped, case folded. Version tokens (`4.1`, `mini`) are deliberately kept — they
 * are the difference between two models.
 */
export function normalizeModelName(name: string): string {
  let value = name.toLowerCase();
  // Trailing qualifiers: "(Free)", "[Fireworks AI]".
  value = value.replace(/[([{][^)\]}]*[)\]}]+/g, " ");
  // A leading vendor prefix: "OpenAI: GPT-5 Pro", "DeepSeek: DeepSeek Flash Latest". The prefix
  // is the reseller's brand, not the model's — dropping it makes "OpenAI: GPT-5 Pro", "GPT-5
  // Pro" and a bare "gpt-5-pro" one identity, which is the whole point. The first colon is the
  // split; later colons in an id-style label are kept.
  const colon = value.indexOf(":");
  if (colon > 0) value = value.slice(colon + 1);
  return value
    .replace(/[^a-z0-9.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ModelIdentity {
  /** Comparable vendor label, `undefined` when the catalog says nothing about this id. */
  label?: string;
  /** The catalog's brand line. Diagnostics only: it spans many distinct models. */
  family?: string;
  releaseDate?: string;
  /** The catalog's label as written, for display. */
  displayName?: string;
  mode: ServingMode;
}

/**
 * The key two entries must share to be the same model. `undefined` when the catalog does not name
 * the model: an unknown name is not evidence of sameness, so those entries resolve by id alone.
 */
export function identityKey(identity: ModelIdentity): string | undefined {
  if (!identity.label) return undefined;
  return `${identity.label}@${identity.mode}`;
}

/** Identity for one model: the catalog's statement, plus the mode parsed from the id itself. */
export function identityFrom(model: string, identity: CatalogIdentity | undefined): ModelIdentity {
  const label = identity?.name ? normalizeModelName(identity.name) : undefined;
  return {
    ...(label ? { label } : {}),
    ...(identity?.family ? { family: identity.family } : {}),
    ...(identity?.releaseDate ? { releaseDate: identity.releaseDate } : {}),
    ...(identity?.name ? { displayName: identity.name } : {}),
    mode: servingMode(model),
  };
}
