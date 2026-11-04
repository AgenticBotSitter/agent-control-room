# cluster-quit-oracle-diagnostics: make quit-before-kill regressions fail with explicit signal evidence

Read this file and do exactly this task.

## Goal and base

Make quit-before-kill regressions fail with explicit signal evidence.

- Kind: unit/guard test hardening; expected effort: 30–60 minutes.
- Publish/clone base: cloud-base/cluster-quit-oracle-diagnostics.
- Existing source branch: cook/b5-first-website at 9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3.
- This base adds only this task file in one documentation commit above that exact source SHA.
- Output: push only cloud/cluster-quit-oracle-diagnostics; no PR, no merge.

## Evidence and frozen scope

Both signal-order tests read signals.log before checking its existence. A straight-SIGKILL regression fails with ENOENT rather than a named ordering assertion. The helper's isAlive/quitGraceMs seams also lack an adjacent explanation of their test-only purpose; a bare kill-0 seam must not be mistaken for production PID custody verification.

All required bodies below are pure unit tests, synthetic process tests or embedded PGlite tests. They require no native PostgreSQL version, cluster or PG_BIN. A bundled PGlite engine is acceptable; it is not a native PostgreSQL 17 installation. Do not run an ordinary native Postgres lane or enable a packet/native gate for this task.

## Allowed files

- tests/disposable-cluster-quit-before-kill.test.mjs.
- tests/helpers/disposable-postgres-cluster.ts.
- docs/cloud-tasks/cluster-quit-oracle-diagnostics-findings.md (evidence).

Read relevant production modules and existing tests for context. The helper change is limited to explanatory comments; its runtime behavior must remain unchanged.

## Work

Add explicit existence assertions before both signal-log reads with a unique SIGQUIT-before-SIGKILL message. Preserve the actual logged sequence, exit signal, elapsed grace and socket-directory assertions. Add comments adjacent to the helper's options explaining that isAlive and short quitGraceMs are test-only seams for sandboxed ps restrictions and that default production-shaped custody still uses isPostmasterAlive. Do not change the helper's stop behavior, signal targets, custody predicate or timeouts. Confirm all stub children are awaited in success and failure teardown; make failure cleanup await the owned child close event if it currently does not. This suite uses synthetic Node stubs only; never start a PostgreSQL server.

## Red test or exact reproduction

In a copied graph replace the graceful-quit attempt with the old immediate-SIGKILL path. Both cases must fail with the new named assertion (ERR_ASSERTION), never ENOENT, and all owned stub children must still be reaped. Restore and require both original cases green. Do not accept a parser error or fixture setup failure as the negative control.

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
if test "$(git branch --show-current)" != cloud/cluster-quit-oracle-diagnostics; then
  git switch -c cloud/cluster-quit-oracle-diagnostics
fi
mkdir -p .test-tmp
```

Record starting HEAD before commits. The parent check applies to the single published task-document commit. A scheduled worker may already be on cloud/cluster-quit-oracle-diagnostics; never force/recreate it. Do not set Git identity or safe.directory. If uid/ownership prevents normal Git operation, report the blocker without changing identity.

Baseline and final focused run (new tests join this selection as implemented):

```sh
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^stopCluster' tests/disposable-cluster-quit-before-kill.test.mjs
```

Broader relevant regression run after the focused tests and controls pass:

```sh
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/disposable-cluster-quit-before-kill.test.mjs
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node_modules/.bin/tsc --project tsconfig.vps.json --noEmit
```

The broader command runs the ordinary module. Any pre-existing gated native body must remain disabled and be recorded explicitly as outside this task, never as required passing coverage. TypeScript's VPS project excludes most tests: its pass is only a production regression check, not proof that edited test code was typechecked. Executed focused bodies and runtime assertions are the primary evidence.

Use serial foreground commands with generous bounded tool timeouts (up to 15 minutes per invocation, 90 minutes overall). Stop on the first unexpected failure. Capture command, actual exit, elapsed time and tests/pass/fail/skipped/cancelled counts. Verify all named selected bodies execute; Node zero-match green is a failure. Report expected negative-control failures separately. Missing Node/dependencies are BLOCKED, never an excuse to fetch, install or replace required execution with a skip.

## Done criteria

Both signal tests have discriminating named failures for the old behavior, original ordering/grace assertions remain, test seam limits are documented and no stub children remain.

Only allowlisted implementation/test paths and the findings file change. No package/lockfile, workflow, schema, migration, runtime security policy or unrelated assertions may change. Helper comments and owned test teardown are the only non-assertion changes permitted.

## Repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and applicable AGENTS.md. This assignment supersedes the historical public-claim workflow: one task, output only cloud/cluster-quit-oracle-diagnostics, no PR, no merge. No external/private specification or report is required.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses, including copied-graph controls. No real model/agent CLI/paid call, login, browser account, deployment, remote request, live install or live port. Synthetic test processes and in-memory handlers are allowed; any listener already used by a selected fixture must be disposable, local to this clone and closed by its teardown. Do not start native PostgreSQL at all.

Never open credential files, client home/settings folders, environment files, auth stores or secret lists. Do not print inherited environment values. Synthetic fixture repositories may use their existing fixture identity setup; never change this clone's configured user.name/user.email or author/committer environment variables. No secrets, personal/private names, private host identifiers, workstation paths, private report references or session URLs in repository files, logs retained in Git or commits. Do not import external reports.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp. Register cleanup before fallible operations. Stop and await every child/server you start, release barriers/listeners, remove only your scratch, and record zero owned leftovers. Never signal unrelated processes, clear shared memory, kill a live service or touch another checkout. Do not weaken refusal checks, remove quarantine or disguise skipped/native bodies as coverage.

## Evidence, scans and submission

Write docs/cloud-tasks/cluster-quit-oracle-diagnostics-findings.md early and update progressively. Include starting and implementation-base SHAs, changes, exact commands/exits/counts/durations, intended red assertions, restoration, unrun steps, cleanup and limitations. Keep all evidence bounded and synthetic. A ready task document does not claim its tests have already run.

Run the repository scanners on exactly the changed allowlist:

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/disposable-cluster-quit-before-kill.test.mjs","tests/helpers/disposable-postgres-cluster.ts","docs/cloud-tasks/cluster-quit-oracle-diagnostics-findings.md"]; const m=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(m.length,0,JSON.stringify(m)); console.log("RESULT secret-scan files="+files.length+" findings="+m.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name guard is an explicit SKIP (configured=0/scanned=0), not a full private-name pass. Do not load or invent a secret list. The lead must run configured privacy CI before integration.

Stage only the changed allowlisted paths, inspect the diff and commit with the environment's configured identity on cloud/cluster-quit-oracle-diagnostics. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove an automatic trailer before submission. Push only cloud/cluster-quit-oracle-diagnostics; never push or change cloud-base/cluster-quit-oracle-diagnostics or another branch. No PR, no merge. If push is unavailable, leave the local commit ready and state it. The lead handles review and integration. Final response: output branch, base/result SHAs, actual test counts, controls, limitations, cleanup and findings path.
