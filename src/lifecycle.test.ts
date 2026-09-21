import { Hono } from "hono";
import { expect, it } from "vite-plus/test";

import { ServerLifecycle } from "./lifecycle";

it("rejects new requests while draining and waits for active work", async () => {
  const lifecycle = new ServerLifecycle();
  const release = lifecycle.beginRequest();
  let restarted = false;

  const restart = lifecycle.restartAfterDrain(async () => {
    restarted = true;
  });
  expect(lifecycle.draining).toBe(true);
  await Promise.resolve();
  expect(restarted).toBe(false);

  release();
  await restart;
  expect(restarted).toBe(true);
});

it("starts a restart immediately when no requests are active", async () => {
  const lifecycle = new ServerLifecycle();
  let restarted = false;
  await lifecycle.restartAfterDrain(() => {
    restarted = true;
  });
  expect(restarted).toBe(true);
});

it("only releases a request once when a response is consumed or cancelled", async () => {
  const lifecycle = new ServerLifecycle();
  const release = lifecycle.beginRequest();
  const tracked = lifecycle.trackResponse(new Response("ok"), release);
  expect(tracked.status).toBe(200);
  await tracked.text();
  release();
  let restarted = false;
  await lifecycle.restartAfterDrain(() => {
    restarted = true;
  });
  expect(restarted).toBe(true);
});

it("assigns tracked bodies onto c.res so @hono/node-server can getReader", async () => {
  // Regression: returning trackResponse() after next() is ignored once Hono has
  // finalized c.res, but getReader() already locked the original body — the
  // public tunnel then threw ERR_INVALID_STATE: ReadableStream is locked.
  const lifecycle = new ServerLifecycle();
  const app = new Hono();
  app.use("*", async (c, next) => {
    const release = lifecycle.beginRequest();
    try {
      await next();
      c.res = lifecycle.trackResponse(c.res, release);
    } catch (error) {
      release();
      throw error;
    }
  });
  app.get("/hi", () => new Response("hello-from-tunnel"));
  const response = await app.request("/hi");
  expect(response.body?.locked).toBe(false);
  const reader = response.body!.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe("hello-from-tunnel");
});
