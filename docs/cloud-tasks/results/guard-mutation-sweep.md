# Guard mutation sweep

Branch `cloud/guard-mutation-sweep`, cut from `origin/cook/b5-first-website`. This is for review before anything merges.

## Result

- **111 hand mutations** across 11 CI guards. Each mutation was applied alone, the guard's own tests were run, and the guard file was restored byte for byte.
- **First run: 71 caught, 40 survived.**
- **34 of the survivors were real gaps.** Each one now has a small test, committed on its own. One test kills two survivors (C2 and C8), so there are 33 new tests in 33 commits.
- **Final run: 105 caught, 6 survived.** All 6 remaining survivors are equivalent mutants or make the guard stricter. None can let a broken change pass (reasons in the table below).
- **No guard changed.** `git diff origin/cook/b5-first-website -- scripts .github` is empty. Only test files changed, plus this report and the files that reproduce it.

## Findings for the reviewer

1. **A test-name filter that matches nothing still exits 0.** My first sweep ran the lane-shape check through `node --test --test-name-pattern='lane|shape|workflow' tests/verify-mutation-checks.test.mjs`. That pattern matched no subtest, so the command ran zero tests and exited 0 for every mutation. This is the same "lane passes while running zero tests" failure the lead asked about. I found it because LC9 and LC12 could not have survived a real run. I fixed the suite with an exact `^…$` name and reran (`results-rerun.json`). The first-run column below uses the rerun for LC9–LC13. A separate guard against `--test-name-pattern` values that match no test is worth considering. I did not add one, because this task changes tests only.
2. **`assertMutationLaneCoverage` had no negative test.** Every caller passed it the real workflow, so dropping or inverting its checks passed. LC10 and LC11 are now killed by perturbing a parsed copy of the real `ci.yml`.
3. **The quarantine runner could silently stop running files (Q13).** With one quarantined test in a multi-file invocation, a mutant that never ran the other files still passed. Q10, Q11 and Q12 likewise showed that no test ran the runner's or the checker's failure exits.
4. **Ledger fields that only the pinned file carries were unchecked (D4, D5, D7).** The digest is recomputed from the working tree, so an edited pinned `kind`, an edited `order` or a wrong committed `digest` all passed once the matching per-field check was removed.
5. **Private-name guard (PN6, PN10).** Two of its fail-closed paths had no test: a pull-request payload that names only the head repository, and a configured list file that cannot be read. A mutant that turned each into a silent skip passed.
6. **V10 was caught only by a source-text meta-test.** Without `declared manifests name unique, tracked source snippets`, which fails whenever an anchored line changes, the behaviour survived. It is now killed by an all-caught audit test.

## Scope

| Guard (file) | Area | Its own tests |
|---|---|---|
| `scripts/check-test-lane-coverage.mjs` | test-lane coverage, mutation-lane workflow shape | `tests/check-test-lane-coverage.test.mjs`, plus the `the CI job gates verification…` test in `tests/verify-mutation-checks.test.mjs` |
| `scripts/check-test-quarantine.mjs`, `scripts/run-tests-with-quarantine.mjs` | test-lane coverage | `tests/test-quarantine.test.mjs` |
| `scripts/ci/check-test-loaders.mjs` | test-lane coverage (a TS test without tsx runs nothing) | `tests/package-test-loaders.test.mjs` |
| `scripts/ci-path-routing.mjs` | workflow shape (lane skipping) | `tests/ci-path-routing.test.mjs` |
| `scripts/ci/verify-mutation-checks.mjs` | workflow shape (mutation gate) | `tests/verify-mutation-checks.test.mjs` |
| `scripts/ci/check-mutation-manifest-branch.sh` | workflow shape (manifest selection) | `tests/mutation-manifest-branch.test.mjs` |
| `scripts/ci/check-pr-claims.mjs` | workflow shape (PR evidence) | `tests/check-pr-claims.test.mjs` |
| `scripts/ci/check-migration-numbers.mjs` | migrations | `tests/migration-number-check.test.mjs` |
| `scripts/check-migration-changes.mjs` | migrations | `tests/migration-change-check.test.mjs`, `tests/migration-lint-baseline.test.mjs` |
| `scripts/verify-migration-ledger.mjs`, `scripts/generate-migration-ledger.mjs` | migrations | `tests/postgres-production-ledger.test.mjs` |
| `scripts/check-private-names.mjs` | secret / private-name scanning | `tests/private-name-guard.test.mjs` |

Not swept, and why:

