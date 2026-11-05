import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Input, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi, type SelectItem } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { VoicePage } from "./speech-provider.js";

type Voice = VoicePage["voices"][number];
export type VoicePickerResult = { kind: "voice"; voice: Voice } | undefined;
const fields = [
  ["gender", "Gender"], ["accent", "Accent"], ["age", "Age"], ["use_case", "Use case"],
] as const;
type Field = typeof fields[number][0];
// undefined means Any; null means a missing/empty label, never an inferred trait.
type Filters = Partial<Record<Field, string | null>>;

function singleLine(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}
function labelValue(voice: Voice, field: Field): string | null {
  return voice.labels && Object.hasOwn(voice.labels, field) ? singleLine(voice.labels[field] ?? "") || null : null;
}
function filterVoices(voices: Voice[], query: string, filters: Filters): Voice[] {
  const search = singleLine(query).toLowerCase();
  return voices.filter((voice) =>
    fields.every(([field]) => filters[field] === undefined || filters[field] === labelValue(voice, field)) &&
    singleLine([voice.name, voice.description, ...Object.entries(voice.labels ?? {}).flat()].join(" ")).toLowerCase().includes(search));
}
function valueLabel(value: string | null | undefined): string {
  return value === undefined ? "Any" : value === null ? "Unspecified"
    : value.replaceAll("_", " ").replace(/^./u, (first) => first.toLocaleUpperCase());
}

