# Shared connector and result contract

**Status:** lead decision for the public initial release, September 12, 2026.  
**Code contract:** `src/harness/v1/connector-profile.ts`.

Control Room owns projects, task admission, attempts, review, revision, artifacts and
recovery decisions. A harness connector translates one upstream interface; it does not
become another scheduler or grant itself permission. Its profile is inert metadata,
not an executable plugin and not proof that advertised operations work.

## Common rules

- Every connector pins exactly one upstream source identity: either an immutable Git
  revision or an exact npm package version plus its SHA-512 package digest. It also
  records transport, isolation, credential-resolution and distribution mode. Package
  identity is evidence of what was inspected; it grants no operation and does not
  authorize Control Room to redistribute an operator-installed package.
- Every operation is explicitly `supported`, `unsupported` or `unknown`, with its
  evidence level. Source and fixture evidence can select work but cannot enable an
  operation. Runtime admission requires actual-interface or native qualification.
- An upstream ID is correlated to the canonical tenant, project, task, attempt and
  Control Room run. An upstream completion message is evidence; canonical result and
  review records decide completion.
- Submit is never blindly repeated after an uncertain reply. Reconnect/read/status
  is distinct from resume or a new turn. Unsupported cancel, usage or replay remains
  visible rather than fabricated.
- The initial artifact is one UTF-8 text result of at most 65,536 bytes. Control Room
  verifies exact bytes, hash, size and run lineage before storing it. No connector may
  turn agent text, a path or an arbitrary URL into a download capability. Additional
  and binary attachments remain disabled for this contract version.
- `src/harness/v1/canonical-text-result.ts` is the single harness-neutral projection
  boundary for that text result. It accepts only a connector whose `result` or read-only
  `read` operation already passed actual-interface or native qualification. Its envelope
  binds the complete Control Room lineage, exact connector profile, upstream identities,
  completion evidence, exact bytes and observation time. The envelope is still pending
  owner review: creating it stores nothing, completes no task and grants no retry, resume
  or execution authority. Existing harness-specific durable storage must be adapted to
  this boundary in a separately reviewed migration; it is not silently relabelled here.
- Public extensions may observe through bounded read interfaces. Execution bindings,
  credential lookup, approval, signing, schema writes and task completion stay in the
  reviewed core. Removing an extension cannot remove canonical history.

## Initial connector decisions

### Hermes

Use `asimons81/hermes-gpt` revision
`89cbfbe232d62dfb8c3cb4f9af04c6c32f956e73` through an operation-level FastMCP
binding. Source inspection confirms `hermes_session_continue`,
`hermes_session_job_status` and `hermes_session_job_result`. The result is capped by
upstream at 24,000 characters and must still pass Control Room's UTF-8 byte bound.
The inert source-inspected profile is retained in
`src/harness/hermes-gpt-v1/connector-profile.ts`; the common admission check refuses
all three advertised operations until their evidence is upgraded by the required
actual-interface or native qualification.

The source does not provide the durable idempotency, SSE, stop or replay interface
assumed by the existing experimental `/v1/runs` adapter. PR #14 remains useful fixture
and uncertainty evidence only. Cancel, event replay and per-job usage are unsupported;
restart may report a running job as `orphaned`, which is uncertainty, not resumability.
Before submit is admitted, run the unmodified FastMCP implementation through
continue → status → result and cover busy, truncation, lost-submit and restart/orphaned.
Once a completed native observation is independently qualified, the pure
`projectNativeObservationTextResultV1` seam checks its current/completed state and
exact byte claim before producing the shared pending-review envelope. It performs no
native call, storage or completion itself.

### Codex

Use the official Codex App Server as a parent-owned stdio JSON-RPC process. The selected
integration pin is `0.150.0-alpha.8` until intentionally upgraded. Retain initialization,
thread/turn identity, notification correlation, interrupt and bounded framing already
present in the codebase. `thread/read` is the required read-only recovery primitive;
resume and a new turn are never substitutes for status inspection. Inbound App Server
approval requests remain unsupported, not silently accepted.