- `scripts/check-migration-search-path.mjs` (privileged-routine `search_path` catalog gate). **Blocked here.** Its tests need PostgreSQL 17. This container has only PostgreSQL 16. Installing 17 from PGDG the way CI does failed: `curl … https://www.postgresql.org/media/keys/ACCC4CF8.asc` exited 56 with `CONNECT tunnel failed, response 403` from the environment's network policy. Without 17, both test files exit 0 with 4 of 10 tests skipped (`# SKIP needs PostgreSQL 17 binaries`), so any mutation would look like a survivor. I recorded the baseline (`search-path` below) but ran no mutations. Also, the gate's audit logic lives in `tests/support/attack-kit/search-path-audit.ts`, which is test support, not under `scripts/`.
- The component-shard workflow guard (`pnpm run test:ci-component-shards`). Its logic lives inside `tests/ci-component-shards.test.mjs`. Mutating it would mean editing the test, which this task forbids.
- `scripts/ci/verify-runtime-inventory.mjs`, `scripts/ci/affected-tests.mjs` and `scripts/ci/run-scripts-keep-going.mjs` fall outside the four requested areas (supply-chain, test selection, the runner). `scripts/install-private-name-hook.mjs` is a local hook installer, not a CI check.

## Method

- `guard-mutation-sweep/mutations.mjs` lists every mutation as an exact `from` → `to` text replacement. Each anchor must occur exactly once in its file, and the harness refuses one that does not. Kinds are those requested: flip a comparison, drop a required key or check, widen a regex, skip a loop (or part of one).
- `guard-mutation-sweep/run-sweep.mjs` applies one mutation, runs the guard's suite from `guard-mutation-sweep/suites.mjs` with a 600 s timeout, records the exit code (non-zero means caught, 0 means survived), writes the original bytes back, and finally checks that `git status -- scripts` is clean.
- For every caught mutation I checked that the failing subtests are about the mutated behaviour; they are listed in `results-*.json` under `failed`. The one exception was V10 (finding 6), which I treated as a survivor.
- Each new test was confirmed in two ways: it passes on the unmodified guard, and the matching mutation is caught when rerun with `--only <ID>`.
- Every new test is in-process or uses a temporary fixture. None uses the network, wall-clock dates or ports. The new verifier tests take about 1 s each; the rest take milliseconds.

## Every mutation

"First run" is the run before any test was added. "Final run" is the same mutation against the strengthened tests.


#### check-test-lane-coverage

Suite `lane-coverage`: `node --test tests/check-test-lane-coverage.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| LC1 | `scripts/check-test-lane-coverage.mjs` | widen-regex | drop the end lookahead on test-file arguments | caught (exit 1) | caught (exit 1) | — |
| LC2 | `scripts/check-test-lane-coverage.mjs` | widen-regex | any bare word counts as a package-script reference, not only pnpm <name> | caught (exit 1) | caught (exit 1) | — |
| LC3 | `scripts/check-test-lane-coverage.mjs` | flip-comparison | CLI: uncovered.length > 0 -> < 0 (never fails) | **SURVIVED** (exit 0) | caught (exit 1) | `the CLI exits non-zero and names a test file no workflow command reaches` (4099294) |
| LC4 | `scripts/check-test-lane-coverage.mjs` | skip-loop | do not recurse into tests/ subdirectories | caught (exit 1) | caught (exit 1) | — |
| LC5 | `scripts/check-test-lane-coverage.mjs` | skip-loop | ignore keep-going runner package names | caught (exit 1) | caught (exit 1) | — |
| LC6 | `scripts/check-test-lane-coverage.mjs` | skip-loop | do not follow package-script chains | caught (exit 1) | caught (exit 1) | — |
| LC7 | `scripts/check-test-lane-coverage.mjs` | flip-comparison | visited.has -> !visited.has | caught (exit 1) | caught (exit 1) | — |
| LC8 | `scripts/check-test-lane-coverage.mjs` | flip-comparison | block scalar ends at <= indentation -> < (block swallows the next step) | **SURVIVED** (exit 0) | caught (exit 1) | `a block command ends at the next step, so it cannot absorb a sibling's text` (c90c227) |
| LC9 | `scripts/check-test-lane-coverage.mjs` | drop-key | drop the monitoring-load lane from the expected mutation-lane shape | caught (exit 1) | caught (exit 1) | — |
| LC10 | `scripts/check-test-lane-coverage.mjs` | drop-key | stop requiring continue-on-error to be absent on mutation jobs | **SURVIVED** (exit 0) | caught (exit 1) | `a mutation lane job marked continue-on-error is refused` (5e17797) |
| LC11 | `scripts/check-test-lane-coverage.mjs` | skip-loop | skip the per-step unconditional check | **SURVIVED** (exit 0) | caught (exit 1) | `a conditional step inside a mutation lane job is refused` (46c45b6) |
| LC12 | `scripts/check-test-lane-coverage.mjs` | flip-comparison | step timeout bound equal -> notEqual | caught (exit 1) | caught (exit 1) | — |
| LC13 | `scripts/check-test-lane-coverage.mjs` | widen-regex | mutation job key filter widened to any job | **SURVIVED** (exit 0) | **SURVIVED** (exit 0) | none: not a gap. Stricter, not weaker: the widened filter refuses more job names (any key containing mutation-checks); it cannot let a lane through. |

