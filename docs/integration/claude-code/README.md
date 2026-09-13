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
- `src/harness/claude-code-v1/result-identity.ts` — binds a decoded stream to the run
  identity Control Room supplies, producing a digest-bound inert record.
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
- **Outcome is derived from `is_error` and `terminal_reason` only.** `result.subtype` can
  read `"success"` while `is_error` is `true`; `subtype` is retained for audit and never
  classifies. A `terminal_reason` alone also fails the outcome.
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
- Process exit shape is validated strictly (`code` xor `signal`).
- `close()` is deadline bounded: close stdin, terminate, then wait for both pumps and
  exit. Anything that does not confirm within the deadline makes the close reject with
  `claude_code_process_session_cleanup_uncertain`, and `disposition()` records
  `cleanupUncertain`. It never silently claims a clean shutdown.
- `disposition().resubmissionSafe` is always `false`. A restart proves nothing about a
  previous attempt, so no path here marks a run safe to resubmit.

## Result identity

`bindClaudeCodeResultIdentityV1` requires the init and result frames to agree with each
other, with the session identity Control Room expected, and with the closed session's
disposition. It re-derives the content hash and size from the result text and rejects a
mismatch. The record is shaped consistently with
`src/harness/v1/terminal-result-evidence.ts` but is deliberately not part of it: adding a
Claude variant to the shared schema is lead-owned. All inert flags are `false`.

## Not done yet

- No canonical result publication. That gating stays with the lead.
- No Claude variant in the shared `terminal-result-evidence` schema.
- No authenticated run, no `--max-budget-usd` ceiling proof, no `--session-id`/`--resume`
  proof. Until those exist, per `docs/SHARED_CONNECTOR_CONTRACT.md`, `submit`, `status`,
  `result`, `resume` and `usage` stay `unsupported` regardless of evidence level.
- No cancellation of a real process; only the bounded cleanup path is proven, against an
  injected fake.
