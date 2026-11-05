import assert from "node:assert/strict";
import test from "node:test";
import type { TObject } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerSpeakTool } from "../src/speak-tool.js";
import { createPiSpeakRuntime } from "../src/runtime.js";
import { writeConfiguration, type SpeechConfiguration } from "../src/configuration.js";
import { settingsForModel } from "../src/settings.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "./helpers.js";

test("speech tool switches schema/guidance and keeps credential sources out of discovery", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-speak-tool-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const tools = new Map<string, ToolDefinition<TObject>>();
  const pi = { registerTool(tool: ToolDefinition<TObject>) { tools.set(tool.name, tool); } } as unknown as ExtensionAPI;
  const ctx = { hasUI: false } as ExtensionContext;
  const played = deferred<void>();
  const release = deferred<void>();
  const runtime = createPiSpeakRuntime(pi, {
    createProvider: async () => ({ async synthesize() { return { kind: "buffered", wav: Buffer.from("audio") }; }, async dispose() {} }),
    playAudio: async () => { played.resolve(); await release.promise; },
  });
  const controller = registerSpeakTool(pi, { getRuntime: async () => runtime });
  try {
    const path = join(dir, "model.onnx");
    await writeFile(path, "model");
    const config: SpeechConfiguration = { version: 2, provider: "kokoro", providers: { kokoro: settingsForModel("kokoro-82m", path) } };
    await writeConfiguration(config);
    await controller.refresh();
    const local = tools.get("speak")!;
    assert.deepEqual(Object.keys(local.parameters.properties), ["text", "voice", "speed"]);
    assert.doesNotMatch(JSON.stringify([local.description, local.promptGuidelines]), /tags|ElevenLabs/i);
    config.provider = "elevenlabs";
    config.providers.elevenlabs = { model: "eleven_v4_turbo", voice: "v1", stability: 0.4, similarity: 0.8, apiKey: "!printf secret-reference" };
    await writeConfiguration(config);
    await controller.refresh();
    const cloud = tools.get("speak")!;
    assert.deepEqual(Object.keys(cloud.parameters.properties), ["text", "voice", "stability", "similarity"]);
    assert.match(JSON.stringify(cloud.promptGuidelines), /\[confident\]/);
    const discovered = await tools.get("speech_options")!.execute("options", {}, undefined, undefined, ctx);
    assert.doesNotMatch(JSON.stringify(discovered), /secret-reference|apiKey|op:\/\//);
    assert.match(JSON.stringify(discovered), /eleven_v4_turbo/);
    let completed = false;
    const pending = cloud.execute("speech", { text: "Hello" }, undefined, undefined, ctx).then((value) => { completed = true; return value; });
    await played.promise;
    assert.equal(completed, false, "tool waits for playback, not merely generation");
    release.resolve();
    assert.match(JSON.stringify(await pending), /playback completed/);
    await controller.shutdown();
    await assert.rejects(cloud.execute("after", { text: "Hello" }, undefined, undefined, ctx), /shutting down/);
  } finally {
    release.resolve();
    await runtime.shutdown(ctx);
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
