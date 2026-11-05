import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writeConfiguration, type SpeechConfiguration } from "../src/configuration.js";
import { createPiSpeakRuntime } from "../src/runtime.js";
import { deferred } from "./helpers.js";

test("runtime stop aborts playback, disposes its provider, and permits subsequent speech with changed defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-speak-runtime-speech-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const ctx = { hasUI: false } as ExtensionContext;
  const started = deferred<void>();
  const configurations: SpeechConfiguration[] = [];
  const signals: AbortSignal[] = [];
  let disposed = 0;
  let blockPlayback = true;
  const runtime = createPiSpeakRuntime({} as ExtensionAPI, {
    createProvider: async (configuration) => {
      configurations.push(configuration);
      return {
        async synthesize(_request, signal) {
          assert.ok(signal);
          signals.push(signal);
          return { kind: "buffered", wav: Buffer.from("test audio") };
        },
        async dispose() { disposed++; },
      };
    },
    playAudio: async (_audio, signal) => {
      assert.equal(signal, signals.at(-1), "synthesis and playback share the job signal");
      assert.ok(signal);
      if (!blockPlayback) return;
      started.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal.throwIfAborted();
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  });
  try {
    const configuration: SpeechConfiguration = {
      version: 2, provider: "elevenlabs",
      providers: { elevenlabs: { model: "eleven_v4", voice: "first", stability: 0.5, similarity: 0.75 } },
    };
    await writeConfiguration(configuration);
    const speaking = runtime.speak({ text: "First" }, ctx);
    const cancelled = assert.rejects(speaking, /cancelled/);
    await started.promise;
    await runtime.stop();
    await cancelled;
    assert.equal(signals[0]!.aborted, true);
    assert.equal(disposed, 1);

    configuration.providers.elevenlabs!.voice = "second";
    configuration.providers.elevenlabs!.model = "eleven_v4_turbo";
    await writeConfiguration(configuration);
    blockPlayback = false;
    await runtime.speak({ text: "Second" }, ctx);
    assert.equal(disposed, 2);
    assert.equal(configurations[0]!.providers.elevenlabs!.voice, "first");
    assert.equal(configurations[1]!.providers.elevenlabs!.voice, "second");
    assert.equal(configurations[1]!.providers.elevenlabs!.model, "eleven_v4_turbo");
    await runtime.shutdown(ctx);
    await assert.rejects(runtime.speak({ text: "After shutdown" }, ctx), /shut down/);
    assert.equal(configurations.length, 2, "shutdown does not construct another provider");
  } finally {
    await runtime.shutdown(ctx);
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(dir, { recursive: true, force: true });
  }
});
