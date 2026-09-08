# F9 shipping and license scope inventory

2026-09-08; requested baseline29dbc4a. Read-only local records/manifests; no download,
package execution, credential/private configuration scan or legal clearance.

## Material finding: prior notice reconciliation is stale for current application

The executable local inventory found **30 direct packages**, not the28 in
`docs/research/public-candidate-notice-reconciliation.json` and
`direct-notice-retention.json`. Existing28 installed manifest hashes still match
that record. New runtime packages **fast-xml-parser5.11.0** and **rss-parser3.13.0**
are absent from old reconciliation and assembled
`docs/research/DEPENDENCY_NOTICES_DRAFT.txt`. Current lock SHA256
`3d98f907941fa407b82b4af1e9475acb2f93f92a427cea666edeb652ad92a8c8`
differs from prior `51e1e83929e1b806c7316b2ca9b1b2326ae89aec3935f15c9e99a157bc531ad0`.

This is **incomplete current distribution accounting**, not proof the dependencies
are unlicensed or a reported license violation. Both installed root LICENSE files
exist and declare MIT. RSS also has current `third_party/rss-parser/{LICENSE,NOTICE.md}`.
Before distributing current expanded application, refresh exact source/artifact
inventory and add new dependency closure/notices; do not repeat already-resolved
missing-root work for the original five packages.

fast-xml-parser adds exact lock edges @nodable/entities3.0.0,
fast-xml-builder1.3.1, is-unsafe2.0.2, path-expression-matcher1.6.2,
strnum2.4.2, xml-naming0.3.0. Installed manifests for these six declare MIT;
five have root LICENSE files, but **@nodable/entities3.0.0 has no root license file**
in its installed package. Resolve exact upstream notice text for that version,
not current-main text by assumption. Full texts/transitive-vendored closure not newly
reviewed here. RSS notice identifies entities2.2.0 BSD-2-Clause, xml2js0.5.0 MIT,
sax1.6.1 BlueOak-1.0.0 and xmlbuilder11.0.1 MIT; preserve actual scoped texts,
not only SPDX names. Lock pins are integrity evidence, not license grants.

Subsequent root-evaluator [entities follow-up](f9-entities-notice-followup.md)
records registry gitHead, matching actual source bytes and retained MIT text. Its
source/package version-field discrepancy is explicit. That narrows the missing
notice-source gap; assembling the shipping notices and full graph remains undone.

## Current local product source versus research versus distribution

| Category | Actual local evidence | Release implication |
| --- | --- | --- |
| Borrowed source integrated into product | Eleven `src/vendor/control-center/*.ts`; `private-app/app/news-daily-snapshot.tsx`; selected upstream test cases | Full MIT notice and exact modification/provenance map required in source/artifact containing them |
| Installed runtime dependencies | fast-xml-parser,pg-boss,postgres,react,react-dom,rss-parser,zod | Follow current lock graph and actual bundle/external output; not all code is visible as bare imports |
| Development/build dependencies |23 direct manifests, including Vite/vinext/PGlite/framework and tooling | dev label does not prove absent from shipped output; built artifacts need bundler/native/WASM mapping |
| Research-only source/package/binary | F1–F8 temporary cohorts, Herdr binary and module experiments | Not added to app manifest just because exercised; only retain sanitized original research harnesses/dossiers unless explicitly vendoring with notices |
| Future separate services | Herdr,etcd/OpenBao,WinSW,pgBackRest,Kuma,Beszel,Authelia as conditional candidates | Separate installation still needs license/notice review of exact distributed binary/image if bundled; do not relicense as original Apache source |
| Historical public preview | `docs/public-launch-draft/THIRD_PARTY.md` explicitly excludes current full news adaptation | Do not reuse its initial-demo scope as description of expanded current private application |

This review does **not** inspect live GitHub/export bytes. "Integrated" here means
current local product source/dependency, not proof a particular version shipped
publicly. `release/NOTICE` and package NOTICE files still say planning/candidate;
they are not proof of a complete current binary notice bundle.

## Control Center provenance is substantially recorded

`third_party/control-center/NOTICE.md` names all eleven vendor files, pin
`d13e79e866cc33a1fddfe84f563ce2fb9a2113e0`, MIT owner and adaptations:
event-only helper versus fullcuration; type/import rewrites; injected reader/clock;
omitted local snapshots; reading-view adaptation; network/cancellation/budget hooks.
Root MIT license hash matches retained upstream
`a149b592d1e38b71a4ff4987ee9020b5f35a5fe7c2f09ebdc78ae9ec7a87349b`.
Full industry-curation hash exactly matches recorded upstream
`ad668fe4bf08e7b48913b43ef7edb05edbe4d874db1a16c451ff006e0b70d962`.
Adapted daily snapshot/test include source/attribution comments. Some unchanged or
import-adapted vendor files have no per-file header; central notice currently names
them. This review does not assert MIT requires a change header. Preserve central
notice with copied subsets so isolated files do not lose provenance; per-file
header/link is advisable for future modular export. Apache upstream changed files
must be evaluated under their own text, not treated as MIT because both are permissive.

