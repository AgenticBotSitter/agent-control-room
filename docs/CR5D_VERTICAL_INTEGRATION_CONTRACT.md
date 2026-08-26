# CR-5D admitted synthetic execution and storage contract

**Status:** Architect-frozen for CR5D-INT-001, CR5D-INT-002, and CR5D-STOR-001
**Decision date:** 2026-08-26  
**Scope:** Effect-free coordination of an already-admitted synthetic execution and bounded in-memory artifact storage  
**Authority:** This contract does not authorize a live node, filesystem/object-store write, credential, deployment, external effect, or production mutation.

## Required boundary

The coordinator may run only when a durable `ExecutionAuthoritySnapshotV1` already exists in state `admitted`. The snapshot tenant, node, project, job, attempt, lease epoch, and operation digest must exactly match the requested synthetic execution. The operation digest is the repository canonical digest of the complete synthetic specification. A mismatch fails before starting the executor or storing an artifact.

The coordinator:

- records the authority `start` transition before emitting the job `started` event;
- checks the durable authority state, effective deadline, and typed cancellation request before start, before each injected sleep, immediately after each injected sleep, and before publishing completion;
- persists deadline crossing or cancellation request before aborting the executor;
- maps lifecycle events to `JobEventBody` under the exact job, attempt, lease, and lease epoch;
- records authority terminal state before publishing the matching terminal event;
- emits exactly one terminal `completed`, `failed`, or `cancelled` event;
- exposes an artifact manifest ID only on a successful terminal event after bytes were stored and independently re-hashed;
- returns fixed safe failure codes and never exposes raw injected error text; and
- never treats the producer verification claim as an independent verification result.

An execution already in progress after restart is not silently resumed by this coordinator. The existing durable recovery classifier remains controlling and requests cancellation for an unresolved in-flight execution.

## Durable event delivery

Every lifecycle event is first appended to the node-local SQLite journal in the same transaction that advances its attempt and checkpoint projection. The journal accepts an exact duplicate as idempotent, rejects conflicting content at the same attempt sequence, rejects a changed job/lease/epoch identity, and rejects events after a terminal outcome.

A pending event is atomically linked to one signed `job.event` outbox frame before transport. Transport success alone does not retire it. Only an authenticated protocol acknowledgement moves both the outbox frame and linked event to acknowledged. An unexpired unacknowledged frame is resent after reconciliation with its original signed identity. An expired frame returns the event to the pending queue and the next delivery attempt receives a new signed message ID. This is at-least-once delivery with idempotent event identity; it is not exactly-once execution or exactly-once transport.

The reconciliation report is built from the same durable attempt projection. Pending lifecycle delivery starts only after connection authentication and reconciliation complete. Signing failure cannot consume a sequence or alter the event record, and transport failure leaves the signed frame durable.

## Storage port

The storage port accepts an artifact ID and immutable bytes and returns an opaque locator, exact byte count, and SHA-256 content hash. Reusing an artifact ID with identical bytes is idempotent. Reusing it with different bytes is a conflict. Capacity is bounded by configured artifact count and total bytes.

The first adapter is memory-only and test-safe. It clones bytes on write and read, performs no filesystem, network, environment, credential, timer, subprocess, platform, or persistent-state operation, and uses only `memory://artifact/<encoded-id>` locators. A filesystem or object adapter requires a separate containment, atomicity, ambiguity, cleanup, and owner-authority contract.

## Acceptance

- Exact admitted operation completes with ordered protocol events, stored bytes, manifest, and separate producer claim.
- Operation, identity, lease, or admission-state mismatch fails before execution.
- Server/operator cancellation and exact deadline crossing produce one durable cancelled outcome and no published artifact.
- Executor crash and storage failure produce one fixed-code failed outcome.
- Storage idempotency, conflict, capacity, byte cloning, and hash checks are deterministic.
- Restart classification remains conservative and never claims exactly-once execution.
- Lifecycle records, attempt/checkpoint projections, signed outbox linkage, acknowledgement, expiry, and retry survive a local bridge restart.
- Focused tests, TypeScript, ESLint, full tests, and rendered build pass.
