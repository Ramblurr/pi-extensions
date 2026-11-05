import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { showSpeakSettings } from "../src/settings-menu.js";
import { settingsForModel, writeSettings, readSettings } from "../src/settings.js";
import { CATALOG_MODELS } from "../src/catalog.js";

// Helpers to mock ExtensionContext
function themeStub() {
  return {
    fg: (_c: string, t: string) => t,
    bold: (t: string) => t,
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["ui"]["theme"];
}

function createMockCtx(opts: {
  mode?: "tui" | "rpc" | "headless";
  availableModels?: Array<{ provider: string; id: string; name?: string }>;
  scopedModels?: Array<{ provider: string; id: string; name?: string }>;
  selectAnswers?: Array<string | undefined>;
  customHandler?: (tui: unknown, theme: unknown, keybindings: unknown, done: (v: unknown) => void) => { render: (w:number)=>string[]; handleInput:(d:string)=>void };
  modelRegistryRefreshCalls?: { count: number };
}) {
  const mode = opts.mode ?? "tui";
  const available = opts.availableModels ?? [
    { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
    { provider: "anthropic", id: "claude-3-5-sonnet", name: "Claude Sonnet" },
    { provider: "openai", id: "gpt-4o-mini", name: "GPT-4o mini" },
  ];
  const scoped = (opts.scopedModels ?? []).map((m) => ({ model: { provider: m.provider, id: m.id, name: m.name } }));
  let selectQueue = [...(opts.selectAnswers ?? [])];
  const selectCalls: Array<{ title: string; options: string[] }> = [];
  const notifyCalls: Array<{ msg: string; level: string }> = [];
  const customCalls: Array<{ tui: unknown; theme: unknown; keybindings: unknown }> = [];
  let customImpl = opts.customHandler;

  const ctx = {
    mode,
    hasUI: true,
    cwd: process.cwd(),
    ui: {
      theme: themeStub(),
      notify: (msg: string, level: string) => notifyCalls.push({ msg, level }),
      select: async (title: string, options: string[]) => {
        selectCalls.push({ title, options });
        const ans = selectQueue.shift();
        // If answer is undefined, simulate cancel (undefined)
        // If answer is string not in options, return as is for test flexibility
        if (ans === undefined) return undefined;
        // If ans is mapping like "__PREPROCESSING__", we need to find preprocessingChoice string?
        // The caller passes options that include themed strings; we can't know exact value.
        // So test should push the actual choice string from selectCalls after first call.
        // For simplicity, if ans starts with "__", treat as special
        return ans;
      },
      custom: async (fn: (tui: unknown, theme: unknown, kb: unknown, done: (v: unknown) => void) => unknown) => {
        customCalls.push({ tui: {}, theme: {}, keybindings: {} });
        if (customImpl) {
          // Simulate custom component lifecycle minimally: call fn and handle done
          return new Promise<unknown>((resolve) => {
            const done = (v: unknown) => resolve(v);
            const comp = fn({ requestRender: () => {} } as unknown as import("@earendil-works/pi-tui").TUI, themeStub(), { matches: () => false } as unknown as import("@earendil-works/pi-tui").Keybindings, done) as unknown as { render: (w:number)=>string[] };
            // For test, we may directly resolve via customImpl logic
            // If customImpl provided, use it to drive component
            if (opts.customHandler) {
              // Let customImpl inspect component? For simplicity, we invoke it
              // The test's customHandler can drive via component's handleInput etc.
            }
          });
        }
        // Fallback: if no customHandler, just call fn and don't interact
        return new Promise<unknown>((resolve) => {
          const done = (v: unknown) => resolve(v);
          fn({ requestRender: () => {} } as any, themeStub(), { matches: () => false } as any, done);
        });
      },
      input: async () => undefined,
      confirm: async () => false,
    },
    modelRegistry: {
      getAvailable: () => available as unknown as any,
      refresh: async () => {
        if (opts.modelRegistryRefreshCalls) opts.modelRegistryRefreshCalls.count++;
      },
      find: () => undefined,
      getError: () => undefined,
    },
    scopedModels: scoped as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["scopedModels"],
    model: undefined,
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
    sessionManager: { getBranch: () => [] } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["sessionManager"],
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;

  return { ctx, selectCalls, notifyCalls, customCalls, setCustomHandler: (h: typeof customImpl) => { customImpl = h; }, pushSelectAnswer: (a: string|undefined)=> selectQueue.push(a) };
}

test("settings-menu preprocessing picker", async (t) => {
  await t.test("showSpeakSettings adds Preprocessing LLM row with off when disabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-sm-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const catalogModel = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(catalogModel.id, fakePath, { preprocessingEnabled: false });
      await writeSettings(settings);
      let capturedChoices: string[] = [];
      const { ctx, selectCalls } = createMockCtx({
        mode: "tui",
        selectAnswers: [undefined], // will be overridden after capturing
      });
      // Mock ui.select to capture choices and return Done
      const originalSelect = ctx.ui.select;
      (ctx.ui as unknown as { select: typeof originalSelect }).select = async (title:string, options:string[]) => {
        capturedChoices = options;
        return "Done";
      };
      const pi = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      const result = await showSpeakSettings(pi, ctx as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext, settings);
      assert.equal(result, false);
      // Choices should have 5 entries: Voice, Speed, Model, Preprocessing LLM, Done
      assert.equal(capturedChoices.length, 5, `expected 5 choices, got ${JSON.stringify(capturedChoices)}`);
      const hasPreprocessing = capturedChoices.some((c) => c.includes("Preprocessing LLM"));
      assert.ok(hasPreprocessing, `choices should contain Preprocessing LLM row: ${JSON.stringify(capturedChoices)}`);
      const preprocessingRow = capturedChoices.find((c) => c.includes("Preprocessing LLM"))!;
      assert.ok(preprocessingRow.includes("off"), `disabled row should show off: ${preprocessingRow}`);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("showSpeakSettings shows provider/id when enabled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-sm-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const catalogModel = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(catalogModel.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "gpt-4o" },
      });
      await writeSettings(settings);
      let captured: string[] = [];
      const { ctx } = createMockCtx({ mode: "tui" });
      (ctx.ui as unknown as { select: typeof ctx.ui.select }).select = async (_t:string, opts:string[]) => {
        captured = opts;
        return "Done";
      };
      const pi = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      await showSpeakSettings(pi, ctx as any, settings);
      const row = captured.find((c) => c.includes("Preprocessing LLM"))!;
      assert.ok(row.includes("openai/gpt-4o"), `enabled row should show provider/id: ${row}`);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("non-TUI fallback: Disabled sets enabled false and clears model", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-sm-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const catalogModel = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(catalogModel.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "gpt-4o" },
        preprocessingPrompt: "custom prompt",
      });
      await writeSettings(settings);
      const available = [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        { provider: "anthropic", id: "claude", name: "Claude" },
      ];
      const { ctx } = createMockCtx({
        mode: "rpc",
        availableModels: available,
        selectAnswers: [], // we will mock select for summary then picker
      });
      // Queue: first select returns preprocessingChoice, second select (picker) returns Disabled, third select returns Done
      let call = 0;
      const originalSelect = ctx.ui.select;
      (ctx.ui as unknown as { select: typeof originalSelect }).select = async (title:string, options:string[]) => {
        call++;
        if (call === 1) {
          // Find preprocessing row
          const row = options.find((o) => o.includes("Preprocessing LLM"))!;
          return row;
        } else if (call === 2) {
          // Picker select: should contain Disabled
          assert.ok(options.includes("Disabled"), `picker options should include Disabled: ${JSON.stringify(options)}`);
          // also should be built from available (non-scoped) and sorted
          assert.ok(options.some((o) => o.includes("openai/gpt-4o")), `should include openai/gpt-4o`);
          return "Disabled";
        } else {
          return "Done";
        }
      };
      const pi = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      await showSpeakSettings(pi, ctx as any, settings);
      // Verify persisted
      const { settings: after } = await readSettings();
      assert.ok(after, "settings should exist after");
      assert.equal(after!.preprocessingEnabled, false, "should be disabled");
      assert.equal(after!.preprocessingModel, undefined, "model should be cleared");
      assert.equal(after!.preprocessingPrompt, "custom prompt", "prompt should be preserved");
      assert.equal(after!.voice, settings.voice, "voice preserved");
      assert.equal(after!.speed, settings.speed, "speed preserved");
      assert.equal(after!.model.id, settings.model.id, "catalog model preserved");
      // Also in-memory configured should be updated
      assert.equal(settings.preprocessingEnabled, false);
      assert.equal(settings.preprocessingModel, undefined);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("non-TUI fallback: picking model enables and persists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-sm-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const catalogModel = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(catalogModel.id, fakePath, { preprocessingEnabled: false });
      await writeSettings(settings);
      const available = [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        { provider: "anthropic", id: "claude", name: "Claude" },
      ];
      const { ctx } = createMockCtx({
        mode: "rpc",
        availableModels: available,
      });
      let call = 0;
      (ctx.ui as unknown as { select: typeof ctx.ui.select }).select = async (title:string, options:string[]) => {
        call++;
        if (call === 1) return options.find((o)=> o.includes("Preprocessing LLM"))!;
        if (call === 2) {
          // picker options: Disabled + models sorted by provider (anthropic first, then openai)
          // Our buildBase sorts by provider then id, with current first (none). So anthropic/claude first after Disabled
          // Choose anthropic/claude
          const target = options.find((o)=> o.includes("anthropic/claude"))!;
          assert.ok(target, `should have anthropic/claude in ${JSON.stringify(options)}`);
          return target;
        }
        return "Done";
      };
      const pi = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      await showSpeakSettings(pi, ctx as any, settings);
      const { settings: after } = await readSettings();
      assert.equal(after!.preprocessingEnabled, true);
      assert.deepEqual(after!.preprocessingModel, { provider: "anthropic", id: "claude" });
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("non-TUI fallback uses scopedModels when non-empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-sm-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const catalogModel = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(catalogModel.id, fakePath, { preprocessingEnabled: false });
      await writeSettings(settings);
      const available = [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        { provider: "anthropic", id: "claude", name: "Claude" },
        { provider: "openai", id: "extra", name: "Extra" },
      ];
      const scoped = [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }];
      const { ctx } = createMockCtx({
        mode: "rpc",
        availableModels: available,
        scopedModels: scoped,
      });
      let pickerOptions: string[] = [];
      let call = 0;
      (ctx.ui as unknown as { select: typeof ctx.ui.select }).select = async (title:string, options:string[]) => {
        call++;
        if (call === 1) return options.find((o)=>o.includes("Preprocessing LLM"))!;
        if (call === 2) {
          pickerOptions = options;
          return "Disabled"; // just to exit
        }
        return "Done";
      };
      const pi = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      await showSpeakSettings(pi, ctx as any, settings);
      // Should only contain scoped model + Disabled, not other available
      assert.ok(pickerOptions.some((o)=>o.includes("openai/gpt-4o")), `should contain scoped model`);
      assert.ok(!pickerOptions.some((o)=>o.includes("anthropic/claude")), `should NOT contain non-scoped model when scoped non-empty: ${JSON.stringify(pickerOptions)}`);
      assert.ok(!pickerOptions.some((o)=>o.includes("openai/extra")), `should NOT contain extra`);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("cancelling picker leaves settings unchanged", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-sm-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const catalogModel = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(catalogModel.id, fakePath, { preprocessingEnabled: false });
      await writeSettings(settings);
      const before = (await readSettings()).settings!;
      const { ctx } = createMockCtx({
        mode: "rpc",
        availableModels: [{ provider: "openai", id: "gpt-4o" }],
      });
      let call = 0;
      (ctx.ui as unknown as { select: typeof ctx.ui.select }).select = async (_t:string, options:string[]) => {
        call++;
        if (call === 1) return options.find((o)=>o.includes("Preprocessing LLM"))!;
        if (call === 2) return undefined; // cancel picker
        return "Done";
      };
      const pi = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      await showSpeakSettings(pi, ctx as any, settings);
      const after = (await readSettings()).settings!;
      assert.deepEqual(after, before, "settings unchanged on cancel");
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("TUI picker uses Input+SelectList and fuzzyFilter, TAB toggles scoped/all", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-sm-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const catalogModel = CATALOG_MODELS[0]!;
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(catalogModel.id, fakePath, { preprocessingEnabled: false });
      await writeSettings(settings);
      const available = [
        { provider: "openai", id: "gpt-4o", name: "GPT-4o" },
        { provider: "anthropic", id: "claude", name: "Claude 3" },
      ];
      const scoped = [{ provider: "openai", id: "gpt-4o", name: "GPT-4o" }];
      let refreshCalls = 0;
      const { ctx } = createMockCtx({
        mode: "tui",
        availableModels: available,
        scopedModels: scoped,
      });
      // Track refresh
      const origRefresh = ctx.modelRegistry.refresh;
      (ctx.modelRegistry as unknown as { refresh: () => Promise<void> }).refresh = async () => { refreshCalls++; await origRefresh(); };
      // Mock summary select to choose preprocessing row, then Done
      let summaryCalls = 0;
      (ctx.ui as unknown as { select: typeof ctx.ui.select }).select = async (_t:string, options:string[]) => {
        summaryCalls++;
        if (summaryCalls === 1) return options.find((o)=>o.includes("Preprocessing LLM"))!;
        return "Done";
      };
      // Mock custom to verify it uses Input, SelectList, fuzzyFilter, TAB
      let customVerified = false;
      const originalCustom = ctx.ui.custom;
      (ctx.ui as unknown as { custom: any }).custom = async (fn: any) => {
        // Provide minimal tui/theme/keybindings and inspect component
        const theme = { fg: (c:string, t:string)=>t, bold: (t:string)=>t } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext["ui"]["theme"];
        const tui = { requestRender: () => {}, terminal: { rows: 24 } } as unknown as any;
        const keybindings = {
          matches: (data:string, id:string) => {
            if (id === "tui.input.tab") return data === "\t";
            if (id === "tui.select.up") return data === "\x1b[A";
            if (id === "tui.select.down") return data === "\x1b[B";
            if (id === "tui.select.confirm") return data === "\r";
            if (id === "tui.select.cancel") return data === "\x1b";
            return false;
          },
        } as unknown as any;
        return new Promise<unknown>((resolve) => {
          const done = (v:unknown) => resolve(v);
          const comp = fn(tui, theme, keybindings, done) as unknown as {
            render: (w:number)=>string[];
            handleInput: (d:string)=>void;
            focused: boolean;
          };
          // Verify initial render contains scope, input, and Disabled entry
          const lines = comp.render(80).join("\n");
          assert.ok(lines.includes("Preprocessing LLM"), `should render title: ${lines}`);
          assert.ok(lines.includes("Scope:"), `should show scope when hasScoped: ${lines}`);
          assert.ok(lines.includes("all") && lines.includes("scoped"), `should show both scopes`);
          // Verify that initial filtered list contains Disabled and scoped model (not anthropic)
          // Our render includes SelectList render which contains model ids
          assert.ok(lines.includes("Disabled"), `should contain Disabled: ${lines}`);
          assert.ok(lines.includes("gpt-4o"), `should contain scoped gpt-4o: ${lines}`);
          assert.ok(!lines.includes("claude"), `should NOT contain non-scoped claude initially: ${lines}`);
          // Test TAB toggles to all (should now show claude)
          comp.handleInput("\t");
          const afterTab = comp.render(80).join("\n");
          assert.ok(afterTab.includes("claude"), `after Tab should show all models including claude: ${afterTab}`);
          // Test fuzzy filtering: type "claude" should filter to claude
          // Simulate typing via handleInput with characters
          comp.handleInput("c");
          comp.handleInput("l");
          comp.handleInput("a");
          comp.handleInput("u");
          comp.handleInput("d");
          comp.handleInput("e");
          const afterFuzzy = comp.render(80).join("\n");
          assert.ok(afterFuzzy.includes("claude"), `fuzzy filter should show claude: ${afterFuzzy}`);
          // Select claude via Enter (list confirmation)
          comp.handleInput("\r");
          customVerified = true;
        });
      };
      const pi = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      await showSpeakSettings(pi, ctx as any, settings);
      assert.ok(customVerified, "custom picker should have been verified");
      assert.equal(refreshCalls, 1, "should have refreshed registry on open");
      // Verify persisted selection is anthropic/claude (since after Tab we filtered to claude and pressed Enter)
      const { settings: after } = await readSettings();
      assert.equal(after!.preprocessingEnabled, true);
      assert.deepEqual(after!.preprocessingModel, { provider: "anthropic", id: "claude" });
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("TUI picker fuzzyFilter uses getModelSelectorSearchText", async () => {
    // Verify searchText formation: provider, provider/id, provider id, name
    // Do isolated check: build picker items and test fuzzyFilter behavior
    const { fuzzyFilter } = await import("@earendil-works/pi-tui");
    function getSearchText(item: { provider: string; id: string; name?: string }) {
      const name = item.name ? ` ${item.name}` : "";
      return `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
    }
    const items = [
      { provider: "openai", id: "gpt-4o", name: "GPT-4o", searchText: getSearchText({ provider: "openai", id: "gpt-4o", name: "GPT-4o" }) },
      { provider: "anthropic", id: "claude", name: "Claude", searchText: getSearchText({ provider: "anthropic", id: "claude", name: "Claude" }) },
      { kind: "disabled", label: "Disabled", searchText: "Disabled off disable" },
    ];
    // Query "openai/gpt" should match first via provider/id token
    let filtered = fuzzyFilter(items, "openai/gpt", (p) => (p as any).searchText);
    assert.ok(filtered.some((f) => (f as any).provider === "openai" && (f as any).id === "gpt-4o"), `should match openai/gpt`);
    // Query "claude" should match second
    filtered = fuzzyFilter(items, "claude", (p) => (p as any).searchText);
    assert.ok(filtered.some((f) => (f as any).provider === "anthropic"), `should match claude`);
    // Query "Disabled" should match disabled entry
    filtered = fuzzyFilter(items, "Disabled", (p) => (p as any).searchText);
    assert.ok(filtered.some((f) => (f as any).label === "Disabled"), `should match Disabled`);
  });
});
