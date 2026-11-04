# selfcheck-load-lanes: fail when a load flag disappears

Read this file and do exactly this task. Repair the two load-lane self-checks so a lane cannot pass after losing its enabling environment flag. This is test infrastructure only; no product behavior changes.

- Base branch to publish/clone: `cook/mutation-lane-selfcheck`.
- Expected implementation tip before documentation packaging: `b2561e2f9` (descendant of `e6dacd39e17196964add00c4cfa463fb2dc149dc`). The lead must put this task document on that base before starting the session. Do not start from `cloud/pack-1` alone: it lacks the shared helper.
- Output: push to branch `cloud/selfcheck-load-lanes`, open no PR, never merge.
- Ready for implementation once that base and this task file are published together. No new feature spec is required.

## Exact reviewed requirement, sanitized excerpt

> MEDIUM 1 - the two load-lane self-checks are disarmed by the same gate they are meant to protect.
> tests/improve-control-room-loop-monitoring.test.tsx:275 if(!ordinary)assertMutationLaneSelection([loadLane]);
> tests/improve-control-room-loop-finalization.test.tsx:875 if(process.env.CONTROL_ROOM_B3C_LOAD==="1")assertMutationLaneSelection([loadLane]);
> tests/helpers/mutation-lane-selfcheck.ts:33 if (pattern !== undefined) { ... } (no pattern -> no selection check)
>
> Deleting or renaming the env var in the lane script (or any future CI-side change to it) means the parent
> is never registered and the assertion is never called, so the helper's selection logic - the only thing that
> can detect a pattern that matches nothing - does not run at all.
>
> Suggested shape: call the assertion unconditionally when a pattern
> is present (export the pattern-detection from the helper, e.g. pass {required:true} or have the helper fail
> when a pattern exists and a lane registered nothing), so "pattern set but lane not registered" is a failure
> rather than a no-op. Small, local, no behaviour change for renames.

The defect has been reproduced: omitting `CONTROL_ROOM_B3B_LOAD=1` with the monitoring load pattern, or `CONTROL_ROOM_B3C_LOAD=1` with the finalization load pattern, yields exit 0 without running the intended parent. The helper currently defers Node test registration until after module-load validation, checks unique/expected parents, requires exactly one selected lane and the full parent set, and checks executed probes. Preserve all of that behavior. Ordinary unpatterned file runs must still work without load flags; do not demand load registration during those runs. Candidate source/UI/SQL selection already uses the same helper and must keep its existing counts and behavior.

## Files to touch

- `tests/helpers/mutation-lane-selfcheck.ts` only if a small helper adjustment is needed.
- `tests/improve-control-room-loop-monitoring.test.tsx` and `tests/improve-control-room-loop-finalization.test.tsx`: fix validation invocation independently of the enable flag.
- `tests/check-test-lane-coverage.test.mjs`: add bounded child-process regression tests here; it is already reachable from CI. You may add one synthetic fixture under `tests/fixtures/mutation-lane-selfcheck/` if needed, and remove it in cleanup if it is only scratch.

No workflow, package script, timeout, quarantine, product source, migration, dependency, or unrelated file edits. Static package-script contracts are a separate task and must not be pulled into this repair.

## Red test first

Add child-process tests that invoke the two real test modules with each load lane's exact name pattern, `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1`, and an environment copy with its load flag explicitly deleted (do not rely on the parent shell being unset). Assert a normal nonzero exit, a selection/registration error, no `Mutation lane:` success line, and no timeout/signal failure. Both new assertions must fail against the unchanged base because the child exits 0. Record that red result before implementing the repair. Use a bounded `spawnSync` timeout and `process.execPath`; remove `NODE_TEST_CONTEXT` from nested child environments, as the existing quarantine runner does. Never print the child environment.

Required negative commands, from repository root (each must exit 1 after the fix; exit 0 is the original bug):

```sh
env -u CONTROL_ROOM_B3B_LOAD -u CONTROL_ROOM_B3C_LOAD -u CONTROL_ROOM_B3C_REQUIRE_A2 -u CONTROL_ROOM_B3C_REQUIRE_DESTRUCTIVE CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern="^B3b product collector contention$" tests/improve-control-room-loop-monitoring.test.tsx
env -u CONTROL_ROOM_B3B_LOAD -u CONTROL_ROOM_B3C_LOAD -u CONTROL_ROOM_B3C_REQUIRE_A2 -u CONTROL_ROOM_B3C_REQUIRE_DESTRUCTIVE CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern="^B3c 24 finalizers retain once and refuse destruction$" tests/improve-control-room-loop-finalization.test.tsx
```

Do not convert the expected nonzero exits into an unconditional green shell result. Record each actual exit and diagnostic. For parent-renaming and multi-selection checks, use a tiny fixture with the real helper (no clone or database needed); retain/extend existing expected-parent and expected-probe negatives. Assert ordinary execution without a name pattern remains successful.

## Green verification commands

```sh
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --test tests/check-test-lane-coverage.test.mjs
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 npm run test:improve-control-room-loop-monitoring-load
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 npm run test:improve-control-room-loop-finalization-load
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 tests/improve-control-room-loop-monitoring.test.tsx tests/improve-control-room-loop-finalization.test.tsx
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 npm run test:improve-control-room-loop-candidate-mutations:source
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 npm run test:improve-control-room-loop-candidate-mutations:ui
node scripts/check-test-lane-coverage.mjs
npm run check
```

