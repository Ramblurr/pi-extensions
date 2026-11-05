import assert from "node:assert/strict";
import test from "node:test";
import { cleanTextForSpeech, DEFAULT_PREPROCESSING_PROMPT, extractTextContent, SPEED_VALUES, speedToIndex, voiceHint } from "../src/text.js";

test("cleanTextForSpeech", async (t) => {
  await t.test("strips fenced code blocks entirely", () => {
    const input = "Hello ```js\nconsole.log('x')\n``` world";
    assert.equal(cleanTextForSpeech(input), "Hello world");
  });

  await t.test("keeps inline code text", () => {
    assert.equal(cleanTextForSpeech("Use `code` here"), "Use code here");
  });

  await t.test("keeps link label and image alt", () => {
    assert.equal(cleanTextForSpeech("See [link](http://x)"), "See link");
    assert.equal(cleanTextForSpeech("![alt](http://x)"), "alt");
  });

  await t.test("strips headings, blockquotes, list markers", () => {
    assert.equal(cleanTextForSpeech("# Title"), "Title");
    assert.equal(cleanTextForSpeech("## Heading"), "Heading");
    assert.equal(cleanTextForSpeech("> quote"), "quote");
    assert.equal(cleanTextForSpeech("- item"), "item");
    assert.equal(cleanTextForSpeech("* item"), "item");
    assert.equal(cleanTextForSpeech("1. item"), "item");
  });

  await t.test("strips bold/italic/strikethrough", () => {
    assert.equal(cleanTextForSpeech("**bold**"), "bold");
    assert.equal(cleanTextForSpeech("*italic*"), "italic");
    assert.equal(cleanTextForSpeech("***both***"), "both");
    assert.equal(cleanTextForSpeech("__bold__"), "bold");
    assert.equal(cleanTextForSpeech("_italic_"), "italic");
    assert.equal(cleanTextForSpeech("~~strike~~"), "strike");
  });

  await t.test("collapses spaces and trims", () => {
    assert.equal(cleanTextForSpeech("  hello   world  "), "hello world");
    assert.equal(cleanTextForSpeech("a  \n\n\n  b"), "a \n\n b");
  });

  await t.test("removes horizontal rules", () => {
    assert.equal(cleanTextForSpeech("hello\n---\nworld"), "hello\n\nworld");
    assert.equal(cleanTextForSpeech("***"), "");
  });

  await t.test("returns empty for only code fences", () => {
    assert.equal(cleanTextForSpeech("```js\ncode\n```"), "");
  });
});

test("extractTextContent", () => {
  assert.equal(extractTextContent(undefined), "");
  assert.equal(extractTextContent([]), "");
  assert.equal(
    extractTextContent([{ type: "text", text: "hello" }, { type: "image", text: "ignored" } as any]),
    "hello",
  );
  assert.equal(
    extractTextContent([{ type: "text", text: "a" }, { type: "text", text: "b" }]),
    "a\nb",
  );
});

test("voiceHint", () => {
  assert.equal(voiceHint("af_heart"), "American female");
  assert.equal(voiceHint("am_adam"), "American male");
  assert.equal(voiceHint("bf_emma"), "British female");
  assert.equal(voiceHint("bm_george"), "British male");
  assert.equal(voiceHint("jf_alpha"), "Japanese female");
  assert.equal(voiceHint("zf_beta"), "Mandarin female");
  // unknown fallback
  assert.equal(voiceHint("xx_unknown"), "");
});

test("SPEED_VALUES and speedToIndex", () => {
  assert.deepEqual([...SPEED_VALUES], ["0.5", "0.75", "1.0", "1.25", "1.5", "1.75", "2.0", "2.25", "2.5", "2.75", "3.0"]);
  assert.equal(speedToIndex(1.0), 2);
  assert.equal(speedToIndex(0.5), 0);
  assert.equal(speedToIndex(3.0), 10);
  assert.equal(speedToIndex(99), 0);
  assert.equal(speedToIndex(1.25), 3);
});

test("DEFAULT_PREPROCESSING_PROMPT", () => {
  assert.equal(
    DEFAULT_PREPROCESSING_PROMPT,
    "You are preparing text for a text-to-speech system. " +
      "You will receive a message from a conversation enclosed in quadruple backticks. " +
      "Summarize it in one single very short sentence, two at most. " +
      "Use a dry, matter-of-fact tone. " +
      "Do not use any markdown formatting, just plain text. " +
      "Prefer words over symbols or abbreviations, as this will be read aloud. " +
      "Output only the sentence, nothing else.",
  );
});
