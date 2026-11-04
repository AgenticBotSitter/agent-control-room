# push-23505-diagnosis status

BLOCKED

Reason: PostgreSQL 17 unavailable. The distro (Ubuntu noble) has no postgresql-17 package and the PGDG apt repository is blocked by the environment's egress proxy (403). With PostgreSQL 16.15 the production session qualifier (requires server_version 17.x and transaction_timeout) refuses every connection, so all 10 lane tests failed in fixture setup with database_unavailable before any body ran. No 23505 was exercised; this is not a non-reproduction.

Setup used: Node v22.23.4; `npm ci` exit 1 (no npm lockfile); `pnpm install --frozen-lockfile` exit 0; `apt-get install postgresql-17` exit 100; PG_BIN=/usr/lib/postgresql/16/bin (16.15); existing builder user; tests run via runuser as builder.

Details: docs/cloud-tasks/push-23505-diagnosis-findings.md
