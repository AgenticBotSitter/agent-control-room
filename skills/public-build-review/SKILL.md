---
name: public-build-review
description: Review public Agent Control Room contributions for material correctness and integration readiness, with concise consolidated findings. Not the legacy V2 capsule intake procedure.
---

# Public build review

Review the assigned outcome and actual diff at a pinned head. Identify the affected
user journey and risk before choosing checks. Existing controlled-operation records
keep their explicit limits; this skill does not grant native or deployment authority.

## Match review to risk

- Ordinary UI/docs/refactoring: one maintainer review plus relevant local checks.
  No mandatory second independent reviewer.
- Shared execution, authorization, persistence, recovery or release-integrity changes:
  lead review and a focused independent review where a silent error could materially
  harm data or authority. Review the boundary, not the whole repository again.
- Provider/production operations: verify scoped authorization and actual evidence;
  fixture tests do not prove live behavior or allow another attempt.

Block for incorrect user behavior, security/data loss, duplicate execution, unsupported
claims, significant regressions, required licensing gaps, or missing evidence that
could conceal those defects. Style, wording, preferred abstractions and speculative
edge cases are nonblocking unless they cause a concrete failure or violate a necessary
contract. State the consequence and a minimal reproducer for each blocking finding.

## One useful review

Inspect code, run the smallest relevant reproducible checks and consolidate findings
in one response. Distinguish checks you ran from worker-reported evidence. Avoid
rerunning unchanged expensive suites; integration gets the combined release checks.
Do not request line counts, extra manifests, recreated logs or cosmetic screenshots
unless they answer a real uncertainty. Do not confuse demo coverage with product-path
coverage. Do not change acceptance criteria mid-review without naming a material
newly discovered risk and letting the lead resolve the scope change.

Re-review the changed portions and their affected tests. One consolidated review is
the goal, not permission to ignore a newly discovered serious defect. Do not impose
arbitrary limits on ordinary repairs. Offer trivial corrections as suggestions or
make them only when authorized; do not send a worker through a new job for wording.

End with: accept, accept with nonblocking follow-ups, or changes required. List only
material remaining blockers, verification performed and genuinely untested behavior.
The lead owns final acceptance and merging; independent reviewers do not approve their
own implementation. Merge accepted work in dependency order and verify the combined
candidate before calling it a release.
