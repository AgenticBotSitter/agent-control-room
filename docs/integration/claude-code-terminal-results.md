# Claude Code terminal results: shared evidence and durable publication

Scope: the path from one decoded Claude Code CLI terminal `result` frame to one
receipt on the existing harness-neutral durable result publisher, and the
shared terminal-result evidence that binds the two.

This document covers source only. Nothing here spawns a process, chooses a
Claude executable, reads a credential, calls a provider, opens a table, or adds
any Claude-specific approval, queue, scheduler or result authority. Native
qualification on a real Claude host remains separate, owner-attended work that
this package does not authorize.

## What changed, and why

PR #123 delivered the inert Claude foundation (bounded stream decoding, owned
process sessions). A later package added
`src/harness/claude-code-v1/result-publication.ts`, a direct bridge from a
decoded terminal frame to the shared `publishDurableResultV1`. That bridge was
correct, but it was the only harness publication path that did **not** go
through the shared harness-neutral evidence layer in
`src/harness/v1/terminal-result-evidence.ts`. That gap was disclosed at the
time, in `docs/integration/claude-code/README.md` under "Not done yet":

> No Claude variant in the shared `terminal-result-evidence` schema.

This package closes exactly that gap. Claude now projects into the same
discriminated union Hermes and Codex already use, and the bridge returns that
evidence alongside the receipt — the same shape
`publishHermesSessionResultV1` returns.

## The two pieces

### 1. `projectClaudeTerminalResultEvidenceV1` (shared layer)

In `src/harness/v1/terminal-result-evidence.ts`. A fourth member,
`kind: "claude_terminal_result"`, joins `hermes_native_snapshot`,
`codex_exact_completed_turn` and `upstream_hermes_session_result` in
`terminalResultEvidenceSchemaV1`.

Input (all `.strict()`, all parsed before anything is read):

| field | meaning |
| --- | --- |
| `lineage` | canonical tenant/project/job/attempt/run/node, retained authority |
| `retained.processAttemptId` | the owned process attempt the evidence belongs to |
| `retained.sessionId` | expected session id, observed on the validated `init` frame and retained before the terminal frame arrived |
| `retained.connectorProfileDigest` | digest of the connector profile the run was admitted with |
| `retained.terminalFrameDigest` | canonical digest of the terminal frame, observed and retained independently |
| `terminalFrameRawLine` | the EXACT raw terminal line — the only material content is read from |
| `resultSubtypeCode` | the decoder's fixed subtype classification (evidence only; it never classifies outcome) |
| `decoderFramesAccepted` | the decoder's accepted-frame count for that stream |
| `observedAt` | caller-pinned timestamp; the projection never invents a clock value, so a replay projects byte-identical evidence |

Output: a deeply frozen, inert evidence object. `canonicalPublicationAllowed`,
`qualityAccepted`, `completionRecorded`, `grantsExecutionAuthority`,
`permitsRetry` and `permitsResume` are all `false` literals — the union's schema
refuses any object where one of them is `true`, so evidence can never be
re-minted as authority. `evidenceDigest` is recomputed over the whole material
by the union's `superRefine`, so any substitution under a preserved digest is
refused on parse.

**Digest discipline.** The projection never trusts a digest field a caller
computed. It parses `terminalFrameRawLine` itself, recomputes
`sha256Digest(parsed)` with the same function the decoder uses for
`frameDigest`, and requires that recomputed value to equal the retained
`terminalFrameDigest`. Every security-relevant field (`type`, `session_id`,
`is_error`, `terminal_reason`, `result`) is then read out of that verified
material, and `content.contentHash` / `content.sizeBytes` are recomputed from
the actual result bytes. Altering the text necessarily alters the recomputed
digest, so it can no longer satisfy the retained one.

**Refusals.** All fail closed as `terminal_result_evidence_unavailable`, with
no I/O of any kind:

- the raw line is not parseable JSON, or parses to something that is not a
  plain object;
- the recomputed canonical digest does not equal the retained
  `terminalFrameDigest` (this is the boundary; a well-formed non-terminal line
  with an honest digest of its own is refused here too);
