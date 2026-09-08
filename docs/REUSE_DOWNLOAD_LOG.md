# Reuse evaluation download and cleanup ledger

## RC5 current service releases — 2026-09-08 (distributions retained)

Pre-download free space139GiB. Official release API selected etcd3.7.1 and
OpenBao2.6.2; [source refresh](research/reuse-comparisons/f5-release-source-refresh.md)
resolves their exact commits. [Acquisition receipt](research/reuse-comparisons/f5-service-acquisitions.json)
records exact official URLs, metadata checksums, streamed size/deadline verification,
archive-entry lists and every extracted file hash. Total allocated352,512KiB;
exact owned retention/cleanup target `/private/tmp/cr-f5-services.vo82x7`.
No global install, package changes, persistent service or GitHub writes.

Actual etcd comparison completed, including one recorded initial harness failure
and one focused correction. Both terminal runs cleaned their owned test-data
directories after process termination. OpenBao was subsequently executed in the
[logged Raft/KV comparison](research/reuse-comparisons/f5-openbao-service-fit.md):
three failed setup/harness attempts followed by17 completed observations. All owned
OpenBao processes terminated with code0 and all owned test-state directories were
removed. Root verified no etcd-state/openbao-state directory remains in the cohort.
Distributions remain intentionally available for the remaining common comparison;
do not count them cleaned or delete them while an owned test is running. Before
eventual exact-root cleanup, retain all needed sanitized evidence and confirm no
owned service handles remain. No real credential/profile or production data exists
in this cohort. Full binary/dependency license audit remains distinct from source
root license inspection and the acquisition hash inventory.

RC2 Python observer follow-up reacquired nine previously pinned source files
(404,162bytes), with139GiB free and prior scoped allocation579,516KiB. No packages
or native runtime installed. [Acquisition/cleanup receipt](research/reuse-comparisons/f2-python-observer-acquisitions.json)
records exact URLs/hashes and removed owned root; seven synthetic peers were reaped.
Independent review confirmed that root absent. Existing F2 SDK and RC5 service
distribution roots were left unchanged.

## RC7 article-extractor comparisons — 2026-09-08 (cleaned)

Public pinned candidates were downloaded only to disposable evaluation roots,
not installed in the application. Every cohort recorded free space above20GiB and
remained within the4GiB retained-evaluation cap. Source/archive hashes, dependency
locks or Go sums, commands, failures and receipts remain in the linked ledgers.

| Cohort | Acquired scope / recorded disk allocation | Retained evidence |
| --- | --- | --- |
| Mozilla Readability0.6.0 + jsdom26.1.0 |40-package install/cache,30MiB plus44KiB separate metadata cache | [Acquisitions](research/reuse-comparisons/f7-readability-acquisitions.json), [fit](research/reuse-comparisons/f7-readability-fit.md) |
| Same Readability with bundled JSDOMParser | One-package install/cache,292KiB | [Acquisitions](research/reuse-comparisons/f7-readability-builtin-acquisitions.json), [fit](research/reuse-comparisons/f7-readability-builtin-fit.md) |
| Miniflux pure extractor at a84533db6ca0a2ff9a47800fbf0326be6d9b3170 | Selected source, checksum-verified Go1.26.0, isolated module/build caches and binary;564,168KiB total, not runtime RAM | [Source ledger](research/reuse-comparisons/f7-miniflux-extractor-acquisitions.json), [toolchain/module/cleanup receipt](research/reuse-comparisons/f7-miniflux-extractor-runtime-evidence.json) |

Root independently checked all four exact paths named in those ledgers after author
cleanup; all were absent. Miniflux's initial removal failed on read-only Go cache
directories; its recorded owned-cache permission correction and final removal are
preserved, not hidden. No root deletion was needed during this verification.
Authored reproduction harnesses and synthetic corpus remain in
`research/reuse-comparisons/`; candidate distributions, caches and toolchain do not.
No application dependencies, credentials, provider calls, GitHub writes or services
were introduced. A separate subsequent HTML-compatibility cohort is not covered by
this cleanup statement and must retain its own receipt.

Subsequent HTML-compatibility cohort: the same40-package pinned closure was acquired
into its own19MiB disposable root, with scripts disabled and the same lock/integrity
identities. [Ledger](research/reuse-comparisons/f7-html-compat-acquisitions.json)
records139GiB initial free space, bounded npm requests and cleanup. Root independently
checked the ledger's exact root was absent after completion. All10 extraction child
processes terminated; none was a live provider or service. The new five-input corpus,
two heuristic observations and [independent review](research/reuse-comparisons/f7-html-compat-review.md)
are retained, including failures. No candidate distribution remains from this cohort.

## New comparison program — 2026-09-08

Fresh goal authority, source baseline44f9064. Storage140GiB before acquisition;
global cap4GiB, stop below20GiB free; heavy local services serialized. Per-family
exact acquisition, negative outcomes and cleanup records:
[F1](research/reuse-comparisons/f1-acquisitions.md),
[F2](research/reuse-comparisons/f2-acquisitions.md),
[F2 Python router](research/reuse-comparisons/f2-router-acquisitions.md),
[F3](research/reuse-comparisons/f3-acquisitions.md),
[F4](research/reuse-comparisons/f4-acquisitions.md),
[F4 mapped planner](research/reuse-comparisons/f4-planner-cleanup.md),
[F4 actual Git/toolchain](research/reuse-comparisons/f4-workspace-closure.md),
[F5](research/reuse-comparisons/f5-acquisitions.md),
[F6](research/reuse-comparisons/f6-acquisitions.md),
[F7](research/reuse-comparisons/f7-candidate-acquisitions.md),
[F8](research/reuse-comparisons/f8-acquisitions.md),
[F8 HTTP](research/reuse-comparisons/f8-http-fit.md),
[F8 JWT libraries](research/reuse-comparisons/f8-jwt-acquisitions.md),
[F8 JWT HTTP](research/reuse-comparisons/f8-jwt-http-acquisitions.md),
[F9](research/reuse-comparisons/f9-entities-notice-followup.md),
[F9 notice/SBOM tooling](research/reuse-comparisons/f9-tooling-fit.md).
The subsequent [actual Vite notice-plugin cohort](research/reuse-comparisons/f9-plugin-fit.md)
used14MiB within its30MiB cap; exact owned directory removed and absence checked.
No production dependency/source change or GitHub write. F1 (222 MiB) and F2
(184 KiB) remain retained for continued package tests; F3/F4/F5/F6/F7/F8/F9 report exact
owned temporary-root cleanup. The F8 JWT cohort (3.6 MiB) was also removed with
absence verified after source/receipt review. Latest root disk check remains140GiB free.

