# Budget and security review: continuous integration

`.gitignore` carries the rule "Do not add automation without an explicit
budget/security review." This is that review, for `.github/workflows/ci.yml`.
It is a recommendation. Adding the workflow requires removing the `.gitignore`
entry that currently blocks it, and that decision belongs to the repository
owner.

## Why now

The private repository's GitHub Actions minutes are exhausted (3,000 of 3,000
used, resetting in 19 days), so no automated verification runs there at present.
This repository is public and has never run a workflow, so its capacity is
entirely unused.

## Budget

Public repositories get unlimited free standard-runner minutes. This workflow
uses `ubuntu-latest` only, so it consumes none of any account's included budget.

Three jobs, each capped with `timeout-minutes` (15, 25, 30). `concurrency` with
`cancel-in-progress` means a burst of pushes leaves one run per ref, not one per
push. There is no scheduled trigger, so the workflow never runs on its own.

Storage: the workflow uploads no artifacts and produces no cache beyond the
dependency cache `actions/setup-node` manages. Included storage is 0.5 GB of 2 GB
used today.

## Security

The relevant fact is that this repository is public, so anyone at all can open a
pull request and cause this workflow to run. Every mitigation below follows from
treating the checked-out code as hostile.

| Risk | Mitigation |
|---|---|
| Fork PR reads secrets or writes to the repo | `pull_request`, never `pull_request_target`. Fork runs get a read-only token and no secrets. `permissions: contents: read` at the top level. |
| Dependency lifecycle scripts execute on the runner | `pnpm install --frozen-lockfile --ignore-scripts` in all three jobs. |
| A moved tag silently changes what an action does | All three actions pinned to full commit SHAs, with the version in a trailing comment. |
| A token left behind in the checkout's git config | `persist-credentials: false` on every checkout. |
| Unreviewed lockfile changes pulling new packages | `--frozen-lockfile` fails the run rather than resolving something new. |

Two residual risks, both accepted rather than eliminated:

**The tests run the pull request's code.** That is what a test is. `--ignore-scripts`
removes the path that runs dependency code *before* any test does, but a pull
request that edits a test still executes on the runner. With no secrets and a
read-only token the reachable damage is runner compute, which is the standard
exposure of CI on any public repository.

**Compute abuse by a stranger opening pull requests.** GitHub's default for public
repositories requires maintainer approval before a first-time contributor's
workflow runs. Confirm that setting is on, under Settings → Actions → General →
"Fork pull request workflows from outside collaborators". Consider the stricter
"Require approval for all outside collaborators".

## What the workflow runs

Only scripts this repository already defines: `check:demo` and `check`
(typechecks), `test:demo` and `test:build:demo`, and `test`. The `test` script
builds the server bundle before testing, so the build is covered and there is no
separate build job.

No lint job: this repository installs eslint transitively but defines no eslint
config and no lint script, so there is nothing to run.

## Verification

Every command was run locally against a clean
`pnpm install --frozen-lockfile --ignore-scripts` of this repository, rather than
reasoned about:

| Command | Result |
|---|---|
| `pnpm run check:demo` | exit 0 |
| `pnpm run check` | exit 0 |
| `pnpm run test:demo` | 30 / 30 pass |
| `pnpm run test:build:demo` | 2 / 2 pass |
| `pnpm run test` | 56 / 56 pass |

88 tests, no failures. This was confirmed both with and without
`--ignore-scripts`, so the hardening does not change the result.

What this does not establish: the workflow has never executed on GitHub's
runners. A local pass on macOS is evidence that the scripts work, not proof the
workflow file is correct. The first run on `ubuntu-latest` is the real test, and
it may fail for environment reasons this review cannot anticipate.

## Follow-up

The pinned actions are the `v4` majors, matching the sibling private repository.
`actions/checkout` and `actions/setup-node` are at `v7` and `pnpm/action-setup`
at `v6`. Upgrading is worth doing separately, where a failure is attributable.

## Standing

This review covers adding CI to this repository. It grants nothing else. It is
not a publication decision, and it does not bear on the public tree disposition,
which remains blocked before independent review.
