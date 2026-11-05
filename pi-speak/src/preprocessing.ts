import { homedir } from "node:os";
import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

let runtimePromise: Promise<ModelRuntime> | undefined;

export function getModelRuntime(): Promise<ModelRuntime> {
  runtimePromise ??= ModelRuntime.create();
  return runtimePromise;
}

export function _resetModelRuntimeForTests(): void {
  runtimePromise = undefined;
}

export function buildPreprocessingUserMessage(raw: string): string {
  return `""""\n${raw}\n""""`;
}

export type PreprocessingDeps = {
  getModelRuntime?: () => Promise<ModelRuntime>;
  createAgentSession?: typeof createAgentSession;
  createLoader?: (prompt: string) => DefaultResourceLoader;
  createSessionManager?: () => unknown;
};

export async function generatePreprocessedText(
  raw: string,
  prompt: string,
  model: unknown,
  _ctx: ExtensionContext,
  deps: PreprocessingDeps = {},
): Promise<string | null> {
  try {
    const userMessage = buildPreprocessingUserMessage(raw);

    const loader = deps.createLoader
      ? deps.createLoader(prompt)
      : new DefaultResourceLoader({
          cwd: process.cwd(),
          agentDir: resolve(homedir(), ".pi", "agent"),
          systemPromptOverride: () => prompt,
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        });
    await loader.reload();

    const modelRuntime = deps.getModelRuntime ? await deps.getModelRuntime() : await getModelRuntime();
    const sessionManager = deps.createSessionManager
      ? (deps.createSessionManager() as never)
      : SessionManager.inMemory();
    const createSession = deps.createAgentSession ?? createAgentSession;

    const { session } = await createSession({
      model: model as never,
      tools: [],
      sessionManager: sessionManager as never,
      modelRuntime,
      resourceLoader: loader,
    });

    try {
      let responseText = "";

      const unsub = session.subscribe((event: unknown) => {
        const e = event as {
          type: string;
          message?: { role?: string; content?: Array<{ type: string; text?: string }> };
        };
        if (e.type === "message_end" && e.message?.role === "assistant") {
          for (const part of e.message.content ?? []) {
            if (part.type === "text" && part.text) responseText += part.text;
          }
        }
      });

      await session.prompt(userMessage);
      unsub();

      const trimmed = responseText.trim();
      return trimmed.length > 0 ? trimmed : null;
    } finally {
      session.dispose();
    }
  } catch {
    return null;
  }
}
