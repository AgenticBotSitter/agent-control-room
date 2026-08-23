# PostgreSQL migrations

## 0001 — core projections

Creates tenants, workspaces, adapter registry, projects, work items, executions, blockers, attention items, machines, workers, agents, capabilities, routes, cursors, projection changes, command receipts, and audit events. Tenant/workspace keys scope projected data.

## 0002 — allocation and simulation

Adds allocation policies, benchmark runs, simulator runs, and recommendations. Append-only triggers protect audit events, projection changes, and command receipts from update or deletion.

## 0003 — canonical domain and durable delivery

Adds normalized canonical records for nodes, requests, workflows, jobs, attempts, leases, checkpoints, approvals, effect intents, services, schedules, incidents, and artifact manifests. Adds tenant-bound composite lineage, job dependencies, one-active-lease and monotonic-epoch constraints, append-only transition events, inbox/outbox, idempotency records, claim recovery, and dead-letter status.

Payload-mirror triggers ensure the indexed ID, tenant, state, and version cannot disagree with the versioned JSON record. Cross-record operations remain repository transactions; direct SQL state changes fail the mirror trigger and are unsupported.

`pnpm db:verify` applies all migrations to an isolated PostgreSQL-compatible PGlite database and checks the expected table set. A disposable real-PostgreSQL rehearsal remains mandatory before any live deployment.
