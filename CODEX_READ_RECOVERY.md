# Exact-ID Codex read recovery

Status: exact selected-package schema is generated, sanitized and bound to the
bounded response projection. The one-shot JSONL profile, owned connection lifecycle,
effect-free start-admission contract and signed delivery/owner-permit intake contract
are implemented; native transport/session wiring, durable identity storage, physical restart read, runtime
reconciliation and host qualification are not implemented or accepted.

Exact-package schema evidence was generated from `@openai/codex@0.150.0-alpha.8`
without experimental methods. The retained evidence records the package/platform
versions, generated v2 bundle byte count and SHA-256, and only the `thread/read`
shape used here. The full generated bundle and temporary package were not retained.
`schema-contract.ts` binds the adapter to that evidence, and the focused suite fails
if the package pin, digest, method, required projection fields or statuses drift.
This evidence made no provider call and does not claim an actual read or restart.

`owned-read.ts` now composes the profile with a caller-owned connection attempt.
It reuses the owned-signing acquisition pattern: synchronous ownership before
readiness, one attempt, total operation deadline, cancellation and a separate
bounded cleanup wait. It rechecks the caller's synchronous admission callback
around waits and after cleanup. Failed or unfinished cleanup withholds the result.
No default native connection, endpoint, credentials or authority implementation
is supplied. The connector contract requires closing eventual readiness and I/O;
fake close callbacks cannot prove that a physical connection met that contract.

