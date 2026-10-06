import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { PrivateHome } from "../private-app/app/home-workspace";
import { LocalRuntimeContextV1 } from "../private-app/app/local-runtime";
import { PwaRegistration } from "../private-app/app/pwa-registration";
import { useOperationsControl, type OperationsControl, type OperationsModeClient } from "../private-app/app/operations-control";
import type { OperationsModeViewV1 } from "../src/web/v1/operations-mode-wire";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const running = { schema: "control-room.installation-operations-mode-view/v1", mode: "running",
  reason: "", setByIdentityId: "", setAt: "", revision: 0, replayed: false, admitsNewWork: true,
  stopRequests: null, startsWork: false, grantsExecutionAuthority: false };
const stopped = { ...running, mode: "stopped", admitsNewWork: false, revision: 1,
  setAt: "2026-10-02T00:00:00.000Z", setByIdentityId: "identity:owner", reason: "phone test",
  stopRequests: { requested: 0, revoked: 0, uncertainJobIds: [] } };

async function mount(element: React.ReactElement, fetcher: typeof fetch = fetch, worker?: unknown) {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control.invalid/", pretendToBeVisual: true });
  if (worker) Object.defineProperty(dom.window.navigator, "serviceWorker", { value: worker });
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    fetch: fetcher, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const close = async () => {
    try { await act(async () => root.unmount()); }
    finally {
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  };
  try { await act(async () => root.render(element)); }
  catch (error) { await close(); throw error; }
  return { dom, root, close, text: () => dom.window.document.body.textContent ?? "",
    button: (text: string) => [...dom.window.document.querySelectorAll("button")].find(b => b.textContent === text)! };
}
const home = () => <LocalRuntimeContextV1.Provider value={{ mode: "local" }}><PrivateHome /></LocalRuntimeContextV1.Provider>;
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });

