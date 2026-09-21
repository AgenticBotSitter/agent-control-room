# Single-machine reuse audit

**Status:** source-level decision record, September 20, 2026.
**Scope:** possible borrowed code for the **This computer** installation choice.
This record does not authorize an installation, provider call, service, process
launch, credential read, or live worker.

## Decision rule

Control Room keeps its existing PostgreSQL task authority, pg-boss scheduler,
assignment/review records, protected result path and shared local/remote delivery
contract. A donor may provide a narrow adapter or presentation component only
when it reduces real code without adding a competing authority, scheduler,
credential store, session store, or automatic execution loop.

No code is copied by this audit. Therefore no new entry is needed in
[THIRD_PARTY.md](../THIRD_PARTY.md).

## Fresh source inspection

| Candidate | Immutable inspected source | License read | Exact source inspected | Decision |
| --- | --- | --- | --- | --- |
| T3 Code | 6a699f0f2fbd8847d7ec2df8d9245ce8c2eb8707 | MIT | packages/client-runtime/src/connection/{compatibility,presentation,supervisor}.ts; packages/effect-codex-app-server/src/_internal/stdio.ts | Adapt concepts only; copy no source. |
| Hermes WebUI | f6a37b2381b2c3f3dc5f1425c2812268b0aa6b2b | MIT | api/{session_events,session_recovery,agent_sessions,agent_health}.py | Adapt concepts only; copy no source. |
| Hermes Desktop | 2663e2e63fb834c15a30e1e15068277d4339c35d | MIT | renderer/session and main connection, remote, secret and process modules; project test inventory | Adapt concepts only; copy no source. |
| Control Center | d13e79e866cc33a1fddfe84f563ce2fb9a2113e0 | MIT | Retained collection/reader modules under src/vendor/control-center/ | Already adopted for news only; retain attribution. |
| Alibaba Open Code Review | 71ed3a288df6435f240b7194f19041b4fcc4ab7d | Apache-2.0 | versioned review manifests, input-bound resume identity and bounded file-read implementation | Later optional externally installed reviewer; do not port its engine or make it an approver. |
| Ralph Sandbox | 5cc70ef4d09e336e6d9c5cedd91a87270eeb51b6 | MIT | clone, network/resource and worker loop implementation | Future containment reference only; do not import its credential mounts, fallback loop, completion marker or scheduler. |
| Herdr | prior pinned v0.9 decision | separately installed | Control Room's existing read-only pane observation adapter | Keep optional and observation-only; it cannot launch or complete work. |

## What T3 Code contributes

T3's compatibility function is a small, useful pattern: compare one advertised
protocol version before connection and turn a mismatch into a clear user-facing
state. Its presentation module also distinguishes available, offline, connecting,
reconnecting, connected, unsupported and error without hiding the last failure.

Control Room already has version checks, unavailable states and explicit
local/remote receipts. The local capability/status view retains those patterns
without importing T3's source or Effect runtime.

The pinned presentation helper can render catalog URLs and SSH identities in
its human-readable output. Control Room must retain opaque worker labels and
safe reason codes instead. T3's compatibility fallback to protocol version one
is also unsuitable here: a Control Room adapter version must be explicitly
registered and an unknown version must remain unavailable.

Do **not** adopt T3's connection supervisor, provider connection catalog,
credential/profile stores, relay, RPC session ownership, event model, native
helper programs or Codex App Server client. They are tightly coupled to T3's
Effect runtime and would compete with Control Room's worker identity, review,
recovery and private configuration boundaries.

**Future extraction gate:** if a concrete reconnect/status component remains
missing after the local agent screens are wired to real records, compare only
the exact presentation function against the existing Control Room view. Adopt
only if it removes more code than its dependency/attribution cost.

## What Hermes WebUI and Desktop contribute

Hermes WebUI's session-event code uses a bounded, coalescing browser-refresh
signal: when scope differs, it falls back to a refresh that cannot silently
drop a relevant update. Its recovery code separates a deliberate transcript
shrink from suspected loss and uses an atomic replacement only after checking
the saved state.

These are good *behavioral tests* for Control Room's future progress and
result-refresh views. They do not replace the canonical delivery receipt,
durable result receipt, or review history. Control Room already refuses to
treat a browser reconnect as a task retry.

Hermes Desktop demonstrates useful visual ideas—separate active-session,
connection and model/capability indicators—but its Electron process, IPC,
secret storage, remote SSH setup, session database, provider/model management
and dashboard state are outside the narrow browser/adapter boundary. Importing
them would expose or duplicate private configuration.

The reviewed Desktop approval card also keeps a failed submission visible and
prevents a second click while one is in progress. That is a good local UI
behavior. Its broad "always" approval choice is not: Control Room approvals
must remain bounded to the declared task and effect. Hermes WebUI's state
session observer likewise falls back from a failed read-only SQLite open to a
writable connection; that fallback must not be copied or used as Control Room
task authority.

**Decision:** do not copy either whole UI. Re-evaluate one pinned, dependency-
light visual component only if a specific Control Room screen cannot be built
from its existing React panels.

## Remaining custom code is legitimate connecting code

The donors do not solve these product-specific requirements:

1. Bind a Control Room-approved task, lease, worker version and review policy to
   one harness invocation.
2. Keep executable/profile/model/workspace settings private and out of browser
   data and canonical records.
3. Prevent a lost response or restart from launching a second task.
4. Bind bounded result bytes and optional diff evidence to the original task
   before owner review.
5. Make different harness capabilities truthful instead of presenting generic
   chat/session controls as task authority.

Those narrow contracts are why Control Room retains custom Hermes, Claude and
Codex adapter glue. They are not replacements for a generic agent framework.

The fresh first-owner path is likewise intentionally retained Control Room
code: the existing `private-owner-bootstrap`, `SecurityStore`, PostgreSQL
transaction and role/preflight work already supply its required pieces. A
general setup wizard or identity package would add a competing login, tenancy
or permission model at the exact point where Control Room must establish its
single owner. The small addition creates only the reviewed tenant and workspace
inside the already guarded one-owner transaction; it does not add a donor,
dependency, scheduler, database, credential store, or authority path.

The remote-session bridge is also deliberately thin Control Room glue. It
accepts only an already-authenticated selected session and forwards the
existing immutable delivery packet. Whole remote-control donors would own
connection creation, credentials, lifecycle, retries or a second session
history—each conflicts with the existing enrollment, receipt and review
contracts. The bridge therefore borrows no external code and adds none of
those responsibilities.

## Next donor decisions

- **Hermes:** finish the existing local CLI adapter first. Evaluate no second
  Hermes transport unless it eliminates a proven gap without adding another
  task authority.
- **Claude:** use the existing stream decoder and result bridge. A real process
  host requires the reviewed approval, workspace, cleanup and credential
  decisions; no donor eliminates those gates.
- **Codex:** use the existing App Server contract. T3's stdio helper does not
  solve the Mac-specific private-home custody requirement.
- **UI:** use Control Room's React panels and capability view. Add a narrow
  donor component only after a file-level extraction, dependency-license review
  and disposable fit test under REUSE_DECISION_GATE.md.
