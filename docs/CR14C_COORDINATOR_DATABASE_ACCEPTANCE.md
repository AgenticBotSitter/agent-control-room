# CR14C — coordinator database gate acceptance

Date: 2026-09-05. Accepted product: `9e4c370353e513857f69dbe93aaa13f6983ff126`.
Tree: `b941da0612941418f6762e373cc6f081008f9b69`.
Base: `87f60511cb96516f5d5ab7c5159a82bb875953be` (PR #297).

## Delivered

- Dedicated narrow task-coordinator NOLOGIN role and fixed-profile read-only preflight, separate
  from the private web role and the broad legacy application role.
- Migration 0046 constant-false lock columns on five tables and a role-specific outbox guard that
  permits supported pending domain transitions, not dispatch commands.
- Real restricted-role planning, assignment, replay and expiry tests, plus denial of identity,
  grant, node-key validity, fleet, completion-integrity, approval and unrelated writes/reads.
- Exact extra/missing privilege, elevated membership, disabled trigger/constraint and stale owner
  rejection; existing restricted-web behavior preserved.
- Updated schema fingerprint and fixture-preparation manifests/current setup contracts for 0001–0046.

## Evidence

Independent review accepted with no actionable findings and 50 passing tests. See
`reviews/CR14C_COORDINATOR_DATABASE_REVIEW.md` for the exact candidate and command.

Final root verification, all exit 0:

| Check | Result |
| --- | --- |
| Effect-free stage zero | ready_for_runtime_check; native readiness not run |
| TypeScript, ESLint, whitespace | Passed |
| Focused CR14C | 250 passed |
| Registered pretest | 769 passed |
| Registered main | 829 total: 827 passed, 2 existing Windows-only skips |
| Registered posttest | 392 passed |
| Private build / compiled tests | Passed / 14 passed |
| Sites build / rendered routes | Passed / 4 passed |
| Disposable migrations | 0001–0046; 132 PostgreSQL tables |

Current schema digest: `dab0f6b51a3f60768873d2eae4ec4804a5ed93006e1bcc9a1400a9c14e0b0b2a`.
Earlier fingerprint claims remain historical. Existing PGlite TEMP privilege metadata is still the
sole injected preflight field; the unchanged production gate refuses its actual value.

Initial fixture setup quoted search_path incorrectly, causing missing relations and a different
schema rendering; it was corrected without weakening preflight. The actual role pipeline then
exposed the required project locking privilege, resolved with the same inert lock column rather
than granting authority-bearing UPDATE. An assertion overload typing error was also corrected.
These initial failures are not evidence of a live database attempt or permission repair.

## Remaining

No roles or migrations were applied to a running database. Tests used disposable PGlite; no real
PostgreSQL ACL/socket/concurrency qualification, native/provider call, credential access, physical
listener, deployment or merge occurred. Installed dependencies were invoked directly; Sites guidance
preserved the separate build profiles without hosting or browser interaction.

The gate does not mount the coordinator into production startup. Continue verified two-pool startup
and shared compiled-page installation on **Astra Medium**, then signed approval/local admission/
dispatch, physical result transfer and bounded revisions. The wider goal remains incomplete.
