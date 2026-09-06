# Public application dependency findings

2026-09-06. Read-only inspection at `46e858d`; no export or release approval.

## Finding that changes extraction order

Use the existing protected VPS application as the initial runnable source candidate,
not the historical fixture dashboard. `vite.config.ts` already selects `private-app`
for `vps-node`; other targets use the original app. The protected app is generic source
despite its directory name. This avoids rewriting every personal demo before preparing
the real application. It does not remove those capabilities from the eventual product.

## Static import experiment

An in-memory TypeScript AST traversal used the installed compiler, current tsconfig
resolution and tracked paths. Seeds were the 27 TS/TSX files under `private-app/` plus
`private-task-host.ts`, `private-process.ts`, `installed-native-queue.ts` and
`pg-boss-schema-inspection.ts`. It followed import/export declarations, literal dynamic
imports and literal require calls; it included directly imported CSS paths.

Observed closure: **286 paths**, comprising 253 under `src/`, 28 under `private-app/`
and five under `app/`. No relative/alias imports remained unresolved. The five shared
app paths are:

- `app/components/project-catalog-navigation.tsx`
- `app/components/project-create-form.tsx`
- `app/components/project-catalog.tsx`
- `app/components/connection-center.tsx`
- `app/globals.css`

No closure path matched the named media/business adapter folders or central fixture
folders searched. This is a path result, **not proof that their contents are free of
personal data**. An initial compiler preprocessor experiment misidentified permission
strings as external dependencies; the results here use the AST traversal instead.

Observed non-Node external imports: React, Next, Zod, postgres, pg-boss and PGlite.
One nonliteral dynamic import occurs in `src/persistence/database.ts`: the PGlite loader.
It requires manual inclusion/resolution. Shared CSS imports Tailwind, outside this JS
traversal. No package installation or native execution occurred.

## What the experiment does not cover

This is not the complete distribution closure. Build-tool imports, framework-discovered
files, CSS dependency traversal, assets, runtime filesystem reads, SQL migrations,
test fixtures, declaration-only type imports, all extra Vite entrypoints and launcher
configuration must still be included or explicitly excluded with reasons. It does not
replace a build from an isolated candidate tree or the promised per-path disposition.

## Remaining coupling

1. `private-app/app/layout.tsx` imports the entire shared `app/globals.css`, which retains
   named media-demo selectors. Separate generic styles carefully, preserving responsive
   layouts; do not strip selectors without checking their consumers and visual behavior.
2. `vite.config.ts` statically imports `.openai/hosting.json` and the Sites build plugin
   even though the VPS target omits the Sites plugin at runtime. A public standalone
   build must not require private hosting metadata. Preserve the current preview setup;
   evaluate a clean Node configuration boundary, not copying unreviewed hosting settings.
3. The root tsconfig includes essentially all TypeScript, including historical tests.
   A reduced export needs an explicit supported check scope and retained regression
   coverage, not a typecheck that silently skips required application code.
4. The protected homepage only links to projects. The intended Idea Lab/news/project
   experience must remain on the roadmap; a successful source build is not completion
   of those live workflows.

## Next implementation decision

Prepare the full per-path disposition around this protected entrypoint, its shared
components and its actual build/test/runtime inputs. Keep historical fixtures and
private coordination out unless independently justified. Then separate build metadata
and styles only where verified dependencies require it, and rehearse the candidate
without private-checkout access. No secret scan, license clearance, isolated build or
publication is claimed by this finding.
