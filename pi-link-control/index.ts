import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "@sinclair/typebox";

type MaybePromise<T> = T | Promise<T>;
type SubmitEditorText = (text: string) => MaybePromise<void>;
type EditorWithSubmit = {
  onSubmit?: (text: string) => MaybePromise<void>;
};

const actions = ["connect", "disconnect"] as const;

class CommandEditor extends CustomEditor {
  submitText(text: string): MaybePromise<void> {
    const submit = this.onSubmit as SubmitEditorText | undefined;
    if (!submit) throw new Error("Pi editor submit handler is unavailable");
    return submit(text);
  }
}

export default function piLinkControlExtension(pi: ExtensionAPI): void {
  let submitEditorText: SubmitEditorText | null = null;
  let installEditorTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingCommands: string[] = [];

  const submitCommandsAfterIdle = (commands: string[], ctx: ExtensionContext) => {
    const submit = submitEditorText;
    const maxAttempts = 200;

    const trySubmit = async (attempt: number): Promise<void> => {
      try {
        if (!ctx.isIdle()) {
          if (attempt < maxAttempts) {
            setTimeout(() => void trySubmit(attempt + 1), 50);
          } else if (ctx.hasUI) {
            ctx.ui.notify("Timed out waiting to execute Pi Link command", "error");
          }
          return;
        }

        if (!submit) throw new Error("Pi editor submit handler is unavailable");
        for (const command of commands) await submit(command);
      } catch (error) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not execute Pi Link command: ${error instanceof Error ? error.message : String(error)}`,
            "error",
          );
        }
      }
    };

    setTimeout(() => void trySubmit(0), 0);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Install after other session_start handlers, then preserve any editor they
    // configured. Calling its submit callback runs slash-command dispatch
    // directly; it does not create or queue a user message.
    installEditorTimer = setTimeout(() => {
      installEditorTimer = null;
      const previousEditorFactory = ctx.ui.getEditorComponent();

      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor =
          previousEditorFactory?.(tui, theme, keybindings) ??
          new CommandEditor(tui, theme, keybindings);

        submitEditorText = (text: string) => {
          if (editor instanceof CommandEditor) return editor.submitText(text);

          const submit = (editor as unknown as EditorWithSubmit).onSubmit;
          if (!submit) throw new Error("Pi editor submit handler is unavailable");
          return submit(text);
        };

        return editor;
      });
    }, 0);
  });

  pi.on("session_shutdown", async () => {
    if (installEditorTimer) clearTimeout(installEditorTimer);
    installEditorTimer = null;
    submitEditorText = null;
    pendingCommands.length = 0;
  });

  pi.registerTool({
    name: "link_control",
    label: "Pi Link Control",
    description:
      "Connect this Pi terminal to the Pi Link hub under a required name, or disconnect it. Connecting again with a new name renames the terminal.",
    promptSnippet:
      "Connect this Pi terminal to Pi Link under a name, rename it, or disconnect it",
    promptGuidelines: [
      "Use link_control to connect, rename, or disconnect this Pi terminal; connect requires a name and reconnects under that name.",
    ],
    parameters: Type.Object({
      action: StringEnum(actions, {
        description: "Link action to perform",
      }),
      name: Type.Optional(
        Type.String({
          description: 'Terminal name; required when action is "connect"',
        }),
      ),
    }),

    async execute(_toolCallId, params) {
      if (!submitEditorText) {
        throw new Error("Pi Link control is available only in an interactive Pi session");
      }

      if (params.action === "connect") {
        const name = params.name?.trim().replace(/\s+/g, " ");
        if (!name) throw new Error('name is required when action is "connect"');
        pendingCommands.push(`/link-name ${name}`, "/link-connect");
      } else {
        pendingCommands.push("/link-disconnect");
      }

      return {
        content: [
          {
            type: "text",
            text: "Pi Link control will execute after this agent turn finishes.",
          },
        ],
        details: { action: params.action, mechanism: "editor-command-dispatch" },
      };
    },
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (pendingCommands.length === 0) return;
    submitCommandsAfterIdle(pendingCommands.splice(0), ctx);
  });
}
