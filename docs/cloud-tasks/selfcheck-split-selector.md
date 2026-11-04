# selfcheck-split-selector: close the split-argv mutation self-check bypass

Read this file and do exactly this task.

## Goal and base

Make the existing mutation-lane selector validator recognize Node's two supported argv spellings and preserve all grouped-lane/flag guarantees.

- Kind: test hardening; expected strong-builder effort: 30–60 minutes.
- Publish/clone base: cloud-base/selfcheck-split-selector.
- Existing source branch: origin/cloud/selfcheck-load-lanes at 5416f85b632b7654f3201b4e99413393fa99091b.
- This published base adds only this task file in one documentation commit above that SHA.
- Output: push only cloud/selfcheck-split-selector; no PR, no merge.

## Evidence and frozen scope

The CLEAN cloud-selfcheck review LOW-1 shows assertMutationLaneSelection only finds --test-name-pattern=VALUE. On this exact source branch, the helper still reads process.execArgv.find(startsWith(...)). Node also accepts --test-name-pattern VALUE; that spelling bypasses the helper's zero-match/group checks. The existing coverage test module has subprocess fixture regressions for enabling flags and selection behavior. This task is distinct from the existing selfcheck-load-lanes task: it addresses split argv parsing, not missing enabling flags with equals syntax.

## Allowed files

- tests/helpers/mutation-lane-selfcheck.ts (implementation).
- tests/check-test-lane-coverage.test.mjs (implementation).
- docs/cloud-tasks/selfcheck-split-selector-findings.md (evidence).

Read relevant production modules and existing tests for context only unless explicitly allowed above.

## Work

Extend the helper's existing pattern extraction narrowly to recognize the bare flag followed by its value as well as equals form. Preserve pattern strings including embedded equals signs. Use Node's observed behavior for supported multiple occurrences; do not invent a general argv parser. Keep load/flag requirements, parent/probe counts, enabled-lane rules and the intentionally permitted unmatched pattern when all lanes are disabled unchanged.

In the existing tests/check-test-lane-coverage.test.mjs subprocess tests, add a named regression "mutation lane selectors accept split argv without disarming checks". Exercise the actual helper in synthetic fixtures: equal-form and split-form valid full grouped lane both run expected parent/probe counts; zero matching parents, a partial grouped selection, cross-lane selection, and matching selector with its enabling flag absent must fail exactly as corresponding equals invocations do. Include a pattern with an equals character in a synthetic parent name. Record Node's own handling of a missing pattern value without building custom acceptance for malformed CLI. Test both existing finalization and monitoring helper consumers via their current regression fixture setup; do not run real models or native qualification.

## Red test or exact reproduction

Run the added split-form cases before the helper change and retain the real unexpected-green failure for a missing flag/zero-match check. Fix extraction and run green. Then temporarily restore only the old equals-only extraction in a scratch copy and require the added test to fail again at the bypass assertion, not a loader failure. Do not alter package scripts/workflows or the other pending selfcheck task.

## Exact Linux commands

Complete setup below first. Use these commands unchanged for baseline/final runs; a task's red-first or diagnostic instructions determine when a nonzero result is expected.

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^mutation lane selectors accept split argv without disarming checks$' tests/check-test-lane-coverage.test.mjs
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/check-test-lane-coverage.test.mjs
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/check-test-lane-coverage.mjs
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

## Done criteria

The split spelling enforces the same selection and flag rules as equals form in real subprocesses. A revert of extraction fails the regression; existing coverage guard and tests stay green. Changes remain inside the test helper and existing test module.

## Environment, repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and any applicable AGENTS.md. This assignment replaces the historical public-claim workflow and defines the output policy: one task, push only cloud/selfcheck-split-selector, no PR, no merge. No external/private specification is needed.

The disposable Linux cloud clone runs as root with Node 22, pre-provisioned dependencies, PostgreSQL 17, PG_BIN=/usr/lib/postgresql/17/bin and an existing unprivileged builder account. Do not download or install anything. Do not use an npm/pnpm command that may refresh dependencies or fetch an executable. Missing prerequisites are BLOCKED; do not substitute skipped bodies for a pass.

