import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readConfiguration, writeConfiguration, type SpeechConfiguration } from "../src/configuration.js";
import { CATALOG_MODELS } from "../src/catalog.js";
import { settingsForModel } from "../src/settings.js";

const cloud = { model: "eleven_v4", voice: "voice-id", stability: 0.5, similarity: 0.75 } as const;

test("provider configuration persistence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-speak-v2-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const path = join(dir, "pi-speak.json");
  const kokoro = settingsForModel(CATALOG_MODELS[0]!.id, "/local/model.onnx", {
    voice: "af_heart", speed: 1.5, preprocessingEnabled: true,
    preprocessingModel: { provider: "llm", id: "summary" }, preprocessingPrompt: "Custom summary prompt",
  });
  const expected: SpeechConfiguration = {
    version: 2, provider: "kokoro", providers: { kokoro },
    preprocessingEnabled: true, preprocessingModel: kokoro.preprocessingModel, preprocessingPrompt: kokoro.preprocessingPrompt,
  };
  try {
    await t.test("missing file is not an error", async () => {
      assert.deepEqual(await readConfiguration(), {});
    });
    await t.test("v1 migration preserves choices without writing on read", async () => {
      const before = JSON.stringify(kokoro);
      await writeFile(path, before);
      assert.deepEqual(await readConfiguration(), { configuration: expected });
      assert.equal(await readFile(path, "utf8"), before);
    });
    await t.test("v2 round-trip preserves inactive provider and authoritative preprocessing", async () => {
      const configuration: SpeechConfiguration = { ...expected, provider: "elevenlabs", providers: { kokoro, elevenlabs: cloud }, preprocessingEnabled: false };
      await writeConfiguration(configuration);
      assert.deepEqual(await readConfiguration(), { configuration });
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(dir), ["pi-speak.json"]);
    });
    await t.test("only nonsecret schema fields are serialized", async () => {
      const configuration = { version: 2, provider: "elevenlabs", apiKey: "secret", providers: { elevenlabs: { ...cloud, unexpectedCredential: "secret" } } } as SpeechConfiguration;
      await writeConfiguration(configuration);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { version: 2, provider: "elevenlabs", providers: { elevenlabs: cloud } });
    });
    await t.test("credential references round-trip without executing commands", async () => {
      const marker = join(dir, "must-not-exist");
      for (const apiKey of ["$CUSTOM_ELEVENLABS_KEY", "${CUSTOM_ELEVENLABS_KEY}", "!op read 'op://Private/ElevenLabs/api-key-quine'", `!touch ${marker}`]) {
        const configuration: SpeechConfiguration = { ...expected, providers: { kokoro, elevenlabs: { ...cloud, apiKey } } };
        await writeConfiguration(configuration);
        assert.deepEqual(await readConfiguration(), { configuration });
        await assert.rejects(stat(marker), { code: "ENOENT" });
      }
      const before = await readFile(path, "utf8");
      await assert.rejects(writeConfiguration({ ...expected, providers: { kokoro, elevenlabs: { ...cloud, apiKey: "sk-literal-secret" } } }));
      assert.equal(await readFile(path, "utf8"), before);
    });
    await t.test("invalid active, inactive, and preprocessing settings are rejected without overwrite", async () => {
      const good: SpeechConfiguration = { version: 2, provider: "elevenlabs", providers: { elevenlabs: cloud } };
      const invalid = [
        { ...good, version: 3 },
        { ...good, providers: { elevenlabs: { ...cloud, apiKey: "literal-secret" } } },
        { ...good, provider: "kokoro" },
        { ...good, providers: { elevenlabs: { ...cloud, model: "eleven_v3" } } },
        { ...good, providers: { elevenlabs: { ...cloud, voice: " " } } },
        { ...good, providers: { elevenlabs: { ...cloud, stability: -0.1 } } },
        { ...good, providers: { elevenlabs: { ...cloud, similarity: 1.1 } } },
        { ...good, providers: { elevenlabs: cloud, kokoro: { ...kokoro, speed: 10 } } },
        { ...good, preprocessingEnabled: "yes" },
        { ...good, preprocessingModel: { provider: "", id: "x" } },
        { ...good, preprocessingPrompt: 42 },
      ];
      for (const value of invalid) {
        const before = JSON.stringify(value);
        await writeFile(path, before);
        const result = await readConfiguration();
        assert.equal(result.configuration, undefined);
        assert.ok(result.warning);
        await assert.rejects(writeConfiguration(good));
        assert.equal(await readFile(path, "utf8"), before);
      }
      await writeFile(path, "{\"apiKey\":\"DO-NOT-ECHO\"");
      assert.ok(!(await readConfiguration()).warning?.includes("DO-NOT-ECHO"));
    });
    await t.test("invalid write leaves a valid existing file intact", async () => {
      await rm(path);
      await writeConfiguration(expected);
      const before = await readFile(path, "utf8");
      await assert.rejects(writeConfiguration({ ...expected, providers: {} }));
      assert.equal(await readFile(path, "utf8"), before);
    });
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    await rm(dir, { recursive: true, force: true });
  }
});
