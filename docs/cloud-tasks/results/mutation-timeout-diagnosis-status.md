# mutation-timeout-diagnosis status

DONE: kill EPERM and the 50ms-baseline failure did not reproduce. The 3 selected tests passed in 20/20 serial rounds as builder, and the full tests/verify-mutation-checks.test.mjs passed 52/52 with 0 skipped. No task process survived; the only leftovers were short-lived zombies that PID 1 reaped within about 3s. Details are in docs/cloud-tasks/mutation-timeout-diagnosis-findings.md.

Setup: Node v22.23.4. `npm ci` failed (exit 1, no package-lock.json), so dependencies came from `pnpm install --frozen-lockfile` using the repo's pnpm-lock.yaml (exit 0). postgresql-17 could not be installed: it is not in the distro archive and the proxy returned 403 for the PGDG repo. The run used PostgreSQL 16 (PG_BIN=/usr/lib/postgresql/16/bin), which these tests do not use. The builder user already existed. The checkout was chowned to builder for the tests and back to root afterwards. Secret scan: 0 findings. Private-name guard: SKIP (no list configured).
