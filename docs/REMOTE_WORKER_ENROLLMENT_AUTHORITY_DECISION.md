# Remote worker enrollment authority decision

**Status:** accepted source-design boundary, September 24, 2026

## Plain-English decision

A remote worker may not become trusted merely because a machine and one of its
keys are active.  The database must also contain a durable record saying that
the **specific worker**, its adapter version, capabilities, and enrollment
digest belong to that machine.  Otherwise a caller could combine a valid
machine/key with a made-up worker description.

The current `control_nodes` and `control_node_keys` records are still reused
for the machine and key.  They are necessary, but not enough on their own.

## What was checked

The existing `control_connection_enrollments` append-only registry was
considered before proposing a new record.  It is intentionally a Hermes 0.21
connection record.  Its signed payload has a connection identity, route and
profile digests, expiry, and result digest.  It has no stable Control Room
worker ID, adapter ID/revision, capability list, remote-worker enrollment
digest, or revocation state.  Reinterpreting it would make the two contracts
ambiguous and would make a future non-Hermes worker depend on Hermes-specific
data.  It must not be reused as remote-worker authority.

## Smallest correct next package

Add one canonical, database-owned remote-worker enrollment projection.  It is
not a queue, transport, scheduler, second database, or browser-visible secret
store.  Each row must bind:

- tenant and node IDs, and the currently accepted node key ID;
- worker ID, adapter ID, adapter revision, and capability digest;
- the existing safe `RemoteWorkerEnrollmentV1` digest and its enrollment ID;
- immutable enrollment time; and
- one explicit state: enrolled, draining, quarantined, or revoked.

The record must be created and changed through a narrow canonical service that
locks the node and current enrollment, rejects changed replay material, and
writes an audit receipt.  A delivery composition must reread that record plus
the existing node/key state immediately before prepare, send, receipt intake,
and recovery.  A revoked, quarantined, draining, expired, rotated, or changed
record refuses rather than silently rerouting or retrying.

## Why this is deliberately separate

The public `RemoteWorkerEnrollmentV1` value remains a safe planning and
delivery envelope.  It is not itself proof that the installation accepted the
worker.  The new database record is the missing bridge from that envelope to
canonical authority.  This lets local and several-computer installations use
the same delivery contract without inventing a second controller or database.

## Proof required before it is called complete

Disposable PostgreSQL tests must prove exact replay, altered enrollment
refusal, worker/node/key substitution refusal, adapter/capability mismatch,
drain/quarantine/revocation, reconnect reread, key rotation, restart over the
same database, and concurrent enrollment attempts.  Browser data may show a
redacted status only; it may not disclose addresses, accounts, key material,
or provider configuration.

No database was created, migrated, queried live, or exposed for this decision.
