import { cleanTextForSpeech } from "./text.js";
import type { PiSpeakSettings } from "./settings.js";
import { KokoroBackend } from "./synthesis.js";

type SynthesisJob = {
  settings: PiSpeakSettings;
  text: string;
  signal?: AbortSignal;
  resolve: (value: Buffer) => void;
  reject: (error: unknown) => void;
  started: boolean;
  settled: boolean;
  removeAbortListener?: () => void;
};

type ReusableBackend = Pick<KokoroBackend, "prepare" | "synthesize" | "dispose">;

type BackendFactory = (modelPath: string) => ReusableBackend | Promise<ReusableBackend>;

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error("Synthesis cancelled");
}

export function float32ToWav(samples: Float32Array, sampleRate: number): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = samples.length * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buffer.writeInt16LE(Math.round(s * 0x7fff), offset);
    offset += 2;
  }

  return buffer;
}

/** Single-queue synthesis service, trimmed TranscriptionService. */
export class SynthesisService {
  private backend: ReusableBackend | undefined;
  private modelPath: string | undefined;
  private readonly queue: SynthesisJob[] = [];
  private loop: Promise<void> | undefined;
  private shuttingDown = false;
  private readonly shutdownController = new AbortController();

  constructor(
    private readonly createBackend: BackendFactory = async (modelPath) => {
      return new KokoroBackend(modelPath);
    },
  ) {}

  synthesize(
    settings: PiSpeakSettings,
    text: string,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    if (this.shuttingDown) return Promise.reject(new Error("pi-speak is shutting down"));
    if (signal?.aborted) return Promise.reject(abortError(signal));

    const result = new Promise<Buffer>((resolve, reject) => {
      const job: SynthesisJob = {
        settings,
        text,
        signal,
        resolve,
        reject,
        started: false,
        settled: false,
      };
      if (signal) {
        const onAbort = (): void => {
          if (job.started || job.settled) return;
          const index = this.queue.indexOf(job);
          if (index >= 0) this.queue.splice(index, 1);
          this.settleJob(job, () => reject(abortError(signal)));
          this.schedule();
        };
        signal.addEventListener("abort", onAbort, { once: true });
        job.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      }
      this.queue.push(job);
    });
    this.schedule();
    return result;
  }

  private settleJob(job: SynthesisJob, settle: () => void): void {
    if (job.settled) return;
    job.settled = true;
    job.removeAbortListener?.();
    settle();
  }

  private withShutdown(signal?: AbortSignal): AbortSignal {
    return signal
      ? AbortSignal.any([signal, this.shutdownController.signal])
      : this.shutdownController.signal;
  }

  private schedule(): void {
    if (this.loop) return;
    const loop = this.process().finally(() => {
      if (this.loop === loop) this.loop = undefined;
      if (this.hasRunnableWork()) this.schedule();
    });
    this.loop = loop;
  }

  private hasRunnableWork(): boolean {
    if (this.shuttingDown) return false;
    return this.queue.length > 0;
  }

  private async process(): Promise<void> {
    while (!this.shuttingDown) {
      const job = this.queue.shift();
      if (job) {
        await this.runJob(job);
        continue;
      }
      await this.unloadModel().catch(() => undefined);
      return;
    }
  }

  private async runJob(job: SynthesisJob): Promise<void> {
    if (job.settled) return;
    job.started = true;
    const signal = this.withShutdown(job.signal);

    try {
      signal.throwIfAborted();
      const backend = await this.ensureModel(job.settings.model.path);
      const cleaned = cleanTextForSpeech(job.text);
      if (!cleaned) throw new Error("Missing or empty 'text' field");
      signal.throwIfAborted();
      const samples = await backend.synthesize(cleaned, {
        voice: job.settings.voice,
        speed: job.settings.speed,
        signal,
      });
      signal.throwIfAborted();
      const wav = float32ToWav(samples, 24000);
      this.settleJob(job, () => job.resolve(wav));
    } catch (error) {
      this.settleJob(job, () => job.reject(error));
    }
  }

  private async ensureModel(modelPath: string): Promise<ReusableBackend> {
    if (this.backend && this.modelPath === modelPath) {
      await this.backend.prepare();
      return this.backend;
    }

    await this.unloadModel();
    const backend = await this.createBackend(modelPath);
    this.backend = backend;
    this.modelPath = modelPath;
    try {
      await backend.prepare();
      return backend;
    } catch (error) {
      if (this.backend === backend) {
        this.backend = undefined;
        this.modelPath = undefined;
      }
      await backend.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async unloadModel(): Promise<void> {
    const backend = this.backend;
    if (!backend) return;
    this.backend = undefined;
    this.modelPath = undefined;
    await backend.dispose();
  }

  async shutdown(): Promise<void> {
    if (!this.shuttingDown) {
      this.shuttingDown = true;
      this.shutdownController.abort(new Error("pi-speak is shutting down"));
      const shutdownError = new Error("pi-speak is shutting down");
      for (const job of this.queue) {
        this.settleJob(job, () => job.reject(shutdownError));
      }
      this.queue.length = 0;
    }

    await this.loop?.catch(() => undefined);
    await this.unloadModel().catch(() => undefined);
  }
}
