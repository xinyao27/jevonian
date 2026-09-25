import { describe, expect, it } from "vite-plus/test";

import { isClientCancelReason, streamWithKeepalive } from "./stream-keepalive";

describe("isClientCancelReason", () => {
  it("treats an empty cancel as a client disconnect", () => {
    expect(isClientCancelReason(undefined)).toBe(true);
    expect(isClientCancelReason(null)).toBe(true);
  });

  it("treats AbortError as a client disconnect", () => {
    expect(isClientCancelReason(new DOMException("Aborted", "AbortError"))).toBe(true);
    expect(isClientCancelReason(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe(
      true,
    );
  });

  it("ignores upstream failures passed as cancel reasons", () => {
    expect(isClientCancelReason(new Error("upstream boom"))).toBe(false);
    expect(isClientCancelReason("socket reset")).toBe(false);
  });
});

describe("streamWithKeepalive", () => {
  it("returns null for a null body", () => {
    expect(streamWithKeepalive(null)).toBeNull();
  });

  it("forwards chunks and emits a keepalive after silence", async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
      },
    });
    const stream = streamWithKeepalive(source, { intervalMs: 20 });
    expect(stream).not.toBeNull();
    const reader = stream!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("data: hi\n\n");
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe(": keepalive\n\n");
    await reader.cancel();
  });

  it("calls onClientCancel when the readable is canceled mid-stream", async () => {
    let canceled = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
      },
    });
    const stream = streamWithKeepalive(source, {
      intervalMs: 60_000,
      onClientCancel: () => {
        canceled += 1;
      },
    });
    const reader = stream!.getReader();
    await reader.read();
    await reader.cancel();
    expect(canceled).toBe(1);
  });

  it("does not call onClientCancel after a clean flush", async () => {
    let canceled = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        controller.close();
      },
    });
    const stream = streamWithKeepalive(source, {
      intervalMs: 60_000,
      onClientCancel: () => {
        canceled += 1;
      },
    });
    const reader = stream!.getReader();
    await reader.read();
    await reader.read();
    expect(canceled).toBe(0);
  });

  it("does not call onClientCancel when cancel carries an upstream Error", async () => {
    let canceled = 0;
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
        setTimeout(() => controller.error(new Error("upstream boom")), 5);
      },
    });
    const stream = streamWithKeepalive(source, {
      intervalMs: 60_000,
      onClientCancel: () => {
        canceled += 1;
      },
    });
    const reader = stream!.getReader();
    await reader.read();
    await expect(reader.read()).rejects.toThrow(/upstream boom/);
    expect(canceled).toBe(0);
  });
});
