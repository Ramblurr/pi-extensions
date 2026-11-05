import { existsSync } from "node:fs";
import type { SpeechConfiguration } from "./configuration.js";
import { elevenLabsDescription, kokoroDescription, validateSpeechRequest } from "./provider-descriptions.js";
import type { SpeechProvider, SpeechToolDescription, VoicePage } from "./speech-provider.js";
import type { SynthesisService } from "./synthesis-service.js";

export function providerDefaults(configuration?: SpeechConfiguration) {
  if (configuration?.provider === "elevenlabs") {
    const cloud = configuration.providers.elevenlabs;
    return cloud ? { model: cloud.model, voice: cloud.voice, stability: cloud.stability, similarity: cloud.similarity } : undefined;
  }
  const local = configuration?.providers.kokoro;
  return local ? { model: local.model.id, voice: local.voice, speed: local.speed } : undefined;
}

export function describeProvider(configuration?: SpeechConfiguration): SpeechToolDescription {
  const cloud = configuration?.provider === "elevenlabs";
  const base = cloud ? elevenLabsDescription : kokoroDescription;
  const defaults = providerDefaults(configuration);
  return {
    ...base,
    description: base.description + (defaults ? ` Configured defaults: ${JSON.stringify(defaults)}.` : " Run /speak to configure speech."),
  };
}

export function requireProviderConfiguration(configuration?: SpeechConfiguration): SpeechConfiguration {
  if (!configuration) throw new Error("pi-speak is not configured. Run /speak in Pi's interactive TUI first.");
  if (configuration.provider === "kokoro") {
    const settings = configuration.providers.kokoro;
    if (!settings || !existsSync(settings.model.path)) {
      throw new Error("The configured speech model is missing. Run /speak and choose a local model again.");
    }
  } else {
    if (!configuration.providers.elevenlabs) throw new Error("Run /speak to configure ElevenLabs.");
  }
  return configuration;
}

export async function createSpeechProvider(
  configuration: SpeechConfiguration, localService?: SynthesisService,
): Promise<SpeechProvider> {
  if (configuration.provider === "elevenlabs") {
    const { ElevenLabsProvider } = await import("./elevenlabs.js");
    return new ElevenLabsProvider(configuration.providers.elevenlabs!);
  }
  const settings = configuration.providers.kokoro!;
  const service = localService ?? new (await import("./synthesis-service.js")).SynthesisService();
  return {
    async synthesize(request, signal) {
      validateSpeechRequest(kokoroDescription, request);
      const wav = await service.synthesize({ ...settings,
        voice: request.voice ?? settings.voice, speed: request.speed ?? settings.speed }, request.text, signal);
      return { kind: "buffered", wav };
    },
    dispose: () => service.shutdown(),
  };
}

export async function searchProviderVoices(
  configuration: SpeechConfiguration, query = "", nextPage?: string, signal?: AbortSignal,
): Promise<VoicePage> {
  if (configuration.provider === "elevenlabs") {
    const { resolveElevenLabsKey } = await import("./credentials.js");
    return (await import("./elevenlabs.js")).searchElevenLabsVoices(query, nextPage, signal, {
      apiKey: () => resolveElevenLabsKey(configuration.providers.elevenlabs!, signal),
    });
  }
  const { getCatalogVoices } = await import("./catalog.js");
  const { voiceHint } = await import("./text.js");
  const voices = getCatalogVoices().map((id) => ({ id, name: id, description: voiceHint(id) }))
    .filter((voice) => `${voice.id} ${voice.description}`.toLowerCase().includes(query.toLowerCase()));
  const offset = nextPage === undefined ? 0 : Number(nextPage);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid voice page token");
  return { voices: voices.slice(offset, offset + 20), ...(offset + 20 < voices.length ? { nextPage: String(offset + 20) } : {}) };
}
