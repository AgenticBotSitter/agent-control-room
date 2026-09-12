# Selected implementation packets — partial handoff

2026-09-08, baseline `d87af13`. These packets expand settled decisions into
actionable work. They do not replace the unfinished all-outcomes plan, authorize
production changes or declare unresolved queue/client/checkpoint choices settled.
Root retains security, schema, integration and final acceptance. Independent
reviewers must not approve their own implementation.

## Shared preparation and release rules

Use a separate clean feature checkout based on the eventual reviewed integration
commit, not another worker's active tree. Inspect current status and run repository
stage zero first; if dependency preparation is needed, use Node >=22.13.0 and
`CI=true pnpm install --frozen-lockfile` with pnpm11.19.0. A dependency change
requires an intentionally regenerated, reviewed lock; frozen installation is the
subsequent reproducibility check, not a command to add dependencies.

Run heavy database/build checks serially and preserve split-memory test files.
The current `test:build:vps` script does not serialize its individual Node test
processes. Do not rely on serial package invocation alone. For the release gate
below, use `pnpm build:vps`, followed by the test file list from that script with
`node --import tsx --test --test-concurrency=1`. Capture the exact resolved list in
the implementation evidence; do not omit cases or run the unspecialized script in
parallel with database work. This is a planned invocation change, not a package
script edit made by this research packet.