test("R6PH-01 Home shares one mode read and retains its last answer on resume/focus", { timeout: 5000 }, async () => {
  let reads = 0, posts = 0, reply: typeof running | typeof stopped = running, status = 200;
  let release: ((response: Response) => void) | undefined;
  let hold = false;
  const signals: AbortSignal[] = [];
  const m = await mount(home(), (async (path, options) => {
    if (String(path) !== "/api/v1/operations-mode") return new Response(null, { status: 503 });
    if (options?.method === "POST") {
      posts++; assert.equal(JSON.parse(String(options.body)).mode, "stopped"); reply = stopped;
      return Response.json({ schema: "control-room.installation-operations-mode-receipt/v1", mode: stopped.mode,
        revision: stopped.revision, setAt: stopped.setAt, replayed: false, stopRequests: stopped.stopRequests,
        startsWork: false, grantsExecutionAuthority: false });
    }
    reads++; signals.push(options!.signal!);
    if (hold) return new Promise<Response>(resolve => { release = resolve; });
    return status === 200 ? Response.json(reply) : new Response(null, { status });
  }) as typeof fetch);
  const attention = () => m.dom.window.document.querySelector('[aria-labelledby="home-attention"]')!.textContent!;
  const visible = async (hidden: boolean) => act(async () => {
    Object.defineProperty(m.dom.window.document, "hidden", { configurable: true, value: hidden });
    m.dom.window.document.dispatchEvent(new m.dom.window.Event("visibilitychange"));
  });
  try {
    await settle();
    assert.equal(reads, 1, "Home and its panel use one read");
    assert.match(m.text(), /Work proceeds as normal/);
    hold = true;
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event("focus")));
    assert.match(attention(), /Checking/);
    assert.match(m.dom.window.document.querySelector('[aria-labelledby="operations-control-title"]')!.textContent!, /Checking/);
    assert.match(m.text(), /Work proceeds as normal/, "last known Running remains visible until the new answer");
    await act(async () => release!(Response.json(running)));
    await visible(true); hold = true;
    await visible(false);
    await act(async () => {
      for (let i = 0; i < 50; i++) {
        m.dom.window.dispatchEvent(new m.dom.window.Event("focus"));
        m.dom.window.document.dispatchEvent(new m.dom.window.Event("visibilitychange"));
      }
    });
    assert.equal(reads, 3, "50 focus/visibility bursts share the held request");
    assert.match(attention(), /Checking/);
    assert.match(m.dom.window.document.querySelector('[aria-labelledby="operations-control-title"]')!.textContent!, /Checking/);
    assert.match(m.text(), /Work proceeds as normal/, "last known Running remains visible until the new answer");
    await act(async () => release!(Response.json(stopped)));
    assert.match(attention(), /Stopped — nothing new/);
    assert.match(m.text(), /Control Room asked 0 to stop/);
    hold = false; reply = running;
    await act(async () => m.button("Read again").click());
    assert.doesNotMatch(attention(), /Stopped — nothing new/);
    assert.match(m.text(), /Work proceeds as normal/);
    status = 401;
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event("focus")));
    assert.match(m.text(), /Your session has ended/);
    assert.match(m.text(), /Work proceeds as normal/);
    assert.match(attention(), /Couldn’t refresh — showing the last known state/);
    await visible(true);
    assert.match(attention(), /Checking/, "a hidden failed state is unconfirmed until the resume check");
    await visible(false);
    status = 503;
    await act(async () => m.button("Read again").click());
    assert.match(m.text(), /current work mode could not be checked/);
    assert.match(m.text(), /Work proceeds as normal/);
    assert.match(attention(), /Couldn’t refresh — showing the last known state/);
    status = 200;
    await act(async () => m.button("Read again").click());
    assert.match(m.text(), /Work proceeds as normal/);
    await act(async () => m.button("Stopped").click());
    assert.equal(posts, 1);
    assert.match(attention(), /Stopped — nothing new/, "panel writes update the shared attention display");
    assert.match(m.text(), /Control Room asked 0 to stop/);
    hold = true;
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event("focus")));
    await visible(true);
    assert.equal(signals.at(-1)!.aborted, true, "hide cancels an unfinished read");
    const oldRelease = release!;
    await visible(false);
    const resumedRelease = release!;
    const beforeOldReply = reads;
    await act(async () => oldRelease(Response.json(running)));
    assert.match(attention(), /Checking/, "old completion cannot end the new check");
    assert.doesNotMatch(m.text(), /Work proceeds as normal/);
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event("focus")));
    assert.equal(reads, beforeOldReply, "old finally must not release the new request lock");
    await act(async () => resumedRelease(Response.json(stopped)));
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event("focus")));
    await visible(true);
    const failedOldRelease = release!;
    await visible(false);
    const retryRelease = release!;
    await act(async () => failedOldRelease(Response.json({ bad: "mode" })));
    assert.match(attention(), /Checking/, "a cancelled malformed reply cannot fail the new read");
    assert.doesNotMatch(m.dom.window.document.querySelector('[aria-labelledby="operations-control-title"]')!.textContent!, /could not be checked/);
    await act(async () => retryRelease(Response.json(stopped)));
    assert.match(attention(), /Stopped — nothing new/, "an old reply cannot overwrite the resumed read");
    await act(async () => m.dom.window.dispatchEvent(new m.dom.window.Event("focus")));
    await m.close();
    assert.equal(signals.at(-1)!.aborted, true, "unmount cancels pending reads");
    await act(async () => release!(Response.json(running)));
  } finally { await m.close(); }
});

