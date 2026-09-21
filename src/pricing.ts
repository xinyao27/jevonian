import { loadPricingSnapshot, OFFICIAL_PROVIDERS } from "./modelsdev";
import bundled from "./pricing/models.json";

export interface ModelPrice {
  provider?: string;
  peakRule?: "deepseek";
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  peak?: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
  note?: string;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const fallbackTable = bundled as unknown as Record<string, ModelPrice>;

let table: Record<string, ModelPrice> = fallbackTable;
let priceSource = "bundled-fallback";
let priceCount = Object.keys(table).length;

function mergeFallback(base: Record<string, ModelPrice>): Record<string, ModelPrice> {
  const merged: Record<string, ModelPrice> = { ...base };
  for (const [model, entry] of Object.entries(fallbackTable)) {
    if (!merged[model]) merged[model] = entry;
  }
  return merged;
}

export function usePriceTable(next: Record<string, ModelPrice>, source = "models.dev"): void {
  table = mergeFallback(next);
  priceSource = source;
  priceCount = Object.keys(table).length;
}

export function pricingInfo(): { source: string; models: number } {
  return { source: priceSource, models: priceCount };
}

export function initPricing(): { source: string; models: number } {
  const snapshot = loadPricingSnapshot();
  if (snapshot && Object.keys(snapshot).length > 0) usePriceTable(snapshot);
  return pricingInfo();
}

// Upstream ids add a service-tier or reasoning suffix that models.dev does not list
// separately. Order matters: strip the most specific variants first.
const VARIANT_SUFFIXES = [
  "extra-low",
  "xhigh",
  "high",
  "medium",
  "low",
  "tiered",
  "thinking",
  "reasoning",
  "preview",
  "agent",
  "latest",
];

// Pricing ids keep the literal model name (`gemini-3.8-flash`), so only the suffix is
// removed here — rewriting dots to dashes would land on a reseller entry instead.
function pricingAliases(model: string): string[] {
  const aliases: string[] = [];
  let current = model;
  for (let step = 0; step < VARIANT_SUFFIXES.length; step += 1) {
    const suffix = VARIANT_SUFFIXES.find((candidate) => current.endsWith(`-${candidate}`));
    if (!suffix) break;
    current = current.slice(0, -(suffix.length + 1));
    if (current.length === 0) break;
    aliases.push(current);
  }
  return aliases;
}

// A lookup widens in steps: the provider's own rate for the id, the bare id, then the
// id stripped to its base name when upstream added a service tier. The exact id keeps
// priority over the stripped base so a specific listing (`…-tiered`) is never billed
// at the generic model's rate.
//
// models.dev also re-lists each model under resellers at marked-up prices. When the
// configured provider is itself an official vendor (google, deepseek, …) its rate is
// authoritative; otherwise the vendor list price wins over whichever reseller happens
// to own the bare key — antigravity serving `gemini-3.8-flash-tiered` must bill
// Google's `gemini-3.8-flash`, not `opencode`'s markup.
export function priceFor(model: string, provider?: string): ModelPrice | undefined {
  const tail = model.includes("/") ? model.slice(model.lastIndexOf("/") + 1) : model;
  const names = [...new Set([model, tail])].flatMap((name) => [name, ...pricingAliases(name)]);
  const providerIsOfficial = provider ? OFFICIAL_PROVIDERS.has(provider) : false;
  const candidates: ModelPrice[] = [];
  // A provider-qualified listing the caller named stays authoritative over the bare vendor
  // key: `reseller/deepseek-v4-pro` must bill the reseller's 99, not DeepSeek's list price.
  let named: ModelPrice | undefined;
  for (const name of names) {
    if (provider) {
      const qualified = table[`${provider}/${name}`];
      if (qualified) {
        // An official provider's own rate is authoritative for its ids.
        if (providerIsOfficial) return qualified;
        named = named ?? qualified;
        candidates.push(qualified);
      }
    }
    const direct = table[name];
    if (direct) candidates.push(direct);
  }
  return (
    named ??
    candidates.find((price) => OFFICIAL_PROVIDERS.has(price.provider ?? "")) ??
    candidates[0]
  );
}

export function isDeepSeekPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function costOf(
  model: string,
  usage: Usage,
  at: Date,
  provider?: string,
): { usd: number | null; known: boolean } {
  const price = priceFor(model, provider);
  if (!price) return { usd: null, known: false };
  const usePeak = price.peakRule === "deepseek" && isDeepSeekPeak(at);
  const rates = usePeak && price.peak ? price.peak : price;
  const perMillion =
    usage.input * rates.input +
    usage.output * rates.output +
    usage.cacheRead * (rates.cacheRead ?? 0) +
    usage.cacheWrite * (rates.cacheWrite ?? 0);
  return { usd: perMillion / 1_000_000, known: true };
}
