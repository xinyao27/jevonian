import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  clearSaverCache,
  DEFAULT_TOKEN_SAVER,
  parseCommand,
  parseTokenSaver,
  saveTokens,
  type TokenSaverConfig,
} from "./saver";

/**
 * Tests do not depend on a system `rtk` install. Each case writes a tiny shell script that
 * plays the part of `rtk pipe`: read stdin, emit a canned (shorter or passthrough) output.
 */
function fakeRtk(behavior: "compress" | "echo" | "fail" | "sleep"): TokenSaverConfig {
  const dir = mkdtempSync(join(tmpdir(), "rtk-fake-"));
  const script = join(dir, "rtk");
  const body =
    behavior === "compress"
      ? // Emit a compact summary — the shape rtk prints for test-runner output.
        "cat >/dev/null; printf 'Pytest: 2 passed, 1 failed\\n'"
      : behavior === "echo"
        ? "cat"
        : behavior === "sleep"
          ? "sleep 10"
          : "exit 1";
  writeFileSync(script, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ...DEFAULT_TOKEN_SAVER, command: script };
}

const BIG_TEST_LOG = [
  "=== test session starts ===",
  "platform darwin -- Python 3.13",
  ...Array.from({ length: 200 }, (_, i) => `collected item ${i}`),
  "tests/test_a.py PASSED",
  "tests/test_b.py FAILED",
  "=== short test summary info ===",
  "FAILED tests/test_b.py - assert 1 == 2",
  "=== 1 failed, 1 passed ===",
].join("\n");

