# Public CI: reviewed settings

Enabled September 12, 2026 with owner authorization; workflow introduced by PR #15.
This supersedes earlier instructions to keep public Actions disabled.

## Scope and cost

CI runs type checks, contributor-demo tests/build and compiled server tests on
standard `ubuntu-latest` runners for pull requests and pushes to main. Manual dispatch
is available. There are no schedules, deployments, provider calls or private-host jobs.
Standard hosted runner minutes are free for public repositories; the private owner's
monthly allowance does not limit these jobs. Larger runners and storage/cache have
separate billing. Dependency caches are used; no build artifacts are uploaded.
See [GitHub billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).

## Verified repository settings

- Actions enabled with `allowed_actions: selected`.
- All external contributors require maintainer approval to run fork PR workflows.
- Default workflow permissions are read-only; workflows cannot approve PR reviews.
- Broad GitHub-owned/Marketplace allow options are disabled. Only these external
  action pins are allowed, each verified in its upstream repository:
  - `actions/checkout@11d5960a326750d5838078e36cf38b85af677262`
  - `pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1`
  - `actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020`
- Repository secret inventory was empty at enablement; the workflow references none.
  No claim is made here about future organization secrets or future workflow changes.

The workflow uses `pull_request`, not `pull_request_target`, read-only contents
permission, checkout without persisted credentials, frozen dependency installation
with lifecycle scripts disabled, per-job timeouts and cancellation of superseded runs.
These restrictions do not make arbitrary test code trusted: tests execute the PR code
on disposable hosted runners. Maintainers review workflow/lockfile changes and never
approve a request to run public PR code on private machines or with deployment secrets.
Selected-actions policy does not replace review of shell steps or local actions.

## Evidence and maintenance

