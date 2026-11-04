# linux-loop-postgres-verification findings

Status: **BLOCKED**. PostgreSQL 17 could not be provisioned, so no native PG17 run happened and no green result is claimed.

## Bases

- Starting HEAD (published base): 4fb3da3b938ca1fc4a04de22763fab199f242778
- Parent (source branch tip): 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041 (verified)
- Changed files: this findings file only. No source, test, SQL, package or lockfile changes.

## Setup (command → exit)

- `npm ci` → 1 (EUSAGE: the repo has no package-lock.json; it pins pnpm and ships pnpm-lock.yaml)
- `pnpm install --frozen-lockfile` (repo's own lockfile, pnpm 11.19.0) → 0
- `apt-get update` → 0; `apt-get install -y postgresql-17` → 100 (package not in distro repos)
- Adding the PostgreSQL apt repository: key download → 22 (HTTP 403 from the egress proxy); repo index fetch was refused with 403; the repo entry was removed again. postgresql-17 is still not installable.
- Fallback per worker instructions: newest local engine = /usr/lib/postgresql/16/bin (PostgreSQL 16.15). PG_BIN was set to it; every other part of the command stayed unchanged.
- `id builder` → 0 (already existed); `test -x node_modules/.bin/tsx` → 0; Node v22.23.4
- `mkdir -p .test-tmp && chown -hR builder:builder "$PWD"` → 0
- `runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/build-vps.mjs` → 0 (about 20 s)

## Run

Round 1, the task's exact lane command except `PG_BIN=/usr/lib/postgresql/16/bin`, started 08:23:31Z:

- tests/improve-control-room-desk-postgres.test.ts: 19 not ok / 1 ok at the time the run stopped. The first failure was
  `Error: private_database_preflight_failed refused: none` at the test file line 281. Every later B1a body failed with `database_unavailable`.
- Root cause: the production preflight requires server_version_num BETWEEN 170000 AND 179999 (src/web/v1/private-database-preflight.ts:810), and the PG16 fixture server cannot meet that. This is an **expected environment failure, not a regression**. No SQLSTATE was surfaced in the bounded output.
- The worker's own 10-minute background tool limit killed the invocation at about 08:33Z, before the desk file finished. The recovery, bridge and candidate files had not reported results yet. Final tests/pass/fail/skipped/cancelled totals were not emitted.
- Rounds 2 and 3: not run. Every round would hit the same version refusal, and the task forbids retrying a broken setup.

Contention or one-winner evidence: none recorded. Those bodies did not run against a valid engine.

## Cleanup

The kill orphaned one fixture-owned PG16 cluster (a builder-owned postmaster on fixture port 60320, with its data dir under a disposable /tmp fixture directory). Cleanup steps:

1. Stopped the cluster with `runuser -u builder -- pg_ctl -D <fixture>/data -m fast -w stop` → 0.
2. Removed only that fixture's /tmp directories.
3. Checked afterwards: no postgres or test processes, no attack-kit /tmp directories, and .test-tmp is empty. Task-owned leftovers = 0.

The in-test `cleanedUp=true` teardown lines were not reached for that cluster, because the fixture process was killed.

## Limitations / next step

This needs an environment with PostgreSQL 17 under /usr/lib/postgresql/17/bin. Either pre-provision it, or allow egress to the PostgreSQL apt repository. Then run all three rounds with a tool timeout of at least 30 minutes per invocation. None of the four files is credited as green.

## Scans

- Secret scan on the findings file → files=1 findings=0
- Private-name guard → SKIP: no list is configured locally. This is not a full privacy pass; the lead must run the CI privacy checks.
- `git diff --check` → clean
