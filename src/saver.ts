/**
 * Tool-result compression via RTK (Rust Token Killer) — https://github.com/rtk-ai/rtk.
 *
 * RTK is the CLI proxy coding agents use to compress command output before it reaches the
 * model. Jevonian sits in the HTTP path instead of the shell path, but every agent turn
 * re-sends the same conversation and the bulky part is prior tool results (test logs,
 * `git status`, file reads). Rather than re-implementing RTK's heuristics, this module runs
 * the actual `rtk` binary on each tool result: `rtk pipe` reads the result text on stdin,
 * auto-detects the output shape (cargo test, pytest, vitest, grep-like, find-like, mypy,
 * phpunit, ctest, go-test JSON, …) and prints a compacted version on stdout. When rtk is not
 * installed or finds nothing to compress, the text is passed through unchanged.
 *
 * Savings are estimated per result with `estimateTokens` (the same estimator the rest of the
 * codebase calibrates against) and recorded on the turn's ledger row, so `jevonian report`
 * and the dashboard can answer "how many tokens did the saver keep out of the prompt".
 */

import { execFile } from "node:child_process";

import { estimateTokens } from "./compaction";

export interface TokenSaverConfig {
  /** Master switch. Off leaves every request body untouched. */
  enabled: boolean;
  /**
   * Path to the `rtk` binary, or just `"rtk"` to resolve it via PATH. Install with
   * `brew install rtk` or download a release from https://github.com/rtk-ai/rtk.
   */
  command: string;
  /** Milliseconds a single `rtk pipe` call may take before the original text is kept. */
  timeoutMs: number;
}

export const DEFAULT_TOKEN_SAVER: TokenSaverConfig = {
  enabled: true,
  command: "rtk",
  timeoutMs: 3_000,
};

export function parseTokenSaver(raw: unknown): TokenSaverConfig {
  const value =
    raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const command = value.command;
  const timeoutMs = value.timeoutMs;
  return {
    enabled: value.enabled !== false,
    command:
      typeof command === "string" && command.trim().length > 0
        ? command.trim()
        : DEFAULT_TOKEN_SAVER.command,
    timeoutMs:
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? Math.floor(timeoutMs)
        : DEFAULT_TOKEN_SAVER.timeoutMs,
  };
}

export interface SaverStats {
  /** Tool results whose text was replaced by a shorter one. */
  resultsCompressed: number;
  /** Estimated input tokens kept out of the request. */
  savedTokens: number;
  /** Characters removed across all compressed results. */
  charsBefore: number;
  charsAfter: number;
  /**
   * Calls where `rtk` failed (binary missing, timed out, exited non-zero, empty stdout). When
   * every call fails the saver is effectively off — install `rtk` (`brew install rtk`) to
   * light it up.
   */
  failures: number;
  /** `rtk` could not be spawned at all — PATH lacks the binary or the path is wrong. */
  unavailable?: boolean;
}

export interface SaveResult {
  /** The rewritten body, or the original reference when nothing qualified. */
  body: Record<string, unknown>;
  stats: SaverStats;
}

/**
 * Tool results shorter than this are never piped. Spawning a process per result is the cost of
 * this design, and a handful of characters ("ok", a single short line) cannot be compressed
 * into anything smaller anyway — a long agent history is full of them.
 */
const MIN_PIPE_CHARS = 200;

/**
 * How many `rtk` processes may run at once across a whole request. A long agent loop carries
 * hundreds of prior tool results; an unbounded `Promise.all` would fork them all simultaneously.
 */
const MAX_CONCURRENCY = 8;

/** Cache ceilings: entry count and the largest text worth keying, to bound retained memory. */
const CACHE_ENTRIES = 512;
const CACHE_MAX_TEXT = 1_000_000;

/**
 * Compressed tool results, keyed by command + source text. An agent re-sends the same
 * conversation prefix on every turn, and `rtk` is deterministic, so the same test log is
 * otherwise re-piped for the whole life of the session. Insertion-ordered, so the Map is its
 * own LRU: re-inserting on a hit moves an entry to the back and `keys().next()` evicts the
 * coldest one.
 */
const cache = new Map<string, string>();

