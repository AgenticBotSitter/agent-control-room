import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { VoiceControlsSurface } from "../private-app/app/voice-controls.tsx";
import { VoiceControlsWorkspace } from "../private-app/app/voice-controls-workspace";
import type {
  VoiceRecognitionAdapterV1,
  VoiceRecognitionErrorV1,
  VoiceSynthesisAdapterV1,
  VoiceTranscriptEventV1,
} from "../src/voice/v1/types";
import { canReadAloudV1, dedupeTranscriptEventsV1 } from "../src/voice/v1/policy";

type TestDom = { window: Window & typeof globalThis };

interface RecognitionCallbacks {
  onEvent: (event: VoiceTranscriptEventV1) => void;
  onError: (kind: VoiceRecognitionErrorV1, message: string) => void;
}

function makeRecognition(supported = true) {
  const state = { starts: 0, stops: 0, callbacks: null as RecognitionCallbacks | null, supported };
  const adapter: VoiceRecognitionAdapterV1 = {
    isSupported: () => state.supported,
    start: (callbacks) => { state.starts += 1; state.callbacks = callbacks; },
    stop: () => { state.stops += 1; },
  };
  return { state, adapter };
}

function makeSynthesis(supported = true) {
  const state = { speaks: [] as string[], cancels: 0, supported };
  const adapter: VoiceSynthesisAdapterV1 = {
    isSupported: () => state.supported,
    speak: (text: string) => { state.speaks.push(text); },
    cancel: () => { state.cancels += 1; },
  };
  return { state, adapter };
}

async function mount(ui: React.ReactElement) {
  const jsdomModule = await import("jsdom");
  const JSDOM = (jsdomModule as { JSDOM: unknown }).JSDOM as new (
    html: string, options?: { url?: string; pretendToBeVisual?: boolean },
  ) => TestDom;
  const dom = new JSDOM("<div id='root'></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(ui));
  return {
    dom,
    render: async (next: React.ReactElement) => { await act(async () => root.render(next)); },
    text: () => dom.window.document.body.textContent ?? "",
    cleanup: async () => {
      await act(async () => root.unmount());
      dom.window.close();
      for (const [key, descriptor] of Object.entries(saved)) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
    unmountOnly: async () => { await act(async () => root.unmount()); },
  };
}

function click(dom: TestDom, selector: string): HTMLButtonElement {
  const el = dom.window.document.querySelector(selector);
  assert.ok(el, `expected element ${selector}`);
  (el as HTMLButtonElement).click();
  return el as HTMLButtonElement;
}

test("voice module is disabled by default and touches no adapter", async () => {
  const rec = makeRecognition();
  const syn = makeSynthesis();
  const h = await mount(<VoiceControlsSurface settings={{ enabled: false }} recognition={rec.adapter} synthesis={syn.adapter} />);
  try {
    assert.match(h.text(), /optional and off/);
    assert.equal(h.dom.window.document.querySelector("button"), null);
    assert.equal(rec.state.starts, 0);
    assert.equal(syn.state.speaks.length, 0);
  } finally { await h.cleanup(); }
});

test("dictation needs Start plus Confirm; nothing is committed before Confirm", async () => {
  const rec = makeRecognition();
  const syn = makeSynthesis();
  const committed: string[] = [];
  const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter}
    synthesis={syn.adapter} onTranscriptCommitted={(t) => committed.push(t)} />);
  try {
    await act(async () => { click(h.dom, "button"); });
    assert.equal(rec.state.starts, 1);
    assert.match(h.text(), /Listening/);
    // Interim (non-final) event is ignored.
    await act(async () => { rec.state.callbacks!.onEvent({ eventId: "e1", transcript: "half", isFinal: false }); });
    assert.equal(committed.length, 0);
    assert.doesNotMatch(h.text(), /Heard:/);
    // Final event shows a visible preview but still commits nothing.
    await act(async () => { rec.state.callbacks!.onEvent({ eventId: "e2", transcript: "hello world", isFinal: true }); });
    assert.match(h.text(), /Heard:.*hello world/);
    assert.equal(committed.length, 0);
    // Explicit Confirm commits exactly the heard words.
    const buttons = [...h.dom.window.document.querySelectorAll("button")].map(b => b.textContent);
    assert.ok(buttons.some(b => /Confirm/.test(b ?? "")));
    await act(async () => { click(h.dom, "button"); }); // first button in confirming mode is Confirm
    assert.deepEqual(committed, ["hello world"]);
  } finally { await h.cleanup(); }
});

