# bridge-shared-synthetic-fixture: share the split bridge suites' duplicated synthetic fixture

Read this file and do exactly this task.

## Goal and base

Share the split bridge suites' duplicated synthetic fixture.

- Kind: documentation-checked test refactor; expected effort: 60–90 minutes.
- Publish/clone base: cloud-base/bridge-shared-synthetic-fixture.
- Existing source branch: cook/b5-first-website at 9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3.
- This base adds only this task file in one documentation commit above that exact source SHA.
- Output: push only cloud/bridge-shared-synthetic-fixture; no PR, no merge.

## Evidence and frozen scope

The split bridge files duplicate the synthetic Python executable, synthetic() and fixture() setup. The original allows an optional repository and later context hooks; the B2 copy has diverged signatures. A future fixture fix can land in only one half with no drift detection. The suite split exists for memory pressure, so sharing must preserve separate test processes.

All required bodies below are pure unit tests, synthetic process tests or embedded PGlite tests. They require no native PostgreSQL version, cluster or PG_BIN. A bundled PGlite engine is acceptable; it is not a native PostgreSQL 17 installation. Do not run an ordinary native Postgres lane or enable a packet/native gate for this task.

## Allowed files

- tests/improve-control-room-loop-bridge.test.ts.
- tests/improve-control-room-loop-bridge-b2.test.ts.
- tests/helpers/improve-control-room-loop-bridge.ts.
- docs/cloud-tasks/bridge-shared-synthetic-fixture-findings.md (evidence).

Read relevant production modules and existing tests for context. Production runtime files are read-only.

## Work

Extract the common synthetic executable and equivalent fixture construction into tests/helpers/improve-control-room-loop-bridge.ts, imported by both files. First compare both implementations carefully and preserve the superset of repository configuration, observation, setDocumentNames and setBeforeAdmission behavior; keep consumer-specific assertions and helpers local. No production code changes and no eager PGlite/database instance at module scope. Accept TestContext so each caller still registers teardown before writes/spawns and owns its separate root/database. Preserve exact argv/env fixture contracts and optional repository behavior. Add B5 shared bridge fixture focused checks using the same exported helper to prove independent roots, observations and cleanup across two clients. Keep the two test files and CI registration separate. Inspect all callers of synthetic()/fixture() before changing signatures.

## Red test or exact reproduction

Record baseline counts for the six explicitly selected existing tests, then refactor with identical results. Add a negative control that intentionally shares mutable observation state between two helper clients and require the new isolation assertion to fail; independently omit a common required fixture artifact and require a named setup assertion. Restore afterward. Do not run native gates or the entire memory-heavy aggregate lane.

A mutation lives only in a task-owned copied module graph under .test-tmp/ or disposable /tmp. Symlink only provisioned dependencies into that graph if needed. Run the same focused command there, then restore real source bytes and run green. Require the intended assertion/diagnostic and check exact-one-match anchors, restoration and child cleanup. Never alter the real checkout's production guard to claim a kill.

## Exact Linux commands

Run from the disposable clone root. The worker setup already runs npm ci; use its provisioned node_modules, never download or reinstall dependencies/tools. Node 22 is required. Run as the environment's current worker uid: these tests use uid-owned fixtures and need no root-only PostgreSQL account setup or ownership handoff.

```sh
node --version
test "$(node -p 'process.versions.node.split(".")[0]')" = 22
test -d node_modules
test -x node_modules/.bin/tsx
test -x node_modules/.bin/tsc
test "$(git rev-parse HEAD^)" = 9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3
git rev-parse HEAD
if test "$(git branch --show-current)" != cloud/bridge-shared-synthetic-fixture; then
  git switch -c cloud/bridge-shared-synthetic-fixture
fi
mkdir -p .test-tmp
```

Record starting HEAD before commits. The parent check applies to the single published task-document commit. A scheduled worker may already be on cloud/bridge-shared-synthetic-fixture; never force/recreate it. Do not set Git identity or safe.directory. If uid/ownership prevents normal Git operation, report the blocker without changing identity.

Baseline and final focused run (new tests join this selection as implemented):

```sh
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B1b (A2 engine receipts \(unwrapped adapter\)|A2 expect pins$|website intake confirm start status stop$|strict bodies, hashes, lineage and owner refusal$|all seven routes recheck expiry, revocation, project and replay authority$|malicious request bytes stay literal exclusive command-file contents$)|^B5 shared bridge fixture' tests/improve-control-room-loop-bridge.test.ts tests/improve-control-room-loop-bridge-b2.test.ts
```

