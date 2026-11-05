import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPiSpeakRuntime } from "../src/runtime.js";
import { settingsForModel, writeSettings } from "../src/settings.js";
import { CATALOG_MODELS } from "../src/catalog.js";
import { DEFAULT_PREPROCESSING_PROMPT } from "../src/text.js";
import { deferred, nextTurn } from "./helpers.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PiSpeakSettings } from "../src/settings.js";

function createFakeSynthesisService() {
  const calls: Array<{ settings: PiSpeakSettings; text: string }> = [];
  let shouldFail = false;
  let failMessage = "synthesis fail";
  let gate: ReturnType<typeof deferred<void>> | undefined;

  return {
    calls,
    setGate(g: ReturnType<typeof deferred<void>>) {
      gate = g;
    },
    setShouldFail(v: boolean, msg = "synthesis fail") {
      shouldFail = v;
      failMessage = msg;
    },
    service: {
      async synthesize(settings: PiSpeakSettings, text: string) {
        calls.push({ settings, text });
        if (gate) await gate.promise;
        if (shouldFail) throw new Error(failMessage);
        return Buffer.from("fake-wav");
      },
      async shutdown() {},
    } as unknown as import("../src/synthesis-service.js").SynthesisService,
  };
}

function createMockCtx(
  branch: unknown[],
  opts: {
    find?: (provider: string, id: string) => unknown;
    hasUI?: boolean;
  } = {},
) {
  const notifications: Array<{ message: string; level: string }> = [];
  const widgets: Array<{ key: string; value: unknown }> = [];
  const ctx = {
    hasUI: opts.hasUI ?? true,
    mode: "tui" as const,
    cwd: process.cwd(),
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
      setWidget: (key: string, value: unknown) => {
        widgets.push({ key, value });
      },
      theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
      // minimal stubs for settings-menu etc not needed
      custom: async () => {},
      select: async () => undefined,
      input: async () => undefined,
    },
    sessionManager: {
      getBranch: () => branch,
    },
    modelRegistry: {
      find: (provider: string, id: string) => {
        if (opts.find) return opts.find(provider, id) as never;
        return undefined as never;
      },
      getAvailable: () => [],
      refresh: async () => {},
    },
    model: undefined,
    scopedModels: [] as readonly unknown[],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;

  return { ctx, notifications, widgets };
}

async function withTempSettings(
  settings: PiSpeakSettings,
  fn: (dir: string) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
  const orig = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    // ensure model file exists for existsSync check
    await writeFile(settings.model.path, "fake-model");
    await writeSettings(settings);
    await fn(dir);
  } finally {
    process.env.PI_CODING_AGENT_DIR = orig;
    await rm(dir, { recursive: true, force: true });
  }
}