Official interface checked 2026-09-09:
[App Server stored thread read](https://learn.chatgpt.com/docs/app-server).
`thread/read` with `includeTurns: true` reads stored turns without resuming or
subscribing. It is distinct from resuming a thread and starting a new turn.
Version-specific protocol compatibility is pinned for this narrow generated-schema
contract. Native process and restart behavior still require separate qualification.

`src/harness/codex-v1/read-recovery.ts` creates a fixed read request for a previously
known thread and projects only its exact known turn status. It rejects foreign
thread IDs, duplicate turn IDs, missing turns, unrecognized statuses and oversized
responses. Absent exact turns remain `not_observed`, not failed or completed.
Transcript items, paths and token metadata are not returned. Usage remains unknown;
a stored completed status is not verified completion or verified cleanup.

This is the Control Room-specific identity/minimization adapter. The separate
`read-jsonl.ts` profile adapts the existing Control Room JSONL correlation pattern
with fixed initialization and a single thread/read request. It exposes no generic
request method, rejects server requests, correlates IDs, bounds frames/ignored
notifications and becomes unusable after an error or disconnect. It is not a
socket, process launcher or full JSON-RPC library. The narrower profile avoids
exporting qualification/broker authority just to inspect stored state. Reuse the
evaluated bounded transport when composing it. Do not widen the existing qualification
controller's method allowlist or use its resume operation for this purpose.

Remaining integration:

### Durable identity prerequisite — source inspection

The generic node restart inventory currently retains task, attempt, lease, run and
delivery identities, not an exact Codex thread/turn pair. A native session digest
cannot be reversed into those IDs. The earlier Codex broker stores a thread ID
for completed calls but quarantines threads and clears raw IDs for ambiguous
calls/restart recovery. Its turn observer holds the turn ID in memory. That broker
is therefore not an existing durable exact-turn recovery source. Do not change its
quarantine behavior or use its completed-call resume resolver as read permission.

Implementation order before runtime wiring:

The current `harness.native.dispatch` contract is specifically Hermes: its schema
requires `harness.hermes.native.start` and the Hermes enrollment/start contracts.
It must not be relabeled as Codex evidence. Before the journal extension, settle
the Codex start-receipt binding to its actual admitted broker ticket/permit and
run, or implement a separately reviewed Codex delivery contract. A generic lease
receipt proves historical lease intake, not permission for either harness to run.
The journal's existing accepted-command lookup may be reused to cross-check lease
identity, but cannot substitute for Codex-specific signed delivery and current
admission evidence.

`src/harness/codex-v1/admission-contract.ts` now defines the non-I/O portion of
that binding. It binds the exact tenant, node, project, job, attempt, run, lease,
input, enrollment, delivery, permit, current-admission and pinned adapter identity.
Its response dispatcher claims one verified initialized-connection identity for
the process lifetime, allows only one outstanding request, never reuses a JSON-RPC
id on that connection, and consumes failed response attempts without retry. It accepts a thread or turn
identifier only from that dispatcher's matching JSON-RPC result id,
requires a persistent root thread and an initially `inProgress` turn, and retains
only response digests rather than response content. OpenAI's App Server contract
documents that `thread/start` returns a `thread`, while `turn/start` returns the
initial `turn`; event notifications are separate and are never accepted here:
[Codex App Server](https://learn.chatgpt.com/docs/app-server).

The start shapes are also pinned to sanitized hashes and required-field facts
generated from the exact selected package; the full schemas and temporary package
are not retained. Every product-facing capability on these records is deliberately false. A turn
receipt proves only that the exact start request received a correlated initial
response. It is not permission to start, retry, resume or read, and it cannot mark
canonical work complete. Its ordinary SHA-256 digests detect accidental or
conflicting changes but are not authentication.

`src/harness/codex-v1/delivery-contract.ts` now carries the authenticated handoff
through the existing signed node protocol as `harness.codex.dispatch`. It reuses
the node signature and pinned owner-approval trust while binding the exact prompt,
workspace intent, connector profile, enrollment, lease, deadline and machine.
It creates no second queue, signer or transport. `approval-intake.ts` verifies the
owner signature and current trust revision, but grants no execution, retry or
resume authority. The start contract may be constructed only after the outer frame,
recorded delivery, verified permit, pinned enrollment and current local admission
are all available, then protected by the node-owned journal.

The existing SQLite journal uses full-synchronous WAL and transactions, but its
ordinary payload digests are integrity consistency checks, not authentication
against a writer that can replace both payload and digest. Preserve protected
node-storage assumptions and reverify original signed authority at admission.
Do not advertise this extension as an authenticated restart source merely because
it survives reopen. Production binding acceptance requires an independent review
of the retained signed evidence and current verification path.

1. The signed Codex frame now uses a negotiated one-shot server-session sender and
   the existing node bridge intake. The server signs once, requires its caller to
   save transmission intent before its only send, and accepts only the exact signed
   receipt. The next server composition must persist that Codex envelope, intent and
   receipt against the canonical queue/lease so a replacement connection cannot
   create a second send slot. Current local policy remains mandatory before start.
   Do not expose these constructors to browser input, reuse an initialized-connection
   identity, or treat a contract digest as a signature.
2. `src/harness/codex-v1/start-journal.ts` now provides the protected,
   observation-only SQLite record for the exact correlated receipt pair. It binds
   tenant/project/node/job/attempt/run, accepted delivery, connection attempt and
   pinned enrollment; refuses altered schemas or records; and exposes no browser,
   queue, retry, resume or read-permission surface.
3. The journal requires the thread receipt to be durable before accepting its turn
   receipt. A reopen after only the thread write returns `turn_not_recorded` with
   no read identity. It never lists/searches, selects a latest turn, replays a
   dispatch or infers a turn ID. Runtime composition must preserve this write order.
4. Keep observation retention distinct from execution/resume authority. Retaining
   identifiers for a separately authorized read must not reactivate a quarantined
   broker grant. Define retention and deletion with the protected journal owner.
5. Revalidate authenticated delivery, enrollment and current read permission before
   acquisition and through cleanup. Historical integrity alone is insufficient.
6. Compose the existing owned read profile with that exact retained identity and
   an independently qualified transport. Preserve the canonical result/event path:
   a stored status cannot settle work, invent usage or release capacity.

Required regression evidence: reopen the journal and recover only its exact pair;
reject cross-project/node/run bindings, changed enrollment and conflicting second
bindings; interrupt between thread/turn acknowledgement and each durable write;
withhold read on absent turn identity; revoke read permission during acquisition,
I/O and cleanup; show that observing a completed turn does not settle the task.
Use generated fixture data first. Physical crash/native acceptance stays gated.

### Transport and reconciliation gates

- Bind tenant/project/node/run and existing thread/turn IDs to current authenticated
  admission before acquiring a connection; unknown identity cannot use list/search
  to guess its way into another task.
- Pin supported app-server version and a separate initialized read-only session;
  enforce request-ID correlation, frame limits, cancellation and connection cleanup.
- Feed only the correlated result value to the projection, never arbitrary server
  notifications or an uncorrelated caller-supplied snapshot.
- Reconcile with canonical durable events/results without inventing missing usage,
  replaying execution, releasing capacity or claiming completion from this snapshot.
- Qualify disconnect, server restart, lost read acknowledgement and duplicate read
  using disposable data under explicit host scope. No automated native retry is
  authorized by this module.

Independent re-review of `798b38a` confirmed the reentrant cancellation correction
and passed all 10 then-current recovery checks. A subsequent lifecycle regression
adds scripted disconnect/lost acknowledgement, unexpected restart response ID and
duplicate initialization acknowledgement: each closes its one owned attempt,
returns no observation and refuses reuse. These are protocol simulations, not an
actual server restart or physical connection retirement. The focused suite now
passes 11 tests.

Run `pnpm test:codex-recovery` for the effect-free
projection and protocol checks. No credentials, native app-server process or provider call is
used by those tests. A separate owner-attended qualification stays separate.