The non-experimental schema generated from the exact selected package is retained
as sanitized version/digest/`thread/read` evidence. The matching official release tag
produces the same complete generated-bundle byte count and SHA-256, so the exact
agent-message result shape is also retained and bound to the narrow adapter.
The start and recovery responses must report the exact selected `cliVersion`; a
different installed Codex version is rejected before its thread or turn can become
durable evidence or a recovered observation.
The shared node protocol also has an effect-free signed `harness.codex.dispatch`
contract. It reuses the existing node signature and pinned owner-approval trust while
binding the exact input, workspace intent, connector profile, enrollment and lease.
The v1 run ID is the hash of the exact tenant, node, project, job, attempt, lease ID
and lease epoch, all of which exist before the complete workspace intent is hashed.
It is deliberately independent of the later effect-claim digest. The owner permit
also binds the exact canonical workspace path, which must be equal to or below the
single approved filesystem root with a separator boundary; the policy target and
activation therefore identify the same checkout path.
Its receipt proves intake only; it grants no permission to launch App Server, retry,
resume, read or complete work. The server session now owns the matching negotiated,
one-shot sender: it signs once, requires a durable transmission callback before its
only send, accepts only the exact authenticated receipt, and does not reopen a send
slot after uncertainty. Append-only, HMAC-protected server records now retain the
exact signed envelope, pre-send transmission intent, and authenticated receipt. They
bind the existing shared queue entry to the complete verified Codex approval packet
and exact machine/work settings; a replacement connection cannot create a second send
intent. The trusted Codex queue collaborator now checks the locked canonical job,
attempt, lease, node and recalculated job-authority digest before recording that shared
queue entry. Canonical Codex task planning and owner-review composition remain required
before native use. The node-private Codex start journal now
stores the exact correlated thread receipt before its turn receipt, survives reopen,
and returns an explicit unknown state when the turn receipt is absent. It is an
observation record only: it cannot list or guess sessions and grants no start, retry,
resume or read authority. The fixed local start composition now connects signed
activation evidence, current admission, the exact protected workspace intent, the
owned App Server process and ordered no-replay journal writes. It is inert on import
and requires an explicit one-shot start call with every native port supplied by a
trusted host. A private `codex-local-v1` configuration and launcher seam can now
open the two protected journals and compose either that initial start or the exact
durable read. A shared fake-tested adapter beneath both fixed JSONL profiles converts
one synchronously owned, explicitly injected process byte port into strict UTF-8
newline frames. It owns readiness, pending I/O, stdin close, termination, reader
drain and valid terminal-exit evidence; any cleanup uncertainty withholds the
observation. A separate Linux-only node acquisition port now consumes the same owned
process interface after a synchronous fence over one immutable permit. It accepts one
absolute, exact-version native ELF artifact, hashes an opened non-symlink file, verifies
root-or-current-owner custody and non-writable group/world modes, and launches the held
descriptor through `/proc/self/fd/3` with only the fixed `app-server` argument. The
reviewed workspace root, workspace and operator-supplied `CODEX_HOME` are canonical,
owned directories with disjoint custody; their opened identities are rechecked around
launch. `CODEX_HOME` is an explicit non-secret location needed by the operator-installed
Codex binary; the port does not inspect credentials or inherit the ambient environment.
It owns standard streams, retains cancellation through process retirement, and escalates
TERM to KILL unless terminal exit is observed. The production export captures Node's
launcher inside the module; the injected launcher remains a test-only, non-server export.
Darwin, Windows and other platforms fail closed pending separate descriptor execution
qualification. No provider call, retry, resume, approval, canonical writer or capacity
release is added, so this remains source/test evidence rather than live enablement or
physical host qualification.
The matching local read composition now accepts only that journal's exact saved
thread and turn identity, rechecks current authority around each native read, and
exposes no resume or new-turn method. A completed recovery read now carries a pinned
agent-message-schema, bounded and secret-screened text candidate when available. The
qualification applies to the selected result item, not every ignored item in the
response. Matching the generated schema does not prove native behavior: the candidate remains explicitly
barred from canonical result publication until restart/read is qualified on the
selected executable.
The portable node bridge now negotiates `harness.codex.dispatch.v1`, verifies the
owner permit and exact local enrollment/profile/workspace bindings, records one
immutable private delivery, and returns one signed receipt. It never replays an
uncertain receipt across reconnect, and this intake path has no process or workspace
effect port. Canonical Codex planning/owner-review composition and the actual start
composition remain separately required.
The fake-JSONL acceptance lane now passes one recorded bridge activation through
the private host into one thread/turn start, then reopens the exact durable pair for
read-only recovery. It also refuses duplicate or missing activation, interrupted
writes, revoked authority, malformed/summary/secret results and uncertain cleanup.
This is composition evidence only: it does not spawn or qualify a physical Codex
process, call a provider, or release capacity.

