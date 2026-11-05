import { elevenLabsDescription, validateSpeechRequest } from "./provider-descriptions.js";
import type { ElevenLabsConfig, SpeechAudio, SpeechProvider, SpeechRequest, VoicePage } from "./speech-provider.js";
import { cleanTextForSpeech } from "./text.js";
import { resolveElevenLabsKey } from "./credentials.js";

const BASE_URL = "https://api.elevenlabs.io";
const REQUEST_TIMEOUT_MS = 120_000;

type HttpOptions = {
  fetch?: typeof fetch;
  apiKey?: () => string | undefined | Promise<string | undefined>;
  timeoutMs?: number;
};

async function apiKey(options: HttpOptions): Promise<string> {
  const key = (options.apiKey ? await options.apiKey() : process.env.ELEVENLABS_API_KEY)?.trim();
  if (!key) throw new Error("Set ELEVENLABS_API_KEY in Pi's environment to use ElevenLabs.");
  return key;
}

function checkResponse(response: Response): void {
  if (response.ok) return;
  const reason = response.status === 401 || response.status === 403
    ? "check the API key and its permissions"
    : response.status === 429
      ? "rate limit or account quota exceeded"
      : "speech service request failed";
  // Never echo remote error bodies: they can contain submitted text or credentials.
  throw new Error(`ElevenLabs HTTP ${response.status}: ${reason}. No automatic retry was made.`);
}

export class ElevenLabsProvider implements SpeechProvider {
  private readonly active = new Set<AbortController>();
  private disposed = false;

  constructor(private readonly config: ElevenLabsConfig, private readonly http: HttpOptions = {}) {}

  async synthesize(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechAudio> {
    if (this.disposed) throw new Error("Speech provider is disposed");
    signal?.throwIfAborted();
    validateSpeechRequest(elevenLabsDescription, request);
    const text = cleanTextForSpeech(request.text);
    if (!text) throw new Error("Missing or empty 'text' field");
    const effective = { ...this.config, ...request };
    if (!["eleven_v4", "eleven_v4_turbo"].includes(effective.model)) throw new Error("Unknown ElevenLabs model");
    validateSpeechRequest(elevenLabsDescription, {
      text, voice: effective.voice, stability: effective.stability, similarity: effective.similarity,
    });
    const key = this.http.apiKey ? await apiKey(this.http) : await resolveElevenLabsKey(this.config, signal);
    signal?.throwIfAborted();
    if (this.disposed) throw new Error("Speech provider is disposed");
    const controller = new AbortController();
    this.active.add(controller);
    const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("ElevenLabs speech request timed out")), this.http.timeoutMs ?? REQUEST_TIMEOUT_MS);
    timer.unref();
    const cleanup = (): void => { clearTimeout(timer); this.active.delete(controller); };
    let response: Response;
    try {
      response = await (this.http.fetch ?? fetch)(
        `${BASE_URL}/v1/text-to-speech/${encodeURIComponent(effective.voice)}/stream?output_format=pcm_24000`,
        {
          method: "POST", redirect: "error", signal: abortSignal,
          headers: { "xi-api-key": key, "Content-Type": "application/json" },
          body: JSON.stringify({ text, model_id: effective.model,
            voice_settings: { stability: effective.stability, similarity_boost: effective.similarity } }),
        },
      );
    } catch {
      cleanup();
      abortSignal.throwIfAborted();
      throw new Error("ElevenLabs network request failed. No automatic retry was made.");
    }
    try {
      checkResponse(response);
      if (!response.body) throw new Error("ElevenLabs returned no audio body");
      const contentType = response.headers.get("content-type") ?? "";
      if (/json|text\/|html/i.test(contentType)) throw new Error("ElevenLabs returned a non-audio response");
      abortSignal.throwIfAborted();
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      cleanup();
      throw error;
    }
    const reader = response.body!.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => undefined); cleanup(); };
    abortSignal.addEventListener("abort", cancel, { once: true });
    if (abortSignal.aborted) cancel();
    async function* chunks(): AsyncIterable<Uint8Array> {
      let bytes = 0;
      try {
        while (true) {
          abortSignal.throwIfAborted();
          const result = await reader.read();
          abortSignal.throwIfAborted();
          if (result.done) break;
          bytes += result.value.byteLength;
          if (result.value.byteLength) yield result.value;
        }
        if (bytes === 0 || bytes % 2 !== 0) throw new Error("ElevenLabs returned empty or truncated PCM audio");
      } catch (error) {
        abortSignal.throwIfAborted();
        if (error instanceof Error && error.message === "ElevenLabs returned empty or truncated PCM audio") throw error;
        throw new Error("ElevenLabs audio stream failed. Playback may be incomplete; no automatic retry was made.");
      } finally {
        abortSignal.removeEventListener("abort", cancel);
        await reader.cancel().catch(() => undefined);
        reader.releaseLock();
        cleanup();
      }
    }
    return { kind: "stream", format: { encoding: "pcm-s16le", sampleRate: 24000, channels: 1 }, chunks: chunks() };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort(new Error("Speech provider disposed"));
    this.active.clear();
  }
}

export async function searchElevenLabsVoices(
  query = "", nextPage?: string, signal?: AbortSignal, http: HttpOptions = {},
): Promise<VoicePage> {
  signal?.throwIfAborted();
  const key = await apiKey(http);
  signal?.throwIfAborted();
  const abortSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(http.timeoutMs ?? 15_000)]);
  const url = new URL(`${BASE_URL}/v2/voices`);
  url.searchParams.set("page_size", "20");
  url.searchParams.set("include_total_count", "false");
  if (query.trim()) url.searchParams.set("search", query.trim());
  if (nextPage) url.searchParams.set("next_page_token", nextPage);
  let response: Response;
  try {
    response = await (http.fetch ?? fetch)(url, {
      signal: abortSignal, redirect: "error", headers: { "xi-api-key": key },
    });
  } catch {
    abortSignal.throwIfAborted();
    throw new Error("ElevenLabs voice lookup failed");
  }
  try {
    checkResponse(response);
    const data: unknown = await response.json();
    if (!data || typeof data !== "object") throw new Error("Invalid voice response");
    const page = data as { voices?: unknown; has_more?: unknown; next_page_token?: unknown };
    if (!Array.isArray(page.voices) || typeof page.has_more !== "boolean" ||
        (page.has_more && (typeof page.next_page_token !== "string" || !page.next_page_token))) {
      throw new Error("Invalid voice response");
    }
    return {
      voices: page.voices.map((entry: unknown) => {
        if (!entry || typeof entry !== "object" || !("voice_id" in entry) || typeof entry.voice_id !== "string") {
          throw new Error("Invalid voice response");
        }
        const value = entry as { voice_id: string; name?: unknown; description?: unknown };
        return { id: value.voice_id, name: typeof value.name === "string" ? value.name : value.voice_id,
          description: typeof value.description === "string" ? value.description : "" };
      }),
      ...(page.has_more ? { nextPage: page.next_page_token as string } : {}),
    };
  } catch (error) {
    abortSignal.throwIfAborted();
    if (error instanceof Error && error.message.startsWith("ElevenLabs HTTP")) throw error;
    throw new Error("ElevenLabs returned an invalid voice list");
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}