## Herdr bounded adapter evaluation — 2026-09-08

Owner requested pinned source/license review, disposable read-only monitoring and
disconnect/restart/duplicate-session evaluation. Pre-acquisition space: 140 GiB
available on the shared APFS volume. Evaluation root created with mktemp:
`/private/tmp/control-room-herdr-eval.ZSup2F`. Limit this cohort to 1 GiB and stop
if available disk falls below 20 GiB. Do not use shared package caches.

Planned acquisitions: public release metadata, one pinned source archive and the
matching macOS arm64 release binary if source inspection permits isolated use.
No installer, Rust toolchain, personal-agent configuration or provider credentials.
Resolved master during discovery: `9e01168b140ce8e3821131345dc82bc2bf9994eb`;
selected release candidate is v0.9.0, whose tag pin is resolved separately before
source acquisition. Record actual paths, hashes, sizes and disposition below.
Retain downloads only for evaluation; remove this exact root after owned processes
are closed and sanitized evidence is saved. Do not delete unrelated caches/data.

Additional acquisition: pinned Cargo.lock dependency license metadata from public
`https://crates.io/api/v1/crates/NAME/VERSION`, bounded to 512 entries, four concurrent
reads and three minutes. No crate archives/install scripts are acquired. Normalized
metadata, exact URLs and response hashes go to `cargo-license-inventory.json` in
the same evaluation root. Runtime test state stays in its owned `run-*` children;
successful test children are removed after verified shutdown. Failed diagnostic
children are retained until findings are recorded and scoped cleanup is performed.

Acquisition/evaluation completed:

| Item under the evaluation root | Source/pin | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| `release.json` | GitHub releases/tags/v0.9.0 API | 21,891 | `98393f4f1e8d1e568c47e8cf9435f9b11b1f2eacfe0e32108a1e5c248fce0dd7` |
| `source.tar.gz` | codeload.github.com/herdrdev/herdr/tar.gz/b99002ac99b09e00b4ca692436cb15a6b0d676f1 | 8,489,740 | `dbb75bfeb331261c3c84b3e751cb7a52852faf944f7d887af53faf9b571ae7a0` |
| `herdr-macos-aarch64` | GitHub v0.9.0 release asset | 20,692,496 | `32b53df09872628059c789a69f02a6b8e29e14ddf26711421f3463f70c1aef17` |
| `cargo-license-inventory.json` | 265 exact-version crates.io metadata responses, normalized | 124,696 | `79af5fd4cfd94fc997fe1dc6ffc7582f274ceea6a78c06db2cf5da3c6f3efd21` |

The extracted source is `herdr-b99002ac99b09e00b4ca692436cb15a6b0d676f1/`.
Its contents are identified by the archive hash; no upstream file was modified.
Individual crates.io response bodies were held in memory and discarded after
normalizing license metadata and hashing them; no crate archives were acquired.
The full normalized license inventory is preserved at
`docs/research/HERDR_CARGO_LICENSE_INVENTORY.json` with the same hash, and the final
sanitized binary receipt at `docs/research/HERDR_BINARY_EVIDENCE.json`.
Acquisition/test tree peak observed allocation: 67 MiB; free space remained 140 GiB.

Two sandbox permission refusals occurred for the initial server/query; explicitly
scoped local-socket execution then worked. Three actual-binary fixture iterations
failed because `agent list` excluded session-bearing unknown panes. All owned
processes were closed each time. Source/response inspection identified the existing
`pane list` interface; the corrected run and expanded outage/permissions run passed.
No native agent was started; the pane executable was `/bin/cat` with synthetic
session reporting. Only this disposable server's socket was renamed/chmodded during
the test, with restoration before shutdown. No real profile, SSH host or provider.

Final observed test servers and captured cat PIDs exited; socket removal was checked
by the runner. `lsof -nP +D` on this exact root returned no entries (exit 1, its
no-match result). Cleanup completed: the exact acquisition/test root was removed
and its absence verified. Approximately 67 MiB of disposable downloads and fixture
state were removed; the pinned public downloads can be acquired again. Sanitized
evidence and the research prototype remain in the repository. No shared cache,
personal data or application dependency was removed.

## Control Center discovery cohort — 2026-09-07

Pre-acquisition: 140 GiB free. Public pinned source root:
`https://raw.githubusercontent.com/mreflow/control-center/d13e79e866cc33a1fddfe84f563ce2fb9a2113e0/`.
Acquired `lib/feed-discovery.ts`, `lib/freshness.ts`, `lib/sitemap.ts`, `lib/types.ts`,
`lib/server/rss.ts` and `tests/industry.test.ts`. Retained adapted code under
`src/vendor/control-center/` (five files, 44 KiB allocated) and the selected upstream
tests at `tests/control-center-discovery-upstream.test.ts`. No separate temporary
source directory. Changes and MIT provenance are in `third_party/control-center/NOTICE.md`.

Installed `fast-xml-parser@5.11.0` with `CI=true pnpm add --save-exact --ignore-scripts`.
Eight packages added: fast-xml-parser 5.11.0, fast-xml-builder 1.3.1,
@nodable/entities 3.0.0, anynum 1.0.1, is-unsafe 2.0.2,
path-expression-matcher 1.6.2, strnum 2.4.2, xml-naming 0.3.0.
All eight installed manifests declare MIT; package licenses remain in their packages.
Registry integrity hashes are retained in pnpm-lock.yaml. Installer reported 15
downloads, 481 reused, eight added; no claim that all downloaded cache entries were
new runtime dependencies. Shared pnpm cache must not be bulk-deleted. Source, tests
and parser are in use; remove through a later reviewed dependency/code cleanup if
this cohort is replaced. No install scripts, service, feed request or provider call.

## Full Control Center curation adoption — 2026-09-07

Pre-acquisition available space: 140 GiB. Retained one 512-line source file at
`src/vendor/control-center/industry-curation.ts`; no package install or service.
Source: `https://raw.githubusercontent.com/mreflow/control-center/d13e79e866cc33a1fddfe84f563ce2fb9a2113e0/lib/industry-curation.ts`.
SHA256: `ad668fe4bf08e7b48913b43ef7edb05edbe4d874db1a16c451ff006e0b70d962`.
This matches the earlier E03 original exactly. Existing MIT license retained under
`third_party/control-center`; notice updated. This file is now used, not disposable.
Other workflow/source inspections in the preceding review were read into tool output
only; no new retained evaluation directory or installed dependencies to clean up.

Started 2026-09-06. Owner authorized needed downloads for the reuse plan, with a storage check and a complete acquisition/cleanup record. This does not authorize provider calls, persistent services or production deployment. E01–E36 preserved application dependencies; E37 adds the pinned tested queue dependency locally.

