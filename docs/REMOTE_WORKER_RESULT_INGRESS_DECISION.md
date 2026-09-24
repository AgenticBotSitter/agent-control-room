# Remote worker result ingress decision

**Status:** accepted source boundary for the several-computers build,
2026-09-24. It is not a live worker, transport, service, database migration,
or permission to run a task.

## The problem being solved

The shared remote-delivery path already sends one saved task packet to one
enrolled worker and saves its delivery receipt in the authoritative PostgreSQL
database. It deliberately stops there. A worker cannot yet return progress or
a final result through that same path, which means a remote result cannot
truthfully appear in the normal owner review screen.

## Decision

Add one **receipt-bound remote result ingress** to the existing signed-node
connection. It is responsible only for receiving bounded progress or terminal
result evidence for the exact delivery that was already recorded. It must:

1. Bind every message to the saved delivery ID and digest, project, task,
   attempt, node, worker, enrollment, and current connection generation.
2. Re-read the existing canonical delivery receipt and enrollment/key state in
   PostgreSQL before accepting data. A disconnected, replaced, rotated,
   drained, quarantined, revoked, wrong-worker, expired, copied, or malformed
   message is refused.
3. Preserve ordering and replay rules: progress cannot move backwards or jump
   past a saved terminal record; an exact terminal replay returns the original
   saved receipt; uncertainty never creates a replacement task, result, or
   provider/workspace run.
4. Use the existing harness-neutral durable result publication and normal
   pending-owner-review flow once its existing binding requirements are met.
   The remote worker never decides that work is accepted, complete, approved,
   or capacity-releasing.

## Reuse, rather than rebuild

| Need | Existing Control Room component to retain |
| --- | --- |
| One saved packet and reconnect-safe receipt | `remote-controller-worker-materializer.ts` and its PostgreSQL receipt store |
| Enrolled-worker/key/revocation decision | `remote-worker-enrollment-store.ts` and the private remote composition |
| Signed connection and replay/session checks | `ServerNodeSession` and negotiated node protocol |
| Exactly-once saved bytes and owner review target | `artifacts/v1/durable-result-publication.ts` |
| Browser result/review/correction display | Existing canonical task result, attention, review, and correction readers |

The earlier `remote-artifact-return.ts` remains only a bounded-byte and digest
validation reference: its SSH/sandbox transport records do not become a second
result store or authority.

## Explicit non-goals

This package does not add a message broker, an outbox, another queue,
another database, a remote scheduler, a second result store, remote approval,
or a generic agent framework. It does not start a worker, contact a network,
inspect credentials, expose a port, or allow a browser to submit a raw result.

## Build sequence and acceptance evidence

1. Add strict signed message definitions for remote progress and terminal
   return, with fixed size and type ceilings.
2. Add a `ServerNodeSession` receive seam that becomes available only after the
   exact delivery receipt is recorded; it must remain separate from native and
   Codex-specific frame paths.
3. Add one private installed-composition ingress that captures the exact
   controller materialization reference and rechecks current canonical state.
4. Reuse the durable publisher only after all its current binding requirements
   are represented; otherwise retain a terminal record as unresolved evidence
   and record the specific missing binding rather than inventing authority.
5. Prove, with disposable tests: intended-worker acceptance; wrong worker/key/
   connection/delivery refusal; duplicate and out-of-order progress refusal;
   terminal exact replay; restart/reconnect recovery without resend or rerun;
   and revocation before publication.

No claim of a working remote worker is valid until the protected installed
worker composition is mounted and the controlled two-node proof succeeds.
