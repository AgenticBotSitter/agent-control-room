# Settled-component implementation packages

Implementation status refreshed against branch `codex/component-batch-4`
through `478e719`. See CONTRIBUTOR_HANDOFF.md for the publication handoff and
remaining assignment boundaries. These changes are not yet accepted into main.
Substantial work, not automatic assignments. Read
[component decisions](COMPONENT_DECISIONS.md), [setup](SETUP.md) and
[contribution rules](CONTRIBUTING.md). Ask for maintainer assignment first.
Every issue must freeze an available public commit and exact files before coding.
Do not fetch private code or infer permission to operate a real agent or database.

## Current assignment status — read before the original package descriptions

The descriptions below retain the original intended outcomes, not an instruction
to rebuild work now implemented. None of the six full batches is accepted complete.
Freeze a published base containing the relevant implementation before assigning
contributors; a local branch name alone is not an available public starting point.

| Package | Implemented locally; do not duplicate | Remaining useful work | Current local verification |
| --- | --- | --- | --- |
| P1 project/results | Markdown renderer, protected result identity checks, task-switch isolation, clear-on-reauthorization, retained drafts, cancelled stale reads, ordinary/Idea archive-reopen and exact-key retry tests | Accessible keyboard/mobile/browser acceptance, project history presentation, separately admitted attachments | `pnpm test:results` (11 tests); physical browser acceptance remains open |
| P2 database | node-postgres adapter and pool lifecycle; previous native PG17 transaction/restore evidence; Postgres.js removal | Real queue/native recovery, release-bound operational configuration and deployment acceptance | `pnpm test:database`, `pnpm test:queue`; see POSTGRES_RESTORE_EVIDENCE.md |
| P3 attribution | Direct notices plus pinned CycloneDX collector, pnpm inventory, 193 runtime package-instance assembly and original-text rendering with explicit exception provenance | Independent review, portable inventory refresh, release output integration, bundle/asset/external-runtime coverage and unresolved entities version provenance | `pnpm test:notices` plus four runtime-license/exception test files listed in CONTRIBUTOR_HANDOFF.md; not full distribution clearance |
| P4 token/calendar | jsonwebtoken policy adapter; cron-parser/Luxon integration and occurrence persistence | Automatic dispatch/recovery, live login acceptance and release integration; no second parser/verifier | `pnpm test:access`, `pnpm test:calendar` |
| P5 news | Bounded extraction, source-bound storage/reader, collection-to-research task persistence | Qualified live sources/resource policy, physical browser acceptance and real agent research delivery | `pnpm test:articles`; no native agent execution implied |
| P6 workspaces | Native Git port, durable intent/removal, root identities and read-only restart observations | Safe re-adoption with current admission, in-flight mutation recovery, retention and runtime composition | See WORKSPACE_RECOVERY_INTEGRATION.md; native fixture execution requires its own scope |

Additional core work is not hidden by these contributor packages: real Idea Lab
participants and crash recovery (DR-01); exact-ID native connector recovery and
artifact admission (DR-17); owner key custody/consent/socket acceptance (DR-16);
independent checkpoint placement and supported split-commit recovery (DR-15).
For DR-17, the exact-ID projection, one-shot JSONL profile and owned read lifecycle
are already implemented (`pnpm test:codex-recovery`, 11 tests). Do not rebuild them.
The missing prerequisite is durable Codex-specific identity/admission evidence;
the existing Hermes dispatch is not interchangeable. See CODEX_READ_RECOVERY.md.
Queue/connector checks now include cancellation and synchronous-readiness
regressions (`pnpm test:queue`, 55 tests), not live recovery acceptance.
Optional Herdr retained-reader startup/API/UI are implemented, but actual collector
composition/host qualification and Kuma/Beszel acceptance remain unfinished.

Prioritize the first real task loop: approved task → native worker → retained
result → review → linked revision, with restart uncertainty handled honestly.
Do not expand optional monitoring to substitute for that missing operational loop.
Maintainers own its cross-component authority and final integration. Local tests
and documentation can proceed; credentials, listeners, live integrations and
production changes still require their scoped approvals.

## P1 — [Any OS][UI] Project navigation and accessible result reading

Start with `private-app/app/workspace.tsx`, existing project routes,
`app/components/project-catalog.tsx`, `private-app/app/task-results.tsx` and their
browser clients. Keep canonical project/result/review IDs. Use DR-11 for formatted
text; controlled project tabs may adapt the selected Desktop presentation after
exact source attribution review. No whole competing application or Electron shell.

Deliver separate project views, browser history/reload, archive/reopen, mobile and
keyboard navigation, formatted text/tables/code with plain-text fallback. Closing
a view only closes a view; it does not cancel work or delete a project. Keep raw
HTML and automatic remote images out of the initial renderer. Protected attachments
remain explicit follow-up work, not model-authored filesystem links.

