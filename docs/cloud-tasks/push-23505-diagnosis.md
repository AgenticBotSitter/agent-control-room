# push-23505-diagnosis: reproduce and locate the parked owner-push unique violation

Read this file and do exactly this task.

## Goal and base

Diagnose the previously observed SQLSTATE 23505 in the synthetic CR-E075 subscription lane. Record findings even if it no longer reproduces; do not guess a store/schema repair.

- Kind: diagnosis; expected strong-builder effort: 45–90 minutes.
- Publish/clone base: cloud-base/push-23505-diagnosis.
- Existing source branch: cook/b5-first-website at 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041.
- This published base adds only this task file in one documentation commit above that SHA.
- Output: push only cloud/push-23505-diagnosis; no PR, no merge.

## Evidence and frozen scope

The parked subscription failure was retained in the B5 CI-blockers round-5 build. Its subsequent CLEAN review recorded two diagnostic gaps: the child subscribers use a separate Client without the pool observer, and the observer narrows query overloads. Both test files on this base still log SQLSTATE 23505 in binding(); concurrency CHILD at the child() helper still creates its own Client. Existing named reproductions include "CR-E075 real owner HTTP", "CR-E075 slow and dropped connection", and "CR-E075 stop halfway". The HTTP/browser issues from that old report were separately fixed and are not this task.

## Allowed files

- tests/owner-web-push-subscribe-grant-postgres.test.ts (implementation).
- tests/owner-web-push-subscribe-grant-postgres-concurrency.test.ts (implementation).
- docs/cloud-tasks/push-23505-diagnosis-findings.md (evidence).

Read relevant production modules and existing tests for context only unless explicitly allowed above.

## Work

Run the unmodified two-file lane once, then run the three named concurrency cases separately for 10 serial rounds, stopping the repetitions once a 23505 is captured with its owning test. Use PG17 as builder. Keep the same schema, role grants, assertions, no-retry semantics and ports. Never create a real push subscription or call a delivery provider.

If the violation occurs but its SQL context is absent, add only temporary/test-local error observation on the failing query path, including the CHILD Client when necessary. Preserve pg's invocation semantics with an overload-preserving wrapper (or instrument the specific awaited query), forward every argument, and rethrow the original error. Retain only SQLSTATE, table, constraint, SQL operation and synthetic key relationships; omit passwords, connection strings, endpoint/auth bytes and raw full rows. Run the unchanged assertion again. Compare constraint columns and transaction/interleaving order with src/web-push/v1/postgres-store.ts and the relevant migration; read these files only.

A final committed diagnostic addition is optional only when it is small, test-only, proves the failing path and does not change timings, queries or outcomes. No product or schema fix is authorized. If no violation occurs, report rounds/tests/environment and an honest non-reproduction; do not conclude absence of a race. Make no stress assertion that 23505 is acceptable.

## Red test or exact reproduction

The red reproduction is the original lane's real 23505 or its propagated assertion, not an injected duplicate or generic setup failure. Save the exact failing test, SQLSTATE/constraint and bounded stack when observed. A skip or unavailable PostgreSQL is BLOCKED. Preserve a baseline failure as evidence.

## Exact Linux commands

Complete setup below first. Use these commands unchanged for baseline/final runs; a task's red-first or diagnostic instructions determine when a nonzero result is expected.

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin CONTROL_ROOM_PG_TEST_PORT_BASE=59720 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/owner-web-push-subscribe-grant-postgres.test.ts tests/owner-web-push-subscribe-grant-postgres-concurrency.test.ts
for round in $(seq 1 10); do
  printf 'round=%s\n' "$round"
  runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin CONTROL_ROOM_PG_TEST_PORT_BASE=59720 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^CR-E075 (real owner HTTP|slow and dropped connection|stop halfway)$' tests/owner-web-push-subscribe-grant-postgres-concurrency.test.ts
  result=$?
  printf 'RESULT push-repeat round=%s exit=%s\n' "$round" "$result"
  test "$result" -eq 0 || break
done
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

## Done criteria

