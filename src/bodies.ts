import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { dataDir } from "./paths";

const MAX_BODIES = 1_000;
const PRUNE_EVERY = 100;

let writes = 0;

export function bodiesDir(): string {
  return join(dataDir(), "bodies");
}

export function isSafeBodyId(id: string): boolean {
  return /^[0-9a-fA-F-]{8,64}$/.test(id);
}

function captureEnabled(): boolean {
  return process.env.JEVONIAN_CAPTURE_BODIES !== "0";
}

export function saveBody(id: string, payload: unknown): void {
  if (!captureEnabled() || !isSafeBodyId(id)) return;
  try {
    mkdirSync(bodiesDir(), { recursive: true });
    writeFileSync(join(bodiesDir(), `${id}.json`), JSON.stringify(payload), { mode: 0o600 });
    writes += 1;
    if (writes >= PRUNE_EVERY) {
      writes = 0;
      pruneBodies();
    }
  } catch {
    return;
  }
}

export function loadBody(id: string): unknown {
  if (!isSafeBodyId(id)) return undefined;
  const path = join(bodiesDir(), `${id}.json`);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function pruneBodies(): void {
  try {
    const dir = bodiesDir();
    const entries = readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, at: statSync(join(dir, name)).mtimeMs }))
      .sort((left, right) => left.at - right.at);
    for (const entry of entries.slice(0, Math.max(0, entries.length - MAX_BODIES))) {
      rmSync(join(dir, entry.name), { force: true });
    }
  } catch {
    return;
  }
}
