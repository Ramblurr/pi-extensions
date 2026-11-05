import { existsSync, rmSync } from "node:fs";

export type SynthesisOptions = {
  voice: string;
  speed: number;
  signal?: AbortSignal;
};

export type SynthesisResult = {
  audio: Float32Array;
  sampling_rate: number;
};

/** In-process Kokoro backend, mirrors pi-transcribe TranscribeCppBackend. */
export class KokoroBackend {
  private tts: { generate: (text: string, opts: { voice: string; speed: number }) => Promise<SynthesisResult>; model: { dispose: () => Promise<void> | void } } | undefined;
  private loading: Promise<unknown> | undefined;
  private disposed = false;

  constructor(private readonly modelPath: string) {}

  async prepare(): Promise<void> {
    if (this.tts) return;
    if (this.disposed) throw new Error("Synthesis backend has been disposed");

    if (!this.loading) {
      this.loading = (async () => {
        const { KokoroTTS } = await import("kokoro-js");
        const { env } = await import("@huggingface/transformers");
        // Allow local models and keep default cache dir (HF hub cache is shared via HF_HUB_CACHE).
        env.allowLocalModels = true;
        try {
          const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
            dtype: "q4",
            device: "cpu",
          });
          if (this.disposed) {
            await tts.model.dispose();
            throw new Error("Synthesis backend was disposed while loading");
          }
          this.tts = tts as unknown as typeof this.tts;
          return tts;
        } catch (error) {
          try {
            if (existsSync(this.modelPath)) rmSync(this.modelPath, { force: true });
          } catch {}
          throw error;
        }
      })();
    }

    try {
      await this.loading;
    } finally {
      this.loading = undefined;
    }
  }

  async synthesize(text: string, options: SynthesisOptions): Promise<Float32Array> {
    options.signal?.throwIfAborted();
    await this.prepare();
    const tts = this.tts;
    if (!tts) throw new Error("Synthesis backend is not prepared");
    options.signal?.throwIfAborted();
    const result = await tts.generate(text, {
      voice: options.voice,
      speed: options.speed,
    });
    options.signal?.throwIfAborted();
    return result.audio as Float32Array;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.loading?.catch(() => undefined);
    const tts = this.tts;
    this.tts = undefined;
    if (tts) {
      try {
        await tts.model.dispose();
      } catch {}
    }
    if (typeof global.gc === "function") global.gc();
  }
}