Broader relevant regression run after the focused tests and controls pass:

```sh
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B1b (A2 engine receipts \(unwrapped adapter\)|A2 expect pins$|website intake confirm start status stop$|strict bodies, hashes, lineage and owner refusal$|all seven routes recheck expiry, revocation, project and replay authority$|malicious request bytes stay literal exclusive command-file contents$)|^B5 shared bridge fixture' tests/improve-control-room-loop-bridge.test.ts tests/improve-control-room-loop-bridge-b2.test.ts
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node_modules/.bin/tsc --project tsconfig.vps.json --noEmit
```

The broader command intentionally repeats the selected cross-file PGlite/synthetic lane after mutations. The native A2 gates and the memory-heavy full files are outside this task. Compare named selected bodies, not file totals. TypeScript's VPS project excludes most tests: its pass is only a production regression check, not proof that edited test code was typechecked. Executed focused bodies and runtime assertions are the primary evidence.

Use serial foreground commands with generous bounded tool timeouts (up to 15 minutes per invocation, 90 minutes overall). Stop on the first unexpected failure. Capture command, actual exit, elapsed time and tests/pass/fail/skipped/cancelled counts. Verify all named selected bodies execute; Node zero-match green is a failure. Report expected negative-control failures separately. Missing Node/dependencies are BLOCKED, never an excuse to fetch, install or replace required execution with a skip.

## Done criteria

One shared fixture implementation serves both consumers, distinct roots/state/teardown remain proved, all six selected existing tests plus new fixture tests run, and no fixture database is created at import time.

Only allowlisted implementation/test paths and the findings file change. No package/lockfile, workflow, schema, migration, runtime security policy or unrelated assertions may change.

## Repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and applicable AGENTS.md. This assignment supersedes the historical public-claim workflow: one task, output only cloud/bridge-shared-synthetic-fixture, no PR, no merge. No external/private specification or report is required.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses, including copied-graph controls. No real model/agent CLI/paid call, login, browser account, deployment, remote request, live install or live port. Synthetic test processes and in-memory handlers are allowed; any listener already used by a selected fixture must be disposable, local to this clone and closed by its teardown. Do not start native PostgreSQL at all.

Never open credential files, client home/settings folders, environment files, auth stores or secret lists. Do not print inherited environment values. Synthetic fixture repositories may use their existing fixture identity setup; never change this clone's configured user.name/user.email or author/committer environment variables. No secrets, personal/private names, private host identifiers, workstation paths, private report references or session URLs in repository files, logs retained in Git or commits. Do not import external reports.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp. Register cleanup before fallible operations. Stop and await every child/server you start, release barriers/listeners, remove only your scratch, and record zero owned leftovers. Never signal unrelated processes, clear shared memory, kill a live service or touch another checkout. Do not weaken refusal checks, remove quarantine or disguise skipped/native bodies as coverage.

## Evidence, scans and submission

Write docs/cloud-tasks/bridge-shared-synthetic-fixture-findings.md early and update progressively. Include starting and implementation-base SHAs, changes, exact commands/exits/counts/durations, intended red assertions, restoration, unrun steps, cleanup and limitations. Keep all evidence bounded and synthetic. A ready task document does not claim its tests have already run.

Run the repository scanners on exactly the changed allowlist:

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/improve-control-room-loop-bridge.test.ts","tests/improve-control-room-loop-bridge-b2.test.ts","tests/helpers/improve-control-room-loop-bridge.ts","docs/cloud-tasks/bridge-shared-synthetic-fixture-findings.md"]; const m=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(m.length,0,JSON.stringify(m)); console.log("RESULT secret-scan files="+files.length+" findings="+m.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name guard is an explicit SKIP (configured=0/scanned=0), not a full private-name pass. Do not load or invent a secret list. The lead must run configured privacy CI before integration.

Stage only the changed allowlisted paths, inspect the diff and commit with the environment's configured identity on cloud/bridge-shared-synthetic-fixture. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove an automatic trailer before submission. Push only cloud/bridge-shared-synthetic-fixture; never push or change cloud-base/bridge-shared-synthetic-fixture or another branch. No PR, no merge. If push is unavailable, leave the local commit ready and state it. The lead handles review and integration. Final response: output branch, base/result SHAs, actual test counts, controls, limitations, cleanup and findings path.
