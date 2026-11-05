import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { stripVTControlCharacters } from "node:util";
import type { VoicePage } from "./speech-provider.js";

type Voice = VoicePage["voices"][number];
export type VoicePickerResult = { kind: "voice"; voice: Voice } | undefined;

function singleLine(text: string): string {
  return stripVTControlCharacters(text).replace(/\s+/g, " ").trim();
}

export async function showVoicePicker(
  ctx: ExtensionContext,
  page: Pick<VoicePage, "voices">,
  preview?: (voice: string, signal: AbortSignal) => Promise<void>,
): Promise<VoicePickerResult> {
  // RPC has no custom component support. Keep its native dialog compact too.
  if (ctx.mode !== "tui") {
    const labels = page.voices.map((voice, index) => `${index + 1}. ${singleLine(voice.name)}`);
    const selected = await ctx.ui.select("Account voices", labels);
    if (selected === undefined) return undefined;
    const voice = page.voices[labels.indexOf(selected)];
    return voice ? { kind: "voice", voice } : undefined;
  }
  return ctx.ui.custom<VoicePickerResult>((tui, theme, keybindings, done) => {
    const items = page.voices.map((voice, index) => ({ value: String(index), label: singleLine(voice.name) || "Unnamed voice" }));
    let selectedIndex = 0;
    let visibleRows = 0;
    let list: SelectList;
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
      const voice = page.voices[selectedIndex];
      if (!previewEnabled || !preview || !voice) return;
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
            previewMessage = status ? `Preview failed (HTTP ${status})` : "Preview failed";
          }
        }).finally(() => {
          if (previewController === controller) {
            previewController = undefined;
            tui.requestRender();
          }
        });
      }, 300);
    };
    const finish = (result: VoicePickerResult): void => {
      stopPreview();
      done(result);
    };
    const select = (): void => {
      const voice = page.voices[selectedIndex];
      if (voice) finish({ kind: "voice", voice });
    };
    const component = {
      capturesViewportInput: true,
      render(width: number): string[] {
        const w = Math.max(1, width);
        const rows = Math.max(1, Math.min(10, tui.terminal.rows - 12));
        if (!list || rows !== visibleRows) {
          visibleRows = rows;
          list = new SelectList(items, rows, {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => theme.fg("accent", theme.bold(text)),
            description: (text) => theme.fg("muted", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          }, { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, Math.max(1, maxWidth), "…") });
          list.setSelectedIndex(selectedIndex);
        }
        const voice = page.voices[selectedIndex];
        const details = voice
          ? [singleLine(`ID: ${voice.id}`), ...wrapTextWithAnsi(singleLine(voice.description) || "No description available.", w)]
          : ["No voices available."];
        const detailLines = details.slice(0, 4);
        if (details.length > 4) detailLines[3] = truncateToWidth(`${detailLines[3]} …`, w, "…");
        while (detailLines.length < 4) detailLines.push("");
        const previewState = previewEnabled ? "on" : "off";
        const footer = preview
          ? `↑↓ · Enter · Esc · P preview ${previewState}`
          : "↑↓ move · Enter pick · Esc back";
        const status = previewEnabled ? `Uses credits · ${previewMessage || "select a voice"}` : "";
        return [
          theme.fg("accent", theme.bold("Account voices")), "",
          ...list.render(w), "",
          ...detailLines.map((line) => theme.fg("muted", line)), theme.fg("dim", status),
          theme.fg("dim", footer),
        ].map((line) => truncateToWidth(line, w, "…"));
      },
      handleInput(data: string): void {
        if (keybindings.matches(data, "tui.select.cancel")) { finish(undefined); return; }
        if (preview && (matchesKey(data, "p") || data === "P")) {
          previewEnabled = !previewEnabled;
          schedulePreview();
          tui.requestRender();
          return;
        }
        if (keybindings.matches(data, "tui.select.confirm")) { select(); return; }
        if (items.length === 0) return;
        const previousIndex = selectedIndex;
        // Use the injected bindings rather than SelectList's package-global manager.
        if (keybindings.matches(data, "tui.select.up")) selectedIndex = (selectedIndex + items.length - 1) % items.length;
        else if (keybindings.matches(data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % items.length;
        else if (keybindings.matches(data, "tui.select.pageUp")) selectedIndex = Math.max(0, selectedIndex - visibleRows);
        else if (keybindings.matches(data, "tui.select.pageDown")) selectedIndex = Math.min(items.length - 1, selectedIndex + visibleRows);
        else return;
        list?.setSelectedIndex(selectedIndex);
        if (selectedIndex !== previousIndex) schedulePreview();
        component.invalidate();
        tui.requestRender();
      },
      invalidate(): void { list?.invalidate(); },
      dispose: stopPreview,
    };
    return component;
  });
}
