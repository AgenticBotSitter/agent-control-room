# candidate-null-down: prove retained null sections block rollback atomically

Read this file and do exactly this task. Add regression coverage proving that the real 0305 down migration refuses a retained null-section candidate and preserves the pre-attempt catalog and signed row. This is test-only evidence for an existing rollback safety contract.

- Publish/clone base: `cloud-base/candidate-null-down`.
- Existing source branch: `cloud/pack-1` at `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`.
- The published base is that exact source plus one docs-only commit adding this file. Confirm `git rev-parse HEAD^` equals `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`; record the actual cloned HEAD. No second branch, external packet, engine graph, browser or workstation report is needed.
- Output: push to branch `cloud/candidate-null-down`, open no PR, never merge.

## Reviewed gap and frozen contract

A CLEAN review of the 0305 null-tolerant candidate migration identified LOW-1: the committed tests prove null sections can be retained and empty rollback works, but no committed test proves a retained null-section row refuses the down while preserving the row and tolerant constraint. The mechanism is already in `db/down/0305_control_loop_candidate_unavailable_sections.sql`: transaction, drop tolerant CHECK, add validated strict CHECK, restore old trigger. Do not modify that mechanism.

At this base, `tests/improve-control-room-loop-candidate.test.tsx` contains `B4 a final report missing optional sections records and replays its finish card`, `syntheticFixture`, `f.edit`, `f.publish`, and a 0307 down/re-up test. The PostgreSQL counterpart has independent synthetic seeding and the `run`/`withRealPostgres` cleanup boundary. Reuse these existing fixtures. Set summary, changedAreas, databaseChanges, assumptions, validations and rounds.repairs to null through the existing evidence editor before publishing, so the signed stored row is valid and remains unchanged.

The current schema also includes 0307, which changes the candidate insert trigger. First roll down 0307 using its real file, as the existing 0307 test does, so the starting trigger is truly the 0305 one. Then capture the candidate row (including payload, record_digest and auth_tag), CHECK definition plus convalidated, and trigger function definition. Run the actual 0305 down as the schema owner using the same session. Expect SQLSTATE 23514, then recover the aborted session with ROLLBACK before inspecting state. The row and tolerant, validated CHECK and 0305 trigger must equal the captured state. Prove a fresh connection/session remains usable; close all clients. Do not add an artificial outer transaction that could supply atomicity absent from the down file itself. Do not delete rows, disable triggers, use CASCADE, rewrite signatures or loosen grants to manufacture the outcome.

## Files to touch

- `tests/improve-control-room-loop-candidate.test.tsx`.
- `tests/improve-control-room-loop-candidate-postgres.test.ts`.
- `docs/cloud-tasks/candidate-null-down-findings.md`.

Read the 0305/0307 up/down files, candidate fixture helpers and `tests/support/attack-kit/real-postgres.ts` for context only. Product, migration and ledger files stay byte-identical.

## Red evidence first

Name the new PGlite test `B4 retained null sections refuse 0305 down atomically` and the native test `B4 native retained null sections refuse 0305 down atomically`. First establish green against the unchanged migration, then demonstrate the new test is red against a scratch-only copy of the down SQL that adds `NOT VALID` to the restored strict payload CHECK without adding validation. Pass this mutated SQL through the same execution path used by the test, on a fresh isolated fixture. The intentionally broken down accepts retained nulls; the expected-23514 assertion must fail. Capture that exact assertion and nonzero exit, then restore the real input and run green. Do not mutate tracked migration bytes, re-ledger, swallow the expected failure, or count a missing cluster as a killed mutant. A small test-local SQL-input seam is allowed; no production injection API.

## Exact Linux test commands

After setup, from the clone root, use these serial commands (the native selector must execute exactly one new native body):

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B4 retained null sections refuse 0305 down atomically$' tests/improve-control-room-loop-candidate.test.tsx
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test PG_BIN=/usr/lib/postgresql/17/bin CONTROL_ROOM_PG_TEST_PORT_BASE=60340 TMPDIR=/tmp ATTACK_KIT_RUN_ROOT=/tmp ATTACK_KIT_SOCKET_ROOT=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B4 native retained null sections refuse 0305 down atomically$' tests/improve-control-room-loop-candidate-postgres.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-loop-candidate.test.tsx
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

Run the two focused commands once more only for the deliberate scratch negative control and restoration; record the exact extra invocation/seam used. No full upgrade lane is required: its unrelated fixture failures are outside this task. PostgreSQL binds only disposable fixture ports 60340–60349.

## Done criteria

