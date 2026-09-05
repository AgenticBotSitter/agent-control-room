# CR14C — native start authority acceptance

Date: 2026-09-05. Independently accepted unwired start/live-read component.
Base: `396c8a68b2b80bc8ce3f5ef2ebb133965a44b561` / PR #300.
Accepted product/test head: `9bcaac9631b14f6625281bbf5ac5f8feb8ae9510`.
Tree: `aa9b697115a0dbb6d1b710bb5868d1a4ab9bcc61`.
Contract: `CR14C_NATIVE_START_AUTHORITY_CONTRACT.md`.

## Delivered

The node start controller now combines exact approved payload binding, current local policy evaluation,
profile verification seam and durable admission/execution/effect markers before the existing native
adapter's fake-tested submission. Every transport authorization rechecks current permission. Existing
execution/claims are not reused to start again; uncertain saves remain quarantined. Exact live status
reads cannot resurrect durable expired execution using an earlier clock.

Effect capacity is checked atomically within the shared local SQLite claim transaction, including
different tasks with stale policy counts. Integrity-checked claimed/executing/ambiguous records retain
capacity. The bounded full-row scan refuses corrupt projections and excess retained records rather
than silently hiding active claims. PostgreSQL remains sole global write authority.

## Independent review and corrections

`cr14c_start_authority_review` reviewed candidate `cf3161f013255a0b136f10ea75dd0082872b65ae`.
Its initial three-file suite passed 36 tests, but its independent repeated-timeout probe exposed M-001:
caller timeout released a slot while a resolver could still be pending. Two batches created 16 unresolved
operations despite the documented limit of eight. The initial candidate was not accepted.

The accepted correction retains each slot until the underlying promise actually settles, handling both
outcomes. A regression tests three timeout batches and eventual slot release after late failures.
Re-review of the exact accepted head/tree passed **37/37 tests**, exit 0; the original probe now starts
only eight unresolved operations. No remaining blocking findings. Final acceptance belongs to Codex.

Earlier development failures remain recorded: TypeScript required avoiding a narrowed phase comparison;
the distinct-task fixture initially exhausted canonical route capacity by assigning its default task
before creating the second task. The fixture now assigns only its intended task; no capacity rule was
relaxed. Targeted tests passed 30, then 31 after durable-expiry coverage, then **32** after M-001 coverage.

## Verification

- Repository stage zero ready; no native readiness or qualification attempt.
- Final TypeScript and full ESLint: exit 0; whitespace check passed.
- CR14C suite on the initial candidate: **288 passed**. The final correction is additionally covered
  by the 37-test independent suite and the final main suite, not misreported as a rerun of all CR14C tests.
- Full lifecycle pretest: **769 passed**; final main suite: **868 passed**, two existing platform skips
  (870 total); posttest: **392 passed**. All lifecycle commands exited 0.
- Private Node build and **16 compiled artifact tests** passed.
- Separate Sites build and **four rendered route tests** passed.
- Disposable migrations 0001–0046: **132 tables**, no schema change in this block.

Build regression checks preceded the resolver-slot correction. This unwired module does not enter either
application route tree; final TypeScript/main/reviewer tests cover the correction. Tests use disposable
PGlite/SQLite, synthetic signing keys and explicit fake transport/profile/ceiling provenance. They do not
prove live signed-lease provenance, installed qualification, physical persistence or owner key custody.

## Remaining and authority

Next on Astra Medium: separately typed exact-run stop and post-deadline observation authority, real trusted
resolver composition, owner approval issuance/intake, signed dispatch and bounded revision submission.
Stop and post-deadline access remain deliberately denied by this start-only controller. Full C-WORK is
not complete. No native/provider call, credential operation, install/download, physical listener, real
database setup, deployment or merge occurred. Current-head CI and dependency-order integration remain
required. PR #300's run `33981299049` ended cancelled at 2026-09-05 17:53:11 UTC, not passed.
