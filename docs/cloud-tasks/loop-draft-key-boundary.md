# loop-draft-key-boundary: lock the 15/16-character draft-key boundary

Read this file and do exactly this task. Add narrow service regression coverage that rejects a 15-character idempotency key before persistence and accepts/replays an otherwise identical 16-character key.

- Publish/clone base: `cloud-base/loop-draft-key-boundary`.
- Existing source branch: `cloud/pack-1` at `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`.
- The published base is that source plus one docs-only commit adding this file. Confirm `git rev-parse HEAD^` equals `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26` and record the actual cloned HEAD. This task needs no external engine, native session or private fixture.
- Output: push to branch `cloud/loop-draft-key-boundary`, open no PR, never merge.

## Reviewed gap and frozen contract

A CLEAN review of the B1b admin/test repairs identified LOW-2: no test covers a draft key shorter than 16 characters. The existing rule is `^[A-Za-z0-9:_-]{16,100}$` in `ImproveControlRoomDeskServiceV1.#loopKey`, called at the start of `saveLoopDraft` in `src/improve-control-room/v1/service.ts`. Migration 0302 independently constrains command keys; a database error does not substitute for the service's `invalid_request` refusal.

`tests/improve-control-room-desk.test.ts` has `loopFixture`, a valid draft/identity/project, `writes()` instrumentation, and tests for exact replay, changed-body conflict, authority and malformed draft bodies. Keep those fixtures and assertions. Add a test named `B1a draft key lower boundary refuses before persistence`: use two fixed synthetic ASCII keys made of allowed characters, assert their literal lengths are exactly 15 and 16, and keep every other input valid. The 15-character call must reject with WebAccessError code `invalid_request`, attempt zero writes compared with the fixture baseline, and leave request/input counts unchanged. An exactly 16-character key must save, return a real request ID, then replay the same request with no new row or write on exact retry. Use count deltas because the fixture already seeds a request. Do not add upper-bound, grammar or unrelated features to this small task.

## Files to touch

- `tests/improve-control-room-desk.test.ts` only for implementation.
- `docs/cloud-tasks/loop-draft-key-boundary-findings.md` for evidence.

Read service.ts and migration 0302 only for context; never commit product or migration changes. No new test file, package entry, helper framework or dependency is needed.

## Red evidence first

For this test-only change, prove the test bites via a temporary mutant before finalizing it: in a disposable clone/copy under `.test-tmp/`, change only the service regex lower bound from 16 to 15, with an exact-one-match assertion. Run the new test against that copied module graph and require a nonzero exit at its `invalid_request`/zero-persistence assertion, not at module loading or fixture setup. A subsequent SQL constraint failure alone does not satisfy the required error code. Restore the original source in the scratch copy and rerun green. Never weaken the production regex, derive the expected boundary from the implementation, or leave any tracked source change in the final commit. Retain the negative-control command and expected failure in findings, not the mutant file.

## Exact Linux test commands

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B1a draft key lower boundary refuses before persistence$' tests/improve-control-room-desk.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-desk.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

Use the first command inside the scratch module graph for mutant/restored controls, with cwd explicitly changed to that copy. Dependencies may be linked from the provisioned checkout; do not download anything. No native PostgreSQL or listener is required; the suite uses its existing embedded database fixture.

## Done criteria

The new selected body executes; 15 characters yield the exact service error with zero persistence; 16 characters save and replay unchanged; the lowered-bound mutant fails for that behavioral assertion and the restored version passes. Existing desk regressions and TypeScript check remain green. Product bytes and persisted rules are unchanged.

## Linux environment and safety

Read `CONTRIBUTOR_HANDBOOK.md`, `CONTRIBUTING.md` and any applicable `AGENTS.md`. This assignment supplies the branch/submission policy; no public claim or PR workflow is required. This is a disposable public product clone, with Node 22, pre-provisioned project dependencies, PostgreSQL 17, `PG_BIN=/usr/lib/postgresql/17/bin`, and `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1`. The setup script creates the unprivileged `builder` account. A line beginning `SETUP:` denotes a setup failure: report it and stop dependent commands. Do not install or download dependencies, tools, browsers or packages. Never use an npm command that fetches a missing executable. Missing prerequisites are BLOCKED, not permission to fabricate passing evidence.