## Storage before acquisition

### 2026-09-07 — ABS RSS/Atom parser dependency

Pre-acquisition check: 106 GiB available. Evaluation/adoption target: `rss-parser@3.13.0`
(MIT), using `parseString` only, not its URL-fetching implementation. Public npm metadata
confirms `entities ^2.0.3` and `xml2js ^0.5.0` dependencies. Package acquisition and
generated lockfile resolution are recorded below once complete. No feed requests,
provider calls, repository clone or service startup is part of this acquisition.

Acquisition complete: pinned rss-parser 3.13.0 plus entities 2.2.0, xml2js 0.5.0,
sax 1.6.1 and xmlbuilder 11.0.1; five packages downloaded. `pnpm-lock.yaml` records
all exact integrity hashes. Used lockfile-only resolution followed by frozen-lockfile
installation, both with lifecycle scripts disabled. No existing package versions changed.
Repository virtual-store directories total approximately 2.3 MiB (rss-parser 1.8 MiB,
xml2js 68 KiB, entities 112 KiB, sax 72 KiB, xmlbuilder 276 KiB). Shared pnpm cache
also retains package content; do not delete a shared cache as project cleanup.
Disposition: retained runtime dependency, imported by the feed decoder. If discarded,
remove the dependency and regenerate the lockfile/install normally; do not manually
delete shared dependency links. No temporary clone or downloaded article files exist.
License/source details: `third_party/rss-parser/NOTICE.md` and packaged licenses.


### E37 local application dependency preparation (2026-09-06)

Precheck: shared APFS volume reports 104 GiB available, 312 GiB used, 76% capacity.
Following E35/E36 complete local integration tests, pin pg-boss 12.30.0 as an application
dependency without enabling runtime startup. First attempt: pnpm 11.19.0 offline lockfile
resolution with lifecycle scripts disabled. Record success/failure, resolved dependencies,
storage and cleanup disposition after the command. E01 acquisition is retained unchanged.
Application installation is package-manager-owned node_modules, not a copied evaluation
tree. Removing it later requires a dependency/lockfile change and normal package-manager
reconciliation, not deleting shared caches or unrelated folders.

Outcome: offline metadata resolution failed (ERR_PNPM_NO_OFFLINE_META). Authorized npm
registry lockfile resolution then succeeded; frozen installation with scripts disabled
downloaded/added 21 packages. All 21 versions and integrity hashes match retained E01's
package-lock; see the existing E01 package/license table below. No old dependency versions
changed; registry refreshed an eslint deprecation metadata entry. Lock SHA256:
`51e1e83929e1b806c7316b2ca9b1b2326ae89aec3935f15c9e99a157bc531ad0`.
Installed pg-boss directory: `node_modules/.pnpm/pg-boss@12.30.0` (1.0 MiB); all package
locations/integrities are in pnpm-lock.yaml. Shared package cache:
`/Users/alastairfraser/Library/pnpm/store/v11` (do not delete wholesale). Storage remains
104 GiB available. E01 remains retained for comparison; no cleanup performed.

All 66 actual-package checks pass against repository node_modules with no evaluation-root
environment variable. Typecheck/lint/stage-zero pass. A normal pnpm run attempted an
automatic reinstall and refused without a TTY. Read-only fail-on-mismatch checks identified
global-virtual-store/CI setting and workspace-state differences; a second frozen install
reported already up to date but the workspace precheck still refused. No force/purge used.
Direct Node test commands work and are the verified fallback; pnpm runtime precheck
diagnosis remains open. This is not a failed package install or waived queue test.

E38 follow-up: the pnpm mismatch is resolved by explicit root-only workspace discovery
and local virtual-store configuration. Error-only prechecks and the normal pnpm command
pass (66 queue tests). No additional download, install, purge or cache cleanup was needed.

`df -h . /private/tmp`: shared APFS Data volume, 460 GiB capacity, 311 GiB used, **105 GiB available**, reported 75% capacity. Rounded filesystem figures need not sum due to APFS accounting. Stop acquisition and reassess if available space falls below 20 GiB or this evaluation exceeds 1 GiB; those are conservative evaluation limits, not requested permanent policies.

## Evaluation E01 — pg-boss

- Owner-created scope: actual package evaluation using disposable local data, no native agents or VPS effects.
- Exact temporary root: `/private/tmp/control-room-reuse-eval.4GX1mK` (created by `mktemp -d`).
- Requested package: `pg-boss@12.30.0` from `https://registry.npmjs.org/`.
- Status: acquired and executed in the isolated evaluation. npm installed 21 packages with lifecycle scripts disabled. Application manifests and `pnpm-lock.yaml` were not changed.
- Complete resolved acquisition inventory: [`research/reuse-e01-package-lock.json`](research/reuse-e01-package-lock.json), including every package version, public tarball URL and SHA512 integrity. Lockfile SHA256: `65750cf508155b418fa0ebd7489396fb569c7eac27d67dd1c0b51bfefc7e5be7`.
- Installed tree target: temporary root's `node_modules/`.
- Download cache and package-manager logs target: temporary root's `npm-cache/`.
- Config: evaluation-only `npmrc` and `globalnpmrc`; no host npm credentials; lifecycle scripts, audit/funding and update notifications disabled.
- Test database: existing repository PGlite 0.3.14, explicitly imported for the test only; no dependency tree copying/relinking.
- Retention: keep until comparison is complete, then remove only this exact evaluation root after closing owned handles and preserving sanitized provenance/results. Do not remove global caches or unrelated files. Cleanup has not occurred.

### Acquired packages

| Package | Exact version | Package license metadata |
|---|---|---|
| pg-boss | 12.30.0 | MIT |
| cron-parser | 5.10.0 | MIT |
| luxon | 3.7.2 | MIT |
| non-error | 0.1.0 | MIT |
| pg | 8.23.0 | MIT |
| pg-cloudflare | 1.4.0 | MIT |
| pg-connection-string | 2.14.0 | MIT |
| pg-int8 | 1.0.1 | ISC |
| pg-pool | 3.14.0 | MIT |
| pg-protocol | 1.16.0 | MIT |
| pg-types | 2.2.0 | MIT |
| pgpass | 1.0.5 | MIT |
| postgres-array | 2.0.0 | MIT |
| postgres-bytea | 1.0.1 | MIT |
| postgres-date | 1.0.7 | MIT |
| postgres-interval | 1.2.0 | MIT |
| serialize-error | 13.0.1 | MIT |
| split2 | 4.2.0 | ISC |
| tagged-tag | 1.0.0 | MIT |
| type-fest | 5.9.0 | MIT OR CC0-1.0 |
| xtend | 4.0.2 | MIT |

