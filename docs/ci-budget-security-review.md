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
fails unless every lane passed or was caught up, and a routing failure runs the lanes
rather than skipping them.

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
| docs | `docs/**`, `**/*.md` | none beyond `quick` | No test file reads `docs/`, and `scripts/license-inventory.mjs` only writes `docs/license-inventory.json`. Markdown is documentation wherever it lives, including under `src/`. |
| release | `deploy/**`, `third_party/**`, `research/**` | server, components | `deploy/operator-config.mjs` is read by `tests/vps-built-startup.test.mjs` (server lane). `third_party/` and `research/` fixtures feed the release-license and codex lanes inside `test:components`. |
| frontend | `app/**`, `public/**`, `styles/**`, `private-app/**`, `contributor-demo/**` | demo, components | The tests reading `app/`, `private-app/` and `contributor-demo/` live in `test:demo` and the product-shell and article lanes inside `test:components`. |
| connector | `src/**/*connector*`, `src/**/connectors/**` | complete suite | Connector contracts are exercised from `src/` by `test:contracts` and by the compiled server lane. |
| database | `db/**` | complete suite | `db/` is read by shared `tests/helpers/` fixtures, so a schema change can be observed from any lane. |
| workflow | `.github/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig*.json`, `vite*.config.*`, `scripts/**`, `tests/**` | complete suite | Shared configuration and the lanes' own tooling. |
| server | `src/**`, `**/dist-vps/**` | complete suite | `src/` accounts for 350 test imports, the largest share in the repository. |
| unknown | anything else | complete suite | Refusing to guess a skip. |

Two failure modes are handled explicitly rather than optimistically:

- **Unknown paths.** An unclassified path is never skipped; it forces the complete suite,
  and so does one unknown path alongside otherwise-inert changes.
- **Diff uncertainty.** An empty changed-path list, an unparsable `git diff --name-status`
  line, or a missing path all force the complete suite. A rename is classified on both
  sides, so a file that moves between classes must satisfy both; a deletion is classified
  as the deleted path. A push to main or a manual dispatch has no pull-request base and
  therefore takes the complete suite.

### Before and after, and what is measured

- **Measured before:** the table above, from the hosted run for `29847cb`.
- **Derived after:** the first useful result for a markdown-only pull request moves from
  448s to roughly the duration of the two type checks, about 50s, because the path-aware
  lanes are skipped and `quick` needs no dependency install for its first two steps. The
  complete suite is still satisfied before merge by `full-gate`, whose critical path is
  the component-lane entry at about 445s, so merge latency for that class is unchanged.
- **Not measured:** no hosted run of this workflow revision exists yet, so the figures
  after the change are derived from the job durations above rather than observed. Locally
  (macOS, this workstation) the routing tests and the lane-coverage check each complete in
  under a second; hosted runners are slower than that and the CI figures above are the
  ones to trust.

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
- It does not claim merge-readiness is enforced. Nothing was added to branch protection.
  To make the gate binding, the repository has to require `Full suite (merge gate)` as a
  status check; that decision stays with the maintainer.
