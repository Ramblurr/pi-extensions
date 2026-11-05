import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PiSpeakSettings } from "./settings.js";
import { STATUS_WIDGET_KEY } from "./shortcut-core.js";
import type { SynthesisService } from "./synthesis-service.js";
import type { AudioQueue } from "./audio.js";

const MIN_SPEED = 0.5;
const MAX_SPEED = 3.0;

type SpeakToolOptions = {
  getSettings: () => Promise<PiSpeakSettings>;
  getService: () => Promise<SynthesisService>;
  getAudioQueue: () => Promise<AudioQueue>;
};

export type SpeakToolController = {
  shutdown(): Promise<void>;
};

export function registerSpeakTool(
  pi: ExtensionAPI,
  options: SpeakToolOptions,
): SpeakToolController {
  let shuttingDown = false;
  const operations = new Set<Promise<unknown>>();
  const shutdownController = new AbortController();

  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      operations.delete(tracked);
    });
    operations.add(tracked);
    return tracked;
  }

  pi.registerTool({
    name: "speak",
    label: "Speak",
    description: "Convert text to speech via local Kokoro TTS and play audio",
    promptSnippet: "Speak text aloud with local Kokoro TTS",
    promptGuidelines: [
      "Use speak when the user wants to hear text spoken aloud.",
      "speak queues synthesis and playback; multiple calls play serially.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Text to speak" }),
      voice: Type.Optional(Type.String({ description: "Voice id, defaults to configured" })),
      speed: Type.Optional(
        Type.Number({ description: "Speed 0.5-3.0", minimum: MIN_SPEED, maximum: MAX_SPEED }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
      if (shuttingDown) throw new Error("pi-speak is shutting down");
      const operationSignal = signal
        ? AbortSignal.any([signal, shutdownController.signal])
        : shutdownController.signal;

      return track(
        (async () => {
          operationSignal.throwIfAborted();
          const rawText = params.text?.trim();
          if (!rawText) throw new Error("Missing or empty 'text' field");
          const { cleanTextForSpeech } = await import("./text.js");
          const cleanedPreview = cleanTextForSpeech(rawText);
          if (!cleanedPreview) throw new Error("Missing or empty 'text' field");

          const configured = await options.getSettings();
          const voice = params.voice ?? configured.voice;
          const speed = params.speed ?? configured.speed;

          if (speed < MIN_SPEED || speed > MAX_SPEED) {
            throw new Error(`Speed must be between ${MIN_SPEED} and ${MAX_SPEED}`);
          }

          const effectiveSettings: PiSpeakSettings = { ...configured, voice, speed };

          const hasUI = ctx.hasUI;
          if (hasUI) {
            ctx.ui.setWidget(STATUS_WIDGET_KEY, [
              ctx.ui.theme.fg("muted", "Synthesizing…"),
            ]);
          }

          let wavBuffer: Buffer;
          try {
            const service = await options.getService();
            wavBuffer = await service.synthesize(effectiveSettings, cleanedPreview, operationSignal);
            operationSignal.throwIfAborted();
          } finally {
            if (hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
          }

          const directory = await mkdtemp(join(tmpdir(), "pi-speak-"));
          const outPath = join(directory, `speak-${process.pid}-${Date.now()}.wav`);
          await writeFile(outPath, wavBuffer);

          const audioQueue = await options.getAudioQueue();
          const { playWav } = await import("./audio.js");
          audioQueue.enqueue({
            play: async () => {
              try {
                await playWav(outPath);
              } finally {
                await unlink(outPath).catch(() => undefined);
                await rm(directory, { recursive: true, force: true }).catch(() => undefined);
              }
            },
          });

          const preview = rawText.length > 80 ? `${rawText.slice(0, 80)}…` : rawText;
          return {
            content: [
              { type: "text" as const, text: `Speaking: "${preview}" (voice ${voice}, speed ${speed})` },
            ],
            details: { voice, speed, textLength: rawText.length },
          };
        })(),
      );
    },
  });

  return {
    async shutdown() {
      shuttingDown = true;
      shutdownController.abort(new Error("pi-speak is shutting down"));
      await Promise.allSettled([...operations]);
    },
  };
}
