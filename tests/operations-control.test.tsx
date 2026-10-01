import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OperationsControlPanel, OPERATIONS_CONTROL_STATES, type OperationsModeClient } from "../private-app/app/operations-control.tsx";

/** createElement's JSX overload does not infer a plain-object prop bag in a .tsx test;
 * this pins the props type the component actually declares. */
const Panel = OperationsControlPanel as FunctionComponent<{ client?: OperationsModeClient }>;
import type { OperationsModeV1, OperationsModeReceiptV1, OperationsModeViewV1 } from "../src/web/v1/operations-mode-wire";

type Client = { read: (signal?: AbortSignal) => Promise<OperationsModeViewV1>;
  set: (value: unknown, signal?: AbortSignal) => Promise<OperationsModeReceiptV1> };

const view = (mode: OperationsModeV1, over: Partial<OperationsModeViewV1> = {}): OperationsModeViewV1 => ({
  schema: "control-room.installation-operations-mode-view/v1", mode, reason: "", setByIdentityId: "", setAt: "",
  revision: 0, replayed: false, admitsNewWork: mode === "running", stopRequests: null,
  startsWork: false, grantsExecutionAuthority: false, ...over });

/** A client whose reads and writes are the only thing the component can do. */
function stubClient(initial: OperationsModeViewV1, options: { failRead?: boolean; failSet?: boolean } = {}) {
  const state = { current: initial, calls: [] as string[] };
  const client: Client = {
    read: async () => {
      state.calls.push("read");
      if (options.failRead) throw new Error("the endpoint is unavailable");
      return state.current;
    },
    set: async (value) => {
      const requested = value as { mode: OperationsModeV1; reason: string };
      state.calls.push(`set:${requested.mode}`);
      if (options.failSet) throw new Error("the endpoint refused");
      state.current = view(requested.mode, { reason: requested.reason, setByIdentityId: "identity:owner",
        setAt: new Date().toISOString(), revision: state.current.revision + 1,
        admitsNewWork: requested.mode === "running" });
      return { schema: "control-room.installation-operations-mode-receipt/v1", mode: state.current.mode,
        revision: state.current.revision, setAt: state.current.setAt, replayed: false, stopRequests: null,
        startsWork: false, grantsExecutionAuthority: false };
    },
  };
  return { state, client };
}

async function mount(element: () => unknown) {
  const jsdomModule = await import("jsdom");
  const JSDOM = (jsdomModule as { JSDOM: unknown }).JSDOM as new (html: string, options?: {
    url?: string; pretendToBeVisual?: boolean }) => { window: Window & typeof globalThis };
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(element() as never); });
  const restore = async () => {
    try { await React.act(async () => { root.unmount(); }); } catch { /* already torn down */ }
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
  return { document: dom.window.document, window: dom.window, act: React.act, restore };
}

test("the panel offers every mode, and the browser-note disclosure is gone", async () => {
  // The server-rendered shell, before any read: it must already say the state is
  // being read, never that it is running.
  const shell = renderToStaticMarkup(createElement(Panel, { client: stubClient(view("running")).client }));
  assert.match(shell, /Pause, drain or stop/);
  assert.match(shell, /Reading the current state/);
  assert.doesNotMatch(shell, /Work proceeds as normal/);

  const { client } = stubClient(view("running"));
  const mounted = await mount(() => createElement(Panel, { client }));
  try {
    const html = mounted.document.body.innerHTML;
    for (const label of ["Paused", "Draining", "Stopped", "Read again"]) assert.ok(html.includes(label), `missing ${label}`);
    // The old permanent disclosure said the state was a localStorage note that
    // nothing honoured. Both halves of that are now false, so neither may remain.
    assert.doesNotMatch(html, /stored in this browser/);
    assert.doesNotMatch(html, /currently checks it/);
    assert.doesNotMatch(html, /localStorage/);
  } finally { await mounted.restore(); }
});

test("it renders the mode the server reported, and reads again rather than inventing one", async () => {
  const { state, client } = stubClient(view("draining", { reason: "overnight", revision: 3,
    setByIdentityId: "identity:owner", setAt: new Date().toISOString() }));
  const mounted = await mount(() => createElement(Panel, { client }));
  try {
    const text = mounted.document.body.textContent ?? "";
    assert.match(text, /Draining/);
    assert.match(text, /overnight/);
    // The current state is not offered as a button: the owner presses the state
    // they want, not the one they have.
    assert.ok(!(mounted.document.querySelector("button")?.textContent === "Draining"), "the current mode is not a button");
    assert.deepEqual(state.calls, ["read"], "the panel reads once on mount and does not write anything");
  } finally { await mounted.restore(); }
});

