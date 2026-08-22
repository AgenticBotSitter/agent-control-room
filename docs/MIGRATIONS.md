# PostgreSQL migrations

## 0001 — core projections

Creates tenants, workspaces, adapter registry, projects, work items, executions, blockers, attention items, machines, workers, agents, capabilities, routes, cursors, projection changes, command receipts, and audit events. Tenant/workspace keys scope projected data.

## 0002 — allocation and simulation

Adds allocation policies, benchmark runs, simulator runs, and recommendations. Append-only triggers protect audit events, projection changes, and command receipts from update or deletion.

`pnpm db:verify` applies both migrations to an isolated in-memory PostgreSQL-compatible PGlite database and checks the expected table set. Production migration execution is intentionally not wired in this phase.
