import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";

/**
 * Upper bound for a decoded request body. Codex bodies are large (full
 * transcripts plus tool schemas), but a decompression bomb must not be able to
 * exhaust memory, so the decoded size is checked rather than trusted.
 */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Decodes a request body according to its `Content-Encoding`.
 *
 * Codex compresses the `/v1/responses` body with zstd and labels it with
 * `Content-Encoding: zstd`. Parsing those bytes as JSON directly fails with
 * "Invalid JSON body", so the encoding has to be honoured first — this is what
 * Ollama's Codex proxy does before reading the model and routing decision.
 *
 * Encodings are applied in reverse order because the last one listed was
 * applied last by the sender.
 */
export function decodeBody(raw: Uint8Array, contentEncoding: string | undefined): Uint8Array {
  const encodings = (contentEncoding ?? "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0 && part !== "identity");

  if (encodings.length === 0) return checkSize(raw);

  let decoded = raw;
  for (const encoding of [...encodings].reverse()) {
    switch (encoding) {
      case "zstd":
        decoded = zstdDecompressSync(decoded);
        break;
      case "gzip":
      case "x-gzip":
        decoded = gunzipSync(decoded);
        break;
      case "deflate":
        decoded = inflateSync(decoded);
        break;
      case "br":
        decoded = brotliDecompressSync(decoded);
        break;
      default:
        throw new Error(`unsupported content-encoding: ${encoding}`);
    }
    checkSize(decoded);
  }
  return decoded;
}

function checkSize(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength > MAX_BODY_BYTES) {
    throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return bytes;
}
