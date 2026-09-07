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

### Retained Idea Lab discussion access

`0599aea` adds protected GET `/api/v1/ideas` and `/api/v1/ideas/:sessionId`.
These use owner-only workspace-wide session read/list grants, shared session revocation,
and the existing keyed registry. Detail returns retained contributions, synthesis and
owner decision; it does not infer a live run state from their presence. Missing keys are
explicitly unavailable, with no fixture fallback. Exact selected session identity and
workspace are checked; cursor pagination retains every session instead of truncating at 25.
The private SQL role template adds SELECT only on sessions/contributions/syntheses/decisions.
No SQL grants were applied outside disposable tests. Page mounting and commands remain open.
Four added tests cover retained records/reopening, owner/operator rejection and wrong scope/key,
52-session pagination, protected HTTP routes, and denied Idea table writes. TypeScript,
focused lint, VPS compilation and 41 combined workflow/compiled-app tests pass locally.
Independent review found a possible READ COMMITTED mixed snapshot. `e04fb08` validates
the exact returned contribution/synthesis/decision tuple with existing parsers and rejects
an incoherent response. The new interleaved-visibility regression and all four Idea read
tests pass; this is injected statement visibility, not real PostgreSQL concurrency evidence.
Independent source re-review found no residual concrete defect in the correction.

### Protected saved-news workflow and full idea brief

`b98991a` and `91a82fe` add a private project News page, authenticated GET list and
read-only POST preparation. Research/setup-guide preparation reads an exact HMAC-checked
retained story, rejects unreviewable sources and inactive projects, and returns a draft
without storing a proposal or dispatching anything. The user inspects this draft and saves
it through the ordinary task command; all source links/digests are retained in instructions.
The preview proposal identifier is a draft reference, not a separately stored proposal.
The web role gains SELECT only on `control_abs_story_versions`; ingestion and proposal
storage remain inaccessible. Configuration accepts a supplied news integrity key but
does not create one, collect sources, apply grants or activate a service.

Independent source review found the 1,500/1,200 goal mismatch and navigation that could
lose an uncertain save key. Both were fixed and re-reviewed without new concrete findings.
Departure guarding preserves the active form, but is not persistence across forced closure
or a user overriding the browser warning. Five news tests cover service/HTTP source-bound
preparation and save/replay, revoked access, restricted role rights, SSR rendering and
simulated navigation guards. Real browser interaction and production PostgreSQL remain untested.

`69817c3` preserves title, full idea summary and target customer in the operator's prompt,
instead of passing only the title. Capacity is checked before a new session is registered
and again for older sessions before starting. The 800-character transport bound is unchanged;
long briefs fail explicitly rather than losing owner context. A two-round fake-driver test
proves all three fields reach all eight turns and oversized input creates no session/call.
`pnpm test:idea-abs` now passes 34 tests. Full TypeScript and focused lint pass.
The Idea Lab prompt correction also passed independent source review; older-session
capacity rejection was source-inspected but is not directly covered by the added test.
The final VPS artifact rebuilt successfully and six compiled/private-process checks
passed. Twenty-six earlier audit/role/rehearsal/news checks passed (overlapping suites,
not an additional unique-test total). No listener, feed, provider call or deployment.

Earlier component evidence:

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
Authenticated read/draft wiring and its SELECT-only role template are now implemented
above; actual deployment/migration and source ingestion remain open.

1. Mount a non-fixture private Idea Lab workspace through the authenticated application.
   Private saved news is mounted; existing demo `/ideas` and ABS fixture UI are not live.
2. Complete ingestion and operational use of the implemented PostgreSQL store. Existing
   SQLite ABS stores and live-read simulation coordinators must not become production authorities.
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
