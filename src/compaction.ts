/**
 * Compaction by deletion, adapted from `fast-jev-compaction` (MIT).
 *
 * The policy differs from the summarise-then-replace approach on purpose: nothing is ever
 * rewritten. Text the user and assistant produced stays verbatim and in order, and the only
 * things removed are tool calls and tool results that Jev judges no longer needed. A summary
 * is lossy — an exact file path, error string, or constraint can vanish even when it still
 * matters — whereas a deleted tool result is recoverable: the assistant can re-run the tool.
 *
 * This module normalises all three wire formats into one transcript shape, fits the state
 * into a token ceiling in shrinking stages, and asks Jev two `noul` questions per candidate
 * call: should the call stay, and should its result stay verbatim.
 */

export type Role = "user" | "assistant";

/** A tool call, paired with the outcome once the transcript holds it. */
export interface ToolUse {
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
}

/** A tool result, paired to its call by id. */
export interface ToolResult {
  tool_use_id: string;
  text: string;
  isError?: boolean;
}

/** One transcript message. All three wire formats normalise into this. */
export interface Message {
  role: Role;
  text: string;
  toolUses: ToolUse[];
  toolResults?: ToolResult[];
}

/** A tool call paired with its result by `tool_use_id`. */
export interface ToolCall {
  /** Short id used in the state and question names (`t1`, `t2`, …). */
  id: string;
  tool_use_id: string;
  tool: string;
  input: Record<string, unknown>;
  callIndex: number;
  resultIndex: number;
  resultChars: number;
  isError: boolean;
  /** In the first or the newest preserved messages; never a candidate. */
  pinned: boolean;
}

export interface CallAnswer {
  keepCall: number;
  keepResult: number;
}

export type CallAction = "keep" | "drop_result" | "drop_call";

export interface CallDecision extends CallAnswer {
  id: string;
  tool: string;
  action: CallAction;
  reason: "pinned" | "kept" | "result_dropped" | "call_dropped";
}

export interface HistoryToolCall {
  id: string;
  tool: string;
  input: string;
  result: string;
}

export interface HistoryEntry {
  i: number;
  role: Role;
  text: string;
  /** Structured per call, or one compact line per call once the state must shrink. */
  tool_calls?: HistoryToolCall[] | string[];
}

export interface CompactionState {
  context: string;
  goal: string;
  history: HistoryEntry[];
}

export interface CompactResult {
  messages: Message[];
  decisions: CallDecision[];
  stats: {
    messagesBefore: number;
    messagesAfter: number;
    charsBefore: number;
    charsAfter: number;
    calls: number;
    kept: number;
    resultsDropped: number;
    callsDropped: number;
    pinned: number;
    stateTokens: number;
    stateStage: string;
    requests: number;
    ms: number;
  };
}

export interface CompactOptions {
  goal?: string;
  /** Minimum keep probability for a call or result to stay. Default 0.5. */
  keepThreshold?: number;
  /** Newest messages never touched (the first is always kept). Default 6. */
  preserveRecentMessages?: number;
  /** Estimated token ceiling for the state. Default 25000. */
  maxStateTokens?: number;
  /** Estimated ceiling for state plus one batch of questions. Default 30000. */
  maxRequestTokens?: number;
  /** Characters of a dropped tool result retained. Default 300. */
  truncateHeadChars?: number;
}

export interface ResolvedCompactOptions {
  goal: string;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

export const DEFAULT_OPTIONS: ResolvedCompactOptions = {
  goal: "",
  keepThreshold: 0.5,
  preserveRecentMessages: 6,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  truncateHeadChars: 300,
};

/** Tokens the request envelope (`model`, key names) adds around state and questions. */
const REQUEST_OVERHEAD_TOKENS = 20;

export const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. `history` is the whole conversation so far, oldest first; tool outputs are replaced by a short `result` note and long texts may be abridged. Each question asks whether one tool call, or the full output of that call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, but the assistant can always re-run a tool or re-read a file.";

/**
 * Estimates tokens without a tokenizer: a word costs one token per six letters, a digit half a
 * token, any other symbol nine tenths. Calibrated against the usage Jev reports for real
 * transcripts, where it lands 2–18% above the true count; a plain characters-per-token ratio
 * undercounts JSON-heavy states by up to 40%.
 */
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2;
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
}

