# Idea Lab and ABS workflow delivery

Owner priority, 2026-09-07: complete multi-bot Idea Lab and ABS news-to-research.
This supersedes the immediately previous research-first sequence, not security rules.
Branch: `codex/idea-abs-workflows`. Public release remains a separate reviewed snapshot.

## Implemented in this batch

- Idea Lab coordinator now sends each participant excerpts from the complete previous
  round instead of repeating an isolated first-pass prompt. First-round opinions stay
  independent. Full opinions remain in the existing registry. Excerpts are evenly
  budgeted and explicitly untrusted; no tool or execution authority changes.
- Multi-round prompt capacity is checked before admission, ledger preparation or any
  provider call. The existing 800-character filtered transport limit is not widened.
- Authenticated `POST /api/v1/projects/:projectId/tasks/from-abs` converts a validated,
  project-matched ABS proposal into an ordinary saved task through WebTaskService.
  Source URLs, digests, goal, requested capability/platform and original title are
  retained in the task. Provenance hashes are not independent verification of news.
- Browser client shares the original task-save idempotency and uncertainty handling,
  retaining the ABS endpoint on explicit retry. No parallel queue or SQLite authority
  was added. New tasks remain proposed and do not contact agents or publish content.
- Shared browser/server size preflight preserves full titles in instructions while
  abbreviating long headings. Combined provenance above the existing 4,000-character
  task format is explicitly unsupported; no sources are silently omitted.

## Evidence and scope

Commits `db0bf3c` and `34e3bc8`; `pnpm test:idea-abs` runs 25 passing focused tests.
Full TypeScript passes. Focused lint passes. The initial batch compiled for VPS and
passed six compiled/private-process tests; these are not physical deployment evidence.
Independent source review identified late capacity checking and mismatched title/
provenance limits. Both findings were addressed and source re-reviewed without a new
concrete finding. No independent test execution or live acceptance is inferred.

## Still required for the requested outcome

Storage update (`c522684`): migration 0059 and `PostgresAbsNewsStoreV1` now implement
immutable source versions, exact source/proposal reads, bounded pagination, and
source-bound proposal retention using the existing DatabaseClient/PostgreSQL stack.
No SQLite promotion, new database engine, role grant, feed or runtime activation.
Custom code is limited to Control Room's scoped story/proposal relationships; SQL
transactions, constraints and the existing validation/HMAC primitives do the storage work.
Independent source review found no concrete defect within the store/test scope.
The recomputed full private schema fingerprint is
`aac6f3f58ff464bf5d3a7227aa16efaf2beab0aba799db3b59b6248eff2f3a9f`.
Store/audit/database-role/rehearsal tests passed 27 checks in disposable PGlite;
this is not real PostgreSQL concurrent-worker or production migration acceptance.
Authenticated application wiring and its deliberately scoped SQL grants remain open.

1. Mount a non-fixture private Idea Lab workspace and ABS source/proposal queue through
   the authenticated application. Existing `/ideas` and ABS fixture UI are not live.
2. Use PostgreSQL for operational source/proposal storage. Existing SQLite ABS stores
   and live-read simulation coordinators must not become production write authorities.
3. Configure allowlisted news sources and reuse the selected normalization/deduplication
   helpers. Retain source attribution, freshness and failures. Do not label a source as
   verified solely because it supplies a digest. Large source packages need the existing
   artifact-storage path rather than dropping links to meet the text limit.
4. Route real bounded participant turns through admitted Hermes/Codex adapters. The
   protected operator remains repository-fake-only; this batch does not relax that gate.
   Preserve real discussion history, synthesis, owner promotion and project isolation.
5. Demonstrate article selection -> saved task -> eligible agent -> retained result ->
   review/revision, and multi-bot discussion -> owner decision -> separate project page.
6. Verify restart, disconnect, duplicate replies, revoked access, budgets and cancellation.
   Real configuration, provider calls and deployment need a consolidated scoped owner
   authorization; earlier one-shot qualifications are not reused permission.

Completion requires these actual journeys, not this component batch or synthetic tests.
