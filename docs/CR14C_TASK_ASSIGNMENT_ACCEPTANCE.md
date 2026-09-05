# CR14C — task assignment and expiry acceptance

Date: 2026-09-05. Accepted product: `daf656633e2bbaafb1669080359f0ea76be778b0`.
Tree: `42d76aa2a6e5703471a96826a21a3c6c7f14c3b0`.
Base: `0231d00d173bdb3cf3d82f027ac26e277cb2d6c3` (PR #295).

## Delivered

- Real SQL preparation-to-assignment path: the child request/workflow/job advances atomically to
  one canonical attempt and bounded lease. The source proposal remains unchanged.
- Configured machine/platform selection through an optional protected page/API operation. Current
  owner/session/grants, immutable plan, active node/key, fresh fleet reports, capacity and deadlines
  are checked at assignment. Fleet reports are scheduling hints, not native qualification.
- Exact lost-reply/restart reconciliation without a second attempt or renewed lease. Explicit
  elapsed-lease reconciliation releases the reservation without claiming an agent was stopped.
- Disposable chain through assignment, injected native run evidence, signed result delivery and
  owner change request. The native admission/start/output gap remains synthetic.
- Preserved least-privilege web SQL role and separate production bootstrap. No runtime activation.

## Evidence

Independent review accepted the corrected product after one P3 refresh-order finding. See
`reviews/CR14C_TASK_ASSIGNMENT_REVIEW.md` for the exact commits, correction and 37 passing tests.
Root retained and fixed a compiled logout-response failure rather than weakening its assertion.
An initial mirror-corruption test correctly hit the database guard; the corrected test first proves
that refusal, then injects a malformed returned row to test coordinator validation. No guard was disabled.

Final root verification, all exit 0:

| Check | Result |
| --- | --- |
| Effect-free stage zero | ready_for_runtime_check; native readiness not run |
| TypeScript, ESLint, whitespace | Passed |
| Focused CR14C | 223 passed |
| Registered pretest | 769 passed |
| Registered main test | 802 total: 800 passed, 2 existing Windows-only skips |
| Registered posttest | 392 passed |
| Private Node production build / compiled tests | Passed / 13 passed |
| Sites production build / rendered routes | Passed / 4 passed |
| Disposable migrations | 0001–0045; 132 PostgreSQL tables; unchanged schema |

Installed dependencies were invoked directly with Node. No installation, download, physical listener,
database service, native credential access, provider/native call, deployment or merge occurred.
Sites guidance preserved the separate Sites/private Node build profiles; no browser interaction occurred.

## Remaining

This is repository/compiled/in-process acceptance, not a running beta. The ordinary production
bootstrap deliberately rejects planning/assignment configuration until the coordinator's bounded
resource ownership is implemented. Actual signed approval, local admission, dispatch, physical
artifact transfer and bounded revisions remain. Real PostgreSQL concurrency and mounted browser
checks remain separate evidence, not claims derived from these disposable/static tests.

Continue coordinator ownership and executable admission/approval/dispatch on **Astra Medium**.
