import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SpeechConfiguration } from "./configuration.js";
import type { ElevenLabsConfig, SpeechAudio, SpeechProvider, SpeechRequest } from "./speech-provider.js";
import type { SynthesisService } from "./synthesis-service.js";
import { SpeechQueue } from "./speech-queue.js";
import { createSpeechProvider, requireProviderConfiguration } from "./speech-providers.js";
import { STATUS_WIDGET_KEY } from "./shortcut-core.js";
import { DEFAULT_PREPROCESSING_PROMPT, extractTextContent } from "./text.js";

export type PiSpeakRuntime = {
  getConfiguration(): Promise<SpeechConfiguration | undefined>;
  speak(request: SpeechRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<void>;
  showSettings(ctx: ExtensionCommandContext): Promise<void>;
  speakLastMessage(ctx: ExtensionContext): Promise<void>;
  replayOnboarding(ctx: ExtensionCommandContext): Promise<void>;
  stop(): Promise<void>;
  shutdown(ctx: ExtensionContext): Promise<void>;
};

export type PiSpeakRuntimeOptions = {
  synthesisService?: SynthesisService;
  createProvider?: (configuration: SpeechConfiguration) => Promise<SpeechProvider>;
  playAudio?: (audio: SpeechAudio, signal?: AbortSignal) => Promise<void>;
  onConfigurationChanged?: () => Promise<void>;
  generatePreprocessedText?: (raw: string, prompt: string, model: unknown, ctx: ExtensionContext) => Promise<string | null>;
};

export function createPiSpeakRuntime(pi: ExtensionAPI, options: PiSpeakRuntimeOptions = {}): PiSpeakRuntime {
  const queue = new SpeechQueue();
  let operation: Promise<void> | undefined;

  async function getConfiguration(): Promise<SpeechConfiguration | undefined> {
    const { readConfiguration } = await import("./configuration.js");
    const result = await readConfiguration();
    if (result.warning) throw new Error(result.warning);
    return result.configuration;
  }

  function runExclusive(ctx: ExtensionContext, task: () => Promise<void>): Promise<void> {
    if (operation) {
      if (ctx.hasUI) ctx.ui.notify("A pi-speak operation is already in progress", "warning");
      return operation;
    }
    const next = task().finally(() => { if (operation === next) operation = undefined; });
    operation = next;
    return next;
  }

  async function play(configuration: SpeechConfiguration, request: SpeechRequest, ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const provider = options.createProvider
      ? await options.createProvider(configuration)
      : await createSpeechProvider(configuration, options.synthesisService);
    try {
      const audio = await provider.synthesize(request, signal);
      signal.throwIfAborted();
      if (ctx.hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, [ctx.ui.theme.fg("muted", "Speaking… /speak-stop to stop")]);
      const playAudio = options.playAudio ?? (await import("./playback.js")).playSpeechAudio;
      await playAudio(audio, signal);
    } finally {
      await provider.dispose();
    }
  }

  async function withStatus(ctx: ExtensionContext, task: () => Promise<void>): Promise<void> {
    if (ctx.hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, [ctx.ui.theme.fg("muted", "Synthesizing… /speak-stop to stop")]);
    try { await task(); }
    finally { if (ctx.hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined); }
  }

  async function speak(request: SpeechRequest, ctx: ExtensionContext, signal?: AbortSignal): Promise<void> {
    const configuration = requireProviderConfiguration(await getConfiguration());
    await queue.enqueue((jobSignal) => withStatus(ctx, () => play(configuration, request, ctx, jobSignal)), signal);
  }

  async function showSettings(ctx: ExtensionCommandContext): Promise<void> {
    await runExclusive(ctx, async () => {
      const configuration = await getConfiguration();
      const { showProviderSettings } = await import("./provider-menu.js");
      await showProviderSettings(pi, ctx, configuration, (cloud: ElevenLabsConfig, voice: string, signal: AbortSignal) => {
        const previewConfiguration: SpeechConfiguration = {
          version: 2, provider: "elevenlabs", providers: { elevenlabs: { ...cloud, voice } },
        };
        return queue.enqueue((jobSignal) => withStatus(ctx, () => play(previewConfiguration,
          { text: "The quick brown fox jumps over the lazy dog." }, ctx, jobSignal)), signal);
      });
      await options.onConfigurationChanged?.();
    });
  }

  async function speakLastMessage(ctx: ExtensionContext): Promise<void> {
    return runExclusive(ctx, async () => {
      try {
        const configuration = requireProviderConfiguration(await getConfiguration());
        let raw: string | undefined;
        const branch = ctx.sessionManager.getBranch();
        for (let index = branch.length - 1; index >= 0; index--) {
          const entry = branch[index] as unknown as { type: string; message?: { role?: string; content?: unknown[] } };
          if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
          const text = extractTextContent(entry.message.content);
          if (text.trim()) { raw = text; break; }
        }
        if (!raw) { if (ctx.hasUI) ctx.ui.notify("No agent message to speak", "warning"); return; }
        const input = raw;
        await queue.enqueue((signal) => withStatus(ctx, async () => {
          let text = input;
          if (configuration.preprocessingEnabled) {
            const selected = configuration.preprocessingModel;
            if (!selected) throw new Error("Preprocessing is enabled but no model is configured. Use /speak to select one.");
            const model = ctx.modelRegistry.find(selected.provider, selected.id);
            if (!model) throw new Error(`Preprocessing model not found: ${selected.provider}/${selected.id}`);
            const generate = options.generatePreprocessedText ?? (await import("./preprocessing.js")).generatePreprocessedText;
            let summary: string | null;
            try {
              summary = await generate(input, configuration.preprocessingPrompt?.trim() || DEFAULT_PREPROCESSING_PROMPT, model, { ...ctx, signal });
            } catch (error) {
              signal.throwIfAborted();
              throw new Error(`Preprocessing failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            signal.throwIfAborted();
            if (!summary?.trim()) throw new Error("Preprocessing failed: LLM returned empty response");
            text = summary.trim();
          }
          if (ctx.hasUI) ctx.ui.notify(`Speaking last message (${text.length} chars)`, "info");
          await play(configuration, { text }, ctx, signal);
        }));
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    });
  }

  async function shutdown(ctx: ExtensionContext): Promise<void> {
    await queue.shutdown();
    await operation?.catch(() => undefined);
    if (ctx.hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
  }

  return { getConfiguration, speak, showSettings, speakLastMessage,
    replayOnboarding: showSettings, stop: () => queue.stop(), shutdown };
}