test("R6PH-01 Stopped warning and buttons survive three slow polls, failed refreshes and a mode change", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0;
  let release!: (response: Response) => void;
  let drop!: (error: Error) => void;
  const m = await mount(home(), (async path => {
    if (String(path) !== "/api/v1/operations-mode") return new Response(null, { status: 503 });
    reads++;
    return reads === 1 ? Response.json(stopped) : new Promise<Response>((resolve, reject) => { release = resolve; drop = reject; });
  }) as typeof fetch);
  const attention = () => m.dom.window.document.querySelector('[aria-labelledby="home-attention"]')!;
  const panel = () => m.dom.window.document.querySelector('[aria-labelledby="operations-control-title"]')!;
  const sample = () => {
    assert.match(attention().textContent!, /Stopped — nothing new is claimed or started/);
    assert.match(panel().textContent!, /Stopped/);
    assert.deepEqual([...panel().querySelectorAll("button")].map(b => b.textContent), ["Running", "Paused", "Draining", "Read again"]);
    assert.ok([...panel().querySelectorAll("button")].every(b => !b.disabled));
  };
  try {
    await settle(); sample();
    for (let cycle = 0; cycle < 3; cycle++) {
      await act(async () => t.mock.timers.tick(30_000));
      assert.equal(reads, cycle + 2);
      for (let frame = 0; frame < 20; frame++) {
        sample();
        assert.match(attention().textContent!, /Checking…/);
        assert.match(panel().textContent!, /Checking…/);
        await act(async () => { await Promise.resolve(); });
      }
      await act(async () => release(Response.json(stopped)));
      sample(); assert.doesNotMatch(panel().textContent!, /Checking…/);
    }
    // Both a dropped read and invalid/missing mode data keep the saved answer.
    for (const response of [new Response(null, { status: 503 }), Response.json({ mode: "imaginary" }), Response.json(null)]) {
      await act(async () => m.button("Read again").click()); sample();
      await act(async () => release(response)); sample();
      assert.match(attention().textContent!, /Couldn’t refresh — showing the last known state/);
      assert.match(panel().textContent!, /Couldn’t refresh — showing the last known state/);
      assert.doesNotMatch(panel().textContent!, /Checking…/);
    }
    await act(async () => m.button("Read again").click()); sample();
    await act(async () => drop(new TypeError("connection dropped"))); sample();
    assert.match(attention().textContent!, /Couldn’t refresh — showing the last known state/);
    assert.match(panel().textContent!, /Couldn’t refresh — showing the last known state/);
    await act(async () => m.button("Read again").click()); sample();
    assert.doesNotMatch(panel().textContent!, /Couldn’t refresh/);
    await act(async () => release(Response.json(running)));
    assert.doesNotMatch(attention().textContent!, /Stopped —|Checking…|Couldn’t refresh/);
    assert.match(panel().textContent!, /Work proceeds as normal/);
    assert.deepEqual([...panel().querySelectorAll("button")].map(b => b.textContent), ["Paused", "Draining", "Stopped", "Read again"]);
    assert.equal(reads, 9, "three polls, four failed checks and one successful retry");
  } finally { await m.close(); }
});

test("R6PH-01 polls only while visible and serializes writes, failures and deliberate retries", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let reads = 0, writes = 0, fail = true;
  let release: (() => void) | undefined, writeSignal: AbortSignal | undefined;
  const client: OperationsModeClient = {
    read: async () => { reads++; return running as OperationsModeViewV1; },
    set: async (_value, signal) => {
      writes++; writeSignal = signal;
      await new Promise<void>(resolve => { release = resolve; });
      if (fail) throw new Error("offline");
      return { schema: "control-room.installation-operations-mode-receipt/v1", mode: "paused", revision: 1,
        setAt: stopped.setAt, replayed: false, stopRequests: null, startsWork: false, grantsExecutionAuthority: false };
    },
  };
  let control!: OperationsControl;
  function Harness() { control = useOperationsControl(client); return <p>{control.error}</p>; }
  const m = await mount(<Harness />);
  try {
    assert.equal(reads, 1);
    await act(async () => t.mock.timers.tick(30_000));
    assert.equal(reads, 2, "bounded visible poll");
    Object.defineProperty(m.dom.window.document, "hidden", { configurable: true, value: true });
    await act(async () => t.mock.timers.tick(90_000));
    assert.equal(reads, 2, "no hidden polling");
    Object.defineProperty(m.dom.window.document, "hidden", { configurable: true, value: false });
    let pending: Promise<boolean>[] = []; // set() answers whether the write was confirmed (r7pfix)
    await act(async () => { pending = Array.from({ length: 50 }, () => control.set("paused", "phone test")); });
    assert.equal(writes, 1, "50 callers share one write even with a client that has no lock");
    const beforePendingWritePoll = reads;
    await act(async () => t.mock.timers.tick(30_000));
    assert.equal(reads, beforePendingWritePoll, "automatic reads wait for the pending write");
    await act(async () => {
      Object.defineProperty(m.dom.window.document, "hidden", { configurable: true, value: true });
      m.dom.window.document.dispatchEvent(new m.dom.window.Event("visibilitychange"));
      Object.defineProperty(m.dom.window.document, "hidden", { configurable: true, value: false });
      m.dom.window.document.dispatchEvent(new m.dom.window.Event("visibilitychange"));
    });
    await act(async () => { release!(); await Promise.all(pending); });
    assert.match(m.text(), /could not change the state/);
    assert.equal(control.busy, false);
    assert.equal(control.checking, false, "a failed write after returning cannot leave checking stuck");
    await act(async () => t.mock.timers.tick(30_000));
    assert.equal(writes, 1, "polling never retries a failed write");
    fail = false;
    let retry!: Promise<boolean>;
    await act(async () => { retry = control.set("paused", "deliberate retry"); });
    await act(async () => { release!(); await retry; });
    assert.equal(writes, 2);
    assert.equal(control.busy, false);
    assert.equal(control.error, undefined);
    await act(async () => { retry = control.set("paused", "stop halfway"); });
    await m.close();
    assert.equal(writeSignal!.aborted, true, "unmount aborts a write without replaying it");
    const readsAfterClose = reads;
    await assert.doesNotReject(async () => control.refresh(), "a retired read callback stays inert");
    await act(async () => { release!(); await retry; });
    assert.equal(writes, 3);
    await assert.doesNotReject(async () => control.set("paused", "after unmount"), "a retired write callback stays inert");
    assert.equal(reads, readsAfterClose, "a retired callback cannot start another read");
    assert.equal(writes, 3, "a retired callback cannot start another write");
  } finally { await m.close(); }
});

