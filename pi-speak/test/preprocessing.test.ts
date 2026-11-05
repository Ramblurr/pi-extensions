import assert from "node:assert/strict";
import test from "node:test";
import { buildPreprocessingUserMessage, generatePreprocessedText, _resetModelRuntimeForTests } from "../src/preprocessing.js";
import { DEFAULT_PREPROCESSING_PROMPT } from "../src/text.js";

test("preprocessing", async (t) => {
  await t.test("buildPreprocessingUserMessage wraps raw in quadruple quotes verbatim", () => {
    assert.equal(buildPreprocessingUserMessage("hello"), `""""\nhello\n""""`);
    const raw = "# Title\n```code```\nworld";
    assert.equal(buildPreprocessingUserMessage(raw), `""""\n${raw}\n""""`);
    // no cleaning, no trimming of raw
    assert.equal(buildPreprocessingUserMessage("  spaced  "), `""""\n  spaced  \n""""`);
  });

  await t.test("generatePreprocessedText uses loader with correct prompt and noExtensions etc, and prompts wrapped message", async () => {
    _resetModelRuntimeForTests();
    let loaderPrompt: string | undefined;
    let loaderOptions: Record<string, unknown> | undefined;
    let prompted: string | undefined;
    let disposed = false;

    const fakeLoader = {
      reload: async () => {},
      getExtensions: () => ({ extensions: [] }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [] }),
      getSystemPrompt: () => loaderPrompt,
    } as unknown as import("@earendil-works/pi-coding-agent").DefaultResourceLoader;

    // Capture prompt via createLoader
    const createLoader = (prompt: string) => {
      loaderPrompt = prompt;
      loaderOptions = {
        cwd: process.cwd(),
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
      };
      return fakeLoader;
    };

    const fakeModelRuntime = {} as unknown as import("@earendil-works/pi-coding-agent").ModelRuntime;
    let getRuntimeCalls = 0;
    const getModelRuntime = async () => {
      getRuntimeCalls++;
      return fakeModelRuntime;
    };

    let storedCb: ((e: unknown) => void) | undefined;
    const fakeSession = {
      subscribe: (cb: (e: unknown) => void) => {
        storedCb = cb;
        return () => {
          storedCb = undefined;
        };
      },
      prompt: async (msg: string) => {
        prompted = msg;
        // simulate LLM emitting message_end before prompt resolves
        storedCb?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "  summary result  " }] } });
      },
      dispose: () => {
        disposed = true;
      },
    };

    const createAgentSession = async () => {
      return { session: fakeSession } as never;
    };

    const ctx = { modelRegistry: { find: () => undefined } } as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
    const raw = "raw **markdown**";
    const result = await generatePreprocessedText(raw, "my prompt", { provider: "openai", id: "gpt-4o" }, ctx, {
      getModelRuntime,
      createAgentSession: createAgentSession as never,
      createLoader,
      createSessionManager: () => ({}) as never,
    });

    assert.equal(prompted, `""""\n${raw}\n""""`, "should prompt wrapped raw");
    assert.equal(result, "summary result", "should return trimmed result");
    assert.equal(disposed, true, "should dispose session");
    assert.equal(loaderPrompt, "my prompt");
    assert.deepEqual(loaderOptions, {
      cwd: process.cwd(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    assert.equal(getRuntimeCalls, 1);
  });

  await t.test("generatePreprocessedText returns null on empty trimmed response", async () => {
    const fakeLoader = { reload: async () => {} } as unknown as import("@earendil-works/pi-coding-agent").DefaultResourceLoader;
    let storedCb2: ((e: unknown) => void) | undefined;
    const fakeSession = {
      subscribe: (cb: (e: unknown) => void) => {
        storedCb2 = cb;
        return () => {
          storedCb2 = undefined;
        };
      },
      prompt: async () => {
        storedCb2?.({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "   " }] } });
      },
      dispose: () => {},
    };
    const ctx = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
    const result = await generatePreprocessedText("raw", DEFAULT_PREPROCESSING_PROMPT, {}, ctx, {
      getModelRuntime: async () => ({}) as never,
      createAgentSession: (async () => ({ session: fakeSession })) as never,
      createLoader: () => fakeLoader,
      createSessionManager: () => ({}) as never,
    });
    assert.equal(result, null);
  });

  await t.test("generatePreprocessedText returns null on exception", async () => {
    const fakeLoader = { reload: async () => { throw new Error("loader fail"); } } as unknown as import("@earendil-works/pi-coding-agent").DefaultResourceLoader;
    const ctx = {} as unknown as import("@earendil-works/pi-coding-agent").ExtensionContext;
    const result = await generatePreprocessedText("raw", "prompt", {}, ctx, {
      getModelRuntime: async () => ({}) as never,
      createAgentSession: (async () => { throw new Error("session fail"); }) as never,
      createLoader: () => fakeLoader,
      createSessionManager: () => ({}) as never,
    });
    assert.equal(result, null);
  });

  await t.test("getModelRuntime memoizes ModelRuntime.create", async () => {
    _resetModelRuntimeForTests();
    let createCalls = 0;
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const origCreate = ModelRuntime.create;
    (ModelRuntime as unknown as { create: () => Promise<unknown> }).create = async () => {
      createCalls++;
      return {} as never;
    };
    try {
      const { getModelRuntime } = await import("../src/preprocessing.js");
      _resetModelRuntimeForTests();
      await getModelRuntime();
      await getModelRuntime();
      await getModelRuntime();
      assert.equal(createCalls, 1, "should memoize");
    } finally {
      (ModelRuntime as unknown as { create: typeof origCreate }).create = origCreate;
      _resetModelRuntimeForTests();
    }
  });
});
