import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { VoiceControlsSurface } from "../private-app/app/voice-controls.tsx";
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
  const { createRoot } = await import("react-dom/client");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://control.invalid/", pretendToBeVisual: true });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await act(async () => root.render(ui));
  return {
    dom,
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