pg-boss's installed MIT LICENSE was inspected (Tim Jones, 2016). The table is package metadata, not a complete transitive source/license or security audit. Before redistribution, verify included notices and any copied source separately. No upstream code has been incorporated into application source.

### Acquisition attempts, storage and cleanup

1. Initial sandboxed npm install could not resolve the registry (`ENOTFOUND`); interrupted with exit 130 before package acquisition. Its log remains under `npm-cache/_logs/2026-09-06T14_44_34_515Z-debug-0.log` inside E01.
2. Same isolated install with authorized network access succeeded: 21 packages, exit 0. Options: `--ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org/ --fetch-retries=0 --fetch-timeout=30000`; prefix, cache, userconfig and globalconfig all explicitly point inside E01.
3. Post-acquisition storage: approximately **13 MiB total**, including **7.6 MiB node_modules** and **5.0 MiB npm-cache**; **105 GiB still available**. Retained package-manager metadata is included in that cache measurement. A later `pnpm exec eslint` update-metadata request failed in the sandbox; lint itself exited 0. Subsequent lint used the already-installed executable directly, with no package-manager request.
4. The first interrupted transaction experiment left one approximately 472 KiB synthetic SQLite fixture. Creation time (2026-09-06 14:50:06 UTC) matched that test; files matched the fixture's three databases. `lsof` found no open handles. It was recoverably moved from the exact `cr-native-lease-x6yBzu` temp directory into **E01/interrupted-synthetic-fixture/**; original-path absence verified. Nothing was deleted. The E01 total still rounds to 13 MiB. Do not commit these generated databases.
5. Later complete candidate and baseline test processes exited 0; their fixture teardown closed databases and removed their owned fixture directories. Downloaded packages/cache remain for the real-PG comparison; cleanup status is **retained, not deleted**. No standing evaluation service was created.

Keep this ledger and the lockfile after removing E01. The ledger contains local cleanup paths and is local-only while GitHub publication is paused; redact private host paths before external sharing. For each further download, add a new evaluation entry with a fresh storage measurement before acquisition.

## Evaluation E02 — disposable native PostgreSQL

Owner approved one local-only cluster evaluation, maximum 20 minutes from first server start, no TCP listener, no production data, required shutdown. Pre-download storage was 105 GiB available; host architecture arm64. Stage-zero passed. Root created before acquisition: `/private/tmp/cr-e02.LekM4K`. All downloads/cache and cluster files were kept here. Status: evaluation completed; server stopped and disposable database removed. Acquisition lifecycle scripts were disabled; isolated npm configs, no global install or autostart service. Exact package/integrity, explicit local symlink preparation and measurements follow.

### Acquired and evaluated

- Exact package: `@embedded-postgres/darwin-arm64@18.4.0-beta.17` (one package, no production dependency tree). [Exact E02 lockfile](research/reuse-e02-package-lock.json), SHA256 `f19c45250830d52fe1db02d64a6879d8f85ba98c6c47017195cc8873060bfd48`.
- Public registry tarball: `https://registry.npmjs.org/@embedded-postgres/darwin-arm64/-/darwin-arm64-18.4.0-beta.17.tgz`; SHA512 integrity is retained in the lockfile. Published source gitHead: `8c8c16d1b81bec8ae3315d59a050654086a85e23`.
- Installed/cache locations: E02 `node_modules/` and `npm-cache/`; installation exit 0, lifecycle scripts disabled, isolated registry configs. No wrapper library, Docker, Homebrew service, Rosetta or compiler installed.
- The package's MIT license was inspected (Lei Nelissen, 2022). It bundles PostgreSQL and native libraries with their own provenance/license obligations; this is **not** complete third-party binary redistribution clearance. Binaries remain local test tooling, not application release assets. PostgreSQL reports 18.4; this is a compatibility test version, not the selected/current-patch production release.
- Package binaries include both arm64 and x86_64 slices. Loader references were inspected. The PostgreSQL version banner describes an x86_64 build target; do not infer executed process architecture solely from that string. No Rosetta installation or translation configuration was performed.
- The package's ordinary postinstall hydrates library symlinks, so scripts remained disabled during acquisition. Before native execution, its complete hydration script and 17 link pairs were inspected; each source existed and every source/target resolved inside this exact package's native directory. Ran that specific package-local hydration step explicitly; no broad lifecycle scripts or upstream modifications.
- Post-download footprint **197 MiB** (144 MiB package tree, 53 MiB cache). Peak measured footprint with the cluster **261 MiB**, including 64 MiB disposable data. Available filesystem storage still rounded to **105 GiB**.

### Execution and cleanup

One initialized cluster, four short starts including planned restart and focused follow-up checks. Original window: 2026-09-06 15:02:05 UTC to final shutdown at approximately 15:07:21 UTC, **316 seconds**. The clock was not reset for follow-ups. All startups verified an empty IP listen-address list, exact private Unix socket directory, 0700 permissions and no TCP listener. Only synthetic data and generated test roles were used.

Initial run: six checks passed, one restricted-role check failed with SQLSTATE 42501 on `job_common`. Focused role follow-up: one passed after exact table grants. Domain/recovery follow-up: two passed. Failure and correction remain in the [E02 report](research/REUSE_E02_POSTGRES_RESULTS.md); not described as one wholly green original run.

Cleanup verified: lifecycle commands completed shutdown; no PID file/socket remained, `pg_ctl status` returned exit 3 (no server), and `lsof` of the exact data directory returned no handles (exit 1). An additional `ps` lookup was denied by the sandbox and is not cited as evidence. Removed **only E02/data and E02/socket**, then verified both paths absent. Approximately **64 MiB** of disposable database data was permanently deleted; it contained no real project data. The fixture can be recreated but that database snapshot has no retained backup.

Retained: E02 binary package, download cache, isolated configs/manifest/lock and local synthetic PostgreSQL log, **197 MiB**, for later authorized comparison. Nothing remains running. The log contains local paths/temporary identities and must not be committed or published; the repository retains sanitized results only. E01 remains separately retained as previously recorded. No app dependencies or remote GitHub state changed.

## Evaluation E03 — Control Center ABS helpers

Pre-acquisition disk check: 105 GiB available. Exact root `/private/tmp/cr-e03.RP4exe`.
Source candidate: `mreflow/control-center` at previously inspected immutable commit
`d13e79e866cc33a1fddfe84f563ce2fb9a2113e0`. Scope: small source/license files for comparison;
no repository clone, package installation, article collection or provider calls. Status:
acquisition and focused adaptation complete, as recorded below.