export function resolveOptions(options: CompactOptions = {}): ResolvedCompactOptions {
  const finite = (value: number | undefined, fallback: number): number =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return {
    goal: options.goal ?? DEFAULT_OPTIONS.goal,
    keepThreshold: finite(options.keepThreshold, DEFAULT_OPTIONS.keepThreshold),
    preserveRecentMessages: Math.max(
      0,
      Math.floor(finite(options.preserveRecentMessages, DEFAULT_OPTIONS.preserveRecentMessages)),
    ),
    maxStateTokens: Math.max(1, finite(options.maxStateTokens, DEFAULT_OPTIONS.maxStateTokens)),
    maxRequestTokens: Math.max(
      1,
      finite(options.maxRequestTokens, DEFAULT_OPTIONS.maxRequestTokens),
    ),
    truncateHeadChars: Math.max(
      0,
      Math.floor(finite(options.truncateHeadChars, DEFAULT_OPTIONS.truncateHeadChars)),
    ),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/**
 * A string field, or `""` when it is missing or not a string. A plain `String(value)` would
 * turn an object into `"[object Object]"`, which as a tool id would silently pair the wrong
 * call and result.
 */
function idOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nameOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  const parts: string[] = [];
  for (const part of value) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    const record = asRecord(part);
    if (typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}

/**
 * Whether a tool result records a failure. Anthropic and Responses carry this in the body; the
 * OpenAI chat format does not, so a `tool` message is treated as an error when its content
 * opens with the conventional error prefix. That only affects the `ok`/`error` note sent to
 * Jev and the wording of the truncation marker, never what is kept.
 */
function looksLikeError(text: string): boolean {
  return /^\s*(error|err!?|fatal|traceback|exception)\b/i.test(text);
}

/**
 * Normalises a request body from any of the three wire formats into one transcript. Tool
 * calls and results are paired here rather than per-format, so the compaction logic below
 * never has to know which agent sent the request.
 *
 * Shape detection is by structure, not by `kind`, because a client may send an Anthropic body
 * to the OpenAI endpoint and vice versa.
 */
export function normalizeTranscript(body: Record<string, unknown>): Message[] {
  const raw = Array.isArray(body.messages)
    ? body.messages
    : Array.isArray(body.input)
      ? body.input
      : [];
  const messages: Message[] = [];
  const byCallId = new Map<string, ToolResult>();

  for (const entry of raw) {
    const message = asRecord(entry);
    const role: Role = message.role === "assistant" ? "assistant" : "user";
    const toolUses: ToolUse[] = [];
    const toolResults: ToolResult[] = [];

    // Anthropic-style content blocks.
    if (Array.isArray(message.content)) {
      for (const blockRaw of message.content) {
        const block = asRecord(blockRaw);
        if (block.type === "tool_use") {
          toolUses.push({
            tool_use_id: idOf(block.id),
            tool: nameOf(block.name),
            input: asRecord(block.input),
          });
        } else if (block.type === "tool_result") {
          toolResults.push({
            tool_use_id: idOf(block.tool_use_id),
            text: textOf(block.content) || textOf(block.text),
            ...(block.is_error === true ? { isError: true } : {}),
          });
        }
      }
    }

    // OpenAI-style tool calls and tool-role results.
    if (Array.isArray(message.tool_calls)) {
      for (const callRaw of message.tool_calls) {
        const call = asRecord(callRaw);
        const fn = asRecord(call.function);
        let input: Record<string, unknown> = {};
        if (typeof fn.arguments === "string") {
          try {
            input = asRecord(JSON.parse(fn.arguments));
          } catch {
            input = { raw: fn.arguments };
          }
        } else {
          input = asRecord(fn.arguments ?? call.input);
        }
        toolUses.push({
          tool_use_id: idOf(call.id),
          tool: nameOf(fn.name) || nameOf(call.name),
          input,
        });
      }
    }
    if (message.role === "tool" && typeof message.tool_call_id === "string") {
      const text = textOf(message.content);
      toolResults.push({
        tool_use_id: message.tool_call_id,
        text,
        ...(looksLikeError(text) ? { isError: true } : {}),
      });
    }

    // Responses-style function calls and outputs, which live at the top level of `input`.
    if (message.type === "function_call") {
      let input: Record<string, unknown> = {};
      if (typeof message.arguments === "string") {
        try {
          input = asRecord(JSON.parse(message.arguments));
        } catch {
          input = { raw: message.arguments };
        }
      }
      toolUses.push({
        tool_use_id: idOf(message.call_id) || idOf(message.id),
        tool: nameOf(message.name),
        input,
      });
    }
    if (message.type === "function_call_output") {
      toolResults.push({
        tool_use_id: idOf(message.call_id),
        text: textOf(message.output),
      });
    }

    const text =
      message.role === "tool" || message.type === "function_call_output"
        ? // A tool result is carried by `toolResults`, never by `text`. Treating it as prose
          // would make compaction keep it verbatim as un-droppable text.
          ""
        : textOf(message.content);
    const normalized: Message = { role, text, toolUses };
    if (toolResults.length > 0) normalized.toolResults = toolResults;
    if (text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) continue;
    messages.push(normalized);
    for (const result of toolResults) byCallId.set(result.tool_use_id, result);
  }

  return messages;
}

/** Characters of text, tool input and tool output a message holds. */
export function messageChars(message: Message): number {
  let total = message.text.length;
  for (const tool of message.toolUses) {
    try {
      total += JSON.stringify(tool.input).length;
    } catch {
      total += 20;
    }
  }
  for (const result of message.toolResults ?? []) total += result.text.length;
  return total;
}

export function reductionRatio(result: Pick<CompactResult, "stats">): number {
  const { charsBefore, charsAfter } = result.stats;
  return charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;
}

// ---------------------------------------------------------------------------
// State fitting: shrink the transcript until it fits the token ceiling, in stages
// ---------------------------------------------------------------------------

/** Successive caps on the serialised tool input included per call. */
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400;
const TEXT_TAIL = 150;

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`;
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text;
  const omitted = text.length - head - tail;
  return `${text.slice(0, head)}\n[… ${omitted} chars omitted …]\n${text.slice(-tail)}`;
}

function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

/**
 * Pairs every tool_use with its tool_result by `tool_use_id`. Calls without a result are not
 * candidates: there is nothing to drop yet.
 */
export function collectToolCalls(
  messages: readonly Message[],
  preserveRecentMessages: number,
): ToolCall[] {
  const results = new Map<string, { index: number; result: ToolResult }>();
  messages.forEach((message, index) => {
    for (const result of message.toolResults ?? []) {
      results.set(result.tool_use_id, { index, result });
    }
  });
  const calls: ToolCall[] = [];
  messages.forEach((message, callIndex) => {
    for (const tool of message.toolUses) {
      const found = results.get(tool.tool_use_id);
      if (!found) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        tool_use_id: tool.tool_use_id,
        tool: tool.tool,
        input: tool.input,
        callIndex,
        resultIndex: found.index,
        resultChars: found.result.text.length,
        isError: found.result.isError ?? false,
        pinned:
          isPinned(callIndex, messages.length, preserveRecentMessages) ||
          isPinned(found.index, messages.length, preserveRecentMessages),
      });
    }
  });
  return calls;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  let json = "";
  try {
    json = JSON.stringify(input);
  } catch {
    json = "[unserializable input]";
  }
  return truncate(json, limit);
}

function resultNote(call: ToolCall): string {
  return `${call.isError ? "error" : "ok"}, ${call.resultChars} chars (omitted)`;
}

/** One call as a single line, for when the structured form is too costly. */
function compactCall(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, " ")}`;
    })
    .join(" ");
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${
    call.isError ? "error" : "ok"
  } ${call.resultChars}ch`;
}

/**
 * Folds runs of adjacent call-only entries into one entry each, so the per-entry envelope is
 * paid once per run; the call lines keep their ids.
 */
function mergeCallRuns(
  history: readonly HistoryEntry[],
  pinned: (entry: HistoryEntry) => boolean,
): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    const foldable = (candidate: HistoryEntry): boolean =>
      !pinned(candidate) &&
      candidate.text.length === 0 &&
      typeof candidate.tool_calls?.[0] === "string";
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [
        ...(previous.tool_calls as string[]),
        ...(entry.tool_calls as string[]),
      ];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

function callsByMessage(calls: readonly ToolCall[]): Map<number, ToolCall[]> {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const list = byMessage.get(call.callIndex) ?? [];
    list.push(call);
    byMessage.set(call.callIndex, list);
  }
  return byMessage;
}

function historyEntries(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  inputChars: number,
): HistoryEntry[] {
  const byMessage = callsByMessage(calls);
  const entries: HistoryEntry[] = [];
  messages.forEach((message, i) => {
    const toolCalls = (byMessage.get(i) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }));
    if (message.text.trim().length === 0 && toolCalls.length === 0) return;
    const entry: HistoryEntry = { i, role: message.role, text: message.text };
    if (toolCalls.length > 0) entry.tool_calls = toolCalls;
    entries.push(entry);
  });
  return entries;
}

/** The last three user prompts, as the default `goal`. */
export function goalFromMessages(messages: readonly Message[]): string {
  return messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.text.trim().length > 0 &&
        (message.toolResults ?? []).length === 0,
    )
    .slice(-3)
    .map((message) => truncate(message.text, 500))
    .join("\n");
}

export interface FittedState {
  state: CompactionState;
  tokens: number;
  /** Which fitting stage produced the state, for diagnostics. */
  stage: string;
}

/**
 * Builds the Jev state from the whole conversation and shrinks it in stages until it fits
 * `maxStateTokens`: tool inputs are truncated, then long texts are abridged oldest-first
 * (pinned messages last), then old messages collapse to a one-line note, then old tool calls
 * shrink to one line each, then old messages that carry no call are left out, then runs of old
 * call-only messages are folded into one entry. Throws when even that is too big.
 */
export function fitState(
  messages: readonly Message[],
  calls: readonly ToolCall[],
  options: Pick<ResolvedCompactOptions, "maxStateTokens" | "preserveRecentMessages" | "goal">,
): FittedState {
  const goal = options.goal || goalFromMessages(messages);
  const stateOf = (history: HistoryEntry[]): CompactionState => ({
    context: STATE_CONTEXT,
    goal,
    history,
  });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = historyEntries(messages, calls, inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, count) => sum + count, 0);
  };
  const fits = (): boolean => tokens <= options.maxStateTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };
  const fitted = (next: HistoryEntry[], count: number, stage: string): FittedState => ({
    state: stateOf(next),
    tokens: count,
    stage,
  });

  rebuild(INPUT_CHARS[0]);
  if (fits()) return fitted(history, tokens, "full");

  for (const limit of INPUT_CHARS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean =>
    isPinned(entry.i, messages.length, options.preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [
    ...indices.filter((index) => !pinned(history[index]!)),
    ...indices.filter((index) => pinned(history[index]!)),
  ];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue;
    shrink(index, (target) => {
      target.text = abridge(target.text, TEXT_HEAD, TEXT_TAIL);
    });
    if (fits()) return fitted(history, tokens, "texts abridged");
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = messages[entry.i]?.text.length ?? entry.text.length;
    shrink(index, (target) => {
      target.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, "old messages collapsed");
  }

  const byMessage = callsByMessage(calls);
  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (target) => {
      target.tool_calls = own.map(compactCall);
    });
    if (fits()) return fitted(history, tokens, "old calls compacted");
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        "old messages left out",
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, count) => sum + count, 0);
  if (fits()) return fitted(history, tokens, "old calls merged");

  throw new Error(
    `history too large for Jev (~${tokens} tokens after truncation, limit ${options.maxStateTokens})`,
  );
}

// ---------------------------------------------------------------------------
// Asking Jev: two `noul` questions per call, batched to fit the request ceiling
// ---------------------------------------------------------------------------

export interface JevQuestion {
  type: "noul" | "choice" | "score";
  instructions: string;
  criteria?: Record<string, string | null> | string[];
}

export interface JevAnswer {
  noul?: number;
  choice?: string;
  score?: number;
  confidence?: number;
}

export interface JevResponse {
  model?: string;
  answers: Record<string, JevAnswer>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Anything that can answer Jev questions: the router's brain client, or a test double. */
export interface JevAsker {
  ask(state: CompactionState, questions: Record<string, JevQuestion>): Promise<JevResponse>;
}

/** The two `noul` questions asked about one call: keep the call, keep its result. */
export function questionsFor(call: ToolCall): Record<string, JevQuestion> {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.resultChars} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  };
}

/**
 * Splits the candidate calls into batches whose questions, together with the (always complete)
 * state, fit one request.
 */
export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  options: Pick<ResolvedCompactOptions, "maxRequestTokens">,
): ToolCall[][] {
  const budget = options.maxRequestTokens - stateTokens - REQUEST_OVERHEAD_TOKENS;
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && tokens > budget) {
      throw new Error(
        `state leaves no room for questions (~${stateTokens} of ${options.maxRequestTokens} tokens)`,
      );
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, "id" | "tool" | "pinned">,
  answer: CallAnswer,
  options: Pick<ResolvedCompactOptions, "keepThreshold">,
): CallDecision {
  const base = { id: call.id, tool: call.tool, ...answer };
  if (call.pinned) return { ...base, action: "keep", reason: "pinned" };
  if (answer.keepResult >= options.keepThreshold)
    return { ...base, action: "keep", reason: "kept" };
  if (answer.keepCall >= options.keepThreshold) {
    return { ...base, action: "drop_result", reason: "result_dropped" };
  }
  return { ...base, action: "drop_call", reason: "call_dropped" };
}

/** The `noul` probability of one answer; throws when it is not there. */
export function noulAnswer(answers: Record<string, JevAnswer>, name: string): number {
  const answer = answers[name];
  const value = answer?.noul;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid Jev answer for ${name}`);
  }
  return value;
}

