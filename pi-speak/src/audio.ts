import { execFile } from "node:child_process";
import { existsSync } from "node:fs";

export const AUDIO_PLAYBACK_TIMEOUT_MS = 5 * 60 * 1000;

export function getAudioPlayer(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform === "darwin") {
    return exists("/usr/bin/afplay") ? "/usr/bin/afplay" : "afplay";
  }
  const candidates = [
    "/usr/bin/pw-play",
    "/usr/local/bin/pw-play",
    "/usr/bin/paplay",
    "/usr/local/bin/paplay",
    "/usr/bin/aplay",
    "/usr/local/bin/aplay",
  ];
  for (const cmd of candidates) {
    if (exists(cmd)) return cmd;
  }
  return "aplay";
}

export function playWav(outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(getAudioPlayer(), [outPath], { timeout: AUDIO_PLAYBACK_TIMEOUT_MS }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

export interface QueueItem {
  play: () => Promise<void>;
}

export interface AudioQueue {
  enqueue(item: QueueItem): void;
  readonly size: number;
  readonly playing: boolean;
}

export function createAudioQueue(): AudioQueue {
  const queue: QueueItem[] = [];
  let playing = false;

  function drain(): void {
    if (playing) return;
    const item = queue.shift();
    if (!item) return;
    playing = true;
    item
      .play()
      .catch(() => {})
      .finally(() => {
        playing = false;
        drain();
      });
  }

  return {
    enqueue(item: QueueItem) {
      queue.push(item);
      drain();
    },
    get size() {
      return queue.length;
    },
    get playing() {
      return playing;
    },
  };
}