function cacheGet(key: string): string | undefined {
  const hit = cache.get(key);
  if (hit === undefined) return undefined;
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

function cacheSet(key: string, value: string): void {
  cache.set(key, value);
  while (cache.size > CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test hook: drop memoized compressions so a case starts from a clean cache. */
export function clearSaverCache(): void {
  cache.clear();
}

interface PipeOutcome {
  /** The shorter text rtk produced, or the original when nothing changed. */
  text: string;
  /** True when rtk could not produce output (missing binary, timeout, non-zero exit). */
  failed: boolean;
  /** True when the binary itself could not be spawned: not installed, or not executable. */
  missing: boolean;
}

/**
 * Split a configured command into the binary and any leading flags, so `"rtk"`, an absolute
 * path, and `"/opt/rtk --ultra-compact"` all work. Quotes group a path that contains spaces.
 * `execFile` never goes through a shell, so nothing here can be shell-interpreted.
 */
export function parseCommand(command: string): { bin: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (const char of command.trim()) {
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.length > 0) parts.push(current);
  const [bin = DEFAULT_TOKEN_SAVER.command, ...args] = parts;
  return { bin, args };
}

/**
 * Runs one tool-result text through `rtk pipe`, memoizing the result. Auto detection inside
 * `rtk pipe` never throws on plain text — unrecognized content passes through byte-identical —
 * so any shrink counts as a real RTK compression. stderr is dropped: rtk prints an install
 * banner there.
 */
async function rtkPipe(
  text: string,
  config: TokenSaverConfig,
  command?: string,
): Promise<PipeOutcome> {
  const key =
    text.length <= CACHE_MAX_TEXT
      ? `${config.command}\u0000${command ?? ""}\u0000${text}`
      : undefined;
  if (key !== undefined) {
    const hit = cacheGet(key);
    if (hit !== undefined) return { text: hit, failed: false, missing: false };
  }
  // First pass: auto-detect. When it passes the text through unchanged and we know which
  // command produced it, retry once with `-f <that command's filter>` — `rtk pipe` leaves
  // plenty of long outputs byte-identical (tsc, npm, git status on big trees) that an explicit
  // filter still compresses.
  const outcome = await spawnRtk(text, config);
  let final = outcome;
  if (!outcome.failed && outcome.text === text) {
    const filter = filterForCommand(command);
    if (filter !== undefined) {
      const retry = await spawnRtk(text, config, filter);
      if (!retry.failed && retry.text.length < text.length) final = retry;
    }
  }
  // Only memoize successes: a failure means the binary or path is broken, and the operator may
  // install or fix it mid-session.
  if (key !== undefined && !final.failed) cacheSet(key, final.text);
  return final;
}

/** One real `rtk pipe` invocation. See `rtkPipe` for caching and `rtkPipeBatch` for pacing. */
function spawnRtk(text: string, config: TokenSaverConfig, filter?: string): Promise<PipeOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: PipeOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const { bin, args } = parseCommand(config.command);
    const argv = filter ? [...args, "pipe", "-f", filter] : [...args, "pipe"];
    const child = execFile(
      bin,
      argv,
      { timeout: config.timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error || typeof stdout !== "string" || stdout.length === 0) {
          finish({ text, failed: true, missing: isUnspawnable(error) });
          return;
        }
        // A compressed body must actually be smaller — never send more than arrived.
        finish({
          text: stdout.length < text.length ? stdout : text,
          failed: false,
          missing: false,
        });
      },
    );
    child.on("error", (error: NodeJS.ErrnoException) =>
      finish({ text, failed: true, missing: isUnspawnable(error) }),
    );
    child.stdin?.on("error", () => finish({ text, failed: true, missing: false }));
    child.stdin?.end(text);
  });
}

/**
 * Whether an error means the binary could not be started at all — as opposed to started and
 * exiting non-zero. `ENOENT` is a missing/wrong path, `EACCES` a file that is not executable.
 */
function isUnspawnable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code === "ENOENT" || code === "EACCES";
}

/**
 * Every tool result of a request through `rtkPipe`, at most `MAX_CONCURRENCY` processes at a
 * time. Order is preserved: results land at their source index. A pipeline is used rather than
 * chunking so a slow result does not hold up the next one's slot.
 */
async function rtkPipeBatch(
  slots: ReadonlyArray<Pick<ResultSlot, "text" | "command">>,
  config: TokenSaverConfig,
): Promise<PipeOutcome[]> {
  const outcomes: PipeOutcome[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < slots.length; index = next++) {
      const slot = slots[index]!;
      outcomes[index] = await rtkPipe(slot.text, config, slot.command);
    }
  };
  const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, slots.length) }, worker);
  await Promise.all(workers);
  return outcomes;
}