Acquisition complete: two public raw files, 24 KiB total retained, no additional
dependencies. `industry-curation.ts` SHA256
`ad668fe4bf08e7b48913b43ef7edb05edbe4d874db1a16c451ff006e0b70d962`;
`LICENSE` SHA256 `a149b592d1e38b71a4ff4987ee9020b5f35a5fe7c2f09ebdc78ae9ec7a87349b`.
Both were fetched from `https://raw.githubusercontent.com/mreflow/control-center/`
at the exact revision above, paths `lib/industry-curation.ts` and `LICENSE`.
Web reader missed the source; direct public curl retrieval succeeded. Files were saved
as LF text through apply_patch; hashes refer to those retained bytes. No raw media or
private credentials were downloaded.

Disposition: adapted the event/title-only subset into
`src/vendor/control-center/industry-events.ts`, with full MIT notice retained under
`third_party/control-center/`. No source URL-normalization, scoring, network, database
or soft-cap behavior adopted. Original files remain in E03 for the four source-comparison
tests. Cleanup status: 24 KiB retained, no service or runtime state. See the
[integration report](REUSE_INTEGRATION_PROGRESS.md) for scope and failed/corrected tests.

## Evaluation E04 — Hermes presentation source

Pre-acquisition disk check: 105 GiB available. Exact root `/private/tmp/cr-e04.eFL8Ow`.
Inspecting Hermes Desktop at `3f744975f818bbb40ed029e6b3022cd0c5ad7a24`.
Two public recursive Git tree reads were made: the first tool output truncated before
parsing; the second filtered the response to source candidates. No repository clone or
installation. Filtered inventory will be retained in E04; raw tree response was not
saved to disk. Source/license acquisitions and their disposition follow when complete.

Acquisition complete: **76 KiB retained**, no packages or media. The following raw
paths all use `https://raw.githubusercontent.com/fathah/hermes-desktop/` followed by
the immutable revision above. Local filenames and retained SHA256 checksums:

| Upstream path | E04 filename | SHA256 |
|---|---|---|
| `LICENSE` | `LICENSE` | `85d12b0f8894e7095f904a9a89fcfaea1b0d037cbfb4a12aba81daa87bcdbcd4` |
| `src/renderer/src/screens/Layout/ActiveSessionsBar.tsx` | `ActiveSessionsBar.tsx` | `61eea6c02fbc832136c5b50cd30d785a1ff774989adb29a0af8be4eb30f736c8` |
| `src/renderer/src/screens/Layout/SidebarRecentSessions.tsx` | `SidebarRecentSessions.tsx` | `6fc4bb78bc36ddd671e1347518e571226076623fec71ea3960c3dfd9a0fb30b3` |
| `src/renderer/src/components/settings/ConnectionPane.tsx` | `ConnectionPane.tsx` | `e6980c9255af6a2b452a965cd257f405e9d2933d1198c183a362c22efe0cb667` |
| Filtered Git tree API response, not source code | `desktop-inventory.json` | `cbf35de08b4ce5991e0f451557b6a5ebc9b4705aaf67b657aaa3d95d68cf3731` |

Saved through apply_patch; the four source/license Git blob hashes exactly match
the upstream inventory, so their retained content is byte-identical. Public web
directory reads missed the cache; direct public API/raw retrieval succeeded. The
WebUI root was viewed through the web reader, not saved locally. No credentials,
plugins, Electron app, native agent, or repository installation involved.

Disposition: [E04 source-fit report](research/REUSE_E04_HERMES_PRESENTATION.md).
MIT source is retained for a later focused project-tab/onboarding adaptation; none
was incorporated yet. Cleanup status: retained, not deleted. Only this exact E04
directory is eligible for later cleanup after preserving needed provenance.

## E05 continuation — no acquisition

The continuous-worker and canonical delivery tests reused E01's pinned installed package
and existing application test dependencies. No downloads, package updates or native
database-server startups. In-memory PGlite/SQLite fixtures were closed by completed test
processes; no new evaluation directory or cleanup target. E01–E04 retention is unchanged.

## E06 — Hermes machine-to-machine transfer research

Owner requested checking current Hermes agent-to-agent data transfer for possible reuse.
Pre-download disk: 105 GiB available. Root `/private/tmp/cr-e06.QqqVyy`.
Public main resolved to `14ca27fa0601144b6ea4af1408a3b37c22456072`, commit dated
2026-09-06T15:31:47Z. Commit/tree metadata viewed but not saved as files. Raw source
downloads use that immutable revision, not mutable main. No live peer registration,
plugin installation, agent call, credentials or file transfer authorized/performed.
Acquisition completed: **257,791 logical bytes / 272 KiB on disk**, 10 files.
Additional PR-source acquisition was preceded by another disk check: 105 GiB free.
All sources were retrieved from public raw GitHub URLs and retained with apply_patch.

Main source URL prefix: `https://raw.githubusercontent.com/NousResearch/hermes-agent/14ca27fa0601144b6ea4af1408a3b37c22456072/`.

| Remote path | E06 filename | Retained SHA256 |
|---|---|---|
| `LICENSE` | `LICENSE` | `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6` |
| `plugins/platforms/a2a/README.md` | `a2a-README.md` | `b1aab5cfb747c64d8cfb148afe96a2d8dead8b018fee4e72a3a12510ef3eb127` |
| `website/docs/user-guide/messaging/a2a.md` | `a2a-guide.md` | `30a1cae98d0a230121187a464af84da491c6f36adf83cff1f132d43ec96c1893` |
| `plugins/platforms/a2a/protocol.py` | `a2a-protocol.py` | `ac0e197ce04aad72ded2a748666ae8aa81058d26fdb34be29d454b17790ced09` |
| `plugins/platforms/a2a/tools.py` | `a2a-tools.py` | `5cb6946f3f2f35d42d4234921d66503b56e160a38d3a0b0560c53f2d209b5440` |
| `hermes_cli/subcommands/peer.py` | `peer.py` | `2504d4b2126e3ca429211a6e673c664f15f30635b56e3a260ba6d4a65c0690cf` |
| `tools/bot_mode_dm.py` | `bot_mode_dm.py` | `321ed449f126c2c6d99b735d6dabd1c86fd9ada61dcf3785009140ccc57fe2ef` |

PR sources use `https://raw.githubusercontent.com/dokterdok/hermes-agent/`
followed by the pinned head and remote path, not a mutable branch.

