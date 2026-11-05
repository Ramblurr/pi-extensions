import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, SelectList } from "@earendil-works/pi-tui";
import { getCatalogModel, getCatalogVoices } from "./catalog.js";
import { runModelSelection } from "./onboarding.js";
import { writeSettings, type PiSpeakSettings } from "./settings.js";
import { SPEED_VALUES, voiceHint } from "./text.js";

const SETTING_LABEL_WIDTH = "Transcription language".length;

function settingChoice(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  value: string,
): string {
  return `${theme.fg("muted", label.padEnd(SETTING_LABEL_WIDTH))}  ${value}`;
}

function selectTheme(theme: ExtensionContext["ui"]["theme"]) {
  return {
    selectedPrefix: (text: string) => theme.fg("accent", text),
    selectedText: (text: string) => theme.fg("accent", text),
    description: (text: string) => theme.fg("muted", text),
    scrollInfo: (text: string) => theme.fg("dim", text),
    noMatch: (text: string) => theme.fg("warning", text),
  };
}

function getModelSelectorSearchText(item: { provider: string; id: string; name?: string }): string {
  const name = item.name ? ` ${item.name}` : "";
  return `${item.provider} ${item.provider}/${item.id} ${item.provider} ${item.id}${name}`;
}

async function selectScrollable(
  ctx: ExtensionContext,
  title: string,
  options: string[],
  initial?: string,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    return ctx.ui.select(title, options);
  }
  const initialIndex = initial ? options.indexOf(initial) : -1;
  return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
    const items = options.map((value) => ({ value, label: value }));
    const termRows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
    // Reserve ~8 rows for title, spacers, footer and borders; clamp to 5..10 visible
    const available = Math.max(5, Math.min(10, termRows - 8));
    const maxVisible = Math.min(items.length, available);
    const list = new SelectList(items, maxVisible, selectTheme(theme));
    if (initialIndex >= 0) list.setSelectedIndex(initialIndex);
    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(undefined);

    return {
      render(width: number): string[] {
        const lines: string[] = [];
        const w = Math.max(1, width);
        lines.push(theme.fg("accent", theme.bold(title)));
        lines.push("");
        lines.push(...list.render(w));
        lines.push("");
        lines.push(theme.fg("dim", "↑↓ navigate • Enter select • Esc cancel"));
        return lines;
      },
      handleInput(data: string): void {
        list.handleInput(data);
        tui.requestRender();
      },
      invalidate(): void {
        list.invalidate();
      },
    };
  });
}

