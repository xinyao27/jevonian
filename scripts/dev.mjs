import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const APP_PORT = Number(process.env.JEVONIAN_PORT ?? 8787);
const WEB_PORT = 5173;
const WEB_DEV_URL = `http://127.0.0.1:${WEB_PORT}`;

const children = [];
let shuttingDown = false;

function browserStatePath() {
  if (process.env.JEVONIAN_BROWSER_STATE) return process.env.JEVONIAN_BROWSER_STATE;
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "jevonian", "browser-state.json");
}

// Fresh `pnpm dev` should open the dashboard once; HMR restarts keep the marker
// so they reuse the same tab instead of stacking a new one on every edit.
try {
  rmSync(browserStatePath(), { force: true });
} catch {
  // best-effort
}

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("error", (error) => {
    console.error(`failed to start ${command}: ${String(error)}`);
    shutdown(1);
  });
  child.on("exit", (code) => shutdown(code ?? 0));
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 200);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

if (await portInUse(APP_PORT)) {
  console.error(`port ${APP_PORT} is already in use — stop the other Jevonian instance first.`);
  process.exit(1);
}

run("vp", ["-C", "web", "dev"]);

setTimeout(() => {
  run("tsx", ["watch", "src/cli.ts", "serve", ...process.argv.slice(2)], {
    JEVONIAN_WEB_DEV: WEB_DEV_URL,
  });
}, 1_200);
