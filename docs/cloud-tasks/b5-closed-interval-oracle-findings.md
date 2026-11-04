# b5-closed-interval-oracle findings

Status: DONE. Test-only hardening. No runtime, schema, package or lockfile change.

## Bases

- Published base (starting HEAD, task-document commit): 1e12d9dfd175fbca8a95a99666d7e0d72283bec8
- Implementation base (HEAD^ of the published base): 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041
- Output branch: cloud/b5-closed-interval-oracle

## Changed files

- tests/improve-control-room-first-website.test.ts
- docs/cloud-tasks/b5-closed-interval-oracle-findings.md

## What changed

- "B5 closed interval 3-6: refusals stay, each next to its green sibling": the reversed-interval
  case 5b (`from` 15.5, `to` 14.8) is removed and replaced by a pointer comment. All other
  assertions in the three named closed-interval tests are kept unchanged.
- Case 6 (`closed=[]`) is kept as a guard unit case. Its comment now says it cannot be reached
  through parsed evidence, because `b5JourneySchemaV1` requires `closed.min(2)`. No full-verifier
  claim is made.
- New test "B5 defective build end bound refuses independently". It builds a before/equal/after
  matrix on one input. Only the end of the "defective build" interval differs between cases.
  - Fixture facts are asserted: the defective build runs over minutes 14-15, and every later
    step starts at or after minute 16.
  - Chronology (fixture minutes):
    - approve-spec at 6.
    - The "defective build" interval runs 13.5 → 15−6s (before) / 15 (equal) / 15.1 (after).
    - A synthetic owner action (a clone of the `answer` action, sequence 90) at 15.3.
    - The "rejection and repair" interval runs 15.5 → 38.
    - The existing "after Start" interval (3.1-3.4) is kept.
    - Synthetic receipt sequences for the two intervals: 91-94.
  - Each case checks:
    - `b5JourneySchemaV1.parse` succeeds.
    - Every interval has from<=to.
    - The single later interval's latest-owner-action handoff start (15.3) is after the build's
      start, so that interval cannot cover the build.
    - The start clause holds for the build interval.
    - Every later step (rejection, repair, fresh reviews) is strictly inside the later interval.
    - No owner action falls inside any interval.
  - Guard results: the equal and after siblings pass the real exported `assertRejectionRepairV1`
    first. Then the before case must throw `{code:'B5_REJECTION_REPAIR', detail:'steps outside a closed-browser interval'}`.

## Setup used

| Command | Exit |
|---|---|
| `npm ci` | 1 (EUSAGE: the repo has no package-lock.json; its lockfile is pnpm-lock.yaml) |
| `pnpm install --frozen-lockfile` (pnpm 11.19.0, matching packageManager) | 0 |
| `apt-get update` | 0 |
| `apt-get install -y postgresql-17` | 100 (package not found) |
| fetching the PostgreSQL apt key | 22 (HTTP 403 from the network proxy); repo list removed again |
| `id builder` (account already existed) | 0 |
| `mkdir -p .test-tmp && chown -hR builder:builder "$PWD"` | 0 |
| `chown -hR root:root "$PWD"` before Git/scans | 0 |

- PostgreSQL 17 could not be installed, so PG_BIN=/usr/lib/postgresql/16/bin was used (PostgreSQL 16).
- Node v22.23.4.

## Runs

The commands are the task's exact commands, except that PG_BIN points to 16.

| Run | Exit | tests/pass/fail/skipped/cancelled | Duration |
|---|---|---|---|
| Selected, pre-edit checkout | 0 | 3/3/0/0/0 | 17s |
| Selected, implementation | 0 | 4/4/0/0/0 | 16s |
| Selected, end-clause mutant (scratch graph) | 1 (expected control failure) | 4/2/2/0/0 | 16s |
| Full file, implementation (first) | 0 | 153/153/0/0/0 | 401s |
| Full file, implementation (final) | 0 | 153/153/0/0/0 | 421s |
| Full file, pre-edit (scratch graph) | 1 | 152/151/1/0/0 | 376s |
| tsc --project tsconfig.vps.json | 0 (no output) | - | 32s |

The first full implementation run is not a pre-edit baseline. The edit landed before the test
file was loaded: the run contains the new test, and pre-edit has 152 tests.

The pre-edit scratch failure was "F04a listener, contamination and protected-diagnostic guard
mutations reach intended assertions". That test git-clones its own working directory, and the
scratch copy has no `.git` ("repository ... does not exist"). This comes from the scratch copy,
not from a regression. The same test passes in both full runs in the real checkout.

## Mutant

- Mutation: in a task-owned scratch copy (`.test-tmp/`, node_modules symlinked), the exactly-once
  match `&& ms(s.endedAt) <= ms(c.to);` was replaced with `;`. This removes only the end clause
  of `fromHandoff`.
- Result:
  - The new test failed at its intended assertion: "Missing expected exception: build ends 6s
    after its interval closes".
  - The equality and after siblings ran before that assertion and stayed green.
  - All schema and structure assertions passed.
- Also seen: the existing case 3 ("owner acts during the build") also fails under this mutant.
  With the end clause gone, the "after Start" interval (3.1-3.4) covers the build through its
  handoff start of 3. This existing assertion depends on the end clause too. It is not counted as
  the isolated kill.
- The real checkout was never mutated. The scratch copy was removed after the runs.

## Cleanup

- The scratch graph was removed, and `.test-tmp/` has no task leftovers.
- No PostgreSQL or initdb processes remained after the runs (checked with `ps`).
- The selected tests start no cluster. The full-file runs used the existing fixture teardown.

## Scans

See the status file for the secret-scan and private-name results. Without a configured list, the
private-name guard result is a SKIP, not a full privacy pass. The lead must run CI's configured
privacy checks before integration.

## Limitations

- PostgreSQL 16 was used instead of 17.
- Dependencies were installed with pnpm from the repo's own lockfile, not provisioned in advance.
- The pre-edit full baseline ran in a scratch copy without `.git`.
