# CR-3 data, durability, and recovery architecture

**Status:** Proposed  
**Decision:** One PostgreSQL authority with encrypted backups and bounded node journals; no multi-writer worker replication

## PostgreSQL in plain language

PostgreSQL is a database server in the same broad family as SQL Server or MySQL. It provides transactions, constraints, indexes, concurrent access, durable write-ahead logging, backups, and replication. Control Room already uses PostgreSQL-shaped migrations and a PostgreSQL client; PGlite is used to verify migrations locally without requiring a production server.

## Why one authority is correct now

The Control Room problem requires a single answer to questions such as:

- Which node owns this lease?
- Was this approval consumed?
- Did this external effect already happen?
- Which project receives the next available GPU slot?
- Is this node revoked?

Letting every worker hold a writable copy requires distributed consensus, conflict resolution, quorum membership, clock and partition handling, encryption of full operational state on every node, and safe node removal. It would increase resource use and attack surface while making failures harder to understand.

The chosen model is:

```text
PostgreSQL primary on Control Room host
  = one writable global truth

R2 + optional offline copies
  = encrypted recovery material

node journals
  = bounded evidence for reconnect/reconciliation
  != database replicas
```

The value the user identified—recovering after a server failure—is real. It is achieved with tested backups, PostgreSQL WAL/PITR, and optionally a later standby. Turning all heterogeneous workers into database peers is not required.

## Authoritative versus reconstructable data

| Data | Authority | Recovery behavior |
|---|---|---|
| Identity, grants, policies, approvals | PostgreSQL | Restore from database backup/WAL; never infer from workers |
| Requests, workflows, jobs, attempts, leases | PostgreSQL | Restore then reconcile node journals |
| Audit and command/event history | PostgreSQL plus external audit anchors | Restore and verify hash chain/anchors |
| Source-scheduled project truth | Source project | Re-project through adapter after restore |
| Worker capabilities and recent telemetry | PostgreSQL projection | Re-discover/re-benchmark from nodes |
| Large artifacts | Local approved storage or R2 | Verify manifest hash; metadata can be reconciled |
| Git source | GitHub/local repository | Re-fetch by commit; never treat DB copy as source |
| Node leased-job journal | Node-local | Submit receipts/checkpoints after reconnect |
| Secrets | Bitwarden/1Password/destination | Re-resolve; never restore plaintext from CR backup |

## Central persistence architecture

Production uses supported PostgreSQL with:

- one application database;
- separate roles for migration, application, read-only operations, and backup;
- loopback/private-container-only listening;
- TLS for any non-loopback connection;
- least-privilege grants;
- foreign keys, checks, unique idempotency constraints, and transactional state transitions;
- append-only event, command, outcome, and audit records;
- transactional outbox for external delivery;
- inbox/deduplication records for node, adapter, webhook, Telegram, and MCP mutations.

PGlite remains a development and contract-test tool. It is not the initial production database.

## V1 domain additions

CR-0 through CR-2 remain the projection foundation. Later migrations add—not silently reinterpret—the following groups:

### Work orchestration

- `requests`
- `workflow_definitions` and immutable versions
- `workflow_runs`
- `jobs`
- `job_dependencies`
- `job_attempts`
- `job_leases`
- `job_checkpoints`
- `effect_intents`
- `outcomes`

### Human and policy control

- `actors`, `roles`, and scoped grants
- `node_enrollments`, node keys, rotations, and revocations
- `policy_sets` and immutable policy versions
- `approvals`, questions, reviews, and decisions
- `credential_references` containing metadata only

### Fleet and services

- node observations and resource samples
- harness installations and versions
- worker slots and executor manifests
- capability probes and benchmark histories
- schedules, services, observations, incidents, and reconciliations

### Delivery and artifacts

- inbox messages and deduplication keys
- transactional outbox and delivery attempts
- artifact manifests, locations, hashes, producers, retention, and quarantine
- notification preferences, destinations, quiet hours, and escalations

Every migration is forward-only, reversible through a documented restore or compensating migration, and tested on an isolated database before deployment.

## Node-local durable journal

Each node keeps a small local database owned by the bridge. It may be SQLite because it is local to one process family and not copied between nodes.

Allowed contents:

- node ID and non-secret enrollment metadata;
- server trust material and local policy version;
- received message IDs/nonces for replay rejection;
- currently leased job envelopes;
- lease-renewal and cancellation observations;
- checkpoints and artifact manifests;
- idempotency/effect receipts;
- bounded redacted event/outbox spool;
- discovery and benchmark cache.

Forbidden contents:

- global project/database replica;
- other nodes' job queues;
- plaintext secrets;
- full prompts/transcripts unless a project explicitly stores them in its own approved location;
- authority to reassign jobs or elect a server.

