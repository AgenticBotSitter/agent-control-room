# Recorded revision history presentation

2026-09-05. Root-authored presentation block based on PR #330 / `6d4d6be`.
The accepted product base is PR #328. Pending PR #329 is not included or accepted.

Use only the existing protected task-results projection. Show which listed review
revisions match each file by BOTH artifact ID and content fingerprint; artifact-list
order is not revision chronology. Preserve exact open-file matching and all existing
owner review/verification conditions. No new command or permission is introduced.

For a superseded target, findings and missing checks are historical, not instructions
to keep fixing that old target. Show the replacement's revision number only when its
explicit `supersedesTargetId` points here in the returned page; do not infer adjacency
from array order. Show a predecessor's number only when its exact ID is present.
Missing bounded history remains unavailable, never invented. A newer pending target
does not inherit acceptance, verification or completion from the old target.

Owner review availability and revision dispatch are distinct. Existing review commands
may be configured, but this block still cannot request, start or submit revised agent
work. Do not add an enabled or decorative revision button, a new target, a new attempt,
or a false quality/completion claim.

Root implements the UI and regression. Agents supply read-only source inventory and
test/review analysis. Preserve the existing visual design and private-app build profile;
no new hosting, preview listener, deployment, dependency, credential, SQL grant or service.

Acceptance: a real disposable Completion Gate negative review and `recordRevision`
must project through `WebTaskService.results` into the rendered panel with the old
target superseded and the new target pending. Verify actual recorded target linkage,
retained historical finding, exact artifact matching, missing predecessor/replacement
page cases, no mutation, no new commands and escaped content. Then run existing
result/review suites, type/lint and both build profiles.

Larger missing integration remains explicit: native review plans currently allow one
initial target per job, native submission/readback reconstruct revision zero, and
generic revisions require the same subject ID. New execution jobs cannot be labeled
revisions without an architect-defined persisted relationship and actual transport,
review, completion and read-model support. This presentation block does not solve or
silently change that execution model.
