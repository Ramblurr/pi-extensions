import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readConfiguration, writeConfiguration, type SpeechConfiguration } from "./configuration.js";
import { searchElevenLabsVoices } from "./elevenlabs.js";
import { runModelSelection, runOnboarding } from "./onboarding.js";
import { stat } from "node:fs/promises";
import { isApiKeySource, resolveElevenLabsKey } from "./credentials.js";
import { choosePreprocessingModel, showSpeakSettings } from "./settings-menu.js";
import type { PiSpeakSettings } from "./settings.js";
import type { ElevenLabsConfig } from "./speech-provider.js";

async function chooseApiKeySource(ctx: ExtensionCommandContext, current = "$ELEVENLABS_API_KEY"): Promise<string | undefined> {
  while (true) {
    const input = await ctx.ui.input("API key source: !command or $ENV (blank uses ELEVENLABS_API_KEY)", current);
    if (input === undefined) return undefined;
    const source = input.trim() || "$ELEVENLABS_API_KEY";
    if (isApiKeySource(source)) return source;
    ctx.ui.notify("Use a !command or environment reference, not a literal API key. The source is saved without executing it.", "error");
  }
}

async function chooseCloudVoice(ctx: ExtensionCommandContext, cloud: ElevenLabsConfig): Promise<string | undefined> {
  const method = await ctx.ui.select("ElevenLabs voice", ["Enter voice ID", "Search account voices"]);
  if (method === "Enter voice ID") {
    const voice = (await ctx.ui.input("ElevenLabs voice ID", cloud.voice))?.trim();
    if (voice === "") ctx.ui.notify("Enter a nonempty voice ID.", "error");
    return voice || undefined;
  }
  if (method !== "Search account voices") return undefined;
  const query = await ctx.ui.input("Search account voices", "Name or description (blank lists voices)");
  if (query === undefined) return undefined;
  let nextPage: string | undefined;
  do {
    const page = await searchElevenLabsVoices(query.trim() || undefined, nextPage, undefined, { apiKey: () => resolveElevenLabsKey(cloud) });
    const labels = page.voices.map((voice) => `${voice.name} · ${voice.id}${voice.description ? ` — ${voice.description}` : ""}`);
    const more = "Next page";
    if (page.nextPage) labels.push(more);
    if (labels.length === 0) {
      ctx.ui.notify("No matching voices. Try another search or enter a voice ID.", "info");
      return undefined;
    }
    const selected = await ctx.ui.select("Account voices", labels);
    if (!selected) return undefined;
    if (selected !== more) return page.voices[labels.indexOf(selected)]?.id;
    nextPage = page.nextPage;
  } while (nextPage);
  return undefined;
}

async function chooseUnitNumber(ctx: ExtensionCommandContext, label: string, current: number): Promise<number | undefined> {
  const input = await ctx.ui.input(`${label} (0–1)`, String(current));
  if (input === undefined) return undefined;
  const number = Number(input);
  if (!input.trim() || !Number.isFinite(number) || number < 0 || number > 1) {
    ctx.ui.notify(`${label} must be a number between 0 and 1.`, "error");
    return undefined;
  }
  return number;
}