test("cancel discards heard words and duplicate events are suppressed", async () => {
  const rec = makeRecognition();
  const syn = makeSynthesis();
  const committed: string[] = [];
  const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter}
    synthesis={syn.adapter} onTranscriptCommitted={(t) => committed.push(t)} />);
  try {
    await act(async () => { click(h.dom, "button"); });
    await act(async () => {
      rec.state.callbacks!.onEvent({ eventId: "dup", transcript: "same words", isFinal: true });
      rec.state.callbacks!.onEvent({ eventId: "dup", transcript: "same words", isFinal: true });
    });
    assert.match(h.text(), /same words/);
    assert.doesNotMatch(h.text(), /same words.*same words/);
    const cancel = [...h.dom.window.document.querySelectorAll("button")].find(b => /Cancel/.test(b.textContent ?? ""));
    assert.ok(cancel);
    await act(async () => { cancel!.click(); });
    assert.equal(committed.length, 0);
    assert.match(h.text(), /cancelled/i);
  } finally { await h.cleanup(); }
});

test("denial, unsupported capability and cancellation produce honest states", async () => {
  // Denial.
  {
    const rec = makeRecognition();
    const syn = makeSynthesis();
    const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter} synthesis={syn.adapter} />);
    try {
      await act(async () => { click(h.dom, "button"); });
      await act(async () => { rec.state.callbacks!.onError("denied", "permission denied"); });
      assert.match(h.text(), /permission was denied/);
    } finally { await h.cleanup(); }
  }
  // Unsupported recognition: Start is disabled and no microphone attempt happens.
  {
    const rec = makeRecognition(false);
    const syn = makeSynthesis();
    const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter} synthesis={syn.adapter} />);
    try {
      const start = h.dom.window.document.querySelector("button");
      assert.ok(start);
      assert.equal((start as HTMLButtonElement).disabled, true);
      assert.equal(rec.state.starts, 0);
      assert.match(h.text(), /browser with speech recognition/);
    } finally { await h.cleanup(); }
  }
  // Cancellation.
  {
    const rec = makeRecognition();
    const syn = makeSynthesis();
    const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter} synthesis={syn.adapter} />);
    try {
      await act(async () => { click(h.dom, "button"); });
      await act(async () => { rec.state.callbacks!.onError("cancelled", "interrupted"); });
      assert.match(h.text(), /cancelled/);
    } finally { await h.cleanup(); }
  }
});

test("read-aloud stops immediately and never reads secrets or hidden content", async () => {
  assert.equal(canReadAloudV1({ text: "hello" }), true);
  assert.equal(canReadAloudV1({ text: "s3cr3t", isSecret: true }), false);
  assert.equal(canReadAloudV1({ text: "hidden", isHidden: true }), false);
  assert.equal(canReadAloudV1({ text: "   " }), false);
  assert.deepEqual(
    dedupeTranscriptEventsV1([
      { eventId: "a", transcript: "x", isFinal: true },
      { eventId: "a", transcript: "x", isFinal: true },
      { eventId: "b", transcript: "y", isFinal: true },
    ]).map(e => e.eventId),
    ["a", "b"],
  );

  // Audible path: Read then Stop.
  {
    const rec = makeRecognition();
    const syn = makeSynthesis();
    const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter}
      synthesis={syn.adapter} readContent={{ text: "Audible update" }} />);
    try {
      const read = [...h.dom.window.document.querySelectorAll("button")].find(b => /Read aloud/.test(b.textContent ?? ""));
      assert.ok(read);
      await act(async () => { read!.click(); });
      assert.deepEqual(syn.state.speaks, ["Audible update"]);
      assert.match(h.text(), /Reading aloud/);
      const stop = [...h.dom.window.document.querySelectorAll("button")].find(b => /Stop reading/.test(b.textContent ?? ""));
      assert.ok(stop);
      await act(async () => { stop!.click(); });
      assert.equal(syn.state.cancels, 1);
      assert.match(h.text(), /stopped/);
    } finally { await h.cleanup(); }
  }
  // Secret path: refused, synthesis untouched.
  {
    const rec = makeRecognition();
    const syn = makeSynthesis();
    const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter}
      synthesis={syn.adapter} readContent={{ text: "token abc", isSecret: true }} />);
    try {
      const read = [...h.dom.window.document.querySelectorAll("button")].find(b => /Read aloud/.test(b.textContent ?? ""));
      assert.ok(read);
      await act(async () => { read!.click(); });
      assert.equal(syn.state.speaks.length, 0);
      assert.match(h.text(), /never read/);
    } finally { await h.cleanup(); }
  }
});

