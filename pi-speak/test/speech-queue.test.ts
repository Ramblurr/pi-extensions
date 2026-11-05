import assert from "node:assert/strict";
import test from "node:test";
import { SpeechQueue } from "../src/speech-queue.js";

function gate() {
  let release!: () => void;
  return { promise: new Promise<void>((resolve) => { release = resolve; }), release: () => release() };
}

test("jobs run their whole lifecycle in order, without prefetch", async () => {
  const queue = new SpeechQueue();
  const first = gate();
  const order: string[] = [];
  const a = queue.enqueue(async () => { order.push("synthesize a"); await first.promise; order.push("played a"); });
  const b = queue.enqueue(async () => { order.push("synthesize b"); order.push("played b"); });
  await Promise.resolve();
  assert.deepEqual(order, ["synthesize a"]);
  first.release();
  await Promise.all([a, b]);
  assert.deepEqual(order, ["synthesize a", "played a", "synthesize b", "played b"]);
});

test("failures reach callers and do not strand later jobs", async () => {
  const queue = new SpeechQueue();
  let failedSignal: AbortSignal | undefined;
  const failure = queue.enqueue((signal) => { failedSignal = signal; throw new Error("synthesis failed"); });
  let ran = false;
  const next = queue.enqueue(async () => { ran = true; });
  await assert.rejects(failure, /synthesis failed/);
  assert.equal(failedSignal?.aborted, true);
  await next;
  assert.equal(ran, true);
});

test("stop cancels active, rejects pending, awaits cleanup, and permits reuse", async () => {
  const queue = new SpeechQueue();
  const cleanup = gate();
  let cleaned = false;
  const active = queue.enqueue(async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    await cleanup.promise;
    cleaned = true;
  });
  let pendingRan = false;
  const pending = queue.enqueue(async () => { pendingRan = true; });
  const activeRejected = assert.rejects(active, { name: "AbortError" });
  const pendingRejected = assert.rejects(pending, { name: "AbortError" });
  await Promise.resolve();
  let stopped = false;
  const stopping = queue.stop().then(() => { stopped = true; });
  await pendingRejected;
  assert.equal(stopped, false);
  cleanup.release();
  await Promise.all([stopping, activeRejected]);
  assert.deepEqual({ cleaned, pendingRan }, { cleaned: true, pendingRan: false });
  await queue.enqueue(async () => {});
  await queue.shutdown();
  await assert.rejects(queue.enqueue(async () => {}), /shut down/);
});

test("cancelled queued jobs never execute; pre-aborted jobs reject", async () => {
  const queue = new SpeechQueue();
  const hold = gate();
  const active = queue.enqueue(() => hold.promise);
  const controller = new AbortController();
  let ran = false;
  const pending = queue.enqueue(async () => { ran = true; }, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(queue.enqueue(async () => {}, controller.signal), { name: "AbortError" });
  hold.release();
  await active;
  assert.equal(ran, false);
  await queue.shutdown();
});

test("external cancellation reaches an active job", async () => {
  const queue = new SpeechQueue();
  const controller = new AbortController();
  const job = queue.enqueue(async (signal) => {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    signal.throwIfAborted();
  }, controller.signal);
  await Promise.resolve();
  controller.abort();
  await assert.rejects(job, { name: "AbortError" });
  await queue.shutdown();
});