A bounded reproducibility table, the exact constraint/query path when observed, and a causal hypothesis clearly separated from proof; or a counted non-reproduction. No production change. All fixture clusters are stopped and leftover counts are recorded.

## Environment, repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and any applicable AGENTS.md. This assignment replaces the historical public-claim workflow and defines the output policy: one task, push only cloud/push-23505-diagnosis, no PR, no merge. No external/private specification is needed.

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
if test "$(git branch --show-current)" != cloud/push-23505-diagnosis; then
  git switch -c cloud/push-23505-diagnosis
fi
mkdir -p .test-tmp
chown -hR builder:builder "$PWD"
```

Record the actual starting HEAD before new commits. The expected parent above is for the published base's single task-document commit. A scheduled worker may already have created the correct output branch; never recreate or force it. Run tests as builder as shown. Do not run initdb as root. Chown only this disposable checkout; -h prevents following symlink targets outside it. After all build-user tests and cleanup, restore the original root ownership with chown -hR root:root "$PWD" before root runs Git checks or commits. Do not change safe.directory or configured Git identity.

Run serial foreground commands with generous but bounded tool timeouts (up to 30 minutes for a full multi-file invocation, subject to a 90-minute whole-task ceiling). Check selected-body counts; Node's zero-match green is not a pass. Capture command, actual exit and tests/pass/fail/skipped/cancelled counts for every run. Loops must stop at the first failure as shown; do not run later dependent green checks after a failure without explaining and verifying cleanup. In a task-owned scratch module graph, the same selected test command is run with cwd at that graph; dependencies may be symlinked from the provisioned checkout. Never download them.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp directories. Stop every process/cluster you start; use existing fixture teardown, record cleanedUp=true and zero leftovers for native runs. Remove only your task-owned scratch. Do not manually clear shared memory, kill unrelated processes or touch another cluster. All listeners are disposable synthetic test fixtures in this cloud clone; never connect to a live install, client ports or remote service.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses. No real models, agent CLIs, paid calls, browser/device account operations, deployments or sign-in. Never open credential files, client home/settings folders, environment files or token stores; never print inherited environment variables. Existing synthetic fixture sessions and fixture Git repositories are allowed by the named tests; they do not authorize changing this clone's identity or using real accounts. No secrets, private/personal names, private host identifiers, workstation paths or private report references in repository files, logs retained in Git or commit messages. Do not import external reports. No feature work or unreviewed spec.

## Evidence, scans and submission

Write docs/cloud-tasks/push-23505-diagnosis-findings.md early and update it progressively. Record: starting and implementation base SHAs, changed files, actual commands/exits/counts, expected control failures separately from regressions, elapsed durations, unrun steps and why, cleanup evidence and limitations. Keep excerpts bounded and synthetic. Readiness after base publication does not claim these tests have already passed.

Only the allowlisted implementation paths above and that findings file may change. No package/lockfile, workflow, schema, migration, production code or unrelated assertions may change. Verification-only tasks commit only their findings. Do not remove quarantine or weaken security/refusal checks. Preserve original branch refs.

After restoring root ownership, run the repository's secret-pattern scanner on exactly the changed allowlist and the private-name guard without loading a secret list:

```sh
chown -hR root:root "$PWD"
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/owner-web-push-subscribe-grant-postgres.test.ts","tests/owner-web-push-subscribe-grant-postgres-concurrency.test.ts","docs/cloud-tasks/push-23505-diagnosis-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name result is SKIP: CI's real private-name list is unavailable locally/in the public clone. Do not invent a list or call this a full privacy pass. The lead must run configured CI privacy checks before integration.

Use only the environment's already configured git identity. Never set user.name/user.email or author/committer variables. Stage only the changed allowlisted paths and findings file, review the diff, and commit on cloud/push-23505-diagnosis. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove any automatic trailer before submission. Push only cloud/push-23505-diagnosis, open no PR, never merge, and never push/alter cloud-base/push-23505-diagnosis. If push is unavailable, leave the local commit ready and report it. The lead handles review and integration. Final response: output branch, base/result SHAs, counts, limitations and findings path.
