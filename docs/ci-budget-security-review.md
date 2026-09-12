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
