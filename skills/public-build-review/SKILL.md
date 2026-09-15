---
name: public-build-review
description: Review public Agent Control Room contributions for material correctness and integration readiness, with concise consolidated findings. Not the legacy V2 capsule intake procedure.
---

# Public build review

Read [the contributor handbook](../../CONTRIBUTOR_HANDBOOK.md) for the authoritative
lifecycle, identity limits, controller commands and legacy fallback. This skill adds
review judgment; it does not define another state machine.

Review the assigned outcome and actual diff at a pinned head. Identify the affected
user journey and risk before choosing checks. Existing controlled-operation records
keep their explicit limits; this skill does not grant native or deployment authority.

## Match review to risk

- Ordinary UI/docs/refactoring from an automated worker: a focused independent
  pre-submission check plus one maintainer review and relevant local checks. Human
  contributors may rely on the maintainer review. Do not manufacture a deep security
  exercise for an isolated presentation change.
- Shared execution, authorization, persistence, recovery or release-integrity changes:
  independent pre-submission review plus lead review of the affected boundary, with
  focused failure-path evidence where a silent error could materially harm data or
  authority. Review the boundary, not the whole repository again.
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
An empirical revert or mutation check is required only when the issue asks for it or
when a material claim depends on a new test whose sensitivity is genuinely uncertain.
It is not a ritual for every test-file edit.

End with: accept, accept with nonblocking follow-ups, or changes required. List only
material remaining blockers, verification performed and genuinely untested behavior.
The lead owns final acceptance and merging; independent reviewers do not approve their
own implementation. Merge accepted work in dependency order and verify the combined
candidate before calling it a release.

Lead-authored repairs and integrations follow the same gate. The author first audits
the exact diff and affected dependency boundary. A separate fresh-context reviewer who
did not author the changed files then reviews the exact commit. Record the reviewer's
declared identity and model, exact commit, verdict, material findings and performed
checks on the pull request, and verify that commit is still its current head. Require
the normal visible controller or manual current-head acceptance handoff to the
integrator; a review comment is not merge authority. Do not merge while any required
check is queued, running, skipped, canceled, missing or failed. A material repair
requires another review of the repaired commit. After merge, verify the expected commit
is on public `main` and check the smallest meaningful combined behavior before recording
completion.

## Return the action explicitly

Return one consolidated correction or acceptance record for the exact submitted commit.
Follow the handbook's controller requests when configured, or its explicit legacy
manual fallback. Verify the next actor is visible in the inbox; a conflicting record
is unfinished coordination, not an idle worker. A shared-login review comment records
the independent checker's evidence but does not prove a separate GitHub identity or
bypass required approval protections. Do not repeat obsolete action-marker rules here.

For an already-submitted legacy correction stranded between an accepted claim and an
advisory Changes-required marker, use the handbook's maintainer-only `adopt-changes`
transition. It requires the complete correction instructions and exact current head;
never treat an advisory marker alone as permission for a worker to resume. The command's
`claim-worker-id` names the original accepted claim and `worker-id` names the current
recipient, permitting one deliberate identity migration instead of leaving old work
invisible.
