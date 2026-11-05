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

const labeled: VoicePage = { voices: [
  { id: "a", name: "Alice", description: "Warm narrator", labels: { gender: "female", accent: "american", age: "young", use_case: "narrative_story" } },
  { id: "b", name: "Brian", description: "Deep presenter", labels: { gender: "male", accent: "british", age: "middle_aged", use_case: "informative_educational" } },
  { id: "c", name: "Chris", description: "Calm", labels: { gender: "male", accent: "american", age: "middle_aged", use_case: "conversational" } },
  { id: "d", name: "Dana", description: "Bright", labels: { gender: "neutral", accent: "australian", age: "old", use_case: "conversational" } },
  { id: "e", name: "Eli", description: "No traits inferred", labels: { gender: " " } },
] };
function choose(component: Component, label: string): void {
  for (let i = 0; i < 40; i++) {
    if (component.render(120).some((line) => line === `→ ${label}`)) { component.handleInput!("\r"); return; }
    component.handleInput!("\x1b[B");
  }
  assert.fail(`Missing choice: ${label}`);
}
function field(component: Component, name: string, value: string): void {
  choose(component, `${name} · Any`);
  choose(component, value);
}

test("local fields combine with AND and cancel discards draft changes", async () => {
  const { result } = await withPicker(labeled, (component) => {
    component.render(120);
    component.handleInput!("F");
    field(component, "Gender", "Male");
    field(component, "Accent", "American");
    field(component, "Age", "Middle aged");
    field(component, "Use case", "Conversational");
    choose(component, "Apply");
    const text = component.render(180).join("\n");
    assert.match(text, /1\/5 voices · Gender: Male · Accent: American · Age: Middle aged · Use case: Conversational/);
    assert.match(text, /→ Chris/);
    component.handleInput!("f");
    choose(component, "Clear all");
    choose(component, "Cancel");
    assert.match(component.render(120).join("\n"), /1\/5 voices/);
    component.handleInput!("\r");
  });
  assert.deepEqual(result, { kind: "voice", voice: labeled.voices[2] });
});

test("missing labels have Unspecified; Clear all resets fields and search only on Apply", async () => {
  await withPicker(labeled, (component) => {
    component.render(120);
    component.handleInput!("/"); component.handleInput!("Eli"); component.handleInput!("\r");
    component.handleInput!("f");
    field(component, "Gender", "Unspecified");
    choose(component, "Apply");
    assert.match(component.render(120).join("\n"), /1\/5 voices · Search: Eli · Gender: Unspecified/);
    component.handleInput!("f"); choose(component, "Clear all"); choose(component, "Apply");
    assert.match(component.render(120).join("\n"), /5\/5 voices/);
    assert.doesNotMatch(component.render(120).join("\n"), /Search:|Gender:/);
    component.handleInput!("\x1b");
  });
});

test("search matches name, description and labels locally, p is text, zero results are recoverable", async () => {
  await withPicker(labeled, (component) => {
    component.render(120);
    for (const [query, count, name] of [["alice", 1, "Alice"], ["presenter", 1, "Brian"], ["AUSTRALIAN", 1, "Dana"], ["p", 1, "Brian"], ["notfound", 0, ""]] as const) {
      component.handleInput!("/"); component.handleInput!("\x15"); component.handleInput!(query);
      const text = component.render(120).join("\n");
      assert.ok(text.includes(`${count}/5 voices`));
      if (name) assert.ok(text.includes(`→ ${name}`));
      else assert.match(text, /No matching voices/);
      component.handleInput!("\r");
    }
    component.handleInput!("\r"); // zero matches cannot finish or select stale details
    component.handleInput!("/"); component.handleInput!("\x15"); component.handleInput!("Alice");
    component.handleInput!("\x1b"); // cancel restores committed zero-match query
    assert.match(component.render(120).join("\n"), /0\/5 voices · Search: notfound/);
    component.handleInput!("/"); component.handleInput!("\x15"); component.handleInput!("\r");
    assert.match(component.render(120).join("\n"), /5\/5 voices/);
    component.handleInput!("\x1b");
  });
});

test("search and filter editing cancel previews and resume just one debounced highlighted voice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls: Array<{ voice: string; signal: AbortSignal }> = [];
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  await withPicker(labeled, async (component) => {
    component.render(120);
    component.handleInput!("p"); t.mock.timers.tick(300); await flush();
    assert.equal(calls.length, 1);
    component.handleInput!("/");
    assert.equal(calls[0]!.signal.aborted, true);
    component.handleInput!("p"); t.mock.timers.tick(1000); await flush();
    assert.equal(calls.length, 1);
    assert.match(component.render(120).join("\n"), /1\/5 voices · Search: p/);
    component.handleInput!("\r"); t.mock.timers.tick(299); await flush();
    assert.equal(calls.length, 1);
    t.mock.timers.tick(1); await flush();
    assert.equal(calls[1]!.voice, "b");
    component.handleInput!("f");
    assert.equal(calls[1]!.signal.aborted, true);
    field(component, "Gender", "Female"); t.mock.timers.tick(1000); await flush();
    assert.equal(calls.length, 2);
    choose(component, "Apply"); t.mock.timers.tick(1000); await flush();
    assert.equal(calls.length, 2, "zero matches do not preview");
    component.handleInput!("f"); choose(component, "Clear all"); choose(component, "Apply");
    t.mock.timers.tick(300); await flush();
    assert.equal(calls.length, 3);
    assert.equal(calls[2]!.voice, "a");
    component.handleInput!("f"); component.handleInput!("\x1b");
    component.handleInput!("/"); // cancels resumed debounce before it fires
    t.mock.timers.tick(1000); await flush();
    assert.equal(calls.length, 3);
    component.handleInput!("\x1b"); component.handleInput!("\x1b");
  }, (voice, signal) => {
    calls.push({ voice, signal });
    return new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  });
});

test("all editing modes remain width bounded and values Escape returns to the panel", async () => {
  await withPicker(labeled, (component) => {
    for (const key of ["/", "\x1b", "f", "\r"]) {
      component.handleInput!(key);
      for (const width of [1, 8, 24, 80]) assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    }
    component.handleInput!("\x1b");
    assert.match(component.render(80).join("\n"), /Voice filters/);
    component.handleInput!("\x1b"); component.handleInput!("\x1b");
  });
});

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

test("preview reports payment gating without exposing response details", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withPicker(page, async (component) => {
    component.render(100);
    component.handleInput!("p");
    t.mock.timers.tick(300);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = component.render(100).join("\n");
    assert.match(output, /Preview requires payment \(HTTP 402\)/);
    assert.doesNotMatch(output, /private response/);
    component.handleInput!("\x1b");
  }, async () => { throw new Error("ElevenLabs HTTP 402: private response details"); });
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
