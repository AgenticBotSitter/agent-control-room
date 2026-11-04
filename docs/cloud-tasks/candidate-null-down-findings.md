# candidate-null-down findings

Result: **BLOCKED (partial)**. The PGlite regression is green against the real down, red against the scratch NOT VALID-only control, and green again after restoration. The native test is written, but this environment could not run it, because only PostgreSQL 16 was available (see Environment). No native evidence is claimed.

## Revisions

- Starting HEAD (published base): `1dde19a9d8f3515725c3234d26a793881b5ca56c`
- `HEAD^` (implementation base): `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`. This matches the required `cloud/pack-1` source.
- Output branch: `cloud/candidate-null-down`

## Changed paths

- `tests/improve-control-room-loop-candidate.test.tsx`: adds `B4 retained null sections refuse 0305 down atomically` and a test-local SQL-input seam (`nullDown0305Input`).
- `tests/improve-control-room-loop-candidate-postgres.test.ts`: adds `B4 native retained null sections refuse 0305 down atomically` and the same test-local seam.
- `docs/cloud-tasks/candidate-null-down-findings.md`: this file.

Product, migration, down, ledger, dependency and lockfile bytes are unchanged.

## What the tests assert

1. The existing synthetic fixture uses `f.edit` to set summary, changedAreas, databaseChanges, assumptions, validations and rounds.repairs to null. It then publishes through the real publisher, so the stored row is genuinely signed.
2. The test rolls 0307 down with its real file, the same way the existing 0307 test does. The PGlite test runs it as `control_room_schema_owner`; the native test runs it as admin.
3. It captures the following state:
   - the full row (`row_to_json`), plus `payload`, `record_digest` and `auth_tag`
   - the CHECK definition and `convalidated`
   - the guard function definition and `prosrc`
   - the user triggers
4. Before the attempt, it asserts that the starting state is the expected one:
   - the CHECK is the tolerant one (`WHEN 'null'::text THEN true`)
   - the CHECK is validated (`convalidated=true`, from 0308)
   - the guard body is byte-exact with the 0305 up body
5. It runs the down as the schema owner. PGlite uses `SET ROLE control_room_schema_owner` on the same session; native uses a `control_room_migrator` login, which is asserted to have the owner role. There is no outer transaction, so any atomicity must come from the down file's own `BEGIN`/`COMMIT`.
6. It catches the error and issues `ROLLBACK` on the same session to recover from the aborted transaction. PGlite also issues `RESET ROLE`. It then asserts SQLSTATE `23514`.
7. It re-captures the state and asserts it deep-equals the pre-attempt capture.
8. It checks that the session is still usable. PGlite reuses its session; native opens a fresh `control_room_web` pool plus a second admin client. In both, the retained card still reads with null sections and publish returns `replayed`. All clients are closed in `finally`.

No rows are deleted, no triggers are disabled, no CASCADE is used, no signatures are rewritten and no grants are loosened.

## Environment / setup (each command and its exit code)

| Command | Exit |
|---|---|
| `npm ci` | 1 (EUSAGE: the repository has no npm lockfile; its lockfile is `pnpm-lock.yaml`) |
| `pnpm install --frozen-lockfile` (pnpm 11.19.0, from `packageManager`) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (package not found) |
| Adding the PostgreSQL apt repository (key download) | 22 (HTTP 403 from the outbound proxy) |
| `apt-get install -y postgresql-17` (retry) | 100 |
| `id builder` | 0 (user already existed) |
| `chown -hR builder:builder <clone>` | 0 |
| `chown -hR root:root <clone>` (after tests) | 0 |

- Node `v22.23.4`.
- PostgreSQL used: **16.15**, `PG_BIN=/usr/lib/postgresql/16/bin`. PostgreSQL 17 was not installable.

## Commands and results

All test commands ran as `runuser -u builder --` with `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp`, exactly as the task specifies. The only difference is that the native run used `PG_BIN=/usr/lib/postgresql/16/bin`.

| Run | Exit | tests / pass / fail / skip / cancel |
|---|---|---|
| PGlite focused `^B4 retained null sections refuse 0305 down atomically$`, real input | 0 | 1 / 1 / 0 / 0 / 0 |
| PGlite focused, scratch NOT VALID-only control | 1 | 1 / 0 / 1 / 0 / 0 (intended) |
| PGlite focused, restored real input | 0 | 1 / 1 / 0 / 0 / 0 |
| PGlite full `tests/improve-control-room-loop-candidate.test.tsx` | 0 | 53 / 53 / 0 / 0 / 0 |
| `tsc --project tsconfig.vps.json` | 0 | none |
| Native focused `^B4 native retained null sections refuse 0305 down atomically$` (PG 16) | 1 | 1 / 0 / 1 / 0 / 0 (**environment-blocked, not a pass**) |
| Native baseline, existing `^B4 PostgreSQL interrupt before commit and lost receipt after commit reconstruct once$` (PG 16) | 1 | 1 / 0 / 1 / 0 / 0 (same environment block) |

Each PGlite run logged `B4 0305 down input=db/down/0305_control_loop_candidate_unavailable_sections.sql`. The control run logged `input=scratch:.test-tmp/0305-down-not-valid-only.sql`.

### Native block

Both the new native test and the unchanged existing native test fail inside the shared `syntheticFixture`, at its first `control_room_web` query, before any new test code runs:

```
error: 'database_unavailable'
  Object.acquire (src/web/v1/private-pg-driver.ts)
  async syntheticFixture (tests/improve-control-room-loop-candidate-postgres.test.ts:63)
```

Cause: production session qualification (`src/web/v1/private-pg-qualification.ts`) requires `server_version_num BETWEEN 170000 AND 179999`. This needs a PostgreSQL 17 rerun. Neither the native test nor any native mutant was counted as passing or killed.

## Negative control (scratch only)

- Seam: the test-local environment variable `B4_NULL_DOWN_0305_SCRATCH_SQL`. The test asserts that its path is under `.test-tmp/`. Unset, the test reads the real tracked file. This is not a production API.
- Mutant: `.test-tmp/0305-down-not-valid-only.sql` was produced with `sed 's/^  ) IS TRUE);$/  ) IS TRUE) NOT VALID;/'` from the real down. It changes exactly one line (line 70, the restored strict CHECK) and adds no validation.
- Invocation: the PGlite focused command with `B4_NULL_DOWN_0305_SCRATCH_SQL=.test-tmp/0305-down-not-valid-only.sql` added. Each run uses a fresh fixture.
- Failure, at the intended assertion (`tests/improve-control-room-loop-candidate.test.tsx:1289`):

```
B4 real 0305 down refuses a retained null-section candidate with 23514
+ actual - expected
+ undefined
- '23514'
code: 'ERR_ASSERTION'  operator: 'strictEqual'
```

- Restoration: the mutant file was deleted, and the real input ran green again (above). The tracked down file was never modified.
- Native counterpart: not run, because it is environment-blocked before the seam is reached.

## Cleanup

- The native harness `run()` threw before it printed its `cleanedUp=true leftovers=0` line, so zero leftovers are **not** asserted by the harness.
- A manual check afterwards found no `postgres` processes, no `/tmp/attack-kit-pg-*` run directories and no new shared-memory segments.
- Scratch logs under the git-ignored `.test-tmp/` were removed.

## Scans

Results are recorded in the commit-time checks below:

- `scanTrackedSecrets` on the three files: `secret-scan files=3 findings=0`
- Private-name guard, no list: SKIP (local, no list). The CI private-name list is unavailable in a public cloud clone, so this is not a full privacy pass.
- `git diff --check`: clean

No native host, engine or product-release qualification is claimed.
