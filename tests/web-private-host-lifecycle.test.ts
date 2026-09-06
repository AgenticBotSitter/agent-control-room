import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { startPrivateHostLifecycle } from "../src/web/v1/private-host-lifecycle";

test("one signal lifetime spans startup and runtime cleanup", async () => {
  const signals = new EventEmitter();
  let starts = 0, closes = 0;
  const lifecycle = startPrivateHostLifecycle({ signals, async start(signal) {
    starts++; assert.equal(signal.aborted, false); return { async close() { closes++; } };
  } });
  await lifecycle.ready;
  signals.emit("SIGTERM"); signals.emit("SIGINT");
  assert.deepEqual(await lifecycle.completed, { status: "closed" });
  assert.equal(starts, 1); assert.equal(closes, 1); assert.equal(signals.eventNames().length, 0);
});

test("stop before scheduled startup prevents acquisition", async () => {
  let starts = 0;
  const lifecycle = startPrivateHostLifecycle({ signals: new EventEmitter(), async start() {
    starts++; return { async close() {} };
  } });
  lifecycle.stop();
  await assert.rejects(lifecycle.ready, /private_host_start_unavailable/);
  // This case is known not to have invoked startup at all.
  assert.deepEqual(await lifecycle.completed, { status: "closed" });
  assert.equal(starts, 0);
});

test("late host after canceled startup is closed, not published as ready", async () => {
  const signals = new EventEmitter();
  let release!: (host: { close(): Promise<void> }) => void;
  let signal!: AbortSignal;
  let closes = 0;
  const lifecycle = startPrivateHostLifecycle({ signals, start(value) {
    signal = value; return new Promise<{ close(): Promise<void> }>(resolve => { release = resolve; });
  } });
  await Promise.resolve(); signals.emit("SIGTERM");
  assert.equal(signal.aborted, true);
  release({ async close() { closes++; } });
  await assert.rejects(lifecycle.ready, /private_host_start_unavailable/);
  assert.deepEqual(await lifecycle.completed, { status: "closed" });
  assert.equal(closes, 1);
});

test("failed startup stays sanitized and is never retried", async () => {
  const signals = new EventEmitter(); let starts = 0;
  const lifecycle = startPrivateHostLifecycle({ signals, async start() {
    starts++; throw new Error("sensitive fixture details");
  } });
  await assert.rejects(lifecycle.ready, { message: "private_host_start_unavailable" });
  assert.deepEqual(await lifecycle.completed, { status: "cleanup_uncertain" });
  assert.equal(starts, 1); assert.equal(signals.eventNames().length, 0);
});

test("startup arriving after the shutdown deadline still closes without changing uncertainty", async () => {
  let release!: (host: { close(): Promise<void> }) => void;
  let closed!: () => void;
  let closes = 0;
  const didClose = new Promise<void>(resolve => { closed = resolve; });
  const lifecycle = startPrivateHostLifecycle({ signals: new EventEmitter(), shutdownMs: 10,
    start: () => new Promise<{ close(): Promise<void> }>(resolve => { release = resolve; }),
  });
  await Promise.resolve();
  lifecycle.stop();
  assert.deepEqual(await lifecycle.completed, { status: "cleanup_uncertain" });
  release({ async close() { closes++; closed(); } });
  await assert.rejects(lifecycle.ready, /private_host_start_unavailable/);
  await didClose;
  assert.equal(closes, 1);
  assert.deepEqual(await lifecycle.completed, { status: "cleanup_uncertain" });
});
