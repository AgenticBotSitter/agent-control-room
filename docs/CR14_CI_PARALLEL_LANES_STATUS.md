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
  process uses concurrency two. At most four matrix lanes run together.
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
ESLint and migrations 0001–0054 (138 tables) passed locally. All six actual runner
lanes and the final GitHub workflow run are pending completion at this record's first
write; no CI timing improvement or green GitHub check is claimed yet.

No product runtime, SQL permission, agent connection, credential, listener, provider,
production database, deployment or public release changed. Real PostgreSQL and fleet
acceptance remain separate owner-authorized work. Next model remains Astra Medium
for this CI/integration maintenance block; no setting change is requested.
