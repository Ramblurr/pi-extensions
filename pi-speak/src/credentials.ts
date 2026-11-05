import type { ElevenLabsConfig } from "./speech-provider.js";
import { getConfigValueEnvVarNames, isCommandConfigValue, resolveConfigValue } from "./vendor/resolve-config-value.js";

export function isApiKeySource(value: unknown): value is string {
  return typeof value === "string" && (
    (isCommandConfigValue(value) && value.slice(1).trim().length > 0) || getConfigValueEnvVarNames(value).length > 0
  );
}

export async function resolveElevenLabsKey(config: ElevenLabsConfig, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const source = config.apiKey ?? "$ELEVENLABS_API_KEY";
  if (!isApiKeySource(source)) throw new Error("API key source must be !command or an environment reference such as $ELEVENLABS_API_KEY.");
  // Keep Pi's template expansion, command timeout and process-lifetime cache semantics.
  // Upstream commands are synchronous (up to 10s); cancellation is checked around resolution.
  const key = resolveConfigValue(source);
  signal?.throwIfAborted();
  if (!key) {
    throw new Error(isCommandConfigValue(source)
      ? "ElevenLabs credential command failed or returned no key. Retry after reloading Pi."
      : "ElevenLabs API key is unavailable. Configure its API key source in /speak or set ELEVENLABS_API_KEY.");
  }
  return key;
}