export async function showVoicePicker(
  ctx: ExtensionContext,
  page: Pick<VoicePage, "voices">,
  preview?: (voice: string, signal: AbortSignal) => Promise<void>,
  initialQuery = "",
): Promise<VoicePickerResult> {
  // RPC has no custom component support. Keep its native dialog compact too.
  if (ctx.mode !== "tui") {
    const voices = filterVoices(page.voices, initialQuery, {});
    const labels = voices.map((voice, index) => `${index + 1}. ${singleLine(voice.name)}`);
    const selected = await ctx.ui.select("Account voices", labels);
    if (selected === undefined) return undefined;
    const voice = voices[labels.indexOf(selected)];
    return voice ? { kind: "voice", voice } : undefined;
  }
  return ctx.ui.custom<VoicePickerResult>((tui, theme, keybindings, done) => {
    let query = initialQuery;
    let filters: Filters = {};
    let draftFilters: Filters = {};
    let draftQuery = "";
    let mode: "browse" | "search" | "filters" | "values" = "browse";
    let input = new Input();
    let focused = false;
    let voices = filterVoices(page.voices, query, filters);
    let selectedIndex = 0;
    let panelIndex = 0;
    let valueIndex = 0;
    let values: Array<string | null | undefined> = [];
    let visibleRows = 0;
    let list: SelectList | undefined;
    let previewEnabled = false;
    let previewTimer: ReturnType<typeof setTimeout> | undefined;
    let previewController: AbortController | undefined;
    let previewMessage = "";
    const stopPreview = (): void => {
      clearTimeout(previewTimer);
      previewTimer = undefined;
      previewController?.abort();
      previewController = undefined;
      previewMessage = "";
    };
    const schedulePreview = (): void => {
      stopPreview();
      const voice = voices[selectedIndex];
      if (mode !== "browse" || !previewEnabled || !preview || !voice) return;
      previewMessage = "waiting…";
      previewTimer = setTimeout(() => {
        previewTimer = undefined;
        const controller = new AbortController();
        previewController = controller;
        previewMessage = "playing…";
        tui.requestRender();
        void Promise.resolve().then(() => {
          if (!controller.signal.aborted) return preview(voice.id, controller.signal);
        }).then(() => {
          if (previewController === controller) previewMessage = "finished";
        }, (error: unknown) => {
          if (previewController === controller && !controller.signal.aborted) {
            const status = error instanceof Error ? /^ElevenLabs HTTP (\d{3}):/.exec(error.message)?.[1] : undefined;
            previewMessage = status === "402" ? "Preview requires payment (HTTP 402)"
              : status ? `Preview failed (HTTP ${status})` : "Preview failed";
          }
        }).finally(() => {
          if (previewController === controller) {
            previewController = undefined;
            tui.requestRender();
          }
        });
      }, 300);
    };
    const refresh = (): void => { list = undefined; tui.requestRender(); };
    const applyFilters = (): void => {
      const selected = voices[selectedIndex];
      voices = filterVoices(page.voices, mode === "search" ? input.getValue() : query, filters);
      selectedIndex = Math.max(0, voices.indexOf(selected!));
      list = undefined;
    };
    const browse = (): void => {
      mode = "browse";
      input.focused = false;
      applyFilters();
      schedulePreview();
      refresh();
    };
    const finish = (result: VoicePickerResult): void => { stopPreview(); done(result); };
    const activeItems = (): SelectItem[] => {
      if (mode === "values") return values.map((value, index) => ({ value: String(index), label: valueLabel(value) }));
      if (mode === "filters") return [
        ...fields.map(([field, name]) => ({ value: field, label: `${name} · ${valueLabel(draftFilters[field])}` })),
        ...["Apply", "Clear all", "Cancel"].map((label) => ({ value: label, label })),
      ];
      return voices.map((voice, index) => ({ value: String(index), label: singleLine(voice.name) || "Unnamed voice" }));
    };
    const activeIndex = (): number => mode === "values" ? valueIndex : mode === "filters" ? panelIndex : selectedIndex;
    const component = {
      capturesViewportInput: true,
      get focused(): boolean { return focused; },
      set focused(value: boolean) { focused = value; input.focused = value && mode === "search"; },
      render(width: number): string[] {
        const w = Math.max(1, width);
        const editingFilters = mode === "filters" || mode === "values";
        const rows = Math.max(1, Math.min(10, tui.terminal.rows - (editingFilters ? 5 : mode === "search" ? 13 : 12)));
        if (!list || rows !== visibleRows) {
          visibleRows = rows;
          list = new SelectList(activeItems(), rows, {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", theme.bold(text)),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: () => theme.fg("warning", "  No matching voices"),
          }, { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, Math.max(1, maxWidth), "…") });
          list.setSelectedIndex(activeIndex());
        }
        if (editingFilters) return [
          theme.fg("accent", theme.bold(mode === "values" ? fields[panelIndex]![1] : "Voice filters")),
          theme.fg("dim", "Local draft · previews paused"),
          ...list.render(w),
          theme.fg("dim", "↑↓ · Enter choose · Esc cancel"),
        ].map((line) => truncateToWidth(line, w, "…"));
        const voice = voices[selectedIndex];
        const details = voice
          ? [singleLine(`ID: ${voice.id}`), ...wrapTextWithAnsi(singleLine(voice.description) || "No description available.", w)]
          : ["No matching voices. Change / search or F filters."];
        const detailLines = details.slice(0, 4);
        if (details.length > 4) detailLines[3] = truncateToWidth(`${detailLines[3]} …`, w, "…");
        while (detailLines.length < 4) detailLines.push("");
        const search = mode === "search" ? input.getValue() : query;
        const summary = [
          `${voices.length}/${page.voices.length} voices`,
          ...(search.trim() ? [`Search: ${singleLine(search)}`] : []),
          ...fields.flatMap(([field, name]) => filters[field] === undefined ? [] : [`${name}: ${valueLabel(filters[field])}`]),
        ].join(" · ");
        const footer = mode === "search" ? "Enter apply · Esc cancel · previews paused"
          : `↑↓ · Enter · Esc · / search · F filters${preview ? ` · P preview ${previewEnabled ? "on" : "off"}` : ""}`;
        const status = previewEnabled ? `Uses credits · ${mode === "search" ? "paused" : previewMessage || "select a voice"}` : "";
        return [
          theme.fg("accent", theme.bold("Account voices")), theme.fg("dim", summary),
          ...(mode === "search" ? input.render(w) : []),
          ...list.render(w), "",
          ...detailLines.map((line) => theme.fg("muted", line)), theme.fg("dim", status),
          theme.fg("dim", footer),
        ].map((line) => truncateToWidth(line, w, "…"));
      },
      handleInput(data: string): void {
        const cancel = keybindings.matches(data, "tui.select.cancel");
        const confirm = keybindings.matches(data, "tui.select.confirm");
        if (mode === "search") {
          if (cancel) { browse(); return; }
          if (confirm) { query = input.getValue(); browse(); return; }
          input.handleInput(data);
          applyFilters();
          refresh();
          return;
        }
        if (mode === "filters" || mode === "values") {
          if (cancel) {
            if (mode === "values") { mode = "filters"; refresh(); } else browse();
            return;
          }
          if (confirm) {
            const field = fields[panelIndex]?.[0];
            if (mode === "values" && field) {
              draftFilters[field] = values[valueIndex];
              mode = "filters";
            } else if (field) {
              const labels = page.voices.map((voice) => labelValue(voice, field));
              values = [undefined, ...new Set(labels.filter((label): label is string => label !== null).sort()), ...(labels.includes(null) ? [null] : [])];
              valueIndex = Math.max(0, values.indexOf(draftFilters[field]));
              mode = "values";
            } else if (panelIndex === 4) {
              filters = { ...draftFilters }; query = draftQuery; browse(); return;
            } else if (panelIndex === 5) {
              draftFilters = {}; draftQuery = "";
            } else { browse(); return; }
            refresh();
            return;
          }
        } else {
          if (cancel) { finish(undefined); return; }
          if (matchesKey(data, "/")) {
            stopPreview();
            mode = "search";
            input = new Input();
            input.setValue(query);
            input.handleInput("\x05"); // Start editing at the end (native Ctrl+E).
            input.focused = focused;
            refresh();
            return;
          }
          if (matchesKey(data, "f") || data === "F") {
            stopPreview(); mode = "filters"; draftFilters = { ...filters }; draftQuery = query; panelIndex = 0;
            refresh(); return;
          }
          if (preview && (matchesKey(data, "p") || data === "P")) {
            previewEnabled = !previewEnabled; schedulePreview(); tui.requestRender(); return;
          }
          if (confirm) {
            const voice = voices[selectedIndex];
            if (voice) finish({ kind: "voice", voice });
            return;
          }
        }
        const length = activeItems().length;
        if (!length) return;
        const previousIndex = activeIndex();
        let index = previousIndex;
        // Use injected bindings rather than SelectList's package-global manager.
        if (keybindings.matches(data, "tui.select.up")) index = (index + length - 1) % length;
        else if (keybindings.matches(data, "tui.select.down")) index = (index + 1) % length;
        else if (keybindings.matches(data, "tui.select.pageUp")) index = Math.max(0, index - visibleRows);
        else if (keybindings.matches(data, "tui.select.pageDown")) index = Math.min(length - 1, index + visibleRows);
        else return;
        if (mode === "values") valueIndex = index;
        else if (mode === "filters") panelIndex = index;
        else selectedIndex = index;
        list?.setSelectedIndex(index);
        if (mode === "browse" && index !== previousIndex) schedulePreview();
        component.invalidate();
        tui.requestRender();
      },
      invalidate(): void { list?.invalidate(); input.invalidate(); },
      dispose: stopPreview,
    };
    return component;
  });
}