Exact current compiled-release gate (refresh if the package's file list changes):

```sh
pnpm build:vps
node --import tsx --test --test-concurrency=1 tests/vps-built-multi-project.test.mjs tests/vps-built-handler.test.mjs tests/vps-built-startup.test.mjs tests/vps-built-serving.test.mjs tests/vps-built-rehearsal.test.mjs tests/vps-built-preparation.test.mjs tests/vps-built-results.test.mjs tests/vps-built-owner-review.test.mjs tests/vps-built-planning.test.mjs tests/vps-built-assignment.test.mjs tests/vps-built-task-application.test.mjs tests/vps-built-task-startup.test.mjs tests/vps-built-approval.test.mjs tests/vps-built-quality.test.mjs tests/vps-built-revision-planning.test.mjs tests/vps-built-revised-result.test.mjs tests/vps-built-capacity-release.test.mjs tests/vps-built-owner-revision-interface.test.mjs tests/vps-built-result-ownership.test.mjs tests/vps-built-native-evidence.test.mjs tests/vps-built-managed-native-sessions.test.mjs tests/vps-built-launcher.test.mjs tests/vps-built-core-schema.test.mjs tests/vps-built-database-check.test.mjs tests/vps-built-node-launcher.test.mjs
```
Run `pnpm check` and focused checks before a full `pnpm lint` / private release
build. These are planned acceptance commands, not passes obtained by this document.
No provider calls, owner profiles, service installation, GitHub writes or live
configuration changes are implicit. Current work stays local; batch reviewed
changes rather than triggering CI for each small edit.

## IP-04 — maintained database driver, existing authority unchanged

**Outcomes:** A1/A5/B1 shared database port; DR-10. Root-owned integration and
security review. Implementer may work on the isolated driver/tests after the final
research handoff; this document is not authorization to deploy. Estimated medium
batch; no model override required by this packet. Queue-engine choice stays separate.

**Sources and scope:** node-postgres8.23.0 public Pool.connect/end and client
query/release(true), with pg MIT notice and complete resolved runtime dependencies.
Use src/persistence/database.ts, src/web/v1/private-postgres.ts and a proposed
src/web/v1/private-pg-driver.ts for the concrete connection composition. Keep
src/web/v1/bounded-database.ts authoritative; do not loosen its deadlines, errors,
precommit or no-retry behavior. Dependency/lock/notices are part of the same batch.

1. Inventory every postgres runtime/test/build import. Implement one explicit pg
   target/options mapping and shared-session DatabaseClient adapter. Preserve
   loopback-only PG17, primary check and session settings; no ambient PG variables,
   configuration mutation, DNS fallback, automatic driver fallback or write replay.
2. Implement exactly-once acquired-lease release and tracked pending acquisition,
   close admission before destroy-on-release, and await bounded pending settlement.
   Test connect-in-flight/late rejection/late success, multiple leases, repeated
   close and active/queued queries. Use a reviewed timeout margin; do not copy the
   research200/500ms values. Closing a client does not prove server non-execution.
3. Run actual outbox claim and native UUID recovery alongside JSON/scalar/text/
   array/null regression cases; use existing DeliveryStore and queue methods, not
   only synthetic predicate rows. Verify failed COMMIT remains uncertain and existing
   canonical reconciliation handles it without resending. No new recovery protocol.
4. Run check/lint, relevant existing database/submission/worker tests, disposable
   real-PG17 schema/role/preflight and the serialized compiled-release gate above.
   Preserve memory-safe split tests. Exact production namespace/owner deployment
   stays separate; no credentials or live service acceptance inferred from local tests.
5. Remove Postgres.js only after the import/package/build inventory is empty or an
   explicit remaining development-only responsibility is documented. Preserve public
   contracts consumed by the app; retain no silent two-driver fallback.

**Done means:** actual caller values and exact session atomicity preserved; race/
uncertain-outcome evidence retained; direct dependency notices complete; independent
review accepted. Zero production code is removed by the research itself.
**Rollback:** revert the immutable app/dependency release after draining admissions;
no schema migration is needed merely for driver replacement. Do not treat a binary
rollback as permission to replay uncertain writes. Deployment is separately gated.
**Evidence/alternatives:** f1-driver-selection-draft.md and independent review,
f1-parameter-callsite-audit.md, binding/uncast/queue/shutdown receipts. Targeted
Postgres.js typing/custom types remain fallback design alternatives if the concrete
pg implementation fails acceptance—not runtime fallback behavior.

## IP-01 — maintained JWT implementation, unchanged owner policy

**Outcome:** A2; DR-05. This can proceed independently of the queue choice during
the approved implementation phase. Root owns verifier/policy review; a bounded
implementer may change only the named primitive and tests. Estimated effort class:
small-to-medium integration, not a measured duration or a model requirement.

**Files:** `src/web/v1/access-verifier.ts`, `package.json`, `pnpm-lock.yaml`,
selected dependency notices; verifier/caller tests as needed. Preserve the public
synchronous caller contract. Use jsonwebtoken9.0.3 and its actual typed import;
add maintained typings only if required by the selected package/toolchain. Remove
superseded standard JWT decoding/signature work, not application identity, canonical
claims, time bounds, trusted-key cache, freshness or digest semantics. No DB schema,
Access provider, hostname or owner credential change. Do not ship jose alongside it.

**Acceptance:** replay the actual policy parity/denial cases from the DR-05 dossier
against the installed production import, not a separately loaded research copy.
Run:

```sh
pnpm check
node --import tsx --test --test-concurrency=1 tests/web-access.test.ts tests/web-access-key-cache.test.ts tests/web-private-process.test.ts tests/private-owner-bootstrap.test.ts
pnpm lint
# Run the serialized compiled-release gate described above.
```

The exact downstream caller inventory in `f8-jwt-caller-audit.md` also governs
coverage: identity changes, wrong owner/origin, expiry, invalid signature/algorithm,
cache behavior and denial before task effects must remain equivalent. Passing the
four named files alone is not a waiver of that inventory. Complete dependency and
actual distribution notices accompany the change.

**Rollback:** retain the prior immutable application package and lock. Since no
schema/provider migration is part of this packet, rollback restores the prior
verifier package without disabling authentication or changing owner policy. If
the old version has an actual security defect, do not use rollback to reintroduce
it; stop admission and obtain a corrected release. Real owner MFA/subject/origin
acceptance is separate target work, not another library selection contest.

## IP-02 — readable ABS articles using the selected extractor

**Outcome:** C3 with C4 lineage; DR-02/07. Root first approves the narrow source
detail persistence/authority design; presentation and extractor integration can
then be delegated separately. Depends on existing news collection, not a new feed
reader service. Estimated effort class: medium, with storage design still unpriced.

**Existing files to integrate:** `src/project-adapters/abs-news/v1/story.ts`,
`discovery-ingestion.ts`, `src/web/v1/news-wire.ts`, `news-service.ts`,
`news-reading-view.ts`, and their actual page/client consumers found at dispatch.
Add only the source-bound detail/extraction boundary selected by root, plus
manifest/lock/notices for Readability0.6.0 and jsdom26.1.0. Do not silently change
the story schema/digest, discovery freshness or `newsResearchInputSchema` binding.

Use plain text initially, retaining canonical source URL, story/digest association,
extractor version, byte hash and explicit complete/partial/failure status. Full
DOM processing must have explicit time, memory, input and output limits and inert
configuration: no page-script execution or parser-triggered network/resource
loading. Exercise hostile script/resource markup and resource exhaustion in an
owned isolated process, proving bounded termination and fallback. Plain-text
output alone does not make parsing inert or bound its memory.
Full reading remains required: summary plus link is failure fallback, not completion.
Never put fetched articles into `NativeResultStore.capture` by inventing a completed
run. The inspected storage implementations'64KiB limits require an explicit
per-feature policy, not silent truncation or a shared native-result limit increase.
If a schema migration is selected, name it, add role tests and include disposable
real-PG verification before acceptance; no migration is invented in this plan.

**Acceptance:** actual package output through the real protected detail/storage
interface; two projects, stale story, repeat extraction, changed bytes, parser
failure, oversized content and expired access. Article text cannot change an
already approved task's source binding. Existing research/guide actions still
produce ordinary tasks with retained source lineage and reviewed results. Run:

```sh
pnpm check
node --import tsx --test --test-concurrency=1 tests/news-reading-view.test.ts tests/web-news.test.ts tests/control-center-ingestion.test.ts
pnpm test:abs-research-journey
pnpm test:idea-abs:delivery
pnpm lint
# Run the serialized compiled-release gate described above.
```

Add actual detail-route/browser/storage negative tests; the existing commands do
not cover a feature that has not yet been added. Real approved sources and native
research results remain target acceptance; synthetic worker results are not live
proof. Code licensing does not confer republication rights to source articles.

**Rollback:** disable/remove the optional detail projection while preserving
existing summaries, links, canonical story/task IDs and all reviewed results.
Retain versioned detail evidence where it underpins task lineage. Any migration
must be additive or have its own reviewed compatibility/restore plan; never drop
source evidence simply to restore the old UI.

## IP-03 — complete release notices and a usable contributor package

**Outcome:** D5 across every imported component; DR-03/04 and the independently
reviewed actual client/RSC/SSR build. Root owns release/export review. A bounded
implementer owns build-time inventory/assembly; a different reviewer verifies the
actual distribution. This is a substantial release package, not one PR per notice.
Estimated effort class: medium, increasing if selected runtime dependencies change.

**Existing boundaries:** `vite.config.ts`, `package.json`, `pnpm-lock.yaml`,
`third_party/`, `src/vendor/control-center/`,
`docs/research/pinned-upstream-notice-texts.json`,
`docs/research/DEPENDENCY_NOTICES_DRAFT.txt`, and current public-package/export
tooling. Add a narrowly scoped build-time assembler and its tests, with final
paths chosen at implementation dispatch. Do not move research-only candidates
into runtime dependencies or ship private research reports automatically.

Use the actual tested rollup-plugin-license3.7.1 per-environment integration for
bundled identities, the prepared pnpm11.19 graph for runtime externals, and the
CycloneDX10.2 public text gatherer for original texts. Preserve every callback:
an early empty callback must not erase later server records. Add only explicit
reviewed pinned exceptions from `f9-build-notice-resolution.md`; the three missing
third-party texts already exist. Re-downloading them or writing another generic
dependency graph scanner is not part of this packet.

The assembler must separately account for original project license/NOTICE,
copied Control Center source and changes, external runtime dependencies, nested
vendor texts, emitted CSS/favicon and other assets. Do not treat the experimental
field named `externals` as a verified external package set: it contains internal
chunk names. Do not substitute a root SPDX label for original notice texts or
assume a source `third_party` directory is included in `dist-vps`.

**Acceptance:** build the actual selected release, collect all three environments,
write the assembled notices into the deliverable, and verify its final file/hash
inventory. Test missing text, changed hash, conflicting record, stale lock/build,
omitted copied file and missing external-runtime entry. Fail packaging with an
actionable exception rather than silently claim full coverage. Reuse actual-build
research receipts for API selection, not as proof the new distribution is complete.
Run the serialized compiled-release gate above and the existing public-package
mechanical/security checks appropriate to the selected export, plus new assembler
negative tests. Exact new test filenames must be recorded before delegation.

Prepare generic examples, README/status, contribution instructions and sizable
work packets with source provenance, platform prerequisites, local commands,
independent review and explicit unmet acceptance gates. Owner Apache choice
applies to original project code; imported files keep their own applicable terms.
No private hostname, owner configuration, credentials or private consumer data
belongs in the public export. Publication remains separately authorized and no
GitHub Actions run is required to prepare or validate this local package.

**Rollback/update:** keep each immutable build, its dependency lock, original
texts and notice inventory together. Never mix a previous release's notices with
new code. A packaging failure blocks publication, not authentication or running
task authority. Rebuild notices when any selected source/dependency/asset changes;
release rollback restores the corresponding complete package. No DB migration or
production service change is introduced by this packet.

## Still due in the final handoff

## IP-05 — separate project views and lifecycle, retained authority

**Outcomes:** A6, C2 and the project-navigation portion of C1/A7. This sizable
presentation batch can proceed independently of native-client selection once its
source attribution and final root disposition are reviewed. It must not claim
native session monitoring or complete conversation rendering.

**Reuse decision and evidence:** retain current catalog, stable project URLs,
protected client/service, ordinary lifecycle and Idea-origin lifecycle operation.
Adapt only the controlled ActiveSessionsBar presentation from Hermes Desktop
`3f744975f818bbb40ed029e6b3022cd0c5ad7a24`, if the tab strip improves the existing
layout; no Electron shell, global raw-session loading set, IPC or stop callback.
The actual108-line body has mounted E3 evidence in `f3-mounted-fit.md`, including
the17-check corrected delayed-response/auth-expiry race receipt. Add accessible
controls because unmodified tab focus failed. WebUI
`e168b67e4278df618d1cab61fdb3a8dc55b29a81` native action structure and stale-stream
scenarios are complementary references; copying its global DOM factory into React
offers little benefit. Do not import the full WebUI shell or Studio's differently
licensed source. Exact selected file hashes/licenses remain in F3 acquisitions;
retain original notices and changed-file attribution in this release.

**Existing integration boundaries:**

- `private-app/app/workspace.tsx`, `app/components/project-catalog.tsx`,
  `app/components/project-catalog-navigation.tsx`, and private header/layout.
- `private-app/app/projects/page.tsx` and existing `[projectId]` routes, including
  tasks/news/sections. Preserve deep links and browser history.
- `src/web/v1/browser-client.ts`, `project-wire.ts`, `project-service.ts` and
  `idea-project-lifecycle-operation.ts` retain ownership, permissions, expected
  versions and original idempotency keys. No new project database/catalog service.

**Implementation:**

1. Add a controlled, bounded open-project view strip keyed by authorized project
   IDs. Opening or focusing a view reads existing data; closing it changes view
   state only. An agent's coincident raw session ID must not identify a project.
2. Support direct link, browser Back/Forward, reload and reopening a closed view.
   If storing view preferences locally, persist only minimal scoped IDs, never
   credentials or private titles/content. Reauthorize before rendering restored
   entries; clear in-memory private state on denial and fence delayed responses.
   Storage refusal or corrupted preferences must fall back to the normal catalog.
3. Keep three distinct controls: close view, project lifecycle change, explicit
   task cancellation. The first two never claim to stop agents. Ordinary projects
   already have lifecycle transitions; Idea-origin projects have a separate
   reviewed operation. Wire both without replacing either domain contract.
4. Show active/paused/completed/archived project state from canonical records, and
   allow owner-authorized archive/reopen with existing conflict/uncertainty UX.
   Archive is not deletion; retain tasks, results, review and Idea backlinks.
5. Provide keyboard focus, native buttons/links, meaningful selected-state labels,
   overflow behavior and usable narrow-screen navigation. If implementing ARIA
   tabs, implement its full focus/selection pattern, not just role attributes.
6. Route project→task→result/review and Idea→promoted project consistently. Unknown
   sessions or offline workers must not become fabricated idle/completed status.
   Conversation/retained-file renderer choices are a separate packet dependency.

**Acceptance:** extend existing `project-catalog.test.tsx`,
`project-workspace-navigation.test.tsx`, `project-workspace-catalog-session.test.ts`,
`web-project-foundation.test.ts`, `web-idea-project-lifecycle-controls.test.tsx` and
`web-task-navigation-recovery.test.tsx`. Add a proposed
`tests/project-open-views.test.tsx` for view identity/persistence/close behavior.
Record exact test selection before worker dispatch. Use a real browser with
disposable protected project data for keyboard, mobile-width, reload/history,
archived reopen, storage refusal and late-success-after-expiry behavior. Assert
closing/archiving creates no cancellation, job, lease mutation or provider call.
Compare ordinary and Idea-origin projects; include unauthorized project IDs,
duplicate native session IDs, revoked identity, lifecycle version conflict and
uncertain save replay. Run check/lint and the serialized release gate above.

**Cost/rollback:** source adaptation estimates100–250lines remain estimates, not
measured production cost. The1.64MB combined development fixture is not a bundle
comparison. No production lines removed or schema migration is required by the
view strip; measure its actual production dependency delta. Retain existing URLs
and catalog as fallback, so reverting presentation never destroys a project or
stops a worker. Preserve accumulated view/preferences compatibility or safely
ignore unknown versions. Native host registration and live owner acceptance are
separate; local browser acceptance is not deferred to the owner unnecessarily.

## Remaining unresolved packets

### Newly proven dependency: restore-stable schema contract

`research/reuse-comparisons/f8-pg17-restore-fit.md` (under docs) records actual
PG17.11 full64-migration dump/restore. Native tools restore the checked data and
permissions, but the application rejects one equivalent CHECK-expression text
change. Keep native PostgreSQL backup tools; do not build a replacement engine.

Before production restore acceptance, implement and independently review an
additive, semantics-preserving constraint canonicalization or another explicitly
reviewed structural fingerprint strategy. Do not change historical migrations,
disable the gate or broaden accepted hashes based only on observed failures.
Affected boundaries: a new numbered migration if selected, reviewed schema digest
in `src/web/v1/private-database-preflight.ts`, corresponding inventory fixtures,
real PG17 restore regression and `deploy/BACKUP_RESTORE.md`.

Acceptance must include source migrations, first and second whole-DB restore,
actual restricted-role preflight, owner/project reads, forbidden writes, and
negative altered bounds/dropped constraint/excess grant/missing owner tests.
Measure selected task roles and canonical artifact pairing separately; the
website-only research fixture does not qualify them. Retain immutable prior
release/digest and verified backups; production application is separately gated.
This is an implementation dependency, not an already dispatched worker capsule.

Queue and native-client selections, artifact attachments, checkpoint recovery,
continuous fleet/install/update, complete project/Idea UI, monitoring/restore and
remaining contributor/export details must be equally concrete. Optional C5 source evidence
and future qualification remain accounted separately. The all-outcomes plan and
copy-ready implementation goal are still unfinished; these partial packets are not
a substitute for either deliverable. IP-03 names new assembler/tests as planned
boundaries, not existing code or an already executor-ready dispatch capsule.
