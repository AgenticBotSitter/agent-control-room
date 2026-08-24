---
name: control-room-work-packets
description: Execute or review a Control Room GitHub work order using the order's declared standard-work, platform-validation, controlled-effect, or independent-review mode. Use for delegated repository work; do not invent architecture, broaden authority, or self-merge.
---

# Control Room work orders

Treat the GitHub issue as the task-specific source of truth. This skill supplies stable operating behavior; it does not repeat the task's implementation instructions.

## Choose the declared mode

The issue must explicitly name one mode. Do not infer or upgrade it.

- **standard-work** — ordinary isolated code, tests, fixtures, documentation, or research. Read [references/standard-work.md](references/standard-work.md).
- **platform-validation** — run an architect-owned readiness check and then an immutable host harness. Read [references/platform-validation.md](references/platform-validation.md).
- **controlled-effect** — credentials, permissions, persistent settings, destructive cleanup, or another high-risk effect. Read [references/execution-contract.md](references/execution-contract.md) and, when a report is required, [references/qualification-report.md](references/qualification-report.md).
- **independent-review** — review another worker's output without changing it. Read [references/independent-review.md](references/independent-review.md).

Every mode also uses [references/work-order.md](references/work-order.md). If the mode or required order fields are absent, contradictory, or stale, post `WORK ORDER BLOCKED` and stop before branching or writing.

## Shared boundaries

- Work from the exact base and branch named by the order. Never work on `main`, another worker branch, or an earlier packet branch.
- Change only allowed paths. Do not modify the work order, harness, accepted contract, or architecture unless that is the assigned deliverable.
- Use only existing authenticated Git/GitHub tooling. Never extract, copy, print, or transfer credentials.
- Never place secrets, private material, production data, raw host identity, personal paths, or raw native diagnostics in commits, issues, PRs, or reports.
- Never self-approve, self-review when independence is required, self-merge, force-push, rewrite history, or expand scope to make a test pass.
- Preserve the first failure and every correction. A later success does not erase earlier work or side effects.
- Prefer safe categorical evidence. Distinguish `observed`, `documented`, `inference`, `blocked`, and `unsupported`.
- Stop when the next action crosses the order's side-effect, path, repair, cost, or retry boundary. Ask for a focused amendment; do not invent one.

## Start

1. Read the complete issue, this skill, the mode reference, and every named immutable input.
2. Check duplicate claims, branches, PRs, and allowed-path overlap.
3. Verify the base, clean tree, identity, tools, and mode-specific prerequisites.
4. Post the mode's concise readiness acknowledgement. Claim only work you are ready to start.
5. Create the named branch from the exact base and follow the work order.

For stale clones, use only the exact bootstrap fetch named by the order. A generic GitHub-read allowance is not permission to improvise a refspec or substitute a SHA fetch.

## Finish

Run the exact acceptance commands and record their real exit codes. Inspect the final diff and confirm only allowed paths changed. Push normally, open one PR, link it from the issue, and leave it unmerged for Codex/Sol review.

The PR body and issue handoff must state the current head, changed paths, tests, repair iterations used, cleanup state, and one honest disposition. A blocked or failed result is useful when reported accurately.

