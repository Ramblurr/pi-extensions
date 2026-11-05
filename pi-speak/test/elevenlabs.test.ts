import assert from "node:assert/strict";
import test from "node:test";
import { ElevenLabsProvider, searchElevenLabsVoices } from "../src/elevenlabs.js";
import { kokoroDescription, elevenLabsDescription } from "../src/provider-descriptions.js";

const config = { model: "eleven_v4" as const, voice: "voice-id", stability: 0.5, similarity: 0.75 };

test("each provider describes only its supported parameters", () => {
  assert.deepEqual(Object.keys(kokoroDescription.parameters.properties), ["text", "voice", "speed"]);
  assert.deepEqual(Object.keys(elevenLabsDescription.parameters.properties), ["text", "voice", "stability", "similarity"]);
  assert.doesNotMatch(JSON.stringify(kokoroDescription), /tags|ElevenLabs|instructions|stability|similarity/i);
  assert.match(elevenLabsDescription.guidelines.join(" "), /\[confident\]/);
});

test("unsupported controls and empty cleaned text fail before any paid request", async () => {
  const provider = new ElevenLabsProvider(config, { apiKey: () => "test-key", fetch: async () => {
    assert.fail("Invalid requests must not contact ElevenLabs");
  } });
  await assert.rejects(provider.synthesize({ text: "Hello", speed: 1 }), /Invalid speech parameters/);
  await assert.rejects(provider.synthesize({ text: "Hello", stability: 1.1 }), /Invalid speech parameters/);
  await assert.rejects(provider.synthesize({ text: "```\ncode\n```" }), /empty/);
  await provider.dispose();
});

test("missing credentials and HTTP errors are actionable and do not leak remote bodies", async () => {
  await assert.rejects(new ElevenLabsProvider(config, { apiKey: () => undefined }).synthesize({ text: "Hello" }), /ELEVENLABS_API_KEY/);
  let calls = 0;
  const provider = new ElevenLabsProvider(config, { apiKey: () => "private-key", fetch: async () => {
    calls++;
    return new Response("private-key and submitted private text", { status: 429 });
  } });
  await assert.rejects(provider.synthesize({ text: "Hello" }), (error: Error) => {
    assert.match(error.message, /429.*quota/);
    assert.doesNotMatch(error.message, /private-key|private text/);
    return true;
  });
  assert.equal(calls, 1);
  await provider.dispose();
});

test("cancelling after headers closes a stalled body", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const provider = new ElevenLabsProvider(config, { apiKey: () => "key", fetch: async () =>
    new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const audio = await provider.synthesize({ text: "Hello" }, controller.signal);
  if (audio.kind !== "stream") throw new Error("Expected stream");
  const pending = audio.chunks[Symbol.asyncIterator]().next();
  controller.abort(new Error("Stopped by user"));
  await assert.rejects(pending, /Stopped by user/);
  assert.equal(cancelled, true);
  await provider.dispose();
});

test("disposing a provider closes an unconsumed stream", async () => {
  let cancelled = false;
  const provider = new ElevenLabsProvider(config, { apiKey: () => "key", fetch: async () =>
    new Response(new ReadableStream({ cancel() { cancelled = true; } })) });
  const audio = await provider.synthesize({ text: "Hello" });
  await provider.dispose();
  assert.equal(cancelled, true);
  if (audio.kind !== "stream") throw new Error("Expected stream");
  await assert.rejects(audio.chunks[Symbol.asyncIterator]().next(), /disposed/);
  await assert.rejects(provider.synthesize({ text: "Again" }), /disposed/);
});

test("v4 Turbo uses per-call controls and reports truncated audio", async () => {
  const provider = new ElevenLabsProvider({ ...config, model: "eleven_v4_turbo" }, {
    apiKey: () => "key", fetch: async (url, init) => {
      assert.match(String(url), /other-voice\/stream/);
      assert.deepEqual(JSON.parse(String(init?.body)), { text: "Hello", model_id: "eleven_v4_turbo",
        voice_settings: { stability: 0.2, similarity_boost: 0.9 } });
      return new Response(Uint8Array.of(1, 2, 3));
    },
  });
  const audio = await provider.synthesize({ text: "Hello", voice: "other-voice", stability: 0.2, similarity: 0.9 });
  if (audio.kind !== "stream") throw new Error("Expected stream");
  await assert.rejects(async () => { for await (const _ of audio.chunks) { /* consume */ } }, /truncated/);
  await provider.dispose();
});

test("a request deadline covers audio body consumption after headers", async () => {
  let cancelled = false;
  const provider = new ElevenLabsProvider(config, { apiKey: () => "key", timeoutMs: 10,
    fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })),
  });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    const audio = await provider.synthesize({ text: "Hello" });
    if (audio.kind !== "stream") throw new Error("Expected stream");
    await assert.rejects(audio.chunks[Symbol.asyncIterator]().next(), /timed out/);
    assert.equal(cancelled, true);
  } finally { clearTimeout(keepAlive); await provider.dispose(); }
});

test("voice discovery preserves a usable next-page token without exposing remote extra fields", async () => {
  const page = await searchElevenLabsVoices("British", "page-two", undefined, {
    apiKey: () => "key", fetch: async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.pathname, "/v2/voices");
      assert.equal(parsed.searchParams.get("search"), "British");
      assert.equal(parsed.searchParams.get("next_page_token"), "page-two");
      return Response.json({ voices: [{ voice_id: "v1", name: "Name", description: "British voice", settings: { secret: "unused" } }],
        has_more: true, next_page_token: "page-three", total_count: 42 });
    },
  });
  assert.deepEqual(page, { voices: [{ id: "v1", name: "Name", description: "British voice" }], nextPage: "page-three" });
});

test("ElevenLabs preserves delivery tags and yields audio before the response finishes", async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let bodyFinished = false;
  const provider = new ElevenLabsProvider(config, {
    apiKey: () => "test-key",
    fetch: async (url, init) => {
      assert.equal(String(url), "https://api.elevenlabs.io/v1/text-to-speech/voice-id/stream?output_format=pcm_24000");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        text: "[confident] Hello. [chuckles]", model_id: "eleven_v4",
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      });
      assert.equal(new Headers(init?.headers).get("xi-api-key"), "test-key");
      return new Response(new ReadableStream({
        async start(controller) {
          controller.enqueue(Uint8Array.of(1, 2));
          await gate;
          controller.enqueue(Uint8Array.of(3, 4));
          bodyFinished = true;
          controller.close();
        },
      }), { headers: { "content-type": "audio/pcm" } });
    },
  });
  try {
    const audio = await provider.synthesize({ text: "[confident] Hello. [chuckles]" });
    assert.equal(audio.kind, "stream");
    if (audio.kind !== "stream") throw new Error("Expected stream");
    assert.deepEqual(audio.format, { encoding: "pcm-s16le", sampleRate: 24000, channels: 1 });
    const iterator = audio.chunks[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, Uint8Array.of(1, 2));
    assert.equal(bodyFinished, false);
    finish();
    assert.deepEqual((await iterator.next()).value, Uint8Array.of(3, 4));
    assert.equal((await iterator.next()).done, true);
  } finally {
    finish();
    await provider.dispose();
  }
});
