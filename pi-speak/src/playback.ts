import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AUDIO_PLAYBACK_TIMEOUT_MS, getAudioPlayer } from "./audio.js";
import type { SpeechAudio } from "./speech-provider.js";

function streamPlayer(audio: Extract<SpeechAudio, { kind: "stream" }>): [string, string[]] {
  const { encoding, sampleRate, channels } = audio.format;
  if (encoding !== "pcm-s16le" || !Number.isSafeInteger(sampleRate) || sampleRate <= 0 ||
      !Number.isSafeInteger(channels) || channels <= 0) {
    throw new Error("Invalid PCM audio format");
  }
  if (process.platform === "darwin") {
    return ["ffplay", ["-nodisp", "-autoexit", "-f", "s16le", "-ar", String(sampleRate), "-ac", String(channels), "-i", "pipe:0"]];
  }
  const player = getAudioPlayer();
  switch (basename(player)) {
    case "pw-play":
      return [player, ["--raw", "--format", "s16", "--rate", String(sampleRate), "--channels", String(channels), "-"]];
    case "paplay":
      return [player, ["--raw", "--format=s16le", `--rate=${sampleRate}`, `--channels=${channels}`]];
    case "aplay":
      return [player, ["-t", "raw", "-f", "S16_LE", "-r", String(sampleRate), "-c", String(channels), "-"]];
    default:
      throw new Error("No supported streaming PCM audio player found");
  }
}

/** Resolves only after playback exits, not when the last byte is written. */
export async function playSpeechAudio(audio: SpeechAudio, signal?: AbortSignal): Promise<void> {
  let directory: string | undefined;
  const iterator = audio.kind === "stream" ? audio.chunks[Symbol.asyncIterator]() : undefined;
  let exhausted = false;
  try {
    signal?.throwIfAborted();
    let command: string;
    let args: string[];
    if (audio.kind === "buffered") {
      directory = await mkdtemp(join(tmpdir(), "pi-speak-"));
      const path = join(directory, "speech.wav");
      await writeFile(path, audio.wav, { mode: 0o600 });
      command = getAudioPlayer();
      args = [path];
    } else {
      [command, args] = streamPlayer(audio);
    }
    signal?.throwIfAborted();
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let rejectFailure!: (error: unknown) => void;
    const failure = new Promise<never>((_, reject) => { rejectFailure = reject; });
    // Every wait races this promise; keep failures handled between waits too.
    void failure.catch(() => {});
    let inputEnded = audio.kind === "buffered";
    let closed = false;
    const completion = new Promise<void>((resolve) => {
      child.once("close", (code, killedBy) => {
        closed = true;
        if (code !== 0) rejectFailure(new Error(`Audio player failed (${killedBy ?? code})`));
        else if (!inputEnded) rejectFailure(new Error("Audio player exited before the audio stream ended"));
        resolve();
      });
    });
    child.once("error", (error) => rejectFailure(new Error(`Cannot start audio player ${basename(command)}: ${error.message}`)));
    child.stdin.on("error", rejectFailure);
    // Drain stderr without exposing potentially sensitive child output or retaining it.
    child.stderr.resume();
    const abort = () => rejectFailure(signal?.reason ?? new DOMException("Speech cancelled", "AbortError"));
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timeout = setTimeout(() => rejectFailure(new Error("Audio playback timed out")), AUDIO_PLAYBACK_TIMEOUT_MS);
    try {
      let bytes = 0;
      if (iterator) {
        while (true) {
          const chunk = await Promise.race([iterator.next(), failure]);
          if (chunk.done) { exhausted = true; break; }
          bytes += chunk.value.byteLength;
          // Await the write callback: at most one chunk is buffered, even for a slow player.
          await Promise.race([
            new Promise<void>((resolve, reject) => {
              child.stdin.write(chunk.value, (error) => error ? reject(error) : resolve());
            }),
            failure,
          ]);
        }
        if (audio.kind === "stream" && (bytes === 0 || bytes % (2 * audio.format.channels) !== 0)) {
          throw new Error("Empty or truncated PCM audio stream");
        }
      }
      inputEnded = true;
      child.stdin.end();
      await Promise.race([completion, failure]);
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      child.stdin.destroy();
      if (!closed) {
        child.kill("SIGTERM");
        const kill = setTimeout(() => child.kill("SIGKILL"), 1000);
        try { await completion; } finally { clearTimeout(kill); }
      }
    }
  } finally {
    if (iterator && !exhausted) {
      // An arbitrary iterator may have an uninterruptible next(). Request closure,
      // but do not let it strand player cleanup; providers must honor the signal.
      void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
    }
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