test("unmount stops recognition and cancels synthesis; controls stay keyboard-native", async () => {
  const rec = makeRecognition();
  const syn = makeSynthesis();
  const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter}
    synthesis={syn.adapter} readContent={{ text: "something" }} />);
  try {
    await act(async () => { click(h.dom, "button"); });
    const kinds = new Set([...h.dom.window.document.querySelectorAll("button, input")].map(el => el.tagName.toLowerCase()));
    assert.ok(kinds.has("button"));
    assert.ok(h.dom.window.document.querySelector('input[type="checkbox"]'));
    const stopsBefore = rec.state.stops;
    const cancelsBefore = syn.state.cancels;
    await h.unmountOnly();
    assert.ok(rec.state.stops >= stopsBefore + 1);
    assert.ok(syn.state.cancels >= cancelsBefore + 1);
  } finally {
    h.dom.window.close();
    for (const key of ["window", "document", "IS_REACT_ACT_ENVIRONMENT"]) delete (globalThis as Record<string, unknown>)[key];
  }
});

/* ---------------------------------------------------------------------------
 * Real browser voice adapters (private-app/app/voice-browser-adapters.ts).
 * These tests exercise the production adapters against browser-global fakes:
 * unsupported detection, final transcript mapping, every safe error mapping,
 * and idempotent stop/cancel before start/speak.
 * ------------------------------------------------------------------------- */

interface FakeRecognitionInstance {
  started: boolean;
  startError: Error | null;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type BrowserGlobals = Partial<{
  SpeechRecognition: unknown;
  webkitSpeechRecognition: unknown;
  SpeechSynthesisUtterance: unknown;
  speechSynthesis: unknown;
}>;

function withBrowserGlobals(globals: BrowserGlobals): () => void {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(globals) as (keyof BrowserGlobals & string)[]) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    if (globals[key] === undefined) delete (globalThis as Record<string, unknown>)[key];
    else Object.defineProperty(globalThis, key, { value: globals[key], configurable: true, writable: true });
  }
  return () => {
    for (const key of Object.keys(globals)) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
}

function makeFakeRecognitionCtor(options?: { startThrows?: boolean }) {
  const instances: FakeRecognitionInstance[] = [];
  class FakeSpeechRecognition {
    started = false;
    startError: Error | null = null;
    onresult: ((event: unknown) => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      instances.push(this);
    }
    start(): void {
      if (options?.startThrows) throw new Error("start refused");
      this.started = true;
    }
    stop(): void {}
    abort(): void {}
  }
  return { instances, ctor: FakeSpeechRecognition as unknown };
}

test("R6PH-03 Stop retains heard words until explicit Confirm or Cancel in the actual workspace", { timeout: 5000 }, async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor });
  const h = await mount(React.createElement(VoiceControlsWorkspace));
  const button = (name: string) => [...h.dom.window.document.querySelectorAll("button")].find(b => b.textContent === name)!;
  const draft = () => (h.dom.window.document.getElementById("voice-local-draft") as HTMLTextAreaElement).value;
  const click = async (name: string) => act(async () => button(name).click());
  const say = async (text: string) => act(async () => fake.instances.at(-1)!.onresult?.({ results: [[{ transcript: text }]] }));
  try {
    await act(async () => h.dom.window.document.getElementById("voice-controls-enabled")!.click());
    await click("Start dictation");
    await say("remember the phone draft");
    await click("Stop listening");
    assert.match(h.text(), /Heard: remember the phone draft/);
    assert.ok(button("Confirm: use these words"));
    assert.equal(draft(), "", "Stop never commits words");
    assert.equal(fake.instances.at(-1)!.onresult, null, "the production adapter detached the stopped engine");
    await click("Confirm: use these words");
    assert.equal(draft(), "remember the phone draft");
    await click("Start dictation");
    await say("discard these words");
    await click("Stop listening");
    await click("Cancel: discard");
    assert.doesNotMatch(h.text(), /discard these words/);
    assert.equal(draft(), "remember the phone draft");
    await click("Start dictation");
    await click("Stop listening");
    assert.match(h.text(), /Nothing is listening/);
    assert.equal(Boolean(button("Confirm: use these words")), false, "empty Stop has nothing to confirm");
    for (const error of ["not-allowed", "network"]) {
      await click("Start dictation");
      await act(async () => fake.instances.at(-1)!.onerror?.({ error }));
      assert.match(h.text(), error === "network" ? /hit an error and stopped/ : /Microphone permission was denied/);
      assert.equal(draft(), "remember the phone draft");
    }
    await click("Start dictation");
    await say("retry draft");
    await click("Stop listening");
    await click("Confirm: use these words");
    assert.equal(draft(), "remember the phone draft\nretry draft");
  } finally { await h.cleanup(); restore(); }
});

