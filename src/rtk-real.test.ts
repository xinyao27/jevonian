import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_TOKEN_SAVER, saveTokens, type TokenSaverConfig } from "./saver";

/**
 * End-to-end regression against the real `rtk` binary, so a change in how `rtk pipe` is
 * invoked is caught against the tool rather than only against the test doubles in
 * `saver.test.ts`. Skipped when `rtk` is not installed — `brew install rtk` to enable it.
 */
function resolveRtk(): string | undefined {
  try {
    return execFileSync("which", ["rtk"], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

const rtkPath = resolveRtk();
const itIfRtk = rtkPath ? it : it.skip;

const config: TokenSaverConfig = { ...DEFAULT_TOKEN_SAVER, command: rtkPath ?? "rtk" };

const PYTEST_LOG = [
  "============================= test session starts ==============================",
  "platform darwin -- Python 3.13.0, pytest-8.0.0, pluggy-1.5.0",
  "rootdir: /Users/x/proj",
  ...Array.from({ length: 120 }, (_, i) => `tests/test_mod.py::test_${i} PASSED`),
  "tests/test_mod.py::test_broken FAILED",
  "=================================== FAILURES ===================================",
  "______________________________ test_broken ______________________________",
  "    def test_broken():",
  ">       assert 1 == 2",
  "E       assert 1 == 2",
  "tests/test_mod.py:3: AssertionError",
  "=========================== short test summary info ============================",
  "FAILED tests/test_mod.py::test_broken - assert 1 == 2",
  "===================== 1 failed, 120 passed in 1.23s ======================",
].join("\n");

describe("saveTokens with the real rtk binary", () => {
  itIfRtk("compresses a pytest log via rtk pipe", async () => {
    const body = {
      messages: [
        { role: "user", content: "run tests" },
        { role: "tool", tool_call_id: "c1", content: PYTEST_LOG },
      ],
    };
    const { body: out, stats } = await saveTokens(body, config);
    const compressed = (out.messages as Array<Record<string, unknown>>)[1]!.content as string;
    // rtk's own summary line, not our passthrough.
    expect(compressed).toContain("Pytest:");
    expect(compressed.length).toBeLessThan(PYTEST_LOG.length);
    expect(stats.resultsCompressed).toBe(1);
    expect(stats.savedTokens).toBeGreaterThan(0);
    expect(stats.failures).toBe(0);
  });

  itIfRtk("passes through text rtk does not recognize", async () => {
    const body = {
      messages: [{ role: "tool", tool_call_id: "c", content: "the answer is 42" }],
    };
    const { body: out, stats } = await saveTokens(body, config);
    expect(out).toBe(body);
    expect(stats.resultsCompressed).toBe(0);
    expect(stats.failures).toBe(0);
  });
});
