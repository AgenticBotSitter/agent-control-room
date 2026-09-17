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
  // @ts-expect-error untyped module
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
