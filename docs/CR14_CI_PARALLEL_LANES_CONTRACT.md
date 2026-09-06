# Coverage-preserving CI lanes

2026-09-05. Independent maintenance lane based on reviewed PR328/6b2a727. Parent-completion
draft PR329 remains separate and its interrupted independent review is not resolved by this work.

Observed run34002739429 exhausted the existing35-minute job limit after preparation770,
main1,160 (two existing skips), post392 and rendered4 passed. Main alone took1,476,341ms.
Do not omit tests or convert cancellation/skips/failures into success to shorten the run.

Root defines this fixed CI composition:

- `checks` job: unchanged type/lint commands,15-minute limit.
- `tests` matrix: `pre`, `main-1`, `main-2`, `main-3`, `main-4`, `post`;25-minute limit,
  fail-fast false, maximum4 parallel matrix jobs. Each uses `node scripts/run-ci-test-lane.mjs --lane NAME`.
- `build` job: both existing build/render test commands and database migration verification,
  15-minute limit. No test/build command is removed.
- `verify` final job retains required check name `Verify build`, needs checks/tests/build and uses
  always(). It succeeds only when ALL three aggregate dependency results equal success, including
  the entire test matrix. No checkout/credentials are needed for this final result gate.
- Preserve existing pull_request/push triggers, workflow cancellation grouping and read-only contents
  permission. Root retains final responsibility for this configuration; the implementation is mechanical.

Every working job checks out the repository then uses a shared local composite setup action:
`.github/actions/prepare-control-room/action.yml`. Keep current pnpm11.19.0/Node22.13.0/action versions,
stage-zero before/after the existing CI=true frozen-lockfile installation, and current cache setup.
No local installs/downloads, credential access or service/deployment action is authorized.

The dependency-free runner parses only the exact existing `node --import tsx --test FILE...` package
script form for pretest/test/posttest. Reject malformed/unknown syntax, duplicate paths within/across
these three lists, non-test paths or missing/non-file inputs. No shell evaluation, test-name filter,
environment-selected path, implicit discovery or retry. `pre`/`post` retain their full lists; main is
split by deterministic sorted-file round-robin across four nonempty shards. The union is exactly the
default lifecycle inventory, with no overlap. Run selected files using the current Node executable,
`--import tsx --test --test-concurrency=2`, inherited test stdio/environment and exact argument arrays.
Nonzero exit, launch failure or terminated child must fail the lane. Importing the runner is inert.

The canonical package test script will additionally include four already-existing CR14C tests that
were only in the focused command: owner verification service/browser, document structure verifier,
and native quality completion. This closes a real default-CI coverage gap; it removes no test.

Independent bounded lanes mechanically implement the workflow and test runner partition/failure
behavior. Root authors runner, package registrations, checks the workflow and performs integration.
Validate whole inventory equality/coverage, malformed inputs and real process exit propagation using
fake child capability and bounded synthetic local tests; execute actual repository lanes once complete.
No changes to product behavior, permissions, deployment or the unfinished product-review gate.
