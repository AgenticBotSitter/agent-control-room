## Work packet

- V2 capsule path (required for agent results):
- Jobber issue and `CLAIM ACCEPTED` comment:
- Claimed route and platform:
- Target integration branch (agent results must not target `main`):
- Immutable implementation commit:
- Result manifest path:
- Issue:
- CR block:
- Worker ID / machine:
- Harness / model / tool versions:
- Task class and qualification state:
- Execution-contract digest:
- Preflight acknowledgement URL/comment:

## Result

- What changed:
- Why it satisfies the accepted contract:
- Allowed paths touched:
- Immutable artifact references/checksums, if any:

## Validation

- Commands and results:
- Failed attempts or retries:
- Assumptions and known risks:

## Planned versus actual effects

| Effect ID | Authorized maximum | Actual chronological count | Final state |
|---|---:|---:|---|

- Actual-ledger validator result:
- Unexpected effects:
- Contract changes after preflight: none / explain and stop
- PR description matches current head and supersedes withdrawn conclusions: yes / no

## Safety

- [ ] No secret, token, private production content, or mutable credential reference is included.
- [ ] No live external effect was performed unless the work packet explicitly authorized it.
- [ ] Scope was not expanded beyond the issue.
- [ ] I did not merge or approve my own work.
- [ ] Codex/Sol semantic review is still required.
- [ ] The original execution-contract digest matches the actual ledger and every effect stayed within budget.
- [ ] Failed attempts, diagnostics, setup, prompts, and cleanup actions are included in actual counts.
- [ ] Every disposable artifact's separately budgeted cleanup effect ran or is reported as blocked; cleanup was not inferred from the creation effect.

## Reviewer disposition

- [ ] Automated intake eligible (agent results only)
- [ ] Independent verification complete or not required by capsule
- [ ] Accepted
- [ ] Accepted with follow-up
- [ ] Changes requested
- [ ] Rejected

Reviewer notes:
