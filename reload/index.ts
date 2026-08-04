import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type MaybePromise<T> = T | Promise<T>;
type SubmitEditorText = (text: string) => MaybePromise<void>;

const RELOAD_COMPLETION_MESSAGE = "[Pi harness: reload completed successfully.]";
const RELOAD_COMPLETION_MESSAGE_TYPE = "pi-harness/reload-complete";
const RELOAD_CONTINUATION_REQUEST_TYPE = "execute-command/reload-continuation-request";
const RELOAD_CONTINUATION_CONSUMED_TYPE = "execute-command/reload-continuation-consumed";

type ReloadContinuationRequest = {
  id: string;
  message: string;
  reason?: string;
  requestedAt: number;
};

type ReloadContinuationConsumed = {
  id: string;
  consumedAt: number;
};

type CustomSessionEntry = {
  type?: unknown;
  customType?: unknown;
  data?: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReloadContinuationRequest(value: unknown): value is ReloadContinuationRequest {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.message === "string" &&
    typeof value.requestedAt === "number"
  );
}

function isReloadContinuationConsumed(value: unknown): value is ReloadContinuationConsumed {
  return isObject(value) && typeof value.id === "string" && typeof value.consumedAt === "number";
}

function sessionBranchEntries(ctx: ExtensionContext): CustomSessionEntry[] {
  try {
    const branch = ctx.sessionManager.getBranch();
    if (Array.isArray(branch)) return branch as CustomSessionEntry[];
  } catch {
    // Fall back to all entries below.
  }

  try {
    const entries = ctx.sessionManager.getEntries();
    if (Array.isArray(entries)) return entries as CustomSessionEntry[];
  } catch {
    // Ignore session inspection failures.
  }

  return [];
}

function pendingReloadContinuations(ctx: ExtensionContext): ReloadContinuationRequest[] {
  const consumed = new Set<string>();
  const requests: ReloadContinuationRequest[] = [];

  for (const entry of sessionBranchEntries(ctx)) {
    if (entry.type !== "custom") continue;

    if (entry.customType === RELOAD_CONTINUATION_CONSUMED_TYPE) {
      if (isReloadContinuationConsumed(entry.data)) consumed.add(entry.data.id);
      continue;
    }

    if (entry.customType === RELOAD_CONTINUATION_REQUEST_TYPE && isReloadContinuationRequest(entry.data)) {
      requests.push(entry.data);
    }
  }

  return requests.filter((request) => !consumed.has(request.id));
}

class AutoSubmitEditor extends CustomEditor {
  submitText(text: string): MaybePromise<void> {
    const submit = this.onSubmit as ((value: string) => MaybePromise<void>) | undefined;
    return submit?.(text);
  }
}

