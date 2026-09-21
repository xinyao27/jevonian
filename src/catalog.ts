import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { resolveProviderAuth } from "./auth";
import type { Config, Provider } from "./config";
import { dataDir } from "./paths";

export interface CatalogEntry {
  provider: string;
  models: string[];
  fetchedAt: string;
  error?: string;
}

export function catalogPath(): string {
  return join(dataDir(), "models.json");
}

export function loadCatalog(): CatalogEntry[] {
  const path = catalogPath();
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((entry) => {
      const value = entry as Partial<CatalogEntry>;
      if (typeof value.provider !== "string" || !Array.isArray(value.models)) return [];
      return [
        {
          provider: value.provider,
          models: value.models.filter((model): model is string => typeof model === "string"),
          fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : "",
          ...(typeof value.error === "string" ? { error: value.error } : {}),
        },
      ];
    });
  } catch {
    return [];
  }
}

export function saveCatalog(entries: CatalogEntry[]): void {
  const path = catalogPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
}

export function codexModelsCachePath(): string {
  const base = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  return join(base, "models_cache.json");
}

export function localCodexModels(): string[] | undefined {
  const entries = readNativeCodexCatalogEntries();
  if (!entries || entries.length === 0) return undefined;
  const usable = entries
    .flatMap((model) => {
      if (typeof model.slug !== "string" || model.slug.length === 0) return [];
      if (model.visibility === "hidden") return [];
      if (model.supported_in_api === false) return [];
      return [
        {
          slug: model.slug,
          priority: typeof model.priority === "number" ? model.priority : Number.MAX_SAFE_INTEGER,
        },
      ];
    })
    .sort((left, right) => left.priority - right.priority);
  return usable.length > 0 ? usable.map((model) => model.slug) : undefined;
}

/**
 * Raw Codex catalog rows from `~/.codex/models_cache.json`.
 *
 * Used when building the ChatGPT Desktop picker the Ollama way: keep every
 * native row (marked ChatGPT-only) and prepend Jevonian's injected models.
 */
export function readNativeCodexCatalogEntries(): Array<Record<string, unknown>> | undefined {
  const path = codexModelsCachePath();
  if (!existsSync(path)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { models?: unknown };
    const models = Array.isArray(raw.models) ? raw.models : [];
    const entries = models.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
      const model = entry as Record<string, unknown>;
      if (typeof model.slug !== "string" || model.slug.length === 0) return [];
      return [model];
    });
    return entries.length > 0 ? entries : undefined;
  } catch {
    return undefined;
  }
}

export async function discoverProviderModels(provider: Provider): Promise<CatalogEntry> {
  const fetchedAt = new Date().toISOString();
  if (
    provider.type === "gemini" ||
    (provider.auth === "oauth" && provider.oauthSource === "antigravity")
  ) {
    const auth = await resolveProviderAuth(provider, "openai");
    if (auth.error) {
      return { provider: provider.name, models: [], fetchedAt, error: auth.error };
    }
    try {
      const base = provider.baseUrl.replace(/\/+$/, "").replace(/\/v1internal$/, "");
      const response = await fetch(`${base}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: auth.headers,
        body: JSON.stringify({ project: auth.project ?? "default-cli-project" }),
      });
      if (!response.ok) {
        return { provider: provider.name, models: [], fetchedAt, error: `HTTP ${response.status}` };
      }
      const json = (await response.json()) as { models?: unknown };
      const entries = Array.isArray(json.models)
        ? []
        : Object.entries(
            typeof json.models === "object" && json.models !== null
              ? (json.models as Record<string, unknown>)
              : {},
          );
      const models = entries.flatMap(([id, raw]) => {
        if (id.startsWith("tab_") || id.startsWith("chat_")) return [];
        const model =
          typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
        if (model.isInternal === true) return [];
        return [id];
      });
      return { provider: provider.name, models, fetchedAt };
    } catch (error) {
      return { provider: provider.name, models: [], fetchedAt, error: String(error) };
    }
  }
  if (provider.auth === "oauth" && provider.oauthSource === "codex") {
    const models = localCodexModels();
    if (!models) {
      return {
        provider: provider.name,
        models: [],
        fetchedAt,
        error:
          "No Codex model cache found. Run `codex` once to refresh ~/.codex/models_cache.json, or add model ids manually.",
      };
    }
    return { provider: provider.name, models, fetchedAt };
  }
  if (provider.type === "responses" && provider.auth !== "api-key") {
    return {
      provider: provider.name,
      models: [],
      fetchedAt,
      error: "this endpoint has no /models route; add model ids manually",
    };
  }
  const auth = await resolveProviderAuth(provider);
  if (auth.error) {
    return { provider: provider.name, models: [], fetchedAt, error: auth.error };
  }
  try {
    const response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: auth.headers,
    });
    if (!response.ok) {
      return { provider: provider.name, models: [], fetchedAt, error: `HTTP ${response.status}` };
    }
    const json = (await response.json()) as { data?: unknown };
    const data = Array.isArray(json.data) ? json.data : [];
    const models = data.flatMap((item) => {
      const id = (item as { id?: unknown }).id;
      return typeof id === "string" ? [id] : [];
    });
    return { provider: provider.name, models, fetchedAt };
  } catch (error) {
    return { provider: provider.name, models: [], fetchedAt, error: String(error) };
  }
}

export async function refreshCatalog(config: Config): Promise<CatalogEntry[]> {
  const entries = await Promise.all(
    config.providers.map((provider) => discoverProviderModels(provider)),
  );
  saveCatalog(entries);
  return entries;
}