First actual hosted run: [34694230466](https://github.com/AgenticBotSitter/agent-control-room/actions/runs/34694230466),
main revision `680e471a06f5ec4a57fd4390c55313c1909fdd88`. Consult the run for final
status; local passes alone are not hosted-run evidence. This workflow covers current
main, not unmerged component-branch integrations or live harness compatibility.

When updating action pins, review upstream changes and update the exact repository
allowlist with the workflow. Use targeted local checks during work, normal CI on code
PRs, and combined integration checks before release. Do not suppress code verification
with skip-ci. No automatic deployment or branch-protection requirements were added.

## Amendment: feedback path versus merge gate (issue #201)

Added September 14, 2026 by worker `marvin-project-templates-01`. Everything above still
describes the repository settings and the security posture, and the workflow still holds
to every one of those restrictions. This section adds a budget finding and the design
that answers it. The static properties the amendment depends on — read-only permissions,
`pull_request` only, the exact action allowlist, no secret expressions, no contributor
hosted runners, cancellation of superseded runs, and a merge gate that no routing
decision can skip — are now asserted by `tests/ci-path-routing.test.mjs` rather than
only described here.

### The finding

Every pull request paid for the slowest lane regardless of what it changed. Measured on
the hosted run for PR #206, revision `29847cb8aa5e867353721dae7c66b8d47c69ebf0`:

| Job | Duration |
| --- | --- |
| Component lanes | 445s |
| Server build tests | 186s |
| Type check | 50s |
| Contributor demo tests | 39s |
| Article build lane | 32s |
| Every test file is in a lane | 6s |
| **Run total** | **448s** |

The lanes run in parallel, so the run total is the critical path, and it is the
`Component lanes` job. A pull request that only edits a markdown file waited 448 seconds
for a result, and the first useful signal arrived with it.

### The design

Two tiers, and the second one is what keeps the first from weakening anything.

- **Fast path.** `quick` runs on every pull request and reports in about a minute: the
  routing and lane-coverage tests need no dependencies, so they report in seconds, then
  the two type checks follow once dependencies are installed. The four lane jobs become
  path-aware: a lane runs when the changed paths can affect it.
- **Merge gate.** `full-gate` runs every lane the fast path skipped, one matrix entry per
  lane so the catch-up is parallel, and `merge-gate` is the single check that attests to
  the complete suite having been satisfied.

The invariant is the whole argument: **for every possible routing decision, the lanes run
early plus the lanes run by the gate are exactly the complete suite.** A skipped lane is
therefore never an unrun lane, which is what makes a skip provable rather than a
judgement call. `gateLanes()` in `scripts/ci-path-routing.mjs` computes the complement,
and a test asserts the invariant across docs-only, frontend, release, server, database,
workflow, unknown, empty-diff and uncertainty inputs.

`merge-gate` deliberately reads no routing output. Routing can narrow what runs early; it
cannot touch the check that decides merge-readiness. Its condition is `always()` and it
fails unless every lane passed or was caught up.

The lane and catch-up conditions each carry a status function, and that is load-bearing
rather than decorative: a job-level `if:` that contains no status function inherits an
implicit `success()` over its dependencies, so a condition of the form
`needs.route.result != 'success'` would **not** have run the lane after a failed or
cancelled routing job - the route job's own failure would have skipped it, and
`full-gate`, having no job-level condition at all, inherited the same skip. `!cancelled()`
restores the intent (run after a routing failure, still respect cancellation of a superseded
run) and a test asserts that every condition reading `needs.` carries a status function and
that `full-gate` has a job guard of its own. A routing failure still fails the gate, because
the routing job's own result is aggregated with the rest.

The early and gate conditions are also exact complements of each other: a lane runs early
*unless* routing succeeded and explicitly reported `false` for it, and the gate runs it
*only* in that same case. The two are therefore mutually exclusive and exhaustive, which
closes the case that would otherwise leave a lane unrun - a routing script that emits no
outputs at all while still exiting 0. An empty output runs the lane early rather than
letting both sides skip it, and a test evaluates both rules over every combination of
routing result and output value, including the empty one.

### The path-to-lane mapping, and its evidence

Each mapping was derived by looking up which test files actually read the area, with
`git grep -l -E '(\.\./)+<area>/' -- 'tests/*'`, rather than by intuition:

| Class | Paths | Lanes | Evidence |
| --- | --- | --- | --- |
| docs | `docs/**` | none beyond `quick` | The only reference to `docs/` anywhere in `tests/`, `scripts/`, the build configs or the JSON fixtures is `scripts/license-inventory.mjs` **writing** `docs/license-inventory.json`. It is an output, so the tree is inert and skips every heavy lane. |
| markdown | `*.md` (repository root) | components | Root markdown is read, but only from the component lanes: `THIRD_PARTY.md` by `scripts/license-inventory.mjs`, `scripts/runtime-license-finalize.mjs` and `tests/runtime-license-finalize.test.mjs`; `README.md` by `tests/runtime-license-bundled-collector.test.mjs` and `tests/runtime-license-digest.test.mjs`. No server-lane input (`tests/vps-built-*.test.mjs`), no article-lane input and no demo-lane input reads a markdown file. |
| release | `deploy/**`, `third_party/**`, `research/**` | server, components | `deploy/operator-config.mjs` is read by `tests/vps-built-startup.test.mjs` (server lane). `third_party/` and `research/` fixtures feed the release-license and codex lanes inside `test:components`. Every demo-lane file (including `vite.contributor.config.ts` and `scripts/contributor-demo.mjs`) and every article-lane input (`tests/vps-built-article-extraction.test.mjs`, `vite.vps.config.ts`, `scripts/build-vps.mjs`) was checked and none reads these three areas. |
| frontend | `app/**`, `public/**`, `styles/**`, `private-app/**`, `contributor-demo/**` | complete suite | `vite.vps.config.ts` sets `appDir: private-app` and reads `public/favicon.svg`, so both build-driven lanes observe these paths: the compiled server lane builds with that config and `test:build:articles` runs that build. `tests/vps-built-serving.test.mjs` compares the built favicon against `public/favicon.svg`, and `vite.contributor.config.ts` reads the same file for the demo build. Every lane sees a frontend path, so this class runs everything. |
| connector | `src/**/*connector*`, `src/**/connectors/**` | complete suite | Connector contracts are exercised from `src/` by `test:contracts` and by the compiled server lane. |
| database | `db/**` | complete suite | `db/` is read by shared `tests/helpers/` fixtures, so a schema change can be observed from any lane. |
| workflow | `.github/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vite*.config.*`, `scripts/**`, `tests/**` | complete suite | Shared configuration and the lanes' own tooling. |
| server | `src/**`, `**/dist-vps/**` | complete suite | `src/` accounts for 350 test imports, the largest share in the repository. |
| unknown | anything else | complete suite | Refusing to guess a skip. |

A correction worth recording, because it is the exact failure this mapping was written to
avoid: the first version of this table gave the docs class `**/*.md` **and** let the frontend
class skip the server and article lanes. Both were wrong. Root markdown is read by the
component lanes, and the frontend paths are read by the two build-driven lanes through
`vite.vps.config.ts`. The first came from checking the areas by import rather than by
consumption, and the second from doing the same thing one level up: an import-only grep does
not see a root-relative file read such as `public/favicon.svg`. The classes above were
re-derived by checking what each lane's tests and build inputs actually read, and only `docs/`
and root markdown are allowed to skip anything.

Two failure modes are handled explicitly rather than optimistically:

- **Unknown paths.** An unclassified path is never skipped; it forces the complete suite,
  and so does one unknown path alongside otherwise-inert changes.
- **Diff uncertainty.** An empty changed-path list, an unparsable `git diff --name-status`
  line, or a missing path all force the complete suite. A rename is classified on both
  sides, so a file that moves between classes must satisfy both; a deletion is classified
  as the deleted path. A push to main or a manual dispatch has no pull-request base and
  therefore takes the complete suite.

### Before and after, measured

**Before**, from the hosted run for `29847cb` (PR #206): Component lanes 445s, Server build
tests 186s, Type check 50s, Contributor demo tests 39s, Article build lane 32s, lane drift
6s, run total **448s**.

**After**, from the hosted run for this revision `69ca445` (run
[34878865721](https://github.com/AgenticBotSitter/agent-control-room/actions/runs/34878865721)),
which completed successfully:

| Job | Duration |
| --- | --- |
| Route changed paths | 11s |
| Quick checks | 50s |
| Component lanes | 345s |
| Server build tests | 192s |
| Contributor demo tests | 34s |
| Article build lane | 32s |
| Merge gate catch-up (each of four lanes) | 13-16s |
| Full suite (merge gate) | 2s |
| **Run total** | **426s** |

Two readings of that, kept separate:

- **The claim being made:** the first useful result now arrives in about a minute. `Quick
  checks` reported a pass at 50s on this revision, against 448s before, and it is 50s whether
  or not the heavy lanes are still running.
- **The claim NOT being made:** that this shortened the merge path in general. This revision
  touches `scripts/` and `.github/`, so routing demanded the complete suite and every lane
  ran: the run total fell from 448s to 426s, and the component lane from 445s to 345s, but
  that difference is run-to-run variance, not an effect of the change. The catch-up entries
  took 13-16s each precisely because they had nothing to do. For a class that skips lanes -
  docs or root markdown - the catch-up does the work instead, in parallel, so merge latency
  for those classes is the catch-up's critical path rather than the sum of the lanes.

Local measurements (macOS, this workstation) put the routing tests and the lane-coverage
check at under a second each; the hosted figures above are the ones to trust.

### Intentionally unchanged

- The `Component lanes`, `Server build tests`, `Contributor demo tests` and
  `Article build lane` jobs keep their names, their commands, their steps and their
  timeouts. Only their condition for running early was added.
- The two type-check commands and the lane-drift test and script moved from the
  `Type check` and `Every test file is in a lane` jobs into `quick`, verbatim. That
  reduces the number of jobs and gives the lane-coverage verdict in seconds instead of
  after a separate job's setup, without changing what is checked.
- `scripts/check-test-lane-coverage.mjs` is unchanged. It reads every `run:` command in the
  workflow regardless of job conditions, so making a lane conditional does not lose its
  reachability, and the check now reports 182 reachable test files rather than 181
  because the new routing test is itself registered in `quick`.
- No schedule, deployment, secret, cache containing private data, dependency or
  contributor-hosted runner was added.

### What this does not claim

- It does not claim the components lane is fast. It is still the longest single job, and
  splitting its 25-entry script chain into balanced parallel jobs is the obvious next
  step; that is deliberately out of scope here, since the issue's target is feedback
  latency and preserving the gate, not re-partitioning a lane whose contents this change
  must not disturb.
- It does not claim a fork cannot alter the workflow. On `pull_request` GitHub runs the
  workflow from the pull request's own merge commit, so a fork can edit `ci.yml`; the
  control for that is the existing requirement that external contributors need maintainer
  approval before fork workflows run, plus branch protection, which is a repository
  setting and not something a workflow can assert. What this change does guarantee is
  narrower and checkable: no pull-request-controlled value gates the merge check, so
  routing cannot be used to skip it.
- It does not claim the repository lints clean. `actionlint` passes on `ci.yml` with no
  findings, but it fails repository-wide on two workflows this change does not own:
  `.github/workflows/automatic-job-claim.yml` and `.github/workflows/review-handoff.yml`
  use a `concurrency.queue` key that the linter does not recognise. That is pre-existing,
  outside this issue's owned paths, and left alone deliberately rather than silently fixed.
- It does not claim merge-readiness is enforced. Nothing was added to branch protection.
  To make the gate binding, the repository has to require `Full suite (merge gate)` as a
  status check; that decision stays with the maintainer.
