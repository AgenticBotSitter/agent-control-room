import assert from "node:assert/strict";
import test from "node:test";
import { createPolledReadScheduler, type PolledReadIntervalReason } from "../src/web/v1/polled-read-scheduler";
import { sharePolledRequest, sharedRequestCountForTest } from "../src/web/v1/polled-request-sharing";

/** A hand-driven clock and timer queue, so these tests need no DOM and no waits. */
function harness() {
  let now = 0, nextTimer = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const intervals: Array<{ delayMs: number; reason: PolledReadIntervalReason }> = [];
  let hidden = false;
  return {
    options: {
      hidden: () => hidden,
      schedule: (callback: () => void, delayMs: number) => { const id = nextTimer++; timers.set(id, { at: now + delayMs, callback }); return id; },
      cancel: (timer: unknown) => { timers.delete(timer as number); },
      observe: (delayMs: number, reason: PolledReadIntervalReason) => { intervals.push({ delayMs, reason }); },
    },
    intervals,
    setHidden(value: boolean) { hidden = value; },
    get now() { return now; },
    /** Advances time, firing every timer whose deadline has passed, in order.
     * Each fired callback is followed by a full microtask drain so that an async
     * `read` settles (and arms its successor) before the next timer is due. */
    async advance(ms: number) {
      const target = now + ms;
      for (let guard = 0; guard < 10_000; guard++) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at);
        if (!due.length) break;
        const [id, timer] = due[0]!;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await new Promise<void>(resolve => setImmediate(resolve));
      }
      now = target;
      await new Promise<void>(resolve => setImmediate(resolve));
    },
    get pending() { return timers.size; },
  };
}

test("a read never overlaps itself: the next poll is armed only after the previous settles", async () => {
  const time = harness();
  let inFlight = 0, maxInFlight = 0, reads = 0, release!: () => void;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options,
    baseIntervalMs: 30_000,
    // The read stays outstanding until the test releases it, which is the
    // condition that would make a `setInterval` implementation overlap.
    read: () => { reads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight); return new Promise<number>(resolve => { release = () => { inFlight--; resolve(reads); }; }); },
    accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  assert.equal(reads, 1);
  // Four whole intervals pass while that one read is still open.
  await time.advance(120_000);
  assert.equal(reads, 1, "no second request may start while the first is in flight");
  assert.equal(maxInFlight, 1);
  release();
  await time.advance(0);
  assert.equal(reads, 1, "settling the read does not fire an immediate extra read");
  assert.equal(time.pending, 1, "it arms exactly one successor");
  await time.advance(30_000);
  assert.equal(reads, 2, "the next poll starts only once the previous one settled");
  release();
  await time.advance(0);
  scheduler.stop();
});

test("a trigger during a read is coalesced into exactly one follow-up", async () => {
  const time = harness();
  let reads = 0, release!: () => void;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options,
    baseIntervalMs: 30_000,
    read: () => { reads++; return new Promise<number>(resolve => { release = () => resolve(reads); }); },
    accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  assert.equal(reads, 1);
  // Four separate triggers while one read is outstanding.
  scheduler.trigger(); scheduler.trigger(); scheduler.trigger(); scheduler.trigger();
  assert.equal(reads, 1, "triggers during a read must not start requests");
  release();
  await time.advance(0);
  assert.equal(reads, 2, "coalesced triggers produce exactly one follow-up read");
  release();
  await time.advance(0);
  assert.equal(reads, 2, "and only one");
  scheduler.stop();
});

test("a hidden tab is never read, and returning to it refreshes immediately", async () => {
  const time = harness();
  let reads = 0;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 30_000,
    read: async () => ++reads, accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  assert.equal(reads, 1);
  time.setHidden(true);
  await time.advance(120_000);
  assert.equal(reads, 1, "a background tab must not poll");
  time.setHidden(false);
  scheduler.trigger();
  await time.advance(0);
  assert.equal(reads, 2, "returning to the tab refreshes at once");
  scheduler.stop();
});

