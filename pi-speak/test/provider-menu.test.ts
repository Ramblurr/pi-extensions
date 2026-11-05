import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { showProviderSettings } from "../src/provider-menu.js";
import { readConfiguration, writeConfiguration, type SpeechConfiguration } from "../src/configuration.js";
import { settingsForModel } from "../src/settings.js";
import { CATALOG_MODELS } from "../src/catalog.js";

function context(answers: Array<string | undefined>, inputs: Array<string | undefined> = [], consent = true) {
  const notices: string[] = [];
  const confirmations: string[] = [];
  const ctx = {
    mode: "rpc", hasUI: true, scopedModels: [],
    modelRegistry: { refresh: async () => {}, getAvailable: () => [{ provider: "llm", id: "summary" }] },
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      select: async (_title: string, options: string[]) => {
        assert.ok(answers.length, `Unexpected menu: ${_title}`);
        const answer = answers.shift();
        if (answer === undefined) return undefined;
        const match = options.find((option) => option === answer || option.startsWith(answer));
        assert.ok(match, `Missing option ${answer} in ${options}`);
        return match;
      },
      input: async () => inputs.shift(),
      confirm: async (_title: string, text: string) => { confirmations.push(text); return consent; },
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notices, confirmations };
}
const pi = {} as ExtensionAPI;

