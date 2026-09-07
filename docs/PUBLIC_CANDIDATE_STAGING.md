# Local public source candidate staging

## Contributor demo expansion review (2026-09-06)

Follow-up import review replaced the local runtime's broad connection-registry barrel
import with direct imports of the same store, intake and disabled ingress/listener
implementations. No implementation or authority changed. The combined closure drops
from 461 to 431 files and missing candidate additions from 80 to 50. Thirty unrelated
re-exported modules no longer enter this preview through the demo runtime. The JSON
expansion receipt above remains the historical pre-refinement inventory; regenerate
against the accepted current commit before selecting candidate bytes.

At private baseline `904748a297c1ed5f3debe8c3d68dcb96e90619f3`, the compiler-parser
inventory now accepts `--with-contributor-demo` alongside `--with-compiled-tests`.
It includes the explicit HTML/browser entry, launcher, build configuration and demo
tests, without executing them. Four inventory tests pass. The combined import closure
contains 461 tracked files: 80 are absent from the staged candidate and seven differ.
Exact additions and current hashes are recorded in the private
`docs/research/public-demo-expansion-review.json`; this is not a public allowlist.

The seven differences must not be blindly replaced. The database preflight and two
built tests include earlier candidate schema/privacy adaptations. Preserve those;
review the actual demo asset/transport/serving changes and helper differences.
The demo's reused local runtime also pulls connection-registry, project-event and
workspace code into scope. Import reachability is not proof of publication safety.

Only nine unique missing import paths were found, all generated `dist-vps/server`
outputs supplied by the existing build. The two runtime dynamic imports resolve the
fixed installed PGlite package; the production launcher has its separately reviewed
built-entry import. Runtime SQL reads, CSS/assets, package scripts, fixture/privacy
content and distribution notices still need candidate-specific review.

No candidate files were overwritten, no new dependency was downloaded, and nothing
was published. Next: inspect/adapt the expansion, preserve the existing candidate
license and generalization, rehearse the complete isolated demo, then independent
review of exact candidate bytes before publication.

## First isolated snapshot

## Approved license application (2026-09-06)

Owner explicitly approved Apache-2.0 with the proposed Agent Control Room attribution.
Applied the official complete license to the candidate LICENSE, approved attribution to
NOTICE, Apache-2.0 package metadata and README declaration. Durable LICENSE/NOTICE
copies are in `docs/public-launch-draft/`. This applies to candidate original code;
the private checkout was not broadly relicensed and upstream licenses remain separate.
Earlier undecided-license statements in this receipt describe prior steps.

