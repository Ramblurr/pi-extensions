import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showVoicePicker, type VoicePickerResult } from "../src/voice-picker.js";
import type { VoicePage } from "../src/speech-provider.js";

type Factory = Parameters<ExtensionContext["ui"]["custom"]>[0];
const page: VoicePage = {
  voices: [
    { id: "alice-id", name: "Alice — 清晰な語り手 👩🏽‍💻 with a long descriptive name", description: "Alice description. " + "Warm and conversational narration. ".repeat(30) },
    { id: "brian-id", name: "Brian", description: "Brian description, deep and resonant." },
    { id: "other-id", name: "Brian", description: "Other Brian description." },
  ],
};

async function withPicker(data: VoicePage, run: (component: Component, terminal: { rows: number }) => void | Promise<void>, preview?: (voice: string, signal: AbortSignal) => Promise<void>) {
  let result: VoicePickerResult;
  let finished = false;
  let renders = 0;
  const terminal = { rows: 24 };
  // SAFETY: the real picker uses only terminal.rows/requestRender and fg/bold;
  // no terminal process or full extension session is needed for component rendering.
  const tui = { terminal, requestRender: () => { renders++; } } as unknown as TUI;
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as ExtensionContext["ui"]["theme"];
  const bindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": ["down", "j"] });
  // SAFETY: showVoicePicker's only context reads in TUI mode are mode and ui.custom.
  const ctx = {
    mode: "tui", ui: { custom: async (factory: Factory) => {
      const component = await factory(tui, theme, bindings as Parameters<Factory>[2], (value) => { result = value as VoicePickerResult; finished = true; });
      await run(component, terminal);
      assert.ok(finished, "test interaction must select or cancel");
      return result;
    } },
  } as unknown as ExtensionContext;
  return { result: await showVoicePicker(ctx, data, preview), renders };
}

test("voice picker renders one name per row and bounded selected-only details", async () => {
  await withPicker(page, (component) => {
    for (const width of [1, 8, 24, 60, 120]) {
      const lines = component.render(width);
      assert.ok(lines.every((line) => visibleWidth(line) <= width), `overflow at ${width} columns`);
      assert.equal(lines.length, 12, "description length must not expand the picker");
      const rows = lines.slice(2, 5);
      assert.ok(rows.every((line) => !line.includes("-id") && !line.includes("description")));
      if (width >= 24) {
        assert.ok(rows[0]!.startsWith("→ Alice"));
        assert.ok(lines.slice(6).some((line) => line.includes("ID: alice-id")));
        assert.ok(!lines.join("\n").includes("brian-id"));
      }
      if (width === 24) assert.ok(stripVTControlCharacters(rows[0]!).endsWith("…"));
      if (width === 120) assert.ok(rows[0]!.includes("with a long descriptive name"), "wide terminals use available width");
    }
    component.handleInput!("\x1b");
  });
});

test("navigation changes detail panel, injected bindings select the correct duplicate name", async () => {
  const { result, renders } = await withPicker(page, (component) => {
    component.render(80);
    component.handleInput!("j");
    let lines = component.render(80);
    assert.ok(lines[3]!.startsWith("→ Brian"));
    assert.ok(lines.join("\n").includes("ID: brian-id"));
    assert.ok(lines.join("\n").includes("Brian description"));
    assert.ok(!lines.join("\n").includes("Alice description"));
    component.handleInput!("\x1b[B");
    lines = component.render(80);
    assert.ok(lines.join("\n").includes("ID: other-id"));
    component.handleInput!("\r");
  });
  assert.deepEqual(result, { kind: "voice", voice: page.voices[2] });
  assert.equal(renders, 2);
});

