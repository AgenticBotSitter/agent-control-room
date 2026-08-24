# Standard work mode

Use for isolated repository work that has no credential, permission, persistent-host, destructive, or production effect.

## Default working freedom

Within the order's paths and objective, the worker may inspect the repository, edit code/docs/tests, run existing deterministic checks, and use ordinary read-only diagnostics. The order should normally allow one focused self-correction before handoff. A failed test does not automatically end the job when the failure can be repaired inside the allowed paths and remaining repair budget.

Do not require a per-command effect ledger. Git history, the PR diff, test output, and the handoff provide the audit trail.

## Setup and dependencies

Dependencies are pre-existing unless the order explicitly authorizes an install/update and names the command. Missing tools or credentials block the order; do not replace the toolchain or extract authentication material.

Temporary test artifacts under repository or OS-managed test directories are allowed only when the existing test command owns and cleans them. Persistent services, schedulers, host configuration, production APIs, and secrets are never implied by standard-work mode.

## Repair loop

Use the exact repair budget in the issue. A typical order permits:

1. implement the scoped deliverable;
2. run acceptance checks;
3. make one focused repair for failures caused by the patch;
4. rerun the affected checks and hand off.

Stop early for architecture ambiguity, scope expansion, unrelated dirty-tree overlap, missing external authority, or a second failed repair. Report the evidence needed for Codex/Sol to continue.

## Handoff

Include changed paths, design decisions limited to the assignment, exact commands/exits, repair iterations, residual risks, and the PR URL/head. Do not produce a large authorization report unless the work order asks for one.