- the verified material is not a `result` frame;
- the material's `session_id` is not the retained expected session id;
- `is_error` is anything other than exactly `false`, or a `terminal_reason` is
  present at all;
- result text that is absent, not a string, empty, whitespace-only, not
  well-formed Unicode (a lone surrogate would silently become U+FFFD on
  encode), or outside 1..65,536 UTF-8 bytes;
- result text carrying secret material, per `assertNoSecretMaterial` — the same
  scan the Codex and upstream-Hermes projections apply;
- a malformed, missing or unexpected input field, including a missing or
  malformed `observedAt`.

### 2. `publishClaudeTerminalResultV1` (connector bridge)

In `src/harness/claude-code-v1/result-publication.ts`. Unchanged in every
existing respect — its retained-identity parsing, connector-profile pinning,
binding/disposition/decoder-state checks, its own independent recomputation of
the terminal material's digest, and its single call into `publishDurableResultV1`
are all exactly as previously accepted, and its refusal taxonomy is unchanged.

Two additions:

1. After all of its own refusals, and before the durable binding is built, it
   calls `projectClaudeTerminalResultEvidenceV1` with the retained facts and the
   raw terminal line. Nothing the bridge already computed is handed to the
   projector as a shortcut: the projector re-parses and re-derives everything
   from the raw material, so the projection is an independent second derivation
   rather than a re-check of the bridge's own conclusions. A projection failure
   surfaces unswallowed as `terminal_result_evidence_unavailable`.
2. It then requires the bytes it is about to publish to match
   `evidence.content` (hash and length), and returns the evidence on
   `ClaudeTerminalResultPublicationV1.evidence`.

The evidence is deterministic in `receivedAt`, so an exact publication replay
returns the same receipt **and** byte-identical evidence.

**Ordering, and why.** The projector is called last rather than first so the
bridge's specific refusal taxonomy
(`claude_code_result_publication_evidence_digest_mismatch`,
`..._terminal_material_unusable`, `..._session_not_terminal`,
`..._result_unusable`, `..._session_mismatch`, `..._binding_mismatch`,
`..._connector_profile_mismatch`, `..._unavailable`) stays the one callers and
the existing tests depend on. The projector's own identical checks then run as
the shared layer's authoritative pass. The two are not divergent
implementations of one check: they compare the same retained digest, computed
with the same `sha256Digest`, over the same raw line, and both must pass.

**What does not change.** The durable binding still anchors
`terminalEvidenceDigest` to the observed **terminal frame** digest, not to the
projected evidence digest. That is deliberate: the shared publisher matches
that field against the `authorityDigest` the run recorded at admission, and the
frame digest is the value an admitting connector can actually attest. Changing
it to the evidence digest would require admission to record a digest that can
only be derived after the result exists.

## Refusal list, end to end

| refusal | raised by | cause |
| --- | --- | --- |
| `claude_code_result_publication_unavailable` | bridge | missing/malformed retained authority, binding, session or `assertAuthority`; absent or empty raw line |
| `claude_code_result_publication_connector_profile_mismatch` | bridge | a connector profile digest other than the accepted Claude profile's |
| `claude_code_result_publication_binding_mismatch` | bridge | disposition, process binding and retained publication binding disagree on run, attempt or process attempt |
| `claude_code_result_publication_session_mismatch` | bridge | retained expected session id vs. the independently decoded terminal session |
| `claude_code_result_publication_evidence_digest_mismatch` | bridge | recomputed digest of the raw material ≠ retained terminal-frame digest; or published bytes ≠ shared evidence content |
| `claude_code_result_publication_terminal_material_unusable` | bridge | raw line not parseable JSON, not an object, not canonically digestible, or not a `result` frame |
| `claude_code_result_publication_session_not_terminal` | bridge | session open, cleanup uncertain, exit unobserved or malformed, terminal result unconfirmed, decode failed or never terminal, or a failed/errored/terminal-reason-bearing outcome |
| `claude_code_result_publication_result_unusable` | bridge | verified result text absent, empty or oversized; or a decoded frame contradicting the verified material |
| `terminal_result_evidence_unavailable` | shared projector | any projector refusal in the list above |
| `durable_result_identity_mismatch`, `durable_result_reservation_conflict`, `durable_result_storage_uncertain`, `durable_result_manual_reconciliation_required` | shared publisher | pass through unswallowed and unrelabelled |