test("recognition adapter reports unsupported without throwing when the API is missing", async () => {
  const restore = withBrowserGlobals({}); // no SpeechRecognition globals at all
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { recognition } = voiceBrowserAdaptersV1();
    assert.equal(recognition.isSupported(), false);
    const errors: Array<{ kind: VoiceRecognitionErrorV1; message: string }> = [];
    recognition.start({ onEvent: () => {}, onError: (kind, message) => errors.push({ kind, message }) });
    recognition.stop(); // idempotent no-op even though start never engaged an engine
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "unsupported");
  } finally {
    restore();
  }
});

test("recognition adapter maps final results into transcript records with stable ids", async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ webkitSpeechRecognition: fake.ctor });
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { recognition } = voiceBrowserAdaptersV1();
    assert.equal(recognition.isSupported(), true);
    const events: VoiceTranscriptEventV1[] = [];
    const errors: Array<{ kind: VoiceRecognitionErrorV1 }> = [];
    recognition.start({
      onEvent: (event) => events.push(event),
      onError: (kind) => errors.push({ kind }),
    });
    const engine = fake.instances[0];
    assert.ok(engine, "adapter must construct the browser recognition engine");
    assert.equal(engine.started, true);
    await act(async () => {
      engine.onresult?.({
        results: [
          [{ transcript: "deploy the staging build" }],
          [{ transcript: "and tag it rc1" }],
        ],
      });
    });
    assert.equal(events.length, 2);
    assert.ok(events.every((event) => event.isFinal));
    assert.deepEqual(events.map((event) => event.transcript), [
      "deploy the staging build",
      "and tag it rc1",
    ]);
    // Ids are stable within a session and unique per result index: repeated
    // delivery of the same result must reproduce identical eventIds so the
    // surface's eventId suppression can drop duplicates.
    const instancePrefix = /^recognition-(\d+)-/.exec(events[0]?.eventId ?? "")?.[0];
    assert.ok(instancePrefix, `eventId format: ${events[0]?.eventId}`);
    assert.ok(events.every((event) => event.eventId.startsWith(instancePrefix!)));
    assert.notEqual(events[0]?.eventId, events[1]?.eventId);
    const firstIds = events.map((event) => event.eventId);
    await act(async () => {
      engine.onresult?.({
        results: [
          [{ transcript: "deploy the staging build" }],
          [{ transcript: "and tag it rc1" }],
        ],
      });
    });
    assert.deepEqual(events.slice(2).map((event) => event.eventId), firstIds);
  } finally {
    restore();
  }
});

