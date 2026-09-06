# Reuse evaluation download and cleanup ledger

Started 2026-09-06. Owner authorized needed downloads for the reuse plan, with a storage check and a complete acquisition/cleanup record. This does not authorize provider calls, persistent services or production deployment. Application dependency declarations and lockfile remain unchanged; test scripts have been extended.

## Storage before acquisition

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
