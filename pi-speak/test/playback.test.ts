import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { playSpeechAudio } from "../src/playback.js";
import type { SpeechAudio } from "../src/speech-provider.js";

const format = { encoding: "pcm-s16le", sampleRate: 24000, channels: 1 } as const;
const stream = (chunks: AsyncIterable<Uint8Array>): SpeechAudio => ({ kind: "stream", format, chunks });

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for player");
    await delay(10);
  }
}
async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

// A real executable at the player boundary: no audio hardware or network required.
async function player(script: string, run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "pi-speak-player-test-"));
  const previousPath = process.env.PATH;
  try {
    const executable = join(dir, "pw-play");
    await writeFile(executable, `#!${process.execPath}\nconst fs = require("node:fs");\nconst dir = ${JSON.stringify(dir)};\nfs.writeFileSync(dir + "/pid", String(process.pid));\n${script}`);
    await chmod(executable, 0o700);
    process.env.PATH = dir;
    await run(dir);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
}

const linuxOnly = { skip: process.platform !== "linux" };

test("PCM reaches stdin before source completion and completion waits for player drain", linuxOnly, async () => {
  await player(`
fs.writeFileSync(dir + "/args", JSON.stringify(process.argv.slice(2)));
process.stdin.on("data", chunk => fs.appendFileSync(dir + "/audio", chunk));
process.stdin.on("end", () => setTimeout(() => fs.writeFileSync(dir + "/drained", "yes"), 100));
`, async (dir) => {
    let finalChunk = false;
    const audio = stream((async function* () {
      yield Buffer.from([1, 2]);
      await waitFor(() => exists(join(dir, "audio")));
      assert.deepEqual(await readFile(join(dir, "audio")), Buffer.from([1, 2]));
      finalChunk = true;
      yield Buffer.from([3, 4]);
    })());
    await playSpeechAudio(audio);
    assert.equal(finalChunk, true);
    assert.deepEqual(await readFile(join(dir, "audio")), Buffer.from([1, 2, 3, 4]));
    assert.equal(await exists(join(dir, "drained")), true);
    assert.deepEqual(JSON.parse(await readFile(join(dir, "args"), "utf8")), ["--raw", "--format", "s16", "--rate", "24000", "--channels", "1", "-"]);
  });
});

test("slow player applies backpressure instead of pulling the next chunk", linuxOnly, async () => {
  await player(`
const timer = setInterval(() => {
  if (fs.existsSync(dir + "/read")) {
    clearInterval(timer);
    process.stdin.on("data", () => {});
  }
}, 10);
`, async (dir) => {
    let pulled = 0;
    const playing = playSpeechAudio(stream((async function* () {
      pulled++;
      yield Buffer.alloc(8 * 1024 * 1024);
      pulled++;
      yield Buffer.alloc(2);
    })()));
    await waitFor(() => exists(join(dir, "pid")));
    await delay(50);
    assert.equal(pulled, 1);
    await writeFile(join(dir, "read"), "go");
    await playing;
    assert.equal(pulled, 2);
  });
});

test("buffered WAV is passed intact and temporary file is removed", linuxOnly, async () => {
  await player(`
const path = process.argv[2];
fs.writeFileSync(dir + "/path", path);
fs.copyFileSync(path, dir + "/audio");
`, async (dir) => {
    const wav = Buffer.from("RIFF test wav bytes");
    await playSpeechAudio({ kind: "buffered", wav });
    assert.deepEqual(await readFile(join(dir, "audio")), wav);
    assert.equal(await exists(await readFile(join(dir, "path"), "utf8")), false);
  });
});

test("abort interrupts a stalled iterator, closes it and terminates the player", linuxOnly, async () => {
  await player("setInterval(() => {}, 1000);", async (dir) => {
    let returned = false;
    const chunks: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: async () => { returned = true; return { done: true, value: undefined }; },
        };
      },
    };
    const controller = new AbortController();
    const playing = playSpeechAudio(stream(chunks), controller.signal);
    const rejected = assert.rejects(playing, { name: "AbortError" });
    await waitFor(() => exists(join(dir, "pid")));
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    controller.abort();
    await rejected;
    assert.equal(returned, true);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});

test("early successful player exit is an error, even while waiting for more audio", linuxOnly, async () => {
  await player("process.exit(0);", async () => {
    let returned = false;
    await assert.rejects(playSpeechAudio(stream({
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: async () => { returned = true; return { done: true, value: undefined }; },
        };
      },
    })), /exited before/);
    assert.equal(returned, true);
  });
});

test("player failures remain visible and buffered files are cleaned", linuxOnly, async () => {
  await player('fs.writeFileSync(dir + "/path", process.argv[2]); process.exit(7);', async (dir) => {
    await assert.rejects(playSpeechAudio({ kind: "buffered", wav: Buffer.alloc(2) }), /Audio player failed \(7\)/);
    assert.equal(await exists(await readFile(join(dir, "path"), "utf8")), false);
  });
});

test("buffered cancellation escalates termination and removes the temporary WAV", linuxOnly, async () => {
  await player(`
process.on("SIGTERM", () => {});
fs.writeFileSync(dir + "/path", process.argv[2]);
setInterval(() => {}, 1000);
`, async (dir) => {
    const controller = new AbortController();
    const playing = playSpeechAudio({ kind: "buffered", wav: Buffer.alloc(2) }, controller.signal);
    const rejected = assert.rejects(playing, { name: "AbortError" });
    await waitFor(() => exists(join(dir, "path")));
    const path = await readFile(join(dir, "path"), "utf8");
    const pid = Number(await readFile(join(dir, "pid"), "utf8"));
    controller.abort();
    await rejected;
    assert.equal(await exists(path), false);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  });
});

test("source failures and malformed PCM remain visible", linuxOnly, async () => {
  await player('process.stdin.resume();', async () => {
    await assert.rejects(playSpeechAudio(stream((async function* () {
      yield Buffer.alloc(2);
      throw new Error("source failed");
    })())), /source failed/);
    await assert.rejects(playSpeechAudio(stream((async function* () { yield Buffer.alloc(1); })())), /truncated/);
    await assert.rejects(playSpeechAudio(stream((async function* () {})())), /Empty/);
  });
});