| PR / pinned head | Remote path | E06 filename | Retained SHA256 |
|---|---|---|---|
| #98072 / `5bc71c54fefb52e6d9f646c950cc04466c2c5a9b` | `gateway/hosted_room_attachments.py` | `pr98072-attachments.py` | `0afdd04dda080bd7dadf5a936eb849de4df6bd151fddb912fcf3b4f6210531bd` |
| #98072 / same | `gateway/platforms/api_server_room_attachments.py` | `pr98072-api-attachments.py` | `919a7ce6564355dd4409ec68005a6b9d0daef1b9e272bc04e09165e0b1ded77d` |
| #99159 / `9dbc7097e02ff1c22a265b6078695259eabb6e4d` | `gateway/hosted_room_artifacts.py` | `pr99159-artifacts.py` | `77a997789b82237bcb2eb6fff39cbc92ce75e78984e24d9b8b7efbe35310a07f` |

PR metadata/file lists and web pages were viewed, not retained as files. One unquoted
query URL failed in zsh before network access; quoted retry succeeded. Some combined
tool outputs truncated; narrowed queries recovered the relevant inventory. #99159's
100-entry first page is not a complete diff inventory. No archive, package or runtime
installation. No source modules executed and no live transfer performed.

Disposition: [E06 source-fit report](research/REUSE_E06_HERMES_TRANSFER.md).
No E06 code adopted. Retain this exact directory for the bounded source evaluation;
cleanup status is retained, not deleted. Verify pinned PR licenses/dependency notices
before source import; only main's root MIT license was acquired this pass.

### E06 continuation — pinned offline test closure

Pre-acquisition disk check: 105 GiB available. Reuse the exact E06 evaluation directory.
Acquire minimal source/license/test dependencies from #99159 head
`9dbc7097e02ff1c22a265b6078695259eabb6e4d` for an isolated offline artifact-store
evaluation. No owner profile, native agent, network listener or authentication will be
used. Record the final inventory/hashes and any incomplete dependency closure below.

Seven additional files acquired from the pinned fork URL above, retained under E06.
The root license is MIT with the same Nous Research notice. Total E06 size is now
**504 KiB**. No modules executed: `hermes_state.py` reveals a much larger session-store
import closure. The owner's exact feature quote then redirected evaluation to merged
remote-sandbox retrieval #103600; do not continue broad RoomLink downloads by default.

| Remote path | Local filename | SHA256 |
|---|---|---|
| `LICENSE` | `pr99159-LICENSE` | `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6` |
| `gateway/hosted_room_attachments.py` | `pr99159-gateway-hosted_room_attachments.py` | `29edaef095ff3af9806dd6dc5c8179888e8ba19cfe0aefec2a797df2011039ef` |
| `gateway/hosted_room_route_schema.py` | `pr99159-gateway-hosted_room_route_schema.py` | `d9b022aef066b9865a33d4411673b5f3320a99ce9137d55071e06606a5aa4ba1` |
| `gateway/hosted_room_safety.py` | `pr99159-gateway-hosted_room_safety.py` | `c05d196965ac753c4479ba4c6a3cc78c1bf5b46a6810a513c28d802cf3ec61d8` |
| `gateway/hosted_rooms.py` | `pr99159-gateway-hosted_rooms.py` | `1f396fa93d41e042d3db84e04998b2c956077a462dee39b59a8662ac1c72b86f` |
| `gateway/hosted_rooms_common.py` | `pr99159-gateway-hosted_rooms_common.py` | `b50b75a091700368f844eaa3a27a1a0890c2e3f97df2a206a0437bcbdd1420c4` |
| `hermes_state.py` | `pr99159-hermes_state.py` | `9353e4fa0a8353b3e50b1945a87a898cf88b647ef726a4bab8ce5f65dffec431` |

Additional main tree/search/PR #103600 API and web responses were inspected, not
retained as files. No #103600 source downloaded to disk yet. All 17 E06 files remain
retained for evaluation/provenance; no cleanup performed, no service or process started.

### E07 — merged Hermes remote-sandbox output retrieval

