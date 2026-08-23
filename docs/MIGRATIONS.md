# PostgreSQL migrations

## 0001 — core projections

Creates tenants, workspaces, adapter registry, projects, work items, executions, blockers, attention items, machines, workers, agents, capabilities, routes, cursors, projection changes, command receipts, and audit events. Tenant/workspace keys scope projected data.

## 0002 — allocation and simulation

Adds allocation policies, benchmark runs, simulator runs, and recommendations. Append-only triggers protect audit events, projection changes, and command receipts from update or deletion.

## 0003 — canonical domain and durable delivery

Adds normalized canonical records for nodes, requests, workflows, jobs, attempts, leases, checkpoints, approvals, effect intents, services, schedules, incidents, and artifact manifests. Adds tenant-bound composite lineage, job dependencies, one-active-lease and monotonic-epoch constraints, append-only transition events, inbox/outbox, idempotency records, claim recovery, and dead-letter status.

Payload-mirror triggers ensure the indexed ID, tenant, state, and version cannot disagree with the versioned JSON record. Cross-record operations remain repository transactions; direct SQL state changes fail the mirror trigger and are unsupported.

`pnpm db:verify` applies all migrations to an isolated PostgreSQL-compatible PGlite database and checks the expected table set. A disposable real-PostgreSQL rehearsal remains mandatory before any live deployment.

## 0004 — CR-4B review hardening

Applies the accepted findings from the two independent CR-4B qualification reviews:

- tenant-prefixes attempt, lease, checkpoint, and worker-machine lineage constraints;
- validates the canonical `sha256:` representation at the database boundary;
- expands payload-mirror checks to indexed lineage, scheduler, approval, and effect fields;
- rejects impossible canonical timestamp order;
- prevents duplicate live approvals for one operation digest and reuse of one approval by multiple effect intents;
- blocks `TRUNCATE` of transition history in addition to row mutation.

The approval indexes are structural backstops, not the authorization decision. CR-4C must still validate actor, scope, digest, expiry, revocation, and single-use consumption in the transaction that authorizes the effect.

## Transactional-by-design invariants

These rules intentionally live in repository transactions rather than SQL triggers:

1. `CanonicalStore.claimReadyJob` locks the job before allocating a monotonic attempt number and lease epoch; the partial unique active-lease index is the backstop.
2. Workflow compilation must supply a pre-existing acyclic dependency graph. `proposed → ready` checks that every dependency succeeded, but the database does not attempt recursive cycle detection on each write.
3. `CanonicalStore.renewLease` and `expireLease` reject stale epochs and versions while holding the relevant transaction boundary.
4. `CanonicalStore.create` locks the attempt before accepting a checkpoint sequence greater than its durable maximum.
5. CR-4C's effect authorization transaction will require an unexpired, unrevoked approval with an exact matching operation digest and atomically bind/consume it.

## Delivery operating contract

- Inbox handler work and the processed marker share one transaction. A failed handler rolls back completely; a second transaction increments the durable failure count and parks the message after the configured maximum. Re-entry requires an explicit future operator recovery action.
- Outbox claim tokens are unique per dispatcher claim batch. Callers must use unpredictable UUID-class values and never reuse a token for independent concurrent batches.
- Retry/backoff timing is computed by the scheduler; the store enforces the supplied `available_at` time.
- Consumers must deduplicate on `(tenant_id, topic, idempotency_key)` and use aggregate versions to reject or reorder stale delivery. Outbox delivery is at least once.
- `processed`, `delivered`, and completed idempotency payloads need a bounded batched-retention policy before production. Idempotency tombstones must outlive their payloads and the maximum replay window. Exact durations remain an owner-configurable operations setting.

## Namespace and runner decisions

Canonical `project_id` values are native domain identifiers, while the original `projects` table is an adapter projection. They are intentionally not foreign-keyed until an adapter explicitly maps those namespaces.

Migrations have one authorized runner. Re-runnable trigger DDL supports isolated verification, but concurrent migration runners are unsupported.

## 0005 — CR-4C identity and policy

Adds tenant-bound application identities, scoped/expiring/revocable role grants, append-only policy decisions, and append-only single-use approval consumption. Raw authentication subjects are represented only by canonical digests.

Production database privileges are deliberately separate from schema migration. After migrations, the database owner applies `db/roles/production_roles.sql` and grants deployment-specific login roles membership in exactly one NOLOGIN group role. This role script must be rehearsed on disposable real PostgreSQL; PGlite is not considered evidence for privilege behavior.

## 0006 — CR-4D audit hash chain

Adds versioned fields to `audit_events`, tenant/month chain heads, and append-only external-anchor records. Version-one events require canonical SHA-256 fields and have a unique tenant/partition sequence. The application advances a locked chain head in the same transaction as the audit insert; migration constraints protect structural integrity, while `AuditStore.verify` recomputes and checks the full chain. Historical non-chain rows remain supported as version zero.

## 0007 — CR-4Q integrity hardening

Tenant-prefixes projection, command, audit, worker/allocation, and recommendation lineage; adds tenant scope to projection cursors/change history; and adds composite workflow/job/attempt lineage for authority-bearing canonical records. It also makes transition idempotency unique per tenant and entity kind.

The migration temporarily removes the projection-change row trigger only while deterministically backfilling `tenant_id` from the immutable adapter registry, then restores the trigger before completion. A populated database containing cross-tenant references intentionally fails migration and requires investigation rather than automatic reassignment.

## 0008 — CR-5A node protocol identity

Adds digest-only, node-class-scoped enrollment tokens; bounded single-use challenges; immutable Ed25519 node public-key identities; direction-specific connection sequence heads; and durable message/nonce/sequence replay rows. Enrollment activation, key insertion, token/challenge consumption, canonical transition, and outbox notification share one transaction.

Private keys and plaintext enrollment tokens are deliberately absent from the schema. Token and challenge identity fields are immutable and terminal states cannot be restored. Replay rows reject update/truncate; a separately privileged maintenance connection may delete expired rows while connection sequence heads remain durable. Key identity bytes cannot change in place, retired keys cannot reactivate, and revoked keys cannot be restored or deleted.

## 0009 — CR-5B protocol delivery semantics

Adds a canonical complete-frame digest to node replay records. New rows always carry the digest. A repeated message ID/nonce is classified as a safe delivery duplicate only when message, nonce, connection, sequence, and complete signed-frame digest all match; any difference remains a replay conflict. Nullable legacy rows intentionally cannot qualify as exact duplicates.
