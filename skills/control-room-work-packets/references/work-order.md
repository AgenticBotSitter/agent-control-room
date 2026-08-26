# Work-order contract

The architect commits task-specific instructions as a V2 capsule and may mirror them in a GitHub issue. The capsule controls when the issue differs. The worker does not fill in missing authority or rewrite the order to fit the host.

## Required fields

Every actionable order states:

- **Mode:** `standard-work`, `platform-validation`, `controlled-effect`, or `independent-review`.
- **Objective:** one concrete deliverable and why it is delegated.
- **Eligibility:** platform, eligible routes, authorized GitHub claimants, required tools, and per-route concurrency.
- **Wave and status:** named frozen wave and a capsule status of `ready`.
- **Base and branches:** full immutable product-base commit and exact `integration/<block>` target; the accepted claim derives `agent/<route>/<capsule>`.
- **Allowed paths:** exact committed product paths; directory boundaries and globs are invalid in V2.
- **Owned inputs:** immutable files, PR heads, schemas, harnesses, fixtures, or references.
- **Acceptance:** observable results and exact validation commands.
- **Repair budget:** what may be corrected, how many iterations, and what requires architect return.
- **Environment boundary:** pre-existing tools, allowed setup, network, dependencies, temporary files, and external effects.
- **Stop boundary:** actions and outcomes that end the assignment.
- **Handoff:** canonical result-manifest path, separate implementation and metadata-only commits, required PR/report/evidence, and verifier.

The issue may link a repository runbook or executable harness for complex mechanics. Keep reusable behavior in the skill, job facts in the order, and fragile procedures in versioned repository code. Do not create a new skill per job.

## Preflight response

Post a concise response before branch creation:

```text
WORK ORDER READY
accepted claim comment: <URL>
wave/capsule/status: <exact>
mode: <declared mode>
worker/model/host class: <actual>
product base/integration target/producer branch: <exact>
allowed paths: <exact>
readiness or validation tools: <versions/status>
repair budget: <exact>
blocked mismatches: none
```

If a required value differs, post `WORK ORDER BLOCKED` with the mismatch and stop. Owner conversation may clarify intent but cannot silently amend the GitHub order; material changes belong in an edited order with an explicit new-ready disposition.

For V2 jobbers, use the exact `/release`, `/blocked`, and `/submitted` transitions in `../../agent-build-worker/SKILL.md`; do not simulate them with assignment edits or informal comments.

## Outcome language

- `met` — acceptance checks pass within scope and repair budget.
- `not met` — the task ran within authority but an acceptance check failed.
- `blocked` — a prerequisite or external state prevented safe execution.
- `rejected — authorization deviation` — work crossed a path, effect, identity, independence, or retry boundary.
