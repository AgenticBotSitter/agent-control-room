# Claude Code connector

Inert connector modules for the operator-installed `@anthropic-ai/claude-code` npm
package. Nothing here runs Claude Code. Nothing here holds, reads or resolves a
credential. Every operation in `claudeCodeConnectorProfileV1` remains `unsupported`.

## Modules

- `src/harness/claude-code-v1/connector-profile.ts` — existing inert profile: exact
  package identity, transport, and per-operation evidence. Unchanged by this work.
- `src/harness/claude-code-v1/stream-json-decode.ts` — strict decoder for the CLI's
  newline-delimited `--output-format stream-json` output.
- `src/harness/claude-code-v1/owned-process-session.ts` — synchronously owned process
  lifecycle over an injected byte port, with bounded stdout framing and bounded cleanup.
- `src/harness/claude-code-v1/unsupported-operations.ts` — explicit refusal, with a
  reason code, for every operation the profile has not proven.

## Decoding rules

Lines are classified as `init`, `assistant_turn`, `result` or `decode_error`.

- The first frame must be `system`/`init`; it fixes the session identity. Later frames
  must repeat that same `session_id`.
- Only `system`/`init`, `assistant` and `result` are accepted. Any other `type`, any
  other `system` subtype, malformed JSON, a non-object, an empty line, an embedded
  carriage return or a line over 262,144 bytes is a `decode_error`.
- Assistant failures arrive inline (`error`, `is_api_error_message`), not as a distinct
  frame type, and are reported as `inlineError` on the assistant frame.
- `result` is terminal. A second `result`, or any frame after it, is a `decode_error`.
- **Outcome is derived from `is_error` and the presence of `terminal_reason` only.**
  `result.subtype` can read `"success"` while `is_error` is `true`, so the subtype never
  classifies. A `terminal_reason` alone also fails the outcome.
- **No raw upstream `subtype` or `terminal_reason` text is retained or exported.** Both
  are untrusted source text. They are read only to select one value from a fixed set and
  are then discarded: `subtypeCode` is `success`, `error_max_turns`,
  `error_during_execution` or `unrecognized`; `terminalReasonCode` is `none`,
  `max_turns`, `max_tokens`, `timeout`, `cancelled`, `refusal`, `error` or
  `unrecognized`, alongside a `terminalReasonPresent` flag. Secret-like or
  control-bearing input therefore cannot reach a decoded frame; tests assert this.
- Result text is bounded by the connector profile's existing
  `resultContract.maximumBytes` (65,536 UTF-8 bytes). No new ceiling is introduced.
- The first decode failure permanently poisons the decoder. There is no resynchronisation.

## Process lifecycle

`createClaudeCodeOwnedProcessSessionV1` takes an injected `acquire` function. It does
not select an executable, build an argument vector, supply environment, read
configuration, retry, resume, or return stderr content — stderr is counted against a
ceiling and discarded.

- One binding may be started exactly once, ever. A restart must mint a fresh
  `processAttemptId`; a duplicate binding is refused before `acquire` is called.
- stdout is framed on `\n` with a per-line ceiling and a total buffered ceiling. A
  carriage return, an overlong line or invalid UTF-8 is fatal to the session.
- **A natural stdout EOF on a line boundary is a drainable stream end, not a failure.**
  Lines already decoded before the EOF — including a `result` frame emitted immediately
  before the process exits — stay readable through `readLine`, which returns `undefined`
  only once the queue is empty. A well formed natural exit does not discard queued
  output. A trailing partial line at EOF is truncated output and remains fatal.
- Process exit shape is validated strictly (`code` xor `signal`).
- `close()` is deadline bounded: close stdin, terminate, then wait for both pumps and
  exit. Anything that does not confirm within the deadline makes the close reject with
  `claude_code_process_session_cleanup_uncertain`, and `disposition()` records
  `cleanupUncertain`. It never silently claims a clean shutdown.
- `disposition().resubmissionSafe` is always `false`. A restart proves nothing about a
  previous attempt, so no path here marks a run safe to resubmit.

## Result identity is not in this package

Binding a decoded stream to a canonical run lineage is deliberately absent here. Caller
supplied lineage and a caller's own terminal confirmation are not trusted provenance, so
an inert connector package must not publish a result-identity binder. That responsibility
belongs to the lead-owned shared result publication path
(`src/harness/v1/terminal-result-evidence.ts`).

## Not done yet

- No canonical result publication. That gating stays with the lead.
- No Claude variant in the shared `terminal-result-evidence` schema.
- No authenticated run, no `--max-budget-usd` ceiling proof, no `--session-id`/`--resume`
  proof. Until those exist, per `docs/SHARED_CONNECTOR_CONTRACT.md`, `submit`, `status`,
  `result`, `resume` and `usage` stay `unsupported` regardless of evidence level.
- No cancellation of a real process; only the bounded cleanup path is proven, against an
  injected fake.
