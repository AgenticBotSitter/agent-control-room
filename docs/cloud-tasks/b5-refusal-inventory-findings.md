# b5-refusal-inventory findings

## Revisions

- Published base / cloned HEAD: `ed407ecd61c29515848e7c9c17c895ea875902d2` (branch `cloud-base/b5-refusal-inventory`).
- `git rev-parse HEAD^` = `f1177b1e1b152bbe9de2fa139e84c5d0bc9f0b26` (matches the stated `cloud/pack-1` source).
- Output branch: `cloud/b5-refusal-inventory`.

## Changed paths

- `tests/improve-control-room-first-website.test.ts` (test only)
- `docs/cloud-tasks/b5-refusal-inventory-findings.md` (this file)

Helper, controller, host, `b5KnownRefusalDetailsV1`, the value gate, package metadata, lockfile and workflows are unchanged.

## What changed

The regex extractor in `B5 refusal detail label set covers every literal detail the producers pass` is replaced by a
test-local inventory (`b5RefusalInventoryV1` / `assertB5RefusalInventoryV1`) that parses helper, controller **and host**
with the pinned TypeScript compiler API (5.9.3, already a dev dependency; no new dependency). It visits every call/new
expression whose callee is `refuse`, `B5RefusalV1`, `bad` or `broken` and classifies the detail argument (second argument,
or first for the `bad`/`broken` wrappers):

- no detail argument: counted separately per module/callee (valid, distinct);
- string / no-substitution template literal: counted per module and label;
- anything else (identifiers, property/element access, calls, conditionals, templates): keyed by the printer-normalized
  call syntax (comments removed, whitespace collapsed; no line numbers, no source bytes).

It also records `canonical`'s `kind` union from the AST, any parse diagnostics, and any reference to a producer name
outside a direct call, declaration, `instanceof` or type position (e.g. passing `refuse` as a value).

The assertions, each with its own message, in order: sources parse; no producer escapes a direct call; every literal is in
`b5KnownRefusalDetailsV1`; kind union equals `["file","directory"]`; nonliteral inventory equals the explicit list; literal
inventory equals the pinned per-label counts; no-detail inventory equals the pinned counts. The label test then checks
every fixed-label/prefix-label nonliteral's documented label domain is in the allowlist, every omitted nonliteral's
documented example text is **not** in the allowlist, and exactly one reason-code entry exists (the host's
`B5_A2_FINALIZATION_TIMEOUT` forwarder). The previous fixed label checks are kept.

## Measured inventory (current producers, inspected by hand once, pinned as literal test data)

- Literal details: 57 occurrences, 52 distinct labels, all in the helper (controller 0, host 0); all 52 are in the
  allowlist. Plus canonical kinds `file`, `directory` (54 distinct allowlisted values, vs. the old `>= 50` floor).
