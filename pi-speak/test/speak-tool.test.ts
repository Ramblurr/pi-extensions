import assert from "node:assert/strict";
import test from "node:test";
import type { TObject } from "typebox";
import { Check } from "typebox/value";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerSpeakTool } from "../src/speak-tool.js";
import { createPiSpeakRuntime } from "../src/runtime.js";
import { writeConfiguration, type SpeechConfiguration } from "../src/configuration.js";
import { settingsForModel } from "../src/settings.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deferred } from "./helpers.js";

type Discovery = { defaults: Record<string, string | number>; example: { tool: string; arguments: unknown } };

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
    config.providers.kokoro!.voice = "af_jessica";
    config.providers.kokoro!.speed = 1.5;
    await writeConfiguration(config);
    await controller.refresh();
    const localOptions = await tools.get("speech_options")!.execute("local-options", {}, undefined, undefined, ctx);
    const localDetails = localOptions.details as Discovery;
    assert.ok(tools.get("speak")!.description.includes(JSON.stringify(localDetails.defaults)));
    assert.equal(localDetails.defaults.model, "kokoro-82m");
    assert.equal(localDetails.defaults.voice, "af_jessica");
    assert.equal(localDetails.defaults.speed, 1.5);
    assert.equal(localDetails.example.tool, "speak");
    assert.equal(Check(tools.get("speak")!.parameters, localDetails.example.arguments), true);
    assert.doesNotMatch(JSON.stringify(localDetails.example), /stability|similarity|\[confident\]/);
    config.provider = "elevenlabs";
    config.providers.elevenlabs = { model: "eleven_v4", voice: "v1", stability: 0.4, similarity: 0.8, apiKey: "!printf secret-reference" };
    await writeConfiguration(config);
    await controller.refresh();
    const cloud = tools.get("speak")!;
    assert.deepEqual(Object.keys(cloud.parameters.properties), ["text", "voice", "stability", "similarity"]);
    assert.match(JSON.stringify(cloud.promptGuidelines), /\[confident\]/);
    assert.match(cloud.description, /eleven_v4/);
    Object.assign(config.providers.elevenlabs, { model: "eleven_v4_turbo", voice: "v2", stability: 0.6, similarity: 0.9 });
    await writeConfiguration(config);
    await controller.refresh();
    const discovered = await tools.get("speech_options")!.execute("options", {}, undefined, undefined, ctx);
    const cloudDetails = discovered.details as Discovery;
    assert.deepEqual(cloudDetails.defaults, { model: "eleven_v4_turbo", voice: "v2", stability: 0.6, similarity: 0.9 });
    assert.ok(tools.get("speak")!.description.includes(JSON.stringify(cloudDetails.defaults)));
    assert.equal(cloudDetails.example.tool, "speak");
    assert.equal(Check(tools.get("speak")!.parameters, cloudDetails.example.arguments), true);
    assert.doesNotMatch(JSON.stringify(cloudDetails.example), /speed/);
    assert.doesNotMatch(JSON.stringify(cloud.promptGuidelines), /omit.*configured defaults/i);
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
