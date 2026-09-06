# Recorded revision history: presentation acceptance

2026-09-05. Product/test commit `843849aca59459eff2a7a9cfc316577b6bb137a7`.
Base: PR #330 / `6d4d6be`, whose product base is reviewed PR #328. This branch
neither includes nor accepts the pending PR #329 completion correction.

## Delivered

Result cards identify their matching displayed review revisions using both artifact
ID and content fingerprint. File-list numbering no longer resembles agent revision
chronology. Replaced targets describe their findings and missing checks as historical.
The exact stored predecessor/successor relationship supplies revision labels when
both records are present; omitted history stays explicitly unavailable.

Review availability is separate from starting a revision. The panel states that a
change request records feedback and that revised agent task execution is not connected.
No new command, callback, persistence, API, permission, runtime or native effect exists.
Existing exact open-file matching, escaped content and owner controls are preserved.

## Verification and review

Root's final focused result/browser-client/owner-review integration passed 39 tests.
The new case records a real negative review and revision through Completion Gate,
then reads it through the real authenticated HTTP handler and browser client into
the rendered panel. It proves old-target supersession, retained historical findings,
fresh pending successor status, missing replacement bytes, exact file association,
omitted-history messages and no checkpoint or canonical completion changes.
Presentation-only permutations additionally test unrelated Revision 7 between linked
targets and a same-fingerprint file absent from the target's matching artifact IDs.
These permutations are not claimed to be received native executions.

Independent read-only presentation review found three issues in the initial patch:
ambiguous direction to the newer revision's "current" outcome, missing nonadjacent
lineage regression, and missing same-fingerprint/unassociated-file regression.
All three were corrected; the reviewer found no remaining actionable presentation
findings at the exact commit above. The reviewer ran no tests and reviewed no pending
security/integration product. Root reran all 39 focused tests after the correction.

Both final builds, 20 compiled private tests, four rendered tests, TypeScript and
full ESLint passed at the unchanged product commit. Browser-client and static rendered tests are not attended browser-click,
real PostgreSQL, native agent or deployed fleet evidence. The full default lifecycle
was not rerun locally for this presentation-only patch; its CI prerequisite has separate
complete local coverage and a retained GitHub interruption/retry record.

## Remaining functional work

The source inventory confirmed a real execution gap, not just a missing button:

1. `WebTaskReviewService.record` stores feedback/findings and returns `startsRevision:false`.
2. Native result submission and readback accept only revision zero, with one immutable
   native review plan per canonical job.
3. Completion Gate revisions preserve the original subject ID, while native result
   reads and completion are bound to their actual execution job/run.
4. No application caller currently connects `recordRevision` to a revised native result.

A future execution block must define the durable original-subject/new-execution
relationship and integrate planning, returned bytes, fresh review/verification and
completion. Creating another ordinary job or rendering a revision button alone does
not meet that requirement. This accepted display correction does not count as that
missing execution integration. Astra Medium remains the current implementation setting.
