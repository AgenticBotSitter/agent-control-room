# Trusted Linux worker state process: implementation contract

Status: selected qualification contract for LCOI-1 candidate 1, 2026-09-24.
**Not implemented, installed, qualified, or permission to start an agent.**
Candidate 1—the systemd-managed trusted Node custodian with a distinct,
untrusted execution identity—is the sole approach selected for the next
disposable Linux qualification. The existing Linux installed-state owner
continues to refuse. This does not certify the mechanism or supersede the
accepted custody requirement: implementation, Linux evidence, and independent
security review remain required before any worker can be called live.

## Chosen composition and scope

Keep the existing bridge, signing keys, security stores, approval pins, start
and result journals, and admission/session owners together in one trusted
worker process. Put Codex and its task subprocesses under a different operating
system identity. PostgreSQL remains the one controller authority. These worker
SQLite files retain their existing recovery/security roles and schemas.

This avoids a remote procedure interface for individual SQLite operations.
The concrete journal methods are synchronous and participate in existing
ordered checks and transactions. Replacing them with asynchronous cross-process
proxies would change their semantics and expand this package unnecessarily.
The trusted process must not load agent plugins or run arbitrary workspace
commands as its own identity.

The composition is independent of whether the controller is on this computer
or another computer. Both use the same enrolled, authenticated node protocol
and canonical project/task lifecycle. Network location grants no authority.
The Linux supervisor and execution-identity adapter are platform implementations,
not a new scheduler, database, permission system or agent framework.

## Reuse and remaining adapter

| Responsibility | Existing implementation retained |
| --- | --- |
| Durable messages, receipts, replay and workspace records | `src/node-bridge/journal.ts`, `SqliteBridgeJournal` |
| Distinct trust artifacts and rollback high-water state | `src/node-policy/v1/persistent-security-state.ts` |
| Owner approval pins and encrypted node signing key | `pinned-approval-trust.ts`, `private-key-store-factory.ts`, `encrypted-file-key-store.ts` in `src/node-policy/v1/` |
| Start reservation, thread/turn receipts, recovery | `src/harness/codex-v1/start-journal.ts`, `local-host.ts` |
| Admission exchange and one-use session capability | `src/node-bridge/private-codex-installed-node-entry.ts`, `private-codex-current-admission-read.ts`, `private-codex-session-owner.ts` |
| Verified controller messages and result return | `PortableNodeBridge` and existing signed Codex result/receipt contracts |
| Bounded application-server process protocol | `src/harness/codex-v1/app-server-process-session.ts` and existing Codex native-process acquisition contract |

The missing adapter must acquire the reviewed Codex executable under the
separate execution identity and return only the existing bounded process
transport/cleanup interface to the trusted process. A narrowly scoped,
release-bound supervisor/launcher owns the identity transition; neither Codex
nor the general Node custodian receives a generic privileged launch interface.
The current acquisition implementation is not evidence that privilege
separation exists. A generic `spawn(command, args, env, cwd, uid)` endpoint is
prohibited. Workspaces and agent authentication stay with the execution
identity; node signing keys, owner pins, and worker journals stay with the
custodian.

## Installation and channel binding

The future verified installation owner must capture these bindings from
protected installation state, never from model output or an HTTP request:

- Installation ID, exact release digest, configuration digest, and supported
  protocol/schema versions.
- Tenant, node ID, node class, enrollment digest, connector-profile digest,
  and signing-key reference.
- Protected owner-pin digest and separate unwrap-source identity; the
  encrypted envelope alone is not authority to unlock itself.
- Exact designated bridge, start/result and two distinct security-store
  identities, their common protected storage domain, and approved workspace
  intent/root binding. Bind concrete store identities in addition to filenames.
- Custodian identity, execution identity, reviewed launch-policy digest, and
  supervisor-owned channel identity. Identity equality must be refused. The
  qualification must also bind effective groups, relevant ACLs and
  capabilities, and prove that no state descriptor or privilege survives an
  execution-identity handoff or a later service restart.

Keep these values private. Emit only existing redacted diagnostics publicly.
An identity or matching digest sent over a pipe is a comparison value, not proof
of provenance. The trusted launcher must establish the channel and authenticate
both endpoints using reviewed OS mechanisms. Untrusted callers cannot provide
their own socket, verifier callback, descriptor number, or `verified` flag.

Each custodian start gets a fresh boot/session binding from the trusted owner.
Each execution channel is bound once to that boot, the installed release, the
exact queue/run/attempt, activation/admission digests, enrollment, workspace
intent, connection-attempt ID and initialized-connection digest. A channel for
one run cannot submit another run's observations. A reconnect receives a new
channel identity and must reconcile existing records; it cannot revive an old
in-memory capability.

