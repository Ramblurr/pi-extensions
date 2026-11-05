import assert from "node:assert/strict";
import test from "node:test";
import { SynthesisService, float32ToWav } from "../src/synthesis-service.js";
import type { PiSpeakSettings } from "../src/settings.js";
import { deferred, nextTurn } from "./helpers.js";

function settings(modelPath: string): PiSpeakSettings {
  return {
    version: 1,
    backend: { type: "kokoro" },
    voice: "af_heart",
    speed: 1.0,
    model: { source: "catalog", id: "kokoro-82m", path: modelPath },
  };
}

type TestBackend = {
  prepare(): Promise<void>;
  synthesize(text: string, options: { voice: string; speed: number; signal?: AbortSignal }): Promise<Float32Array>;
  dispose(): Promise<void>;
};

function createTestService(overrides: Partial<TestBackend> = {}): SynthesisService {
  return new SynthesisService(() => ({
    async prepare() {},
    async synthesize() {
      return new Float32Array([0.1, 0.2]);
    },
    async dispose() {},
    ...overrides,
  }));
}

function createHarness(blockedIds: readonly number[] = []): {
  service: SynthesisService;
  events: string[];
  release(id: number): void;
} {
  const events: string[] = [];
  const blocks = new Map(blockedIds.map((id) => [id, deferred<void>()]));
  const service = new SynthesisService((modelPath) => {
    events.push(`load:${modelPath}`);
    return {
      async prepare() {
        events.push(`prepare:${modelPath}`);
      },
      async synthesize(text: string, options: { voice: string; speed: number; signal?: AbortSignal } = { voice: "af_heart", speed: 1 }) {
        const id = Number.parseInt(text, 10);
        const numericId = Number.isNaN(id) ? text : String(id);
        // Use text as id when it's numeric, else use first char
        const runId = Number.isNaN(id) ? text.slice(0, 5) : id;
        events.push(`run:${runId}`);
        const gate = blocks.get(typeof runId === "number" ? runId : -1);
        if (gate) await gate.promise;
        options.signal?.throwIfAborted();
        events.push(`done:${runId}`);
        return new Float32Array([0.1, 0.2, 0.3]);
      },
      async dispose() {
        events.push(`unload:${modelPath}`);
      },
    };
  });
  return {
    service,
    events,
    release(id) {
      blocks.get(id)?.resolve();
    },
  };
}

test("queued jobs sharing a model load it once", async () => {
  const harness = createHarness([1]);
  const first = harness.service.synthesize(settings("model-a"), "1");
  await nextTurn();
  const second = harness.service.synthesize(settings("model-a"), "2");

  harness.release(1);
  const [a, b] = await Promise.all([first, second]);
  assert.ok(Buffer.isBuffer(a));
  assert.ok(Buffer.isBuffer(b));
  await nextTurn();

  assert.equal(harness.events.filter((e) => e === "load:model-a").length, 1);
  assert.deepEqual(
    harness.events.filter((e) => e.startsWith("run:")),
    ["run:1", "run:2"],
  );
  assert.equal(harness.events.at(-1), "unload:model-a");
  await harness.service.shutdown();
});

test("a different model is unloaded and loaded at the queue boundary", async () => {
  const harness = createHarness([4]);
  const first = harness.service.synthesize(settings("model-a"), "4");
  await nextTurn();
  const second = harness.service.synthesize(settings("model-b"), "5");

  harness.release(4);
  await Promise.all([first, second]);
  await nextTurn();

  assert.ok(harness.events.indexOf("unload:model-a") < harness.events.indexOf("load:model-b"));
  assert.equal(harness.events.filter((e) => e === "load:model-a").length, 1);
  assert.equal(harness.events.filter((e) => e === "load:model-b").length, 1);
  await harness.service.shutdown();
});

