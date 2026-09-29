# Optional voice controls (voice/v1)

An optional, removable voice-input and read-aloud module behind a strict
adapter boundary. The product remains fully usable without voice.

## Authority

- Disabled by default (`VoiceSettingsV1.enabled === false`). While disabled the
  surface renders only the enable checkbox and touches no adapter.
- Dictation never populates a text field on its own. An explicit **Start
  dictation** press opens listening; heard words are shown as a visible preview
  and only an explicit **Confirm** press fires `onTranscriptCommitted`.
  **Cancel** discards. Duplicate adapter events (same `eventId`) are suppressed.
- Read-aloud requires an explicit **Read aloud** press, stops immediately on
  **Stop reading**, and refuses secrets and hidden content (`canReadAloudV1`):
  `isSecret` or `isHidden` content is never spoken and never logged.
- Unsupported browsers, denied permission, cancellation and errors produce
  honest text states (`voiceInputStateTextV1`, `voiceReadStateTextV1`) — never
  silent failure, never automatic submission.
- Unmount stops recognition and cancels synthesis (`cleanupVoiceV1`).
- The module grants no authority: it cannot approve, save, send or start
  anything. It only reports heard words for the caller to commit.

## Adapter boundary

Production code touches microphones and speakers only through the injected
adapters in `src/voice/v1/types.ts`:

- `VoiceRecognitionAdapterV1` (`isSupported` / `start` / `stop`)
- `VoiceSynthesisAdapterV1` (`isSupported` / `speak` / `cancel`)

Tests inject fakes. No real microphone attempt, permission prompt, provider
call, credential or deployment effect exists anywhere in this module.

## Browser adapters (mounted only in Settings)

`private-app/app/voice-browser-adapters.ts` provides the real Web Speech API
implementations of both boundaries via `voiceBrowserAdaptersV1()`:

- **Recognition** feature-detects `SpeechRecognition` / `webkitSpeechRecognition`
  lazily at call time — never at import or adapter creation — so an unsupported
  browser imports cleanly, reports `isSupported() === false`, and `start()`
  reports the safe `unsupported` error kind instead of throwing. Final results
  are mapped into the existing `VoiceTranscriptEventV1` transcript records with
  stable `eventId`s (`recognition-<instance>-<index>`); duplicate suppression
  remains the surface's job (`dedupeTranscriptEventsV1`). Browser error codes
  map onto the safe kinds only (`not-allowed` / `service-not-allowed` →
  `denied`; `not-supported` / `audio-capture` → `unsupported`; `aborted` /
  `no-speech` → `cancelled`; anything else → `error`), and `stop()` is
  safe before start and after stop. During a run it calls the active engine's
  `stop()` once and releases its callbacks/state; repeated stops do nothing.
  Natural end (including an end after an error) and synchronous start failure
  also release the run, allowing the same adapter to start again. A late end
  from a stopped run cannot clear a newer active engine.
- **Synthesis** feature-detects `speechSynthesis`, creates a
  `SpeechSynthesisUtterance` only on explicit caller use of `speak()`, refuses
  blank text, and `cancel()` is idempotent and safe before anything was spoken.

`VoiceControlsWorkspace` mounts the adapters only in the private **Settings**
page. It remains disabled by default, so merely visiting Settings does not
request microphone access, create speech-recognition activity, or contact a
voice service. The owner must first enable the optional controls and then
explicitly press **Start dictation** or **Read aloud**.

A confirmed transcript goes only to an editable, unsent, browser-local draft.
That draft cannot create a project, dispatch a task, contact a worker, or
change settings outside the page. This keeps optional voice useful without
turning speech into an authority path.

## Keyboard and text-only

Every control is a native labelled `<button>` / `<input type="checkbox">`.
Status is an `aria-live` text paragraph, not a colour- or icon-only signal.
Typing always works; voice never replaces it.

## Files

- `src/voice/v1/types.ts` — contract, states, adapter interfaces
- `src/voice/v1/policy.ts` — default-off settings, read-aloud gate, dedupe, cleanup
- `src/voice/v1/presentation.ts` — owner-visible wording for every state
- `private-app/app/voice-controls.tsx` — `VoiceControlsSurface`
- `private-app/app/voice-browser-adapters.ts` — real browser adapters, composed only by the default-off Settings workspace
- `private-app/app/voice-controls-workspace.tsx` — disabled-by-default Settings composition and unsent local draft
- `tests/voice-accessibility.test.tsx` — lane `test:voice`
