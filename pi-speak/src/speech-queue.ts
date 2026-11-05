type Job = {
  task: (signal: AbortSignal) => Promise<void>;
  controller: AbortController;
  resolve: () => void;
  reject: (error: unknown) => void;
  detach: () => void;
};

function cancelled(): Error {
  return new DOMException("Speech cancelled", "AbortError");
}

/** Serializes synthesis and playback together; tasks must honor their abort signal. */
export class SpeechQueue {
  private pending: Job[] = [];
  private active?: Job;
  private draining?: Promise<void>;
  private closed = false;

  enqueue(task: Job["task"], signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Speech queue is shut down"));
    if (signal?.aborted) return Promise.reject(signal.reason ?? cancelled());
    return new Promise<void>((resolve, reject) => {
      const controller = new AbortController();
      const abort = () => {
        controller.abort(signal?.reason ?? cancelled());
        const index = this.pending.indexOf(job);
        if (index !== -1) {
          this.pending.splice(index, 1);
          job.detach();
          reject(controller.signal.reason);
        }
      };
      const job: Job = {
        task, controller, resolve, reject,
        detach: () => signal?.removeEventListener("abort", abort),
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.pending.push(job);
      if (!this.draining) {
        // Defer entry so draining is assigned even for a synchronously throwing task.
        this.draining = Promise.resolve().then(() => this.drain());
      }
    });
  }

  private async drain(): Promise<void> {
    try {
      let job: Job | undefined;
      while ((job = this.pending.shift())) {
        this.active = job;
        try {
          job.controller.signal.throwIfAborted();
          await job.task(job.controller.signal);
          job.controller.signal.throwIfAborted();
          job.resolve();
        } catch (error) {
          // A failed player must also cancel a provider's outstanding body read.
          job.controller.abort(error);
          job.reject(error);
        } finally {
          job.detach();
          this.active = undefined;
        }
      }
    } finally {
      this.draining = undefined;
    }
  }

  async stop(): Promise<void> {
    const reason = cancelled();
    for (const job of this.pending.splice(0)) {
      job.detach();
      job.reject(reason);
    }
    this.active?.controller.abort(reason);
    await this.draining;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    await this.stop();
  }
}