The Codex-only canonical result publisher now consumes an exact completed-turn
publication contract and terminal evidence only after independently verifying the
complete signed physical-qualification receipt against operator-injected expected
identity, digest, signer key ID and public key. It also re-authenticates the saved v3
task plan and activation intent, locks and rechecks the current canonical admission,
then reserves exact bytes before storage and readback. After exact readback it writes
the artifact manifest, result receipt and one pending review target. Restart replays
only fully committed metadata; ambiguous storage and split writes require explicit
reconciliation and never cause a second write. Its harness record is a neutral Codex
evidence anchor: `discovered`, no start/finish/events/native task, not resumable and
not a lifecycle or completion claim. It does not accept review, complete a task,
attempt or lease, or release capacity. Tests use an ephemeral synthetic signer and
are not physical qualification. Live reachability remains disabled until the actual
spawn/environment/credential port and selected-executable qualification are reviewed
and composed by the owner.

This correction was made before any qualified v1 native record was deployed. Any
older pending packet or reservation created with the provisional effect-derived run
ID or filesystem-root target must remain preserved as reconciliation evidence and
be rejected and replanned/redelivered. It must never be rewritten in place or
accepted through a dual-formula compatibility path.
Actual admission still requires a test that `thread/read(includeTurns: true)` after
process restart reads the exact thread without resuming or starting work. Production
WebSocket transport, dynamic tools and automatic approval are outside the initial contract.

**Landing order is a gate, not a preference.** `submit` may not move from `unknown`/
`source_inspected` to a status that lets a real process start until both the
`thread/read` restart-recovery qualification above and the result-schema evidence
in the paragraph above it are independently passing. A connector that can start work
but cannot yet honestly read a result back after a restart must stay unreachable from
the admission path, however complete its start-side code looks.

### Claude Code

Treat Claude Code as an operator-installed, invocation-only npm package speaking bounded
JSON-lines over standard input and output. Its connector profile uses the exact package
name, version and package digest instead of inventing a Git revision. This only makes the
source identity truthful. Submit, status, result, cancel, resume, approvals, background
agents, worktrees and usage remain unavailable until each operation has the evidence level
required by the shared admission rule. Authentication remains owned by Claude Code; no
credential value, executable path or private endpoint belongs in the public profile.

An unauthenticated run of the pinned package (`-p`/`--print --output-format stream-json`)
already gives real, zero-cost `fixture_tested` evidence for the `system`/`init`,
`assistant` and `result` frame shapes, including that `result.subtype` can read
`"success"` while `result.is_error` is `true` — classification must key off `is_error`/
`terminal_reason`, never `subtype`. It does not, and cannot, evidence a real turn: no
operation here may move past `fixture_tested` until an authenticated run exists. Actual
admission requires, once a credential path is authorized (owner/billing decision, not a
connector concern): (1) one full authenticated turn's real frame sequence, including at
least one `tool_use`/`tool_result` pair, not just the auth-failure sequence Stage A0
captured; (2) `--max-budget-usd` actually halting a run at its ceiling rather than only
being accepted as a flag; (3) a `--session-id`-pinned run correctly resumed by
`--resume` with its native identity intact; (4) `--resume` against an already-exited
session reporting a clean, non-silent failure. Until all four pass, `submit`, `status`,
`result`, `resume` and `usage` remain `unsupported` regardless of evidence level, per the
shared admission rule above.

## Optional components

- Herdr v0.9 (`b99002ac99b09e00b4ca692436cb15a6b0d676f1`) stays an
  operator-installed, observation-only pane source. It is not task authority, a remote
  transport or proof of completion. Native same-host isolation remains unqualified.
- Current Control Room React panels and react-markdown/GFM remain the UI base. From
  Hermes WebUI, retain only anti-stuck streaming/pending semantics as tests. A Hermes
  Desktop active-session strip is deferred unless a real second in-app view switcher
  is still needed. Do not import either global store, full shell or Electron runtime.
- Built-in health and Needs attention projections are the initial monitoring surface.
  Uptime Kuma and Beszel remain separate optional services; neither is installed or
  copied into Control Room and neither becomes task authority.

Copied donor code must record upstream URL, immutable revision, original path, local
destination, modifications, license/copyright and notices in `THIRD_PARTY.md`. Invoking
an operator-installed binary does not authorize redistributing that binary.
