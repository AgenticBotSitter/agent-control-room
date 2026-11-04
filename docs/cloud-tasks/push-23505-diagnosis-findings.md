# push-23505-diagnosis findings

Status: BLOCKED (environment). No 23505 reproduction attempt reached the code under test.

## Bases

- Published base (starting HEAD): 9ea4bded8b0af3eb68f3fb1d346ffca576d72643
- Parent (expected source SHA): 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041 (matches)
- Implementation base: same as starting HEAD; no test or production file changed.

## Changed files

- docs/cloud-tasks/push-23505-diagnosis-findings.md (this file) only.

## Setup

| Command | Exit |
|---|---|
| `node --version` (v22.23.4) | 0 |
| `npm ci` | 1 (EUSAGE: repo has no package-lock.json; it ships pnpm-lock.yaml) |
| `pnpm install --frozen-lockfile` (pnpm 11.19.0, the repo's own lockfile) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` (distro repos) | 100 (package not found on Ubuntu noble) |
| fetch PostgreSQL apt signing key / apt.postgresql.org index | 22 / 403 from the environment's egress proxy |
| `apt-get install -y postgresql-17` (after adding PGDG source) | 100; PGDG source file removed afterwards |
| `id builder` | 0 (already existed) |
| `chown -hR builder:builder` checkout, later `chown -hR root:root` | 0 / 0 |

Only PostgreSQL 16.15 (`/usr/lib/postgresql/16/bin`) was available, so `PG_BIN=/usr/lib/postgresql/16/bin` was used.

## Baseline run (two-file lane, PG16)

Command: the task's baseline command unchanged except `PG_BIN=/usr/lib/postgresql/16/bin`.

- exit=1, elapsed 286 s; tests 10, pass 0, fail 10, cancelled 0, skipped 0.
- Every test failed in fixture setup with `database_unavailable` from
  `private-pg-driver.ts` `acquire` (via `bounded-database.ts`), before any test body ran.
- No `CR-E075 PostgreSQL unique violation` line was logged.

Cause (verified by reading code, not a regression): `src/web/v1/private-pg-qualification.ts`
rejects any session unless `server_version_num` is 170000..179999 and the PG17-only
`transaction_timeout` setting is `10s`. A PG16 server can never qualify, so the
production binding refuses every acquisition. This is the expected control failure
for a missing PG17, not evidence about the 23505 path.

## Unrun steps

- 10-round serial repetition of the three named concurrency cases: not run; the
  baseline proved every acquisition is refused on PG16, so the rounds could not exercise
  the subscribe path and a "pass/fail" count would be meaningless.
- Instrumentation of the CHILD Client / overload-preserving wrapper: not added; no
  violation was observed to instrument.
- `tsc --project tsconfig.vps.json`: not run; no source changed.

## Reproducibility table

| Run | Server | Rounds | 23505 observed |
|---|---|---|---|
| Two-file baseline | PG 16.15 | 1 | no (setup refused before bodies) |
| Named concurrency cases | — | 0 | not run |

This is NOT a non-reproduction: the race was never exercised. No conclusion about
the presence or absence of the race is drawn.

## Cleanup

- Fixture teardown ran for all 10 tests; afterwards: postgres processes 0, listeners on
  ports 59720-59739 0, `.test-tmp/` entries 0.

## To unblock

Run on a host with PostgreSQL 17 binaries at `/usr/lib/postgresql/17/bin` (or an
environment whose network policy allows apt.postgresql.org).
