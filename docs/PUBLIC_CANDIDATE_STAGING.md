# Local public source candidate staging

## First isolated snapshot

- Exact source commit: `4667c1197f364b9648bf7b03ab36d83fe4b662da`.
- Staging root: `/private/tmp/control-room-public-candidate.zVOmZD`.
- Extracted source: `source/`; retained archive: `source.tar`.
- Archive SHA-256: `def39997d0d7b829654b7b9b332ec3168f5d5d27f4e700df26e4ae379283ee5d`.
- Available disk before staging: 101 GiB. Archive plus extracted tree: about 7.7 MiB.
- 458 tracked files selected: standalone build/compiled-test import closure, explicit
  root dependency/TypeScript/build configuration, required original favicon, 67 SQL
  files and existing Control Center attribution files.
- Created with `git archive` from the exact commit. No private Git history, untracked
  image, installed dependencies, credentials or runtime state was copied.
- Verified absent at the candidate root: `.git`, `node_modules`, `.env`, `.github`,
  `.openai`, `docs`, `coordination`.
- No network download, package installation, public push or deployment in this step.

This is an **unreviewed local candidate**, not an approved public file allowlist.
The original repository is unchanged. Retain this exact staging root while reviewing;
after it is superseded or accepted, remove only this recorded directory under the
owner's approved cleanup scope. Do not delete the private checkout or dependency cache.

## Preliminary source scan

The 381 selected application/build/test closure files were scanned for known private
brand tokens, personal host/account identifiers, home-directory prefixes and private
domain tokens. One file matched: `tests/vps-built-handler.test.mjs`, whose negative
assertion checks that private project names are not displayed. Preserve that guard in
the private tree; adapt the candidate assertion without publishing private brands.
No matches in the other scanned categories. This limited scan is not secret detection,
manual content review or privacy clearance, and does not cover all selected SQL/config.

## Next work before any publication

### Isolated preparation evidence

The candidate now has only three package scripts: `check` (standalone TypeScript),
`build` (existing standalone builder), and `test` (existing build plus 22 compiled-test
files). Removed inherited private lifecycle scripts, not tests silently reported as
passing. Dependency versions and frozen lockfile are unchanged. TypeScript aliases to
unselected SDK packages were removed. The private-brand negative assertion was adapted
in the candidate to ensure the freshly created synthetic project is not preloaded in
the client shell. Private source remains unchanged. `SETUP.md` is retained in
`docs/public-launch-draft/SETUP.md`; it explicitly says no interactive demo start yet.

Rehearsal: Node 22.22.3, pnpm 11.19.0, macOS. Offline preparation initially reported a
missing cached tarball. The authorized normal frozen installation then completed with
476 dependencies found in the store/imported; no package download events were recorded.
Private local installation event log: `install.ndjson` under the staging root. That raw
log contains machine metadata and MUST NOT be included in the public release.
Available disk checked first: 101 GiB. Staging root after install/build: about 455 MiB.
Cleanup includes this root's dependency tree, generated build and logs; do not delete
the shared pnpm store. No repository credentials or private `node_modules` copied.

Candidate `pnpm check` passes. Candidate `pnpm test` completes its standalone build
and **47 compiled tests pass**, no failures/skips/cancellations; log `build-test.log`
under the staging root. This is an isolated dependency preparation, not proof that a
fresh machine without an existing package cache can install. No service/listener,
native provider, production database or deployment was started.

Adapted package SHA-256: `ac32f7d0124a76e009a3e4bcb5163d4327ef74acfc21e76de77d2ec64320e221`.
Adapted tsconfig SHA-256: `744e30d113cc31b44a487b1d68651fbed0ac376aaf08f3c2d92421d795b9f288`.
Unchanged lockfile SHA-256: `51e1e83929e1b806c7316b2ca9b1b2326ae89aec3935f15c9e99a157bc531ad0`.
The archive remains the original snapshot; adaptations are in the extracted candidate.

1. Adapt candidate package scripts and TypeScript paths to the selected tree. The copied
   root scripts still mention private/unselected tests and are not a usable quick start.
2. Inspect SQL, configuration and selected source content; retain private provenance
   separately. Resolve findings, do not mechanically replace security-significant IDs.
3. Add reviewed public README, setup, roadmap, substantial work packages and contribution
   policy; no Actions workflows. Keep incomplete integrations labeled accurately.
4. Apply the owner-selected original-code license and exact third-party notices.
5. Prepare dependencies from the frozen lockfile in this isolated candidate, recording
   downloads and disk use; run its actual type/build/tests and documented local demo.
6. Obtain independent candidate review and publish only the accepted tree to the already
   existing public repository. Do not attach that remote to the private checkout.

The current selection is the standalone application, not the newer root local-preview
route. Its usable demonstration must be established explicitly; copying more private
preview files without review is not an acceptable shortcut.
