# Private Idea project lifecycle delivery

The private project Settings page now connects Idea-origin projects to the existing
`IdeaLabProjectLifecycleServiceV1`. It does not copy projects into the manual-project
registry, replace signed history, start an agent, or cancel running work.

## Behavior

- Active: pause or complete; paused: resume or complete.
- Completed: archive; archived: reopen.
- Controls expose only actions permitted by the current owner's grants. Ordinary
  project lifecycle permission does not authorize changes to Idea projects.
- The private `POST /api/v1/projects/:id/idea-lifecycle` route accepts only an action
  and expected version, with a browser-generated idempotency key.
- Uncertain saves retain the original key and body for explicit retry. A replay
  returns the original receipt even after later changes; the UI then reads current
  project state. No automatic write retry is added.
- Identity/session/grant authorization, existing policy decisions, signed registry
  transitions, audit and command receipts share one transaction. Session expiry at
  commit rolls everything back. Workspace and adapter checks prevent adopting an
  ordinary or another workspace's project.

Independent review found that the pre-existing domain service treated `resume` and
`reopen` as interchangeable because both target active. The service now checks the
source state after historical replay; regression tests exercise both restricted
action-grant cases. Re-review reported the finding resolved and no new concrete
defect in the inspected integration.

## Deployment implications — not production authorization

This release changes the exact `control_room_private_web` permission profile:

- SELECT and INSERT on `control_policy_decisions`.
- INSERT on `control_project_lifecycle_events` (already readable).
- Column-scoped UPDATE of `projects.payload` and `projects.observed_at`, alongside
  the previously permitted lifecycle projection columns.

The fresh-role script and strict startup preflight agree on this profile. No new
tables or schema migrations are needed. Previously prepared roles need a reviewed
privilege update before this release starts; do not rerun CREATE ROLE over an
existing role or grant broad UPDATE/ownership to bypass preflight. The deployment
inventory hashes change because the role source changed. No SQL was applied to
production by this implementation.

The bridge is composed only when `ideaProjects` supplies the existing integrity
key. The minimal `deploy/operator-config.mjs` profile does not supply that key;
this integration does not pretend the first website-only deployment enables every
Idea Lab capability. Configuring the saved-record key is separate private setup.

`pnpm test:idea-lifecycle` runs isolated database files sequentially and covers the
bridge, mounted restricted-role route, permission removal rejection, browser retry
binding and rendered controls. It is included in `test:idea-abs:delivery`.

The restricted-role fixture uses PGlite and the existing test-only database TEMP
metadata accommodation. These tests do not establish real PostgreSQL installation,
durable storage, backup/restore, real authentication, or production operation.
