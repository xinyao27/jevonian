import { brotliCompressSync, gzipSync, zstdCompressSync } from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { decodeBody, MAX_BODY_BYTES } from "./body-encoding";

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("decodeBody", () => {
  it("passes an unencoded body through untouched", () => {
    // The common case: ordinary curl and SDK traffic sends plain JSON.
    const raw = encode('{"model":"jevonian/auto"}');
    expect(decodeBody(raw, undefined)).toEqual(raw);
    expect(decodeBody(raw, "")).toEqual(raw);
    expect(decodeBody(raw, "identity")).toEqual(raw);
  });

  it("decompresses a zstd body", () => {
    // Codex compresses /v1/responses with zstd; parsing those bytes directly is
    // what produced "Invalid JSON body".
    const json = '{"model":"jevonian/auto","input":"hi"}';
    expect(decode(decodeBody(zstdCompressSync(encode(json)), "zstd"))).toBe(json);
  });

  it("accepts zstd regardless of header casing", () => {
    const json = '{"a":1}';
    const compressed = zstdCompressSync(encode(json));
    expect(decode(decodeBody(compressed, "ZSTD"))).toBe(json);
    expect(decode(decodeBody(compressed, " zstd "))).toBe(json);
  });

  it("decompresses the other encodings a client may negotiate", () => {
    const json = '{"model":"m"}';
    expect(decode(decodeBody(gzipSync(encode(json)), "gzip"))).toBe(json);
    expect(decode(decodeBody(brotliCompressSync(encode(json)), "br"))).toBe(json);
  });

  it("applies multiple encodings in reverse order", () => {
    // RFC 9110: Content-Encoding lists encodings in the order they were
    // applied, so "gzip, zstd" means the sender gzipped first, then zstd'd.
    // Decoding therefore has to undo them last-to-first.
    const json = '{"model":"m"}';
    const doubly = zstdCompressSync(gzipSync(encode(json)));
    expect(decode(decodeBody(doubly, "gzip, zstd"))).toBe(json);
  });

  it("rejects an encoding it cannot decode instead of returning garbage", () => {
    // Silently returning compressed bytes would surface as a confusing JSON
    // parse failure much later in the request.
    expect(() => decodeBody(encode("{}"), "snappy")).toThrow(/unsupported content-encoding/);
  });

  it("surfaces a corrupt body as a thrown error", () => {
    expect(() => decodeBody(encode("not zstd at all"), "zstd")).toThrow();
  });

  it("rejects a decoded body that exceeds the cap", () => {
    // A zip bomb must be caught even though the compressed input is tiny.
    const huge = encode("a".repeat(MAX_BODY_BYTES + 1));
    const compressed = zstdCompressSync(huge);
    expect(compressed.byteLength).toBeLessThan(1024 * 1024);
    expect(() => decodeBody(compressed, "zstd")).toThrow(/exceeds/);
  });
});
