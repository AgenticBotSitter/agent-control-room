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
- `src/harness/claude-code-v1/result-publication.ts` — source-only bridge from one
  accepted, decoded terminal result to the existing shared durable publisher.

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

## Result identity is not minted in this package

Binding a decoded stream to a canonical run lineage is deliberately absent here. Caller
supplied lineage and a caller's own terminal confirmation are not trusted provenance, so
an inert connector package must not mint a result identity. That responsibility belongs
to the lead-owned shared result publication path
(`src/harness/v1/terminal-result-evidence.ts`) and to the shared durable publisher.

`result-publication.ts` does not change that. It mints no identity: every identity field
it publishes is retained authority the trusted caller supplied whole, and the shared
publisher independently verifies all of it against recorded state.

## Durable result publication bridge

`publishClaudeTerminalResultV1(config, input)` hands one accepted Claude terminal result
to the EXISTING `publishDurableResultV1` (`src/artifacts/v1/durable-result-publication.ts`)
over the existing neutral reservation adapter. It is the whole of the connector's
publication path: one call, one shared publisher, no new table, storage authority or
result schema, and no Codex, native or Hermes publisher copied or reused.

**Inputs.** All retained by the trusted caller, captured field by field and frozen at
entry so later caller mutation cannot change what was verified or published:

- `retainedBinding` — `tenantId`, `projectId`, `jobId`, `attemptId`, `runId`, `nodeId`,
  `workflowId`, `acceptanceProfileId`, `acceptanceProfileDigest`. Project authority, none
  of it readable from transport output.
- `processBinding` — the accepted `ClaudeCodeProcessBindingV1` for the owned session.
- `retainedSession` — `processAttemptId`, the retained expected `sessionId` bound to it,
  and the independently observed `terminalFrameDigest`.
- `disposition` — that session's own `ClaudeCodeSessionDispositionV1`.
- `terminalFrame` and `decoderState` — the independent decode of the same stream.
- `acceptedConnectorProfileDigest`, `receivedAt`, `assertAuthority`.

The harness tag (`claude`) and the connector profile digest are **not** caller inputs:
both come from the accepted connector profile, and a supplied digest that differs from
`CLAUDE_CODE_CONNECTOR_PROFILE_DIGEST_V1` is refused. Terminal JSON may supply content
and observed session evidence only — never tenant, project, job, attempt, run, node,
workflow or acceptance-profile identity, and never a grant or key. The terminal frame's
digest is published as `terminalEvidenceDigest`; its fields are not.

**Retained state this connector does not yet expose.** The retained expected session ID
and the observed terminal-frame digest are explicit bridge inputs because
`ClaudeCodeSessionDispositionV1` carries neither, and
`OwnedClaudeCodeProcessSessionV1` exposes no method that retains the validated `init`
observation — `recordTerminalResultObserved()` takes no argument, and there is no
`recordInitSessionObserved(sessionId)` or equivalent accessor. The expected session ID may
originate from that validated init frame and is then retained by the caller and compared
against the terminal observation; both sides of that comparison never come from the same
frame. Runtime acquisition and wiring remain out of scope, so tests supply the retained
inputs explicitly.

**Refusals.** Every one fails closed before the shared publisher is reached, and the
tests assert the injected database, storage and reservation ports were never touched:

- `claude_code_result_publication_unavailable` — missing or malformed retained authority
  (including a missing `assertAuthority`), retained binding or retained session.
- `claude_code_result_publication_connector_profile_mismatch` — a connector profile
  digest other than the accepted Claude profile's.
- `claude_code_result_publication_binding_mismatch` — the disposition, the accepted
  process binding and the retained publication binding disagree on run, attempt or
  process attempt.
- `claude_code_result_publication_session_mismatch` — the retained expected session ID
  does not match the independently decoded terminal session.
- `claude_code_result_publication_evidence_digest_mismatch` — the retained observed
  terminal-frame digest does not match the decoded frame.
- `claude_code_result_publication_session_not_terminal` — the session is open, cleanup is
  uncertain, the exit was unobserved or malformed, no terminal result was confirmed, the
  decode failed or never reached a terminal frame, or the decoded outcome is `failed`.
- `claude_code_result_publication_result_unusable` — absent, empty, oversized (over the
  profile's existing 65,536-byte result ceiling) or self-contradicting result text.

The shared publisher's own refusals — `durable_result_identity_mismatch`,
`durable_result_reservation_conflict`, `durable_result_storage_uncertain`,
`durable_result_manual_reconciliation_required` — pass through unswallowed and
unrelabelled.

**What it does not do.** It approves nothing, completes nothing, releases no capacity,
retries nothing and redispatches nothing; it starts, acquires and spawns no process, so
an exact publication retry over retained evidence returns the existing durable receipt
without starting a new one. It holds no state, so a reconstructed instance over the same
database replays identically. It is not a live qualification: no authenticated run, no
provider call and no credential is involved, and every profile operation stays
`unsupported`.

## Not done yet

- No canonical result publication. That gating stays with the lead; the durable bridge
  above publishes one receipt and one ordinary pending review target, and approves nothing.
- No Claude variant in the shared `terminal-result-evidence` schema.
- No authenticated run, no `--max-budget-usd` ceiling proof, no `--session-id`/`--resume`
  proof. Until those exist, per `docs/SHARED_CONNECTOR_CONTRACT.md`, `submit`, `status`,
  `result`, `resume` and `usage` stay `unsupported` regardless of evidence level.
- No cancellation of a real process; only the bounded cleanup path is proven, against an
  injected fake.
