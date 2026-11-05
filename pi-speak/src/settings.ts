import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getCatalogModel, type CatalogModel } from "./catalog.js";

const SETTINGS_VERSION = 1;

export const DEFAULT_VOICE = "af_heart";
export const DEFAULT_SPEED = 1.0;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 3.0;

export type PreprocessingModel = {
  provider: string;
  id: string;
};

export type PiSpeakSettings = {
  version: 1;
  backend: { type: "kokoro" };
  voice: string;
  speed: number;
  model: {
    source: "catalog";
    id: string;
    path: string;
  };
  preprocessingEnabled?: boolean;
  preprocessingModel?: PreprocessingModel;
  preprocessingPrompt?: string;
};

type SettingsReadResult = {
  settings?: PiSpeakSettings;
  warning?: string;
};

function settingsPath(): string {
  return join(getAgentDir(), "pi-speak.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateVoice(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function validateSpeed(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  if (value < MIN_SPEED || value > MAX_SPEED) return undefined;
  return value;
}

function defaultVoiceForModel(_model: CatalogModel): string {
  return DEFAULT_VOICE;
}

function validateSettings(value: unknown): PiSpeakSettings | undefined {
  if (!isObject(value) || value.version !== SETTINGS_VERSION) return undefined;
  if (!isObject(value.backend) || value.backend.type !== "kokoro") return undefined;

  const voice = validateVoice(value.voice);
  if (!voice) return undefined;

  const speed = validateSpeed(value.speed);
  if (speed === undefined) return undefined;

  if (!isObject(value.model) || value.model.source !== "catalog") return undefined;
  if (typeof value.model.id !== "string") return undefined;
  const model = getCatalogModel(value.model.id);
  if (!model) return undefined;
  if (typeof value.model.path !== "string" || value.model.path.length === 0) return undefined;

  let preprocessingEnabled: boolean | undefined;
  if ("preprocessingEnabled" in value) {
    const raw = (value as Record<string, unknown>).preprocessingEnabled;
    if (raw !== undefined) {
      if (typeof raw !== "boolean") return undefined;
      preprocessingEnabled = raw;
    }
  }

  let preprocessingModel: PreprocessingModel | undefined;
  if ("preprocessingModel" in value) {
    const raw = (value as Record<string, unknown>).preprocessingModel;
    if (raw !== undefined) {
      if (!isObject(raw)) return undefined;
      if (typeof raw.provider !== "string" || typeof raw.id !== "string") return undefined;
      const provider = raw.provider.trim();
      const id = raw.id.trim();
      if (provider.length === 0 || id.length === 0) return undefined;
      preprocessingModel = { provider, id };
    }
  }

  let preprocessingPrompt: string | undefined;
  if ("preprocessingPrompt" in value) {
    const raw = (value as Record<string, unknown>).preprocessingPrompt;
    if (raw !== undefined) {
      if (typeof raw !== "string") return undefined;
      const trimmed = raw.trim();
      if (trimmed.length > 0) preprocessingPrompt = trimmed;
    }
  }

  return {
    version: SETTINGS_VERSION,
    backend: { type: "kokoro" },
    voice,
    speed,
    model: {
      source: "catalog",
      id: value.model.id,
      path: value.model.path,
    },
    ...(preprocessingEnabled !== undefined ? { preprocessingEnabled } : {}),
    ...(preprocessingModel ? { preprocessingModel } : {}),
    ...(preprocessingPrompt ? { preprocessingPrompt } : {}),
  };
}

export async function readSettings(): Promise<SettingsReadResult> {
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(), "utf8"));
    const settings = validateSettings(parsed);
    return settings
      ? { settings }
      : { warning: `Invalid settings in ${settingsPath()}; configuration is required.` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return {
      warning: `Could not read ${settingsPath()}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function writeSettings(settings: PiSpeakSettings): Promise<void> {
  const path = settingsPath();
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  const content = `${JSON.stringify(settings, null, 2)}\n`;

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

type ModelSettingsOptions = {
  voice?: string;
  speed?: number;
  preprocessingEnabled?: boolean;
  preprocessingModel?: PreprocessingModel;
  preprocessingPrompt?: string;
};

export function settingsForModel(
  modelId: string,
  modelPath: string,
  options: ModelSettingsOptions = {},
): PiSpeakSettings {
  const model = getCatalogModel(modelId);
  if (!model) throw new Error(`Unknown catalog model: ${modelId}`);

  const voice = validateVoice(options.voice) ?? defaultVoiceForModel(model);
  const speed = validateSpeed(options.speed) ?? DEFAULT_SPEED;

  // Validate voice belongs to model if possible; fallback to default.
  const resolvedVoice = modelSupportedVoice(model, voice) ? voice : defaultVoiceForModel(model);

  let preprocessingEnabled: boolean | undefined;
  if (typeof options.preprocessingEnabled === "boolean") {
    preprocessingEnabled = options.preprocessingEnabled;
  }

  let preprocessingModel: PreprocessingModel | undefined;
  if (options.preprocessingModel) {
    const raw = options.preprocessingModel;
    if (typeof raw.provider === "string" && typeof raw.id === "string") {
      const provider = raw.provider.trim();
      const id = raw.id.trim();
      if (provider.length > 0 && id.length > 0) {
        preprocessingModel = { provider, id };
      }
    }
  }

  let preprocessingPrompt: string | undefined;
  if (typeof options.preprocessingPrompt === "string") {
    const trimmed = options.preprocessingPrompt.trim();
    if (trimmed.length > 0) preprocessingPrompt = trimmed;
  }

  return {
    version: SETTINGS_VERSION,
    backend: { type: "kokoro" },
    voice: resolvedVoice,
    speed,
    model: { source: "catalog", id: modelId, path: modelPath },
    ...(preprocessingEnabled !== undefined ? { preprocessingEnabled } : {}),
    ...(preprocessingModel ? { preprocessingModel } : {}),
    ...(preprocessingPrompt ? { preprocessingPrompt } : {}),
  };
}

function modelSupportedVoice(model: CatalogModel, voice: string): boolean {
  return (model.voices as readonly string[]).includes(voice);
}