test("recognition adapter maps browser error codes to the safe error kinds", async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor });
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { recognition } = voiceBrowserAdaptersV1();
    const seen: Array<{ kind: VoiceRecognitionErrorV1; message: string }> = [];
    recognition.start({
      onEvent: () => {},
      onError: (kind, message) => seen.push({ kind, message }),
    });
    const engine = fake.instances[0];
    for (const raw of ["not-allowed", "service-not-allowed"]) {
      await act(async () => { engine.onerror?.({ error: raw }); });
    }
    for (const raw of ["not-supported", "audio-capture"]) {
      await act(async () => { engine.onerror?.({ error: raw }); });
    }
    for (const raw of ["aborted", "no-speech"]) {
      await act(async () => { engine.onerror?.({ error: raw }); });
    }
    await act(async () => { engine.onerror?.({ error: "network" }); });
    assert.deepEqual(seen.map((entry) => entry.kind), [
      "denied", "denied", "unsupported", "unsupported", "cancelled", "cancelled", "error",
    ]);
    assert.ok(seen.every((entry) => entry.message.length > 0));
    // A final end after a reported error adds no duplicate cancellation.
    await act(async () => { engine.onend?.(); });
    assert.equal(seen.length, 7);
    // Malformed result payloads never throw and never fabricate events.
    await act(async () => {
      engine.onresult?.({});
      engine.onresult?.({ results: [[{}], [{ transcript: "" }]] });
    });
    assert.ok(!seen.some((entry) => entry.kind === undefined));
  } finally {
    restore();
  }
});

test("recognition stop reaches the active engine exactly once and allows restart", async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor });
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { recognition } = voiceBrowserAdaptersV1();
    const errors: VoiceRecognitionErrorV1[] = [];
    const callbacks = { onEvent: () => {}, onError: (kind: VoiceRecognitionErrorV1) => errors.push(kind) };
    recognition.stop();
    recognition.stop();
    assert.equal(fake.instances.length, 0);
    recognition.start(callbacks);
    recognition.start(callbacks);
    assert.equal(fake.instances.length, 1, "duplicate start while active is ignored");
    const first = fake.instances[0] as FakeRecognitionInstance & { stop: () => void };
    let stops = 0;
    first.stop = () => { stops += 1; };
    const oldEnd = first.onend;
    recognition.stop();
    recognition.stop();
    assert.equal(stops, 1);
    recognition.start(callbacks);
    assert.equal(fake.instances.length, 2);
    assert.equal(fake.instances[1].started, true);
    oldEnd?.(); // A late event from the stopped run must not clear the new run.
    assert.deepEqual(errors, []);
    const second = fake.instances[1] as FakeRecognitionInstance & { stop: () => void };
    second.stop = () => { stops += 1; };
    recognition.stop();
    assert.equal(stops, 2);
  } finally { restore(); }
});

test("recognition restarts after natural end and after an errored end", async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor });
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { recognition } = voiceBrowserAdaptersV1();
    const errors: VoiceRecognitionErrorV1[] = [];
    const callbacks = { onEvent: () => {}, onError: (kind: VoiceRecognitionErrorV1) => errors.push(kind) };
    recognition.start(callbacks);
    fake.instances[0].onend?.();
    recognition.start(callbacks);
    assert.equal(fake.instances.length, 2);
    assert.equal(fake.instances[1].started, true);
    fake.instances[1].onerror?.({ error: "not-allowed" });
    fake.instances[1].onend?.();
    recognition.start(callbacks);
    assert.equal(fake.instances.length, 3);
    assert.deepEqual(errors, ["cancelled", "denied"]);
    recognition.stop();
  } finally { restore(); }
});

test("recognition adapter start failure path stays honest, and stop is always safe", async () => {
  const fake = makeFakeRecognitionCtor({ startThrows: true });
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor });
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { recognition } = voiceBrowserAdaptersV1();
    recognition.stop(); // safe before any start
    const errors: Array<{ kind: VoiceRecognitionErrorV1 }> = [];
    recognition.start({ onEvent: () => {}, onError: (kind) => errors.push({ kind }) });
    assert.equal(fake.instances.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(errors[0]?.kind, "error");
    const retry = makeFakeRecognitionCtor();
    const restoreRetry = withBrowserGlobals({ SpeechRecognition: retry.ctor });
    try {
      recognition.start({ onEvent: () => {}, onError: (kind) => errors.push({ kind }) });
      assert.equal(retry.instances.length, 1, "failed start must release the active run");
      assert.equal(retry.instances[0].started, true);
      recognition.stop();
    } finally { restoreRetry(); }
    recognition.stop(); // still safe after a failed start/retry
  } finally {
    restore();
  }
});

test("synthesis adapter refuses to speak when unsupported and stays silent on empty text", async () => {
  const restore = withBrowserGlobals({});
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { synthesis } = voiceBrowserAdaptersV1();
    assert.equal(synthesis.isSupported(), false);
    synthesis.speak("hello"); // no speechSynthesis global — must be a no-op
    synthesis.cancel(); // idempotent cancel before anything was spoken
    const after = { spoke: (globalThis as { speechSynthesis?: unknown }).speechSynthesis };
    assert.equal(after.spoke, undefined);
  } finally {
    restore();
  }
});

