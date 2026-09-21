import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { join } from "node:path";

export interface Credentials {
  [provider: string]: { apiKey: string };
}

export function credentialsPath(): string {
  if (process.env.JEVONIAN_CREDENTIALS) return process.env.JEVONIAN_CREDENTIALS;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "jevonian", "credentials.json");
}

export function loadCredentials(): Credentials {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof raw !== "object" || raw === null) return {};
    const credentials: Credentials = {};
    for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
      const apiKey = (value as { apiKey?: unknown })?.apiKey;
      if (typeof apiKey === "string" && apiKey.length > 0) credentials[provider] = { apiKey };
    }
    return credentials;
  } catch {
    return {};
  }
}

function writeCredentials(credentials: Credentials): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function setCredential(provider: string, apiKey: string): void {
  const credentials = loadCredentials();
  credentials[provider] = { apiKey };
  writeCredentials(credentials);
}

export function removeCredential(provider: string): void {
  const credentials = loadCredentials();
  if (!(provider in credentials)) return;
  delete credentials[provider];
  writeCredentials(credentials);
}

export function getCredential(provider: string): string | undefined {
  return loadCredentials()[provider]?.apiKey;
}

export function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) return "****";
  return `${apiKey.slice(0, 4)}…${apiKey.slice(-4)}`;
}