const warnedCommands = new Set<string>();

/**
 * Tell the operator once per configured command that `rtk` never ran, so a misconfigured path
 * is diagnosable without logging on every proxied request. Repeat calls are no-ops.
 */
export function warnSaverUnavailable(config: TokenSaverConfig, unavailable: boolean): void {
  if (!unavailable || warnedCommands.has(config.command)) return;
  warnedCommands.add(config.command);
  console.warn(
    `[token-saver] cannot run "${config.command}" — tool results are passing through unchanged. Install it (\`brew install rtk\`) or point tokenSaver.command at the binary.`,
  );
}

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The text a message part carries, whichever wire field it lives in. Anthropic tool results
 * keep theirs in `content` (string or text blocks); OpenAI `tool` messages use `content`;
 * Responses `function_call_output` items use `output`.
 */
function extractText(part: Json, field: "content" | "output"): string | undefined {
  const raw = part[field];
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const block = raw.find((item) => isRecord(item) && typeof item.text === "string");
    if (isRecord(block) && typeof block.text === "string") return block.text;
  }
  return undefined;
}

/** Write a compressed text back into the same shape the part carried it in. */
function injectText(part: Json, field: string, text: string): Json {
  const raw = part[field];
  if (typeof raw === "string") return { ...part, [field]: text };
  if (Array.isArray(raw)) {
    let replaced = false;
    const next = raw.map((item) => {
      if (replaced || !isRecord(item) || typeof item.text !== "string") return item;
      replaced = true;
      return { ...item, text };
    });
    return { ...part, [field]: replaced ? next : raw };
  }
  return part;
}

/** One tool result found on a message: its text plus the part that carries it. */
interface ResultSlot {
  text: string;
  part: Json;
  /**
   * The command that produced this result, when the originating tool call supplied one
   * (`arguments.command`/`input.command`, or a bare string argument). Used to pick an explicit
   * `-f <filter>` when auto-detect fails — the filter names in `FILTER_BY_COMMAND` all match
   * the subcommands `rtk rewrite` would emit.
   */
  command?: string;
}

/** All the places a tool-result text can live on one message item. */
function resultSlots(message: Json, commandsById?: Map<string, string>): ResultSlot[] {
  const slots: ResultSlot[] = [];

  // Anthropic: user messages carry `tool_result` content blocks. An OpenAI tool message can
  // also carry an array `content`, but its blocks are `{type: "text"}` — only the Anthropic
  // shape takes this branch.
  if (Array.isArray(message.content)) {
    for (const rawBlock of message.content) {
      if (!isRecord(rawBlock) || rawBlock.type !== "tool_result") continue;
      const text = extractText(rawBlock, "content");
      if (text !== undefined) {
        slots.push({
          text,
          part: rawBlock,
          command:
            typeof rawBlock.tool_use_id === "string"
              ? commandsById?.get(rawBlock.tool_use_id)
              : undefined,
        });
      }
    }
    if (slots.length > 0) return slots;
    // Fall through: array content without tool_result blocks can still be an OpenAI tool
    // message whose output text lives inside `content[*].text`.
  }

  // OpenAI chat: `role: "tool"` messages hold the output in `content` (string or text blocks).
  if (message.role === "tool" && typeof message.tool_call_id === "string") {
    const text = extractText(message, "content");
    if (text !== undefined) {
      slots.push({
        text,
        part: message,
        command: commandsById?.get(message.tool_call_id),
      });
    }
    return slots;
  }

  // Responses: `type: "function_call_output"` items hold the output in `output`.
  if (message.type === "function_call_output") {
    const text = extractText(message, "output");
    if (text !== undefined) {
      slots.push({
        text,
        part: message,
        command:
          typeof message.call_id === "string" ? commandsById?.get(message.call_id) : undefined,
      });
    }
  }
  return slots;
}

/**
 * All sizable tool results on one message, each paired with the message it belongs to so it
 * can be rebuilt after the batch runs.
 */
function messageSlots(
  message: Json,
  commandsById?: Map<string, string>,
): Array<{ message: Json; slot: ResultSlot }> {
  return resultSlots(message, commandsById)
    .filter((slot) => slot.text.length >= MIN_PIPE_CHARS)
    .map((slot) => ({ message, slot }));
}