- Nonliteral details: 28 distinct normalized expressions, 29 occurrences:
  - forwarded (wrapper parameter, covered at call sites): 4 (`refuse`'s own `detail`, and the three `why` wrappers);
  - fixed-label: 11 expressions / 12 occurrences (`kind`, config `name` x2, `binding.input`, `binding.name` x4 codes,
    `binding ${binding.name}`, `dom ${screen}`, `fresh ${role}`);
  - prefix-label: 2 (`B5_INPUT_BINDING_REFUSED` and `B5_BRIEF_SCOPE` templates);
  - omitted (arbitrary text, documented, never allowlisted): 10 (`review ${review.stepId}`, `recipe.id`, config issue
    paths call, `String(port)`, `check.outputPath` x2, git `args[0]`, `entry.path`, artifact `path`, `entry.table`);
  - reason-code: 1 (host `new B5RefusalV1("B5_A2_FINALIZATION_TIMEOUT", reasonCode)`).
- Templates (subset of nonliteral): 6, same set the old test listed.
- No-detail calls: helper `refuse` 112, helper `bad` 12, helper `new B5RefusalV1` 2, controller `new B5RefusalV1` 18,
  host `new B5RefusalV1` 9.

## Mutation regression `B5 refusal producer inventory rejects uncovered details`

Memory-only copies of the three sources; each mutation asserts its anchor occurs exactly once, that the result differs,
and that the mutant parses with zero diagnostics, then requires the validator to throw an `AssertionError` whose message
starts with the intended assertion. Nothing is written to disk and no injected call is executed.

| case | intended assertion |
| --- | --- |
| helper quoted unlisted detail in `refuse` | literal refusal detail missing from b5KnownRefusalDetailsV1 |
| host `new B5RefusalV1(code, "unlisted host detail")` | literal refusal detail missing from b5KnownRefusalDetailsV1 |
| helper bare identifier `refuse(code, evidenceDir)` | nonliteral refusal detail not in the explicit inventory |
| helper call `evidenceDir.slice(1)` | nonliteral refusal detail not in the explicit inventory |
| helper conditional `root ? "json" : "git"` | nonliteral refusal detail not in the explicit inventory |
| helper template ``bad(`remote ${facts.remotes}`)`` | nonliteral refusal detail not in the explicit inventory |
| host bare identifier `new B5RefusalV1(code, ownerCode)` | nonliteral refusal detail not in the explicit inventory |
| additional copy of an allowlisted literal | literal refusal detail inventory changed |
| protected literal `bad("remote")` removed | literal refusal detail inventory changed |
| `export const refuseAlias = refuse` | refusal producer referenced outside a direct call |
| extra no-detail `new B5RefusalV1` in host | no-detail refusal inventory changed |

For the removal case the test also shows the old checks would pass: `remote` is still allowlisted and the remaining
distinct literal count is still >= 50.

## Setup used

- Started as root in a fresh public clone; Node `v22.23.4`.
- `npm ci` -> exit 1 (EUSAGE: the repo has no `package-lock.json`; its own lockfile is `pnpm-lock.yaml`,
  `packageManager: pnpm@11.19.0`).
- `pnpm install --frozen-lockfile` -> exit 0 (repo lockfile, no lockfile change).
- `apt-get update` -> 0; `apt-get install -y postgresql-17` -> 100 (package not available); adding the PGDG apt key ->
  curl 403 through the environment proxy, so PostgreSQL 17 could not be installed (the temporary apt source was removed).
  Fallback: `PG_BIN=/usr/lib/postgresql/16/bin` (PostgreSQL 16.15). This task starts no cluster; PostgreSQL was not used.
- `id builder` -> 0 (account already present). `mkdir -p .test-tmp` -> 0.
- `chown -hR builder:builder` on the checkout -> 0 before tests; `chown -hR root:root` -> 0 before Git checks.

## Commands and results

All test commands ran as `runuser -u builder -- env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node
scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 ...` exactly as in
the task file.

1. Selected (4-pattern) command, **red**: new regression wired to the old regex extractor (host omitted, quoted/backtick
   only). Exit 1; tests 4, pass 3, fail 1, cancelled 0, skipped 0. Failure: `Missing expected exception: host literal`.
   A second red run collecting every miss reported
   `RED: legacy extractor missed mutations [ 'host literal', 'helper bare identifier' ]` (exit 1). The quoted helper case
   already failed the old allowlist check, as expected. (A first red attempt failed for a test-harness reason: matching
   `assert.throws` with a RegExp tests `String(err)`; it was switched to a predicate on `err.message` before recording.)
2. Selected command, **green** after replacing the extractor: exit 0; tests 4, pass 4, fail 0, cancelled 0, skipped 0.
3. Full module `tests/improve-control-room-first-website.test.ts`: exit 0; tests 153, pass 153, fail 0, cancelled 0,
   skipped 0, todo 0 (about 346 s). Existing retained-verdict, cleanup and timeout reason-code tests pass unchanged.
4. `node_modules/.bin/tsc --project tsconfig.vps.json`: exit 0. That project does not include `tests/`, so the test file
   was additionally checked with `tsc --noEmit -p tsconfig.json`: exit 2 with 9 lines of errors, all in other test files
   (`improve-control-room-loop-bridge`, `-loop-candidate`, `-loop-recovery`); the base without this change gives the same
   9 lines. Zero errors in the edited file.
5. Secret scan (`scanTrackedSecrets` with injected file list, both changed files): findings 0.
6. `env -u CONTROL_ROOM_PRIVATE_NAMES -u CONTROL_ROOM_PRIVATE_NAMES_FILE -u GITHUB_ACTIONS node scripts/check-private-names.mjs`:
   exit 0, **SKIP** ("no list configured"). This is not a privacy pass; CI must run it with the real list.
7. `git diff --check`: exit 0.

## Cleanup

No cluster, server or browser was started by this task. Scratch lived only in the ignored `.test-tmp/` and was removed.
No mutant was written to any tracked file; the committed tree contains only the two allowlisted paths above.

## Limitations

- PostgreSQL 17 unavailable in this environment (16.15 present); not needed by this task.
- `npm ci` cannot run against a pnpm-only repo; `pnpm install --frozen-lockfile` used instead.
- The inventory reads `SourceFile.parseDiagnostics` (internal but stable TypeScript field) to reject parse failures.
