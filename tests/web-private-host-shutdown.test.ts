import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { bindPrivateHostShutdown } from "../src/web/v1/private-host-shutdown";

test("signal bridge closes once, awaits cleanup, and retains other listeners", async () => {
  const signals = new EventEmitter();
  const other = () => {};
  signals.on("SIGTERM", other);
  let release!: () => void;
  let closes = 0;
  const owned = bindPrivateHostShutdown({ close: () => { closes++; return new Promise<void>(resolve => { release = resolve; }); } }, signals);
  assert.equal(closes, 0);
  signals.emit("SIGTERM"); signals.emit("SIGINT");
  const first = owned.stop(); assert.equal(first, owned.stop());
  await Promise.resolve(); await Promise.resolve();
  assert.equal(closes, 1);
  let finished = false; void owned.completed.then(() => { finished = true; });
  await Promise.resolve(); assert.equal(finished, false);
  release(); assert.deepEqual(await owned.completed, { status: "closed" });
  assert.deepEqual(signals.listeners("SIGTERM"), [other]);
  assert.equal(signals.listenerCount("SIGINT"), 0);
});

test("failure and ignored close deadline are uncertain without raw errors or retry", async () => {
  for (const fails of [true, false]) {
    let closes = 0;
    const signals = new EventEmitter();
    const owned = bindPrivateHostShutdown({ close: () => {
      closes++;
      return fails ? Promise.reject(new Error("sensitive fixture detail")) : new Promise<void>(() => {});
    } }, signals, 10);
    signals.emit("SIGINT");
    assert.deepEqual(await owned.completed, { status: "cleanup_uncertain" });
    assert.deepEqual(await owned.stop(), { status: "cleanup_uncertain" });
    assert.equal(closes, 1); assert.equal(signals.listenerCount("SIGTERM"), 0);
  }
});

test("invalid bound registers nothing", () => {
  const signals = new EventEmitter();
  assert.throws(() => bindPrivateHostShutdown({ close: async () => {} }, signals, Infinity));
  assert.equal(signals.eventNames().length, 0);
});
