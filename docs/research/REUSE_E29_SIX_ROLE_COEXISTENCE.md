# E29 — six-role queue coexistence

2026-09-06. Local actual-package/PGlite evidence; no services or deployment.

The actual pg-boss schema now has one combined test applying all application role
scripts plus queue producer, recovery and worker grants. Six distinct LOGIN identities
pass their real startup database checks: private web, coordinator, results, evidence,
sessions and queue worker. The website/results/evidence/sessions identities cannot read
queue jobs. The queue worker cannot read canonical task intents.

Each identity is then deliberately given an incompatible role membership. Every
corresponding startup gate rejects the broadened authority; the test removes that grant
before continuing. No production permission changes are made.

Verification: 62 actual-package integration tests pass together (submission and worker
suites), targeted ESLint and git whitespace checks pass. Stage-zero preparation passes.
Package remains the retained pg-boss 12.30.0 acquisition; no download was needed.

Limits: one serialized PGlite backend, not six physical PostgreSQL pools. Only the known
PGlite TEMP catalog limitation is substituted; identities, roles, application schema and
ACL queries are real. This does not prove complete upstream queue schema drift checking,
whole-host lifecycle, native execution, browser acceptance or production readiness.

Next: connect the existing protected browser approval workflow to the trusted submission
port. Inspection confirms `task-wire.ts` and `task-service.ts` still explicitly report
dispatch as `not_connected`, while `private-task-application.ts` supplies approval but
not submission to the web process. Do not relabel dispatch without actually wiring and
testing that path. Consolidated full-host and real PostgreSQL acceptance remain required.
