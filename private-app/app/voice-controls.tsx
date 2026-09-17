import { useEffect, useRef, useState } from "react";
import type {
  ReadAloudContentV1,
  VoiceInputStateV1,
  VoiceReadStateV1,
  VoiceRecognitionAdapterV1,
  VoiceRecognitionErrorV1,
  VoiceSettingsV1,
  VoiceSynthesisAdapterV1,
  VoiceTranscriptEventV1,
} from "../../src/voice/v1/types";
import { canReadAloudV1, cleanupVoiceV1, dedupeTranscriptEventsV1 } from "../../src/voice/v1/policy";
import { voiceInputStateTextV1, voiceReadStateTextV1 } from "../../src/voice/v1/presentation";

/**
 * Optional, removable voice-input and read-aloud controls.
 *
 * - Disabled by default: `settings.enabled === false` renders only the enable
 *   checkbox and an explanatory note. No adapter is touched while disabled.
 * - Voice never populates a text field on its own: dictation requires an
 *   explicit Start press, and the heard words require a second explicit
 *   Confirm press before `onTranscriptCommitted` fires. Cancel discards.
 * - Read-aloud requires an explicit Read press, stops immediately on Stop,
 *   and refuses secrets and hidden content without speaking.
 * - Every control is a native labelled button/checkbox: keyboard and
 *   text-only workflows are unchanged. The status paragraphs are `aria-live`
 *   text alternatives, not colour- or icon-only signals.
 * - The surface grants no authority: it cannot approve, save, send or start
 *   anything. It only reports heard words for the caller to commit.
 */
export function VoiceControlsSurface({ settings, recognition, synthesis, readContent, onTranscriptCommitted, onSettingsChange }: {
  settings: VoiceSettingsV1;
  recognition: VoiceRecognitionAdapterV1;
  synthesis: VoiceSynthesisAdapterV1;
  readContent?: ReadAloudContentV1;
  onTranscriptCommitted?: (transcript: string) => void;
  onSettingsChange?: (next: VoiceSettingsV1) => void;
}) {
  const [inputState, setInputState] = useState<VoiceInputStateV1>("idle");
  const [readState, setReadState] = useState<VoiceReadStateV1>("idle");
  const [heard, setHeard] = useState("");
  const seenIds = useRef<Set<string>>(new Set());
  const recognitionRef = useRef(recognition);
  const synthesisRef = useRef(synthesis);
  recognitionRef.current = recognition;
  synthesisRef.current = synthesis;

  useEffect(() => {
    return () => cleanupVoiceV1({
      stopRecognition: () => { try { recognitionRef.current.stop(); } catch { /* already stopped */ } },
      cancelSynthesis: () => { try { synthesisRef.current.cancel(); } catch { /* already idle */ } },
    });
  }, []);

  if (!settings.enabled) {
    return <section className="private-panel" aria-labelledby="voice-controls-heading">
      <h2 id="voice-controls-heading">Voice controls</h2>
      <p className="private-note">Voice input and read-aloud are optional and off.
        Everything on this page works fully with keyboard and typed text.</p>
      <label htmlFor="voice-controls-enabled">
        <input id="voice-controls-enabled" type="checkbox" checked={false}
          onChange={event => onSettingsChange?.({ enabled: event.target.checked })} />
        Enable voice controls (optional)
      </label>
      <p data-field="voice-input-status" aria-live="polite">{voiceInputStateTextV1("idle")}</p>
    </section>;
  }

  const recognitionSupported = recognition.isSupported();
  const synthesisSupported = synthesis.isSupported();

  const handleRecognitionError = (kind: VoiceRecognitionErrorV1) => {
    try { recognition.stop(); } catch { /* best effort */ }
    setInputState(kind === "denied" ? "denied" : kind === "unsupported" ? "unsupported" : kind === "cancelled" ? "cancelled" : "error");
  };

  const startDictation = () => {
    if (!recognitionSupported) { setInputState("unsupported"); return; }
    seenIds.current = new Set();
    setHeard("");
    setInputState("listening");
    recognition.start({
      onEvent: (event: VoiceTranscriptEventV1) => {
        if (seenIds.current.has(event.eventId)) return;
        seenIds.current.add(event.eventId);
        if (!event.isFinal) return;
        const merged = dedupeTranscriptEventsV1([{ ...event }]);
        setHeard(prev => (prev + " " + (merged[0]?.transcript ?? "")).trim());
        setInputState("confirming");
      },
      onError: (kind) => handleRecognitionError(kind),
    });
  };

  const cancelDictation = () => {
    try { recognition.stop(); } catch { /* best effort */ }
    setHeard("");
    setInputState("cancelled");
  };

  const confirmTranscript = () => {
    const text = heard.trim();
    try { recognition.stop(); } catch { /* best effort */ }
    if (text.length === 0) { setInputState("idle"); return; }
    onTranscriptCommitted?.(text);
    setHeard("");
    setInputState("idle");
  };

  const startReading = () => {
    if (!synthesisSupported) { setReadState("unsupported"); return; }
    const content = readContent ?? { text: "" };
    if (!canReadAloudV1(content)) { setReadState("refused"); return; }
    try {
      synthesis.speak(content.text);
      setReadState("speaking");
    } catch {
      setReadState("denied");
    }
  };

  const stopReading = () => {
    try { synthesis.cancel(); } catch { /* best effort */ }
    setReadState("stopped");
  };

  return <section className="private-panel" aria-labelledby="voice-controls-heading">
    <h2 id="voice-controls-heading">Voice controls</h2>
    <p className="private-note">Optional. Dictation never types on its own — you press Start,
      then review and Confirm. Read-aloud never reads secrets or hidden content.</p>
    <p data-field="keyboard-alternatives" className="private-note">Every action below is a labelled
      button or checkbox reachable with the keyboard. Typing always works; voice never replaces it.</p>
    <label htmlFor="voice-controls-enabled">
      <input id="voice-controls-enabled" type="checkbox" checked={settings.enabled}
        onChange={event => onSettingsChange?.({ enabled: event.target.checked })} />
      Enable voice controls (optional)
    </label>

    <h3 id="voice-input-heading">Voice input</h3>
    <p data-field="voice-input-status" aria-live="polite">{voiceInputStateTextV1(inputState)}</p>
    {inputState === "listening" || inputState === "confirming" ? <>
      {heard.trim().length > 0 && <p data-field="voice-heard-preview">Heard: {heard}</p>}
      <button type="button" onClick={confirmTranscript} disabled={heard.trim().length === 0}>Confirm: use these words</button>
      <button type="button" onClick={cancelDictation}>Cancel: discard</button>
      <button type="button" onClick={() => { try { recognition.stop(); } catch { /* best effort */ } setInputState("idle"); }}>Stop listening</button>
    </> : <>
      <button type="button" onClick={startDictation} disabled={!recognitionSupported}>Start dictation</button>
      {!recognitionSupported && <p data-field="voice-unsupported-note">Dictation needs a browser with speech recognition; this one has none.</p>}
    </>}

    <h3 id="voice-read-heading">Read aloud</h3>
    <p data-field="voice-read-status" aria-live="polite">{voiceReadStateTextV1(readState)}</p>
    {readState === "speaking"
      ? <button type="button" onClick={stopReading}>Stop reading</button>
      : <button type="button" onClick={startReading} disabled={!synthesisSupported}>Read aloud</button>}
    {!synthesisSupported && <p data-field="voice-read-unsupported-note">Read-aloud needs a browser with speech synthesis; this one has none.</p>}
  </section>;
}