Run from the clone root, before tests:

```sh
node --version
test -d node_modules
test -x node_modules/.bin/tsx
id builder
test -x /usr/lib/postgresql/17/bin/initdb
test -x /usr/lib/postgresql/17/bin/pg_ctl
test "$(git rev-parse HEAD^)" = 5416f85b632b7654f3201b4e99413393fa99091b
git rev-parse HEAD
if test "$(git branch --show-current)" != cloud/selfcheck-split-selector; then
  git switch -c cloud/selfcheck-split-selector
fi
mkdir -p .test-tmp
chown -hR builder:builder "$PWD"
```

Record the actual starting HEAD before new commits. The expected parent above is for the published base's single task-document commit. A scheduled worker may already have created the correct output branch; never recreate or force it. Run tests as builder as shown. Do not run initdb as root. Chown only this disposable checkout; -h prevents following symlink targets outside it. After all build-user tests and cleanup, restore the original root ownership with chown -hR root:root "$PWD" before root runs Git checks or commits. Do not change safe.directory or configured Git identity.

Run serial foreground commands with generous but bounded tool timeouts (up to 30 minutes for a full multi-file invocation, subject to a 90-minute whole-task ceiling). Check selected-body counts; Node's zero-match green is not a pass. Capture command, actual exit and tests/pass/fail/skipped/cancelled counts for every run. Loops must stop at the first failure as shown; do not run later dependent green checks after a failure without explaining and verifying cleanup. In a task-owned scratch module graph, the same selected test command is run with cwd at that graph; dependencies may be symlinked from the provisioned checkout. Never download them.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp directories. Stop every process/cluster you start; use existing fixture teardown, record cleanedUp=true and zero leftovers for native runs. Remove only your task-owned scratch. Do not manually clear shared memory, kill unrelated processes or touch another cluster. All listeners are disposable synthetic test fixtures in this cloud clone; never connect to a live install, client ports or remote service.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses. No real models, agent CLIs, paid calls, browser/device account operations, deployments or sign-in. Never open credential files, client home/settings folders, environment files or token stores; never print inherited environment variables. Existing synthetic fixture sessions and fixture Git repositories are allowed by the named tests; they do not authorize changing this clone's identity or using real accounts. No secrets, private/personal names, private host identifiers, workstation paths or private report references in repository files, logs retained in Git or commit messages. Do not import external reports. No feature work or unreviewed spec.

## Evidence, scans and submission

Write docs/cloud-tasks/selfcheck-split-selector-findings.md early and update it progressively. Record: starting and implementation base SHAs, changed files, actual commands/exits/counts, expected control failures separately from regressions, elapsed durations, unrun steps and why, cleanup evidence and limitations. Keep excerpts bounded and synthetic. Readiness after base publication does not claim these tests have already passed.

Only the allowlisted implementation paths above and that findings file may change. No package/lockfile, workflow, schema, migration, production code or unrelated assertions may change. Verification-only tasks commit only their findings. Do not remove quarantine or weaken security/refusal checks. Preserve original branch refs.

After restoring root ownership, run the repository's secret-pattern scanner on exactly the changed allowlist and the private-name guard without loading a secret list:

```sh
chown -hR root:root "$PWD"
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/helpers/mutation-lane-selfcheck.ts","tests/check-test-lane-coverage.test.mjs","docs/cloud-tasks/selfcheck-split-selector-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name result is SKIP: CI's real private-name list is unavailable locally/in the public clone. Do not invent a list or call this a full privacy pass. The lead must run configured CI privacy checks before integration.

Use only the environment's already configured git identity. Never set user.name/user.email or author/committer variables. Stage only the changed allowlisted paths and findings file, review the diff, and commit on cloud/selfcheck-split-selector. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove any automatic trailer before submission. Push only cloud/selfcheck-split-selector, open no PR, never merge, and never push/alter cloud-base/selfcheck-split-selector. If push is unavailable, leave the local commit ready and report it. The lead handles review and integration. Final response: output branch, base/result SHAs, counts, limitations and findings path.