The implementation must retain existing object capabilities inside the trusted
process. Their WeakMap brands cannot be serialized into authority tokens. A
copy of an entry/session object, even with identical fields, remains invalid.

## Allowed communication

1. Controller traffic uses existing negotiated signed-node frames and existing
   replay, deadline, trust, enrollment and admission checks. Transport receipt
   is not permission to run a task. Reuse the bridge's durable reservation
   before send and exact response correlation.
2. Trusted lifecycle control may initialize, drain and close the one installed
   composition through its private launcher channel. These operations select
   no files or credentials and accept no executable arguments or SQL. Startup
   chooses the previously verified installation, not a caller-selected path.
3. The execution channel carries only the existing bounded Codex application-
   server exchange for the admitted run, and its terminal/cleanup observation.
   Every observation is untrusted until parsed and matched by the existing
   host. Arbitrary JSON-RPC methods, unbounded streams and arbitrary signing
   requests must not become reachable through this channel.

Apply existing size, request, time and queue ceilings at the corresponding
protocol boundaries. Any new outer framing must have an explicit fixed byte
ceiling, bounded allocation, strict version/type allowlist and a single owner
before implementation acceptance; this document does not authorize a generic
payload or extension field. Return fixed safe failure codes, never raw paths,
key bytes, database contents or provider output in transport diagnostics.

## One-use, restart and cleanup behavior

Reserve the existing start/admission operation durably before crossing the
execution boundary. Burn a one-use capability before calling the external
process. A timeout, lost reply, transport close or exception is uncertainty,
not permission to send again. Preserve existing journal receipts and recovery
rules: after restart, reconcile the recorded thread/turn and return the already
recorded result when permitted; never create a replacement turn merely because
an in-memory set was lost. A reservation without a proven outcome remains
blocked for reconciliation.

No independent cache or sequence store is added. If an existing journal cannot
represent a required restart fence, extend that journal's reviewed reservation
contract before enabling the new adapter. Do not assert restart safety using
only a boot nonce or a process-local set.

On revocation or changed admission/trust, refuse further starts and follow the
existing bounded cancellation/cleanup policy. Drain stops new admissions. Close
the process transport/owned execution, then lock and dispose signing-key
custody and close owned stores in their reviewed reverse-acquisition order.
Partial acquisition closes only resources actually acquired. Cleanup failure
preserves recovery state and prevents readiness; it must not delete journals
or silently normalize permissions. Shutdown alone is not proof the child died.

## Required isolation decision and Linux qualification

The selected qualification target trusts the kernel, system supervisor,
administrator and the reviewed custodian code. It must contain hostile task
processes, including arbitrary code under the execution identity. It does not
claim to contain arbitrary code already running as the custodian or root. This
selects the boundary to test; it does not replace the current owner refusal.

Directory isolation must hold through initial validation, all main/WAL/SHM/
rollback-journal I/O, close, downtime and restart. Legitimate SQLite sidecar
recreation within that continuously protected domain is permitted only by the
reviewed lifecycle; this is not an invariant that every sidecar inode stays
fixed forever. Check protected ancestors and deployment inputs before allowing
a supervisor to create or change ownership of state. No network-shared SQLite
state.

Pin the Linux/supervisor, Node/SQLite, release and launch-adapter versions in a
qualification artifact. On disposable Linux state prove:

- Hostile task identity cannot replace ancestors/files/sidecars, change modes,
  attach hard links, inspect custodian memory, inherit state descriptors, alter
  launch configuration or impersonate the private launcher channel. Tests must
  cover supplementary groups, ACLs, capabilities, service-manager overrides,
  and stop/restart identity reuse—not just unequal user IDs.
- Wrong installation, release, enrollment, profile, key, workspace, peer,
  channel/run and boot bindings fail before protected I/O or execution.
- Concurrent duplicate activation, lost response, crash after reservation,
  restart, replay from an old channel and revoked admission cause at most one
  start and retain accurate uncertainty. Recovered evidence is not a new permit.
- Real SQLite checkpoint/recovery and sidecar recreation work; replacement
  attacks are prevented before redirected reads/writes, not just noticed later.
- Interrupted open, locked/wrong keys, disk-full and failed cleanup preserve
  state and fail readiness. No state/key descriptors or credentials reach Codex.

The existing topology-neutral lifecycle tests are necessary but cannot prove
these Linux properties. Until this qualification and independent review pass,
LCOI-1 remains unavailable, and neither setup choice may label this worker live.

## Why no new executable schema in this package

Existing signed-frame, activation, session and journal schemas remain the
contracts to reuse. The unresolved work is OS provenance and isolated execution,
not JSON shape. A new structural `trusted: true` schema or pure validator would
not verify it. This package therefore specifies the implementation boundary
without adding another capability minter or a generic RPC protocol. It makes
no service, filesystem, database, credential, process or network changes.