Both real-input tests run and pass; the scratch NOT VALID-only control fails at the intended assertion; retained row, validated tolerant CHECK and trigger survive the refused real down; all owned native clusters report zero leftovers. Full PGlite candidate regression and TypeScript check pass or have precise unrelated baseline evidence. No native host/engine/product-release qualification is claimed.

## Linux environment and safety

Read `CONTRIBUTOR_HANDBOOK.md`, `CONTRIBUTING.md` and any applicable `AGENTS.md`. This assignment supplies the branch/submission policy; no public claim or PR workflow is required. This is a disposable public product clone, with Node 22, pre-provisioned project dependencies, PostgreSQL 17, `PG_BIN=/usr/lib/postgresql/17/bin`, and `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1`. The setup script creates the unprivileged `builder` account. A line beginning `SETUP:` denotes a setup failure: report it and stop dependent commands. Do not install or download dependencies, tools, browsers or packages. Never use an npm command that fetches a missing executable. Missing prerequisites are BLOCKED, not permission to fabricate passing evidence.

Check setup, from the clone root:

```sh
node --version
test -d node_modules
id builder
test -x /usr/lib/postgresql/17/bin/initdb
test -x /usr/lib/postgresql/17/bin/pg_ctl
git switch -c cloud/candidate-null-down
mkdir -p .test-tmp
```

The worker starts as root. Before running the task commands, give only this disposable checkout to the existing build account with `chown -hR builder:builder "$PWD"`; do not chown any external path. Do not run initdb as root. Run PostgreSQL tests via `runuser -u builder --` as shown below. Use serial foreground commands with bounded test timeouts. Scratch files may live only in `.test-tmp/` or disposable directories under `/tmp`; remove only task-owned scratch and stop every process/cluster you start. Use existing fixture cleanup and require `cleanedUp=true` and zero leftovers for native runs. Never touch another cluster, the live installation, client ports, protected storage or shared-memory segments manually.

No real models, agent CLIs, paid calls, deployments, account sign-in, credential files, settings stores, environment files, tokens, or remote service access. Do not print inherited environment variables. Keep CLI blocking enabled for every test. All inputs and identities are synthetic. No secrets, private names, personal names, host identities, private report locations or absolute workstation paths in repository files, logs retained in Git, or commit messages. Do not copy external reports into the clone. No dependencies, lockfiles, package scripts, workflow, product code, migration files, schema pins or existing assertions may change unless this task explicitly allows that path. Keep quarantine and existing refusal/security checks intact. No new feature or unreviewed specification is authorized.

## Evidence and submission

After all build-user tests and cleanup complete, return this disposable checkout to its original root ownership with `chown -hR root:root "$PWD"` before root runs Git checks or commits. The `-h` flag keeps symlink targets outside the clone untouched. This avoids Git dubious-ownership errors while preserving the root session's existing configured commit identity; do not change safe.directory or identity settings.

Write `docs/cloud-tasks/candidate-null-down-findings.md` with the actual starting HEAD, implementation base, changed paths, commands, exits, test/pass/fail/skip/cancel counts, exact expected negative-control failure, restored-green result and cleanup evidence. Keep logs bounded and sanitized. A skip, missing prerequisite, or zero selected tests is not a pass. Record unrelated baseline failures honestly; do not repair outside scope or weaken assertions. Never count an intentionally broken negative control as an ordinary regression failure. Leave no mutant in the committed tree.

Use the repository's existing secret scanner on the changed allowlisted files, with its `runGit` file-list injection (read `scanTrackedSecrets` in `scripts/release-tool.mjs`); assert zero findings. Run the private-name guard without reading or supplying a secret file:

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/improve-control-room-loop-candidate.test.tsx","tests/improve-control-room-loop-candidate-postgres.test.ts","docs/cloud-tasks/candidate-null-down-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
```

The private-name guard's local no-list result is an explicit SKIP: the CI private-name list is unavailable in a public cloud clone. Do not invent a denylist or call this a full privacy pass. The lead's CI must supply the real list before integration.

Use the git identity already configured by the environment. Do not set `user.name` or `user.email`, globally, locally, or per command, and do not override author/committer environment variables. Commit only the named allowlisted test/helper paths and findings file. Do not add a Claude-Session or any session URL trailer to commit messages; if your tooling adds one, amend it out before pushing. Inspect `git log -1 --format=%B` and verify no such trailer remains. Push to branch `cloud/candidate-null-down`, open no PR, never merge. Push only that output branch; never alter/push the published base. If pushing is unavailable, leave the local commit ready and report that limitation. The lead handles review and integration. Final response: output branch, base and result SHAs, test counts, limitations and findings path.
