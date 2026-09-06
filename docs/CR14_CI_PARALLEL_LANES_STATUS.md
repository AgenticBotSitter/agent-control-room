# Coverage-preserving CI lanes: verification record

2026-09-05. Maintenance branch based on reviewed PR #328 (`6b2a727`), not the
separate workflow-completion draft PR #329. This work does not resolve that draft's
interrupted independent review or authorize merging the prerequisite stack.

## Reason for this change

GitHub run `34002739429` exhausted its 35-minute limit after the preparation,
main, post and rendered suites passed. The private build was cancelled and migration
verification was skipped. That run remains non-passing. Raising the single-job limit
had already failed to provide sufficient headroom; this change separates independent
work while retaining the complete test inventory and both build commands.

## Delivered

- Shared frozen dependency preparation with unchanged Node/pnpm/action versions,
  cache, stage-zero probes and read-only repository permission.
- Separate type/lint, build/migration, and six test lanes. The four main shards use
  sorted round-robin filenames; preparation and post lists remain intact. Each test
  process now uses one file at a time. At most four matrix lanes run together.
- The default lifecycle now includes four previously focused-only result-checking
  test files and the new runner regression file. No existing test was removed.
- `Verify build` remains the final aggregate check and requires every dependency
  to succeed. Failure, cancellation and skipped work cannot count as a passing lane.
- Pure partition validation plus exact argument-array execution, complete inventory
  file checks, child exit propagation and inert imports. No shell evaluates package
  scripts, and no test selection depends on an environment variable or name filter.

The final inventory is 264 test files: preparation 71, main 36/36/35/35, post 51.
Local `pnpm test` still invokes the existing lifecycle. A prepared checkout can run
one identical CI lane with `node scripts/run-ci-test-lane.mjs --lane main-1` (or
`pre`, `main-2`, `main-3`, `main-4`, `post`). Running one lane is not full verification.

## Evidence and limits

The isolated test agent passed eight runner tests, including an ordinary local Node
child's exit 0/9 propagation. Root repeated all eight successfully. An initial fixture
assertion incorrectly compared macOS's temporary path alias to its canonical path;
the assertion was corrected to use the canonical path, with no runner change.

Both YAML files parsed using installed Ruby Psych. `actionlint` was unavailable and
was not installed. Root's shell matrix check found that implicit error stopping for
separate `[[ ... ]]` commands was not sufficient on macOS Bash 3.2; explicit aggregate
success/failure is required. The corrected gate passed all 64 combinations of
success/failure/cancelled/skipped across its three dependencies, both with and
without shell error stopping (128 cases). The implementing agent and root each
repeated this check; only the all-success combination returned zero. Static review
found no evident lifecycle dependency on another lane's generated artifacts.

Both application builds, 20 compiled private tests, four rendered tests, TypeScript,
ESLint and migrations 0001–0054 (138 tables) passed locally. Every actual runner lane
exited zero on initial configuration `6d4d6be` (two test files per process group):

| Lane | Passed | Existing skips | Local duration |
| --- | ---: | ---: | ---: |
| pre | 770 | 0 | 49.6 s |
| main-1 | 273 | 0 | 68.6 s |
| main-2 | 384 | 1 | 66.0 s |
| main-3 | 298 | 1 | 84.2 s |
| main-4 | 302 | 0 | 73.2 s |
| post | 392 | 0 | 31.9 s |

Total: 2,419 passed, two existing platform skips, zero failures/cancellations. The
lanes ran sequentially on the local host; these durations are not GitHub timing
evidence. All 259 original test files remain; exactly five files were added.

Published as [PR #330](https://github.com/MarvinAi5/control-room/pull/330), based on
PR #328 rather than pending PR #329. The first GitHub run `34005325019` started
the checks/build and four matrix jobs, with two matrix jobs queued as designed.
The final current-head GitHub result remains pending; no timing improvement or green
GitHub check is claimed here. No merge is claimed.

Follow-up on initial head `6d4d6be`: run `34005397761` attempt 1 finished non-passing.
Checks, both builds/migrations and five test lanes passed. `main-3` reported the runner
receiving a shutdown signal, followed by a killed test process and cancellation; no
failed assertion was shown. The aggregate check correctly failed. This is retained
negative infrastructure evidence, not a diagnosed product defect or an accepted pass.
After the run was terminal, one failed-job retry was requested. Attempt 2 was confirmed
running for `main-3`; successful jobs were retained. No product code or test coverage was
changed to obtain that retry.

Follow-up: attempt 2 also terminated, again reporting a runner shutdown while the
same database-heavy receipt/quality files overlapped. This is not a third blind retry.
The runner is amended to execute one test file at a time, retaining four parallel
GitHub lanes, all 264 files and the tests' own concurrency scenarios. This lowers
possible per-runner contention but does not establish the shutdown's cause. A separate
local run of the receipt test passed 20/20, exit 0, in 23.39 seconds. Peak memory was
unavailable because the host rejected the timing utility's system metadata read; that
instrumentation was not repeated. No assertion defect was identified by those runs.

Eight amended runner tests, scoped lint and diff checks passed. The amended actual
main-3 lane exited zero: 298 passed, one existing platform skip, zero failures or
cancellations, 167.97 seconds locally. New-head GitHub checks remain required.
Independent read-only mechanical review confirmed that only file-level concurrency
and its exact argv assertion changed: inventory, per-test concurrency scenarios,
matrix, all-success gate, setup, permissions, builds and timeouts are unchanged.

No product runtime, SQL permission, agent connection, credential, listener, provider,
production database, deployment or public release changed. Real PostgreSQL and fleet
acceptance remain separate owner-authorized work. Next model remains Astra Medium
for this CI/integration maintenance block; no setting change is requested.
