import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PiSpeakRuntime } from "./runtime.js";
import type { SpeechRequest } from "./speech-provider.js";

type SpeakToolOptions = { getRuntime: () => Promise<PiSpeakRuntime> };
export type SpeakToolController = { refresh(): Promise<void>; shutdown(): Promise<void> };

export function registerSpeakTool(pi: ExtensionAPI, options: SpeakToolOptions): SpeakToolController {
  let shuttingDown = false;

  async function refresh(): Promise<void> {
    const runtime = await options.getRuntime();
    const configuration = await runtime.getConfiguration();
    const { describeProvider } = await import("./speech-providers.js");
    const description = describeProvider(configuration);
    pi.registerTool({
      name: "speak", label: "Speak", description: description.description,
      promptSnippet: description.description,
      promptGuidelines: ["Use speak when the user wants to hear text aloud.", ...description.guidelines],
      parameters: description.parameters,
      async execute(_id, parameters, signal, _update, ctx) {
        if (shuttingDown) throw new Error("pi-speak is shutting down");
        await runtime.speak(parameters as SpeechRequest, ctx, signal);
        return { content: [{ type: "text", text: "Speech playback completed." }], details: { provider: configuration?.provider ?? "kokoro" } };
      },
    });
  }

  pi.registerTool({
    name: "speech_options", label: "Speech options",
    description: "Inspect the selected speech provider's controls and defaults. Supply query to search voices; use nextPage to continue results.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Search voices; empty string lists voices" })),
      nextPage: Type.Optional(Type.String({ description: "Voice page token from a previous result; retain the same query" })),
    }, { additionalProperties: false }),
    async execute(_id, parameters, signal) {
      if (shuttingDown) throw new Error("pi-speak is shutting down");
      const configuration = await (await options.getRuntime()).getConfiguration();
      const { describeProvider, searchProviderVoices } = await import("./speech-providers.js");
      const description = describeProvider(configuration);
      const result = {
        provider: configuration?.provider ?? "kokoro",
        defaults: configuration?.provider === "elevenlabs" ? {
          model: configuration.providers.elevenlabs?.model, voice: configuration.providers.elevenlabs?.voice,
          stability: configuration.providers.elevenlabs?.stability, similarity: configuration.providers.elevenlabs?.similarity,
        } :
          configuration?.providers.kokoro ? {
            model: configuration.providers.kokoro.model.id,
            voice: configuration.providers.kokoro.voice, speed: configuration.providers.kokoro.speed,
          } : undefined,
        delivery: configuration?.provider === "elevenlabs" ? "streaming" : "buffered",
        parameters: description.parameters,
        guidance: description.guidelines,
        ...(configuration && (parameters.query !== undefined || parameters.nextPage !== undefined)
          ? await searchProviderVoices(configuration, parameters.query, parameters.nextPage, signal) : {}),
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });

  return { refresh, async shutdown() { shuttingDown = true; } };
}