test("list has no pagination control and cancel never selects a voice", async () => {
  const last = await withPicker(page, (component) => {
    component.render(50);
    component.handleInput!("\x1b[A");
    const lines = component.render(50);
    assert.ok(!lines.join("\n").includes("Next page"));
    assert.ok(lines.join("\n").includes("ID: other-id"));
    component.handleInput!("\r");
  });
  assert.deepEqual(last.result, { kind: "voice", voice: page.voices[2] });
  for (const key of ["\x1b", "\x03"]) {
    assert.equal((await withPicker(page, (component) => { component.render(50); component.handleInput!(key); })).result, undefined);
  }
});

test("viewport scrolling and resizing keep selection and details bounded", async () => {
  const many: VoicePage = { voices: Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, name: `Voice ${i}`, description: `Description ${i}` })) };
  const { result } = await withPicker(many, (component, terminal) => {
    assert.ok(component.render(80).length <= 21);
    component.handleInput!("\x1b[6~");
    assert.ok(component.render(80).some((line) => line === "ID: id-10"));
    terminal.rows = 14;
    const narrow = component.render(24);
    assert.ok(narrow.length <= 14);
    assert.ok(narrow.some((line) => line === "ID: id-10"));
    assert.ok(narrow.every((line) => visibleWidth(line) <= 24));
    component.invalidate();
    terminal.rows = 40;
    assert.ok(component.render(100).some((line) => line === "ID: id-10"));
    component.handleInput!("\r");
  });
  assert.deepEqual(result, { kind: "voice", voice: many.voices[10] });
});

test("remote control sequences and newlines cannot inject extra list rows", async () => {
  await withPicker({ voices: [{ id: "id", name: "A\nB\x1b[31mC", description: "Safe" }] }, (component) => {
    const rows = component.render(40);
    assert.equal(rows[2], "→ A BC");
    component.handleInput!("\x1b");
  });
});

test("preview defaults off, debounces navigation, and aborts only its own requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: Array<{ voice: string; signal: AbortSignal }> = [];
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await withPicker(page, async (component) => {
    assert.ok(component.render(80).join("\n").includes("P preview off"));
    component.handleInput!("j");
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls.length, 0);
    component.handleInput!("p");
    assert.ok(component.render(80).join("\n").includes("Uses credits"));
    t.mock.timers.tick(299);
    await flush();
    assert.equal(calls.length, 0);
    component.handleInput!("j");
    t.mock.timers.tick(299);
    await flush();
    assert.equal(calls.length, 0);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls[0]?.voice, "other-id");
    component.handleInput!("\x1b[A");
    assert.equal(calls[0]?.signal.aborted, true);
    t.mock.timers.tick(300);
    await flush();
    assert.equal(calls[1]?.voice, "brian-id");
    component.handleInput!("p");
    assert.equal(calls[1]?.signal.aborted, true);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls.length, 2);
    component.handleInput!("p");
    t.mock.timers.tick(300);
    await flush();
    assert.equal(calls.length, 3, "no cache: toggling on previews the same voice again");
    component.handleInput!("\x1b");
    assert.equal(calls[2]?.signal.aborted, true);
  }, (voice, signal) => {
    calls.push({ voice, signal });
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
});

test("preview closes pending timers and shows failures without closing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const preview = async () => { calls++; throw new Error("remote detail must not leak"); };
  await withPicker(page, async (component) => {
    component.render(80);
    component.handleInput!("p");
    t.mock.timers.tick(300);
    await flush();
    assert.equal(calls, 1);
    const text = component.render(80).join("\n");
    assert.ok(text.includes("Preview failed"));
    assert.ok(!text.includes("remote detail"));
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 1, "no retries");
    component.handleInput!("j");
    component.handleInput!("\r");
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(calls, 1, "selection closes and cancels pending timer");
  }, preview);
  await withPicker(page, async (component) => {
    assert.ok(component.render(80).join("\n").includes("P preview off"));
    component.handleInput!("p");
    component.handleInput!("p");
    t.mock.timers.tick(300);
    await flush();
    assert.equal(calls, 1, "toggle off cancels pending timer");
    component.handleInput!("\x1b");
  }, preview);
});
