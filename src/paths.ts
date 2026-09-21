import { homedir } from "node:os";
import { dirname, join } from "node:path";

const home = homedir();

export function configPath(): string {
  if (process.env.JEVONIAN_CONFIG) return process.env.JEVONIAN_CONFIG;
  const base = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return join(base, "jevonian", "config.json");
}

export function tunnelStatePath(): string {
  if (process.env.JEVONIAN_TUNNEL_STATE) return process.env.JEVONIAN_TUNNEL_STATE;
  return join(dirname(configPath()), "tunnel-state.json");
}

export function tunnelLogPath(): string {
  if (process.env.JEVONIAN_TUNNEL_LOG) return process.env.JEVONIAN_TUNNEL_LOG;
  return join(dataDir(), "tunnel.log");
}

export function browserStatePath(): string {
  if (process.env.JEVONIAN_BROWSER_STATE) return process.env.JEVONIAN_BROWSER_STATE;
  return join(dirname(configPath()), "browser-state.json");
}

export function dataDir(): string {
  if (process.env.JEVONIAN_DATA_DIR) return process.env.JEVONIAN_DATA_DIR;
  const base = process.env.XDG_DATA_HOME ?? join(home, ".local", "share");
  return join(base, "jevonian");
}

export function updateStatePath(): string {
  if (process.env.JEVONIAN_UPDATE_STATE) return process.env.JEVONIAN_UPDATE_STATE;
  return join(dataDir(), "update.json");
}

export function ledgerPath(): string {
  if (process.env.JEVONIAN_LEDGER) return process.env.JEVONIAN_LEDGER;
  return join(dataDir(), "ledger.jsonl");
}
