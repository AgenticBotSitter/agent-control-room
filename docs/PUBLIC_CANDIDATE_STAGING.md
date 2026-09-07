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
