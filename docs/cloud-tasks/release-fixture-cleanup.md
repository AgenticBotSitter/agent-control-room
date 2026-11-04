# release-fixture-cleanup: clean temporary release fixtures when setup fails

Read this file and do exactly this task. Repair failure cleanup in the test fixture setup so a release assembly or staging exception cannot leak its temporary root.

- Publish/clone base: `cloud-base/release-fixture-cleanup`.
- Existing source branch: `cloud/pack-1` at `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`.
- The published base is that source plus one docs-only commit adding this file. Confirm `git rev-parse HEAD^` equals `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`; record actual cloned HEAD. All release operations below use synthetic disposable fixture directories only.
- Output: push to branch `cloud/release-fixture-cleanup`, open no PR, never merge.

## Reviewed gap and frozen contract

A CLEAN review of the pre-PR test fixes identified LOW F1: both files below allocate a temp root inside `releaseSource()`, then register `t.after(rm)` only after releaseSource returns. If assembly, staging or preparation throws, no hook owns that root. `releaseFixtureTemp` deliberately chooses a checkout sibling when TMPDIR is nested because real assembly refuses an output nested in its source tree. Keep that safety rule; the fix belongs in test resource ownership.

At this base the two local releaseSource functions call `releaseFixtureTemp`, mkdir, `assembleLocalReleaseV1`, `stageLocalReleaseV1`, and preparation before returning. Make cleanup ownership begin immediately after successful allocation, before the first setup action can throw. Pass the test context or its cleanup registrar into releaseSource (or allocate/register in the body); remove redundant later registrations. Use the smallest shared helper only if both callers need it. Preserve successful-fixture lifetime until the test's own teardown and preserve the original error object on failure. A full generic resource framework is out of scope.

## Files to touch

- `tests/protected-release-review-native-owner-seam.test.ts`.
- `tests/three-worker-activation-bundle-preflight.test.ts`.
- `tests/helpers/release-fixture-temp.ts`, only if needed to share the narrow test cleanup seam.
- `docs/cloud-tasks/release-fixture-cleanup-findings.md`.

No installer, assembly, staging or production ownership changes. These names say native owner seam, but the tests assert blocked synthetic preparation and do not authorize a real installed owner ceremony.

## Red test first

Add a test named `release fixture setup failures retain cleanup ownership` to an existing allowlisted test file. Use deterministic test-only injection at the local fixture boundary to raise sentinel errors after root allocation in assembly and staging separately, for both consumers. Capture and run the registered cleanup hooks just as teardown would, assert the original error identity, and assert the allocated directory no longer exists. Do not fail the entire test runner via an intentionally failing subtest; catch the synthetic setup exception and explicitly execute the captured cleanup registrar. Before the fix, the missing-registration or remaining-directory assertion must fail. Run and record this red invocation, then implement early ownership and run green. Include a positive case showing a successful setup retains the root until cleanup runs. Ensure injected operations are wired to the same releaseSource path each real test uses; an isolated helper test with unchanged unsafe callers is insufficient. Do not actually corrupt source files, kill a real installer, or perform native activation to induce failure.

Exercise TMPDIR both outside a synthetic repository and nested under it using disposable synthetic directory layouts. Do not change global TMPDIR concurrently across tests. For the nested case require the allocated root to be outside the synthetic repository and then removed; preserve the real assembler's refusal of nested output. Do not delete anything found by prefix scan: cleanup only exact roots allocated by the current fixture.

## Exact Linux test commands

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^release fixture setup failures retain cleanup ownership$' tests/protected-release-review-native-owner-seam.test.ts tests/three-worker-activation-bundle-preflight.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/protected-release-review-native-owner-seam.test.ts tests/three-worker-activation-bundle-preflight.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

The selected regression must run at least once (one shared test is enough if it drives both consumers). Record the same first command before and after the fix, including failed/passed counts. Synthetic layout checks can inject temp-base selection into the test helper; no extra production environment or API. If TMPDIR is deliberately set inside the checkout for an additional real-fixture run, record the exact command and confirm every allocated checkout sibling was removed, without scanning or touching unrelated siblings.

## Done criteria

Both consumers register cleanup before any fallible setup after allocation. Assembly/staging failures preserve the original error and leave zero owned roots. Positive fixture roots live through their test and disappear at teardown for outside/nested temp layouts. Existing owner-seam and activation-preflight assertions pass unchanged. No activation authority or product behavior changes.

