# CR14C private task results and recorded review — repository acceptance

**Date:** 2026-09-05. **Disposition:** independently accepted; no live activation.
**Accepted product:** `e5db1f436c7c3f9cf809fe5f2e3fbcf6122ae1a0`.
**Tree:** `bd248c36f9c32a349d82553a52ed4f7062923d7c`.
**Base:** `be668c5068c5e612e896562b4e10c8c75e856114` (PR #290 handoff).
Branch: `codex/cr14c-private-task-results`. Publication/current checks are tracked in `BUILD_STATUS.md`.
Subsequent acceptance/handoff changes are documentation-only. No merge is implied.

## Delivered

- Existing signed native completion evidence binds one exact task/run/attempt and separately supplied
  bounded UTF-8 result. An inert capture service writes and reads back approved artifact storage, then
  atomically records an existing canonical manifest, authenticated receipt and content-free audit entry.
  PostgreSQL remains metadata/coordination authority; private result bytes remain artifact storage.
- Deterministic artifact identity, exact recovery after lost SQL acknowledgement, concurrent same-result
  reconciliation and explicit orphan/uncertainty handling. Two-second logical I/O ceilings signal abort
  and quarantine the instance; neither timers nor failures imply native work was stopped or may restart.
- Read-only private result metadata/content routes under shared current project/session checks and an
  additional result-content grant. Both server and browser verify exact UTF-8 hash/size. Missing storage,
  changed bytes, stale review checkpoints and revoked access are unavailable, never healthy empty data.
- Existing Completion Gate history reads retain HMAC/external rollback protection and full-history status
  calculation. No checkpoint is initialized/advanced by reads. The website captures artifact/checkpoint
  read functions only, even when given fuller objects. Review records do not grant execution or approval.
- Task detail shows escaped, selectable result text and an exact open-file identity/fingerprint. Each
  recorded review explicitly matches or disagrees with that particular file. Large review projections
  omit older targets within a 524,288-byte budget with truthful flags; stored history is unchanged.
- Migration 0042 adds append-only result receipts and lock-only review integrity support. Explicit web
  read grants and schema/preparation pins advance to 129 tables; no real database was changed.

See `CR14C_PRIVATE_TASK_RESULTS_CONTRACT.md`. Physical upload transport remains unwired; result ingestion
is exercised through real signed authentication and disposable storage/SQL, not a live agent connection.
Owner review/revision commands are visibly not connected. Canonical job completion remains unchanged.

## Review and verification

Initial product `7c7afbae` was rejected for two Medium presentation/capacity findings. Both were corrected
and independently re-reviewed with **67 passing tests** and no remaining blocking findings. Original and
corrective reports remain in `docs/reviews/`; negative evidence has not been rewritten as an initial pass.

Root reran these checks after correction using installed dependencies; all returned exit 0:

| Check | Result |
|---|---|
| Stage zero | Ready, independently repeated; no installation |
| New focused result tests / registered `test:cr14c` | 27 / 129 passed |
| Registered pretest | 769 passed |
| Registered main test | 708 tests: 706 passed, two existing Windows-only skips |
| Registered posttest | 392 passed |
| TypeScript / full ESLint / cumulative whitespace | Passed |
| Private Node build / compiled artifact tests | Passed / 10 passed |
| Preserved Sites build / rendered artifact tests | Passed / 4 passed |
| Disposable migrations | 0001–0042 / 129 PostgreSQL tables passed |

Actual disposable filesystem readback/reopen, PGlite transactions, restricted SQL role, existing signed
node frames, current Access/session handlers, Completion Gate checkpoint fixtures and compiled private
routes were exercised. Browser-client/controller and server-rendered markup tests are not observed browser
clicks. No dependency/lockfile upgrade. Existing non-failing build convention warnings remain.

## Remaining gates

Next is owner review/revision-request command integration and bounded executable planning/admission/
dispatch. Do not naively place Completion Gate checkpoint writes inside the web session transaction:
permission/expiry rejection before commit must not advance an external checkpoint. Existing rollback
protection must remain fail-closed on genuinely uncertain checkpoint/SQL outcomes.

Physical artifact transport/storage retention, qualified real agents, actual private PostgreSQL setup/
rehearsal, IdP/MFA/ingress, serving/browser acceptance and deployment remain separately scoped work.
This block did not use a listener, real database, credentials, native agent/provider, deployment or merge.
The complete C-WORK journey and operational private-beta exit remain unfinished. Continue on **Astra Xhigh**.
