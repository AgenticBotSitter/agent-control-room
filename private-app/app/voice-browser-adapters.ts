/** Browser speech-recognition and speech-synthesis adapters (voice/v1). */

import type {
  VoiceRecognitionAdapterV1,
  VoiceRecognitionErrorV1,
  VoiceSynthesisAdapterV1,
  VoiceTranscriptEventV1,
} from "../../src/voice/v1/types";

/**
 * Real browser adapters for the injected `VoiceRecognitionAdapterV1` /
 * `VoiceSynthesisAdapterV1` boundaries in `src/voice/v1/types.ts`. They wrap the
 * Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`,
 * `window.speechSynthesis`) only; the module itself never touches microphone
 * permissions, the network or any credential.
 *
 * Feature detection is always lazy and read inside a function call, never at
 * module top level: an unsupported browser never throws at import time, and a
 * test that removes the browser globals between adapter creation and use still
 * gets the honest `unsupported` answer. The adapters are also not mounted in
 * any page yet — see `docs/integration/optional-voice.md`.
 */

/** Minimal structural shape of the constructor the browser provides. */
type SpeechRecognitionCtor = new () => {
  lang?: string;
  continuous?: boolean;
  interimResults?: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: unknown) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
};

/** Read the browser's recognition constructor at call time, or null. */
function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const scope = globalThis as {
    SpeechRecognition?: unknown;
    webkitSpeechRecognition?: unknown;
  };
  if (typeof scope.SpeechRecognition === "function") {
    return scope.SpeechRecognition as SpeechRecognitionCtor;
  }
  if (typeof scope.webkitSpeechRecognition === "function") {
    return scope.webkitSpeechRecognition as SpeechRecognitionCtor;
  }
  return null;
}

/** Read the browser's synthesis API at call time, or null. */
function speechSynthesisApi(): {
  speak: (utterance: unknown) => void;
  cancel: () => void;
} | null {
  const candidate = (globalThis as { speechSynthesis?: unknown }).speechSynthesis;
  if (
    candidate !== null &&
    typeof candidate === "object" &&
    typeof (candidate as { speak?: unknown }).speak === "function" &&
    typeof (candidate as { cancel?: unknown }).cancel === "function"
  ) {
    return candidate as { speak: (utterance: unknown) => void; cancel: () => void };
  }
  return null;
}

/**
 * Map a raw SpeechRecognition error code onto the contract's safe error kinds.
 * Unknown codes fall through to the generic `error` kind with the raw code in
 * the message — the module renders honest text states either way.
 */
function mapRecognitionError(raw: string | undefined): {
  kind: VoiceRecognitionErrorV1;
  message: string;
} {
  switch (raw) {
    case "not-allowed":
    case "service-not-allowed":
      return { kind: "denied", message: "Microphone permission was denied." };
    case "not-supported":
    case "audio-capture":
      return { kind: "unsupported", message: `Speech recognition failed: ${raw ?? "unknown error"}.` };
    case "aborted":
    case "no-speech":
      return { kind: "cancelled", message: `Recognition ended: ${raw ?? "unknown reason"}.` };
    default:
      return { kind: "error", message: `Recognition error: ${raw ?? "unknown error"}.` };
  }
}

let recognitionInstanceCounter = 0;

class RecognitionSession {
  private readonly instanceId: number;
  private started = false;
  private activeEngine: InstanceType<SpeechRecognitionCtor> | null = null;

  constructor() {
    this.instanceId = recognitionInstanceCounter;
    recognitionInstanceCounter += 1;
  }

  readonly adapter: VoiceRecognitionAdapterV1 = {
    isSupported: () => speechRecognitionCtor() !== null,
    start: (callbacks: {
      onEvent: (event: VoiceTranscriptEventV1) => void;
      onError: (kind: VoiceRecognitionErrorV1, message: string) => void;
    }): void => {
      if (this.started) return;
      const Ctor = speechRecognitionCtor();
      if (Ctor === null) {
        callbacks.onError(
          "unsupported",
          "Speech recognition is not available in this browser.",
        );
        return;
      }
      let engine: InstanceType<SpeechRecognitionCtor>;
      try {
        engine = new Ctor();
      } catch {
        callbacks.onError("error", "Speech recognition could not be started.");
        return;
      }
      let reportedError = false;
      engine.onresult = (event: unknown) => {
        const results = (event as { results?: ArrayLike<ArrayLike<{ transcript?: string }>> }).results;
        if (!results) return;
        for (let index = 0; index < results.length; index += 1) {
          const alternative = results[index]?.[0];
          const transcript = alternative?.transcript;
          if (typeof transcript !== "string" || transcript.length === 0) continue;
          callbacks.onEvent({
            eventId: `recognition-${this.instanceId}-${index}`,
            transcript,
            isFinal: true,
          });
        }
      };
      engine.onerror = (event: { error?: string }) => {
        reportedError = true;
        const mapped = mapRecognitionError(event?.error);
        callbacks.onError(mapped.kind, mapped.message);
      };
      engine.onend = () => {
        if (this.activeEngine !== engine) return;
        this.activeEngine = null;
        this.started = false;
        engine.onresult = null;
        engine.onerror = null;
        engine.onend = null;
        if (reportedError) return;
        callbacks.onError("cancelled", "Recognition ended without a final result.");
      };
      this.activeEngine = engine;
      this.started = true;
      try {
        engine.start();
      } catch {
        if (this.activeEngine !== engine) return;
        this.activeEngine = null;
        this.started = false;
        engine.onresult = null;
        engine.onerror = null;
        engine.onend = null;
        callbacks.onError("error", "Speech recognition could not be started.");
      }
    },
    stop: (): void => {
      const engine = this.activeEngine;
      this.activeEngine = null;
      this.started = false;
      if (!engine) return;
      // Detach before stopping: browser stop may synchronously dispatch end.
      engine.onresult = null;
      engine.onerror = null;
      engine.onend = null;
      try { engine.stop(); } catch { /* Already stopped by the browser. */ }
    },
  };
}

class SynthesisEngine {
  readonly adapter: VoiceSynthesisAdapterV1 = {
    isSupported: () => speechSynthesisApi() !== null,
    speak: (text: string): void => {
      const api = speechSynthesisApi();
      if (api === null || text.trim().length === 0) return;
      const utteranceCtor = (globalThis as { SpeechSynthesisUtterance?: new (text: string) => unknown })
        .SpeechSynthesisUtterance;
      if (typeof utteranceCtor !== "function") return;
      // Created only here, on explicit caller use — never at adapter creation.
      api.speak(new utteranceCtor(text));
    },
    cancel: (): void => {
      // Idempotent by contract: cancelling with nothing speaking is a no-op.
      speechSynthesisApi()?.cancel();
    },
  };
}

/**
 * Real browser voice adapters. Tests inject fakes instead; production code
 * receives these only when the host environment provides the Web Speech API
 * (or honestly reports `unsupported` when it does not).
 */
export function voiceBrowserAdaptersV1(): {
  recognition: VoiceRecognitionAdapterV1;
  synthesis: VoiceSynthesisAdapterV1;
} {
  const recognitionSession = new RecognitionSession();
  const synthesis = new SynthesisEngine();
  return { recognition: recognitionSession.adapter, synthesis: synthesis.adapter };
}
