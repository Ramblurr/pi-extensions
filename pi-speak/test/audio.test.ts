import assert from "node:assert/strict";
import test from "node:test";
import { createAudioQueue, getAudioPlayer } from "../src/audio.js";

test("getAudioPlayer", async (t) => {
  await t.test("darwin prefers /usr/bin/afplay when exists", () => {
    const player = getAudioPlayer("darwin", (p) => p === "/usr/bin/afplay");
    assert.equal(player, "/usr/bin/afplay");
  });

  await t.test("darwin falls back to afplay", () => {
    const player = getAudioPlayer("darwin", () => false);
    assert.equal(player, "afplay");
  });

  await t.test("linux prefers pw-play", () => {
    const player = getAudioPlayer("linux", (p) => p === "/usr/bin/pw-play");
    assert.equal(player, "/usr/bin/pw-play");
  });

  await t.test("linux falls through to paplay", () => {
    const exists = (p: string) => p === "/usr/bin/paplay";
    assert.equal(getAudioPlayer("linux", exists), "/usr/bin/paplay");
  });

  await t.test("linux falls through to aplay", () => {
    const exists = (p: string) => p === "/usr/bin/aplay";
    assert.equal(getAudioPlayer("linux", exists), "/usr/bin/aplay");
  });

  await t.test("linux returns aplay when nothing exists", () => {
    assert.equal(getAudioPlayer("linux", () => false), "aplay");
  });

  await t.test("linux prefers /usr/local/bin when /usr/bin missing", () => {
    const exists = (p: string) => p === "/usr/local/bin/pw-play";
    assert.equal(getAudioPlayer("linux", exists), "/usr/local/bin/pw-play");
  });
});

test("createAudioQueue serial drain", async () => {
  const queue = createAudioQueue();
  const order: number[] = [];

  // Mock play functions that record order
  let play1Started = false;

  let secondDone!: () => void;
  const secondFinished = new Promise<void>((r) => { secondDone = r; });

  queue.enqueue({
    async play() {
      play1Started = true;
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      order.push(10);
    },
  });

  queue.enqueue({
    async play() {
      // Should not start until first finishes
      assert.equal(play1Started, true);
      order.push(2);
      await new Promise((r) => setTimeout(r, 5));
      order.push(20);
      secondDone();
    },
  });

  await secondFinished;
  // Give drain final tick to reset playing
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [1, 10, 2, 20]);
  assert.equal(queue.playing, false);
  assert.equal(queue.size, 0);
});

test("createAudioQueue handles play rejection and continues", async () => {
  const queue = createAudioQueue();
  const order: number[] = [];

  let secondDone!: () => void;
  const secondFinished = new Promise<void>((r) => { secondDone = r; });

  queue.enqueue({
    async play() {
      order.push(1);
      throw new Error("play failed");
    },
  });

  queue.enqueue({
    async play() {
      order.push(2);
      secondDone();
    },
  });

  await secondFinished;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, [1, 2]);
  assert.equal(queue.playing, false);
});

test("createAudioQueue tracks size and playing", async () => {
  const queue = createAudioQueue();
  assert.equal(queue.size, 0);
  assert.equal(queue.playing, false);

  let resolve: () => void = () => {};
  const gate = new Promise<void>((r) => { resolve = r; });
  let secondDone!: () => void;
  const secondFinished = new Promise<void>((r) => { secondDone = r; });

  queue.enqueue({
    async play() {
      await gate;
    },
  });

  // Give drain a tick to start
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.playing, true);
  assert.equal(queue.size, 0);

  queue.enqueue({
    async play() {
      secondDone();
    },
  });
  assert.equal(queue.size, 1);
  assert.equal(queue.playing, true);

  resolve();
  await secondFinished;
  await new Promise((r) => setImmediate(r));
  assert.equal(queue.playing, false);
  assert.equal(queue.size, 0);
});
