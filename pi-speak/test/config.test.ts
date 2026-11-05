import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readSettings, writeSettings, settingsForModel } from "../src/settings.js";
import { CATALOG_MODELS } from "../src/catalog.js";

test("config", async (t) => {
  await t.test("settings persistence round-trip and atomic 0o600", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const model = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");

      const created = settingsForModel(model.id, fakePath, { voice: model.voices[0], speed: 1.5 });
      await writeSettings(created);

      const filePath = join(dir, "pi-speak.json");
      const st = await stat(filePath);
      assert.equal(st.mode & 0o777, 0o600);

      const content = await readFile(filePath, "utf8");
      const parsed = JSON.parse(content);
      assert.equal(parsed.voice, created.voice);
      assert.equal(parsed.speed, 1.5);

      const read = await readSettings();
      assert.ok(read.settings);
      assert.equal(read.settings!.voice, created.voice);
      assert.equal(read.settings!.speed, 1.5);
      assert.equal(read.warning, undefined);

      const files = await readdir(dir);
      assert.ok(!files.some((f) => f.endsWith(".tmp")));
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("readSettings ENOENT returns empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-enoent-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const result = await readSettings();
      assert.equal(result.settings, undefined);
      assert.equal(result.warning, undefined);
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("readSettings invalid JSON returns warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-invalid-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const path = join(dir, "pi-speak.json");
      await writeFile(path, "{ invalid json", "utf8");
      const result = await readSettings();
      assert.equal(result.settings, undefined);
      assert.ok(result.warning);
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("readSettings invalid shape returns warning", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-shape-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const path = join(dir, "pi-speak.json");
      await writeFile(path, JSON.stringify({ version: 999, backend: { type: "kokoro" }, voice: "x", speed: 1, model: { source: "catalog", id: "kokoro-82m", path: "/tmp/x" } }), "utf8");
      const result = await readSettings();
      assert.equal(result.settings, undefined);
      assert.ok(result.warning);
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("settingsForModel validates voice and speed", async () => {
    const model = CATALOG_MODELS[0]!;
    const fakePath = "/tmp/fake.onnx";

    const s1 = settingsForModel(model.id, fakePath, { voice: model.voices[0], speed: 2.0 });
    assert.equal(s1.voice, model.voices[0]);
    assert.equal(s1.speed, 2.0);

    const s2 = settingsForModel(model.id, fakePath, { voice: "nonexistent_voice", speed: 1 });
    assert.equal(s2.voice, "af_heart");

    const s3 = settingsForModel(model.id, fakePath, { voice: model.voices[0], speed: 99 as any });
    assert.equal(s3.speed, 1.0);

    assert.throws(() => settingsForModel("unknown", fakePath));
  });

  await t.test("writeSettings is atomic via temp rename", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-atomic-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const model = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const s = settingsForModel(model.id, fakePath);
      await writeSettings(s);
      const s2 = settingsForModel(model.id, fakePath, { voice: model.voices[1] ?? model.voices[0], speed: 0.75 });
      await writeSettings(s2);
      const read = await readSettings();
      assert.equal(read.settings!.voice, s2.voice);
      assert.equal(read.settings!.speed, 0.75);
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("preprocessing fields round-trip and preserve on voice change", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-pre-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const model = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const created = settingsForModel(model.id, fakePath, {
        voice: model.voices[0],
        speed: 1.5,
        preprocessingEnabled: true,
        preprocessingModel: { provider: " openai ", id: " gpt-4o " },
        preprocessingPrompt: "  Custom prompt  ",
      });
      assert.equal(created.preprocessingEnabled, true);
      assert.deepEqual(created.preprocessingModel, { provider: "openai", id: "gpt-4o" });
      assert.equal(created.preprocessingPrompt, "Custom prompt");
      await writeSettings(created);
      const read = await readSettings();
      assert.ok(read.settings);
      assert.equal(read.settings!.preprocessingEnabled, true);
      assert.deepEqual(read.settings!.preprocessingModel, { provider: "openai", id: "gpt-4o" });
      assert.equal(read.settings!.preprocessingPrompt, "Custom prompt");
      // preserve via spread (voice change path)
      const updated = { ...read.settings!, voice: model.voices[1] ?? model.voices[0]! };
      await writeSettings(updated);
      const read2 = await readSettings();
      assert.equal(read2.settings!.preprocessingEnabled, true);
      assert.deepEqual(read2.settings!.preprocessingModel, { provider: "openai", id: "gpt-4o" });
      assert.equal(read2.settings!.preprocessingPrompt, "Custom prompt");
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("readSettings without preprocessing keys remains disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-pre-absent-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const model = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const base = settingsForModel(model.id, fakePath, { voice: model.voices[0] });
      await writeSettings(base);
      const read = await readSettings();
      assert.ok(read.settings);
      assert.equal(read.settings!.preprocessingEnabled, undefined);
      assert.equal(read.settings!.preprocessingModel, undefined);
      assert.equal(read.settings!.preprocessingPrompt, undefined);
      assert.equal(read.warning, undefined);
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("readSettings rejects invalid preprocessing shapes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-config-pre-invalid-"));
    const original = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const model = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const base = { version: 1, backend: { type: "kokoro" }, voice: "af_heart", speed: 1, model: { source: "catalog", id: model.id, path: fakePath } } as any;

      await writeFile(join(dir, "pi-speak.json"), JSON.stringify({ ...base, preprocessingEnabled: "true" }), "utf8");
      let r = await readSettings();
      assert.equal(r.settings, undefined);
      assert.ok(r.warning);

      await writeFile(join(dir, "pi-speak.json"), JSON.stringify({ ...base, preprocessingModel: { provider: " ", id: "gpt-4" } }), "utf8");
      r = await readSettings();
      assert.equal(r.settings, undefined);
      assert.ok(r.warning);

      await writeFile(join(dir, "pi-speak.json"), JSON.stringify({ ...base, preprocessingModel: { provider: "openai" } }), "utf8");
      r = await readSettings();
      assert.equal(r.settings, undefined);
      assert.ok(r.warning);

      await writeFile(join(dir, "pi-speak.json"), JSON.stringify({ ...base, preprocessingPrompt: 123 }), "utf8");
      r = await readSettings();
      assert.equal(r.settings, undefined);
      assert.ok(r.warning);

      await writeFile(join(dir, "pi-speak.json"), JSON.stringify({ ...base, preprocessingModel: "openai/gpt-4" }), "utf8");
      r = await readSettings();
      assert.equal(r.settings, undefined);
      assert.ok(r.warning);

      // whitespace prompt is valid and treated as absent
      await writeFile(join(dir, "pi-speak.json"), JSON.stringify({ ...base, preprocessingPrompt: "   " }), "utf8");
      r = await readSettings();
      assert.ok(r.settings);
      assert.equal(r.settings!.preprocessingPrompt, undefined);
      assert.equal(r.warning, undefined);

      // enabled true without model is valid (hard error at runtime, not validation)
      await writeFile(join(dir, "pi-speak.json"), JSON.stringify({ ...base, preprocessingEnabled: true }), "utf8");
      r = await readSettings();
      assert.ok(r.settings);
      assert.equal(r.settings!.preprocessingEnabled, true);
      assert.equal(r.warning, undefined);
    } finally {
      process.env.PI_CODING_AGENT_DIR = original;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("settingsForModel trims and preserves preprocessing fields", async () => {
    const model = CATALOG_MODELS[0]!;
    const fakePath = "/tmp/fake.onnx";
    const s = settingsForModel(model.id, fakePath, {
      preprocessingEnabled: true,
      preprocessingModel: { provider: "  openai  ", id: "  gpt-4o " },
      preprocessingPrompt: "  Hello  ",
    });
    assert.equal(s.preprocessingEnabled, true);
    assert.deepEqual(s.preprocessingModel, { provider: "openai", id: "gpt-4o" });
    assert.equal(s.preprocessingPrompt, "Hello");

    const s2 = settingsForModel(model.id, fakePath, { preprocessingModel: { provider: " ", id: " " } });
    assert.equal(s2.preprocessingModel, undefined);

    const s3 = settingsForModel(model.id, fakePath, { preprocessingPrompt: "   " });
    assert.equal(s3.preprocessingPrompt, undefined);

    const s4 = settingsForModel(model.id, fakePath, { preprocessingEnabled: false });
    assert.equal(s4.preprocessingEnabled, false);
  });
});
