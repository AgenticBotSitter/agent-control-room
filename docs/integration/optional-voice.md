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

## Keyboard and text-only

Every control is a native labelled `<button>` / `<input type="checkbox">`.
Status is an `aria-live` text paragraph, not a colour- or icon-only signal.
Typing always works; voice never replaces it.

## Files

- `src/voice/v1/types.ts` — contract, states, adapter interfaces
- `src/voice/v1/policy.ts` — default-off settings, read-aloud gate, dedupe, cleanup
- `src/voice/v1/presentation.ts` — owner-visible wording for every state
- `private-app/app/voice-controls.tsx` — `VoiceControlsSurface`
- `tests/voice-accessibility.test.tsx` — lane `test:voice`
