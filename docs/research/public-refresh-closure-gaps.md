# Public refresh: exact compiler/demo closure and remaining build inputs

Private continuation preparation,2026-09-08. No copying/export/security approval. Actual existing read-only inventory and import helper were read, then executed with `--with-compiled-tests --with-contributor-demo`. The helper uses TypeScript AST parsing, not application evaluation. First large result exceeded terminal output capacity; the same read-only inventory was captured again without redundant public hashes, parsed successfully and saved through apply_patch. No application/test/build executed.

`public-refresh-closure.json` records every exact path/private SHA256, disposition, seeds, external imports, dynamic calls and unresolved compiled references. Baseline is privatebc0a61a; comparison public source iscc565d2. Root subsequently moved public main to42ecea2 with five documentation-only changes; source comparison remains applicable. No public staging file was written.

## Usable import inventory

534 compiler/test/demo closure files:352 unchanged,103 candidate additions,75 candidate updates,4 explicit sanitized merges. Additions group into81 src,15 private-app,5 tests,1 script and1 deploy template. Updates are54 src,8 private-app,10 tests,1 script,1 style and vite.vps.config.ts. Four manual merges are private-database-preflight, web-foundation helper, compiled core-schema test and compiled handler test. Path lists in JSON are complete for this scanner output; no broad1,014-file private-only copy is needed.

**Special review hold:** `deploy/operator-config.mjs` appears because `tests/vps-built-startup.test.mjs` imports its createConfiguration function. This is an import dependency, not permission to export operator configuration. Root must inspect the tracked template, preserve placeholders and absence of private runtime inputs, or adapt the public test/template together. This task did not load or execute its configuration. All manifest candidate labels mean review only.

## Concrete holes in the existing scanner

The inventory follows import declarations and compiler seeds but does not discover string-valued Vite entrypoints. Current `vite.vps.config.ts` has five entry sources absent from the534-file closure:

- `src/web/v1/private-idea-authoring-startup.ts`
- `src/web/v1/private-owner-bootstrap.ts`
- `src/web/v1/private-owner-review.ts`
- `src/web/v1/private-task-database-check.ts`
- `src/node-bridge/private-node-entry.ts`

Their transitive imports must be added to the final candidate closure before using the current complete build configuration. This report deliberately does not claim the534-file compiler closure is already a complete build manifest. The other ten explicitly listed Vite entry sources are present. Do not omit these entries silently just to make a copied subset compile; root should choose the intended public build scope explicitly.

There are72 unresolved scanner records, all generated `dist-vps/server` references, across11 unique filenames: ideaAuthoring, bootstrap, index, serving, taskHost, nodeConnector, runtime, taskBootstrap, taskApplication, preparation and rehearsal (all `.js`). These are expected build products, not source to copy. Verify generated names against selected Vite/vinext output and staged tests. No unresolved non-dist local import was reported.

## Dynamic/runtime and packaging supplement

Four nonliteral imports were inspected:

1. `src/persistence/database.ts:51` constructs `@electric-sql/pglite`; declared existing test/development dependency, not an undiscovered plugin.
2. `src/local-pilot/v1/runtime.ts:257` constructs the same package. Its migration function reads every SQL file in db/migrations at runtime; source import closure alone cannot supply those files.
3. `scripts/run-private-vps.mjs:30` loads explicitly supplied executable operator configuration. Never package ambient/private owner configuration to close this dynamic import.
4. `scripts/run-private-node.mjs:16` has the same explicit operator configuration boundary. It remains a one-task launcher, not a continuous daemon.

Additional required selected inputs outside ordinary source imports:

- `public/favicon.svg` is emitted by generateBundle through readFile while publicDir is false. Keep that explicit original asset, not the whole public directory.
- Actual public migration set through0064, preserving generic0025/0026 filenames/table names; selected role SQL and operator setup files. web-foundation and local-pilot both enumerate migration files, while private-deployment-inventory explicitly enumerates migrations and profile-specific role/setup inputs. Preserve reviewed public fingerprint/test transformations.
- Root package.json/pnpm-lock.yaml/pnpm-workspace.yaml/tsconfig.json/tsconfig.vps.json/postcss settings and public contributor-demo configuration/commands. package and tsconfig are manual public merges, not among the four AST-selected manual rows. The source already imports fast-xml-parser/rss-parser; declarations and notices must accompany them. External `next`/`next/server` imports are framework-resolution inputs, not instructions to independently add another Next runtime without reviewing vinext's existing setup.
- THIRD_PARTY/NOTICE and exact selected Control Center/rss-parser notices; compiled/node_modules/native/WASM output remains excluded from a source refresh. Private research inventories/reports and private configuration/history are not release content.

## Handoff boundary

This provides the exact existing scanner's minimal534-path closure and names its five concrete missing build roots plus runtime supplements. Root can extend only those roots, inspect added/changed bytes and merge public transformations before staging. Final source/import/build/test/content/license acceptance remains required. No new installations, remote writes, source export or running private configuration occurred here.