test("aborting an unstarted queued job rejects immediately", async () => {
  const harness = createHarness([1]);
  const active = harness.service.synthesize(settings("model-a"), "1");
  await nextTurn();

  const controller = new AbortController();
  const queued = harness.service.synthesize(settings("model-a"), "9", controller.signal);
  controller.abort(new Error("cancelled while queued"));

  let timeout: NodeJS.Timeout | undefined;
  const settled = await Promise.race([
    queued.then(() => "resolved", () => "rejected"),
    new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => resolve("timeout"), 100);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  assert.equal(settled, "rejected");
  await assert.rejects(queued, /cancelled while queued/);

  harness.release(1);
  assert.ok(Buffer.isBuffer(await active));
  assert.equal(harness.events.includes("run:9"), false);
  await harness.service.shutdown();
});

test("aborting during prepare releases slot for next job", async () => {
  const prepareGate = deferred<void>();
  let prepareCalls = 0;
  const service = createTestService({
    async prepare() {
      prepareCalls++;
      await prepareGate.promise;
    },
  });

  const controller = new AbortController();
  const first = service.synthesize(settings("model-a"), "hello", controller.signal);
  await nextTurn();
  // Queue second while first is preparing
  const second = service.synthesize(settings("model-a"), "world");
  controller.abort(new Error("cancelled while loading"));

  let secondCompleted = false;
  second.then(() => { secondCompleted = true; }).catch(() => { secondCompleted = true; });

  prepareGate.resolve();
  await assert.rejects(first, /cancelled while loading/);
  // second should eventually settle (either resolve or reject) but not hang
  await assert.doesNotReject(async () => {
    const result = await second;
    assert.ok(Buffer.isBuffer(result));
  });
  assert.equal(prepareCalls >= 1, true);
  await service.shutdown();
});

test("empty text rejects", async () => {
  const service = createTestService();
  await assert.rejects(service.synthesize(settings("model-a"), "   "), /Missing or empty/);
  await assert.rejects(service.synthesize(settings("model-a"), "```code```"), /Missing or empty/);
  await assert.rejects(service.synthesize(settings("model-a"), ""), /Missing or empty/);
  await service.shutdown();
});

test("shutdown rejects queued jobs with shutting down", async () => {
  const prepareGate = deferred<void>();
  const service = new SynthesisService((modelPath) => ({
    async prepare() {
      await prepareGate.promise;
    },
    async synthesize() {
      return new Float32Array([0.1]);
    },
    async dispose() {},
  }));
  const first = service.synthesize(settings("model-a"), "hello");
  await nextTurn();
  const second = service.synthesize(settings("model-a"), "world");
  await nextTurn();
  const shutdownPromise = service.shutdown();
  // Release prepare so shutdown can complete and jobs reject
  prepareGate.resolve();
  await assert.rejects(first, /shutting down/);
  await assert.rejects(second, /shutting down/);
  await shutdownPromise;
  await assert.rejects(service.synthesize(settings("model-a"), "again"), /shutting down/);
});

test("float32ToWav produces valid WAV header", () => {
  const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const wav = float32ToWav(samples, 24000);
  assert.equal(wav.slice(0, 4).toString(), "RIFF");
  assert.equal(wav.slice(8, 12).toString(), "WAVE");
  assert.equal(wav.slice(12, 16).toString(), "fmt ");
  assert.equal(wav.slice(36, 40).toString(), "data");
  assert.equal(wav.length, 44 + samples.length * 2);
  // Check sample rate
  assert.equal(wav.readUInt32LE(24), 24000);
});

test("synthesize returns WAV buffer with correct size", async () => {
  const service = createTestService({
    async synthesize() {
      return new Float32Array([0, 0.1, 0.2]);
    },
  });
  const wav = await service.synthesize(settings("model-a"), "hello");
  assert.ok(Buffer.isBuffer(wav));
  assert.equal(wav.slice(0, 4).toString(), "RIFF");
  await service.shutdown();
});