Pre-download disk check: 105 GiB free. Use E06's exact retained directory with
`e07-` filename prefixes; do not mix these files with unmerged RoomLink modules.
Acquire source/license from merged commit `b499ab11fe8b081470e269f2fb27abae03000da5`
of `NousResearch/hermes-agent` (#103600). Offline synthetic-file evaluation only;
no native Hermes runtime, remote sandbox, agent/provider, credentials or listener.

Acquisition complete: 11 E07 files, **712 KiB combined E06/E07**. URL prefix is
`https://raw.githubusercontent.com/NousResearch/hermes-agent/b499ab11fe8b081470e269f2fb27abae03000da5/`.
Local names below encode the upstream path after `e07-`: `gateway-platforms-` maps
to `gateway/platforms/`, `tools-environments-` to `tools/environments/`,
`tests-gateway-` to `tests/gateway/`; other first directory separators likewise map
to `/`. The retained base LICENSE is MIT. No third-party package installed.

| E07 filename | Retained SHA256 |
|---|---|
| `e07-LICENSE` | `821556e6336796450ab852d375117b48a4887e71d255794fd6318d99982a5ab6` |
| `e07-gateway-media_fetch.py` | `35863b2d653c109dc0b2301d10dc7faa916420cc1fabb18cab95824b1e409906` |
| `e07-gateway-platforms-api_server_runs.py` | `270f7e221b5486a6ac499732d0f5471f3f48dc0c0a0633186bc762bcb1345a39` |
| `e07-hermes_cli-_subprocess_compat.py` | `625cfb9a1088eb8a50313e9b1a0b5a186cb582cc68ee9c8f9ee12580bf9e0144` |
| `e07-hermes_constants.py` | `492a78956930c5c385121b525b947fa50056c20666d01c431e2fd93436e793b0` |
| `e07-tests-gateway-test_remote_media_fetch.py` | `d3040be616d45b734857ddc3043cbcf5891ea1f01b3897a0e3b5792e723592b0` |
| `e07-tools-environments-base.py` | `3b4ac4db47ff700b48a447a4ebe396de070358134934cbd505cb9871070e0716` |
| `e07-tools-environments-base_output.py` | `e16963a309d74d5d4aee25299716ac6b536640b09b9d48fa756ea70a66bcaa0e` |
| `e07-tools-environments-base_session_env.py` | `1db42be8bead2c12d8e1ae3bccfc775148e0fda15aaf85d2b979cc01e62739b0` |
| `e07-tools-environments-base_wait.py` | `8bfb5a97f1fd92a1c9a6f8e1c801473ef23caa6b767c9da7e3553ea86fc827c9` |
| `e07-tools-interrupt.py` | `fc0e402eab50383407e1bf547503cdaf750545e97874ae12249bba1a1abc6deb` |

Attempted `gateway/media_delivery.py` retrieval failed (curl 56), nothing retained
under that name. The actual media hook is the retained `gateway/media_fetch.py`.
No retry or extra tree download was needed. Source/test additions remained within
the same logged scope, with a second 105 GiB free-space check before run-API source.

[E07 test report](research/REUSE_E07_HERMES_REMOTE_FETCH.md): initial system Python
3.9 import failed before tests; existing bundled 3.12.14 passed 11 offline tests.
Only synthetic fixture files/symlinks were created and removed automatically by
the test harness. Downloads remain retained; no source copied into runtime, no
live gateway/remote backend/agent or provider used. Preserve these pinned sources
for reproducibility; only the exact E06 directory is a future cleanup target.

### E08 — Hermes authenticated file access source fit

Pre-download disk: 105 GiB free. Retain `e08-` files in the same exact evaluation
directory, pinned to E07's merge `b499ab11fe8b081470e269f2fb27abae03000da5`.
Inspect existing media/file interfaces and their authorization before integration.
Public tree metadata reads only so far; no live service or credential access.

Four pinned source files retained (three tree listings viewed, not saved). Source URL
Combined E06/E07/E08 retention is **864 KiB**; disk remains approximately 105 GiB free.
prefix is E07's public raw URL. Local names map to `hermes_cli/web_routers/files.py`,
`hermes_cli/web_server.py`, `hermes_cli/web_server_files.py` and
`tools/environments/file_sync.py` respectively. Same pinned MIT root license retained.

| E08 filename | Retained SHA256 |
|---|---|
| `e08-hermes_cli-web_routers-files.py` | `727c8a05cb3c4491f47f9a21537a523064b823f4094c64bd68996117917e533c` |
| `e08-hermes_cli-web_server.py` | `cebf1e020b7934dac336ddeb1b532259a917baea21f94097ced429b366471433` |
| `e08-hermes_cli-web_server_files.py` | `bbfddf761fe9949812e5eab53dad8288bbde55b0ef7662e5994df76b6edb0610` |
| `e08-tools-environments-file_sync.py` | `0ebbf3515a511deed9efa90c86fff31c4fd5380e89f4937f9a41a2b07109b9ee` |

One orchestration call failed JavaScript parsing before execution; corrected call
retrieved the intended web server source. Bundled FastAPI import probe reported absent;
no install performed. Nine source-level policy tests used explicitly documented type
stand-ins, not a fake HTTP/auth pass. Synthetic test fixtures were cleaned automatically.
All source retained for provenance; no source modules from the web server, file router
or credential-sync manager executed. Only the isolated path-policy module was evaluated.
See [E08 evidence](research/REUSE_E08_HERMES_FILE_API.md). No live service or credential
access, no runtime source adoption, and no directory cleanup beyond test fixtures.

### E09 — owned queue lifecycle (no acquisition)

Reused E01's existing pg-boss 12.30.0 package and repository PGlite for 28 combined
actual-package tests. No downloads, native database server, native agent, service or
provider. Unit/type/lint tests also used existing dependencies. In-memory fixtures
closed on completion. All E01–E08 retained acquisition paths remain unchanged.

### E10 — queue worker privileges (no acquisition)

Reused E01 pg-boss and existing PGlite. Candidate SQL executed only in fresh in-memory
fixtures; no native database/role configuration. 31 combined package checks passed.
Fixtures/processes closed, no downloads or installation, retained sources unchanged.

### E11 — permission preflight (no acquisition)

Reused retained E01 package and repository dependencies. 32 combined package checks
passed on in-memory PGlite; fixtures closed on completion. No new download, service,
installation or retained temporary data. Acquisition paths remain unchanged.

### E12 — coordinator integration (no acquisition)

Used the retained E01 package and existing dependencies for 20 package checks and 28
lifecycle/startup checks. In-memory fixtures closed; no download, installation, live
service or additional cleanup target.

### E13 — application queue privileges (no acquisition)

Reused E01 and repository dependencies. Candidate grants and preflight exercised only
in in-memory PGlite fixtures, closed after tests. No additional retained files outside
the repository, downloads, installation, PostgreSQL service or GitHub publication.

### E14 — producer startup (no acquisition)

Existing E01 package and repository dependencies only. In-memory fixtures and late
synthetic resources cleaned after tests. No download, installation, native service,
credential operation or new retained temporary directory.

### E15 — upstream version/drift evaluation (no acquisition)

Read retained E01 package source and used existing PGlite. All version/index changes
were confined to disposable in-memory fixtures, closed after tests. No downloads,
native database/server, additional retained directory or external mutation.

### E16 — worker identity (no acquisition)

Retained E01 package and existing repository dependencies only. Synthetic LOGIN/role
changes occurred solely in disposable PGlite fixtures, closed after tests. No native
credential, server, connection pool, downloads or new cleanup directory.

### E17 — worker startup composition (no acquisition)

Existing E01 package and repository dependencies only; actual-package fixtures remain
in-memory and close after tests. No new downloads, persistent services, native database,
provider calls or temporary acquisition paths.

### E18 — joint lifecycle and delivery inspection (no acquisition)

Repository source and existing dependencies only. Fake lifecycle resources and PGlite
regression fixtures cleaned by tests. No download, new temporary directory, native
service or external publication.

### E19 — server delivery authority (no acquisition)

Existing repository dependencies and retained E01 package only. PGlite and synthetic
signed-session fixtures closed after tests; no native provider, credentials, downloads
or new retained temporary directories.

### E20 — managed-session queue routing (no acquisition)

Repository dependencies only. Disposable signed-session/PGlite fixtures closed after
tests; no package acquisition, native provider, credential access or external changes.

### E21 — connected queue-to-review regression (no acquisition)

Existing E01 package and repository dependencies only. In-memory queue and signed
session fixtures closed after tests. No new download, directory, native service,
credential use or external publication.

### E22 — host startup and offline pickup evidence (no acquisition)

Existing repository dependencies and retained E01 package only. Fake worker factories,
minimal queue ACL and in-memory actual-package fixtures close after tests. No new
download or retained directory; no native service, credential or external effect.

### E23 — recovery primitive evaluation (no acquisition)

Read retained E01 package source and executed its public APIs against disposable
in-memory fixtures. No new downloads, native server, credentials or external effects.
The initial unsupported restore() call failed; corrected to test public API absence.

### E24 — canonical recovery integration (no acquisition)

Existing E01 package and repository dependencies only. Disposable PGlite canonical,
queue and signed-session fixtures closed after tests. No new retained acquisition,
native process, credential access, deployment or external publication.

### E25 — recovery permission profile (no acquisition)

Existing E01 package and repository dependencies only. Column grants and temporary
LOGIN identities exist only inside closed in-memory fixtures. No downloaded files,
new retained directory, production database changes or external publication.

### E26 — owned recovery and verified pickup (no acquisition)

Existing repository dependencies and retained E01 package only. Synthetic transports
and in-memory fixtures closed after tests. No acquisition, credentials, native service,
provider call, deployment or external publication.

### E27 — recovery startup wiring (no acquisition)

Retained E01 package and repository dependencies only. Disposable in-memory fixtures
closed after tests. Initial administrative fixture pickup used the wrong retained
logical identity and failed; fixed in test setup without expanding coordinator grants.
No download, credentials, native service or external publication.

### E28 — automatic readiness recovery (no acquisition)

Existing repository dependencies and retained E01 package only. In-memory fixtures and
synthetic transports closed after tests. No download, new retained directory, native
database/provider, credential access, deployment or external publication.

## E55 — isolated ssh2 signing compatibility

Pre-download disk check: 102 GiB available on the workspace/temp filesystem.
Exact evaluation root: `/private/tmp/cr-e55.x7lWXA`. Candidate: `ssh2@1.17.0`
from the public npm registry. Owner's logged-download authority applies; no native
agent, real credentials, listener or SSH service is authorized or used.
Install only here, with lifecycle scripts disabled and optional dependencies omitted;
cache and configuration files stay in this root. Acquisition result, lock integrity,
license inventory and retained size will be appended after verification. Status: planned.

Acquisition completed: npm installed five packages, exit 0, with `--ignore-scripts
--omit=optional --no-audit --no-fund`, explicit local prefix/cache/config and a 30-second
fetch timeout/no retry. No application manifest/lockfile or global package changed.
Retained evaluation lock: `docs/research/reuse-e55-package-lock.json`, SHA256
`8bbce62b2b395f941ac07533fe3a5cd4c59e9c03641432ff8ad0d46277bf3805`.
It records exact registry tarballs and SHA512 integrities. Original candidate agent.js
SHA256: `cc6987488bf45f73e0ac5d8bbe59912b70a144cd73b53c83919f188f4cc3f2be`.

Installed license files inspected: ssh2 1.17.0 (MIT), asn1 0.2.6 (MIT), safer-buffer
2.1.2 (MIT), tweetnacl 0.14.5 (Unlicense), bcrypt-pbkdf 1.0.2 (BSD-3-Clause Blowfish
plus ISC-style notices for bcrypt/Javascript portions). Preserve all notices if adopted.
Optional cpu-features/buildcheck/nan entries remain in npm's lock but were not installed;
their presence is not an assertion of license clearance or native-build execution.

Post-acquisition size: 2.9 MiB total, 1.8 MiB node_modules and 1.1 MiB cache; 102 GiB
still available. Cleanup status: retained for the next offline adapter evaluation,
not deleted. Exact cleanup candidate remains `/private/tmp/cr-e55.x7lWXA`; keep this
ledger and the committed lock after eventual cleanup. Tests close their in-memory
protocols and disposable fixtures. No standing process/socket/key store was created.

## Evaluation E69 — etcd client (2026-09-06)

Pre-acquisition free space: 102 GiB on the workspace/temporary volume.
Exact isolated evaluation and cleanup candidate: `/private/tmp/cr-e69.gJhaMa`.
Planned acquisition: public npm metadata and a pinned `etcd3` package plus its
dependencies, with lifecycle scripts disabled, no optional dependencies and a local
cache/configuration. No application dependency change, credentials, etcd server,
listener or live database is authorized by this evaluation. Retain the download
record and package lock after eventual cleanup. Acquisition outcome recorded below.

Outcome: initial sandbox metadata lookup failed DNS; authorized escalated public
registry lookup and install succeeded. Pinned `etcd3@1.1.2`, 37 packages installed
with scripts disabled. Retained root totals 31 MiB including cache and dependencies.
No server binary downloaded or started. Package LICENSE inspected: MIT (Microsoft).
Transitive license/security clearance remains unfinished. Reproducible dependency
inventory: `docs/research/reuse-e69-package-lock.json`, SHA-256
`b8307c21522e05b5325aa2c9c79164ec86303f4f0a675cd72837d9d20d6ad7f9`.
Two installed-package fake-RPC diagnostics pass. Retained, not deleted; no main
application dependencies changed. Evaluation decision is documented in E69.

E70 reuses this same directory and package lock without additional acquisition.
Three generated-gRPC-client/codec diagnostics pass with a fake channel (five combined
E69/E70 tests). gRPC/proto-loader installed license files are Apache-2.0; upstream
protocol provenance and full transitive clearance remain required before adoption.
No service, resolver or physical connection created. Retention status unchanged.
# 2026-09-07 — Control Center reading cohort

Before acquisition, `df -h .` showed 140 GiB free. Read three pinned public source
files at d13e79e866cc33a1fddfe84f563ce2fb9a2113e0: `lib/industry.ts`,
`components/daily-snapshot.tsx`, `components/daily-snapshot.module.css`.
Retained industry module under `src/vendor/control-center/industry.ts` (imports
adapted), snapshot presentation under `private-app/app/news-daily-snapshot.tsx`
(adaptations recorded in third_party/control-center/NOTICE.md). Both are in use.
CSS was inspected in tool output only, not saved. No temporary download directory,
package installation, credentials, Actions or remote write. Remove retained modules
only if their news page imports are removed; there are no unused downloaded files
from this acquisition to clean up.
# 2026-09-07 — Control Center HTTP reader cohort

Disk check before acquisition: 140 GiB free. Read three public files at pinned
revision d13e79e866cc33a1fddfe84f563ce2fb9a2113e0 under `lib/server/`:
`safe-fetch.ts`, `pinned-fetch.ts`, `public-address.ts`. Read once for inspection,
then again to retain exact module bodies via apply_patch. Stored under
`src/vendor/control-center/` with adaptations in the upstream NOTICE. No separate
temporary files, packages or caches downloaded. Retained for integration and fake
tests; remove only if the corresponding imports/tests are removed. No native fetch,
source collection, credential operation, GitHub write or Actions run occurred.
At local checkpoint 91e62ae, retained adapted code totaled 14,790 bytes. SHA256: public-address
`291fc245b943c48feaeb5807ef5f60b1ec8b31f0f8f6cdd7782c998be0c6cb48`;
pinned-fetch `1fafc239bb2a06038c2c7f54d0026f736e64f938ff37976e075b2021e20112ca`;
safe-fetch `986fe50ac2579e6a97f2bebbfcce6c1fd8b87eb709f5bc04c6310e2d8427e03f`.