#### test quarantine

Suite `quarantine`: `node --test tests/test-quarantine.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| Q1 | `scripts/check-test-quarantine.mjs` | flip-comparison | future added date: ageDays < 0 -> < -1 (tomorrow accepted) | **SURVIVED** (exit 0) | caught (exit 1) | `a quarantine entry dated tomorrow is refused as a future date` (f00467b) |
| Q2 | `scripts/check-test-quarantine.mjs` | drop-key | accept entries with extra keys as long as the four exist | **SURVIVED** (exit 0) | caught (exit 1) | `a quarantine entry with an extra key is refused` (bbf069c) |
| Q3 | `scripts/check-test-quarantine.mjs` | widen-regex | issue reference unanchored | **SURVIVED** (exit 0) | caught (exit 1) | `an issue must be exactly #<positive number>` (dcb6aed) |
| Q4 | `scripts/check-test-quarantine.mjs` | widen-regex | test identifier no longer pinned to tests/*.test.* | caught (exit 1) | caught (exit 1) | — |
| Q5 | `scripts/check-test-quarantine.mjs` | skip-loop | duplicate detection disabled | **SURVIVED** (exit 0) | caught (exit 1) | `a test quarantined twice is refused as a duplicate` (502e48e) |
| Q6 | `scripts/check-test-quarantine.mjs` | drop-key | owner no longer required to be non-blank | **SURVIVED** (exit 0) | caught (exit 1) | `a blank owner is refused` (335d259) |
| Q7 | `scripts/check-test-quarantine.mjs` | flip-comparison | expiry: ageDays > 14 -> > 140 | caught (exit 1) | caught (exit 1) | — |
| Q8 | `scripts/run-tests-with-quarantine.mjs` | skip-loop | affected files are never run | caught (exit 1) | caught (exit 1) | — |
| Q9 | `scripts/run-tests-with-quarantine.mjs` | flip-comparison | runGate: next !== 0 -> === 0 | caught (exit 1) | caught (exit 1) | — |
| Q10 | `scripts/run-tests-with-quarantine.mjs` | flip-comparison | runQuarantined: next !== 0 -> === 0 (report lane always green) | **SURVIVED** (exit 0) | caught (exit 1) | `the quarantined-test report fails when a quarantined test fails` (cfc7e71) |
| Q11 | `scripts/run-tests-with-quarantine.mjs` | flip-comparison | runner: invalid quarantine errors.length > 0 -> < 0 (runs anyway) | **SURVIVED** (exit 0) | caught (exit 1) | `the quarantine runner refuses to run tests under an invalid list` (b19f5a2) |
| Q12 | `scripts/check-test-quarantine.mjs` | flip-comparison | check CLI: errors.length > 0 -> < 0 | **SURVIVED** (exit 0) | caught (exit 1) | `the quarantine check CLI exits non-zero on an invalid list` (7dc91b7) |
| Q13 | `scripts/run-tests-with-quarantine.mjs` | skip-loop | unaffected files are never run | **SURVIVED** (exit 0) | caught (exit 1) | `files with no quarantined test still run, and fail the gate, beside a quarantined file` (f8b6a83) |

#### check-test-loaders

Suite `loaders`: `node --test tests/package-test-loaders.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| L1 | `scripts/ci/check-test-loaders.mjs` | flip-comparison | preload after file accepted: importIndex > fileIndex -> < | caught (exit 1) | caught (exit 1) | — |
| L2 | `scripts/ci/check-test-loaders.mjs` | widen-regex | any --import=<x> accepted as the tsx preload | **SURVIVED** (exit 0) | caught (exit 1) | `an --import= preload of another module cannot replace --import=tsx` (d99f157) |
| L3 | `scripts/ci/check-test-loaders.mjs` | skip-loop | only the first chained invocation is checked | caught (exit 1) | caught (exit 1) | — |
| L4 | `scripts/ci/check-test-loaders.mjs` | drop-key | nested package.json files no longer scanned | caught (exit 1) | caught (exit 1) | — |
| L5 | `scripts/ci/check-test-loaders.mjs` | flip-comparison | JS tests never inspected for TS imports | caught (exit 1) | caught (exit 1) | — |
| L6 | `scripts/ci/check-test-loaders.mjs` | widen-regex | newline no longer separates invocations | caught (exit 1) | caught (exit 1) | — |

#### ci-path-routing

Suite `routing`: `node --test tests/ci-path-routing.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| R1 | `scripts/ci-path-routing.mjs` | flip-comparison | lanes === null -> !== null | caught (exit 1) | caught (exit 1) | — |
| R2 | `scripts/ci-path-routing.mjs` | skip-loop | full suite never sets the lanes | caught (exit 1) | caught (exit 1) | — |
| R3 | `scripts/ci-path-routing.mjs` | widen-regex | name-status code accepts any non-space | caught (exit 1) | caught (exit 1) | — |
| R4 | `scripts/ci-path-routing.mjs` | flip-comparison | empty diff is no longer uncertain | caught (exit 1) | caught (exit 1) | — |
| R5 | `scripts/ci-path-routing.mjs` | drop-key | release class drops the server lane | caught (exit 1) | caught (exit 1) | — |
| R6 | `scripts/ci-path-routing.mjs` | drop-key | rename source path no longer classified | caught (exit 1) | caught (exit 1) | — |
| R7 | `scripts/ci-path-routing.mjs` | flip-comparison | gate runs the lanes that already ran | caught (exit 1) | caught (exit 1) | — |
| R8 | `scripts/ci-path-routing.mjs` | widen-regex | single * crosses directories | caught (exit 1) | caught (exit 1) | — |
| R9 | `scripts/ci-path-routing.mjs` | skip-loop | first-match order reversed | caught (exit 1) | caught (exit 1) | — |
| R10 | `scripts/ci-path-routing.mjs` | drop-key | workflow class drops tests/** | **SURVIVED** (exit 0) | **SURVIVED** (exit 0) | none: not a gap. Equivalent: tests/** then falls through to the unknown class, which also runs the complete suite. Only the reported class name changes. |
| R11 | `scripts/ci-path-routing.mjs` | flip-comparison | a rename line with < 3 fields accepted | **SURVIVED** (exit 0) | **SURVIVED** (exit 0) | none: not a gap. Equivalent for routing: a two-field rename line adds the path "undefined", which is unclassified and still forces the complete suite. |

#### verify-mutation-checks

Suite `verify-mutations`: `node --test tests/verify-mutation-checks.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| V1 | `scripts/ci/verify-mutation-checks.mjs` | flip-comparison | verifyEntry accepts multiple matches | **SURVIVED** (exit 0) | **SURVIVED** (exit 0) | none: not a gap. Unreachable: main() and --audit-all both check that every anchor matches exactly once before verifyEntry runs, so verifyEntry never sees a multi-match. |
| V2 | `scripts/ci/verify-mutation-checks.mjs` | drop-key | manifest entries may carry extra fields | caught (exit 1) | caught (exit 1) | — |
| V3 | `scripts/ci/verify-mutation-checks.mjs` | flip-comparison | a nonzero test exit no longer counts as caught | caught (exit 1) | caught (exit 1) | — |
| V4 | `scripts/ci/verify-mutation-checks.mjs` | widen-regex | isInside accepts ../ traversal | caught (exit 1) | caught (exit 1) | — |
| V5 | `scripts/ci/verify-mutation-checks.mjs` | skip-loop | anchor validation visits no manifest | caught (exit 1) | caught (exit 1) | — |
| V6 | `scripts/ci/verify-mutation-checks.mjs` | skip-loop | only the first manifest entry is mutated | **SURVIVED** (exit 0) | caught (exit 1) | `a surviving second entry fails the manifest after a caught first entry` (536e426) |
| V7 | `scripts/ci/verify-mutation-checks.mjs` | drop-key | no clean-tree check after the mutated test | caught (exit 1) | caught (exit 1) | — |
| V8 | `scripts/ci/verify-mutation-checks.mjs` | drop-key | whitespace-only control skipped | caught (exit 1) | caught (exit 1) | — |
| V9 | `scripts/ci/verify-mutation-checks.mjs` | flip-comparison | baseline failures no longer stop the run | caught (exit 1) | caught (exit 1) | — |
| V10 | `scripts/ci/verify-mutation-checks.mjs` | flip-comparison | audit counts caught entries as failures | **SURVIVED** (exit 0) | caught (exit 1) | `maintenance audit passes when every entry is caught` (3f9a121) |
| V11 | `scripts/ci/verify-mutation-checks.mjs` | widen-regex | timeout env accepts any string containing a digit | **SURVIVED** (exit 0) | caught (exit 1) | `a malformed mutation timeout is refused before any test runs` (0a4200b) |
| V12 | `scripts/ci/verify-mutation-checks.mjs` | drop-key | text-only probe control skipped | caught (exit 1) | caught (exit 1) | — |
| V13 | `scripts/ci/verify-mutation-checks.mjs` | flip-comparison | baseline nonzero exit accepted | caught (exit 1) | caught (exit 1) | — |

#### check-mutation-manifest-branch.sh

Suite `manifest-branch`: `node --test tests/mutation-manifest-branch.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| M1 | `scripts/ci/check-mutation-manifest-branch.sh` | flip-comparison | misnamed addition test flipped | caught (exit 1) | caught (exit 1) | — |
| M2 | `scripts/ci/check-mutation-manifest-branch.sh` | widen-regex | refusal diff includes modifications | caught (exit 1) | caught (exit 1) | — |
| M3 | `scripts/ci/check-mutation-manifest-branch.sh` | widen-regex | selection glob recurses into subdirectories | caught (exit 1) | caught (exit 1) | — |
| M4 | `scripts/ci/check-mutation-manifest-branch.sh` | skip-loop | changed manifests not checked for regular blobs | caught (exit 1) | caught (exit 1) | — |
| M5 | `scripts/ci/check-mutation-manifest-branch.sh` | flip-comparison | own manifest emitted only when absent | caught (exit 1) | caught (exit 1) | — |
| M6 | `scripts/ci/check-mutation-manifest-branch.sh` | widen-regex | any 1xxxxx mode is a regular blob | caught (exit 1) | caught (exit 1) | — |
| M7 | `scripts/ci/check-mutation-manifest-branch.sh` | flip-comparison | merge topology trusted for a foreign second parent | caught (exit 1) | caught (exit 1) | — |

#### check-pr-claims

Suite `pr-claims`: `node --test tests/check-pr-claims.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| P1 | `scripts/ci/check-pr-claims.mjs` | widen-regex | any tests/ path resolves as a test file | **SURVIVED** (exit 0) | caught (exit 1) | `a test reference must name a tests/*.test or *.spec file, not any file under tests/` (c1b75e7) |
| P2 | `scripts/ci/check-pr-claims.mjs` | widen-regex | evidence item no longer anchored at line start | caught (exit 1) | caught (exit 1) | — |
| P3 | `scripts/ci/check-pr-claims.mjs` | flip-comparison | missing reference flipped | caught (exit 1) | caught (exit 1) | — |
| P4 | `scripts/ci/check-pr-claims.mjs` | skip-loop | only the first reference in a bullet is checked | **SURVIVED** (exit 0) | caught (exit 1) | `every reference in one bullet is checked, not only the first` (1d7f8bf) |
| P5 | `scripts/ci/check-pr-claims.mjs` | drop-key | ci references never resolved | caught (exit 1) | caught (exit 1) | — |
| P6 | `scripts/ci/check-pr-claims.mjs` | flip-comparison | stray report only when every added path is a report | **SURVIVED** (exit 0) | caught (exit 1) | `an added report is refused even beside ordinary added files` (36bfe82) |
| P7 | `scripts/ci/check-pr-claims.mjs` | widen-regex | any indented key counts as a workflow job | **SURVIVED** (exit 0) | caught (exit 1) | `a key nested inside a job is not a CI job reference` (cb51901) |
| P8 | `scripts/ci/check-pr-claims.mjs` | flip-comparison | body size limit flipped | caught (exit 1) | caught (exit 1) | — |
| P9 | `scripts/ci/check-pr-claims.mjs` | drop-key | src/db change without evidence section accepted | caught (exit 1) | caught (exit 1) | — |
| P10 | `scripts/ci/check-pr-claims.mjs` | widen-regex | named test match accepts a prefix | **SURVIVED** (exit 0) | caught (exit 1) | `a test reference must name the whole test, not a prefix of it` (c81e186) |
| P11 | `scripts/ci/check-pr-claims.mjs` | skip-loop | bullets after the first are ignored | caught (exit 1) | caught (exit 1) | — |

#### check-migration-numbers

Suite `migration-numbers`: `node --test tests/migration-number-check.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| N1 | `scripts/ci/check-migration-numbers.mjs` | widen-regex | five-digit prefix joins a four-digit group | caught (exit 1) | caught (exit 1) | — |
| N2 | `scripts/ci/check-migration-numbers.mjs` | flip-comparison | group.length > 1 -> < 1 | caught (exit 1) | caught (exit 1) | — |
| N3 | `scripts/ci/check-migration-numbers.mjs` | drop-key | only .sql entries counted | caught (exit 1) | caught (exit 1) | — |
| N4 | `scripts/ci/check-migration-numbers.mjs` | skip-loop | no names grouped | caught (exit 1) | caught (exit 1) | — |
| N5 | `scripts/ci/check-migration-numbers.mjs` | flip-comparison | CLI: !result.ok -> result.ok | caught (exit 1) | caught (exit 1) | — |
| N6 | `scripts/ci/check-migration-numbers.mjs` | flip-comparison | CLI: unreadable directory treated as clean | **SURVIVED** (exit 0) | **SURVIVED** (exit 0) | none: not a gap. Equivalent exit code: an unreadable directory returns ok: false, so main() falls through to the duplicate branch and still exits 1. Only the message changes. |
| N7 | `scripts/ci/check-migration-numbers.mjs` | skip-loop | only the first duplicate group reported | caught (exit 1) | caught (exit 1) | — |

#### check-migration-changes

Suite `migration-changes`: `npm exec --yes --package=squawk-cli@2.61.0 -- node --import tsx --test tests/migration-change-check.test.mjs tests/migration-lint-baseline.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| C1 | `scripts/check-migration-changes.mjs` | flip-comparison | shipped edits accepted | caught (exit 1) | caught (exit 1) | — |
| C2 | `scripts/check-migration-changes.mjs` | widen-regex | any 1xxxxx git mode is regular (symlink 120000 accepted) | **SURVIVED** (exit 0) | caught (exit 1) | `a symlink in the base tree's db/migrations is refused even when the working tree is clean` (5980758) |
| C3 | `scripts/check-migration-changes.mjs` | skip-loop | working-tree non-regular entries ignored | caught (exit 1) | caught (exit 1) | — |
| C4 | `scripts/check-migration-changes.mjs` | drop-key | added migrations never linted | caught (exit 1) | caught (exit 1) | — |
| C5 | `scripts/check-migration-changes.mjs` | flip-comparison | squawk nonzero accepted | caught (exit 1) | caught (exit 1) | — |
| C6 | `scripts/check-migration-changes.mjs` | drop-key | squawk exec failure ignored | caught (exit 1) | caught (exit 1) | — |
| C7 | `scripts/check-migration-changes.mjs` | flip-comparison | baseline accepts findings when any remain | caught (exit 1) | caught (exit 1) | — |
| C8 | `scripts/check-migration-changes.mjs` | skip-loop | base tree not scanned for symlinks | **SURVIVED** (exit 0) | caught (exit 1) | `a symlink in the base tree's db/migrations is refused even when the working tree is clean` (5980758) |
| C9 | `scripts/check-migration-changes.mjs` | widen-regex | isMigration accepts any path | **SURVIVED** (exit 0) | **SURVIVED** (exit 0) | none: not a gap. Equivalent: the only caller diffs with the pathspec -- db/migrations, so no path outside db/migrations ever reaches isMigration. |

#### migration ledger

Suite `migration-ledger`: `node --test tests/postgres-production-ledger.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| D1 | `scripts/verify-migration-ledger.mjs` | drop-key | per-file sha256 check removed | caught (exit 1) | caught (exit 1) | — |
| D2 | `scripts/verify-migration-ledger.mjs` | drop-key | entry count check removed | caught (exit 1) | caught (exit 1) | — |
| D3 | `scripts/verify-migration-ledger.mjs` | skip-loop | per-entry loop skipped | caught (exit 1) | caught (exit 1) | — |
| D4 | `scripts/verify-migration-ledger.mjs` | drop-key | kind check removed | **SURVIVED** (exit 0) | caught (exit 1) | `ledger refuses a pinned entry whose kind was changed` (dec01e8) |
| D5 | `scripts/verify-migration-ledger.mjs` | drop-key | digest check removed | **SURVIVED** (exit 0) | caught (exit 1) | `ledger refuses a committed digest that does not match its entries` (56129a9) |
| D6 | `scripts/verify-migration-ledger.mjs` | drop-key | version check removed | **SURVIVED** (exit 0) | caught (exit 1) | `ledger refuses an unknown ledger version` (2897728) |
| D7 | `scripts/verify-migration-ledger.mjs` | drop-key | order-number check removed | **SURVIVED** (exit 0) | caught (exit 1) | `ledger refuses a pinned entry whose order number was edited` (5c9aab0) |
| D8 | `scripts/generate-migration-ledger.mjs` | flip-comparison | empty migration directory accepted | **SURVIVED** (exit 0) | caught (exit 1) | `ledger collection refuses an empty migration directory` (3052ce3) |
| D9 | `scripts/generate-migration-ledger.mjs` | widen-regex | any name containing .sql enters the ledger | **SURVIVED** (exit 0) | caught (exit 1) | `only files ending in .sql enter the ledger` (f45f504) |

#### check-private-names

Suite `private-names`: `node --test tests/private-name-guard.test.mjs`

| ID | File | Kind | Mutation | First run | Final run | Test added (commit) |
|---|---|---|---|---|---|---|
| PN1 | `scripts/check-private-names.mjs` | flip-comparison | fork test flipped | caught (exit 1) | caught (exit 1) | — |
| PN2 | `scripts/check-private-names.mjs` | drop-key | filename matches dropped | caught (exit 1) | caught (exit 1) | — |
| PN3 | `scripts/check-private-names.mjs` | drop-key | content match becomes case-sensitive | **SURVIVED** (exit 0) | caught (exit 1) | `guard matches content whose case differs from both the term and its lowercase` (4e37c98) |
| PN4 | `scripts/check-private-names.mjs` | skip-loop | only the first tracked file scanned | caught (exit 1) | caught (exit 1) | — |
| PN5 | `scripts/check-private-names.mjs` | flip-comparison | GITHUB_ACTIONS check flipped | caught (exit 1) | caught (exit 1) | — |
| PN6 | `scripts/check-private-names.mjs` | flip-comparison | missing head OR base -> AND (fail-open on a missing base) | **SURVIVED** (exit 0) | caught (exit 1) | `a pull request payload without a base repository cannot buy a fork skip` (5844a4c) |
| PN7 | `scripts/check-private-names.mjs` | flip-comparison | absent payload treated as skippable | caught (exit 1) | caught (exit 1) | — |
| PN8 | `scripts/check-private-names.mjs` | flip-comparison | CLI: matches.length === 0 -> >= 0 | caught (exit 1) | caught (exit 1) | — |
| PN9 | `scripts/check-private-names.mjs` | skip-loop | only the first line of each file scanned | **SURVIVED** (exit 0) | caught (exit 1) | `guard scans every line of a file, not only the first` (45de696) |
| PN10 | `scripts/check-private-names.mjs` | drop-key | list file read failure falls back silently | **SURVIVED** (exit 0) | caught (exit 1) | `an unreadable configured list file fails instead of skipping` (f1b85a4) |
| PN11 | `scripts/check-private-names.mjs` | widen-regex | event name printed from any characters | caught (exit 1) | caught (exit 1) | — |
| PN12 | `scripts/check-private-names.mjs` | flip-comparison | no-list repository run passes | caught (exit 1) | caught (exit 1) | — |


Baselines (final run):

| Suite | Command | Exit |
|---|---|---|
| lane-coverage | `node --test tests/check-test-lane-coverage.test.mjs` | 0 |
| lane-shape | `node --test tests/check-test-lane-coverage.test.mjs && node --test --test-name-pattern='^the CI job gates verification on a branch manifest and joins the merge gate$' tests/verify-mutation-checks.test.mjs` | 0 |
| quarantine | `node --test tests/test-quarantine.test.mjs` | 0 |
| loaders | `node --test tests/package-test-loaders.test.mjs` | 0 |
| routing | `node --test tests/ci-path-routing.test.mjs` | 0 |
| verify-mutations | `node --test tests/verify-mutation-checks.test.mjs` | 0 |
| verify-mutations-behavior | `node --test --test-skip-pattern='^declared manifests name unique, tracked source snippets$' tests/verify-mutation-checks.test.mjs` | 0 |
| manifest-branch | `node --test tests/mutation-manifest-branch.test.mjs` | 0 |
| pr-claims | `node --test tests/check-pr-claims.test.mjs` | 0 |
| migration-numbers | `node --test tests/migration-number-check.test.mjs` | 0 |
| migration-changes | `npm exec --yes --package=squawk-cli@2.61.0 -- node --import tsx --test tests/migration-change-check.test.mjs tests/migration-lint-baseline.test.mjs` | 0 |
| migration-ledger | `node --test tests/postgres-production-ledger.test.mjs` | 0 |
| private-names | `node --test tests/private-name-guard.test.mjs` | 0 |
| search-path | `PG_BIN=/usr/lib/postgresql/17/bin node --import tsx --test --test-concurrency=1 --test-timeout=240000 tests/attack-kit-search-path-gate-real-postgres.test.ts tests/attack-kit-search-path-waiver-real-postgres.test.ts` | 0 |

`search-path` exits 0 only because 4 of its 10 tests skip without PostgreSQL 17 (see Scope). `verify-mutations-behavior` is the verifier suite without the source-anchor meta-test, used only for V10.

## Commands and exit codes

Setup:

| Command | Exit |
|---|---|
| `git fetch origin cook/b5-first-website` | 0 |
| `git checkout -B cloud/guard-mutation-sweep origin/cook/b5-first-website` | 0 |
| `pnpm install --frozen-lockfile --ignore-scripts` (pnpm 11.19.0 via corepack, Node v22.23.4) | 0 |
| `curl -sS -L -o /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc` (PostgreSQL 17, as CI installs it) | 56 (proxy 403) |

Sweep (run from the repository root):

| Command | Exit |
|---|---|
| `node docs/cloud-tasks/results/guard-mutation-sweep/run-sweep.mjs --baseline --out results-first.json` (first run, with the misfiltered lane-shape suite) | 0 |
| `node docs/cloud-tasks/results/guard-mutation-sweep/run-sweep.mjs --only LC9,LC10,LC11,LC12,LC13,C1,C2,C3,C4,C5,C6,C7,C8,C9,V10 --out results-rerun.json` (corrected suites) | 0 |
| `node docs/cloud-tasks/results/guard-mutation-sweep/run-sweep.mjs --only <ID>` after each new test (one per commit) | 0 |
| `node docs/cloud-tasks/results/guard-mutation-sweep/run-sweep.mjs --baseline --out results-final.json` (final run) | 0 |

The harness itself exits 0 whenever every guard file was restored. Each mutation's own exit code is in the tables above.

CI's own commands on the changed tests and the repository-level guards, after the last commit:

| Command | Exit |
|---|---|
| `node scripts/run-tests-with-quarantine.mjs --test tests/check-test-lane-coverage.test.mjs tests/ci-path-routing.test.mjs tests/private-name-guard.test.mjs tests/test-file-dynamic-import-guard.test.mjs tests/release-tool.test.mjs tests/migration-number-check.test.mjs tests/install-preflight.test.mjs tests/mac-local-rehearsal-fleet-bringup-sources.test.mjs tests/runtime-inventory-ci.test.mjs` | 0 |
| `node --test tests/check-pr-claims.test.mjs` | 0 |
| `node scripts/run-tests-with-quarantine.mjs --test tests/verify-mutation-checks.test.mjs` | 0 |
| `node scripts/check-test-lane-coverage.mjs` | 0 |
| `node scripts/check-test-quarantine.mjs` | 0 |
| `node scripts/ci/check-migration-numbers.mjs` | 0 |
| `pnpm run test:test-loaders` | 0 |
| `pnpm run check:test-loaders` | 0 |
| `pnpm run test:hygiene` | 0 |
| `npm exec --yes --package=squawk-cli@2.61.0 -- node --test tests/migration-lint-baseline.test.mjs` | 0 |
| `node scripts/ci/verify-mutation-checks.mjs --anchors-only` | 0 |
| `node scripts/run-tests-with-quarantine.mjs --import tsx --test tests/postgres-production-ledger.test.mjs` | 0 |
| `for i in 1 2 3; do node --test tests/check-test-lane-coverage.test.mjs tests/test-quarantine.test.mjs tests/package-test-loaders.test.mjs tests/check-pr-claims.test.mjs tests/postgres-production-ledger.test.mjs tests/private-name-guard.test.mjs \|\| exit 1; done` (repeat-run determinism check, 109 pass each time) | 0 |

`node scripts/check-private-names.mjs` was not run with the real list, because that list is a repository secret. Instead, the added lines were checked by hand for addresses, home or temp paths and session identifiers. None are present.

## Files

- `docs/cloud-tasks/results/guard-mutation-sweep/mutations.mjs`, `suites.mjs`, `run-sweep.mjs`: the sweep, so it can be reproduced.
- `docs/cloud-tasks/results/guard-mutation-sweep/kills.mjs`: the test added, or the reason no test was needed, for each survivor.
- `docs/cloud-tasks/results/guard-mutation-sweep/results-first.json`, `results-rerun.json`, `results-final.json`: raw per-mutation records (exit code, verdict, failing subtests).