/**
 * Shell-command prefix → `rtk pipe -f` filter, matched on the longest prefix of the normalized
 * command. Every filter name here is a real one from `rtk pipe --help` (the same set `rtk
 * rewrite` maps commands onto), and every entry is a command whose filter keeps — rather than
 * destroys — the meaningful fields of output that doesn't match it exactly.
 *
 * `-f log` is deliberately absent: it wraps input in a "Log Summary / 0 errors / 0 warnings"
 * envelope that is lossy on anything not already log-shaped (it reduces a `git status` or a
 * plain file to a single empty summary line).
 */
const FILTER_BY_COMMAND: ReadonlyArray<readonly [prefix: string, filter: string]> = [
  ["cargo test", "cargo-test"],
  ["git status", "git-status"],
  ["git diff", "git-diff"],
  ["git log", "git-log"],
  ["go test", "go-test"],
  ["go build", "go-build"],
  ["python -m pytest", "pytest"],
  ["python -m mypy", "mypy"],
];

/**
 * First-token matches whose single-word filter shares the name: `tsc`, `mypy`, `pytest`,
 * `vitest`, `grep`, `rg`, `find`, `fd`. A runner (`npx`, `pnpm`, `yarn`, `bunx`) is skipped
 * first, so `npx tsc --noEmit` reaches the same rule.
 */
const FILTER_BY_SINGLE_TOKEN = new Set([
  "tsc",
  "mypy",
  "pytest",
  "vitest",
  "grep",
  "rg",
  "find",
  "fd",
]);

/** `npx`, `pnpm exec`, `bunx`, … hand their arguments to the next program. */
const RUNNERS = new Set(["npx", "pnpm", "pnpx", "yarn", "bunx", "bun", "uvx"]);

/**
 * Maps a tool-call command to the `rtk pipe -f` filter it implies, or undefined when the command
 * isn't one we recognize. Leading noise — `sudo`, `env VAR=x`, `cd dir &&`, a runner, absolute
 * paths — is stripped so `/usr/bin/tsc`, `npx tsc`, and `tsc` all resolve alike. The filter is
 * only ever a hint: `rtk pipe` rejects unknown names and the caller keeps the original text, so
 * a miss costs one extra spawn, never correctness.
 */
function filterForCommand(command: string | undefined): string | undefined {
  if (!command) return undefined;
  // Only the first pipeline/redirect segment matters: `git status | head` is still git-status.
  let segment = command.split(/[|;&]/)[0] ?? "";
  segment = segment.replace(/^\s*sudo\s+/, "");
  segment = segment.replace(/^\s*env\s+(?:\w+=\S+\s+)*/, "");
  segment = segment.replace(/^\s*cd\s+\S+\s*&&\s*/, "");
  const basename = (token: string): string => token.split("/").pop() ?? token;
  const tokens = segment.trim().split(/\s+/).filter(Boolean).map(basename);
  // Skip leading assignments and runners to find the real program.
  let start = 0;
  while (start < tokens.length && (tokens[start]!.includes("=") || RUNNERS.has(tokens[start]!))) {
    start += 1;
  }
  if (start >= tokens.length) return undefined;
  const rest = tokens.slice(start);
  for (const [prefix, filter] of FILTER_BY_COMMAND) {
    const words = prefix.split(" ");
    if (words.length <= rest.length && words.every((word, i) => rest[i] === word)) {
      return filter;
    }
  }
  return FILTER_BY_SINGLE_TOKEN.has(rest[0]!) ? rest[0] : undefined;
}

/**
 * Pulls a tool call's command argument out of the wire shape the call arrived in. OpenAI chat
 * puts it in `tool_calls[].function.arguments` (a JSON string), Anthropic puts it in `tool_use`
 * blocks' `input` (an object), Responses puts it in `function_call.arguments` (a JSON string).
 * A bare-string argument is also accepted for tools that take the command itself.
 */
function extractCommand(rawArguments: unknown): string | undefined {
  if (typeof rawArguments === "string") {
    // Usually a JSON blob, occasionally the command itself — try JSON, else treat a
    // shell-shaped string as the command.
    try {
      return extractCommand(JSON.parse(rawArguments));
    } catch {
      return /[a-z]/i.test(rawArguments) ? rawArguments : undefined;
    }
  }
  if (!isRecord(rawArguments)) return undefined;
  const candidate =
    rawArguments.command ??
    rawArguments.cmd ??
    rawArguments.program ??
    rawArguments.script ??
    rawArguments.shell ??
    rawArguments.bash;
  return typeof candidate === "string" ? candidate : undefined;
}

