import assert from "node:assert/strict";
import test from "node:test";
import { isApiKeySource, resolveElevenLabsKey } from "../src/credentials.js";

const config = { model: "eleven_v4" as const, voice: "voice", stability: 0.5, similarity: 0.75 };

test("API key sources resolve environment references and commands without accepting stored literals", async () => {
  const previous = process.env.PI_SPEAK_TEST_KEY;
  process.env.PI_SPEAK_TEST_KEY = "environment-value";
  try {
    assert.equal(await resolveElevenLabsKey({ ...config, apiKey: "$PI_SPEAK_TEST_KEY" }), "environment-value");
    assert.equal(await resolveElevenLabsKey({ ...config, apiKey: "${PI_SPEAK_TEST_KEY}" }), "environment-value");
    assert.equal(await resolveElevenLabsKey({ ...config, apiKey: "$!literal-$$-${PI_SPEAK_TEST_KEY}" }), "!literal-$-environment-value");
    process.env.PI_SPEAK_TEST_KEY = "updated-value";
    assert.equal(await resolveElevenLabsKey({ ...config, apiKey: "$PI_SPEAK_TEST_KEY" }), "updated-value");
    assert.equal(await resolveElevenLabsKey({ ...config, apiKey: "!printf 'command-value\\n'" }), "command-value");
    assert.equal(isApiKeySource("literal-secret"), false);
    await assert.rejects(resolveElevenLabsKey({ ...config, apiKey: "literal-secret" }), /API key source/);
  } finally {
    if (previous === undefined) delete process.env.PI_SPEAK_TEST_KEY;
    else process.env.PI_SPEAK_TEST_KEY = previous;
  }
});

test("failed credential commands never include stdout, stderr, or the command in errors", async () => {
  await assert.rejects(resolveElevenLabsKey({ ...config, apiKey: "!printf 'sensitive-stdout'; printf 'sensitive-stderr' >&2; exit 1" }), (error: Error) => {
    assert.doesNotMatch(error.message, /sensitive|printf/);
    assert.match(error.message, /credential command failed/i);
    return true;
  });
});

test("cancelled credential resolution does not run the command", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Stopped"));
  await assert.rejects(resolveElevenLabsKey({ ...config, apiKey: "!exit 1" }, controller.signal), /Stopped/);
});
