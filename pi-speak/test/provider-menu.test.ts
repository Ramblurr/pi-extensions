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
import { getElevenLabsVoice } from "../src/elevenlabs.js";
import { KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";

function context(answers: Array<string | undefined>, inputs: Array<string | undefined> = [], consent = true) {
  const notices: string[] = [];
  const confirmations: string[] = [];
  const menus: Array<{ title: string; options: string[] }> = [];
  const statuses: Array<string | undefined> = [];
  const ctx = {
    mode: "rpc", hasUI: true, scopedModels: [],
    modelRegistry: { refresh: async () => {}, getAvailable: () => [{ provider: "llm", id: "summary" }] },
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      select: async (_title: string, options: string[]) => {
        menus.push({ title: _title, options });
        assert.ok(answers.length, `Unexpected menu: ${_title}`);
        const answer = answers.shift();
        if (answer === undefined) return undefined;
        const match = options.find((option) => option === answer || option.replace(/^\d+\. /, "").startsWith(answer));
        assert.ok(match, `Missing option ${answer} in ${options}`);
        return match;
      },
      custom: async (factory: Parameters<ExtensionCommandContext["ui"]["custom"]>[0]) => {
        const answer = answers.shift();
        let result: unknown;
        // SAFETY: the picker uses only terminal.rows and requestRender from TUI.
        const tui = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
        const component = await factory(tui, ctx.ui.theme, new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<Parameters<ExtensionCommandContext["ui"]["custom"]>[0]>[2], (value) => { result = value; });
        for (let index = 0; index < 30; index++) {
          const lines = component.render(80);
          menus.push({ title: "Voice picker", options: lines });
          if (answer === undefined) { component.handleInput!("\x1b"); return result; }
          if (lines.some((line) => line.startsWith(`→ ${answer}`))) { component.handleInput!("\r"); return result; }
          component.handleInput!("\x1b[B");
        }
        assert.fail(`Could not select ${answer} in custom voice picker`);
      },
      setStatus: (_key: string, status: string | undefined) => statuses.push(status),
      input: async () => inputs.shift(),
      confirm: async (_title: string, text: string) => { confirmations.push(text); return consent; },
      notify: (text: string) => notices.push(text),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, notices, confirmations, menus, statuses };
}
const pi = {} as ExtensionAPI;

test("provider settings UI", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-speak-provider-menu-"));
  const original = process.env.PI_CODING_AGENT_DIR;
  const originalKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("No real network in settings tests"); };
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
    await t.test("first setup accepts command references; save alone does not resolve edited source", async () => {
      await rm(path);
      const source = "!printf synthetic-test-key";
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
    await t.test("voice search combines all pages and saves the selected ID", async () => {
      const originalFetch = globalThis.fetch;
      const originalSearchKey = process.env.PI_SPEAK_TEST_SEARCH_KEY;
      process.env.PI_SPEAK_TEST_SEARCH_KEY = "test-key-not-real";
      const urls: URL[] = [];
      globalThis.fetch = async (url, options) => {
        assert.equal(new Headers(options?.headers).get("xi-api-key"), "test-key-not-real");
        urls.push(new URL(String(url)));
        const second = urls.length === 2;
        return Response.json({ voices: [{ voice_id: second ? "second-id" : "first-id", name: second ? "Second" : "First", description: "Test narrator voice" }], has_more: !second, ...(!second ? { next_page_token: "page-2" } : {}) });
      };
      try {
        await writeConfiguration(local);
        const { ctx } = context(["ElevenLabs (cloud)", "Search account voices", "Second", "Save"], ["${PI_SPEAK_TEST_SEARCH_KEY}", "narrator"]);
        const result = await showProviderSettings(pi, ctx, local);
        assert.equal(result?.providers.elevenlabs?.voice, "second-id");
        assert.equal(result?.providers.elevenlabs?.voiceName, "Second");
        assert.equal((await readConfiguration()).configuration?.providers.elevenlabs?.voiceName, "Second");
        assert.deepEqual(urls.map((url) => [url.searchParams.get("search"), url.searchParams.get("next_page_token")]), [[null, null], [null, "page-2"]]);
        assert.ok(!(await readFile(path, "utf8")).includes("test-key-not-real"));
      } finally {
        globalThis.fetch = originalFetch;
        if (originalSearchKey === undefined) delete process.env.PI_SPEAK_TEST_SEARCH_KEY;
        else process.env.PI_SPEAK_TEST_SEARCH_KEY = originalSearchKey;
      }
    });
    await t.test("browse combines pages, deduplicates IDs and sorts names before opening the picker", async () => {
      const previousFetch = globalThis.fetch;
      process.env.ELEVENLABS_API_KEY = "synthetic-browse-key";
      const urls: URL[] = [];
      globalThis.fetch = async (url) => {
        urls.push(new URL(String(url)));
        const second = urls.length === 2;
        return Response.json({ voices: second
          ? [{ voice_id: "b-id", name: "Brian" }, { voice_id: "a-id", name: "Alice" }, { voice_id: "z-id", name: "Duplicate ignored" }]
          : [{ voice_id: "z-id", name: "Zulu" }, { voice_id: "c-id", name: "brian" }],
          has_more: !second, ...(!second ? { next_page_token: "next" } : {}) });
      };
      try {
        await writeConfiguration(local);
        const { ctx, menus } = context(["ElevenLabs (cloud)", "Browse account voices", "Brian", "Save"]);
        Object.assign(ctx, { mode: "tui" });
        let inputCount = 0;
        ctx.ui.input = async () => { assert.equal(++inputCount, 1, "only credential source input is needed"); return ""; };
        const result = await showProviderSettings(pi, ctx, local);
        assert.equal(result?.providers.elevenlabs?.voiceName, "Brian");
        assert.equal((await readConfiguration()).configuration?.providers.elevenlabs?.voiceName, "Brian");
        assert.deepEqual(urls.map((url) => [url.pathname, url.searchParams.get("search"), url.searchParams.get("next_page_token")]), [["/v2/voices", null, null], ["/v2/voices", null, "next"]]);
        assert.ok(menus.some((menu) => menu.options.includes("Voice · Brian · b-id")));
        assert.deepEqual(menus.find((menu) => menu.title === "Voice picker")?.options.slice(2, 6), ["→ Alice", "  Brian", "  brian", "  Zulu"]);
        assert.ok(menus.every((menu) => menu.options.every((option) => !option.includes("Next page"))));
        assert.deepEqual(menus.find((menu) => menu.title === "ElevenLabs voice")?.options, ["Browse account voices", "Search account voices", "Enter voice ID"]);
      } finally {
        globalThis.fetch = previousFetch;
        delete process.env.ELEVENLABS_API_KEY;
      }
    });
    await t.test("initial search can broaden locally without fetching or synthesizing", async () => {
      process.env.ELEVENLABS_API_KEY = "synthetic-local-search-key";
      let requests = 0;
      let previews = 0;
      globalThis.fetch = async (url) => {
        requests++;
        assert.equal(new URL(String(url)).searchParams.get("search"), null);
        return Response.json({ voices: [
          { voice_id: "a", name: "Alice", labels: { gender: "female" } },
          { voice_id: "b", name: "Brian", labels: { gender: "male" } },
        ], has_more: false });
      };
      try {
        const existing: SpeechConfiguration = { ...local, provider: "elevenlabs", providers: { elevenlabs: { ...cloud, voiceName: "Original" } } };
        const { ctx } = context(["ElevenLabs (cloud)", "Voice", "Search account voices", "Save"], ["Alice"]);
        Object.assign(ctx, { mode: "tui" });
        ctx.ui.custom = async (factory) => {
          let result: unknown;
          const tui = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
          const component = await factory(tui, ctx.ui.theme, new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<typeof factory>[2], (value) => { result = value; });
          assert.match(component.render(100).join("\n"), /1\/2 voices.*Search: Alice/);
          component.handleInput!("/");
          component.handleInput!("\x15"); // native Ctrl+U clears the initial query
          assert.match(component.render(100).join("\n"), /2\/2 voices/);
          component.handleInput!("\r");
          component.handleInput!("\x1b[B");
          component.handleInput!("\r");
          assert.equal(requests, 1);
          assert.equal(previews, 0);
          return result as never;
        };
        const result = await showProviderSettings(pi, ctx, existing, async () => { previews++; });
        assert.equal(result?.providers.elevenlabs?.voice, "b");
      } finally {
        globalThis.fetch = originalFetch;
        delete process.env.ELEVENLABS_API_KEY;
      }
    });
    await t.test("repeated pagination token fails finitely and clears whole-fetch loading status", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const previousFetch = globalThis.fetch;
      process.env.ELEVENLABS_API_KEY = "synthetic-pages-key";
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        assert.ok(calls <= 2, "must not fetch a repeated token again");
        t.mock.timers.tick(120);
        return Response.json({ voices: [], has_more: true, next_page_token: "do-not-echo-token" });
      };
      try {
        await writeConfiguration(local);
        const { ctx, notices, statuses, menus } = context(["ElevenLabs (cloud)", "Browse account voices"], [""]);
        assert.deepEqual(await showProviderSettings(pi, ctx, local), local);
        assert.equal(calls, 2);
        assert.ok(notices.some((notice) => notice.includes("repeated page token")));
        assert.ok(notices.every((notice) => !notice.includes("do-not-echo-token")));
        assert.deepEqual(statuses, ["Loading voices…", undefined], "delay spans pages, rather than resetting per page");
        assert.ok(menus.every((menu) => menu.title !== "Account voices"));
        assert.deepEqual(await readConfiguration(), { configuration: local });
      } finally {
        globalThis.fetch = previousFetch;
        delete process.env.ELEVENLABS_API_KEY;
      }
    });
    await t.test("saved ID resolves directly; manual edit replaces stale name; unavailable names stay editable", async () => {
      const previousFetch = globalThis.fetch;
      process.env.ELEVENLABS_API_KEY = "synthetic-lookup-key";
      const urls: string[] = [];
      globalThis.fetch = async (url) => {
        urls.push(String(url));
        const id = new URL(String(url)).pathname.split("/").at(-1);
        if (id === "unavailable") return new Response("private response", { status: 403 });
        return Response.json({ voice_id: id, name: id === "manual-id" ? "Brian" : "Alice" });
      };
      try {
        const existing: SpeechConfiguration = { ...local, provider: "elevenlabs", providers: { elevenlabs: cloud } };
        await writeConfiguration(existing);
        const first = context(["ElevenLabs (cloud)", "Voice", "Enter voice ID", "Save"], ["new-id"]);
        const changed = await showProviderSettings(pi, first.ctx, existing);
        assert.equal(changed?.providers.elevenlabs?.voiceName, "Alice");
        assert.ok(first.menus.some((menu) => menu.options.includes("Voice · Brian · manual-id")));
        assert.ok(first.menus.some((menu) => menu.options.includes("Voice · Alice · new-id")));
        assert.deepEqual(urls.map((url) => new URL(url).pathname), ["/v1/voices/manual-id", "/v1/voices/new-id"]);
        const failed = context(["ElevenLabs (cloud)", "Voice", "Enter voice ID", "API key source", "Save"], ["unavailable", "$MISSING_KEY"]);
        const result = await showProviderSettings(pi, failed.ctx, changed);
        assert.equal(result?.providers.elevenlabs?.voiceName, undefined);
        assert.equal(result?.providers.elevenlabs?.voice, "unavailable");
        assert.ok(failed.menus.some((menu) => menu.options.includes("Voice · name unavailable · unavailable")));
        assert.equal(result?.providers.elevenlabs?.apiKey, "$MISSING_KEY");
        assert.ok(failed.notices.every((notice) => !notice.includes("private response")));
      } finally {
        globalThis.fetch = previousFetch;
        delete process.env.ELEVENLABS_API_KEY;
      }
    });
    await t.test("empty search returns to browse/manual choices", async () => {
      const previousFetch = globalThis.fetch;
      process.env.ELEVENLABS_API_KEY = "synthetic-empty-key";
      globalThis.fetch = async () => Response.json({ voices: [], has_more: false });
      try {
        await writeConfiguration(local);
        const { ctx, notices, menus } = context(["ElevenLabs (cloud)", "Search account voices", "Enter voice ID", "Save"], ["", "absent", "manual-id"]);
        const result = await showProviderSettings(pi, ctx, local);
        assert.equal(result?.providers.elevenlabs?.voice, "manual-id");
        assert.equal(menus.filter((menu) => menu.title === "ElevenLabs voice").length, 2);
        assert.ok(notices.some((notice) => notice.includes("Browse account voices")));
      } finally {
        globalThis.fetch = previousFetch;
        delete process.env.ELEVENLABS_API_KEY;
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
    await t.test("voice loading status is delayed and cleared after success and failure", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const previousFetch = globalThis.fetch;
      process.env.ELEVENLABS_API_KEY = "synthetic-status-key";
      const existing: SpeechConfiguration = { ...local, provider: "elevenlabs", providers: { elevenlabs: cloud } };
      try {
        globalThis.fetch = async () => Response.json({ voice_id: "manual-id", name: "Brian" });
        const fast = context(["ElevenLabs (cloud)", "Cancel"]);
        await showProviderSettings(pi, fast.ctx, existing);
        t.mock.timers.tick(1000);
        assert.deepEqual(fast.statuses, [], "fast lookup never flickers");
        for (const fail of [false, true]) {
          let start!: () => void;
          let finish!: () => void;
          const started = new Promise<void>((resolve) => { start = resolve; });
          globalThis.fetch = async () => {
            start();
            await new Promise<void>((resolve) => { finish = resolve; });
            if (fail) throw new Error("synthetic network failure");
            return Response.json({ voice_id: "manual-id", name: "Brian" });
          };
          const slow = context(["ElevenLabs (cloud)", "Cancel"]);
          const pending = showProviderSettings(pi, slow.ctx, existing);
          await started;
          t.mock.timers.tick(199);
          assert.deepEqual(slow.statuses, []);
          t.mock.timers.tick(1);
          assert.deepEqual(slow.statuses, ["Loading voices…"]);
          finish();
          await pending;
          assert.deepEqual(slow.statuses, ["Loading voices…", undefined]);
          t.mock.timers.tick(1000);
          assert.equal(slow.statuses.length, 2, "no orphaned status timer");
        }
      } finally {
        globalThis.fetch = previousFetch;
        delete process.env.ELEVENLABS_API_KEY;
      }
    });
    await t.test("preview receives unsaved cloud settings and cancels its own signal on picker close", async (t) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const previousFetch = globalThis.fetch;
      process.env.ELEVENLABS_API_KEY = "synthetic-preview-key";
      globalThis.fetch = async () => Response.json({ voices: [{ voice_id: "preview-id", name: "Brian", description: "Narrator" }], has_more: false });
      try {
        const existing: SpeechConfiguration = { ...local, provider: "elevenlabs", providers: { elevenlabs: { ...cloud, voiceName: "Original" } } };
        const { ctx } = context(["ElevenLabs (cloud)", "Model", "eleven_v4_turbo", "Stability", "Voice", "Browse account voices", "Cancel"], ["0.25"]);
        Object.assign(ctx, { mode: "tui" });
        let requested: { config: unknown; voice: string; signal: AbortSignal } | undefined;
        ctx.ui.custom = async (factory) => {
          let result: unknown;
          // SAFETY: this real component only needs rows and requestRender from TUI.
          const tui = { terminal: { rows: 24 }, requestRender: () => {} } as unknown as TUI;
          const component = await factory(tui, ctx.ui.theme, new KeybindingsManager(TUI_KEYBINDINGS) as Parameters<typeof factory>[2], (value) => { result = value; });
          component.render(80);
          component.handleInput!("p");
          t.mock.timers.tick(300);
          await new Promise<void>((resolve) => setImmediate(resolve));
          component.handleInput!("\x1b");
          return result as never;
        };
        await showProviderSettings(pi, ctx, existing, async (config, voice, signal) => {
          requested = { config: structuredClone(config), voice, signal };
          await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
        });
        assert.deepEqual(requested?.config, { ...cloud, voiceName: "Original", model: "eleven_v4_turbo", stability: 0.25 });
        assert.equal(requested?.voice, "preview-id");
        assert.equal(requested?.signal.aborted, true);
        assert.equal(existing.providers.elevenlabs?.model, "eleven_v4", "preview does not persist draft edits");
      } finally {
        globalThis.fetch = previousFetch;
        delete process.env.ELEVENLABS_API_KEY;
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
    globalThis.fetch = originalFetch;
    if (original === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = original;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    await rm(dir, { recursive: true, force: true });
  }
});

test("single voice lookup uses direct endpoint and redacts failures", async () => {
  const voice = await getElevenLabsVoice("id/encoded", undefined, {
    apiKey: async () => "synthetic-key",
    fetch: async (url, options) => {
      assert.equal(String(url), "https://api.elevenlabs.io/v1/voices/id%2Fencoded");
      assert.equal(new Headers(options?.headers).get("xi-api-key"), "synthetic-key");
      assert.equal(options?.redirect, "error");
      return Response.json({ voice_id: "id/encoded", name: "Brian", description: "Narrator" });
    },
  });
  assert.deepEqual(voice, { id: "id/encoded", name: "Brian", description: "Narrator" });
  for (const response of [new Response("secret-body", { status: 403 }), Response.json({ voice_id: "wrong", name: "secret-body" })]) {
    await assert.rejects(getElevenLabsVoice("id", undefined, { apiKey: () => "synthetic-key", fetch: async () => response }), (error: Error) => !error.message.includes("secret-body"));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(getElevenLabsVoice("id", controller.signal, { apiKey: () => { throw new Error("must not resolve"); } }), { name: "AbortError" });
  await assert.rejects(getElevenLabsVoice("id", undefined, {
    apiKey: () => "synthetic-key", timeoutMs: 5,
    fetch: async (_url, options) => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      options?.signal?.throwIfAborted();
      return Response.json({ voice_id: "id", name: "Brian" });
    },
  }), { name: "TimeoutError" });
});
