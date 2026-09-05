# CR14C private task workspace — repository acceptance

**Date:** 2026-09-05. **Disposition:** independently accepted; not deployed or connected to live dispatch.
**Accepted product:** `a8021de5d6744c796f4a31eb48b60000e27bd986`.
**Tree:** `fb75541d35e830a007bc2662e5af2eb5f8dcf777`.
**Base:** `7020280c8525052fe76bb1e1ab635d3b4359a72f` (PR #289 handoff).
Branch: `codex/cr14c-private-task-workspace`. Publication/current checks are tracked in `BUILD_STATUS.md`.
Subsequent acceptance/handoff edits are documentation-only. No merge or live effect is authorized here.

## Delivered

- Separate protected Tasks and task-detail pages for ordinary and owner-authorized Idea projects, sharing
  existing Access assertions, current membership, project grants and session revocation. Stable URLs support
  separate project/task tabs; bounded read refresh does not submit or retry work.
- A real canonical draft request/proposed workflow/proposed job saved atomically with audit and an immutable
  receipt. Concurrent identical requests and explicit lost-response reconciliation recover the same proposal.
  Previously uncertain saves retain their exact key through later permission/session denials.
- Task catalogs with 50-record pagination, requested instructions, canonical attempt history and existing
  integrity-verified agent observations. Native state, canonical job state and current availability are
  distinct. Stale/disconnected reports cannot appear to be current work; unknown time/tokens/cost stay unknown.
- Producer result hash/size claims displayed as unverified metadata, not delivered files or owner acceptance.
  No raw native session/connection handles, infrastructure, diagnostics or credentials are returned.
- Migration 0041's append-only proposal receipts and database insert guards. The private web role can insert
  only initial unassigned effect-free proposals, not transition canonical work, dispatch attempts or approve
  effects. Startup/preparation checks advance to the exact 128-table schema; no live database was migrated.

See `CR14C_PRIVATE_TASK_WORKSPACE_CONTRACT.md` for exact limits. Missing dispatch, artifact-content transfer
and review commands are visibly not connected; there are no pretend action buttons. The saved proposal's
immutable authority cannot later be silently expanded into an executable job.

## Independent review and final checks

Initial candidate `7444c42` was rejected for two Medium findings: uncertainty recovery after a later denial,
and a fresh but unavailable native observation appearing active. Root corrected both and added regression
combinations. Independent re-review accepted the exact product above with no remaining findings and **60
tests passed**. Both original and corrective reports remain in `docs/reviews/`.

All root checks below used installed dependencies and returned exit 0:

| Check | Result |
|---|---|
| Stage zero | Ready; no installation |
| New task-focused tests / registered `test:cr14c` | 28 / 102 passed |
| Registered pretest | 769 passed |
| Registered main test | 681 tests: 679 passed, two existing Windows-only skips |
| Registered posttest | 392 passed |
| TypeScript / full ESLint / cumulative whitespace | Passed |
| Private Node build / compiled artifact checks | Passed / 9 passed |
| Preserved Sites build / rendered artifact checks | Passed / 4 passed |
| Disposable migrations | 0001–0041 / 128 tables passed |

All listed test/build/type/lint/migration checks were rerun after correction; stage zero remained ready in
independent re-review. Actual restricted-role SQL and compiled handler tests cover the new task routes and
proposal write. Native fixtures exercise the recorded observation path, not a real agent or provider.
Server rendering/in-process HTTP checks are not observed browser-click acceptance. Build warnings about the
existing middleware convention and ineffective dynamic imports remain non-failing; no dependency upgrade.

## Remaining work

Canonical planning/admission/dispatch must materialize bounded executable work with the existing authority
services. Final result bytes must be transferred and verified; existing Completion Gate review/revision must
be connected without adding a second approval authority. The current task pages do not complete that journey.

Private PG17 setup/rehearsal, IdP/MFA/ingress, physical serving/browser acceptance and a qualified real agent
still require separately scoped operator work. No listener, real database, credential-store operation, actual
agent/provider, deployment or merge occurred. Continue authorized repository integration on **Astra Xhigh**.
