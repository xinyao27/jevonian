import { describe, expect, it } from "vite-plus/test";

import { sessionFingerprint } from "./session";

describe("sessionFingerprint", () => {
  it("is stable for the same conversation prefix", () => {
    const input = { messages: [{ role: "user", content: "hi" }] };
    expect(sessionFingerprint(input)).toBe(sessionFingerprint(input));
  });

  it("ignores messages appended after the first user turn", () => {
    const first = { messages: [{ role: "user", content: "hi" }] };
    const later = {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "more" },
      ],
    };
    expect(sessionFingerprint(first)).toBe(sessionFingerprint(later));
  });

  it("changes when the system prompt or tools change", () => {
    const messages = [{ role: "user", content: "hi" }];
    expect(sessionFingerprint({ system: "a", messages })).not.toBe(
      sessionFingerprint({ system: "b", messages }),
    );
    expect(sessionFingerprint({ tools: [{ name: "read" }], messages })).not.toBe(
      sessionFingerprint({ tools: [{ name: "write" }], messages }),
    );
  });

  it("handles payloads without messages", () => {
    expect(sessionFingerprint({})).toHaveLength(16);
  });
});
