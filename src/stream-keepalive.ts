/**
 * Keeps a streamed SSE response alive while the upstream is silent.
 *
 * Claude's thinking phase can produce no client-facing bytes for well over a
 * minute when `thinking_delta` is dropped by a wire bridge. Idle proxies and
 * agent clients then cancel the connection. An SSE comment (`: …`) is ignored
 * by parsers but resets those idle timers.
 *
 * The same transform also notices a client disconnect: Node's TransformStream
 * `cancel` runs when the readable side is canceled (hono does this on socket
 * close) and does not run on a clean `flush`. That is how canceled turns get
 * a ledger row instead of vanishing.
 */

const KEEPALIVE = new TextEncoder().encode(": keepalive\n\n");

/** Default silence before a keepalive comment is written. */
export const STREAM_KEEPALIVE_MS = 15_000;

export interface StreamKeepaliveOptions {
  /** Milliseconds of silence before emitting a keepalive. Defaults to 15s. */
  intervalMs?: number;
  /**
   * Called when the client abandons the stream before it finishes. Upstream
   * failures (cancel with an Error) do not invoke this — only a client-side
   * disconnect (cancel with no reason / AbortError).
   */
  onClientCancel?: () => void;
}

/** True when a TransformStream `cancel` reason looks like a client disconnect. */
export function isClientCancelReason(reason: unknown): boolean {
  if (reason === undefined || reason === null) return true;
  if (typeof reason === "object" && reason !== null && "name" in reason) {
    return (reason as { name: string }).name === "AbortError";
  }
  return false;
}

/**
 * Wraps an SSE body so idle periods still emit traffic, and so a client
 * disconnect can be observed. Returns `null` when `stream` is null.
 */
export function streamWithKeepalive(
  stream: ReadableStream<Uint8Array> | null,
  options: StreamKeepaliveOptions = {},
): ReadableStream<Uint8Array> | null {
  if (!stream) return null;
  const intervalMs = options.intervalMs ?? STREAM_KEEPALIVE_MS;
  let timer: ReturnType<typeof setInterval> | undefined;
  let settled = false;

  const clear = (): void => {
    if (timer === undefined) return;
    clearInterval(timer);
    timer = undefined;
  };

  const arm = (controller: TransformStreamDefaultController<Uint8Array>): void => {
    clear();
    timer = setInterval(() => {
      try {
        controller.enqueue(KEEPALIVE);
      } catch {
        clear();
      }
    }, intervalMs);
    // Do not keep the process alive solely for keepalives.
    timer.unref?.();
  };

  const transform = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      arm(controller);
    },
    transform(chunk, controller) {
      controller.enqueue(chunk);
      arm(controller);
    },
    flush() {
      settled = true;
      clear();
    },
    cancel(reason) {
      clear();
      if (settled) return;
      settled = true;
      if (!isClientCancelReason(reason)) return;
      options.onClientCancel?.();
    },
  });

  return stream.pipeThrough(transform);
}
