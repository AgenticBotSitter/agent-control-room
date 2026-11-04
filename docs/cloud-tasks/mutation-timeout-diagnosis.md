# mutation-timeout-diagnosis: repeat mutation timeout and process-group cleanup regressions on Linux

Read this file and do exactly this task.

## Goal and base

Determine whether the previously reported mutation timeout kill/EPERM failure reproduces on Linux as an unprivileged builder.

- Kind: diagnosis; expected strong-builder effort: 30–60 minutes.
- Publish/clone base: cloud-base/mutation-timeout-diagnosis.
- Existing source branch: cook/b5-first-website at 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041.
- This published base adds only this task file in one documentation commit above that SHA.
- Output: push only cloud/mutation-timeout-diagnosis; no PR, no merge.

## Evidence and frozen scope

The CLEAN B5 PR-510 CI round-11 review distinguishes a repaired slow 50ms baseline from an older kill EPERM observation. This base uses a fast shell baseline for "a timed-out mutated command restores the file"; neighboring tests exercise timeout process-group kill and background-child cleanup. The review explicitly says the EPERM path was not proved fixed.

## Allowed files

- No implementation changes; findings only.
- docs/cloud-tasks/mutation-timeout-diagnosis-findings.md (evidence).

Read relevant production modules and existing tests for context only unless explicitly allowed above.

## Work

Execute the three exact named tests below 20 times serially as builder, then the complete tests/verify-mutation-checks.test.mjs once if the repetitions are clean. Keep the 50ms timeout and all original process-group/file restoration assertions. Record round, each selected body's counts, exit/signal, intended timeout output, and first failure's bounded stack. Verify no task-owned marker/child process survives each test's cleanup. Do not inspect unrelated system processes or signal a bare PID without proving it belongs to this task.

If EPERM appears, identify which process issued the signal, the intended target group and uid relationships from task-owned reproduction only; distinguish failure to signal from a stale/empty process group and from baseline startup exceeding 50ms. Findings only: no harness/test/product fix, no privilege escalation to make a signal work, no timeout change, no repetition until a green summary. Stop at first failure and state later rounds/full suite were not run.

## Red test or exact reproduction

The historical red is kill EPERM during command termination, not the expected caught timeout or an arbitrary nonzero exit. A 50ms baseline failure is a separate diagnosis. If neither repeats, report the count honestly without calling either permanently fixed.

## Exact Linux commands

Complete setup below first. Use these commands unchanged for baseline/final runs; a task's red-first or diagnostic instructions determine when a nonzero result is expected.

```sh
for round in $(seq 1 20); do
  printf 'round=%s\n' "$round"
  runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^(a timed-out mutated command restores the file|a timeout kills the test command.s whole process group|a normal test-command exit kills its background child)$' tests/verify-mutation-checks.test.mjs
  result=$?
  printf 'RESULT mutation-timeout round=%s exit=%s\n' "$round" "$result"
  test "$result" -eq 0 || break
done
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/verify-mutation-checks.test.mjs
```

## Done criteria

A counted Linux reproduction/non-reproduction with precise failure classification, task-owned cleanup evidence and no code changes.

## Environment, repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and any applicable AGENTS.md. This assignment replaces the historical public-claim workflow and defines the output policy: one task, push only cloud/mutation-timeout-diagnosis, no PR, no merge. No external/private specification is needed.

The disposable Linux cloud clone runs as root with Node 22, pre-provisioned dependencies, PostgreSQL 17, PG_BIN=/usr/lib/postgresql/17/bin and an existing unprivileged builder account. Do not download or install anything. Do not use an npm/pnpm command that may refresh dependencies or fetch an executable. Missing prerequisites are BLOCKED; do not substitute skipped bodies for a pass.

Run from the clone root, before tests:

```sh
node --version
test -d node_modules
test -x node_modules/.bin/tsx
id builder
test -x /usr/lib/postgresql/17/bin/initdb
test -x /usr/lib/postgresql/17/bin/pg_ctl
test "$(git rev-parse HEAD^)" = 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041
git rev-parse HEAD
if test "$(git branch --show-current)" != cloud/mutation-timeout-diagnosis; then
  git switch -c cloud/mutation-timeout-diagnosis
fi
mkdir -p .test-tmp
chown -hR builder:builder "$PWD"
```

Record the actual starting HEAD before new commits. The expected parent above is for the published base's single task-document commit. A scheduled worker may already have created the correct output branch; never recreate or force it. Run tests as builder as shown. Do not run initdb as root. Chown only this disposable checkout; -h prevents following symlink targets outside it. After all build-user tests and cleanup, restore the original root ownership with chown -hR root:root "$PWD" before root runs Git checks or commits. Do not change safe.directory or configured Git identity.

Run serial foreground commands with generous but bounded tool timeouts (up to 30 minutes for a full multi-file invocation, subject to a 90-minute whole-task ceiling). Check selected-body counts; Node's zero-match green is not a pass. Capture command, actual exit and tests/pass/fail/skipped/cancelled counts for every run. Loops must stop at the first failure as shown; do not run later dependent green checks after a failure without explaining and verifying cleanup. In a task-owned scratch module graph, the same selected test command is run with cwd at that graph; dependencies may be symlinked from the provisioned checkout. Never download them.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp directories. Stop every process/cluster you start; use existing fixture teardown, record cleanedUp=true and zero leftovers for native runs. Remove only your task-owned scratch. Do not manually clear shared memory, kill unrelated processes or touch another cluster. All listeners are disposable synthetic test fixtures in this cloud clone; never connect to a live install, client ports or remote service.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses. No real models, agent CLIs, paid calls, browser/device account operations, deployments or sign-in. Never open credential files, client home/settings folders, environment files or token stores; never print inherited environment variables. Existing synthetic fixture sessions and fixture Git repositories are allowed by the named tests; they do not authorize changing this clone's identity or using real accounts. No secrets, private/personal names, private host identifiers, workstation paths or private report references in repository files, logs retained in Git or commit messages. Do not import external reports. No feature work or unreviewed spec.

## Evidence, scans and submission

Write docs/cloud-tasks/mutation-timeout-diagnosis-findings.md early and update it progressively. Record: starting and implementation base SHAs, changed files, actual commands/exits/counts, expected control failures separately from regressions, elapsed durations, unrun steps and why, cleanup evidence and limitations. Keep excerpts bounded and synthetic. Readiness after base publication does not claim these tests have already passed.

Only the allowlisted implementation paths above and that findings file may change. No package/lockfile, workflow, schema, migration, production code or unrelated assertions may change. Verification-only tasks commit only their findings. Do not remove quarantine or weaken security/refusal checks. Preserve original branch refs.

After restoring root ownership, run the repository's secret-pattern scanner on exactly the changed allowlist and the private-name guard without loading a secret list:

```sh
chown -hR root:root "$PWD"
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["docs/cloud-tasks/mutation-timeout-diagnosis-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name result is SKIP: CI's real private-name list is unavailable locally/in the public clone. Do not invent a list or call this a full privacy pass. The lead must run configured CI privacy checks before integration.

Use only the environment's already configured git identity. Never set user.name/user.email or author/committer variables. Stage only the changed allowlisted paths and findings file, review the diff, and commit on cloud/mutation-timeout-diagnosis. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove any automatic trailer before submission. Push only cloud/mutation-timeout-diagnosis, open no PR, never merge, and never push/alter cloud-base/mutation-timeout-diagnosis. If push is unavailable, leave the local commit ready and report it. The lead handles review and integration. Final response: output branch, base/result SHAs, counts, limitations and findings path.
