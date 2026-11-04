# ci-load-lane-contract: preserve both CI load selectors

Read this file and do exactly this task. Make the existing mutation-lane coverage guard reject a load lane that loses or changes its enabling flag or its exact parent-selection pattern. This protects CI configuration only.

- Base branch to publish/clone: `cloud/pack-1` (implementation base `e6dacd39e17196964add00c4cfa463fb2dc149dc` plus the documentation pack).
- Output: push to branch `cloud/ci-load-lane-contract`, open no PR, never merge.
- Ready for implementation once the lead publishes this branch. The product work is already on the first integration PR; no unreviewed feature spec or roster/settings/updater merge is required.

## Exact plan requirement and reviewed gap, sanitized excerpts

Approved plan slice F05b2:

> Re-measure both complete jobs and aggregate coverage/anchors; authorized maintainer applies required-check mapping; hosted checks on exact head → CI-BUDGET-PROVED. If not possible by D5, move first PR.

This packet is the small aggregate-coverage guard portion only. It does not earn the whole F05b2 gate: hosted timing, required-check configuration and maintainer actions remain with the lead.

Reviewed LOW 1:

> a lane that loses its --test-name-pattern silently loses the self-check.
> scripts/check-test-lane-coverage.mjs:130 does not require a pattern for
> test:improve-control-room-loop-monitoring-load or test:improve-control-room-loop-finalization-load.
> In that state the lane runs the whole file, so it is not green-with-zero-tests, but the selection proof the
> branch adds is gone without any failure. Cheap hardening: extend line 130's pattern requirement to those two
> lanes, or make the helper assert that a pattern was supplied when the file is expected to be pattern-driven.

The same review reproduced green-with-zero-intended-tests after a load flag disappeared. The runtime repair lives in a separate task on `cook/mutation-lane-selfcheck`; this task is independent static protection of the package commands and can build immediately on the current integration head.

## Frozen contract

`assertMutationLaneCoverage` in `scripts/check-test-lane-coverage.mjs` already owns mutation job names, ordered lane membership, bounds, unconditional steps, PG version and aggregate results. Extend that function without weakening any existing condition. The two commands must retain:

| Lane | Required enable token | Required exact selection token | Required exact test module |
|---|---|---|---|
| `test:improve-control-room-loop-monitoring-load` | `CONTROL_ROOM_B3B_LOAD=1` | `--test-name-pattern="^B3b product collector contention$"` | `tests/improve-control-room-loop-monitoring.test.tsx` |
| `test:improve-control-room-loop-finalization-load` | `CONTROL_ROOM_B3C_LOAD=1` | `--test-name-pattern="^B3c 24 finalizers retain once and refuse destruction$"` | `tests/improve-control-room-loop-finalization.test.tsx` |

Each command also retains the real `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1` environment assignment, `node scripts/run-tests-with-quarantine.mjs`, `--import tsx`, `--test`, serial execution and its existing 600000ms process timeout. Check the actual invocation tokens, not substrings embedded in unrelated variable values, comments or command arguments. Do not write a general shell parser: the current two literal package commands are the bounded supported shape. Pin their existing command form if that is the smallest reliable solution; do not allow extra shell operators, `echo` prefixes or `|| true` to masquerade as invocation. Existing workflow step bounds stay 3 minutes, job bounds 45 minutes. This packet adds no job or timeout change.

## Files to touch

- `scripts/check-test-lane-coverage.mjs`.
- `tests/check-test-lane-coverage.test.mjs`, already directly run in the source-guard CI lane.

Read `package.json`, `.github/workflows/ci.yml` and `tests/verify-mutation-checks.test.mjs` for context. They are not edit targets. No product/test-runtime/helper, migration, workflow, package script, dependency, lockfile or baseline fixture changes. This avoids shared edits with the runtime self-check task, except that both add tests to the small existing guard test file; the lead must reconcile those additive tests if both land. Neither task may edit the other's implementation files.

## Red test first

In the existing guard test file, import `assertMutationLaneCoverage`, load the actual package scripts and workflow, and prove the unchanged current data passes. Parse YAML using the already lockfile-pinned `js-yaml` through ESLint's dependency, as the guard and `tests/ci-component-shards.test.mjs` already do. Do not add a package.

For each of the two lanes independently, clone the scripts object and exercise: missing enable flag, renamed flag, flag value 0, missing name pattern, wrong/unanchored pattern, missing CLI-block flag, wrong test module, `echo` instead of invocation, and a swallowed exit (`|| true`). Every mutation must throw while the unmodified workflow/script contract passes. Keep fixtures isolated in memory and do not rewrite the working package file. Run the command below before implementation: the new missing-flag and missing-pattern cases must be red because the current guard accepts them. Capture the actual failing counts. Implement the narrow guard, then rerun green. Assert a broken lane in either job cannot borrow the other lane's validity.

## Exact verification commands

```sh
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --test tests/check-test-lane-coverage.test.mjs
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --test tests/verify-mutation-checks.test.mjs
node scripts/check-test-lane-coverage.mjs
npm run check
git diff --check
```

These tests use synthetic Git/workflow fixtures; no real models, live database or private tools. Preserve the existing workflow reachability total (940 test files at the implementation base; extending this existing test file does not change it). The verifier meta-tests pin declared mutation anchors: do not change their snippets or weaken the meta-test to make it pass. Record any genuinely unrelated baseline failure instead of editing outside scope.

## Done criteria

The actual current lane contracts pass, all specified single-lane mutations fail with a bounded lane-specific assertion, and both lanes remain reachable under the same workflow conditions, step bounds and aggregate gate. Both load flags and exact patterns are protected. No hosted CI or native-PG qualification is claimed from these tests. Include red/green exits and counts, privacy evidence, commit SHA and actual base SHA. Commit and push only the output branch above. No PR, never merge.

## Rules and boundaries

This is an authorized, disposable cloud build in the public product repository. Read `CONTRIBUTOR_HANDBOOK.md`, `CONTRIBUTING.md`, and any applicable `AGENTS.md` before editing. This task supplies the branch and submission policy for this session. No PR, comment, merge, deployment, live install, real model launch, paid call, account sign-in, or credential-file access is authorized. Run only synthetic test fixtures. Never read client settings, login stores, environment files, tokens, or credentials. Do not print inherited environment variables. Do not add secrets, private context, personal names, host identities, or absolute workstation paths to source, commits, test output retained in Git, or reports. Synthetic fixtures only. Keep existing quarantine, timeouts, counts, security assertions and independent review requirements intact. Do not install new project dependencies or change the lockfile.

Commit as `Control Room Worker <worker@localhost>` by setting it on the commit command itself, for example `git -c user.name='Control Room Worker' -c user.email=worker@localhost commit ...`. Do not change the global git configuration. Check the result with `git log -1 --format='%an <%ae> / %cn <%ce>'`.

## Linux session setup

Use a disposable Debian/Ubuntu Linux worker with sudo and outbound package access. These are setup commands for the cloud session, not a request to provision any other machine. Cloud sessions start as root, which is fine for everything except PostgreSQL (`initdb` refuses root): create an unprivileged user yourself (`useradd -m builder`, then give it the checkout with `chown -R builder .`) and run the PostgreSQL-backed tests as that user (`runuser -u builder -- <command>`). All tests run from the repository root. Node must be 22.13 or newer within major 22; PostgreSQL must be major 17. Python 3 is also required by the existing synthetic engine fixtures; no private engine source is needed.

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
