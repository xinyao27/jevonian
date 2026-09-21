import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { isSafeBodyId, loadBody, saveBody } from "./bodies";

let dir = "";
let previousData: string | undefined;
let previousCapture: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "jevonian-bodies-"));
  previousData = process.env.JEVONIAN_DATA_DIR;
  previousCapture = process.env.JEVONIAN_CAPTURE_BODIES;
  process.env.JEVONIAN_DATA_DIR = dir;
});

afterEach(() => {
  if (previousData === undefined) delete process.env.JEVONIAN_DATA_DIR;
  else process.env.JEVONIAN_DATA_DIR = previousData;
  if (previousCapture === undefined) delete process.env.JEVONIAN_CAPTURE_BODIES;
  else process.env.JEVONIAN_CAPTURE_BODIES = previousCapture;
  rmSync(dir, { recursive: true, force: true });
});

describe("bodies", () => {
  it("round-trips a payload", () => {
    const id = "11111111-2222-3333-4444-555555555555";
    saveBody(id, { kind: "request", body: { messages: [{ role: "user", content: "hi" }] } });
    expect(loadBody(id)).toEqual({
      kind: "request",
      body: { messages: [{ role: "user", content: "hi" }] },
    });
  });

  it("rejects unsafe ids", () => {
    expect(isSafeBodyId("../../etc/passwd")).toBe(false);
    expect(isSafeBodyId("nope")).toBe(false);
    expect(loadBody("../../etc/passwd")).toBeUndefined();
    saveBody("../../etc/passwd", { evil: true });
    expect(loadBody("../../etc/passwd")).toBeUndefined();
  });

  it("honors the capture toggle", () => {
    process.env.JEVONIAN_CAPTURE_BODIES = "0";
    const id = "99999999-2222-3333-4444-555555555555";
    saveBody(id, { kind: "request" });
    expect(loadBody(id)).toBeUndefined();
  });
});