export async function showProviderSettings(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  configuration?: SpeechConfiguration,
): Promise<SpeechConfiguration | undefined> {
  if (!ctx.hasUI) return configuration;
  if (!configuration) {
    const read = await readConfiguration();
    if (read.warning) {
      ctx.ui.notify(read.warning, "error");
      return undefined;
    }
    configuration = read.configuration;
  }
  const provider = await ctx.ui.select("Speech provider", ["Kokoro (local)", "ElevenLabs (cloud)"]);
  if (!provider) return configuration;
  const draft: SpeechConfiguration = structuredClone(configuration ?? { version: 2, provider: "kokoro", providers: {} });
  try {
    if (provider === "Kokoro (local)") {
      draft.provider = "kokoro";
      const persist = async (settings: PiSpeakSettings): Promise<void> => {
        const updated: SpeechConfiguration = {
          ...draft,
          providers: { ...draft.providers, kokoro: settings },
          preprocessingEnabled: settings.preprocessingEnabled,
          preprocessingModel: settings.preprocessingModel,
          preprocessingPrompt: settings.preprocessingPrompt,
        };
        for (const key of ["preprocessingEnabled", "preprocessingModel", "preprocessingPrompt"] as const) {
          if (updated[key] === undefined) delete updated[key];
          if (settings[key] === undefined) delete settings[key];
        }
        await writeConfiguration(updated);
        for (const key of ["preprocessingEnabled", "preprocessingModel", "preprocessingPrompt"] as const) delete draft[key];
        Object.assign(draft, updated);
        configuration = structuredClone(draft);
      };
      const saved = draft.providers.kokoro;
      if (!saved) {
        const settings = await runOnboarding(ctx, (settings) => persist({
          ...settings, preprocessingEnabled: draft.preprocessingEnabled,
          preprocessingModel: draft.preprocessingModel, preprocessingPrompt: draft.preprocessingPrompt,
        }));
        if (!settings) return configuration;
      } else {
        const modelExists = await stat(saved.model.path).then((file) => file.isFile()).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return false;
          throw error;
        });
        if (!modelExists) {
          await runModelSelection(ctx, {
            currentModelId: saved.model.id, voice: saved.voice, speed: saved.speed,
            preprocessingEnabled: draft.preprocessingEnabled, preprocessingModel: draft.preprocessingModel,
            preprocessingPrompt: draft.preprocessingPrompt, continueAfterSelection: true, persist,
          });
          return configuration;
        }
        // The envelope is authoritative, even when the legacy copy has stale fields.
        const settings = { ...saved, preprocessingEnabled: draft.preprocessingEnabled,
          preprocessingModel: draft.preprocessingModel, preprocessingPrompt: draft.preprocessingPrompt };
        await persist(settings);
        await showSpeakSettings(pi, ctx, settings, persist);
      }
      return configuration;
    }
    if (provider !== "ElevenLabs (cloud)") return configuration;
    if (configuration?.provider !== "elevenlabs") {
      const consent = await ctx.ui.confirm("Use ElevenLabs cloud speech?", "Spoken text will be sent to ElevenLabs. Synthesis consumes your account quota and may incur charges. Continue?");
      if (!consent) return configuration;
    }
    draft.provider = "elevenlabs";
    let cloud: ElevenLabsConfig | undefined = draft.providers.elevenlabs;
    if (!cloud) {
      const apiKey = await chooseApiKeySource(ctx);
      if (apiKey === undefined) return configuration;
      cloud = { model: "eleven_v4", voice: "", stability: 0.5, similarity: 0.75, apiKey };
      const voice = await chooseCloudVoice(ctx, cloud);
      if (!voice) return configuration;
      cloud.voice = voice;
      draft.providers.elevenlabs = cloud;
    }
    while (true) {
      const apiKeyChoice = `API key source · ${cloud.apiKey ?? "$ELEVENLABS_API_KEY"}`;
      const modelChoice = `Model · ${cloud.model}`;
      const voiceChoice = `Voice · ${cloud.voice}`;
      const stabilityChoice = `Stability · ${cloud.stability}`;
      const similarityChoice = `Similarity · ${cloud.similarity}`;
      const preprocessingChoice = `Preprocessing LLM · ${draft.preprocessingEnabled && draft.preprocessingModel ? `${draft.preprocessingModel.provider}/${draft.preprocessingModel.id}` : "off"}`;
      const choice = await ctx.ui.select("ElevenLabs settings", [modelChoice, voiceChoice, stabilityChoice, similarityChoice, apiKeyChoice, preprocessingChoice, "Save", "Cancel"]);
      if (!choice || choice === "Cancel") return configuration;
      if (choice === "Save") {
        await writeConfiguration(draft);
        return draft;
      }
      if (choice === apiKeyChoice) {
        const source = await chooseApiKeySource(ctx, cloud.apiKey);
        if (source !== undefined) cloud.apiKey = source;
      } else if (choice === modelChoice) {
        const model = await ctx.ui.select("ElevenLabs model", ["eleven_v4", "eleven_v4_turbo"]);
        if (model === "eleven_v4" || model === "eleven_v4_turbo") cloud.model = model;
      } else if (choice === voiceChoice) {
        const voice = await chooseCloudVoice(ctx, cloud);
        if (voice) cloud.voice = voice;
      } else if (choice === stabilityChoice || choice === similarityChoice) {
        const field = choice === stabilityChoice ? "stability" : "similarity";
        const value = await chooseUnitNumber(ctx, field === "stability" ? "Stability" : "Similarity", cloud[field]);
        if (value !== undefined) cloud[field] = value;
      } else if (choice === preprocessingChoice) {
        const result = await choosePreprocessingModel(ctx, draft);
        if (result) {
          draft.preprocessingEnabled = result.preprocessingEnabled;
          if (result.preprocessingModel) draft.preprocessingModel = result.preprocessingModel;
          else delete draft.preprocessingModel;
        }
      }
    }
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : "Could not save speech settings.", "error");
    return configuration;
  }
}