test("synthesis adapter speaks only on explicit caller use and cancels idempotently", async () => {
  const spoken: string[] = [];
  const restore = withBrowserGlobals({
    speechSynthesis: {
      speak: (utterance: unknown) => spoken.push(String((utterance as { text?: string }).text ?? "")),
      cancel: () => { spoken.push("<cancel>"); },
    },
    SpeechSynthesisUtterance: class {
      text: string;
      constructor(text: string) { this.text = text; }
    },
  });
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { synthesis } = voiceBrowserAdaptersV1();
    assert.equal(synthesis.isSupported(), true);
    synthesis.cancel(); // idempotent cancel before any speak
    assert.deepEqual(spoken, ["<cancel>"]);
    synthesis.speak("read this aloud");
    assert.deepEqual(spoken, ["<cancel>", "read this aloud"]);
    synthesis.speak("   "); // blank text is refused rather than spoken
    assert.deepEqual(spoken, ["<cancel>", "read this aloud"]);
    synthesis.cancel(); // idempotent by contract; safe to call repeatedly
    assert.deepEqual(spoken, ["<cancel>", "read this aloud", "<cancel>"]);
  } finally {
    restore();
  }
});

test("unsupported detection is read lazily at call time, not at adapter creation", async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ webkitSpeechRecognition: fake.ctor });
  try {
    const { voiceBrowserAdaptersV1 } = await import("../private-app/app/voice-browser-adapters.ts");
    const { recognition, synthesis } = voiceBrowserAdaptersV1();
    assert.equal(recognition.isSupported(), true);
    assert.equal(synthesis.isSupported(), false);
    restore(); // globals removed between adapter creation and use
    assert.equal(recognition.isSupported(), false);
    assert.equal(synthesis.isSupported(), false);
    const errors: Array<{ kind: VoiceRecognitionErrorV1 }> = [];
    recognition.start({ onEvent: () => {}, onError: (kind) => errors.push({ kind }) });
    assert.equal(errors[0]?.kind, "unsupported");
    recognition.stop();
    synthesis.cancel();
  } finally {
    restore();
  }
});

function voiceButton(h: Awaited<ReturnType<typeof mount>>, name: string) {
  const button = [...h.dom.window.document.querySelectorAll('button')].find(b => b.textContent === name);
  assert.ok(button, `missing ${name}`);
  return button;
}

test('R5A-01 disabling voice stops both engines and fences old callbacks in 50 sessions', async () => {
  const rec = makeRecognition(), syn = makeSynthesis();
  const committed: string[] = [];
  const surface = (enabled: boolean) => <VoiceControlsSurface settings={{ enabled }} recognition={rec.adapter}
    synthesis={syn.adapter} readContent={{ text: 'Safe update' }} onTranscriptCommitted={t => committed.push(t)} />;
  const h = await mount(surface(true));
  try {
    for (let i = 0; i < 50; i++) {
      await act(async () => voiceButton(h, 'Start dictation').click());
      const old = rec.state.callbacks!;
      if (i % 2) await act(async () => old.onEvent({ eventId: 'final', transcript: 'pending words', isFinal: true }));
      await act(async () => voiceButton(h, 'Read aloud').click());
      const stops = rec.state.stops, cancels = syn.state.cancels;
      await h.render(surface(false));
      assert.equal(rec.state.stops, stops + 1);
      assert.equal(syn.state.cancels, cancels + 1);
      assert.equal(h.dom.window.document.querySelector('button'), null);
      await act(async () => {
        old.onEvent({ eventId: 'late', transcript: 'late words', isFinal: true });
        old.onError('denied', 'old error');
      });
      await h.render(surface(true));
      assert.doesNotMatch(h.text(), /Heard:|pending words|late words|permission was denied/);
      assert.equal(voiceButton(h, 'Read aloud').disabled, false);
      await act(async () => voiceButton(h, 'Start dictation').click());
      await act(async () => old.onEvent({ eventId: 'new-late', transcript: 'old session', isFinal: true }));
      assert.doesNotMatch(h.text(), /old session/);
      await act(async () => voiceButton(h, 'Cancel: discard').click());
    }
    assert.deepEqual(committed, []);
  } finally { await h.cleanup(); }
});