test("failures back off exponentially and reset on the next success", async () => {
  const time = harness();
  let attempt = 0;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 10_000,
    read: async () => { if (attempt++ < 3) throw new Error("server unavailable"); return 1; },
    accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  assert.deepEqual(time.intervals.map(entry => entry.delayMs), [20_000], "first failure doubles");
  await time.advance(20_000);
  assert.deepEqual(time.intervals.map(entry => entry.delayMs), [20_000, 40_000], "second failure doubles again");
  await time.advance(40_000);
  assert.deepEqual(time.intervals.map(entry => entry.delayMs), [20_000, 40_000, 80_000], "third failure doubles again");
  // The fourth attempt succeeds, so the backoff must reset to the base interval.
  await time.advance(80_000);
  assert.equal(time.intervals.at(-1)?.delayMs, 10_000, "a success returns the page to the base interval");
  assert.equal(time.intervals.at(-1)?.reason, "base");
  scheduler.stop();
});

test("error backoff is bounded so a long outage still recovers on a fixed schedule", async () => {
  const time = harness();
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 10_000, maxErrorMultiplier: 8,
    read: async () => { throw new Error("down"); }, accept: () => {}, failed: () => {},
  });
  scheduler.start();
  // Step well past the ceiling each round so the ceiling itself is exercised
  // without depending on which multiplier the previous round happened to pick.
  for (let round = 0; round < 12; round++) await time.advance(80_000);
  assert.ok(time.intervals.length >= 10, `expected many rounds, saw ${time.intervals.length}`);
  assert.equal(Math.max(...time.intervals.map(entry => entry.delayMs)), 80_000, "never exceeds 8x base");
  assert.equal(Math.min(...time.intervals.map(entry => entry.delayMs)), 20_000, "and never collapses below 2x base");
  assert.ok(time.intervals.every(entry => entry.reason === "error"), "a failing read stays in the error schedule");
  scheduler.stop();
});

test("unchanged data stretches the interval, and any change returns it to base", async () => {
  const time = harness();
  let value = 1;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 30_000,
    read: async () => value, accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  // The first read has no predecessor, so it can only be judged "base".
  assert.equal(time.intervals.at(-1)?.delayMs, 30_000, "the first read is always at base");
  await time.advance(60_000);
  assert.equal(time.intervals.at(-1)?.delayMs, 60_000, "an unchanged read stretches to 2x");
  await time.advance(60_000);
  assert.equal(time.intervals.at(-1)?.delayMs, 120_000, "and then to the 4x ceiling");
  await time.advance(120_000);
  // A real change must take effect at once rather than at the stretched rate:
  // once it is read, the page is back at the base interval.
  value = 2;
  await time.advance(120_000);
  assert.ok(time.intervals.some(entry => entry.delayMs === 30_000 && entry.reason === "base"),
    `changed data returns to the base interval, saw ${JSON.stringify(time.intervals)}`);
  scheduler.stop();
});

test("unchanged data holds at the 4x quiet-backoff ceiling", async () => {
  const time = harness();
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 30_000,
    read: async () => 1, accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0); // initial value: base interval
  await time.advance(30_000); // first unchanged read: 2x
  await time.advance(60_000); // second unchanged read: 4x
  await time.advance(120_000); // third unchanged read: remains 4x
  await time.advance(120_000); // fourth unchanged read: still remains 4x
  const quietDelays = time.intervals.filter(entry => entry.reason === "quiet").map(entry => entry.delayMs);
  assert.deepEqual(quietDelays, [60_000, 120_000, 120_000, 120_000],
    "successive unchanged reads never stretch beyond the 4x ceiling");
  scheduler.stop();
});

test("focusing or returning to the tab earns the base interval, never a stretched one", async () => {
  const time = harness();
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 30_000,
    read: async () => 1, accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  await time.advance(180_000);
  assert.equal(time.intervals.at(-1)?.delayMs, 120_000, "idle page is stretched to the ceiling");
  const before = time.intervals.length;
  scheduler.trigger();
  // The trigger's own read runs immediately, and the interval it then arms
  // starts again from the base rather than resuming the stretched one.
  await time.advance(0);
  const armed = time.intervals.slice(before);
  assert.equal(armed.length, 1, "the trigger arms exactly one successor");
  assert.ok(armed[0]!.delayMs <= 60_000,
    `a focus must not resume a stretched interval, armed ${armed[0]!.delayMs}`);
  assert.equal(armed[0]!.delayMs, 60_000, "and it starts the stretch over from the beginning");
  scheduler.stop();
});