Every bridge-local and projector-local refusal happens before the shared
publisher is reached; the tests assert the injected database, storage and
reservation ports were never touched.

## Behaviour change to note

A Claude result whose text matches the shared secret-material patterns now
refuses at the projector. Previously the bridge had no such scan and would have
published it. This is deliberate and matches the Codex and upstream-Hermes
projections, but it is a genuine behaviour change relative to the previously
accepted bridge, not just a formalisation.

## Tests

- `tests/claude-code-stream-json-decode.test.ts` — the projector directly:
  positive control (inert flags, frozen output, lineage/source binding,
  recomputed content, `kind` discrimination, determinism), raw-material binding
  and tamper cases, malformed/stale/mismatched/non-terminal material, and
  oversized/empty/whitespace/invalid-UTF-8/secret-bearing result text. Also
  confirms a projection refusal still leaves the shared publisher untouched.
- `tests/claude-code-owned-process-session.test.ts` — the publication returned
  from a **real** owned session, real stdout framing and real decode carries
  shared evidence bound to the published bytes and the retained session, and
  replays byte-identically.
- `tests/durable-result-publication.test.ts` — the Claude member inside the
  shared union in the durable lane: `kind` discrimination against every sibling
  member, and forged-evidence-digest refusal.

## Disclosed gaps

These are real and are **not** worked around here; closing them needs files
outside this package's write scopes, or work this package does not authorize.

1. **`publishClaudeTerminalResultV1` has no production caller.** Nothing in
   `src/` outside the connector package invokes it: it is reached only from
   tests. There is no dispatcher hook, no runtime wiring, and no code path that
   collects the retained inputs from live state. Adding one would require a
   live dispatcher change, which this packet explicitly forbids
   (`effects: none`).

2. **The connector still exposes no accessor for its own retained session
   state.** `ClaudeCodeSessionDispositionV1` carries neither a session id nor a
   terminal-frame digest, and `OwnedClaudeCodeProcessSessionV1` has no
   `recordInitSessionObserved(sessionId)` or equivalent. Both remain explicit
   caller-supplied inputs, and the tests supply them by hand. This is unchanged
   from the previously accepted bridge.

3. **`docs/integration/claude-code/README.md` is now stale.** Its "Not done
   yet" section still reads "No Claude variant in the shared
   `terminal-result-evidence` schema", which this package has closed, and its
   bridge section does not mention the shared projection. That file is not in
   this packet's write scopes, so it is left untouched and the staleness is
   disclosed here instead.

4. **The projector's explicit `1..65_536` byte check is redundant.** The
   evidence `contentSchema` already bounds `sizeBytes` to that range, so
   removing the explicit check does not change any observable behaviour
   (confirmed by mutation: the mutant survives because the schema refuses
   first). It is kept as defence in depth, mirroring the upstream-Hermes
   projection, and is documented here rather than presented as an independently
   load-bearing check.

5. **The bridge's evidence-content cross-check proves reachability, not
   provenance.** The bridge and the projector read the same raw line, so on any
   successful publication the two agree by construction; no test can
   distinguish which side produced the value. Provenance is proven where the
   two sides are made to differ — in the projector's own tamper cases. This
   mirrors the honest caveat already recorded for the upstream-Hermes path in
   `tests/durable-result-publication.test.ts`.

6. **No canonical publication, no live qualification.** The bridge publishes one
   durable receipt and one ordinary pending review target. It approves nothing,
   completes nothing, releases no capacity and permits no retry or redispatch.
   Canonical result gating stays with the lead. No authenticated run, no
   provider call, no credential and no budget/session-resume proof exists here,
   so per `docs/SHARED_CONNECTOR_CONTRACT.md` the connector's `submit`,
   `status`, `result`, `resume` and `usage` operations remain `unsupported`.