test('R5A-01 workspace disabling stops browser engines while listening or confirming', async () => {
  const fake = makeFakeRecognitionCtor(); let stops = 0, cancels = 0;
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor,
    SpeechSynthesisUtterance: class { constructor(public text: string) {} },
    speechSynthesis: { speak: () => {}, cancel: () => { cancels++; } } });
  const h = await mount(<VoiceControlsWorkspace />);
  try {
    for (const confirming of [false, true]) {
      await act(async () => click(h.dom, '#voice-controls-enabled'));
      await act(async () => voiceButton(h, 'Start dictation').click());
      const engine = fake.instances.at(-1)! as FakeRecognitionInstance & { stop: () => void };
      engine.stop = () => { stops++; };
      const oldResult = engine.onresult, oldError = engine.onerror;
      if (confirming) await act(async () => engine.onresult?.({ results: [[{ transcript: 'pending' }]] }));
      await act(async () => voiceButton(h, 'Read aloud').click());
      const before = cancels;
      await act(async () => click(h.dom, '#voice-controls-enabled'));
      assert.equal(stops, confirming ? 2 : 1);
      assert.equal(cancels, before + 1);
      await act(async () => { oldResult?.({ results: [[{ transcript: 'late' }]] }); oldError?.({ error: 'not-allowed' }); });
      await act(async () => click(h.dom, '#voice-controls-enabled'));
      assert.doesNotMatch(h.text(), /Heard:|permission was denied/);
      assert.equal((h.dom.window.document.querySelector('#voice-local-draft') as HTMLTextAreaElement).value, '');
      await act(async () => click(h.dom, '#voice-controls-enabled'));
    }
  } finally { await h.cleanup(); restore(); }
});

test('R5A-02 result then natural end retains confirmation in 50 composed sessions; empty and error ends recover', async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor });
  const h = await mount(<VoiceControlsWorkspace />);
  try {
    await act(async () => click(h.dom, '#voice-controls-enabled'));
    for (let i = 0; i < 50; i++) {
      await act(async () => voiceButton(h, 'Start dictation').click());
      const engine = fake.instances.at(-1)!;
      await act(async () => engine.onresult?.({ results: [[{ transcript: `words ${i}` }]] }));
      await act(async () => engine.onend?.());
      assert.match(h.text(), new RegExp(`Heard: words ${i}`));
      assert.equal((h.dom.window.document.querySelector('#voice-local-draft') as HTMLTextAreaElement).value, '');
      await act(async () => voiceButton(h, 'Confirm: use these words').click());
      assert.equal((h.dom.window.document.querySelector('#voice-local-draft') as HTMLTextAreaElement).value, `words ${i}`);
      await act(async () => voiceButton(h, 'Clear local draft').click());
    }
    await act(async () => voiceButton(h, 'Start dictation').click());
    await act(async () => fake.instances.at(-1)!.onresult?.({ results: [[{}], [{ transcript: '' }]] }));
    await act(async () => fake.instances.at(-1)!.onend?.());
    assert.match(h.text(), /cancelled/i);
    await act(async () => voiceButton(h, 'Start dictation').click());
    await act(async () => fake.instances.at(-1)!.onerror?.({ error: 'not-allowed' }));
    assert.match(h.text(), /permission was denied/);
    await act(async () => voiceButton(h, 'Start dictation').click());
    await act(async () => voiceButton(h, 'Cancel: discard').click());
    assert.equal((h.dom.window.document.querySelector('#voice-local-draft') as HTMLTextAreaElement).value, '');
  } finally { await h.cleanup(); restore(); }
});

