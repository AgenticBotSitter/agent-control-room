# Public refresh: private source-scope inventory

2026-09-08. **Private planning receipt, not for publication or an export allowlist.** Compared immutable private bc0a61a with public cc565d2acf33883316a5784fd0c8ba56fe2eb389 in the supplied staging checkout. Read-only Git trees/blobs and existing reconstruction receipts; no application/test execution, copying, downloads or remote writes. Root owns content/security and release decisions. One initial read-only inventory expression had a syntax error before examining files; corrected expression completed. Large exploratory lists were output-capped; the final counts below come from the focused uncapped tree summary.

## Exact census and meaning

Public tree has520 tracked files. Scope screen includes `src`, `app`, `private-app`, `db`, `tests`, `scripts`, `styles`, `contributor-demo`, `public`, `third_party`, and root package/lock/workspace/TypeScript/build configuration files. This screen contains1,522 private tracked files, of which508 already have the same public path:424 byte-identical and84 byte-different. There are1,014 private-only paths in this broad screen. **Most are not proposed additions**: private-source presence neither makes a file safe nor establishes that the public build needs it. The two public-only application paths are the intentionally renamed external-content migrations0025/0026; preserve them.

The84 changed common paths group as follows:

| Group | Count | Refresh responsibility |
|---|---:|---|
| src |55| Current Idea/news admission and shared canonical/native/web support; includes deliberate public adaptations requiring merge rather than overwrite |
| private-app |8| Existing header/workspace and task approval/assignment/planning/submission panels now linking expanded workflows |
| tests |13| Seven helpers and six compiled/launcher tests; keep helper/source changes paired |
| db |1| private_web_roles.sql alongside new read/write surfaces |
| scripts |1| run-private-vps.mjs; retain explicit operator configuration/no automatic production start |
| styles |1| control-room.css |
| third_party |1| Control Center NOTICE reflects actual adapted source |
| Root files |4| package.json, pnpm-lock.yaml, tsconfig.json, vite.vps.config.ts |

Do not describe84 as84 newly implemented features: public sanitization/package adaptations themselves account for some differences. No research-selected driver/JWT/extractor has become application code merely because its decision is committed.

## Concrete candidate expansion, subject to import/content review

The coherent latest compiled feature expansion is Idea Lab and ABS news/research, not the entire private historical dashboard or every adapter:

- **15 new private UI paths:** idea-create-form, idea-decision-form, idea-start-control, idea-stop-control, idea-synthesis-control, idea-workspace; `ideas/page.tsx`, `ideas/[sessionId]/page.tsx`; news-collection-history, news-daily-snapshot, news-research-form, news-source-refresh, news-source-settings, news-workspace; `projects/[projectId]/news/page.tsx` (all beneath `private-app/app`). These require the eight changed existing UI files, not isolated copying of route pages.
- **83 new source paths in four obvious feature prefixes:**42 under `src/project-adapters/abs-news/`,11 under `src/vendor/control-center/`,15 `src/web/v1/news-*`,15 `src/web/v1/idea-*`. These counts are useful review groups, not a final transitive closure. Shared startup/admission/network-destination/queue/runtime additions outside these prefixes must be resolved as well; e.g. updated domain validators import new `src/security/canonical-network-destination.ts`.
- **Six new schema migrations:**0059_abs_news_postgres through0064_abs_story_archives. Existing public0058 already exists; do not replace or renumber0025/0026. **Five new role procedures:**idea_creation_roles, idea_runtime_roles, news_coordinator_roles, news_ingestion_roles, news_queue_producer_roles. `db/setup/private_idea_adapter.sql` is a separate operator setup candidate requiring explicit review, not startup auto-repair.
- **Attribution additions:** actual selected Control Center files need their existing exact notice/license and changed-source provenance. `third_party/rss-parser/LICENSE` and NOTICE are private-only candidates accompanying the newly declared parser. Existing public THIRD_PARTY text says adapted curation is absent; that statement must change if it is actually added, without claiming compiled artifact clearance.
- **Tests/build:** select the current compiled test roots and the specific Idea/news tests with their complete helper imports. The1,014 private-only screen includes476 tests and44 scripts; do not export these wholesale. Keep the public contributor demo and its existing tests/build scripts. No private deploy/operator secrets, host reports, research harnesses or worker history belong in that expansion.