async function askBatch(
  asker: JevAsker,
  state: CompactionState,
  batch: readonly ToolCall[],
): Promise<Map<string, CallAnswer>> {
  const questions: Record<string, JevQuestion> = Object.assign({}, ...batch.map(questionsFor));
  const { answers } = await asker.ask(state, questions);
  return new Map(
    batch.map((call) => [
      call.id,
      {
        keepCall: noulAnswer(answers, `call_${call.id}`),
        keepResult: noulAnswer(answers, `result_${call.id}`),
      },
    ]),
  );
}

function truncatedResultText(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  return `${head}[jevonian truncated ${text.length - headChars} chars of this tool result${
    isError ? " (error)" : ""
  }; re-run the tool if needed]`;
}

/**
 * Rebuilds the conversation from the decisions. A dropped call disappears together with its
 * result; a dropped result keeps a bounded head and note. Messages that lose all their content
 * are removed; untouched messages are returned as the same objects they came in as.
 *
 * The output is format-agnostic — `Message[]`, not a wire body. Re-encoding into the caller's
 * original shape is the caller's job, so this stays testable without three serialisers.
 */
export function applyDecisions(
  messages: readonly Message[],
  decisions: readonly CallDecision[],
  calls: readonly ToolCall[],
  headChars: number,
): Message[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  const actions = new Map<string, CallAction>();
  for (const decision of decisions) {
    const call = byId.get(decision.id);
    if (call && decision.action !== "keep") actions.set(call.tool_use_id, decision.action);
  }
  const kept: Message[] = [];
  for (const message of messages) {
    const touched =
      message.toolUses.some((tool) => actions.has(tool.tool_use_id)) ||
      (message.toolResults ?? []).some((result) => actions.has(result.tool_use_id));
    if (!touched) {
      kept.push(message);
      continue;
    }
    const toolUses = message.toolUses.filter(
      (tool) => actions.get(tool.tool_use_id) !== "drop_call",
    );
    const toolResults = (message.toolResults ?? [])
      .filter((result) => actions.get(result.tool_use_id) !== "drop_call")
      .map((result) => {
        if (actions.get(result.tool_use_id) !== "drop_result") return result;
        const text = truncatedResultText(result.text, result.isError ?? false, headChars);
        return text === result.text ? result : { ...result, text };
      });
    if (message.text.trim().length === 0 && toolUses.length === 0 && toolResults.length === 0) {
      continue;
    }
    const rebuilt: Message = { role: message.role, text: message.text, toolUses };
    if (toolResults.length > 0) rebuilt.toolResults = toolResults;
    kept.push(rebuilt);
  }
  return kept;
}

