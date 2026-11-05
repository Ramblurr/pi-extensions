import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSettings, type PiSpeakSettings, type PreprocessingModel } from "./settings.js";
import type { ElevenLabsConfig } from "./speech-provider.js";
import { isApiKeySource } from "./credentials.js";

export type SpeechConfiguration = {
  version: 2;
  provider: "kokoro" | "elevenlabs";
  providers: { kokoro?: PiSpeakSettings; elevenlabs?: ElevenLabsConfig };
  preprocessingEnabled?: boolean;
  preprocessingModel?: PreprocessingModel;
  preprocessingPrompt?: string;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unitNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateConfiguration(value: unknown): SpeechConfiguration | undefined {
  if (!isObject(value)) return undefined;
  if (value.version === 1) {
    const kokoro = validateSettings(value);
    if (!kokoro) return undefined;
    return {
      version: 2, provider: "kokoro", providers: { kokoro },
      ...(kokoro.preprocessingEnabled !== undefined ? { preprocessingEnabled: kokoro.preprocessingEnabled } : {}),
      ...(kokoro.preprocessingModel ? { preprocessingModel: kokoro.preprocessingModel } : {}),
      ...(kokoro.preprocessingPrompt !== undefined ? { preprocessingPrompt: kokoro.preprocessingPrompt } : {}),
    };
  }
  if (value.version !== 2 || (value.provider !== "kokoro" && value.provider !== "elevenlabs") || !isObject(value.providers)) return undefined;
  const providers: SpeechConfiguration["providers"] = {};
  if (value.providers.kokoro !== undefined) {
    const kokoro = validateSettings(value.providers.kokoro);
    if (!kokoro) return undefined;
    providers.kokoro = kokoro;
  }
  if (value.providers.elevenlabs !== undefined) {
    const cloud = value.providers.elevenlabs;
    if (!isObject(cloud) || (cloud.model !== "eleven_v4" && cloud.model !== "eleven_v4_turbo") ||
        typeof cloud.voice !== "string" || !cloud.voice.trim() || !unitNumber(cloud.stability) || !unitNumber(cloud.similarity)) return undefined;
    if (cloud.apiKey !== undefined && !isApiKeySource(cloud.apiKey)) return undefined;
    providers.elevenlabs = { model: cloud.model, voice: cloud.voice.trim(), stability: cloud.stability, similarity: cloud.similarity };
    if (cloud.apiKey !== undefined) providers.elevenlabs.apiKey = cloud.apiKey as string;
    if (cloud.voiceName !== undefined) {
      if (typeof cloud.voiceName !== "string" || !cloud.voiceName.trim()) return undefined;
      providers.elevenlabs.voiceName = cloud.voiceName.trim();
    }
  }
  if (!providers[value.provider]) return undefined;
  const configuration: SpeechConfiguration = { version: 2, provider: value.provider, providers };
  if (value.preprocessingEnabled !== undefined) {
    if (typeof value.preprocessingEnabled !== "boolean") return undefined;
    configuration.preprocessingEnabled = value.preprocessingEnabled;
  }
  if (value.preprocessingModel !== undefined) {
    const model = value.preprocessingModel;
    if (!isObject(model) || typeof model.provider !== "string" || !model.provider.trim() || typeof model.id !== "string" || !model.id.trim()) return undefined;
    configuration.preprocessingModel = { provider: model.provider.trim(), id: model.id.trim() };
  }
  if (value.preprocessingPrompt !== undefined) {
    if (typeof value.preprocessingPrompt !== "string") return undefined;
    configuration.preprocessingPrompt = value.preprocessingPrompt;
  }
  return configuration;
}

export async function readConfiguration(): Promise<{ configuration?: SpeechConfiguration; warning?: string }> {
  const path = join(getAgentDir(), "pi-speak.json");
  try {
    const configuration = validateConfiguration(JSON.parse(await readFile(path, "utf8")));
    return configuration ? { configuration } : { warning: `Invalid settings in ${path}; repair the file before configuring speech.` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // JSON parse errors can include file contents, including accidentally stored secrets.
    return { warning: `Could not read ${path}; repair the file before configuring speech.` };
  }
}

export async function writeConfiguration(configuration: SpeechConfiguration): Promise<void> {
  const validated = validateConfiguration(configuration);
  if (!validated || configuration.version !== 2) throw new Error("Invalid speech configuration");
  const existing = await readConfiguration();
  if (existing.warning) throw new Error(existing.warning);
  const dir = getAgentDir();
  const path = join(dir, "pi-speak.json");
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}