Download record: official `https://www.apache.org/licenses/LICENSE-2.0.txt` fetched twice
(initial inspection, then verbatim application); 101 GiB available before retrieval.
Retained license is 11,358 bytes, SHA-256
`cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.
The two retained files are the candidate LICENSE and durable template, not dependency
downloads. No additional download file/cache was created by these curl calls. Candidate
copy follows the recorded staging cleanup scope; durable template is intentional source.
No public upload, Actions run or deployment occurred.

## Original snapshot receipt

### Durable reconstruction receipt

`docs/research/public-candidate-reconstruction.json` preserves the exact private base
commit, 458 selected base paths, 17 added/changed file bodies, two superseded migration
paths, and SHA-256 hashes for all 467 current candidate source files. It excludes
dependencies, generated output and execution logs. This is private release-preparation
evidence: do not publish the receipt, its private base references or historical paths.
An in-memory reconstruction using the recorded Git base plus changes matched every
manifest hash and every current candidate file byte-for-byte. No reconstruction writes
or deletion were performed. The candidate is no longer dependent solely on temporary
storage, provided the private repository and this receipt are retained.

Demo investigation: the existing owner-attended launcher is macOS/Keychain-specific;
the standalone compiled tests include test-only startup metadata injection and are not
a demo launcher. Do not reuse those injections in a runnable public demo. The existing
local synthetic runtime has protected project/task services and explicit simulation
result input, but its standalone UI/runtime composition is not in this candidate yet.
Reuse those services through a separately reviewed disposable-demo composition; do not
claim browser readiness or weaken operational authentication to obtain a quick start.

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

## Candidate preparation and remaining publication work

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

### Expanded privacy and upload-hygiene review

The expanded source check found private consumer identifiers in migrations 0025/0026,
including table names, and matching references in `tests/vps-built-core-schema.test.mjs`
and `tests/helpers/web-foundation.ts`. These were publication findings, not
credentials. Generalization must preserve SQL references and schema-test coverage;
do not rename the existing private installation's tables or remove the content feature.
The earlier scan did not include underscore-separated brand spellings and therefore
understated the affected files. Future scans must cover filenames and token variants.

Candidate `.gitignore` now excludes dependency/build trees, environment overrides,
key files, logs and workflows. Its durable template is
`docs/public-launch-draft/CANDIDATE_GITIGNORE`. This is an accident-prevention aid,
not a secret scanner or a publication allowlist; forced additions can bypass it.
Required source, lockfile, notices and placeholder environment examples remain eligible.
Nothing was uploaded and no license was applied.

### Candidate-only generic content schema adaptation

Resolved the above identifier finding in the isolated source: migration filenames and
all SQL/test references change `content_blooms` to `external_content`; the two SQL
comments use `external content`. All 14 content tables remain. Exact comparison to
the private original SQL proves that no statements changed except these substitutions.
The test-helper omitted-migration profile now names the generic filenames, and the
compiled schema tests assert generic table names. Private source/database is untouched.

Recomputed the candidate's fixed catalog fingerprint from all 57 migrations in fresh
disposable PGlite, using the existing catalog query:
`5ddb1f082f2e598bf0434f63708063674829fcde2c2b4384aecc32f6dff238e3`.
Updated only candidate `src/web/v1/private-database-preflight.ts`. This is a separate
fresh-install candidate schema, not an upgrade migration for an existing installation.
Fingerprint enforcement remains fixed; the incomplete-schema rejection still passes.
Real PostgreSQL equivalence has not been rehearsed here.

Candidate type check, standalone build and all 47 compiled tests pass again (zero
failures/skips/cancellations). Private log: `generalized-schema-test.log` under the
recorded staging root; retain for cleanup, never publish. An expanded filename/content
scan of 460 source files (excluding dependencies and generated `.next`, `dist`,
`dist-vps`) reports zero known private-name, home-path, private-key-header or selected
token-shape matches. This is limited pattern evidence, not full manual privacy or
secret clearance. No new downloads, native/provider calls, listener or public writes.

### Contributor documents staged

Candidate now includes README, CONTRIBUTING, SETUP, ROADMAP, WORK_PACKAGES and
`docs/ARCHITECTURE.md`. README links to the five supporting documents, reports actual
candidate check/build evidence, and clearly states that browser startup and live
compatibility are unfinished. Hermes/Codex are first priority; Claude Code/OpenClaw and
other harnesses are proposed tracks. Work packages stay substantial and unassigned
until their prerequisites and exact public base are available. Actions remains disabled;
local checks and meaningful batches are documented without discouraging local commits.
All six documents were checked for resolving local links and selected private-reference
patterns. They retain candidate/draft labels. License, governance and private security
reporting approval were not inferred or published.

1. Package scripts and TypeScript paths are adapted and verified as recorded above.
   Finish an honest runnable contributor demonstration; build tests alone are not it.
2. Inspect SQL, configuration and selected source content; retain private provenance
   separately. Resolve findings, do not mechanically replace security-significant IDs.
3. Add reviewed public README, setup, roadmap, substantial work packages and contribution
   policy; no Actions workflows. Keep incomplete integrations labeled accurately.
4. Apply the owner-selected original-code license and exact third-party notices.
5. Repeat the recorded isolated type/build/tests after candidate changes and verify the
   documented local demo; preserve download/disk receipts and cold-cache limitations.
6. Obtain independent candidate review and publish only the accepted tree to the already
   existing public repository. Do not attach that remote to the private checkout.

The current selection is the standalone application, not the newer root local-preview
route. Its usable demonstration must be established explicitly; copying more private
preview files without review is not an acceptable shortcut.