On reconnect the node reports its last acknowledged server event and unresolved attempts. The server compares lease epochs, attempt IDs, effect receipts, and artifact hashes before accepting, retrying, or flagging ambiguous work.

## Failure behavior

### Control Room process crash

PostgreSQL transactions preserve committed state. The restarted process resumes outbox delivery, expires stale leases, and reconciles nodes. Nodes do not accept new jobs while disconnected.

### VPS reboot

systemd or Docker restart policies restore PostgreSQL, Control Room, and the tunnel in dependency order. Readiness remains false until migrations, database access, policy keys, and scheduler leadership are healthy.

### PostgreSQL crash

PostgreSQL replays its local write-ahead log to a consistent point. Application components remain unavailable until the database passes readiness checks.

### VPS loss or filesystem corruption

Provision a clean host, restore the latest base backup plus WAL archive, restore independently backed-up configuration, validate audit anchors, then reconnect nodes in reconciliation mode. No node becomes an automatic primary.

### Network partition

- Nodes may continue only an already-started job if its offline policy and lease envelope explicitly permit it.
- Nodes cannot claim new global work.
- Consequential effects requiring online approval pause.
- Outputs are journaled locally and uploaded after reconnect.
- The server does not immediately duplicate a potentially running effect; it waits for lease and reconciliation policy.

### Node loss

The lease expires. Retry occurs only if the job/effect policy is safe. Artifacts are accepted only with matching attempt IDs and hashes.

## Backup plan

### Recovery objectives proposed for v1

- Metadata RPO: 15 minutes or better once WAL archiving is enabled.
- Metadata RTO: four hours for a documented clean-host restore.
- Artifact RPO: determined per project; published/approved artifacts should be uploaded or mirrored before dependent work.
- Configuration RPO: every accepted configuration change captured in Git or an encrypted configuration backup.

These are targets to prove, not promises until restore drills pass.

### Layers

1. PostgreSQL crash recovery on the primary disk.
2. Encrypted daily logical backup for portability and inspection.
3. Encrypted periodic base backup plus continuous WAL archive to an R2 prefix dedicated to backups.
4. Hostinger's included weekly backup as an additional provider-level safety net, not the sole backup.
5. Optional encrypted backup pull to the home PC/Mac for provider-diversity.
6. Independently backed-up deployment configuration, migration versions, and recovery runbooks.

Backups use credentials that can write only to the backup prefix. Restore credentials are separated where practical. Retention uses daily/weekly/monthly generations, legal/privacy policy, and available storage.

### Verification

- Every backup emits a manifest, hash, version, timestamp, and safe size metrics.
- Automated checks verify presence and integrity.
- A scheduled disposable restore proves the database boots and invariants hold.
- Quarterly clean-host recovery exercises measure actual RPO/RTO.
- A backup is not considered successful until a restore has been demonstrated.

## Replication and future high availability

PostgreSQL supports WAL-based standby and streaming replication. We deliberately do not place standbys on every worker.

Add one dedicated standby or move to managed PostgreSQL when one or more triggers occur:

- measured uptime requirement exceeds what a four-hour restore can satisfy;
- Control Room becomes operationally or commercially critical;
- database size makes restore time unacceptable;
- active users or automation cannot tolerate VPS maintenance;
- the deployment has an independent host suitable for a maintained standby;
- operational maturity includes monitoring, failover fencing, credential rotation, and regular drills.

A future standby is read-only until an explicit promotion process fences the old primary. Automatic failover is deferred because a mistaken dual-primary event is worse than a short outage at current scale.

## Why workers do not rebuild global truth by voting

Workers observe only their own jobs and may be offline, compromised, stale, or holding partially completed effects. They cannot reconstruct owner policies, unassigned queue order, other nodes' state, or consumed approvals reliably. Their journals are valuable reconciliation evidence after restore, but PostgreSQL backups and source adapters rebuild authority.

## Data acceptance tests

- lease claim is atomic under concurrent nodes;
- expired lease can be reclaimed without accepting a stale completion silently;
- approval wait survives application and database restart;
- idempotency prevents repeated API, webhook, Telegram, MCP, and node mutations;
- ambiguous effect produces reconciliation attention rather than automatic duplicate action;
- outbox resumes without duplicate consequential delivery;
- tenant/workspace isolation tests fail cross-scope access;
- node journal reconnect reconciles completed, running, cancelled, and orphaned attempts;
- backup and PITR restore to a clean environment succeeds;
- source projections can be rebuilt without overwriting native authority;
- artifact hashes detect changed or corrupted objects;
- database loss does not require or permit worker election.

## Decision summary

The system has one master authority because that is the simplest safe answer for the current fleet and remains appropriate for many larger installations. Durability is obtained through PostgreSQL transactions, WAL, encrypted off-host backups, restore drills, and later an optional dedicated standby—not by burdening every worker with a writable copy of the global database.