async function chooseVoice(
  ctx: ExtensionContext,
  current: string,
): Promise<string | undefined> {
  const voices = getCatalogVoices();
  const title = `Voice · ${current}${voiceHint(current) ? ` (${voiceHint(current)})` : ""}`;
  if (ctx.mode !== "tui") {
    const labels = voices.map((voice) => {
      const hint = voiceHint(voice);
      return hint ? `${voice} (${hint})` : voice;
    });
    const selected = await ctx.ui.select(title, labels);
    if (!selected) return undefined;
    const index = labels.indexOf(selected);
    return index >= 0 ? voices[index] : undefined;
  }
  // Searchable, scrollable voice picker: fuzzy on "voiceId hint" (e.g. "af_heart American female")
  const baseItems = voices.map((voice) => ({
    value: voice,
    label: voice,
    description: voiceHint(voice),
  }));
  const initialIndex = voices.indexOf(current);
  const selected = await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const input = new Input();
    let query = "";
    let filteredItems = [...baseItems];
    let selectedIndex = initialIndex >= 0 ? initialIndex : 0;
    type GenderFilter = "all" | "female" | "male";
    let genderFilter: GenderFilter = "all";
    const voiceGender = (voice: string): GenderFilter | "unknown" => {
      const hint = voiceHint(voice).toLowerCase();
      if (hint.includes("female")) return "female";
      if (hint.includes("male")) return "male";
      return "unknown";
    };
    const genderLabel = (g: GenderFilter) => g === "all" ? "All" : g === "female" ? "Female" : "Male";
    const nextGender = (g: GenderFilter): GenderFilter => g === "all" ? "female" : g === "female" ? "male" : "all";

    const termRows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
    const available = Math.max(5, Math.min(10, termRows - 10));
    const makeList = (items: typeof baseItems, maxVis: number, selIdx: number) => {
      const list = new SelectList(items, maxVis, selectTheme(theme));
      list.setSelectedIndex(selIdx);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = makeList(filteredItems, Math.min(filteredItems.length, available), selectedIndex);

    const applyFilters = (newQuery: string, newGender: GenderFilter) => {
      query = newQuery;
      genderFilter = newGender;
      let items: typeof baseItems = [...baseItems];
      if (genderFilter !== "all") {
        items = items.filter((it) => voiceGender(it.value) === genderFilter);
      }
      if (query.trim()) {
        items = fuzzyFilter(items, query, (it) => `${it.value} ${it.description ?? ""}`);
      }
      filteredItems = items;
      selectedIndex = 0;
      const newMax = Math.min(filteredItems.length, available);
      const newList = makeList(filteredItems, newMax || 1, selectedIndex);
      newList.onSelectionChange = (item) => {
        const idx = filteredItems.indexOf(item as typeof baseItems[number]);
        if (idx >= 0) selectedIndex = idx;
      };
      list = newList;
    };
    const updateFilter = (newQuery: string) => applyFilters(newQuery, genderFilter);
    const cycleGender = () => applyFilters(query, nextGender(genderFilter));

    // Initial selection notifier
    list.onSelectionChange = (item) => {
      const idx = filteredItems.indexOf(item as typeof baseItems[number]);
      if (idx >= 0) selectedIndex = idx;
    };

    let focused = true;
    input.focused = true;

    return {
      get focused() {
        return focused;
      },
      set focused(v: boolean) {
        focused = v;
        input.focused = v;
      },
      render(width: number): string[] {
        const w = Math.max(1, width);
        const lines: string[] = [];
        lines.push(theme.fg("accent", theme.bold(title)));
        const allText = genderFilter === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
        const femaleText = genderFilter === "female" ? theme.fg("accent", "female") : theme.fg("muted", "female");
        const maleText = genderFilter === "male" ? theme.fg("accent", "male") : theme.fg("muted", "male");
        lines.push(`${theme.fg("muted", "Gender: ")}${allText}${theme.fg("muted", " | ")}${femaleText}${theme.fg("muted", " | ")}${maleText}`);
        lines.push("");
        lines.push(...input.render(w));
        lines.push("");
        lines.push(...list.render(w));
        lines.push("");
        lines.push(theme.fg("dim", "↑↓ navigate • Tab gender • Enter select • Esc cancel"));
        if (filteredItems.length === 0) {
          const q = query.trim() ? ` for "${query}"` : "";
          const g = genderFilter !== "all" ? ` in ${genderLabel(genderFilter)}` : "";
          lines.push(theme.fg("warning", `  No voices match${q}${g}`));
        }
        return lines;
      },
      handleInput(data: string): void {
        // Tab cycles gender filter (all → female → male → all); Shift+Tab reverses
        if (data === "\t" || keybindings.matches(data, "tui.input.tab")) {
          cycleGender();
          tui.requestRender();
          return;
        }
        if (data === "\x1b[Z") {
          const prev: typeof genderFilter = genderFilter === "all" ? "male" : genderFilter === "male" ? "female" : "all";
          applyFilters(query, prev);
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) {
          list.handleInput(data);
          const sel = list.getSelectedItem();
          if (sel) {
            const idx = filteredItems.findIndex((it) => it.value === sel.value);
            if (idx >= 0) selectedIndex = idx;
          }
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          list.handleInput(data);
          const sel = list.getSelectedItem();
          if (sel) {
            const idx = filteredItems.findIndex((it) => it.value === sel.value);
            if (idx >= 0) selectedIndex = idx;
          }
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }

        // Typing for filter
        const before = input.getValue();
        input.handleInput(data);
        const after = input.getValue();
        if (before !== after) {
          updateFilter(after);
        }
        tui.requestRender();
      },
      invalidate(): void {
        input.invalidate?.();
        list.invalidate();
      },
    };
  });
  return selected ?? undefined;
}

