# b5-session-cleanup-boundary: cover exact retry deadline and attempt boundaries in session revocation

Read this file and do exactly this task.

## Goal and base

Cover exact retry deadline and attempt boundaries in session revocation.

- Kind: unit/guard test hardening; expected effort: 45–60 minutes.
- Publish/clone base: cloud-base/b5-session-cleanup-boundary.
- Existing source branch: cook/b5-first-website at 9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3.
- This base adds only this task file in one documentation commit above that exact source SHA.
- Output: push only cloud/b5-session-cleanup-boundary; no PR, no merge.

## Evidence and frozen scope

Session revoke uses a 30000 ms budget, strict delay < remaining budget, max(0, delay), and at most three DELETE attempts. Existing tests cover 2/3-second successful retries, a 60-second refusal and persistent 1-second limits, but not exactly 30000 ms, remaining-budget equality after a first retry, zero/past-date clamping, or sequential delays that cross the budget.

All required bodies below are pure unit tests, synthetic process tests or embedded PGlite tests. They require no native PostgreSQL version, cluster or PG_BIN. A bundled PGlite engine is acceptable; it is not a native PostgreSQL 17 installation. Do not run an ordinary native Postgres lane or enable a packet/native gate for this task.

## Allowed files

- tests/improve-control-room-first-website-session.test.ts.
- docs/cloud-tasks/b5-session-cleanup-boundary-findings.md (evidence).

Read relevant production modules and existing tests for context. Production runtime files are read-only.

## Work

Add B5 session cleanup boundary tests with the existing injected clock/wait/fetch seams. Use fake time only: 29999 ms remaining delay accepted, 30000 equality and 30001 refused, integer Retry-After seconds of 29/30/31, a past HTTP date clamped to zero, and a two-response sequence whose second delay equals the remaining budget. Pin <=3 DELETE attempts, exact waits, no DELETE after refusal, close-promise identity/failure reuse, and no new session issuance during cleanup. For 29999 use an HTTP-date relative to a clock offset, since integer seconds cannot encode it; keep HTTP-date millisecond truncation explicit. Dates and cookies must be synthetic. Preserve existing ordinary session tests and public behavior; do not loosen timing or retry policy.

## Red test or exact reproduction

Independently change the strict < comparison to <= and require the equality refusal test to fail; change attempt < 2 to attempt < 3 and require the exact max-attempt assertion to fail; remove the delay clamp and require the past-date wait-zero assertion to fail. Apply exact-one-match edits only in a copied source graph, restore between mutants and rerun selected green.

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
if test "$(git branch --show-current)" != cloud/b5-session-cleanup-boundary; then
  git switch -c cloud/b5-session-cleanup-boundary
fi
mkdir -p .test-tmp
```

Record starting HEAD before commits. The parent check applies to the single published task-document commit. A scheduled worker may already be on cloud/b5-session-cleanup-boundary; never force/recreate it. Do not set Git identity or safe.directory. If uid/ownership prevents normal Git operation, report the blocker without changing identity.

Baseline and final focused run (new tests join this selection as implemented):

```sh
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 CONTROL_ROOM_B5_ASSEMBLY_PG=0 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B5 (session cleanup boundary|controller cleanup)' tests/improve-control-room-first-website-session.test.ts
```

Broader relevant regression run after the focused tests and controls pass:

```sh
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 CONTROL_ROOM_B5_ASSEMBLY_PG=0 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-first-website-session.test.ts
env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 CONTROL_ROOM_B5_ASSEMBLY_PG=0 NODE_ENV=test TMPDIR=/tmp node_modules/.bin/tsc --project tsconfig.vps.json --noEmit
```

The broader command runs the ordinary module. Any pre-existing gated native body must remain disabled and be recorded explicitly as outside this task, never as required passing coverage. TypeScript's VPS project excludes most tests: its pass is only a production regression check, not proof that edited test code was typechecked. Executed focused bodies and runtime assertions are the primary evidence.

Use serial foreground commands with generous bounded tool timeouts (up to 15 minutes per invocation, 90 minutes overall). Stop on the first unexpected failure. Capture command, actual exit, elapsed time and tests/pass/fail/skipped/cancelled counts. Verify all named selected bodies execute; Node zero-match green is a failure. Report expected negative-control failures separately. Missing Node/dependencies are BLOCKED, never an excuse to fetch, install or replace required execution with a skip.

## Done criteria

Actual helper behavior at deadline equality and the third-attempt boundary is proved without wall-clock sleeps; every targeted mutant fails its named assertion and the full ordinary session suite passes with native bodies disabled.

Only allowlisted implementation/test paths and the findings file change. No package/lockfile, workflow, schema, migration, runtime security policy or unrelated assertions may change.

## Repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and applicable AGENTS.md. This assignment supersedes the historical public-claim workflow: one task, output only cloud/b5-session-cleanup-boundary, no PR, no merge. No external/private specification or report is required.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses, including copied-graph controls. No real model/agent CLI/paid call, login, browser account, deployment, remote request, live install or live port. Synthetic test processes and in-memory handlers are allowed; any listener already used by a selected fixture must be disposable, local to this clone and closed by its teardown. Do not start native PostgreSQL at all.

Never open credential files, client home/settings folders, environment files, auth stores or secret lists. Do not print inherited environment values. Synthetic fixture repositories may use their existing fixture identity setup; never change this clone's configured user.name/user.email or author/committer environment variables. No secrets, personal/private names, private host identifiers, workstation paths, private report references or session URLs in repository files, logs retained in Git or commits. Do not import external reports.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp. Register cleanup before fallible operations. Stop and await every child/server you start, release barriers/listeners, remove only your scratch, and record zero owned leftovers. Never signal unrelated processes, clear shared memory, kill a live service or touch another checkout. Do not weaken refusal checks, remove quarantine or disguise skipped/native bodies as coverage.

## Evidence, scans and submission

Write docs/cloud-tasks/b5-session-cleanup-boundary-findings.md early and update progressively. Include starting and implementation-base SHAs, changes, exact commands/exits/counts/durations, intended red assertions, restoration, unrun steps, cleanup and limitations. Keep all evidence bounded and synthetic. A ready task document does not claim its tests have already run.

Run the repository scanners on exactly the changed allowlist:

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/improve-control-room-first-website-session.test.ts","docs/cloud-tasks/b5-session-cleanup-boundary-findings.md"]; const m=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(m.length,0,JSON.stringify(m)); console.log("RESULT secret-scan files="+files.length+" findings="+m.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name guard is an explicit SKIP (configured=0/scanned=0), not a full private-name pass. Do not load or invent a secret list. The lead must run configured privacy CI before integration.

Stage only the changed allowlisted paths, inspect the diff and commit with the environment's configured identity on cloud/b5-session-cleanup-boundary. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove an automatic trailer before submission. Push only cloud/b5-session-cleanup-boundary; never push or change cloud-base/b5-session-cleanup-boundary or another branch. No PR, no merge. If push is unavailable, leave the local commit ready and state it. The lead handles review and integration. Final response: output branch, base/result SHAs, actual test counts, controls, limitations, cleanup and findings path.
