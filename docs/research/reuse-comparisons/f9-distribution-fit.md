# F9 actual local distribution notice fit

2026-09-08; immutable source base `24f839f`. Local read-only inspection only. No build, install, download, package execution, public export/GitHub access, production or credential inspection. Private notes and unrelated artwork untouched. No legal clearance or vulnerability audit.

## Concrete result

The notice gap remains real and now has an artifact-level boundary: current `dist-vps` contains **115 files / 3,150,406 bytes**, with **zero LICENSE/NOTICE-named files**. AST inspection finds bare external imports for `pg-boss`, `react`, `react-dom`, `react-dom/server.edge`, `react/jsx-runtime`, plus Node built-ins. These external packages must be accounted for separately from bundled code. Other dependencies may be bundled even though no external import survives; absence from the import list is not absence from the artifact.

Current package manifest has 30 direct dependencies: seven runtime, 23 development/build. Current lock SHA256 remains `3d98f907941fa407b82b4af1e9475acb2f93f92a427cea666edeb652ad92a8c8`. Old 28-package notice reconciliation does not cover added fast-xml-parser5.11.0 or rss-parser3.13.0. Both are absent by name from the old draft. A third name absent by substring is @cloudflare/vite-plugin: separate `cloudflare-notice-evidence.json` already holds source evidence, so this name-only signal is **not** a new missing-license finding or instruction to reacquire it. Semantic coverage must use exact identities, not substring search.

Two generated JS files contain license/copyright words, but bounded inspection shows these are an application schema property (`license`) and an RSS field (`copyright`), not retained notices. No claim that a filename/substring scan alone proves every possible embedded notice absent. No module-level build manifest or sourcemap provenance was established from this inventory. Existing output was not rebuilt; correspondence to current HEAD is **unverified**.

## Existing implementation worth reusing

`scripts/build-vps.mjs` delegates to Vite. `vite.vps.config.ts` explicitly externalizes pg-boss, disables publicDir and only explicitly emits favicon.svg. There is no selected notice-copy/assembly step there. Source `third_party` does not automatically travel into this output.

`docs/research/notice-draft-assembly.json` already provides deduplicated full-text hashes, sizes and component labels for the 189,118-byte draft. Reuse that evidence/index, plus `direct-notice-retention.json`, `pinned-upstream-notice-texts.json`, `installed-bundle-notice-texts.json`, `embedded-runtime-notice-texts.json`, and source-specific Cloudflare/Tailwind/PGlite/Vite evidence. Do not redownload already resolved texts. Searches of current `research` and `scripts` found no executable assembler for DEPENDENCY_NOTICES_DRAFT or its assembly index; the retained index is data, not a proven automatic publishing pipeline.

`scripts/public-package-mechanical-audit.ts` is a real reusable digest/inventory implementation, but its five fixed public candidate roots have predetermined small dependency sets, not the 30-package app or dist-vps. `scripts/public-tree-disposition.ts` and tests deliberately identify the old candidate packages' 11-byte `Apache-2.0` files as SPDX-only, not complete license texts. Current `packages/control-room-core/NOTICE` and `release/NOTICE` explicitly describe planning/candidate scope. Keep those historical guardrails; do not repurpose a passing abstract digest contract as proof current distributable notices are complete.

## Exact remaining assembly batch

| Scope | Reuse already available | Required change / acceptance |
|---|---|---|
| Original 28 direct package evidence | Existing hash-indexed complete-text records | Refresh lock linkage and artifact inclusion map; reuse verified text instead of re-researching |
| Added RSS parser and closure | `third_party/rss-parser/LICENSE`, NOTICE and installed exact package licenses | Include rss-parser3.13.0 and entities2.2.0/BSD-2-Clause, xml2js0.5.0/MIT, sax1.6.1/BlueOak, xmlbuilder11.0.1/MIT texts when corresponding bytes distribute |
| Added fast XML and closure | Installed licenses plus F9 entities retained MIT source receipt | Assemble fast-xml-parser5.11.0, fast-xml-builder1.3.1, is-unsafe2.0.2, path-expression-matcher1.6.2, strnum2.4.2, xml-naming0.3.0, @nodable/entities3.0.0; retain registry/source version discrepancy rather than hiding it |
| Copied Control Center source/UI | `third_party/control-center/LICENSE` + exact-file NOTICE and modifications | Ensure exact shipped subset keeps full notice/provenance; browser/server packaging cannot rely on source-directory adjacency |
| Client/server bundles and external installs | Vite output plus frozen package graph | Emit module-to-chunk/component inventory during next authorized build; generate separate bundled/external notice sets, complete project license, and deterministic artifact manifest |
| Packaging gates | Existing mechanical assurance digest patterns | Adapt to exact selected distribution, then negative tests for missing notice, changed text/hash, changed lock graph, orphan component and omitted copied file; no legal conclusions from test success |
| Research/separate services | Existing per-family acquisition receipts | Exclude temporary comparison dependencies and optional service binaries unless deliberately shipped; do not append all research licenses to obscure actual scope |

The @nodable/entities missing-text location has already been resolved by F9 source matching at registry gitHead and retained full MIT text; that is not a reason to repeat downloads. Its placement into a shipped notice set remains undone. Root-license metadata does not clear transitive code, generated assets, fonts, binaries, or third-party material embedded inside packages.

No application infrastructure needs replacing for this work. Tooling selection remains **provisional**: screen established notice/SBOM generators first, then test viable contenders whose results could change the decision. The active goal already authorizes bounded, logged, isolated tool comparison; this particular delegated audit intentionally performed no downloads or installs. Only after that comparison should we decide whether any small artifact-specific assembler/verifier is necessary to connect existing evidence to actual output. Project-specific provenance exceptions may need explicit handling, but they do not yet justify new generic notice infrastructure. This audit establishes exact gaps and acceptance criteria, not a final tooling choice.

## Reproducible local check

`node research/reuse-comparisons/f9-distribution-inventory.mjs` executed successfully, exit0. It reads only root manifest/lock, existing draft and actual dist-vps; parses literal JS import/export/require specifiers through existing TypeScript; hashes every observed file. It does not execute generated application code. Symlinks are skipped rather than cleared; this diagnostic is not a production archive validator. Computed or dynamically constructed imports and bundled-component identity require the next build provenance pass.

Inventory anchor: client `.vite/manifest.json` SHA256 `ed754db73bf2af77cb659c6b8fe5d4ff7c3d1a1175101c3ac3473fe5d2ce9ac4`. Full per-file current hashes can be reproduced by the script; no full artifact or private data was copied into this report. Existing public contract tests were inspected for scope, not rerun as a substitute for new artifact acceptance.

Outcome: ready for one substantial notice/provenance packaging batch once distribution scope/build authority is selected. Not ready to call current dist-vps a fully attributed downloadable release. This finding does not establish unlawful private operation or change the user's Apache-2.0 decision.
