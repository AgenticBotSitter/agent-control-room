# RC10 clean frozen pnpm preparation and license inventory

2026-09-08 baseline f2bac29. **Select native pnpm11.19.0 for the installed production dependency identity graph, with a separate full-text notice collection step.** Its clean prepared graph matches all39 required/installed optional runtime identities. Do not use incomplete checker4.4.2 traversal or write a replacement dependency walker. This is a bounded runtime-graph selection, not complete distribution/legal clearance.

## What actually ran

Only unchanged package.json and pnpm-lock.yaml copied into owned `/private/tmp/cr-f9-prepared.ze3EBj`. No application source/node_modules/profiles copied. Reviewed pnpm-workspace.yaml contains root-only package selection, enableGlobalVirtualStore:false and three disabled builds; it was not copied because isolated preparation explicitly uses owned store and ignore-scripts, single root only. No .npmrc copied. Installed actual pnpm11.19.0 with production/frozen-lock/ignore-scripts and owned store/cache:39 packages downloaded, zero reused, production seven root packages, development skipped, exit0 in reported3.7seconds. No dependency scripts or application tests/build executed.

`pnpm licenses list --prod --json` first rejected command-local --store-dir/--cache-dir flags. Corrected documented global `--config.store-dir=... --config.cache-dir=...` invocation exited0 without another install or source change. Direct JSON output and install completion retained in f9-prepared-licenses-evidence.json. The receipt includes selected upstream package author/description metadata, not private user identities.

`f9-prepared-compare.mjs` verifies copied manifest/lock hashes equal current originals, then exact name@version set equality with previously independently resolved39runtime identities. Actual output **39/39**, no extras or omissions. Dependencies include RSS/XML/PostgreSQL transitives that checker4.4.2 missed. This comparison is runtime required/installed optional closure; it is not all30direct dev+runtime packages, peer/platform/monorepo certification or bundle membership.

## Full-text finding, source-backed

All39 JSON entries lack licenseContents. Actual installed pnpm `dist/pnpm.mjs::resolveLicense` first returns `{name: manifestLicense}` when a recognized non-SEE-LICENSE manifest value exists; only its fallback reads a license file and attaches content. Therefore its internally available licenseContents field is **not** a full-text collector for this graph. This explains output, rather than guessing a hidden --long flag will solve it. No changed metadata experiment required to establish these actual package results.

Read-only output-path inspection hashes conventional root LICENSE/LICENCE/COPYING/NOTICE files. Four package roots have none under that narrow filename test: @nodable/entities3.0.0, pg-types2.2.0, pgpass1.0.5, postgres3.4.7. **Not four new unlicensed packages:** pg-types/pgpass/Postgres prior provenance/notice records may already resolve their text; reuse those before downloads. @nodable/entities exact-source retained MIT exception is already known. This root scan does not clear nested/vendored notices or prove no notice appears elsewhere. Full filenames/bytes/hashes are retained in comparison evidence; original notices are not replaced with SPDX labels.

## Adoption and remaining collector choice

Use pnpm's native frozen graph/paths/identities as the scope input and the separately exercised rollup-plugin-license for actual bundled module discovery/notice extraction. Preserve separate explicit original Apache and Control Center copied-source provenance. Avoid a custom package-manager graph parser and do not try to fix checker4.4.2's pnpm traversal fork. Current diagnostic comparator is research evidence, not production code to promote.

For complete external-package text, the remaining **narrow** decision is an existing collector invoked per pnpm-identified physical package or a supported bundle-plugin scan/export mechanism, matched against retained full-text exceptions. That can bypass unreliable whole-graph npm walking without synthesizing a foreign lock or ignoring errors. It must prove all39package scope, required full text, separate NOTICE/multiple texts, identity binding and changed-text rejection before final notice assembly. This experiment does not claim that unexecuted per-package collector design already works.

Cost comparison: native graph avoids another runtime/dependency chain, needs clean frozen preparation/store metadata and output normalization. Checker4.4.2 whole-graph mode is rejected for this checkout by earlier silent transitive omissions; its per-package text/clarification behavior could still be reused. CycloneDX6.0.1 whole npm-reader mode failed on current graph and remains viable only with supported graph preparation or a bounded adapter; no reason to replace pnpm's now-proven graph solely for standardized serialization. No production code removed; generic graph-walker development avoided. No schema/data migration, service or native credentials needed.

## Resource/provenance/cleanup

139GiB free before preparation; final allocated288MiB including isolated store/cache, under4GiB aggregate research limit and20GiB floor. Only this known owned cohort created here. Exact package identity log is the39entry actual pnpm output, and registry integrity pins are in the unchanged frozen lock with SHA256 `3d98f907941fa407b82b4af1e9475acb2f93f92a427cea666edeb652ad92a8c8`. Package manifest and installed pnpm implementation hashes are in comparison evidence. No dynamic versions resolved or app lock changed. Package downloads are the selected frozen npm registry packages, not tool/source clones.

No persistent process/listener started; install session and both candidate commands completed. Exact owned root removed after retaining evidence and absence checked;288MiB temporary packages/store/cache removed. This stage supplies decisive graph evidence and a narrower full-text task, not a false declaration that RC10 is entirely complete.