test("structural equality compares objects by value, so a reserialised body counts as unchanged", async () => {
  const time = harness();
  let reads = 0;
  const scheduler = createPolledReadScheduler<{ items: number[]; at: string }>({
    ...time.options, baseIntervalMs: 10_000,
    read: async () => { reads++; return { items: [1, 2], at: "same" }; },
    accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  // Every read returns a fresh object with identical content, which is what a
  // re-serialised JSON body looks like to the client.
  await time.advance(20_000);
  assert.equal(time.intervals.at(-1)?.delayMs, 20_000, "a new but equal object still counts as unchanged");
  assert.equal(time.intervals.at(-1)?.reason, "quiet");
  await time.advance(20_000);
  assert.equal(time.intervals.at(-1)?.delayMs, 40_000, "and the stretch keeps growing");
  assert.ok(reads >= 3);
  scheduler.stop();
});

test("a value that really differs is not mistaken for unchanged", async () => {
  const time = harness();
  let reads = 0;
  const scheduler = createPolledReadScheduler<{ items: number[] }>({
    ...time.options, baseIntervalMs: 10_000,
    read: async () => ({ items: [reads++] }), accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  await time.advance(10_000);
  assert.equal(time.intervals.at(-1)?.delayMs, 10_000, "differing content stays at base");
  assert.equal(time.intervals.at(-1)?.reason, "base");
  scheduler.stop();
});

test("stopping ends polling and aborts the read that is still in flight", async () => {
  const time = harness();
  let signal: AbortSignal | undefined, reads = 0;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 10_000,
    read: received => { reads++; signal = received; return new Promise<number>(() => {}); },
    accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  assert.equal(reads, 1);
  assert.equal(signal?.aborted, false);
  scheduler.stop();
  assert.equal(signal?.aborted, true, "the in-flight read is aborted");
  assert.equal(scheduler.stopped, true);
  await time.advance(120_000);
  assert.equal(reads, 1, "a stopped scheduler never reads again");
  assert.equal(time.pending, 0, "and leaves no timer behind");
  scheduler.stop();
  assert.equal(scheduler.stopped, true, "stop is idempotent");
});

test("concurrent readers of one endpoint share a single request", async () => {
  assert.equal(sharedRequestCountForTest(), 0);
  let requests = 0, release!: (value: string) => void;
  const key = "shared-endpoint-test";
  const request = () => { requests++; return new Promise<string>(resolve => { release = resolve; }); };
  const signal = new AbortController().signal;
  const first = sharePolledRequest(key, request, signal);
  const second = sharePolledRequest(key, request, signal);
  const third = sharePolledRequest(key, request, signal);
  assert.equal(requests, 1, "three concurrent readers issue one request");
  release("value");
  assert.deepEqual(await Promise.all([first, second, third]), ["value", "value", "value"]);
  assert.equal(sharedRequestCountForTest(), 0, "the entry is dropped once it settles");
  // A later reader must start a fresh request: this collapses concurrency, it
  // never stores a response.
  const later = sharePolledRequest(key, request, signal);
  assert.equal(requests, 2, "a settled request is never replayed");
  release("second");
  assert.equal(await later, "second");
  assert.equal(sharedRequestCountForTest(), 0);
});

test("a rejected shared request is not left behind for the next reader", async () => {
  const key = "shared-endpoint-failure";
  const signal = new AbortController().signal;
  await assert.rejects(sharePolledRequest(key, () => Promise.reject(new Error("read failed")), signal));
  assert.equal(sharedRequestCountForTest(), 0);
  assert.equal(await sharePolledRequest(key, () => Promise.resolve("recovered"), signal), "recovered");
});

test("one sharer can abort without cancelling a surviving reader", async () => {
  const key = "shared-endpoint-independent-abort";
  const first = new AbortController(), second = new AbortController();
  let requests = 0, underlying: AbortSignal | undefined, release!: (value: string) => void;
  const request = (signal: AbortSignal) => {
    requests += 1; underlying = signal;
    return new Promise<string>(resolve => { release = resolve; });
  };
  const abandoned = sharePolledRequest(key, request, first.signal);
  const survivor = sharePolledRequest(key, request, second.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests, 1);
  first.abort();
  await assert.rejects(abandoned, error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(underlying?.aborted, false, "the surviving reader still owns the shared request");
  release("value");
  assert.equal(await survivor, "value");
  assert.equal(sharedRequestCountForTest(), 0);
});

test("the underlying shared request is cancelled after every sharer aborts", async () => {
  const key = "shared-endpoint-all-abort";
  const first = new AbortController(), second = new AbortController();
  let underlying: AbortSignal | undefined;
  const request = (signal: AbortSignal) => {
    underlying = signal;
    return new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  };
  const one = sharePolledRequest(key, request, first.signal);
  const two = sharePolledRequest(key, request, second.signal);
  await new Promise<void>(resolve => setImmediate(resolve));
  first.abort(); second.abort();
  await Promise.all([
    assert.rejects(one, error => error instanceof DOMException && error.name === "AbortError"),
    assert.rejects(two, error => error instanceof DOMException && error.name === "AbortError"),
  ]);
  assert.equal(underlying?.aborted, true, "no subscriber remains to consume the request");
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(sharedRequestCountForTest(), 0);
});

test("a subscriber remounted in the abort tick starts a fresh shared request", async () => {
  const key = "shared-endpoint-abort-remount";
  let calls = 0;
  const request = (signal: AbortSignal) => new Promise<number>((resolve, reject) => {
    const call = ++calls;
    signal.addEventListener("abort", () => setTimeout(() => reject(signal.reason), 0), { once: true });
    setTimeout(() => resolve(call), 5);
  });
  const first = new AbortController();
  const abandoned = sharePolledRequest(key, request, first.signal);
  first.abort();
  const remounted = sharePolledRequest(key, request, new AbortController().signal);
  await assert.rejects(abandoned, error => error instanceof DOMException && error.name === "AbortError");
  assert.equal(await remounted, 2, "the new subscriber must not inherit the aborted request");
  assert.equal(calls, 2, "the remount starts a fresh request");
  assert.equal(sharedRequestCountForTest(), 0);
});

test("an invalid base interval is refused rather than silently polling at zero", () => {
  const time = harness();
  for (const baseIntervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
    assert.throws(() => createPolledReadScheduler({ ...time.options, baseIntervalMs, read: async () => 1, accept: () => {}, failed: () => {} }),
      /polled_read_interval_invalid/, `interval ${baseIntervalMs}`);
});

// The three regressions below were all found by the real owner-page suites
// after the first version of this hook shipped. Each is a behaviour the
// hand-written effects had and the shared hook initially lost.

test("a page mounted while hidden still settles its first read, then stops polling", async () => {
  const time = harness();
  time.setHidden(true);
  let reads = 0;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 30_000,
    read: async () => { reads++; return reads; },
    accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  assert.equal(reads, 1, "the first read of a mounted page is a page load, not a poll");
  await time.advance(120_000);
  assert.equal(reads, 1, "a hidden tab must not keep polling after it has settled");
  assert.equal(time.pending, 0, "a hidden tab arms no successor");
  scheduler.stop();
});

test("a forced trigger reads even where document.hidden is unreliable", async () => {
  const time = harness();
  time.setHidden(true);
  let reads = 0;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 30_000,
    read: async () => { reads++; return reads; },
    accept: () => {}, failed: () => {},
  });
  scheduler.start();
  await time.advance(0);
  assert.equal(reads, 1);
  // A focus event only reaches a tab the owner is looking at, so it must read
  // even in a DOM that reports itself hidden.
  scheduler.trigger(true);
  await time.advance(0);
  assert.equal(reads, 2, "focus forces a read");
  // An unforced trigger in a hidden tab still waits for visibility.
  scheduler.trigger();
  await time.advance(0);
  assert.equal(reads, 2, "an ordinary trigger in a hidden tab does not read");
  scheduler.stop();
});

test("a failed read arms a bounded backoff instead of retrying at the base interval", async () => {
  const time = harness();
  let reads = 0, failures = 0;
  const scheduler = createPolledReadScheduler<number>({
    ...time.options, baseIntervalMs: 1_000,
    read: async () => { reads++; throw new Error("upstream unavailable"); },
    accept: () => {}, failed: () => { failures++; },
  });
  scheduler.start();
  await time.advance(0);
  assert.equal(failures, 1);
  const delays: number[] = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const before = time.intervals.length;
    await time.advance(60_000);
    if (time.intervals.length > before) delays.push(time.intervals[time.intervals.length - 1]!.delayMs);
  }
  assert.ok(delays.length >= 3, `expected repeated retries, saw ${delays.length}`);
  assert.ok(delays[0]! > 1_000, `the first retry must back off past the base interval, got ${delays[0]}`);
  assert.ok(delays[2]! >= delays[0]!, "backoff grows while the read keeps failing");
  assert.ok(delays[delays.length - 1]! <= 1_000 * 64, "backoff stays bounded");
  scheduler.stop();
});