Clear inherited load/installed-proof flags before the ordinary full-file command. Those ordinary suites intentionally skip separately gated installed-engine evidence; record those skips and do not claim installed qualification. The candidate source lane baseline is 17 tests (two parents + 15 probes), and UI baseline is 5 (two parents + 3 probes); both have two selected parents. Each positive load lane must execute its one intended parent and emit `Mutation lane: selected=24/24` with the exact parent name. If a baseline prerequisite blocks a candidate command, retain the failure and report it, while still completing all independent self-check proofs. SQL mutation lanes are outside scope: do not invoke their re-ledger/private prerequisites or claim native-PG coverage.

## Done criteria

The two real missing-flag negatives fail at module load before scratch engine or collector/finalizer work; both enabled lanes still run exactly 24 participants; ordinary unpatterned runs and candidate helper consumers retain their prior behavior. Rename, partial/over-selection and probe-count drift cannot pass. New regression tests are reachable in CI and verify behavior through child exits. No timeout/quarantine/count relaxation. Required checks, privacy review and exact evidence are recorded. Commit the complete repair and push only the output branch above. No PR, never merge.

## Rules and boundaries

This is an authorized, disposable cloud build in the public product repository. Read `CONTRIBUTOR_HANDBOOK.md`, `CONTRIBUTING.md`, and any applicable `AGENTS.md` before editing. This task supplies the branch and submission policy for this session. No PR, comment, merge, deployment, live install, real model launch, paid call, account sign-in, or credential-file access is authorized. Run only synthetic test fixtures. Never read client settings, login stores, environment files, tokens, or credentials. Do not print inherited environment variables. Do not add secrets, private context, personal names, host identities, or absolute workstation paths to source, commits, test output retained in Git, or reports. Synthetic fixtures only. Keep existing quarantine, timeouts, counts, security assertions and independent review requirements intact. Do not install new project dependencies or change the lockfile.

The remote commit identity must already be `Control Room Worker <worker@localhost>`. Verify it with `git var GIT_AUTHOR_IDENT` and `git var GIT_COMMITTER_IDENT`; if it differs, stop and report the setup mismatch to the lead. Never change `user.name` or `user.email`. Commit on the session's working branch, then push to the output branch specified below; open no PR, never merge. Stop and clean up every process, child, scratch directory and temporary database you start. Keep the final Git tree clean. If a prerequisite is missing or a command fails, report the exact command, exit and bounded error; do not relabel it as passing.

## Linux session setup

Use a disposable Debian/Ubuntu Linux worker with sudo and outbound package access. These are setup commands for the cloud session, not a request to provision any other machine. Run as a non-root user (PostgreSQL `initdb` refuses root). If the session starts as root, have its environment provide an unprivileged build user before running tests. All tests run from the repository root. Node must be 22.13 or newer within major 22; PostgreSQL must be major 17. Python 3 is also required by the existing synthetic engine fixtures; no private engine source is needed.

If Node 22 and PostgreSQL 17 are not installed, install them in this disposable session:

```sh
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg git python3 build-essential postgresql-common
sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor | sudo tee /etc/apt/keyrings/nodesource.gpg >/dev/null
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' | sudo tee /etc/apt/sources.list.d/nodesource.list >/dev/null
sudo /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y
sudo apt-get update
sudo apt-get install -y nodejs postgresql-17 postgresql-client-17
```

Then prepare the existing lockfile dependencies (no dependency or lockfile edits):

```sh
node -e 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==22 || minor<13 || process.getuid()===0) process.exit(1)'
export PG_BIN=/usr/lib/postgresql/17/bin
"$PG_BIN/postgres" --version
/usr/bin/python3 --version
mkdir -p .test-tmp/cloud-bin
corepack enable --install-directory "$PWD/.test-tmp/cloud-bin"
export PATH="$PWD/.test-tmp/cloud-bin:$PATH"
corepack prepare pnpm@11.19.0 --activate
pnpm install --frozen-lockfile --ignore-scripts
export CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1
```

If the Node distribution lacks Corepack, install only the pinned package manager with `npm install --prefix .test-tmp/cloud-package-manager --no-save --package-lock=false --ignore-scripts pnpm@11.19.0` and prepend `$PWD/.test-tmp/cloud-package-manager/node_modules/.bin` to PATH instead. This is session tooling, not a project dependency. Do not use `npm install` at the repository root. These task lanes use the repository's PGlite/synthetic fixtures rather than private native-database wrappers, a real provider, or the installed product. Installing PostgreSQL 17 makes `PG_BIN` portable; it does not turn these scoped tests into native-PG release qualification.

## Privacy and evidence before submission

Stage only authorized changed files. Run `git diff --cached --check` and `node scripts/check-private-names.mjs`, which is the private-name guard used by CI. The guard scans tracked files, so new files must be staged first. A real private-name list must be supplied by the lead/session through `CONTROL_ROOM_PRIVATE_NAMES` or `CONTROL_ROOM_PRIVATE_NAMES_FILE`; never copy a list into Git or inspect credential files to find one. A public cloud clone normally has no repository-secret list. If absent, preserve the scanner's skip/failure message and report the full denylist check as unavailable; do not invent a substitute and call it a clean CI scan. Run an additional diff review for private paths/context, private keys, API keys, passwords, authenticated connection strings, private hostnames and tokens; print locations/categories only, never values. A configured-list pass and an unavailable-list result are distinct evidence.

For each required command record exit, test/pass/fail/cancelled/skipped counts, and the nonzero participant/probe count where applicable. A lane reporting success without its expected `Mutation lane:` line is a failure. Report any unrelated baseline failures separately; do not widen this task to fix them. The final response names the commit SHA, actual base SHA, changed files, evidence and remaining setup/acceptance limitations. The lead performs independent review and release qualification.
