# Package 4 disposable rehearsal — 2026-09-25

Scope: isolated Mac checkout and two disposable loopback PostgreSQL clusters. No live VPS database, network policy, or production protected root was changed. This is not W7 acceptance.

## Observed

- Release build and TypeScript check passed. The built provider import initially failed because Vite replaced an owner-held dynamic import with a nonfunctional stub; a native `vite-ignore` import corrected that, and the built loader then loaded the fixed three-export module.
- A fresh zero-project rehearsal started the loopback website. The W6 script confirmed local sign-in, denial of a wrong code and foreign origin, project creation, exact replay, and project read. This was not a restart pass.
- After creating the first project, the three-worker provider constructed and reported ready when invoked directly against the disposable database. This exposed and corrected two integration defects: a digest prefix in an adapter revision that requires plain hex, and a duplicate Hermes executor wrapper.
- Fleet signal refresh exposed a PostgreSQL BIGINT/string sequence comparison bug; a focused regression test now covers sequence 2. A filesystem measurement failure remains an unavailable signal that blocks assignment.
- The first rehearsal fixture lacked the pre-provisioned pg-boss queue. The fixture now installs that queue offline before trying to start workers. Application startup still never creates or migrates it.

## Blocking result

`mac:up` with one active project still exits with `native_queue_worker_start_failed`. The disposable fixture gives all four logins broad `control_room_application` membership. The real queue-worker preflight instead requires a login inheriting **only** its dedicated `control_room_native_queue_worker` role, with exact table and database privileges. The fixture is not a valid role-isolation proof. The existing VPS role setup similarly appears to grant broad application membership; that observation is from source review, not a live privilege audit.

Do not weaken the queue-worker preflight, treat four successful connection checks as role isolation, or mark section 9's three pending-review journeys complete. Package 5 needs the reviewed role setup and a fresh rehearsal before this host can pass. A separate result-inspection concern also remains: publishing a review target does not by itself prove that owner review can inspect every current Hermes, Claude, and Codex run shape.

## Next gate for the lead

Review package 4's source changes and decide how the already-planned package 5 provisions exact roles, queue grants, and review inspection. After that, repeat `mac:up`, require `/api/v1/local-workers` to list three ready workers, and run one harmless task per worker to pending review exactly once. Until then, no live installation claim is justified.
