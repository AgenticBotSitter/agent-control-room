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