Test ordinary projects, missing/denied results, exact review matching, stale response
after revoked access, repeated view IDs, storage refusal, accessible focus and
uncertain lifecycle saves. Exercise actual parent/client code, not only a renderer
with synthetic props. Extend existing demo/browser tests; add focused tests in the
assigned issue. Coordinate with existing public issue #1 rather than duplicate it.

Before assignment, the maintainer must name a focused synthetic production-panel
and parent test entry and its command. The current contributor demo renders a
different workspace: passing demo tests alone does not verify TaskResultsPanel.
Contributors must not need a configured private installation to test this package.

## P2 — [Any OS][Database][Maintainer review] Maintained database adapter

DR-10. Existing public starting points: `src/persistence/database.ts`,
`src/web/v1/private-postgres.ts`, `src/web/v1/bounded-database.ts`.
Implement one node-postgres adapter while retaining session bounds, transaction
and precommit behavior. Deliberately update package/lock/notices in this batch.

Test scalar/array/JSON/null values, UUID/timestamp callers, rollback, uncertain
commit, pending/late acquisition, active queries and repeated close. Destroying a
lease does not prove that a server statement never ran. No automatic replay or
silent driver fallback. A maintainer must supply the reviewed real-PG17 fixture
scope and latest caller-test export before marking this package ready. Remove
Postgres.js only after the import/build inventory proves it is no longer required.

## P3 — [Any OS][Build tooling] Complete release attribution

DR-03/04. Reuse pnpm's prepared graph and the selected build-time license-text
gatherer; no new resolver. Combine actual bundled files, runtime dependencies,
copied/vendor code, assets and separately installed runtime notices. Keep original
texts and changed-file attribution; do not infer rights from package metadata alone.

Deliver a deterministic release-bound notice inventory and failure tests for missing
text, conflicting/stale hashes and omitted copied assets. Build-time tooling must
not become a production service. Maintainers identify the exact public build entry
and retained-text exceptions before assignment. Rollback uses the matching build
and notices together; never mix two releases' inventories.

## P4 — [Any OS][Library integration][Maintainer review] Calendar and token adapters

DR-05/09. Two independently reviewable subparts may run in separate checkouts.
Use jsonwebtoken behind the existing synchronous policy boundary; preserve issuer,
audience, expiration, identity and cache/revocation checks. Use cron-parser field
expansion with retained schedule grammar, timezone/DST and occurrence semantics.
Neither library replaces permissions or the durable work engine.

Require actual caller parity plus malformed input, boundary dates, sparse schedules,
revoked identity and dependency-upgrade regression tests. Missing public calendar
fixtures must be exported before that subpart is assigned. Do not copy private
accounts, login metadata or scheduling data into fixtures.

## P5 — [Any OS][News] Source-bound article reading

DR-02/07. Reuse the existing collection/parsing and Readability/jsdom extraction,
not a new news service. The sanitized collection source is now included under
`src/project-adapters/` with news web modules under `src/web/v1/`. Before assignment,
freeze the exact public commit and focused news test entry; the source refresh
does not itself complete the article-extraction integration.

Deliver bounded source retrieval, saved provenance, article detail with summary/
source-link fallback, and existing research/guide actions. A fetched article is
not a completed native-agent result. Do not silently truncate oversized material
or raise shared result limits. Test extraction failure, duplicate refresh, archive,
source mismatch, private-network retrieval refusal and preserved research lineage.

## P6 — [Any OS][Git adapter] Owned disposable workspaces

DR-08. Use native Git detached checkout with exact revision/readback and current
lease/ownership checks. Preserve dirty or foreign-owned work; no reset/clean over
another person's checkout. Deliver contention, failed-create, restart and cleanup
tests with synthetic repositories. Maintainer must export and freeze the concrete
workspace interface/test set before assignment. No shared live checkout or copied
credentials/node_modules between machines.

## Shared verification and handoff

Use Node >=22.13.0 and pnpm11.19.0. Follow SETUP.md for frozen preparation. Current
public commands include `pnpm check:demo`, `pnpm check`, `pnpm build:demo` and
`pnpm test:demo`. An assigned issue supplies its exact additional test files.
Run database-heavy tests serially (`node --import tsx --test --test-concurrency=1`
with the assigned file list); do not run several full suites in parallel on a VPS.
Local tests do not authorize services, provider calls, credentials or deployment.

Handoff: public base/head commits, changed files, upstream pins/licenses, commands
and actual outcomes, unresolved failures, resource observations, cleanup and
rollback notes. Do not invent a pass or hide an uncertain operation. Ordinary
implementation mistakes can be fixed within scope; native attempts obey their
separately stated limits. One coherent PR per deliverable, independent review,
maintainer integration. Actions stays disabled.