test("an automatic pause says plainly that the Mac will restart work when it calms down", async () => {
  const { client } = stubClient(view("paused", { revision: 2, setByIdentityId: "identity:owner",
    reason: "Paused automatically — this Mac was too busy. It will start again by itself when things calm down.",
    setAt: new Date().toISOString(), admitsNewWork: false }));
  const mounted = await mount(() => createElement(Panel, { client }));
  try {
    assert.match(mounted.document.body.textContent ?? "",
      /Paused automatically — this Mac was too busy\. It will start again by itself when things calm down\./);
  } finally { await mounted.restore(); }
});

test("pressing a mode writes to the endpoint, with the reason, and shows what came back", async () => {
  const { state, client } = stubClient(view("running"));
  const mounted = await mount(() => createElement(Panel, { client }));
  try {
    const reason = mounted.document.getElementById("operations-control-reason") as HTMLTextAreaElement;
    await mounted.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(mounted.window.HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(reason, "lunch");
      reason.dispatchEvent(new mounted.window.Event("input", { bubbles: true }));
      await Promise.resolve();
    });
    const paused = [...mounted.document.querySelectorAll("button")].find(button => button.textContent === "Paused");
    assert.ok(paused, "a Paused button is offered while running");
    await mounted.act(async () => { paused!.click(); });
    assert.deepEqual(state.calls, ["read", "set:paused", "read"], "one write, then a re-read of what the server holds");
    assert.equal(state.current.mode, "paused");
    assert.equal(state.current.reason, "lunch", "the reason the owner typed is what was recorded");
    assert.match(mounted.document.body.textContent ?? "", /lunch/);
  } finally { await mounted.restore(); }
});

test("a failed read says the state is unknown; it never shows a green Running", async () => {
  const { client } = stubClient(view("running"), { failRead: true });
  const mounted = await mount(() => createElement(Panel, { client }));
  try {
    const text = mounted.document.body.textContent ?? "";
    assert.match(text, /could not read the current state/);
    assert.doesNotMatch(text, /Work proceeds as normal/);
    // The one action that is still trustworthy is offered; the state buttons are
    // not, because pressing one would be a blind write.
    assert.ok([...mounted.document.querySelectorAll("button")].some(button => button.textContent === "Read again"));
    assert.deepEqual([...mounted.document.querySelectorAll("button")].map(button => button.textContent), ["Read again"]);
  } finally { await mounted.restore(); }
});

test("a failed write keeps the last known state and says the change was not confirmed", async () => {
  const { state, client } = stubClient(view("running"), { failSet: true });
  const mounted = await mount(() => createElement(Panel, { client }));
  try {
    const paused = [...mounted.document.querySelectorAll("button")].find(button => button.textContent === "Paused");
    await mounted.act(async () => { paused!.click(); });
    const text = mounted.document.body.textContent ?? "";
    assert.match(text, /could not change the state/);
    assert.match(text, /Running/, "the last state the server confirmed is still shown");
    assert.equal(state.current.mode, "running", "nothing was recorded locally as if it had been");
  } finally { await mounted.restore(); }
});

test("the four modes are exactly running, paused, draining and stopped", () => {
  assert.deepEqual([...OPERATIONS_CONTROL_STATES], ["running", "paused", "draining", "stopped"]);
});

test("stopped reports what was asked to stop and what could not be confirmed", async () => {
  const { client } = stubClient(view("stopped", { revision: 4, setByIdentityId: "identity:owner",
    setAt: new Date().toISOString(), stopRequests: { requested: 3, revoked: 2, uncertainJobIds: ["job:x"] } }));
  const mounted = await mount(() => createElement(Panel, { client }));
  try {
    const text = mounted.document.body.textContent ?? "";
    assert.match(text, /asked 3 to stop; 2 were stopped here/);
    assert.match(text, /1 could not be stopped/);
    assert.match(text, /cannot confirm that a process on a worker saw the request/);
    // A process on a worker was never observed, and the copy does not imply it was.
    assert.doesNotMatch(text, /all running work has stopped/);
  } finally { await mounted.restore(); }
});
