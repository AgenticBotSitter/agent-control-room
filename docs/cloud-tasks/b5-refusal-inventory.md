# b5-refusal-inventory: cover every retained-refusal producer in the test inventory

Read this file and do exactly this task. Harden the existing refusal-detail drift test so a new bare-expression detail or a new host producer cannot silently escape inventory. Retained verdict behavior already fails closed; this task improves test coverage only.

- Publish/clone base: `cloud-base/b5-refusal-inventory`.
- Existing source branch: `cloud/pack-1` at `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26`.
- The published base is that source plus one docs-only commit adding this file. Confirm `git rev-parse HEAD^` equals `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26` and record actual cloned HEAD. No native packet, browser or engine is required.
- Output: push to branch `cloud/b5-refusal-inventory`, open no PR, never merge.

## Reviewed gaps and frozen contract

A CLEAN review of the refusal-detail change identified three LOWs in `B5 refusal detail label set covers every literal detail the producers pass`:

1. The regex sees only quoted/backtick second arguments. A new `refuse("B5_PROJECT_REMOTE", someVariable)` is invisible.
2. It scans helper and controller but omits `scripts/workflow-journeys/first-website-host.ts`, which can throw `B5RefusalV1` into the controller catch.
3. `literals.size >= 50` does not notice loss of one of the actual protected literals.

At this base that exact test and weaknesses remain in `tests/improve-control-room-first-website.test.ts` (near the end). The actual baseline has evolved since review: measure the current producers; do not copy old literal totals. The value gate in `first-website-controller.ts` and `b5KnownRefusalDetailsV1` must remain unchanged. Unknown details still become `refusalDetailOmitted`, and timeout reason codes retain their independent contract.

Replace the incomplete extraction/inventory inside the test file with a small test-local inventory using the already pinned TypeScript compiler API if needed. Parse the three actual producer sources (helper, controller, host), inspect call/new expressions for `refuse`, `B5RefusalV1` and the detail-forwarding `bad`/`broken` wrappers. Account explicitly for every supplied detail argument: exact literal labels, the existing canonical kind union, templates and nonliteral expressions (including calls, conditional expressions and identifiers). Record explicit expected normalized nonliteral expressions with their fixed-label/omitted/reason-code treatment. Use stable syntax normalization, not source line numbers or all source bytes. Known arbitrary prose is documented as omitted; do not add it to the product allowlist. Calls with no detail argument are valid and distinct. Preserve all existing knownDynamic and retained-verdict/cleanup coverage or strengthen it.

Pin an independently reviewed-in-the-task expected inventory/count for the current producer set. Expectations must be literal test data measured and inspected once, not dynamically derived from the same current extraction result. Avoid a count-only proof: literal additions missing from the production allowlist and nonliteral additions missing from the explicit inventory must each fail. This is a bounded test over three known modules, not a general policy scanner or a new production parser.

## Files to touch

- `tests/improve-control-room-first-website.test.ts`.
- `docs/cloud-tasks/b5-refusal-inventory-findings.md`.

Read helper/controller/host and pinned package metadata for context only. No runtime helpers, controller labels, product behavior, schema, package/workflow or dependency changes. Keep additions within this existing test module so workflow reachability stays unchanged.

## Red evidence first

Before finalizing the stronger validator, add in-memory source-mutation cases demonstrating the current drift check misses the reviewed shapes. Name the new regression `B5 refusal producer inventory rejects uncovered details`. Build the validator so the unchanged three-source fixture passes and each independent in-memory mutation fails the intended inventory/allowlist assertion:

- Add an unlisted quoted detail to helper refuse and independently to a host `new B5RefusalV1` call.
- Add an unlisted bare identifier second argument to a helper refuse call.
- Add an unlisted expression/call second argument and an unlisted template detail.
- Remove one actually protected literal producer without changing the product allowlist; the exact expected inventory must detect the loss even though the old floor passes.

Demonstrate at least the bare-identifier and host-literal cases fail the new regression when it is first wired to the old extractor; record a genuine red exit and intended assertion. Then replace the inventory logic, run green, and keep all mutation checks as ordinary assert.throws-style tests on memory-only copies. Each fixture mutation must assert exactly one intended insertion/replacement, so a no-op cannot earn a pass. Parse failures alone do not count as detection. Do not execute injected refusal calls or write mutations into production files.

## Exact Linux test commands

```sh
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='B5 refusal producer inventory rejects uncovered details|B5 refusal detail label set covers every literal detail|B5 controller keeps only known refusal detail labels|B5 controller applies the same refusal detail rule' tests/improve-control-room-first-website.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/improve-control-room-first-website.test.ts
runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node_modules/.bin/tsc --project tsconfig.vps.json
```

Record the first command red then green. The full suite is offline/synthetic at this base; never opt into host sessions, real transport or native providers. Record current literal/template/nonliteral and selected test totals in findings instead of assuming the older review's counts.

## Done criteria