## Linux environment and safety

Read `CONTRIBUTOR_HANDBOOK.md`, `CONTRIBUTING.md` and any applicable `AGENTS.md`. This assignment supplies the branch/submission policy; no public claim or PR workflow is required. This is a disposable public product clone, with Node 22, pre-provisioned project dependencies, PostgreSQL 17, `PG_BIN=/usr/lib/postgresql/17/bin`, and `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1`. The setup script creates the unprivileged `builder` account. A line beginning `SETUP:` denotes a setup failure: report it and stop dependent commands. Do not install or download dependencies, tools, browsers or packages. Never use an npm command that fetches a missing executable. Missing prerequisites are BLOCKED, not permission to fabricate passing evidence.

Check setup, from the clone root:

```sh
node --version
test -d node_modules
id builder
test -x /usr/lib/postgresql/17/bin/initdb
test -x /usr/lib/postgresql/17/bin/pg_ctl
git switch -c cloud/release-fixture-cleanup
mkdir -p .test-tmp
```

The worker starts as root. Before running the task commands, give only this disposable checkout to the existing build account with `chown -hR builder:builder "$PWD"`; do not chown any external path. Do not run initdb as root. Run PostgreSQL tests via `runuser -u builder --` as shown below. Use serial foreground commands with bounded test timeouts. Scratch files may live only in `.test-tmp/` or disposable directories under `/tmp`; remove only task-owned scratch and stop every process/cluster you start. Use existing fixture cleanup and require `cleanedUp=true` and zero leftovers for native runs. Never touch another cluster, the live installation, client ports, protected storage or shared-memory segments manually.

No real models, agent CLIs, paid calls, deployments, account sign-in, credential files, settings stores, environment files, tokens, or remote service access. Do not print inherited environment variables. Keep CLI blocking enabled for every test. All inputs and identities are synthetic. No secrets, private names, personal names, host identities, private report locations or absolute workstation paths in repository files, logs retained in Git, or commit messages. Do not copy external reports into the clone. No dependencies, lockfiles, package scripts, workflow, product code, migration files, schema pins or existing assertions may change unless this task explicitly allows that path. Keep quarantine and existing refusal/security checks intact. No new feature or unreviewed specification is authorized.

## Evidence and submission

After all build-user tests and cleanup complete, return this disposable checkout to its original root ownership with `chown -hR root:root "$PWD"` before root runs Git checks or commits. The `-h` flag keeps symlink targets outside the clone untouched. This avoids Git dubious-ownership errors while preserving the root session's existing configured commit identity; do not change safe.directory or identity settings.

Write `docs/cloud-tasks/release-fixture-cleanup-findings.md` with the actual starting HEAD, implementation base, changed paths, commands, exits, test/pass/fail/skip/cancel counts, exact expected negative-control failure, restored-green result and cleanup evidence. Keep logs bounded and sanitized. A skip, missing prerequisite, or zero selected tests is not a pass. Record unrelated baseline failures honestly; do not repair outside scope or weaken assertions. Never count an intentionally broken negative control as an ordinary regression failure. Leave no mutant in the committed tree.

Use the repository's existing secret scanner on the changed allowlisted files, with its `runGit` file-list injection (read `scanTrackedSecrets` in `scripts/release-tool.mjs`); assert zero findings. Run the private-name guard without reading or supplying a secret file:

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/protected-release-review-native-owner-seam.test.ts","tests/three-worker-activation-bundle-preflight.test.ts","tests/helpers/release-fixture-temp.ts","docs/cloud-tasks/release-fixture-cleanup-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
```

The private-name guard's local no-list result is an explicit SKIP: the CI private-name list is unavailable in a public cloud clone. Do not invent a denylist or call this a full privacy pass. The lead's CI must supply the real list before integration.

Use the git identity already configured by the environment. Do not set `user.name` or `user.email`, globally, locally, or per command, and do not override author/committer environment variables. Commit only the named allowlisted test/helper paths and findings file. Do not add a Claude-Session or any session URL trailer to commit messages; if your tooling adds one, amend it out before pushing. Inspect `git log -1 --format=%B` and verify no such trailer remains. Push to branch `cloud/release-fixture-cleanup`, open no PR, never merge. Push only that output branch; never alter/push the published base. If pushing is unavailable, leave the local commit ready and report that limitation. The lead handles review and integration. Final response: output branch, base and result SHAs, test counts, limitations and findings path.
