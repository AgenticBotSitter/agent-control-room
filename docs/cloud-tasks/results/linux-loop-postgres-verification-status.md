# linux-loop-postgres-verification status

BLOCKED

Reason: PostgreSQL 17 could not be installed. It is not in the distro repos, and the egress proxy returns 403 for the PostgreSQL apt repository. The fallback engine, PG 16.15, is refused by the production preflight, which requires server_version_num 17.x. That refusal is an expected environment failure, not a regression. Rounds 2 and 3 were not run. The worker's 10-minute tool limit stopped round 1 early. The orphaned fixture cluster was stopped and removed; leftovers = 0. No code changes.

Setup used:
- npm ci → 1 (no package-lock.json); pnpm install --frozen-lockfile → 0
- apt-get update → 0; apt-get install postgresql-17 → 100; PGDG repo key fetch → 22 (403)
- builder user pre-existing; chown -hR builder checkout → 0; build-vps → 0
- PG_BIN=/usr/lib/postgresql/16/bin (PostgreSQL 16.15), Node v22.23.4

Details: docs/cloud-tasks/linux-loop-postgres-verification-findings.md