export default function reloadExtension(pi: ExtensionAPI) {
  // /reload is a built-in interactive command, not an extension command, and
  // tools only receive ExtensionContext (no ctx.reload()). Install an editor
  // bridge so the tool can submit /reload exactly as if the user pressed Enter,
  // but only after the current agent run becomes idle.
  let pendingReload: { reason?: string } | null = null;
  let submitEditorText: SubmitEditorText | null = null;

  const recordReloadContinuation = (reason?: string) => {
    const request: ReloadContinuationRequest = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      message: RELOAD_COMPLETION_MESSAGE,
      reason,
      requestedAt: Date.now(),
    };

    try {
      pi.appendEntry(RELOAD_CONTINUATION_REQUEST_TYPE, request);
    } catch {
      // Best effort only. Reload itself should still proceed.
    }
  };

  const sendHarnessMessageAfterIdle = (message: string, ctx: ExtensionContext, reason?: string) => {
    const maxAttempts = 200;

    const trySend = (attempt: number) => {
      try {
        if (!ctx.isIdle() && attempt < maxAttempts) {
          setTimeout(() => trySend(attempt + 1), 50);
          return;
        }

        pi.sendMessage(
          {
            customType: RELOAD_COMPLETION_MESSAGE_TYPE,
            content: message,
            display: true,
            details: { event: "reload-complete", reason },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not send reload completion message: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      }
    };

    setTimeout(() => trySend(0), 0);
  };

  const submitReloadAfterIdle = (ctx: ExtensionContext, reason?: string) => {
    const submit = submitEditorText;
    const ui = ctx.hasUI ? ctx.ui : undefined;
    const maxAttempts = 200;

    const trySubmit = (attempt: number) => {
      try {
        if (!ctx.isIdle()) {
          if (attempt < maxAttempts) {
            setTimeout(() => trySubmit(attempt + 1), 50);
          } else if (ui) {
            ui.setEditorText("/reload");
            ui.notify(
              `Timed out waiting to auto-submit /reload; press Enter to execute it${reason ? ` (${reason})` : ""}`,
              "warning",
            );
          }
          return;
        }
      } catch (error) {
        if (ui) {
          ui.setEditorText("/reload");
          ui.notify(
            `Could not check whether Pi is idle before /reload: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
        return;
      }

      if (!submit) {
        if (ui) {
          ui.setEditorText("/reload");
          ui.notify(
            `Could not auto-submit /reload; press Enter to execute it${reason ? ` (${reason})` : ""}`,
            "warning",
          );
        }
        return;
      }

      try {
        const result = submit("/reload");
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((error) => {
            if (ui) {
              ui.setEditorText("/reload");
              ui.notify(
                `Auto-submit failed for /reload: ${error instanceof Error ? error.message : String(error)}`,
                "error",
              );
            }
          });
        }
      } catch (error) {
        if (ui) {
          ui.setEditorText("/reload");
          ui.notify(
            `Auto-submit failed for /reload: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      }
    };

    setTimeout(() => trySubmit(0), 0);
  };

  pi.on("session_start", async (event, ctx) => {
    if (event.reason === "reload") {
      const pendingContinuations = pendingReloadContinuations(ctx);
      if (pendingContinuations.length > 0) {
        for (const request of pendingContinuations) {
          pi.appendEntry(RELOAD_CONTINUATION_CONSUMED_TYPE, {
            id: request.id,
            consumedAt: Date.now(),
          });
        }

        const latestRequest = pendingContinuations[pendingContinuations.length - 1];
        sendHarnessMessageAfterIdle(RELOAD_COMPLETION_MESSAGE, ctx, latestRequest?.reason);
      }
    }

    if (!ctx.hasUI) return;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      const editor = new AutoSubmitEditor(tui, theme, keybindings);
      submitEditorText = (text: string) => editor.submitText(text);
      return editor;
    });
  });

  pi.on("session_shutdown", async () => {
    submitEditorText = null;
    pendingReload = null;
  });

  pi.registerTool({
    name: "reload_runtime",
    label: "Reload Runtime",
    description:
      "NEVER use unless the user gives permission. Reload Pi keybindings, extensions, skills, prompts, themes, and context files. Use this after creating or changing extensions, skills, prompts, or other Pi resources that require /reload.",
    promptSnippet:
      "NEVER use unless the user gives permission. Reload Pi keybindings, extensions, skills, prompts, themes, and context files after changing Pi resources.",
    promptGuidelines: [
      "NEVER use unless the user gives permission. Use reload_runtime after changing Pi extensions, skills, prompts, themes, keybindings, or context files that require /reload.",
    ],
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({
          description: "Optional explanation for why Pi should reload.",
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      const reason = params.reason?.trim() || undefined;
      pendingReload = { reason };

      return {
        content: [
          {
            type: "text",
            text: reason
              ? `Queued /reload. It will run automatically after this turn finishes. Reason: ${reason}`
              : "Queued /reload. It will run automatically after this turn finishes.",
          },
        ],
        details: { command: "/reload", reason, mechanism: "editor-auto-submit" },
        terminate: true,
      };
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (!pendingReload) return;

    const { reason } = pendingReload;
    pendingReload = null;
    recordReloadContinuation(reason);
    submitReloadAfterIdle(ctx, reason);
  });
}
