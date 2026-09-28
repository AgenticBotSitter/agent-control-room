import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { usePolledRead, type PolledReadState } from "../private-app/app/use-polled-read";
import type { PolledReadIntervalReason } from "../src/web/v1/polled-read-scheduler";

/**
 * The React adapter, exercised through the hook every owner page actually
 * uses.
 *
 * The scheduler has its own thorough tests, but they drive
 * `createPolledReadScheduler` directly. That left the adapter between the
 * scheduler and the pages untested, and two defects shipped through it that
 * the scheduler's own tests could not see: an `unchanged` fallback that
 * reported every read as unchanged, and error state that a later success
 * never cleared. These tests drive the hook itself.
 *
 * The hook schedules through the real `setTimeout`, so time is real and short:
 * a base interval of a few milliseconds over a few hundred milliseconds is
 * enough for the scheduler to take a dozen reads. Assertions are about the
 * *interval chosen* rather than the exact read count, so a slow or loaded
 * runner cannot make them flaky.
 */

const BASE_MS = 20;

function installDom() {
  const dom = new JSDOM("<div id='root'></div>");
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(
    key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as Record<string, PropertyDescriptor | undefined>;
  // JSDOM reports a document as hidden (it is a prerendered one), and the
  // hook deliberately never polls a hidden tab. These tests are about the
  // interval a *visible* page chooses, so the test document says it is
  // visible; the visibility behaviour itself is covered against the
  // scheduler, which is where it is implemented.
  Object.defineProperty(dom.window.document, "hidden", { configurable: true, get: () => false });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  return { dom, restore: () => {
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  } };
}

/** Waits real time, flushing React between slices so state updates land. */
async function settle(ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  }
}

interface Observation { delayMs: number; reason: PolledReadIntervalReason }

/**
 * Mounts the hook on a component and exposes both the state it returns and
 * the interval it chose for each poll.
 */
function mount<T>(options: {
  key: string;
  read: () => Promise<T>;
  unchanged?: (previous: T, next: T) => boolean;
}) {
  const { dom, restore } = installDom();
  const observed: Observation[] = [];
  const states: Array<PolledReadState<T>> = [];
  // A counter outside the render closure, so `read` stays referentially stable
  // and the read function never depends on the handle returned below.
  let reads = 0;
  const read = async (): Promise<T> => { reads += 1; return options.read(); };
  const onInterval = (delayMs: number, reason: PolledReadIntervalReason) => { observed.push({ delayMs, reason }); };
  const Probe = () => {
    const state = usePolledRead<T>({
      key: options.key, read, baseIntervalMs: BASE_MS, onInterval, unchanged: options.unchanged });
    states.push(state);
    return React.createElement("span", null, state.value === undefined ? "empty" : "held");
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  return {
    observed,
    states,
    get reads() { return reads; },
    text: () => dom.window.document.body.textContent ?? "",
    async start() { await act(async () => root.render(React.createElement(Probe))); },
    async stop() { await act(async () => root.unmount()); restore(); },
  };
}

test("a read that changes every time keeps polling at the base interval", async () => {
  // Every read returns a different value, so the page is not idle and must
  // never be treated as quiet. Regression: the adapter defaulted `unchanged`
  // to `true`, so *changing* data stretched the interval to the 4x ceiling
  // and the page fell minutes behind.
  let sequence = 0;
  const view = mount<{ items: number[] }>({
    key: "use-polled-read:changing",
    read: async () => ({ items: [++sequence] }),
  });
  try {
    await view.start();
    await settle(500);
    assert.ok(view.reads >= 5, `expected repeated reads, saw ${view.reads}`);
    assert.ok(view.observed.length > 0, "the hook reports the interval it chose");
    assert.ok(view.observed.every(entry => entry.reason === "base"),
      `changing data must stay on the base schedule, saw ${JSON.stringify(view.observed)}`);
    assert.ok(view.observed.every(entry => entry.delayMs === BASE_MS),
      `changing data must never be stretched, saw ${JSON.stringify(view.observed)}`);
    const stretched = view.observed.filter(entry => entry.delayMs > BASE_MS);
    assert.equal(stretched.length, 0, "in particular it must never reach the 4x quiet ceiling");
  } finally { await view.stop(); }
});

test("data that really is unchanged still backs off to the quiet ceiling", async () => {
  // The counter-test for the fix above: a page that has genuinely stopped
  // changing must still settle to a low read rate, or the backoff the PR
  // exists to provide is gone.
  const view = mount<{ items: number[] }>({
    key: "use-polled-read:unchanged",
    read: async () => ({ items: [1] }),
  });
  try {
    await view.start();
    await settle(500);
    assert.ok(view.reads >= 3, `expected repeated reads, saw ${view.reads}`);
    assert.ok(view.observed.some(entry => entry.reason === "quiet"),
      `identical data must be judged quiet, saw ${JSON.stringify(view.observed)}`);
    assert.ok(view.observed.some(entry => entry.delayMs === BASE_MS * 4),
      `the quiet stretch must still reach its ceiling, saw ${JSON.stringify(view.observed)}`);
  } finally { await view.stop(); }
});

test("a caller's own unchanged predicate still wins over the default", async () => {
  // A caller that knows better about its data can still say "always changed"
  // and hold the base interval even while the bytes are identical.
  const view = mount<{ items: number[] }>({
    key: "use-polled-read:predicate",
    read: async () => ({ items: [1] }),
    unchanged: () => false,
  });
  try {
    await view.start();
    await settle(400);
    assert.ok(view.reads >= 3, `expected repeated reads, saw ${view.reads}`);
    assert.ok(view.observed.every(entry => entry.reason === "base" && entry.delayMs === BASE_MS),
      `an explicit predicate must be honoured, saw ${JSON.stringify(view.observed)}`);
  } finally { await view.stop(); }
});

test("the hook's own error state is cleared by the next successful read", async () => {
  // The hook reports a failure through `error` and drops it on the next
  // success. The article reader's sticky error is a *component* concern and is
  // covered in tests/article-reader.test.mjs, which is where that bug lived.
  let attempt = 0;
  const view = mount<{ items: number[] }>({
    key: "use-polled-read:recover",
    read: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("No saved article text yet.");
      return { items: [attempt] };
    },
  });
  try {
    await view.start();
    await settle(400);
    assert.ok(view.reads >= 2, `expected a retry after the failure, saw ${view.reads}`);
    const last = view.states.at(-1)!;
    assert.equal(last.error, undefined, "a successful read leaves no error behind");
    assert.notEqual(last.value, undefined, "and the value is held");
    assert.equal(last.loading, false);
    assert.equal(view.text(), "held", "the page renders the value, not a failure");
  } finally { await view.stop(); }
});

test("a failure still surfaces as an error state with no value", async () => {
  // The other half of the contract: clearing on success must not mean never
  // reporting. A read that keeps failing reports the failure.
  const view = mount<{ items: number[] }>({
    key: "use-polled-read:always-fails",
    read: async () => { throw new Error("server unavailable"); },
  });
  try {
    await view.start();
    await settle(200);
    const last = view.states.at(-1)!;
    assert.equal(last.value, undefined);
    assert.ok(last.error instanceof Error, `expected the failure to be reported, got ${String(last.error)}`);
    assert.ok(view.observed.every(entry => entry.reason === "error"),
      `a failing read stays on the error schedule, saw ${JSON.stringify(view.observed)}`);
  } finally { await view.stop(); }
});
