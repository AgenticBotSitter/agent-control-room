# CR-4B transaction and delivery design

**Status:** Implemented

**Boundary:** Persistence, optimistic concurrency, leases, durable messages, and idempotency. Identity, authorization, policy evaluation, approval authenticity, digest calculation/verification, and generalized redaction arrive in CR-4C.

## Storage model

CR-4B uses normalized PostgreSQL tables for all 13 CR-4A durable entity types. Each table stores:

- indexed identity, tenant, lifecycle state, version, lineage, and scheduler fields;
- the complete validated versioned JSON payload;
- created and updated timestamps.

Payload-mirror triggers reject a write when payload ID, tenant, state, or version differs from its indexed columns. Relational foreign keys include `tenant_id`, preventing an entity in one tenant from citing lineage in another even when an ID is known.

## Mutation contract

Every ordinary transition:

1. checks for an earlier transition with the same idempotency key;
2. locks the current row;
3. compares expected version and current state;
4. checks the CR-4A transition table and available edge guards;
5. validates an allowlisted transition metadata patch;
6. increments version exactly once;
7. writes the entity, immutable transition event, and outbox event in one transaction.

Attempts, leases, and cross-record job edges cannot use the public generic transition method. They require a coordinated repository operation so a caller cannot put a job in `leased` without an attempt and active lease.

Creation is restricted to each entity's defined initial state. Jobs insert their dependency rows transactionally; dependencies must already exist, encouraging topological workflow compilation.

## Lease transaction

`claimReadyJob` locks the ready job and active node, allocates the next attempt number and lease epoch, creates the offered attempt, transitions it to leased, creates the active lease, and transitions the job to leased atomically. A partial unique index permits only one active lease per job.

Renewal requires the current version and epoch, occurs before expiry, and must extend the expiry. Expiry verifies lineage/epoch, expires the lease, orphans the attempt, and either re-readies a not-yet-started job or orphans running work in one transaction. A later claim receives the next attempt number and epoch.

## Inbox and idempotency

Inbox identity is `(tenant, protocol, message_id)`. Repeating the same body digest is a replay; reusing the ID with another digest fails. The handler and processed marker share a transaction, so a process/transaction failure returns the message to its prior durable state.

`executeIdempotent` binds `(tenant, operation scope, key)` to a request digest and durable result. Same-key/same-digest replays return the stored result. A different digest fails. The callback must contain database work only; external effects must be represented by an effect intent and outbox message.

## Outbox

Claims use row locking with `SKIP LOCKED`, a claim token, attempt counter, availability timestamp, and batch limit. Only the matching token may acknowledge or fail a claim. Failed messages respect their next availability time. A recovery operation requeues abandoned processing claims. Exceeding the configured maximum attempts produces `dead_letter`, which is not automatically reclaimed.

Delivery is at least once. Destination idempotency or later effect reconciliation handles acknowledgement loss; Control Room does not claim exactly-once delivery across external systems.

## Remaining phase gates

- CR-4C decides whether an actor may call any repository operation and verifies approval/digest/redaction boundaries.
- CR-4D adds the audit hash chain and production-safe operational error taxonomy.
- CR-5 exercises the same contracts over a disposable remote node and production-shaped PostgreSQL environment.
- No CR-4B repository is exposed as an unauthenticated route.