test("provider settings UI", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-speak-provider-menu-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  process.env.PI_CODING_AGENT_DIR = dir;
  delete process.env.ELEVENLABS_API_KEY;
  const path = join(dir, "pi-speak.json");
  const modelPath = join(dir, "model.onnx");
  await writeFile(modelPath, "test model");
  const kokoro = settingsForModel(CATALOG_MODELS[0]!.id, modelPath, { preprocessingEnabled: true, preprocessingModel: { provider: "stale", id: "old" } });
  const local: SpeechConfiguration = { version: 2, provider: "kokoro", providers: { kokoro }, preprocessingEnabled: false, preprocessingPrompt: "Keep this prompt" };
  const cloud = { model: "eleven_v4", voice: "manual-id", stability: 0.5, similarity: 0.75, apiKey: "$ELEVENLABS_API_KEY" } as const;
  try {
    await t.test("provider cancel and denied cloud consent preserve the existing file", async () => {
      await writeConfiguration(local);
      const before = await readFile(path, "utf8");
      for (const answers of [[undefined], ["ElevenLabs (cloud)"]]) {
        const { ctx, confirmations } = context(answers, [], false);
        assert.deepEqual(await showProviderSettings(pi, ctx, local), local);
        assert.equal(await readFile(path, "utf8"), before);
        if (confirmations.length) assert.match(confirmations[0]!, /sent to ElevenLabs.*quota.*charges/);
      }
    });
    await t.test("cloud setup saves without any Kokoro configuration or API key", async () => {
      await rm(path);
      const { ctx, notices, confirmations } = context(["ElevenLabs (cloud)", "Enter voice ID", "Save"], ["", "manual-id"]);
      const expected = { version: 2, provider: "elevenlabs", providers: { elevenlabs: cloud } };
      assert.deepEqual(await showProviderSettings(pi, ctx), expected);
      assert.deepEqual(await readConfiguration(), { configuration: expected });
      assert.equal(confirmations.length, 1);
      assert.deepEqual(notices, []);
    });
    await t.test("first setup accepts command references without resolving them", async () => {
      await rm(path);
      const source = "!op read 'op://Private/ElevenLabs/api-key-quine'";
      const { ctx, notices } = context(["ElevenLabs (cloud)", "Enter voice ID", "Save"], [source, "manual-id"]);
      const result = await showProviderSettings(pi, ctx);
      assert.equal(result?.providers.elevenlabs?.apiKey, source);
      assert.deepEqual(await readConfiguration(), { configuration: result });
      assert.deepEqual(notices, []);
      const marker = join(dir, "must-not-exist");
      const edit = context(["ElevenLabs (cloud)", "API key source", "Save"], [`!touch ${marker}`]);
      const updated = await showProviderSettings(pi, edit.ctx, result);
      assert.equal(updated?.providers.elevenlabs?.apiKey, `!touch ${marker}`);
      await assert.rejects(readFile(marker), { code: "ENOENT" });
    });
    await t.test("credential source cancellation and literal rejection leave saved configuration unchanged", async () => {
      await writeConfiguration(local);
      const before = await readFile(path, "utf8");
      const initial = context(["ElevenLabs (cloud)"], [undefined]);
      assert.deepEqual(await showProviderSettings(pi, initial.ctx, local), local);
      assert.equal(await readFile(path, "utf8"), before);
      const existing: SpeechConfiguration = { ...local, provider: "elevenlabs", providers: { kokoro, elevenlabs: cloud } };
      await writeConfiguration(existing);
      const edit = context(["ElevenLabs (cloud)", "API key source", "Cancel"], ["sk-literal-secret", undefined]);
      assert.deepEqual(await showProviderSettings(pi, edit.ctx, existing), existing);
      assert.deepEqual(await readConfiguration(), { configuration: existing });
      assert.ok(edit.notices.some((notice) => notice.includes("not a literal API key")));
      assert.ok(edit.notices.every((notice) => !notice.includes("sk-literal-secret")));
    });
    await t.test("voice search pages explicitly and saves the selected ID", async () => {
      const originalFetch = globalThis.fetch;
      const originalSearchKey = process.env.PI_SPEAK_TEST_SEARCH_KEY;
      process.env.PI_SPEAK_TEST_SEARCH_KEY = "test-key-not-real";
      const urls: URL[] = [];
      globalThis.fetch = async (url, options) => {
        assert.equal(new Headers(options?.headers).get("xi-api-key"), "test-key-not-real");
        urls.push(new URL(String(url)));
        const second = urls.length === 2;
        return Response.json({ voices: [{ voice_id: second ? "second-id" : "first-id", name: second ? "Second" : "First", description: "Test voice" }], has_more: !second, ...(!second ? { next_page_token: "page-2" } : {}) });
      };
      try {
        await writeConfiguration(local);
        const { ctx } = context(["ElevenLabs (cloud)", "Search account voices", "Next page", "Second", "Save"], ["${PI_SPEAK_TEST_SEARCH_KEY}", "narrator"]);
        const result = await showProviderSettings(pi, ctx, local);
        assert.equal(result?.providers.elevenlabs?.voice, "second-id");
        assert.deepEqual(urls.map((url) => [url.searchParams.get("search"), url.searchParams.get("next_page_token")]), [["narrator", null], ["narrator", "page-2"]]);
        assert.ok(!(await readFile(path, "utf8")).includes("test-key-not-real"));
      } finally {
        globalThis.fetch = originalFetch;
        if (originalSearchKey === undefined) delete process.env.PI_SPEAK_TEST_SEARCH_KEY;
        else process.env.PI_SPEAK_TEST_SEARCH_KEY = originalSearchKey;
      }
    });
    await t.test("initial voice cancellation leaves no file", async () => {
      await rm(path);
      const { ctx } = context(["ElevenLabs (cloud)", undefined], [""]);
      assert.equal(await showProviderSettings(pi, ctx), undefined);
      assert.deepEqual(await readConfiguration(), {});
    });
    await t.test("cloud cancel discards draft edits and does not mutate caller", async () => {
      await writeConfiguration(local);
      const before = structuredClone(local);
      const { ctx } = context(["ElevenLabs (cloud)", "Enter voice ID", "Model", "eleven_v4_turbo", "Cancel"], ["", "manual-id"]);
      assert.deepEqual(await showProviderSettings(pi, ctx, local), before);
      assert.deepEqual(local, before);
      assert.deepEqual(await readConfiguration(), { configuration: before });
    });
    await t.test("cloud controls, preprocessing, and inactive Kokoro survive save", async () => {
      await writeConfiguration(local);
      const { ctx } = context([
        "ElevenLabs (cloud)", "Enter voice ID", "Model", "eleven_v4_turbo",
        "Stability", "Stability", "Similarity", "Preprocessing LLM", "llm/summary", "Save",
      ], ["", "manual-id", "2", "0", "1"]);
      const result = await showProviderSettings(pi, ctx, local);
      assert.deepEqual(result, { ...local, provider: "elevenlabs", providers: { kokoro, elevenlabs: { ...cloud, model: "eleven_v4_turbo", stability: 0, similarity: 1 } }, preprocessingEnabled: true, preprocessingModel: { provider: "llm", id: "summary" } });
      assert.deepEqual(await readConfiguration(), { configuration: result });
    });
    await t.test("Kokoro legacy menu writes only v2 and syncs authoritative preprocessing", async () => {
      const existing: SpeechConfiguration = { ...local, provider: "elevenlabs", providers: { kokoro, elevenlabs: cloud } };
      await writeConfiguration(existing);
      const { ctx } = context(["Kokoro (local)", "Preprocessing LLM", "llm/summary", "Done"]);
      const select = ctx.ui.select.bind(ctx.ui);
      ctx.ui.select = async (title, options) => {
        assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
        if (title === "pi-speak settings" && options.some((s) => s.startsWith("Preprocessing LLM") && s.includes("off"))) {
          assert.equal((await readConfiguration()).configuration?.providers.kokoro?.preprocessingEnabled, false);
        }
        return select(title, options);
      };
      const result = await showProviderSettings(pi, ctx, existing);
      assert.equal(result?.provider, "kokoro");
      assert.deepEqual(result?.providers.elevenlabs, cloud);
      assert.deepEqual(result?.preprocessingModel, { provider: "llm", id: "summary" });
      assert.equal(result?.preprocessingPrompt, local.preprocessingPrompt);
      assert.deepEqual(await readConfiguration(), { configuration: result });
    });
    await t.test("opening legacy Kokoro settings migrates to v2", async () => {
      await writeFile(path, JSON.stringify(kokoro));
      const { ctx } = context(["Kokoro (local)", "Done"]);
      const result = await showProviderSettings(pi, ctx);
      assert.equal(result?.version, 2);
      assert.deepEqual(result?.providers.kokoro, kokoro);
      assert.equal(JSON.parse(await readFile(path, "utf8")).version, 2);
    });
    await t.test("missing Kokoro file enters onboarding and cancellation preserves all settings", async () => {
      const originalCache = process.env.HF_HUB_CACHE;
      process.env.HF_HUB_CACHE = join(dir, "empty-hf-cache");
      try {
        const missing: SpeechConfiguration = { ...local, providers: { kokoro: { ...kokoro, voice: "af_bella", speed: 1.5, model: { ...kokoro.model, path: join(dir, "missing.onnx") } }, elevenlabs: cloud } };
        await writeConfiguration(missing);
        const before = await readFile(path, "utf8");
        const { ctx, confirmations } = context(["Kokoro (local)", undefined], [], false);
        Object.assign(ctx, { mode: "tui" });
        assert.deepEqual(await showProviderSettings(pi, ctx, missing), missing);
        assert.equal(await readFile(path, "utf8"), before);
        assert.ok(confirmations.some((text) => text.includes("Download")));
      } finally {
        if (originalCache === undefined) delete process.env.HF_HUB_CACHE;
        else process.env.HF_HUB_CACHE = originalCache;
      }
    });
    await t.test("invalid existing data is never replaced by onboarding", async () => {
      await writeFile(path, "not json");
      const { ctx, notices } = context([]);
      assert.equal(await showProviderSettings(pi, ctx), undefined);
      assert.equal(await readFile(path, "utf8"), "not json");
      assert.equal(notices.length, 1);
    });
  } finally {
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    await rm(dir, { recursive: true, force: true });
  }
});