Check setup, from the clone root:

```sh
node --version
test -d node_modules
id builder
test -x /usr/lib/postgresql/17/bin/initdb
test -x /usr/lib/postgresql/17/bin/pg_ctl
git switch -c cloud/loop-draft-key-boundary
mkdir -p .test-tmp
```

The worker starts as root. Before running the task commands, give only this disposable checkout to the existing build account with `chown -hR builder:builder "$PWD"`; do not chown any external path. Do not run initdb as root. Run PostgreSQL tests via `runuser -u builder --` as shown below. Use serial foreground commands with bounded test timeouts. Scratch files may live only in `.test-tmp/` or disposable directories under `/tmp`; remove only task-owned scratch and stop every process/cluster you start. Use existing fixture cleanup and require `cleanedUp=true` and zero leftovers for native runs. Never touch another cluster, the live installation, client ports, protected storage or shared-memory segments manually.

No real models, agent CLIs, paid calls, deployments, account sign-in, credential files, settings stores, environment files, tokens, or remote service access. Do not print inherited environment variables. Keep CLI blocking enabled for every test. All inputs and identities are synthetic. No secrets, private names, personal names, host identities, private report locations or absolute workstation paths in repository files, logs retained in Git, or commit messages. Do not copy external reports into the clone. No dependencies, lockfiles, package scripts, workflow, product code, migration files, schema pins or existing assertions may change unless this task explicitly allows that path. Keep quarantine and existing refusal/security checks intact. No new feature or unreviewed specification is authorized.

## Evidence and submission

After all build-user tests and cleanup complete, return this disposable checkout to its original root ownership with `chown -hR root:root "$PWD"` before root runs Git checks or commits. The `-h` flag keeps symlink targets outside the clone untouched. This avoids Git dubious-ownership errors while preserving the root session's existing configured commit identity; do not change safe.directory or identity settings.

Write `docs/cloud-tasks/loop-draft-key-boundary-findings.md` with the actual starting HEAD, implementation base, changed paths, commands, exits, test/pass/fail/skip/cancel counts, exact expected negative-control failure, restored-green result and cleanup evidence. Keep logs bounded and sanitized. A skip, missing prerequisite, or zero selected tests is not a pass. Record unrelated baseline failures honestly; do not repair outside scope or weaken assertions. Never count an intentionally broken negative control as an ordinary regression failure. Leave no mutant in the committed tree.

Use the repository's existing secret scanner on the changed allowlisted files, with its `runGit` file-list injection (read `scanTrackedSecrets` in `scripts/release-tool.mjs`); assert zero findings. Run the private-name guard without reading or supplying a secret file:

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/improve-control-room-desk.test.ts","docs/cloud-tasks/loop-draft-key-boundary-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
```

The private-name guard's local no-list result is an explicit SKIP: the CI private-name list is unavailable in a public cloud clone. Do not invent a denylist or call this a full privacy pass. The lead's CI must supply the real list before integration.

Use the git identity already configured by the environment. Do not set `user.name` or `user.email`, globally, locally, or per command, and do not override author/committer environment variables. Commit only the named allowlisted test/helper paths and findings file. Do not add a Claude-Session or any session URL trailer to commit messages; if your tooling adds one, amend it out before pushing. Inspect `git log -1 --format=%B` and verify no such trailer remains. Push to branch `cloud/loop-draft-key-boundary`, open no PR, never merge. Push only that output branch; never alter/push the published base. If pushing is unavailable, leave the local commit ready and report that limitation. The lead handles review and integration. Final response: output branch, base and result SHAs, test counts, limitations and findings path.
