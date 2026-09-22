/**
 * Coordinates a restart with in-flight responses.
 *
 * Node's HTTP server can stop accepting new sockets immediately, but Jevonian's
 * streaming responses may still be writing. This lifecycle keeps one shared
 * draining flag and an active-response count so the supervisor can wait for
 * natural completion rather than killing a model turn mid-stream.
 *
 * A hung stream (abandoned client, stuck upstream) must not block the update
 * forever: after {@link DEFAULT_DRAIN_TIMEOUT_MS}, remaining work is cancelled
 * and restart proceeds.
 */

/** How long an update restart waits for in-flight responses before forcing exit. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

export type RestartAfterDrainOptions = {
  /** Override {@link DEFAULT_DRAIN_TIMEOUT_MS}. Prefer short values in tests. */
  timeoutMs?: number;
};

export class ServerLifecycle {
  private active = 0;
  private isDraining = false;
  private idleWaiters = new Set<() => void>();
  private trackedCancels = new Set<() => void>();

  get draining(): boolean {
    return this.isDraining;
  }

  get activeRequests(): number {
    return this.active;
  }

  beginDraining(): void {
    this.isDraining = true;
  }

  resume(): void {
    this.isDraining = false;
  }

  beginRequest(): () => void {
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active = Math.max(0, this.active - 1);
      if (this.active === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    };
  }

  trackResponse(response: Response, release: () => void): Response {
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    let finished = false;
    const done = (): void => {
      if (finished) return;
      finished = true;
      this.trackedCancels.delete(cancel);
      release();
    };
    const cancel = (): void => {
      done();
      void reader.cancel("draining for restart").catch(() => {});
    };
    this.trackedCancels.add(cancel);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await reader.read();
          if (result.done) {
            done();
            controller.close();
          } else {
            controller.enqueue(result.value);
          }
        } catch (error) {
          done();
          controller.error(error);
        }
      },
      async cancel(reason) {
        done();
        await reader.cancel(reason).catch(() => {});
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  /**
   * Stop accepting new work, wait for active responses (or the timeout), then
   * run `restart`. Timed-out streams are cancelled before `restart` so a hung
   * client cannot leave the process in draining forever.
   */
  async restartAfterDrain(
    restart: () => void | Promise<void>,
    options?: RestartAfterDrainOptions,
  ): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.beginDraining();
    await this.whenIdle(timeoutMs);
    if (this.active > 0) {
      console.warn(
        `restart: ${this.active} request(s) still active after ${timeoutMs}ms drain; forcing restart`,
      );
      this.cancelTracked();
    }
    await restart();
  }

  private cancelTracked(): void {
    for (const cancel of [...this.trackedCancels]) cancel();
    this.trackedCancels.clear();
  }

  private whenIdle(timeoutMs: number): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.idleWaiters.delete(settle);
        resolve();
      };
      const timer = setTimeout(settle, timeoutMs);
      // Drain timeout must not keep the event loop alive on its own.
      timer.unref?.();
      this.idleWaiters.add(settle);
    });
  }
}