async function chooseSpeed(
  ctx: ExtensionContext,
  current: number,
): Promise<number | undefined> {
  const currentLabel = String(current);
  const selected = await selectScrollable(ctx, `Speed · ${current}`, [...SPEED_VALUES], currentLabel);
  if (!selected) return undefined;
  const speed = Number.parseFloat(selected);
  return Number.isFinite(speed) ? speed : undefined;
}

type PreprocessingPickerResult = {
  preprocessingEnabled: boolean;
  preprocessingModel?: { provider: string; id: string };
};

async function choosePreprocessingModel(
  ctx: ExtensionContext,
  configured: PiSpeakSettings,
): Promise<PreprocessingPickerResult | undefined> {
  // Refresh registry on open with abort controller (15s timeout like ModelSelectorComponent)
  const refreshAbort = new AbortController();
  let refreshTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    refreshTimeout = setTimeout(() => refreshAbort.abort(), 15_000);
    // ModelRegistry.refresh has no signal param; try both signatures
    const registry = ctx.modelRegistry as unknown as { refresh: (opts?: { signal?: AbortSignal }) => Promise<void> };
    try {
      await registry.refresh({ signal: refreshAbort.signal });
    } catch {
      await ctx.modelRegistry.refresh();
    }
  } catch {}
  finally {
    if (refreshTimeout) clearTimeout(refreshTimeout);
  }

  const allModels = ctx.modelRegistry.getAvailable() as unknown as Array<{ provider: string; id: string; name?: string }>;
  const scopedModels = ctx.scopedModels as unknown as Array<{ model: { provider: string; id: string; name?: string } }>;
  const hasScoped = scopedModels.length > 0;
  let scope: "all" | "scoped" = hasScoped ? "scoped" : "all";

  type PickerItem = {
    kind: "disabled" | "model";
    provider?: string;
    id?: string;
    name?: string;
    label: string;
    description?: string;
    searchText: string;
  };

  function buildBase(s: typeof scope): PickerItem[] {
    const source: Array<{ provider: string; id: string; name?: string }> =
      s === "scoped"
        ? scopedModels.map((sm) => ({
            provider: sm.model.provider,
            id: sm.model.id,
            name: (sm.model as unknown as { name?: string }).name,
          }))
        : allModels.map((m) => ({ provider: m.provider, id: m.id, name: m.name }));

    // Sort: current model first, then by provider
    const sorted = [...source].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    if (configured.preprocessingEnabled && configured.preprocessingModel) {
      const cur = configured.preprocessingModel;
      sorted.sort((a, b) => {
        const aIsCurrent = a.provider === cur.provider && a.id === cur.id;
        const bIsCurrent = b.provider === cur.provider && b.id === cur.id;
        if (aIsCurrent && !bIsCurrent) return -1;
        if (!aIsCurrent && bIsCurrent) return 1;
        return 0;
      });
    }

    const disabled: PickerItem = {
      kind: "disabled",
      label: "Disabled",
      description: "Turn off preprocessing",
      searchText: "Disabled off disable",
    };
    const modelItems: PickerItem[] = sorted.map((m) => ({
      kind: "model",
      provider: m.provider,
      id: m.id,
      name: m.name,
      label: m.id,
      description: `[${m.provider}]${m.name ? ` ${m.name}` : ""}`,
      searchText: getModelSelectorSearchText({ provider: m.provider, id: m.id, name: m.name }),
    }));
    return [disabled, ...modelItems];
  }

  // Non-TUI fallback via simple select
  if (ctx.mode !== "tui") {
    const base = buildBase(scope);
    const currentLabel = configured.preprocessingEnabled && configured.preprocessingModel ? `${configured.preprocessingModel.provider}/${configured.preprocessingModel.id}` : "off";
    const title = `Preprocessing LLM · ${currentLabel}`;
    // Options as visible labels; keep Disabled first
    const options = base.map((p) => (p.kind === "disabled" ? "Disabled" : `${p.provider}/${p.id}${p.name ? ` — ${p.name}` : ""}`));
    const selected = await ctx.ui.select(title, options);
    if (!selected) return undefined;
    const idx = options.indexOf(selected);
    const chosen = base[idx];
    if (!chosen) return undefined;
    if (chosen.kind === "disabled") return { preprocessingEnabled: false };
    return { preprocessingEnabled: true, preprocessingModel: { provider: chosen.provider!, id: chosen.id! } };
  }

  // TUI picker: Input + SelectList + fuzzyFilter, TAB toggles scoped/all
  return ctx.ui.custom<PreprocessingPickerResult | undefined>((tui, theme, keybindings, done) => {
    const wrappedDone = (value: PreprocessingPickerResult | undefined) => {
      try {
        refreshAbort.abort();
      } catch {}
      done(value);
    };
    const input = new Input();
    let query = "";
    let basePickerItems = buildBase(scope);
    let filteredPickerItems: PickerItem[] = [...basePickerItems];
    let selectedIndex = 0;
    if (configured.preprocessingEnabled && configured.preprocessingModel) {
      const cur = configured.preprocessingModel;
      const idx = filteredPickerItems.findIndex((p) => p.kind === "model" && p.provider === cur.provider && p.id === cur.id);
      if (idx >= 0) selectedIndex = idx;
    }

    const termRows = (tui as unknown as { terminal?: { rows?: number } }).terminal?.rows ?? 24;
    const available = Math.max(5, Math.min(10, termRows - 12));

    const makeList = (pickerItems: PickerItem[], maxVis: number, selIdx: number) => {
      const selectItems = pickerItems.map((p) => ({
        value: p.kind === "disabled" ? "__disabled__" : `${p.provider}/${p.id}`,
        label: p.kind === "disabled" ? "Disabled" : p.label,
        description: p.description,
      }));
      const maxVisible = Math.min(selectItems.length, maxVis) || 1;
      const list = new SelectList(selectItems, maxVisible, selectTheme(theme));
      const clamped = Math.max(0, Math.min(selIdx, selectItems.length - 1));
      if (selectItems.length > 0) list.setSelectedIndex(clamped);
      list.onSelect = (item) => {
        const idx = selectItems.findIndex((s) => s.value === item.value);
        const picker = pickerItems[idx];
        if (!picker) {
          wrappedDone(undefined);
          return;
        }
        if (picker.kind === "disabled") wrappedDone({ preprocessingEnabled: false });
        else wrappedDone({ preprocessingEnabled: true, preprocessingModel: { provider: picker.provider!, id: picker.id! } });
      };
      list.onCancel = () => wrappedDone(undefined);
      list.onSelectionChange = (item) => {
        const idx = selectItems.findIndex((s) => s.value === item.value);
        if (idx >= 0) selectedIndex = idx;
      };
      return list;
    };

    let list = makeList(filteredPickerItems, available, selectedIndex);

    const applyFilters = (newQuery: string, newScope: typeof scope) => {
      query = newQuery;
      if (newScope !== scope) {
        scope = newScope;
        basePickerItems = buildBase(scope);
      }
      if (query.trim()) {
        filteredPickerItems = fuzzyFilter(basePickerItems, query, (p) => p.searchText);
        selectedIndex = 0;
      } else {
        filteredPickerItems = [...basePickerItems];
        // Restore selection to current model or Disabled
        if (configured.preprocessingEnabled && configured.preprocessingModel) {
          const cur = configured.preprocessingModel;
          const idx = filteredPickerItems.findIndex((p) => p.kind === "model" && p.provider === cur.provider && p.id === cur.id);
          selectedIndex = idx >= 0 ? idx : 0;
        } else {
          selectedIndex = 0;
        }
        // Clamp if previous selection was out of range (e.g., after scope toggle)
        selectedIndex = Math.min(selectedIndex, Math.max(0, filteredPickerItems.length - 1));
      }
      const newMax = Math.min(filteredPickerItems.length, available) || 1;
      list = makeList(filteredPickerItems, newMax, selectedIndex);
    };

    const toggleScope = () => {
      const next: typeof scope = scope === "all" ? "scoped" : "all";
      applyFilters(query, next);
    };

    let focused = true;
    input.focused = true;

    return {
      get focused() {
        return focused;
      },
      set focused(v: boolean) {
        focused = v;
        input.focused = v;
      },
      render(width: number): string[] {
        const w = Math.max(1, width);
        const lines: string[] = [];
        const currentLabel = configured.preprocessingEnabled && configured.preprocessingModel ? `${configured.preprocessingModel.provider}/${configured.preprocessingModel.id}` : "off";
        lines.push(theme.fg("accent", theme.bold(`Preprocessing LLM · ${currentLabel}`)));
        if (hasScoped) {
          const allText = scope === "all" ? theme.fg("accent", "all") : theme.fg("muted", "all");
          const scopedText = scope === "scoped" ? theme.fg("accent", "scoped") : theme.fg("muted", "scoped");
          lines.push(`${theme.fg("muted", "Scope: ")}${allText}${theme.fg("muted", " | ")}${scopedText}`);
          lines.push(theme.fg("dim", "Tab: toggle scope") + theme.fg("muted", " (all/scoped)"));
        } else {
          lines.push(theme.fg("warning", "Only showing models from configured providers. Use /login to add providers."));
        }
        lines.push("");
        lines.push(...input.render(w));
        lines.push("");
        lines.push(...list.render(w));
        lines.push("");
        lines.push(theme.fg("dim", hasScoped ? "↑↓ navigate • Tab scope • Enter select • Esc cancel" : "↑↓ navigate • Enter select • Esc cancel"));
        if (filteredPickerItems.length === 0) {
          const q = query.trim() ? ` for "${query}"` : "";
          lines.push(theme.fg("warning", `  No models match${q}`));
        }
        return lines;
      },
      handleInput(data: string): void {
        if (data === "\t" || keybindings.matches(data, "tui.input.tab")) {
          if (hasScoped) {
            toggleScope();
            tui.requestRender();
          }
          return;
        }
        if (data === "\x1b[Z") {
          if (hasScoped) {
            toggleScope();
            tui.requestRender();
          }
          return;
        }
        if (keybindings.matches(data, "tui.select.up")) {
          list.handleInput(data);
          const sel = list.getSelectedItem();
          if (sel) {
            const idx = filteredPickerItems.findIndex((p) => (p.kind === "disabled" ? "__disabled__" : `${p.provider}/${p.id}`) === sel.value);
            if (idx >= 0) selectedIndex = idx;
          }
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.down")) {
          list.handleInput(data);
          const sel = list.getSelectedItem();
          if (sel) {
            const idx = filteredPickerItems.findIndex((p) => (p.kind === "disabled" ? "__disabled__" : `${p.provider}/${p.id}`) === sel.value);
            if (idx >= 0) selectedIndex = idx;
          }
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.cancel")) {
          list.handleInput(data);
          tui.requestRender();
          return;
        }
        const before = input.getValue();
        input.handleInput(data);
        const after = input.getValue();
        if (before !== after) {
          applyFilters(after, scope);
        }
        tui.requestRender();
      },
      invalidate(): void {
        input.invalidate?.();
        list.invalidate();
      },
    };
  });
}