function count(decisions: readonly CallDecision[], reason: CallDecision["reason"]): number {
  return decisions.filter((decision) => decision.reason === reason).length;
}

/**
 * Compacts a transcript by asking Jev, for every tool call outside the pinned first and newest
 * messages, whether the call and whether its result must stay. The whole history (results
 * omitted, fitted into `maxStateTokens`) is sent as state with every batch of questions.
 * Throws when Jev fails or the history cannot be fitted; the caller decides whether to fall
 * back — and should check `reductionRatio` before accepting the result.
 */
export async function compact(
  messages: readonly Message[],
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<CompactResult> {
  const started = Date.now();
  const resolved = resolveOptions(options);
  const calls = collectToolCalls(messages, resolved.preserveRecentMessages);
  const candidates = calls.filter((call) => !call.pinned);
  const charsBefore = messages.reduce((sum, message) => sum + messageChars(message), 0);

  let fitted: { tokens: number; stage: string } = { tokens: 0, stage: "" };
  let batches: ToolCall[][] = [];
  const answers = new Map<string, CallAnswer>();
  if (candidates.length > 0) {
    const state = fitState(messages, calls, resolved);
    fitted = { tokens: state.tokens, stage: state.stage };
    batches = batchCalls(candidates, state.tokens, resolved);
    const answered = await Promise.all(batches.map((batch) => askBatch(asker, state.state, batch)));
    for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  }

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, resolved),
  );
  const kept = applyDecisions(messages, decisions, calls, resolved.truncateHeadChars);
  return {
    messages: kept,
    decisions,
    stats: {
      messagesBefore: messages.length,
      messagesAfter: kept.length,
      charsBefore,
      charsAfter: kept.reduce((sum, message) => sum + messageChars(message), 0),
      calls: calls.length,
      kept: count(decisions, "kept"),
      resultsDropped: count(decisions, "result_dropped"),
      callsDropped: count(decisions, "call_dropped"),
      pinned: count(decisions, "pinned"),
      stateTokens: fitted.tokens,
      stateStage: fitted.stage,
      requests: batches.length,
      ms: Date.now() - started,
    },
  };
}

