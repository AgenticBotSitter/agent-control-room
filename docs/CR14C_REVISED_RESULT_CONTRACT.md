# Revised native result and protected review integration

Root contract, 2026-09-05. Base `8fa77f9aff3cdd235df723ade9d2172e9c3cfdc0`, PR #333.
This block connects the existing durable v2 execution plan to a same-subject replacement
result, fresh quality evidence and protected read/review. It does not deploy a runtime,
start an agent, inherit earlier approval or accept excluded draft PR #329.

## Exact identities

Keep v1 native review plans, tags, targets and receipts unchanged. Add a strict v2 native
review-plan branch with a separate HMAC purpose. The actual child job/run/attempt/node,
input/authority/native binding and received artifact remain their real producer identities.
Carry the verified v2 execution revision context as immutable native review-plan lineage.
The logical review subject and root target remain those of the original task.

Only the trusted execution planner binds that context to an actual discovered child run.
The submission service independently checks the predecessor's saved authenticated native
result, target, exact owner change review/digest, findings, profile, next revision and
times before first registration. No caller can provide a target or mark quality accepted.
One immutable native review plan per child job/run gives exact replay; changed registration
inputs conflict. Registration does not write a Completion Gate target or run an agent.

Submission re-reads actual child bytes and native evidence, reconstructs the exact next
target and revision record, and uses existing `recordRevision` and staged checkpoint
publication in one transaction. Changed bytes, consecutive bounded revision, same profile,
exact complete predecessor findings and one successor remain mandatory. The old target
becomes superseded, not accepted. The new target starts without inherited review or checks.
Readback validates both the exact target and recorded revision, not a hash/node coincidence.
Lost acknowledgements reconcile existing evidence without retrying native execution.

## Protected lineage read

Extract shared pure native-plan schema/authentication and exact target construction below
the web layer. A read-only helper resolves a producing job's authenticated native review
plan and verifies its requested target against actual checked artifact receipt metadata
and Completion Gate target. Existing v1/manual initial-target behavior is preserved;
cross-job revised targets require explicit authenticated v2 lineage, never inferred hashes.

Result lists on a producing child job show that child's file and the authenticated logical
subject's review history. Artifact/command receipts and routes retain the producing job ID.
Owner review and manual verification use the same checked relationship. Other jobs, same
bytes from another run, missing/tampered mappings and cross-project roots remain denied.

The private web role gains SELECT on the existing native review-plan table only, with the
exact preflight allowlist and role tests updated. It receives neither execution-plan reads
nor the execution-plan signing key, and no native review-plan write privilege. No schema
change or production grant execution is authorized. Runtime writer mounting is still a
separate outstanding connection, not something supplied by this read permission.

## Activation and limits

Keep general executable v2 reads blocked until the same-subject binder/submission and
protected review paths pass together. Only then may the trusted planner read v2 plans and
bind their review through the new registration branch; existing assignment/approval and
dispatch checks still apply independently. Planning receipts remain non-executing and
truthfully distinguish a connected result path from runtime/approval availability.
No new public endpoint or background timer is included. Reservation turnover, upstream
workflow/request outcome, browser revision-planning command, runtime registration and
supervision, real host/DB preparation and owner signing remain explicit pending work.

## Proof

Root owns production, security and integration. Isolated agents author native lifecycle
and protected read/review regressions; a separate reviewer checks the frozen product.
Preserve all v1 cases. Prove actual synthetic child run and returned bytes, same logical
subject with actual child producer, exact binding/refusal/replay, missing or conflicting
findings, changed content, staged checkpoint failures, fresh verification/owner review,
and no accidental completion of the original job. Prove exact restricted role changes
and compiled protected composition. Fake transport/PGlite are not live host evidence.
