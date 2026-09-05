# CR14C result verification interface

Owner-requested continuation,2026-09-05. Design boundary; acceptance recorded separately.

Add an optional owner-operated verification interface using existing Completion Gate verification
records. It does not replace automated or independent-agent checks. Only exact scenarios explicitly
configured by trusted composition as suitable for human verification are available, pinned to the
existing acceptance profile ID/digest. An empty configuration exposes no verification commands.
No default scenario, acceptance profile or successful evidence is invented.

The owner reads the exact checked artifact and configured scenario instructions, then records passed,
failed, blocked or inconclusive with a nonempty observation note. The server derives human identity,
time and target/profile from current authenticated project scope. Existing tasks.reviews.record
permission, risk ceiling, active project, producer separation and target state govern the operation.
Instructions are configuration data, not code; note text is hashed as evidence, not executed or logged.

Use a deterministic verification ID per tenant/owner/target/scenario. The existing HMAC-protected,
checkpoint-anchored Completion Gate record is the idempotency source, without another table. One
immutable record per owner/scenario/target: exact replay returns history; changed evidence conflicts.
No automatic retry after an uncertain save. The browser retains exact pending input in the task page
until explicit reconciliation; it does not claim a save succeeded from an HTTP callback alone.

Receipt binds project/job/artifact/target/content/scenario/instructions/outcome/note digest and record
time. Reads never initialize checkpoints or bootstrap profiles. Re-read exact artifact bytes and target
under current session/permission, stage checkpoint changes, and flush after final precommit authority.
Verification does not complete a canonical job, dispatch a revision, publish content or approve effects.

Root owns schemas, service/authentication, route and runtime composition. Internal implementation
agents may build the controlled panel/browser client under these settled types and tests. Root reviews
integration; a separate reviewer checks the service and transaction boundaries.

Route: `/api/v1/projects/{project}/tasks/{job}/results/{artifact}/verifications/{target}`.
GET returns taskVerificationOptionsSchema. POST takes taskVerificationDraftSchema and returns
taskVerificationCommandSchema. No client identity/profile/authority fields and no idempotency key are
needed: the exact owner/target/scenario fixes the record ID. Browser matching must verify every bound
field and the canonical SHA256 digest of the note string before dropping pending input.