## Prior sanitizing reconstruction that must survive

`public-candidate-reconstruction.json` starts from private4667c119, selects458 base files, removes two branded migrations, records17 explicit changes and a467-file manifest. `public-demo-reconstruction-delta.json` adds53 source records and five adapted files from1ff1ee7a; the later release inventory records520 files. These receipts explicitly say private/not for publication. Their prior content-review hashes certify only matching bytes, not new replacements.

Preserve these transformations:

1. Public migrations are `0025_cr9a_external_content_sync.sql` and `0026_cr9a_external_content_placement.sql`, with `control_external_content_*` identifiers—not the private Content Blooms paths/table names. Genericization is schema-sensitive, not cosmetic string substitution.
2. Public `private-database-preflight.ts` contains a separately generated public migration fingerprint (currently1d03ff65…); private latest0001–0064 fingerprintf3431786… is **not** valid for the generic public schema. Carry new preflight functionality while preserving a correctly reviewed public schema contract. The newly discovered restore/deparse fingerprint defect must stay disclosed; this inventory does not authorize changing accepted digests or fixing schema.
3. Public `tests/helpers/web-foundation.ts` uses `without-external-content` and renamed migration exclusions; `tests/vps-built-core-schema.test.mjs` checks generic table names/profiles. Reconcile current fixture/test improvements without restoring private identifiers. `tests/vps-built-handler.test.mjs` was also an explicit reconstruction adaptation; inspect its content diff rather than overwrite.
4. package.json/tsconfig.json were intentionally public-scoped. The demo delta further adapts package.json, gitignore, README, SETUP and THIRD_PARTY. Preserve contributor commands, safe defaults, synthetic labels and source-preview scope. Do not import private package scripts pointing at unavailable history, production/native operations or research files.
5. Keep Apache LICENSE/NOTICE, contribution/architecture/roadmap/work-package prose generic, no personal host/credential/profile routing. Preserve the no-Actions default and reviewed substantial-batch workflow. Installed dependencies, dist output, native payloads, private inventories and research receipts were excluded—not implicitly approved release assets.

## Dependencies and verification blockers

At these exact trees, public runtime dependencies are pg-boss12.30.0, postgres3.4.7, React/ReactDOM19.2.6 and zod4.1.12. Private adds fast-xml-parser5.11.0 and rss-parser3.13.0. Refreshing the feature source requires matching package/lock importers and dependency notices, not copying node_modules. **Do not add pg, jsonwebtoken, Readability, jsdom, DBOS or research tools merely because comparison reports recommend them**; those are future implementation choices, not this source snapshot's dependencies.

The old read-only export inventory script can guide a fresh reviewed closure: compiler roots, selected compiled-test roots and contributor-demo roots; actual TypeScript-resolved imports; CSS, runtime file reads and framework route discovery reviewed separately. This task did not execute that script or perform a full dependency-closure/content safety audit. Consequently the broad counts above cannot be used as a copy manifest.

Before release root must resolve: exact transitive application/test closure and dynamic/runtime assets; public generic schema/fingerprint consistency; selected script names and all referenced files; frozen package/lock alignment; current source notices; public-content review and synthetic-example scan; and bounded staged type/build/test checks. Existing public test command lacks a guarantee that every expanded heavy fixture is serial; keep memory-safe test grouping/concurrency explicit rather than importing the private full suite. A successful source refresh is not permission to start native agents, provision a database or deploy automatically.

Recommended export shape: retain the existing public tree, merge current shared source improvements with the known public transforms, add only the reviewed coherent Idea/news import/test/schema closure, and publish a candid roadmap describing remaining driver, reader, recovery and deployment work. Do not publish the private comparison dossiers to explain those gaps; write sanitized public summaries. Root's security/export approval remains required before transfer.