// ---------------------------------------------------------------------------
// Re-encoding: put the compacted transcript back into the caller's wire format
// ---------------------------------------------------------------------------

/**
 * Writes a compacted transcript back into a request body, preserving the original wire format
 * of the messages it came from. Only `messages`/`input` is replaced; every other field
 * (`model`, `tools`, `stream`, …) is left exactly as the caller sent it.
 *
 * Re-encoding is lossy by design for anything this module does not model — a message whose
 * blocks it did not understand is passed through untouched when it was untouched by the
 * decisions, and a rebuilt message only ever carries the text and tool blocks it understood.
 * That is why `applyDecisions` returns the original objects for messages it did not touch.
 */
export function reencodeMessages(
  body: Record<string, unknown>,
  messages: readonly Message[],
): Record<string, unknown> {
  const key = Array.isArray(body.messages) ? "messages" : "input";
  const anthropic = key === "messages" && messages.some((message) => message.role === "assistant");
  const out = messages.map((message) => encodeMessage(message, anthropic));
  return { ...body, [key]: out };
}

function encodeMessage(message: Message, anthropicStyle: boolean): Record<string, unknown> {
  const blocks: unknown[] = [];
  if (message.text.length > 0) {
    blocks.push(
      anthropicStyle ? { type: "text", text: message.text } : { type: "text", text: message.text },
    );
  }
  for (const tool of message.toolUses) {
    blocks.push({ type: "tool_use", id: tool.tool_use_id, name: tool.tool, input: tool.input });
  }
  for (const result of message.toolResults ?? []) {
    blocks.push({
      type: "tool_result",
      tool_use_id: result.tool_use_id,
      ...(anthropicStyle ? { content: result.text } : { text: result.text }),
      ...(result.isError ? { is_error: true } : {}),
    });
  }
  return { role: message.role, content: blocks };
}