export async function showSpeakSettings(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  configured: PiSpeakSettings,
): Promise<boolean> {
  while (true) {
    const model = getCatalogModel(configured.model.id);
    if (!model) {
      ctx.ui.notify(`Unknown model: ${configured.model.id}`, "error");
      return false;
    }
    const theme = ctx.ui.theme;
    const voiceChoice = settingChoice(
      theme,
      "Voice",
      `${configured.voice}${voiceHint(configured.voice) ? ` (${voiceHint(configured.voice)})` : ""}`,
    );
    const speedChoice = settingChoice(theme, "Speed", String(configured.speed));
    const modelChoice = settingChoice(theme, "Model", model.name);
    const preprocessingLabel = configured.preprocessingEnabled && configured.preprocessingModel ? `${configured.preprocessingModel.provider}/${configured.preprocessingModel.id}` : "off";
    const preprocessingChoice = settingChoice(theme, "Preprocessing LLM", preprocessingLabel);
    const choices = [voiceChoice, speedChoice, modelChoice, preprocessingChoice, "Done"];
    const summary = "pi-speak settings";
    const choice = await ctx.ui.select(summary, choices);
    if (!choice || choice === "Done") return false;

    if (choice === voiceChoice) {
      const voice = await chooseVoice(ctx, configured.voice);
      if (!voice || voice === configured.voice) continue;
      const updated: PiSpeakSettings = { ...configured, voice };
      await writeSettings(updated);
      Object.assign(configured, updated);
      ctx.ui.notify(`Voice saved as ${voice}${voiceHint(voice) ? ` (${voiceHint(voice)})` : ""}`, "info");
      continue;
    }
    if (choice === speedChoice) {
      const speed = await chooseSpeed(ctx, configured.speed);
      if (speed === undefined || speed === configured.speed) continue;
      const updated: PiSpeakSettings = { ...configured, speed };
      await writeSettings(updated);
      Object.assign(configured, updated);
      ctx.ui.notify(`Speed saved as ${speed}`, "info");
      continue;
    }
    if (choice === modelChoice) {
      const changed = await runModelSelection(ctx, {
        currentModelId: configured.model.id,
        voice: configured.voice,
        speed: configured.speed,
        preprocessingEnabled: configured.preprocessingEnabled,
        preprocessingModel: configured.preprocessingModel,
        preprocessingPrompt: configured.preprocessingPrompt,
      });
      if (changed) Object.assign(configured, changed);
      continue;
    }
    if (choice === preprocessingChoice) {
      const result = await choosePreprocessingModel(ctx, configured);
      if (!result) continue;
      const isCurrentlyEnabled = !!configured.preprocessingEnabled;
      const isNewEnabled = !!result.preprocessingEnabled;
      const curModel = configured.preprocessingModel;
      const newModel = result.preprocessingModel;
      const sameModel = (!curModel && !newModel) || (!!curModel && !!newModel && curModel.provider === newModel.provider && curModel.id === newModel.id);
      if (isCurrentlyEnabled === isNewEnabled && sameModel) continue;
      let updated: PiSpeakSettings;
      if (!result.preprocessingEnabled) {
        updated = { ...configured, preprocessingEnabled: false };
        delete (updated as unknown as { preprocessingModel?: unknown }).preprocessingModel;
        await writeSettings(updated);
        configured.preprocessingEnabled = false;
        delete (configured as unknown as { preprocessingModel?: unknown }).preprocessingModel;
        ctx.ui.notify("Preprocessing disabled", "info");
      } else {
        updated = { ...configured, preprocessingEnabled: true, preprocessingModel: newModel! };
        await writeSettings(updated);
        configured.preprocessingEnabled = true;
        configured.preprocessingModel = newModel;
        ctx.ui.notify(`Preprocessing LLM saved as ${newModel!.provider}/${newModel!.id}`, "info");
      }
      continue;
    }
  }
}
