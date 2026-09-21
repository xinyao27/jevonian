/**
 * Coordinates a restart with in-flight responses.
 *
 * Node's HTTP server can stop accepting new sockets immediately, but Jevonian's
 * streaming responses may still be writing. This lifecycle keeps one shared
 * draining flag and an active-response count so the supervisor can wait for
 * natural completion rather than killing a model turn mid-stream.
 */
export class ServerLifecycle {
  private active = 0;
  private isDraining = false;
  private idleWaiters = new Set<() => void>();

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
      release();
    };
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

  async restartAfterDrain(restart: () => void | Promise<void>): Promise<void> {
    this.beginDraining();
    await this.whenIdle();
    await restart();
  }

  private whenIdle(): Promise<void> {
    if (this.active === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
}
