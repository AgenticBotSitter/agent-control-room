# b5-repair-guard-isolation status

**DONE**

Identity-only and family-only forged repairs (provider metadata and qualified lineup kept
self-consistent) are each refused with `B5_REJECTION_REPAIR:original builder repair`; each
one-clause helper deletion is killed by its own case (actual `incomplete`), not by a later
provenance refusal. Named test 1/1, full B5 file 152/152, mutations partition 1 14/14
(13/13 probes), tsc exit 0. Helper byte-unchanged.

- Base: 4c7cf8c66746627684176392135fbaaa78ce1be7 (parent 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041)
- Implementation commit: 8a06df6878e767f0b1ecf2cfc05b027aaba1db00
- Findings: docs/cloud-tasks/b5-repair-guard-isolation-findings.md

## Setup used

- Node v22.23.4; `npm ci` exit 1 (no npm lockfile); `pnpm install --frozen-lockfile` exit 0.
- PostgreSQL 17 unavailable (apt exit 100; PGDG key fetch exit 22, proxy 403);
  used **PostgreSQL 16.15**, `PG_BIN=/usr/lib/postgresql/16/bin`. Re-run on 17 before integration.
- Existing `builder` account; tests run via `runuser -u builder --`; ownership restored to root.
