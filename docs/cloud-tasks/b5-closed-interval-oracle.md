# b5-closed-interval-oracle: isolate defective-build end-boundary coverage

Read this file and do exactly this task.

## Goal and base

Repair the reviewed closed-interval test oracle so the defective build's end bound is tested with valid intervals and independently of later steps.

- Kind: test hardening; expected strong-builder effort: 45–75 minutes.
- Publish/clone base: cloud-base/b5-closed-interval-oracle.
- Existing source branch: cook/b5-first-website at 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041.
- This published base adds only this task file in one documentation commit above that SHA.
- Output: push only cloud/b5-closed-interval-oracle; no PR, no merge.

## Evidence and frozen scope

The CLEAN B5 closed-interval review LOW-1 identified case 5b. It still sets from=15.5 and to=14.8 in "B5 closed interval 3-6: refusals stay, each next to its green sibling". That is a reversed interval. The real fixture has defective build 14–15 and rejection 16–17. assertRejectionRepairV1.fromHandoff checks ms(s.endedAt)<=ms(c.to); other non-build steps have their own strict closed checks. A malformed interval or uncovered later review must not stand in for testing this end clause.

## Allowed files

- tests/improve-control-room-first-website.test.ts (implementation).
- docs/cloud-tasks/b5-closed-interval-oracle-findings.md (evidence).

Read relevant production modules and existing tests for context only unless explicitly allowed above.

## Work

Keep the existing three named closed-interval regressions and all their assertions. Replace the misleading 5b case with an independently constructed, schema-valid set of closed intervals: one valid interval for the defective build ending just before that build's end, and later valid interval(s) covering every rejection, repair and required fresh code review. No later interval may cover the defective build via fromHandoff's latest-owner-action rule. Use synthetic legal owner actions/interval boundaries if necessary; make their chronology explicit. Assert the journey parses, every interval has from<=to, and all non-build guard prerequisites still pass. Add a same-input positive sibling at exact build-end equality and one just after it.

Prefer a dedicated test named "B5 defective build end bound refuses independently" that calls the exported real guard and requires exact B5_REJECTION_REPAIR/detail "steps outside a closed-browser interval". Keep the direct no-interval test as a guard unit case, but identify it in test comments as schema-unreachable through parsed full-verifier evidence; do not invent a full-verifier claim. No runtime or schema change is authorized.

## Red test or exact reproduction

In a task-owned scratch graph, remove only && ms(s.endedAt) <= ms(c.to) from fromHandoff with an exact-one-match edit. The new before-end case must now fail its intended refusal assertion, while equality/after siblings remain valid. Restore and require green. If another guard refuses the mutant, the fixture is still not isolated: correct the test packet within scope instead of counting that failure as a kill.

## Exact Linux commands

Complete setup below first. Use these commands unchanged for baseline/final runs; a task's red-first or diagnostic instructions determine when a nonzero result is expected.

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B5 (closed interval|defective build end bound refuses independently)' tests/improve-control-room-first-website.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-first-website.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

## Done criteria

A valid and independently isolated before/equal/after boundary matrix, with a genuine end-clause mutant kill and full B5 green. No reversed interval, schema error or later-step refusal is credited to the defective-build clause.

## Environment, repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and any applicable AGENTS.md. This assignment replaces the historical public-claim workflow and defines the output policy: one task, push only cloud/b5-closed-interval-oracle, no PR, no merge. No external/private specification is needed.

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
if test "$(git branch --show-current)" != cloud/b5-closed-interval-oracle; then
  git switch -c cloud/b5-closed-interval-oracle
fi
mkdir -p .test-tmp
chown -hR builder:builder "$PWD"
```

Record the actual starting HEAD before new commits. The expected parent above is for the published base's single task-document commit. A scheduled worker may already have created the correct output branch; never recreate or force it. Run tests as builder as shown. Do not run initdb as root. Chown only this disposable checkout; -h prevents following symlink targets outside it. After all build-user tests and cleanup, restore the original root ownership with chown -hR root:root "$PWD" before root runs Git checks or commits. Do not change safe.directory or configured Git identity.

Run serial foreground commands with generous but bounded tool timeouts (up to 30 minutes for a full multi-file invocation, subject to a 90-minute whole-task ceiling). Check selected-body counts; Node's zero-match green is not a pass. Capture command, actual exit and tests/pass/fail/skipped/cancelled counts for every run. Loops must stop at the first failure as shown; do not run later dependent green checks after a failure without explaining and verifying cleanup. In a task-owned scratch module graph, the same selected test command is run with cwd at that graph; dependencies may be symlinked from the provisioned checkout. Never download them.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp directories. Stop every process/cluster you start; use existing fixture teardown, record cleanedUp=true and zero leftovers for native runs. Remove only your task-owned scratch. Do not manually clear shared memory, kill unrelated processes or touch another cluster. All listeners are disposable synthetic test fixtures in this cloud clone; never connect to a live install, client ports or remote service.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses. No real models, agent CLIs, paid calls, browser/device account operations, deployments or sign-in. Never open credential files, client home/settings folders, environment files or token stores; never print inherited environment variables. Existing synthetic fixture sessions and fixture Git repositories are allowed by the named tests; they do not authorize changing this clone's identity or using real accounts. No secrets, private/personal names, private host identifiers, workstation paths or private report references in repository files, logs retained in Git or commit messages. Do not import external reports. No feature work or unreviewed spec.

## Evidence, scans and submission

Write docs/cloud-tasks/b5-closed-interval-oracle-findings.md early and update it progressively. Record: starting and implementation base SHAs, changed files, actual commands/exits/counts, expected control failures separately from regressions, elapsed durations, unrun steps and why, cleanup evidence and limitations. Keep excerpts bounded and synthetic. Readiness after base publication does not claim these tests have already passed.

Only the allowlisted implementation paths above and that findings file may change. No package/lockfile, workflow, schema, migration, production code or unrelated assertions may change. Verification-only tasks commit only their findings. Do not remove quarantine or weaken security/refusal checks. Preserve original branch refs.

After restoring root ownership, run the repository's secret-pattern scanner on exactly the changed allowlist and the private-name guard without loading a secret list:

```sh
chown -hR root:root "$PWD"
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/improve-control-room-first-website.test.ts","docs/cloud-tasks/b5-closed-interval-oracle-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name result is SKIP: CI's real private-name list is unavailable locally/in the public clone. Do not invent a list or call this a full privacy pass. The lead must run configured CI privacy checks before integration.

Use only the environment's already configured git identity. Never set user.name/user.email or author/committer variables. Stage only the changed allowlisted paths and findings file, review the diff, and commit on cloud/b5-closed-interval-oracle. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove any automatic trailer before submission. Push only cloud/b5-closed-interval-oracle, open no PR, never merge, and never push/alter cloud-base/b5-closed-interval-oracle. If push is unavailable, leave the local commit ready and report it. The lead handles review and integration. Final response: output branch, base/result SHAs, counts, limitations and findings path.