test("R6PH-01 a cancelled read error cannot contaminate the new read", { timeout: 5000 }, async () => {
  let control!: OperationsControl;
  const requests: Array<{ resolve: (value: OperationsModeViewV1) => void; reject: (error: Error) => void }> = [];
  const client: OperationsModeClient = {
    read: () => new Promise<OperationsModeViewV1>((resolve, reject) => { requests.push({ resolve, reject }); }),
    set: async () => { throw new Error("unused"); },
  };
  function Harness() { control = useOperationsControl(client); return null; }
  const m = await mount(<Harness />);
  try {
    await act(async () => {
      Object.defineProperty(m.dom.window.document, "hidden", { configurable: true, value: true });
      m.dom.window.document.dispatchEvent(new m.dom.window.Event("visibilitychange"));
      Object.defineProperty(m.dom.window.document, "hidden", { configurable: true, value: false });
      m.dom.window.document.dispatchEvent(new m.dom.window.Event("visibilitychange"));
    });
    assert.equal(requests.length, 2);
    await act(async () => requests[0]!.reject(new Error("cancelled old response")));
    assert.equal(control.error, undefined, "old failure belongs to the cancelled request");
    assert.equal(control.checking, true);
    await act(async () => requests[1]!.resolve(stopped as OperationsModeViewV1));
    assert.equal(control.view!.mode, "stopped");
    assert.equal(control.checking, false);
  } finally { await m.close(); }
});

class TrackedTarget extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (callback) {
      const listeners = this.listeners.get(type) ?? new Set(); listeners.add(callback); this.listeners.set(type, listeners);
    }
    super.addEventListener(type, callback, options);
  }
  override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (callback) this.listeners.get(type)?.delete(callback);
    super.removeEventListener(type, callback, options);
  }
}
class Worker extends TrackedTarget {
  // r7pfix (D20) offers an update only for a waiter the browser reports as
  // "installed" while a controller already serves the page, as a real update does.
  state = "installed";
  messages: unknown[] = [];
  postMessage(value: unknown) { this.messages.push(value); }
}
class Registration extends TrackedTarget {
  installing: Worker | null = null;
  waiting: Worker | null = null;
}
test("R6PH-02 watches already installing, already waiting and future/replaced workers", { timeout: 5000 }, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const initial of ["installing", "waiting", "future"]) {
    const registration = new Registration(), first = new Worker(), second = new Worker();
    second.state = "installing"; // the replacement is still installing until its own statechange
    registration.installing = initial === "installing" ? first : null;
    registration.waiting = initial === "waiting" ? first : null;
    const container = Object.assign(new TrackedTarget(), { register: async () => registration, controller: new Worker() });
    const m = await mount(<PwaRegistration />, fetch, container);
    try {
      if (initial !== "waiting") {
        assert.equal(Boolean(m.button("Reload for update")), false);
        await act(async () => {
          if (initial === "future") { registration.installing = first; registration.dispatchEvent(new Event("updatefound")); }
          registration.waiting = first; first.dispatchEvent(new Event("statechange"));
        });
      }
      assert.ok(m.button("Reload for update"), initial);
      assert.deepEqual(first.messages, [], "no automatic activation");
      await act(async () => m.button("Reload for update").click());
      assert.deepEqual(first.messages, [{ type: "control-room.activate-update" }]);
      // r7pfix (D20): one request owns the control until the page reloads or its
      // 10-second bound ends it. No controller change came, so let the bound end it.
      await act(async () => t.mock.timers.tick(10_000));
      await act(async () => {
        registration.waiting = null; registration.installing = second;
        for (let i = 0; i < 50; i++) registration.dispatchEvent(new Event("updatefound"));
      });
      assert.equal(Boolean(m.button("Reload for update")), false, "a departed waiting worker is cleared");
      await act(async () => { registration.waiting = second; first.dispatchEvent(new Event("statechange")); });
      assert.equal(Boolean(m.button("Reload for update")), false, "old worker no longer has a listener");
      await act(async () => { second.state = "installed"; second.dispatchEvent(new Event("statechange")); });
      await act(async () => m.button("Reload for update").click());
      assert.equal(second.messages.length, 1);
      await m.close();
      assert.equal(second.listeners.get("statechange")!.size, 0, "unmount removes the worker listener");
      assert.equal(registration.listeners.get("updatefound")!.size, 0, "unmount removes registration listener");
      assert.equal(container.listeners.get("controllerchange")!.size, 0, "unmount removes container listener");
      await act(async () => { registration.dispatchEvent(new Event("updatefound")); second.dispatchEvent(new Event("statechange")); });
    } finally { await m.close(); }
  }
});

