# selfcheck-split-selector findings

## Bases

- Starting HEAD (published base, task-document commit): e6b4a137e494a286af7d56797d8e3e8c0d73e46f
- Implementation base (parent of that commit, origin/cloud/selfcheck-load-lanes): 5416f85b632b7654f3201b4e99413393fa99091b
- Output branch: cloud/selfcheck-split-selector

## Changed files

- tests/helpers/mutation-lane-selfcheck.ts: pattern extraction now collects every `--test-name-pattern=VALUE` and every bare `--test-name-pattern` followed by its value from `process.execArgv`; a parent counts as selected when any collected pattern matches. Load/flag, parent/probe count, enabled-lane and disabled-only rules are unchanged.
- tests/check-test-lane-coverage.test.mjs: `runFixture` takes an optional argv form (default unchanged equals form); new regression "mutation lane selectors accept split argv without disarming checks".
- docs/cloud-tasks/selfcheck-split-selector-findings.md (this file).

## Node's observed argv behavior (Node v22.23.4, synthetic probe file in /tmp)

| Invocation | Child `process.execArgv` | Effect |
|---|---|---|
| `--test-name-pattern=a=b` | `["--test-name-pattern=a=b"]` | selects `a=b one` |
| `--test-name-pattern a=b` | `["--test-name-pattern","a=b"]` | selects `a=b one` |
| two occurrences, either or mixed spelling | each occurrence forwarded as given | union: a test runs if any pattern matches |
| `--test-name-pattern` (no value, nothing after) | n/a | node exits 9: `--test-name-pattern requires an argument` |
| `--test-name-pattern=` (empty) | n/a | node exits 9: `requires an argument` |
| `--test-name-pattern FILE` (value missing, file consumed) | `["--test-name-pattern","FILE"]` | file name becomes the pattern; Node falls back to default file discovery |
| pattern flag placed after the test file | `[]` | Node does not forward or apply it; every test runs |

No custom acceptance was built for malformed CLI; the regression only asserts Node's own refusal of a flag with no value. The consumed-file and trailing-flag cases are recorded as limitations only.

## Regression coverage

Through the real helper in the synthetic fixture (`tests/fixtures/mutation-lane-selfcheck/lane.ts`), for both equals and split forms:
- a full grouped lane whose parent names contain `=` (`lane x=1 one`, `lane x=1 two`) runs with selected=2/2 and 3/3 and does not run the other lane;
- zero matching parents, partial grouped selection, cross-lane selection, and a matching selector with the enabling flag absent each exit 1 with the same diagnostic as equals form and print no lane selection;
- a repeated pattern (equals then split) that crosses lanes is refused;
- the monitoring (`B3b product collector contention`) and finalization (`B3c 24 finalizers retain once and refuse destruction`) consumers, run through `scripts/run-tests-with-quarantine.mjs` with split form and no enabling flag, are refused with `mutation lane selected without its enabling flag`. No real models or native qualification were run.

## Runs (all as builder, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1)

PG_BIN in the commands was `/usr/lib/postgresql/16/bin` (see Setup); the commands are otherwise unchanged from the task file.

| Run | Exit | tests/pass/fail/skipped/cancelled | Duration | Kind |
|---|---|---|---|---|
| Selected regression, before helper change (red) | 1 | 1/0/1/0/0 | 1.5 s | expected control failure: `zero matching parents (split) must exit 1, got 0` (child printed `1..0`, an unexpected green) |
| Selected regression, after fix | 0 | 1/1/0/0/0 | 11.7 s | green |
| Selected regression, scratch copy with only old equals-only extraction | 1 | 1/0/1/0/0 | 1.6 s | expected control failure: `ERR_ASSERTION` at `zero matching parents (split) must exit 1, got 0` (bypass assertion, not a loader failure) |
| Full tests/check-test-lane-coverage.test.mjs, baseline (unchanged base in scratch copy) | 0 | 12/12/0/0/0 | 11.7 s | baseline |
| Full tests/check-test-lane-coverage.test.mjs, final | 0 | 13/13/0/0/0 | 16.0 s | green |
| node scripts/check-test-lane-coverage.mjs | 0 | n/a: "all 940 test files are reachable from GitHub Actions" | <2 s | green |
| tsc --project tsconfig.vps.json | 0 | n/a | 38.5 s | green |

No regressions observed.

## Setup

- `node --version` -> v22.23.4 (exit 0)
- `npm ci` -> exit 1 (EUSAGE: repository has no package-lock.json; it pins pnpm and ships pnpm-lock.yaml)
- `pnpm install --frozen-lockfile` (pnpm 11.19.0, repository lockfile) -> exit 0
- `apt-get update` -> exit 0; `apt-get install -y postgresql-17` -> exit 100 (package not in distro repositories)
- Adding the PostgreSQL apt repository: key download exit 22 (egress proxy refused the host); `apt-get install -y postgresql-17` -> exit 100. The repository entry was removed again.
- Fallback: PostgreSQL 16.15 at `/usr/lib/postgresql/16/bin` (initdb and pg_ctl present); PG_BIN set to it. This task's tests do not start a cluster.
- `id builder` -> exit 0 (existing account); `test -x node_modules/.bin/tsx` -> 0; parent SHA check -> 0
- `mkdir -p .test-tmp`; `chown -hR builder:builder "$PWD"` -> 0; restored with `chown -hR root:root "$PWD"` before Git and scans.

## Cleanup

- Scratch copy `.test-tmp/selfcheck-split-revert` (dependencies symlinked, nothing downloaded) removed.
- No processes owned by builder remained (`pgrep -u builder` found none). No PostgreSQL cluster was started. cleanedUp=true, leftovers=0.

## Limitations

- PostgreSQL 17 was unavailable; 16.15 was used. Not exercised by these tests.
- The private-name check ran without a list and is SKIP, not a full privacy pass; the lead must run configured CI privacy checks.
- Pattern flags placed after the test file are not seen by the child and are not applied by Node; the helper does not (and cannot from execArgv) see them. Recorded only.
- `--test-skip-pattern` interaction is out of scope and unchanged.

## Scans (as root after ownership restore)

- Secret-pattern scanner on the three changed paths: `secret-scan files=3 findings=0` (exit 0)
- Private-name guard without a list: `private-name check skipped: no list configured` (exit 0, SKIP)
- `git diff --check`: exit 0