describe("parseTokenSaver", () => {
  it("defaults to enabled with the default settings", () => {
    expect(parseTokenSaver(undefined)).toEqual(DEFAULT_TOKEN_SAVER);
    expect(parseTokenSaver(null)).toEqual(DEFAULT_TOKEN_SAVER);
    expect(parseTokenSaver({})).toEqual(DEFAULT_TOKEN_SAVER);
  });

  it("honours explicit flags", () => {
    expect(parseTokenSaver({ enabled: false }).enabled).toBe(false);
    expect(parseTokenSaver({ command: "/opt/rtk" }).command).toBe("/opt/rtk");
    expect(parseTokenSaver({ timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
  });

  it("falls back to defaults on bad values", () => {
    expect(parseTokenSaver({ command: "  " }).command).toBe(DEFAULT_TOKEN_SAVER.command);
    expect(parseTokenSaver({ timeoutMs: -1 }).timeoutMs).toBe(DEFAULT_TOKEN_SAVER.timeoutMs);
    expect(parseTokenSaver({ timeoutMs: "x" }).timeoutMs).toBe(DEFAULT_TOKEN_SAVER.timeoutMs);
  });
});

describe("parseCommand", () => {
  it("splits a binary from its leading flags", () => {
    expect(parseCommand("rtk")).toEqual({ bin: "rtk", args: [] });
    expect(parseCommand("/opt/homebrew/bin/rtk")).toEqual({
      bin: "/opt/homebrew/bin/rtk",
      args: [],
    });
    expect(parseCommand("rtk --ultra-compact")).toEqual({
      bin: "rtk",
      args: ["--ultra-compact"],
    });
  });

  it("keeps a quoted path with spaces together", () => {
    expect(parseCommand('"/Applications/My Tools/rtk" --ultra-compact')).toEqual({
      bin: "/Applications/My Tools/rtk",
      args: ["--ultra-compact"],
    });
  });

  it("never returns an empty binary", () => {
    expect(parseCommand("   ").bin).toBe(DEFAULT_TOKEN_SAVER.command);
  });
});

describe("saveTokens", () => {
  const compressing = fakeRtk("compress");

  it("returns the same body when disabled", async () => {
    const body = { messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }] };
    const { body: out, stats } = await saveTokens(body, {
      ...compressing,
      enabled: false,
    });
    expect(out).toBe(body);
    expect(stats.savedTokens).toBe(0);
  });

  it("compresses OpenAI tool messages through rtk", async () => {
    const body = {
      model: "gpt",
      messages: [
        { role: "user", content: "run the tests" },
        {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: BIG_TEST_LOG },
      ],
    };
    const { body: out, stats } = await saveTokens(body, compressing);
    const messages = out.messages as Array<Record<string, unknown>>;
    const tool = messages[2]!;
    expect(tool.content).toBe("Pytest: 2 passed, 1 failed\n");
    expect(stats.resultsCompressed).toBe(1);
    expect(stats.savedTokens).toBeGreaterThan(0);
    expect(stats.charsBefore).toBe(BIG_TEST_LOG.length);
    // Original body is not mutated.
    expect((body.messages[2] as { content: string }).content).toBe(BIG_TEST_LOG);
  });

  it("passes configured flags to rtk before the pipe subcommand", async () => {
    // The test double only accepts `--ultra-compact pipe`; a bare `pipe` exits 2.
    const dir = mkdtempSync(join(tmpdir(), "rtk-flags-"));
    const script = join(dir, "rtk");
    writeFileSync(
      script,
      `#!/bin/sh
if [ "$1" != "--ultra-compact" ] || [ "$2" != "pipe" ]; then exit 2; fi
cat >/dev/null
printf 'ok\\n'
`,
      { mode: 0o755 },
    );
    const body = { messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }] };
    const { body: out, stats } = await saveTokens(body, {
      ...DEFAULT_TOKEN_SAVER,
      command: `${script} --ultra-compact`,
    });
    expect((out.messages as Array<Record<string, unknown>>)[0]!.content).toBe("ok\n");
    expect(stats.failures).toBe(0);
  });

  it("skips the process spawn for tiny tool results", async () => {
    // A wrapper that fails loudly if it is ever executed.
    const dir = mkdtempSync(join(tmpdir(), "rtk-short-"));
    const script = join(dir, "rtk");
    writeFileSync(script, "#!/bin/sh\nexit 9\n", { mode: 0o755 });
    const body = {
      messages: [{ role: "tool", tool_call_id: "c", content: "ok" }],
    };
    const { body: out, stats } = await saveTokens(body, {
      ...DEFAULT_TOKEN_SAVER,
      command: script,
    });
    expect(out).toBe(body);
    expect(stats.failures).toBe(0); // never spawned, so never failed
    expect(stats.resultsCompressed).toBe(0);
  });

  it("memoizes a result text so a repeated turn never re-spawns rtk", async () => {
    // A wrapper that counts invocations; the second identical request must serve the cache.
    const dir = mkdtempSync(join(tmpdir(), "rtk-count-"));
    const script = join(dir, "rtk");
    const counter = join(dir, "count");
    writeFileSync(
      script,
      `#!/bin/sh
cat >/dev/null
printf 'ok\\n'
printf x >> "${counter}"
`,
      { mode: 0o755 },
    );
    const body = { messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }] };
    const cfg = { ...DEFAULT_TOKEN_SAVER, command: script };
    clearSaverCache();
    await saveTokens(body, cfg);
    await saveTokens(body, cfg);
    const calls = readFileSync(counter, "utf8").length;
    expect(calls).toBe(1);
  });

  it("compresses OpenAI tool messages with array content", async () => {
    const body = {
      messages: [
        {
          role: "tool",
          tool_call_id: "c1",
          content: [{ type: "text", text: BIG_TEST_LOG }],
        },
      ],
    };
    const { body: out, stats } = await saveTokens(body, compressing);
    const tool = (out.messages as Array<Record<string, unknown>>)[0]!;
    const blocks = tool.content as Array<Record<string, unknown>>;
    expect(blocks[0]!.text).toBe("Pytest: 2 passed, 1 failed\n");
    expect(stats.resultsCompressed).toBe(1);
  });

  it("compresses Anthropic tool_result blocks", async () => {
    const body = {
      model: "claude",
      messages: [
        { role: "user", content: "run tests" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: BIG_TEST_LOG }],
        },
      ],
    };
    const { body: out, stats } = await saveTokens(body, compressing);
    const user = (out.messages as Array<Record<string, unknown>>)[2]!;
    const content = user.content as Array<Record<string, unknown>>;
    expect(content[0]!.content).toBe("Pytest: 2 passed, 1 failed\n");
    expect(stats.savedTokens).toBeGreaterThan(0);
  });

  it("compresses Anthropic tool_result text-block arrays", async () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: [{ type: "text", text: BIG_TEST_LOG }],
            },
          ],
        },
      ],
    };
    const { body: out } = await saveTokens(body, compressing);
    const result = (
      (out.messages as Array<Record<string, unknown>>)[0]!.content as Array<Record<string, unknown>>
    )[0]!;
    const blocks = result.content as Array<Record<string, unknown>>;
    expect(blocks[0]!.text).toBe("Pytest: 2 passed, 1 failed\n");
  });

  it("compresses Responses function_call_output items", async () => {
    const body = {
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "c1", name: "bash", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: BIG_TEST_LOG },
      ],
    };
    const { body: out, stats } = await saveTokens(body, compressing);
    const items = out.input as Array<Record<string, unknown>>;
    expect(items[2]!.output).toBe("Pytest: 2 passed, 1 failed\n");
    expect(stats.savedTokens).toBeGreaterThan(0);
  });

  it("leaves passthrough output untouched and records no savings", async () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }],
    };
    const { body: out, stats } = await saveTokens(body, fakeRtk("echo"));
    expect(out).toBe(body); // same reference — rtk gave nothing shorter
    expect(stats.resultsCompressed).toBe(0);
    expect(stats.savedTokens).toBe(0);
    expect(stats.failures).toBe(0);
  });

  it("leaves the text and counts a failure when rtk errors", async () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }],
    };
    const { body: out, stats } = await saveTokens(body, fakeRtk("fail"));
    expect(out).toBe(body);
    expect(stats.resultsCompressed).toBe(0);
    expect(stats.failures).toBe(1);
  });

  it("leaves the text when rtk is not installed", async () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }],
    };
    const { body: out, stats } = await saveTokens(body, {
      ...compressing,
      command: "/nonexistent/rtk-binary",
    });
    expect(out).toBe(body);
    expect(stats.failures).toBe(1);
    expect(stats.unavailable).toBe(true);
  });

  it("does not flag unavailable when rtk runs but exits non-zero", async () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }],
    };
    const { stats } = await saveTokens(body, fakeRtk("fail"));
    expect(stats.failures).toBe(1);
    expect(stats.unavailable).toBeUndefined();
  });

  it("leaves the text when rtk times out", async () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "c", content: BIG_TEST_LOG }],
    };
    const { body: out, stats } = await saveTokens(body, {
      ...fakeRtk("sleep"),
      timeoutMs: 200,
    });
    expect(out).toBe(body);
    expect(stats.failures).toBe(1);
  });

  it("leaves bodies without tool results untouched", async () => {
    const body = { messages: [{ role: "user", content: "hi" }] };
    const { body: out, stats } = await saveTokens(body, compressing);
    expect(out).toBe(body);
    expect(stats.resultsCompressed).toBe(0);
  });

  it("sums savings across several results", async () => {
    const body = {
      messages: [
        { role: "tool", tool_call_id: "a", content: BIG_TEST_LOG },
        { role: "tool", tool_call_id: "b", content: BIG_TEST_LOG },
      ],
    };
    const { stats } = await saveTokens(body, compressing);
    expect(stats.resultsCompressed).toBe(2);
    expect(stats.charsBefore).toBe(BIG_TEST_LOG.length * 2);
  });

  describe("command-aware filter retry", () => {
    /**
     * A fake rtk that mimics auto-detect failing: a bare `pipe` passes text through, but
     * `pipe -f <filter>` compresses. Records each invocation's argv so a test can assert the
     * filter the saver chose.
     */
    function selectiveRtk(): { config: TokenSaverConfig; calls: string[] } {
      const dir = mkdtempSync(join(tmpdir(), "rtk-selective-"));
      const script = join(dir, "rtk");
      const log = join(dir, "argv");
      writeFileSync(
        script,
        `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
if [ "$2" = "-f" ]; then cat >/dev/null; printf 'FILTERED via %s\\n' "$3"; else cat; fi
`,
        { mode: 0o755 },
      );
      return { config: { ...DEFAULT_TOKEN_SAVER, command: script }, calls: [] };
    }

    it("retries with the filter named by an OpenAI tool call's command", async () => {
      clearSaverCache();
      const { config } = selectiveRtk();
      const body = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "tsc --noEmit" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: BIG_TEST_LOG },
        ],
      };
      const { body: out, stats } = await saveTokens(body, config);
      const tool = (out.messages as Array<Record<string, unknown>>)[1]!;
      expect(tool.content).toBe("FILTERED via tsc\n");
      expect(stats.resultsCompressed).toBe(1);
    });

    it("retries for Anthropic tool_use input commands", async () => {
      clearSaverCache();
      const { config } = selectiveRtk();
      const body = {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "t1", name: "bash", input: { command: "git status" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "t1", content: BIG_TEST_LOG }],
          },
        ],
      };
      const { body: out } = await saveTokens(body, config);
      const user = (out.messages as Array<Record<string, unknown>>)[1]!;
      const block = (user.content as Array<Record<string, unknown>>)[0]!;
      expect(block.content).toBe("FILTERED via git-status\n");
    });

    it("uses the git-diff filter for `git diff` commands", async () => {
      clearSaverCache();
      const { config } = selectiveRtk();
      const body = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "git diff HEAD~1" }),
                },
              },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: BIG_TEST_LOG },
        ],
      };
      const { body: out } = await saveTokens(body, config);
      const tool = (out.messages as Array<Record<string, unknown>>)[1]!;
      expect(tool.content).toBe("FILTERED via git-diff\n");
    });

    it("maps `git log` and `npx tsc` to their filters", async () => {
      clearSaverCache();
      const { config } = selectiveRtk();
      const mkBody = (id: string, command: string) => ({
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id,
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command }) },
              },
            ],
          },
          { role: "tool", tool_call_id: id, content: BIG_TEST_LOG },
        ],
      });
      const a = await saveTokens(mkBody("a", "git log --oneline"), config);
      const b = await saveTokens(mkBody("b", "npx tsc --noEmit"), config);
      const outA = (a.body.messages as Array<Record<string, unknown>>)[1]!;
      const outB = (b.body.messages as Array<Record<string, unknown>>)[1]!;
      expect(outA.content).toBe("FILTERED via git-log\n");
      expect(outB.content).toBe("FILTERED via tsc\n");
    });

    it("retries for Responses function_call commands", async () => {
      clearSaverCache();
      const { config } = selectiveRtk();
      const body = {
        input: [
          {
            type: "function_call",
            call_id: "c1",
            name: "bash",
            arguments: JSON.stringify({ command: "pytest -q" }),
          },
          { type: "function_call_output", call_id: "c1", output: BIG_TEST_LOG },
        ],
      };
      const { body: out } = await saveTokens(body, config);
      const items = out.input as Array<Record<string, unknown>>;
      expect(items[1]!.output).toBe("FILTERED via pytest\n");
    });

    it("does not retry when the command maps to no known filter", async () => {
      clearSaverCache();
      const { config } = selectiveRtk();
      const body = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "vim notes.md" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: BIG_TEST_LOG },
        ],
      };
      const { body: out, stats } = await saveTokens(body, config);
      expect(out.messages).toBeDefined();
      expect(stats.resultsCompressed).toBe(0);
    });

    it("keeps auto-detect output when it already compressed", async () => {
      clearSaverCache();
      // compress on bare `pipe` too, so the retry must not fire.
      const dir = mkdtempSync(join(tmpdir(), "rtk-auto-"));
      const script = join(dir, "rtk");
      writeFileSync(script, "#!/bin/sh\ncat >/dev/null\nprintf 'auto\\n'\n", { mode: 0o755 });
      const body = {
        messages: [
          {
            role: "assistant",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "tsc" }) },
              },
            ],
          },
          { role: "tool", tool_call_id: "c1", content: BIG_TEST_LOG },
        ],
      };
      const { body: out } = await saveTokens(body, { ...DEFAULT_TOKEN_SAVER, command: script });
      const tool = (out.messages as Array<Record<string, unknown>>)[1]!;
      expect(tool.content).toBe("auto\n");
    });
  });
});
