# Protected owner revision-planning interface

Root-owned contract, 2026-09-05. Base: `1c6b5d40c9cd0912cfcfd45d929de6972ff63ecd`.

## Product behavior

The matching open result's protected recorded owner review supplies exact saved feedback.
An explicit **Prepare revised task** action creates or reconciles the existing bounded
revision plan and links to its separate task. It does not assign, approve, dispatch or
start an agent. Reloading requires reading the saved review again; explicit preparation
of that exact review reconciles the deterministic bundle instead of creating duplicates.

## Boundary

- `POST /api/v1/projects/:projectId/tasks/:sourceJobId/revisions` accepts only the existing
  strict `TaskRevisionRequest`, bounded to 16,384 encoded bytes. No query, caller idempotency
  key, execution settings or authority fields. Same-origin Access authentication and shared
  project/session authorization precede the optional operation. The existing planner owns
  all exact owner/review/result/profile/permission/transaction validation.
- Optional scoped `TaskRevisionOperation.plan` is captured in private process composition;
  only the separately owned coordinator mounts it. Ordinary one-pool startup rejects this
  injected dependency. Missing operation is unavailable, never synthetic success.
- Request cancellation reaches the existing bounded coordinator/planner. Responses parse
  a strict receipt and bind project, source, different destination job, producer run,
  target/digest, bytes, review and feedback digest. New save is 201, exact replay 200.
- Existing protected review options add optional `revisionPlanning` (`configured` or
  `not_connected`), a configuration indicator, not an eligibility or permission grant.
  The UI uses only a matching saved changes-requested review, never unsaved draft text.
- Browser pending state captures exact immutable request/body. Lost reply, malformed success,
  server failure and later authorization failure retain uncertainty. Only explicit owner
  checking retries it; refresh/focus/read never writes. A first definitive rejection can
  release an unacknowledged request. Page-owned review sessions retain pending revision
  commands across result close/read failure. They never authorize display: receipt links
  appear only beside a current matching protected review. No local/session storage.
- Source capacity release remains the existing quality coordinator's responsibility.
  No role/schema change, runtime start, scheduler, native/provider call, credential access,
  physical database, listener, deployment or merge is included.

## Parallel evidence

Root implements production, normative contract, registration and integration. After a
frozen production commit, isolated backend tests cover the real restricted startup/HTTP
path and boundary failures. A separate lane covers browser state and compiled/rendered
UI. Independent review checks the exact product diff and integrated evidence. Existing
dependencies only; one focused ordinary fixture repair is permitted with failures retained.
No workers edit production, shared checkout, package registration, SQL roles or this contract.

Acceptance: stage zero, focused persistence/coordinator/HTTP/browser tests, compiled private
app tests, both existing builds, types and lint; current-head GitHub CI before integration.