test('R5A-03 dictation moves owned focus to replacements without stealing focus elsewhere', async () => {
  const rec = makeRecognition(), syn = makeSynthesis();
  const h = await mount(<><input id='elsewhere' /><VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter} synthesis={syn.adapter} /></>);
  try {
    const doc = h.dom.window.document;
    voiceButton(h, 'Start dictation').focus();
    await act(async () => voiceButton(h, 'Start dictation').click());
    assert.ok(doc.activeElement === voiceButton(h, 'Stop listening'), 'focus reaches Stop listening');
    await act(async () => rec.state.callbacks!.onEvent({ eventId: 'final', transcript: 'words', isFinal: true }));
    voiceButton(h, 'Confirm: use these words').focus();
    await act(async () => voiceButton(h, 'Confirm: use these words').click());
    assert.ok(doc.activeElement === voiceButton(h, 'Start dictation'), 'focus reaches Start dictation');
    doc.getElementById('elsewhere')!.focus();
    await act(async () => voiceButton(h, 'Start dictation').click());
    assert.ok(doc.activeElement === doc.getElementById('elsewhere'), 'focus stays elsewhere');
    await act(async () => voiceButton(h, 'Cancel: discard').click());
    assert.ok(doc.activeElement === doc.getElementById('elsewhere'), 'focus stays elsewhere');
  } finally { await h.cleanup(); }
});

test('R5A-01 adapter rejects captured result and error callbacks after stop and restart', async () => {
  const fake = makeFakeRecognitionCtor();
  const restore = withBrowserGlobals({ SpeechRecognition: fake.ctor });
  try {
    const { recognition } = (await import('../private-app/app/voice-browser-adapters')).voiceBrowserAdaptersV1();
    const events: VoiceTranscriptEventV1[] = [], errors: VoiceRecognitionErrorV1[] = [];
    const callbacks = { onEvent: (e: VoiceTranscriptEventV1) => events.push(e), onError: (e: VoiceRecognitionErrorV1) => errors.push(e) };
    recognition.start(callbacks);
    const oldResult = fake.instances[0]!.onresult, oldError = fake.instances[0]!.onerror;
    recognition.stop(); recognition.start(callbacks);
    for (let i = 0; i < 50; i++) {
      oldResult?.({ results: [[{ transcript: 'late' }]] }); oldError?.({ error: 'network' });
    }
    assert.equal(events.length, 0); assert.equal(errors.length, 0);
    fake.instances[1]!.onresult?.({ results: [[{ transcript: 'current' }]] });
    assert.equal(events[0]!.transcript, 'current');
    recognition.stop();
  } finally { restore(); }
});

test('R5A-01 stopped, cancelled, confirmed and unmounted sessions reject late speech', async () => {
  for (const action of ['Stop listening', 'Cancel: discard', 'Confirm: use these words', 'unmount']) {
    const rec = makeRecognition(), syn = makeSynthesis(); const committed: string[] = [];
    const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter}
      synthesis={syn.adapter} onTranscriptCommitted={t => committed.push(t)} />);
    try {
      await act(async () => voiceButton(h, 'Start dictation').click());
      const old = rec.state.callbacks!;
      if (action === 'Confirm: use these words') await act(async () => old.onEvent({ eventId: 'final', transcript: 'confirmed', isFinal: true }));
      if (action === 'unmount') await h.unmountOnly();
      else await act(async () => voiceButton(h, action).click());
      const stops = rec.state.stops;
      await act(async () => { old.onEvent({ eventId: 'late', transcript: 'late speech', isFinal: true }); old.onError('denied', 'late error'); });
      assert.equal(rec.state.stops, stops, 'late errors cannot touch the stopped adapter');
      assert.doesNotMatch(h.text(), /late speech|permission was denied/);
      assert.deepEqual(committed, action === 'Confirm: use these words' ? ['confirmed'] : []);
    } finally { await h.cleanup(); }
  }
});

test('R5A-02 Stop listening keeps final words available for explicit confirmation', async () => {
  const rec = makeRecognition(), syn = makeSynthesis(); const committed: string[] = [];
  const h = await mount(<VoiceControlsSurface settings={{ enabled: true }} recognition={rec.adapter}
    synthesis={syn.adapter} onTranscriptCommitted={t => committed.push(t)} />);
  try {
    await act(async () => voiceButton(h, 'Start dictation').click());
    await act(async () => rec.state.callbacks!.onEvent({ eventId: 'final', transcript: 'review these words', isFinal: true }));
    await act(async () => voiceButton(h, 'Stop listening').click());
    assert.match(h.text(), /Heard: review these words/);
    assert.equal(committed.length, 0);
    await act(async () => voiceButton(h, 'Confirm: use these words').click());
    assert.deepEqual(committed, ['review these words']);
  } finally { await h.cleanup(); }
});