All three producer modules are covered; current fixed and dynamic details have explicit expected treatment; all independent in-memory mutations are caught; removing a protected producer is detected. Existing retained-verdict and cleanup tests still pass, runtime bytes stay unchanged, and no private context or dynamic detail is added to the public product label set.

## Linux environment and safety

Read `CONTRIBUTOR_HANDBOOK.md`, `CONTRIBUTING.md` and any applicable `AGENTS.md`. This assignment supplies the branch/submission policy; no public claim or PR workflow is required. This is a disposable public product clone, with Node 22, pre-provisioned project dependencies, PostgreSQL 17, `PG_BIN=/usr/lib/postgresql/17/bin`, and `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1`. The setup script creates the unprivileged `builder` account. A line beginning `SETUP:` denotes a setup failure: report it and stop dependent commands. Do not install or download dependencies, tools, browsers or packages. Never use an npm command that fetches a missing executable. Missing prerequisites are BLOCKED, not permission to fabricate passing evidence.

Check setup, from the clone root:

```sh
node --version
test -d node_modules
id builder
test -x /usr/lib/postgresql/17/bin/initdb
test -x /usr/lib/postgresql/17/bin/pg_ctl
git switch -c cloud/b5-refusal-inventory
mkdir -p .test-tmp
```

The worker starts as root. Before running the task commands, give only this disposable checkout to the existing build account with `chown -hR builder:builder "$PWD"`; do not chown any external path. Do not run initdb as root. Run PostgreSQL tests via `runuser -u builder --` as shown below. Use serial foreground commands with bounded test timeouts. Scratch files may live only in `.test-tmp/` or disposable directories under `/tmp`; remove only task-owned scratch and stop every process/cluster you start. Use existing fixture cleanup and require `cleanedUp=true` and zero leftovers for native runs. Never touch another cluster, the live installation, client ports, protected storage or shared-memory segments manually.

No real models, agent CLIs, paid calls, deployments, account sign-in, credential files, settings stores, environment files, tokens, or remote service access. Do not print inherited environment variables. Keep CLI blocking enabled for every test. All inputs and identities are synthetic. No secrets, private names, personal names, host identities, private report locations or absolute workstation paths in repository files, logs retained in Git, or commit messages. Do not copy external reports into the clone. No dependencies, lockfiles, package scripts, workflow, product code, migration files, schema pins or existing assertions may change unless this task explicitly allows that path. Keep quarantine and existing refusal/security checks intact. No new feature or unreviewed specification is authorized.

## Evidence and submission

After all build-user tests and cleanup complete, return this disposable checkout to its original root ownership with `chown -hR root:root "$PWD"` before root runs Git checks or commits. The `-h` flag keeps symlink targets outside the clone untouched. This avoids Git dubious-ownership errors while preserving the root session's existing configured commit identity; do not change safe.directory or identity settings.

Write `docs/cloud-tasks/b5-refusal-inventory-findings.md` with the actual starting HEAD, implementation base, changed paths, commands, exits, test/pass/fail/skip/cancel counts, exact expected negative-control failure, restored-green result and cleanup evidence. Keep logs bounded and sanitized. A skip, missing prerequisite, or zero selected tests is not a pass. Record unrelated baseline failures honestly; do not repair outside scope or weaken assertions. Never count an intentionally broken negative control as an ordinary regression failure. Leave no mutant in the committed tree.

Use the repository's existing secret scanner on the changed allowlisted files, with its `runGit` file-list injection (read `scanTrackedSecrets` in `scripts/release-tool.mjs`); assert zero findings. Run the private-name guard without reading or supplying a secret file:

```sh
node --input-type=module -e 'import assert from "node:assert/strict"; import {scanTrackedSecrets} from "./scripts/release-tool.mjs"; const files=["tests/improve-control-room-first-website.test.ts","docs/cloud-tasks/b5-refusal-inventory-findings.md"]; const matches=scanTrackedSecrets(process.cwd(),()=>files.join("\0")); assert.equal(matches.length,0,JSON.stringify(matches)); console.log("secret-scan files="+files.length+" findings="+matches.length);'
env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs
git diff --check
```

The private-name guard's local no-list result is an explicit SKIP: the CI private-name list is unavailable in a public cloud clone. Do not invent a denylist or call this a full privacy pass. The lead's CI must supply the real list before integration.

Use the git identity already configured by the environment. Do not set `user.name` or `user.email`, globally, locally, or per command, and do not override author/committer environment variables. Commit only the named allowlisted test/helper paths and findings file. Do not add a Claude-Session or any session URL trailer to commit messages; if your tooling adds one, amend it out before pushing. Inspect `git log -1 --format=%B` and verify no such trailer remains. Push to branch `cloud/b5-refusal-inventory`, open no PR, never merge. Push only that output branch; never alter/push the published base. If pushing is unavailable, leave the local commit ready and report that limitation. The lead handles review and integration. Final response: output branch, base and result SHAs, test counts, limitations and findings path.
