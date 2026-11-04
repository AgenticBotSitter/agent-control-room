# b5-device-file-custody: cover direct private file size and hard-link custody boundaries

Read this file and do exactly this task.

## Goal and base

Exercise readB5DeviceFileV1 directly at its exact cap and single-link/private-mode refusal boundaries.

- Kind: coverage gap; expected strong-builder effort: 45–75 minutes.
- Publish/clone base: cloud-base/b5-device-file-custody.
- Existing source branch: cook/b5-first-website at 2e91e867c20cb5a0ab8b8ddff41402f75c9f4041.
- This published base adds only this task file in one documentation commit above that SHA.
- Output: push only cloud/b5-device-file-custody; no PR, no merge.

## Evidence and frozen scope

PR 510 device custody() requires a regular file, nlink===1, mode 0600, current uid and size <= cap. readB5DeviceFileV1 normalizes unexpected I/O errors while preserving B5DeviceRefusalV1 codes. The unit device suite currently never imports readB5DeviceFileV1; its packet-gated device-postgres consumer reads only nominal files. Existing mailbox/writer tests exercise other paths but do not prove this exported reader's custom-cap boundary or hard-link refusal.

## Allowed files

- tests/improve-control-room-first-website-device.test.ts (implementation).
- docs/cloud-tasks/b5-device-file-custody-findings.md (evidence).

Read relevant production modules and existing tests for context only unless explicitly allowed above.

## Work

Add tests named "B5 device reader exact size boundary" and "B5 device reader refuses hard links and public modes". Use real task-owned files under scratch(t), with explicit chmod rather than umask assumptions. Test cap=32 with 32 bytes accepted byte-for-byte and 33 bytes refused with B5_DEVICE_SIZE. Confirm the default cap accepts exactly 65536 bytes and refuses 65537. Use byte buffers, including a multibyte text example whose byte count differs from string.length; cap is bytes. Do not use giant allocations.

For custody, prove a private single-link file is accepted; create a hard link to another synthetic task-owned file, assert nlink is actually 2 and reject with B5_DEVICE_CUSTODY; remove that link and prove the unchanged original returns to acceptance. Independently chmod a single-link regular file to 0644, assert its actual mode, reject with exact CUSTODY and restore 0600/accept. Cover a missing path with PATH, a symlink with PATH, and an outside-root synthetic sibling with PATH without reading its contents. Never create fixtures in a real client credential/settings folder or point a symlink/hard link at anything outside task-owned scratch. Every test must clean both links/files. Do not manufacture root-only uid mismatches or timing-dependent open races.

## Red test or exact reproduction

Use independent exact-one-match scratch mutants: remove only the stat-size guard (the 33-byte case must still be caught by the post-read size check, so this alone is a defence control, not an expected kill); then remove both size checks and require the new boundary assertion to fail. Separately remove only s.nlink === 1 and require the hard-link assertion to fail, with all other custody inputs valid. Restore and run green after each. Document the two size layers honestly; never claim one surviving layer was killed.

## Exact Linux commands

Complete setup below first. Use these commands unchanged for baseline/final runs; a task's red-first or diagnostic instructions determine when a nonzero result is expected.

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B5 device reader (exact size boundary|refuses hard links and public modes)$' tests/improve-control-room-first-website-device.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp PG_BIN=/usr/lib/postgresql/17/bin node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-first-website-device.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

## Done criteria

Exact byte-boundary and real on-disk custody cases execute with precise error codes. The double-size deletion and link-count deletion die at the intended assertions. Single-layer size defence is recorded accurately. Full device tests pass and only the test/findings files change.

## Environment, repository rules and safety

Read CONTRIBUTOR_HANDBOOK.md, CONTRIBUTING.md and any applicable AGENTS.md. This assignment replaces the historical public-claim workflow and defines the output policy: one task, push only cloud/b5-device-file-custody, no PR, no merge. No external/private specification is needed.

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
if test "$(git branch --show-current)" != cloud/b5-device-file-custody; then
  git switch -c cloud/b5-device-file-custody
fi
mkdir -p .test-tmp
chown -hR builder:builder "$PWD"
```

Record the actual starting HEAD before new commits. The expected parent above is for the published base's single task-document commit. A scheduled worker may already have created the correct output branch; never recreate or force it. Run tests as builder as shown. Do not run initdb as root. Chown only this disposable checkout; -h prevents following symlink targets outside it. After all build-user tests and cleanup, restore the original root ownership with chown -hR root:root "$PWD" before root runs Git checks or commits. Do not change safe.directory or configured Git identity.

Run serial foreground commands with generous but bounded tool timeouts (up to 30 minutes for a full multi-file invocation, subject to a 90-minute whole-task ceiling). Check selected-body counts; Node's zero-match green is not a pass. Capture command, actual exit and tests/pass/fail/skipped/cancelled counts for every run. Loops must stop at the first failure as shown; do not run later dependent green checks after a failure without explaining and verifying cleanup. In a task-owned scratch module graph, the same selected test command is run with cwd at that graph; dependencies may be symlinked from the provisioned checkout. Never download them.

Scratch is limited to task-owned .test-tmp/ directories or disposable /tmp directories. Stop every process/cluster you start; use existing fixture teardown, record cleanedUp=true and zero leftovers for native runs. Remove only your task-owned scratch. Do not manually clear shared memory, kill unrelated processes or touch another cluster. All listeners are disposable synthetic test fixtures in this cloud clone; never connect to a live install, client ports or remote service.

Keep CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 on all test/build subprocesses. No real models, agent CLIs, paid calls, browser/device account operations, deployments or sign-in. Never open credential files, client home/settings folders, environment files or token stores; never print inherited environment variables. Existing synthetic fixture sessions and fixture Git repositories are allowed by the named tests; they do not authorize changing this clone's identity or using real accounts. No secrets, private/personal names, private host identifiers, workstation paths or private report references in repository files, logs retained in Git or commit messages. Do not import external reports. No feature work or unreviewed spec.

## Evidence, scans and submission

Write docs/cloud-tasks/b5-device-file-custody-findings.md early and update it progressively. Record: starting and implementation base SHAs, changed files, actual commands/exits/counts, expected control failures separately from regressions, elapsed durations, unrun steps and why, cleanup evidence and limitations. Keep excerpts bounded and synthetic. Readiness after base publication does not claim these tests have already passed.

Only the allowlisted implementation paths above and that findings file may change. No package/lockfile, workflow, schema, migration, production code or unrelated assertions may change. Verification-only tasks commit only their findings. Do not remove quarantine or weaken security/refusal checks. Preserve original branch refs.

After restoring root ownership, run the repository's secret-pattern scanner on exactly the changed allowlist and the private-name guard without loading a secret list:

```sh
chown -hR root:root "$PWD"
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/improve-control-room-first-website-device.test.ts","docs/cloud-tasks/b5-device-file-custody-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
git status --short
```

A no-list private-name result is SKIP: CI's real private-name list is unavailable locally/in the public clone. Do not invent a list or call this a full privacy pass. The lead must run configured CI privacy checks before integration.

Use only the environment's already configured git identity. Never set user.name/user.email or author/committer variables. Stage only the changed allowlisted paths and findings file, review the diff, and commit on cloud/b5-device-file-custody. Do not add Claude-Session or any session URL trailer; inspect git log -1 --format=%B and remove any automatic trailer before submission. Push only cloud/b5-device-file-custody, open no PR, never merge, and never push/alter cloud-base/b5-device-file-custody. If push is unavailable, leave the local commit ready and report it. The lead handles review and integration. Final response: output branch, base/result SHAs, counts, limitations and findings path.