`docs/PUBLIC_ASSET_PROVENANCE.md` records original favicon replacement, but contains
historical license-choice-pending text superseded by owner's Apache decision. Do not
use it to reopen that decision. Old unknown-provenance artwork/private history is
not cleared by current favicon. No image/media/private profile scanned here.

No LICENSE/NOTICE-named file was found in current `dist-vps` inventory; build entry
only delegates to Vite. That is an artifact packaging follow-up, not proof of unlawful
private use. Before downloadable built release, attach exact bundled/external notice
set and module provenance; don't assume source third_party directory travels with
compiled output or simply ship the old draft wholesale.

## Per-family adoption prerequisites

| Family | Current reuse/licensing posture | Required before adopting/distributing new scope |
| --- | --- | --- |
| F1 queues | pg-boss12.30.0 MIT integrated, prior runtime notices retained; DBOS/Hatchet scoped research | Compare exact chosen SDK/engine versions and commercial-vs-community boundaries; include added deps, SQL/runtime assets, retained changed notices; don't infer source-main equals published package |
| F2 native interfaces/files | Hermes/Codex research and existing original adapter; TS SDK0.153.4 actual package scoped, executable dependency not acquired | Exact SDK/runtime/generated schema notice closure and what is separately installed; pure imports don't clear bundled agent executable; no provider logos/brand claims inferred |
| F3 UI/terminals | Desktop/WebUI MIT source examined, narrow experiments only; Herdr Apache root plus265 metadata inventory | Exact copied files plus icons/fonts/assets and transitive imports; Herdr patched portable-pty/Ghostty MIT and Zig graph/binary notices; Studio BSL remains file/intended-use unresolved, not permissible MIT shortcut |
| F4 teamwork | Hermes/AI Maestro MIT; Agent Orchestrator Apache source probes | Preserve precise extracted functions/file originals and change records; don't include meeting/video/media packages based on pure helper review; verify any optional commercial artifact independently |
| F5 custody | etcd Apache server; etcd3/ssh2 MIT package evidence; OpenBao MPL server candidate | Preserve package/server distinctions, generated protocol licenses, MPL file-source/notice scope for copied modifications or distribute separate service appropriately; no blanket incompatibility claim |
| F6 supervision | WinSW2.12.0 MIT source only; OS platform interfaces | Exact release/runtime bundled notices and provenance if wrapper redistributed; Task Scheduler/systemd/launchd config is not redistribution of their whole implementation |
| F7 news/content | Actual Control Center/RSS/fastXML integrated as above; Miniflux/FreshRSS/RSSHub new source-only candidates | Update current graph/notices and artifact manifest; verify actual pinned root terms rather than old search summaries; feed/article availability does not grant wholesale article/image republication rights; owned synthetic fixtures avoid copying articles into public tests |
| F8 operations | pgBackRest/Kuma/Beszel MIT, Authelia Apache sources; not installed by comparison | Exact per-platform binaries/images/deps; Beszel optional LibreHardwareMonitor MPL2 and smartmontools separate terms; no root-only release clearance |
| F9 public contribution | Original-code Apache decision accepted | Final exported file inventory/notice delivery, contributor provenance and changed-file tracking; preview versus fullbuild scope must be explicit |

No actual Apache/MIT incompatibility established by this inventory. **Studio BSL
intended-use/files and optional bundled copyleft components remain unresolved scope**,
not permissions to borrow now/replace later, and not a categorical rejection of all
separately used software. Copyright notices/source terms must follow actual bytes.

F7 evaluator reports newly read source pins Miniflux
`a84533db6ca0a2ff9a47800fbf0326be6d9b3170`, FreshRSS
`65e402ca412dd2683ed3b36ac673cb7cdf5de43e` and RSSHub
`865f1cf5af3973dffaa2cb8c2d73ee0538043c12`. Evaluator identifies current FreshRSS
and RSSHub root texts as AGPL, contradicting an old RSSHub MIT search summary.
This F9 reviewer has not read those newly acquired texts; retain evaluator provenance
in F7 ledger and perform intended-use/component review before selection. No code
imported. Do not convert old metadata into an MIT permission for current source.

## Reproducible local check and action batch

Run `node research/reuse-comparisons/f9-local-inventory.mjs`. It reads only root
manifest/lock, direct installed package manifests/root notices and selected vendor
attribution. Output saved `f9-local-inventory.json`:30 packages, current/old lock
comparison, original28 manifest matches,11 vendor hashes and four notice hashes.
Substring notice matches are a coverage hint, not semantic/legal verification.
No complete transitive graph, computed import scan or vulnerability audit claimed.

Substantial next batch: refresh full expanded source export inventory; traverse new
runtime graph; retain complete new notice texts and graph identities; assemble
selected source/built artifact notices separately; use Vite module provenance for
bundled output; reject missing expected notices in packaging tests; independently
review the exact distribution. Do not modify application behavior for this batch.
Research candidates get their own inventories only when selected files/versions are
known, rather than exhausting resources clearing unrelated media/runtime distributions.
