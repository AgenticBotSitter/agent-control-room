import assert from "node:assert/strict";
import test from "node:test";
import { TestClock } from "./support/clock";

test("clock advances timers deterministically", () => {
  const clock = new TestClock(1_000);
  const events: string[] = [];
  clock.setTimeout(() => {
    events.push(`first:${clock.now()}`);
    clock.setTimeout(() => events.push(`nested:${clock.now()}`), 5);
  }, 10);
  const cancelled = clock.setTimeout(() => events.push("cancelled"), 10);
  clock.setTimeout(() => events.push(`second:${clock.now()}`), 20);
  clock.clearTimeout(cancelled);

  clock.advance(20);
  assert.equal(clock.now(), 1_020);
  assert.deepEqual(events, ["first:1010", "nested:1015", "second:1020"]);
});
