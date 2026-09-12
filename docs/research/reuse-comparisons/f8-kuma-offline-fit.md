# Kuma release dependencies and offline database fit

2026-09-08. Actual isolated setup, not daemon/alert acceptance.

The exact2.5.3 release lock prepared with `npm ci --ignore-scripts --omit=dev
--omit=optional`, no audit/fund/network retries, isolated empty npm configuration
and home,60-second deadline and500MiB cohort cap.574 packages installed in3seconds;
cohort288,816KiB including archives/source/UI/cache. Recorded deprecation warnings
include old tar/glob/inflight families: retain as maintenance/advisory follow-up,
not a claim all installed modules execute or a reason to erase the candidate.
No installer scripts or fallback compilation ran. Full exact resolved graph is
the pinned release lock in the retained source cohort; its hash is in the receipt.

The inspected addon was copied only to its expected installed package binding
path and loaded in one sterile child process. Native code provenance is the
official release download plus observed hashes and ad-hoc integrity signature;
not independently authenticated publisher signing. Existing owner home/config,
credentials and services were not used. The first command targeted a nonexistent
assumed Node path and exited127 without execution. After locating process.execPath,
the same research ran with the actual Node22.22.3 executable, empty environment,
synthetic home and256MiB V8 heap setting (not a whole-process memory measurement).

Actual upstream Database.initDataDir/writeDBConfig/connect/patch initialize the
owned SQLite database, including legacy/Knex/aggregate migrations. No migration
skip flag, mocked SQLite engine, MariaDB fallback or patched upstream code. Actual
Settings.set/get and raw stored value confirm checkUpdate=false before any daemon
listen. SQLite3.41.1,29 tables, clean upstream Database.close and cleared settings
timer; process exited0. See `f8-kuma-offline-evidence.json`.

Retained data: `/private/tmp/cr-f8-kuma-release-OiEJq7/offline-data-BoNMHr`.
It is a disposable initialized monitoring DB, not Control Room's authoritative
PostgreSQL database, a production account or a completed monitor configuration.
No daemon/server listener was requested; no provider call or actual alert occurred.
No OS-wide outbound traffic trace or independent process-memory measurement is
claimed. Full daemon code has not executed merely because its database models loaded.

Next finite test: use exact matching packaged UI and unchanged release daemon,
explicit loopback endpoints and a synthetic supported webhook receiver. Verify
persisted false from a fresh process before listen; observe real monitor transition,
stored heartbeat, notification, restart and duplicate behavior. Then cleanup/absence
checks and source/evidence review. Do not repeat dependency or migration preparation
unchanged; reuse the exact retained cohort and evidence. Beszel fit stays separate.