test("runtime preprocessing", async (t) => {
  await t.test("disabled path synthesizes raw verbatim with no cleaning or truncation", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, {
        voice: model.voices[0],
        speed: 1.0,
        preprocessingEnabled: false,
      });
      await writeSettings(settings);

      const rawMarkdown = "# Title\n\nHello **world** with [link](http://example.com) and `code`.\n```js\nconsole.log('hi')\n```\n";
      const longRaw = "a".repeat(1000);
      const rawToUse = `${rawMarkdown}\n${longRaw}`; // >600 chars, includes markdown

      const branch = [
        {
          type: "message",
          message: { role: "assistant", content: [{ type: "text", text: rawToUse }] },
        },
      ];

      const fakeSynth = createFakeSynthesisService();
      let preprocessCalled = false;
      const fakePreprocess = async () => {
        preprocessCalled = true;
        return "should not be called";
      };

      const { ctx, notifications, widgets } = createMockCtx(branch);
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
      const runtime = createPiSpeakRuntime(pi, {
        synthesisService: fakeSynth.service,
        generatePreprocessedText: fakePreprocess as never,
      });

      await runtime.speakLastMessage(ctx);

      assert.equal(preprocessCalled, false, "preprocessing should not be called when disabled");
      assert.equal(fakeSynth.calls.length, 1);
      assert.equal(fakeSynth.calls[0]!.text, rawToUse, "should synthesize raw verbatim, no cleaning/slice");
      // widget shown and cleared, single Synthesizing… (via setWidget)
      const setCalls = widgets.filter((w) => w.key === "pi-speak-status");
      assert.ok(setCalls.length >= 2, "widget should be set and cleared");
      // last widget should be undefined (cleared)
      assert.equal(setCalls.at(-1)!.value, undefined);
      // should notify Speaking...
      assert.ok(notifications.some((n) => n.message.includes("Speaking last message") && n.level === "info"));
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("disabled path undoes truncation: long raw not sliced to 600", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath);
      await writeSettings(settings);
      const longRaw = "x".repeat(2000);
      const branch = [
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: longRaw }] } },
      ];
      const fakeSynth = createFakeSynthesisService();
      const { ctx } = createMockCtx(branch);
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, { synthesisService: fakeSynth.service, generatePreprocessedText: async () => "nope" as never });
      await runtime.speakLastMessage(ctx);
      assert.equal(fakeSynth.calls.length, 1);
      assert.equal(fakeSynth.calls[0]!.text.length, 2000, "should not truncate to 600");
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("enabled path summarize-then-synthesize with verbatim raw and trimmed summary", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "gpt-4o" },
        preprocessingPrompt: "Custom prompt",
      });
      await writeSettings(settings);

      const raw = "# Hello ```code``` world [link](x)";
      const branch = [
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: raw }] } },
      ];

      const fakeSynth = createFakeSynthesisService();
      const preprocessCalls: Array<{ raw: string; prompt: string; model: unknown }> = [];
      const fakePreprocess = async (r: string, prompt: string, mdl: unknown) => {
        preprocessCalls.push({ raw: r, prompt, model: mdl });
        // return with surrounding whitespace to verify trim
        return "  Summarized one sentence.  ";
      };

      const fakeModel = { provider: "openai", id: "gpt-4o" };
      const { ctx, notifications, widgets } = createMockCtx(branch, {
        find: (p, id) => (p === "openai" && id === "gpt-4o" ? fakeModel : undefined),
      });

      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, {
        synthesisService: fakeSynth.service,
        generatePreprocessedText: fakePreprocess as never,
      });

      await runtime.speakLastMessage(ctx);

      assert.equal(preprocessCalls.length, 1);
      assert.equal(preprocessCalls[0]!.raw, raw, "raw should be verbatim, no cleaning, no slice");
      assert.equal(preprocessCalls[0]!.prompt, "Custom prompt", "should use custom prompt");
      assert.equal(preprocessCalls[0]!.model, fakeModel);
      assert.equal(fakeSynth.calls.length, 1);
      assert.equal(fakeSynth.calls[0]!.text, "Summarized one sentence.", "should synthesize trimmed LLM result verbatim, no post-cleaning");
      const setCalls = widgets.filter((w) => w.key === "pi-speak-status");
      assert.ok(setCalls.length >= 2);
      assert.equal(setCalls.at(-1)!.value, undefined);
      assert.ok(notifications.some((n) => n.message.includes("Speaking last message")));
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("enabled uses built-in default prompt when absent", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "gpt-4o" },
      });
      await writeSettings(settings);
      const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "raw" }] } }];
      const fakeSynth = createFakeSynthesisService();
      let capturedPrompt: string | undefined;
      const fakePreprocess = async (_r: string, prompt: string) => {
        capturedPrompt = prompt;
        return "summary";
      };
      const fakeModel = { provider: "openai", id: "gpt-4o" };
      const { ctx } = createMockCtx(branch, { find: () => fakeModel });
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, { synthesisService: fakeSynth.service, generatePreprocessedText: fakePreprocess as never });
      await runtime.speakLastMessage(ctx);
      assert.equal(capturedPrompt, DEFAULT_PREPROCESSING_PROMPT);
      assert.equal(fakeSynth.calls[0]!.text, "summary");
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("hard error: enabled but no preprocessingModel", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, { preprocessingEnabled: true });
      await writeSettings(settings);
      const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }];
      const fakeSynth = createFakeSynthesisService();
      let called = false;
      const { ctx, notifications, widgets } = createMockCtx(branch);
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, {
        synthesisService: fakeSynth.service,
        generatePreprocessedText: (async () => {
          called = true;
          return "nope";
        }) as never,
      });
      await runtime.speakLastMessage(ctx);
      assert.equal(called, false, "preprocessing should not be called when model missing");
      assert.equal(fakeSynth.calls.length, 0, "no synthesis on hard error");
      assert.ok(notifications.some((n) => n.level === "error" && n.message.includes("no model")), `expected error notify, got ${JSON.stringify(notifications)}`);
      const setCalls = widgets.filter((w) => w.key === "pi-speak-status");
      // widget should be cleared even on error
      assert.equal(setCalls.at(-1)?.value, undefined);
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("hard error: registry miss", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "missing" },
      });
      await writeSettings(settings);
      const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }];
      const fakeSynth = createFakeSynthesisService();
      let called = false;
      const { ctx, notifications, widgets } = createMockCtx(branch, { find: () => undefined });
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, {
        synthesisService: fakeSynth.service,
        generatePreprocessedText: (async () => {
          called = true;
          return "nope";
        }) as never,
      });
      await runtime.speakLastMessage(ctx);
      assert.equal(called, false);
      assert.equal(fakeSynth.calls.length, 0);
      assert.ok(notifications.some((n) => n.level === "error" && n.message.includes("not found")));
      assert.equal(widgets.filter((w) => w.key === "pi-speak-status").at(-1)?.value, undefined);
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("hard error: LLM throws", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "gpt-4o" },
      });
      await writeSettings(settings);
      const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }];
      const fakeSynth = createFakeSynthesisService();
      const { ctx, notifications, widgets } = createMockCtx(branch, {
        find: () => ({ provider: "openai", id: "gpt-4o" }),
      });
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, {
        synthesisService: fakeSynth.service,
        generatePreprocessedText: (async () => {
          throw new Error("LLM timeout");
        }) as never,
      });
      await runtime.speakLastMessage(ctx);
      assert.equal(fakeSynth.calls.length, 0);
      assert.ok(notifications.some((n) => n.level === "error" && n.message.includes("Preprocessing failed")));
      assert.equal(widgets.filter((w) => w.key === "pi-speak-status").at(-1)?.value, undefined);
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("hard error: LLM returns null/empty", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "gpt-4o" },
      });
      await writeSettings(settings);
      for (const empty of [null, "", "   ", " \n\t "]) {
        const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }];
        const fakeSynth = createFakeSynthesisService();
        const { ctx, notifications, widgets } = createMockCtx(branch, {
          find: () => ({ provider: "openai", id: "gpt-4o" }),
        });
        const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
        const runtime = createPiSpeakRuntime(pi, {
          synthesisService: fakeSynth.service,
          generatePreprocessedText: async () => empty as never,
        });
        await runtime.speakLastMessage(ctx);
        assert.equal(fakeSynth.calls.length, 0, `should not synthesize for empty ${JSON.stringify(empty)}`);
        assert.ok(notifications.some((n) => n.level === "error" && n.message.includes("empty")));
        assert.equal(widgets.filter((w) => w.key === "pi-speak-status").at(-1)?.value, undefined);
        await runtime.shutdown(ctx);
      }
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("Last Agent Message is most recent assistant with non-empty text parts", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, { preprocessingEnabled: false });
      await writeSettings(settings);
      const branch = [
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "old" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "user" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "   " }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "tool_result", text: "x" }] } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "latest with **markdown**" }] } },
        { type: "custom", customType: "other", data: {} },
      ];
      const fakeSynth = createFakeSynthesisService();
      const { ctx } = createMockCtx(branch);
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, { synthesisService: fakeSynth.service, generatePreprocessedText: async () => "nope" as never });
      await runtime.speakLastMessage(ctx);
      assert.equal(fakeSynth.calls.length, 1);
      assert.equal(fakeSynth.calls[0]!.text, "latest with **markdown**");
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("second ctrl+alt+x while in progress warns and does not enqueue second synthesis", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, { preprocessingEnabled: false });
      await writeSettings(settings);
      const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }];
      const gate = deferred<void>();
      const fakeSynth = createFakeSynthesisService();
      fakeSynth.setGate(gate);
      const { ctx, notifications } = createMockCtx(branch);
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, { synthesisService: fakeSynth.service, generatePreprocessedText: async () => "nope" as never });
      const first = runtime.speakLastMessage(ctx);
      // Wait until first synthesis has started (gate blocked)
      for (let i = 0; i < 20; i++) {
        if (fakeSynth.calls.length === 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(fakeSynth.calls.length, 1, "first synthesis should have started");
      const second = runtime.speakLastMessage(ctx);
      // second should immediately notify warning and return same operation
      assert.ok(notifications.some((n) => n.message.includes("already in progress") && n.level === "warning"));
      assert.equal(fakeSynth.calls.length, 1, "second should not enqueue another synthesis while first in progress");
      // second promise should be same as first (runExclusive returns operation)
      // release gate to finish
      gate.resolve();
      await first;
      await second;
      // after finished, next call should work again
      const fakeSynth2 = createFakeSynthesisService();
      // need new runtime? operation cleared, so same runtime can run again but need to reset notifications
      notifications.length = 0;
      // Update runtime's synthesisService? reuse same runtime but swap service? easier create new runtime
      const runtime2 = createPiSpeakRuntime(pi, { synthesisService: fakeSynth2.service, generatePreprocessedText: async () => "nope" as never });
      // Need to re-use settings already written; but runtime2 will load settings again
      const { ctx: ctx2 } = createMockCtx(branch);
      await runtime2.speakLastMessage(ctx2);
      assert.equal(fakeSynth2.calls.length, 1);
      await runtime.shutdown(ctx);
      await runtime2.shutdown(ctx2);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("enabled path also guarded by exclusive: second press during preprocessing warns", async () => {
    const model = CATALOG_MODELS[0]!;
    const dir = await mkdtemp(join(tmpdir(), "pi-speak-rt-"));
    const orig = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    try {
      const fakePath = join(dir, "model.onnx");
      await writeFile(fakePath, "x");
      const settings = settingsForModel(model.id, fakePath, {
        preprocessingEnabled: true,
        preprocessingModel: { provider: "openai", id: "gpt-4o" },
      });
      await writeSettings(settings);
      const branch = [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }];
      const gate = deferred<void>();
      const fakeSynth = createFakeSynthesisService();
      let preprocessCalls = 0;
      const fakePreprocess = async () => {
        preprocessCalls++;
        await gate.promise;
        return "summary";
      };
      const { ctx, notifications } = createMockCtx(branch, { find: () => ({ provider: "openai", id: "gpt-4o" }) });
      const pi = { events: { emit: () => {}, on: () => () => {} }, appendEntry: () => {} } as never;
      const runtime = createPiSpeakRuntime(pi, { synthesisService: fakeSynth.service, generatePreprocessedText: fakePreprocess as never });
      const first = runtime.speakLastMessage(ctx);
      for (let i = 0; i < 20; i++) {
        if (preprocessCalls === 1) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(preprocessCalls, 1, "first preprocessing should have started");
      const second = runtime.speakLastMessage(ctx);
      assert.ok(notifications.some((n) => n.message.includes("already in progress")));
      assert.equal(preprocessCalls, 1, "second should not start second preprocessing");
      gate.resolve();
      await first;
      await second;
      assert.equal(fakeSynth.calls.length, 1);
      await runtime.shutdown(ctx);
    } finally {
      process.env.PI_CODING_AGENT_DIR = orig;
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test("speak tool remains deterministic: already covered by eager imports and previous behavior", async () => {
    // Verify speak-tool does not import preprocessing statically
    const { readFileSync } = await import("node:fs");
    const speakToolSrc = readFileSync(join(process.cwd(), "src/speak-tool.ts"), "utf8");
    assert.equal(speakToolSrc.includes("preprocessing"), false, "speak-tool should not import preprocessing");
    assert.equal(speakToolSrc.includes("preprocessingEnabled"), false, "speak-tool should not check preprocessingEnabled");
  });
});