test("R6PH phone layout at 375px and 320px with 200% text and live controls", { timeout: 30_000 }, async t => {
  // Bundle actual components before attempting launch, so a sandbox skip does
  // not hide a broken fixture. No server, microphone or real service worker.
  const bundle = await build({ write: false, bundle: true, platform: "browser", format: "iife", jsx: "automatic",
    stdin: { resolveDir: process.cwd(), loader: "tsx", contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { PrivateHome } from './private-app/app/home-workspace';
      import { LocalRuntimeContextV1 } from './private-app/app/local-runtime';
      import { PwaRegistration } from './private-app/app/pwa-registration';
      import { VoiceControlsWorkspace } from './private-app/app/voice-controls-workspace';
      const polls = [];
      window.setInterval = callback => { polls.push(callback); return polls.length; };
      window.clearInterval = () => {};
      window.phonePoll = () => polls.forEach(callback => callback());
      window.holdMode = false;
      window.fetch = async path => String(path) === '/api/v1/operations-mode'
        ? window.holdMode ? new Promise(resolve => { window.releaseMode = resolve; }) : Response.json(${JSON.stringify(stopped)}) : new Response(null, { status: 503 });
      window.phoneEngine = null;
      window.SpeechRecognition = class { constructor() { window.phoneEngine = this; } start() {} stop() {} abort() {} };
      const installing = new EventTarget(), registration = new EventTarget();
      Object.assign(registration, { installing, waiting: null });
      // An update, not a first install: a controller serves the page and the waiter reports "installed" (r7pfix, D20).
      Object.defineProperty(navigator, 'serviceWorker', { value: Object.assign(new EventTarget(), { register: async () => registration, controller: {} }) });
      window.finishPhoneUpdate = () => { registration.waiting = { state: 'installed', postMessage() {} }; installing.dispatchEvent(new Event('statechange')); };
      createRoot(document.getElementById('root')).render(<><PwaRegistration />
        <LocalRuntimeContextV1.Provider value={{ mode: 'local' }}><PrivateHome /></LocalRuntimeContextV1.Provider>
        <div className="private-shell"><main><VoiceControlsWorkspace /></main></div></>);
    ` }, plugins: [{ name: "unused-node-crypto", setup(builder) {
      builder.onResolve({ filter: /^node:crypto$/ }, () => ({ path: "node:crypto", namespace: "unexercised" }));
      builder.onLoad({ filter: /.*/, namespace: "unexercised" }, () => ({
        contents: 'export function createHash(){throw new Error("unexercised_node_crypto_in_phone_fixture")}', loader: "js" }));
    } }] });
  let browser;
  try { browser = await chromium.launch({ timeout: 8000 }); }
  catch (error) {
    if (String(error).includes("Executable doesn't exist")) { t.skip("Chromium is not provisioned"); return; }
    if (String(error).includes("bootstrap_check_in") && String(error).includes("Permission denied")) {
      t.skip("Chromium is blocked before navigation by the OS sandbox Mach-port policy; 375px/320px painted layout is unverified"); return;
    }
    throw error;
  }
  try {
    const css = ["../node_modules/tailwindcss/preflight.css", "../styles/control-room.css", "../private-app/app/private.css"]
      .map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n");
    for (const width of [375, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 812 }, isMobile: true, hasTouch: true });
      page.setDefaultTimeout(5000);
      try {
        await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\nhtml { font-size: 32px !important; }</style><div id="root"></div>`);
        await page.addScriptTag({ content: bundle.outputFiles![0]!.text });
        await page.getByText("Stopped — nothing new", { exact: false }).waitFor();
        await page.evaluate(() => (window as any).finishPhoneUpdate());
        await page.getByRole("button", { name: "Reload for update" }).waitFor();
        await page.getByRole("checkbox", { name: "Enable voice controls (optional)" }).check();
        await page.getByRole("button", { name: "Start dictation" }).click();
        await page.evaluate(() => (window as any).phoneEngine.onresult({ results: [[{ transcript: "phone draft to confirm" }]] }));
        await page.getByRole("button", { name: "Stop listening" }).click();
        await page.getByText("Heard: phone draft to confirm").waitFor();
        assert.equal(await page.locator("#voice-local-draft").inputValue(), "");
        const layout = await page.evaluate(() => ({ font: getComputedStyle(document.documentElement).fontSize,
          width: innerWidth, scroll: document.documentElement.scrollWidth,
          title: (() => { const h = document.querySelector(".private-everything-else-heading h2");
            const r = h!.getBoundingClientRect(); return { width: r.width, height: r.height, lineHeight: parseFloat(getComputedStyle(h!).lineHeight) }; })(),
          outside: [...document.querySelectorAll("button, textarea, [data-field=voice-heard-preview], .private-pwa-update")]
            .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > innerWidth + 1); })
            .map(el => el.textContent?.slice(0, 80)) }));
        assert.equal(layout.font, "32px"); assert.equal(layout.width, width);
        assert.ok(layout.scroll <= width + 1, JSON.stringify(layout)); assert.deepEqual(layout.outside, []);
        assert.ok(layout.title.width >= 120, JSON.stringify(layout.title));
        assert.ok(layout.title.height <= layout.title.lineHeight * 3 + 1, "Everything else stays readable");
        for (let cycle = 0; cycle < 3; cycle++) {
          await page.evaluate(() => { (window as any).holdMode = true; (window as any).phonePoll(); });
          await page.locator('[aria-labelledby="operations-control-title"]').getByText("Checking…", { exact: true }).waitFor();
          const samples = await page.evaluate(async () => {
            const frames = [];
            for (let i = 0; i < 20; i++) {
              await new Promise(requestAnimationFrame);
              const attention = document.querySelector('[aria-labelledby="home-attention"]')!;
              const panel = document.querySelector('[aria-labelledby="operations-control-title"]')!;
              frames.push({ warning: attention.textContent!.includes("Stopped — nothing new"),
                stopped: panel.textContent!.includes("Stopped"), checking: panel.textContent!.includes("Checking…"),
                buttons: [...panel.querySelectorAll("button")].map(b => b.textContent) });
            }
            return frames;
          });
          for (const sample of samples) {
            assert.equal(sample.warning, true); assert.equal(sample.stopped, true); assert.equal(sample.checking, true);
            assert.deepEqual(sample.buttons, ["Running", "Paused", "Draining", "Read again"]);
          }
          await page.evaluate(value => (window as any).releaseMode(Response.json(value)), stopped);
          await page.locator('[aria-labelledby="operations-control-title"]').getByText("Checking…", { exact: true }).waitFor({ state: "hidden" });
        }
        await page.evaluate(() => (window as any).phonePoll());
        await page.locator('[aria-labelledby="operations-control-title"]').getByText("Checking…", { exact: true }).waitFor();
        await page.evaluate(() => (window as any).releaseMode(new Response(null, { status: 503 })));
        await page.locator('[aria-labelledby="home-attention"]').getByText("Couldn’t refresh — showing the last known state.", { exact: true }).waitFor();
        await page.getByText("Stopped — nothing new", { exact: false }).waitFor();
        assert.deepEqual(await page.locator('[aria-labelledby="operations-control-title"] button').allTextContents(), ["Running", "Paused", "Draining", "Read again"]);
        await page.getByRole("button", { name: "Read again", exact: true }).click();
        await page.evaluate(value => (window as any).releaseMode(Response.json(value)), running);
        await page.getByText("Work proceeds as normal.", { exact: false }).waitFor();
        await page.getByText("Stopped — nothing new", { exact: false }).waitFor({ state: "hidden" });
        await page.getByRole("button", { name: "Confirm: use these words" }).click();
        assert.equal(await page.locator("#voice-local-draft").inputValue(), "phone draft to confirm");
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