/**
 * One pass over one message: gathers `tool_call_id -> command` pairs from whatever shape the
 * assistant turn used to request tool execution.
 */
function collectCommands(message: Json, into: Map<string, string>): void {
  // OpenAI chat: assistant messages carry `tool_calls` entries.
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      if (!isRecord(call) || typeof call.id !== "string") continue;
      const fn = isRecord(call.function) ? call.function : undefined;
      const command = extractCommand(fn?.arguments);
      if (command) into.set(call.id, command);
    }
  }
  // Anthropic: assistant content is a list of blocks including `tool_use`.
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      const command = extractCommand(block.input);
      if (command && typeof block.id === "string") into.set(block.id, command);
    }
  }
  // Responses: `function_call` items carry `call_id` + `arguments`.
  if (message.type === "function_call" && typeof message.call_id === "string") {
    const command = extractCommand(message.arguments);
    if (command) into.set(message.call_id, command);
  }
}

/**
 * Rebuilds one message with the compressed text for each of its slots, or returns it unchanged
 * when nothing was replaced.
 */
function applyReplacements(message: Json, byPart: Map<Json, string>): Json {
  if (byPart.size === 0) return message;
  if (Array.isArray(message.content) && !byPart.has(message)) {
    // Anthropic shape: slots pointed at `tool_result` blocks inside `content`.
    return {
      ...message,
      content: message.content.map((block) => {
        if (!isRecord(block)) return block;
        const text = byPart.get(block);
        return text === undefined ? block : injectText(block, "content", text);
      }),
    };
  }
  // OpenAI `role: "tool"` (string or array content) or Responses `function_call_output`: the
  // slot pointed at the message itself, so replace its `content`/`output` field.
  const text = byPart.get(message);
  if (text === undefined) return message;
  const field = message.type === "function_call_output" ? "output" : "content";
  return injectText(message, field, text);
}

/**
 * Shrinks prior tool results inside a request body by piping each one through `rtk pipe`.
 * Returns the body plus how much rtk removed; the caller records `savedTokens` on the ledger
 * row. Never throws — a missing binary or a result rtk cannot parse is left as it arrived.
 */
export async function saveTokens(
  body: Record<string, unknown>,
  config: TokenSaverConfig,
): Promise<SaveResult> {
  const stats: SaverStats = {
    resultsCompressed: 0,
    savedTokens: 0,
    charsBefore: 0,
    charsAfter: 0,
    failures: 0,
  };
  if (!config.enabled) return { body, stats };

  // The messages list is `messages` on Chat/Anthropic bodies and `input` on Responses bodies.
  const key = Array.isArray(body.messages)
    ? "messages"
    : Array.isArray(body.input)
      ? "input"
      : undefined;
  if (!key) return { body, stats };

  const raw = body[key] as unknown[];
  // Walk assistant turns once to record `tool_call_id -> command` — a tool result does not carry
  // the command that produced it, but the tool_call that requested it does. The map feeds
  // `rtkPipe`'s explicit-filter retry.
  const commandsById = new Map<string, string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    collectCommands(item, commandsById);
  }

  // Collect every sizable tool result across the request so all of them share one bounded pool
  // of rtk processes, rather than each message spawning its own.
  const work: Array<{ message: Json; slot: ResultSlot }> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    work.push(...messageSlots(item, commandsById));
  }
  if (work.length === 0) return { body, stats };

  const outcomes = await rtkPipeBatch(
    work.map((entry) => entry.slot),
    config,
  );
  const byPart = new Map<Json, string>();
  outcomes.forEach((outcome, index) => {
    if (outcome.failed) stats.failures += 1;
    if (outcome.missing) stats.unavailable = true;
    const { slot } = work[index]!;
    if (outcome.text === slot.text) return;
    stats.resultsCompressed += 1;
    stats.charsBefore += slot.text.length;
    stats.charsAfter += outcome.text.length;
    stats.savedTokens += Math.max(0, estimateTokens(slot.text) - estimateTokens(outcome.text));
    byPart.set(slot.part, outcome.text);
  });
  if (stats.resultsCompressed === 0) return { body, stats };

  const next = raw.map((item) =>
    isRecord(item) ? applyReplacements(item, byPart) : item,
  ) as unknown[];
  return { body: { ...body, [key]: next }, stats };
}
