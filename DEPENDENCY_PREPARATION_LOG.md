# Implementation dependency preparation

2026-09-08: pg 8.23.0 promoted to an explicit dependency using pnpm 11.19.0,
offline mode and disabled install scripts. Existing cache reused; zero downloaded
packages and zero newly added package files reported. Free disk before preparation:
137 GiB. Initial attempt refused a mismatched default store without installing;
retry explicitly selected the already-used store, without changing global settings.

Cleanup: this checkout's node_modules is disposable after stopping owned processes.
Do not delete the shared package cache. No production service or database was used.
Original pg MIT license inspected; complete release notices remain a batch gate.

Added @types/pg 8.15.5 as a pinned development dependency, scripts disabled.
One package downloaded/added, 496 reused. Stored in the same shared pnpm cache
and linked into this disposable checkout; no global setting changed. This is
compile-time declaration material, not a second runtime driver.

Removed postgres 3.4.7 after the final caller/import inventory. pnpm reported one
package removed, zero downloaded. The initial remove invocation rejected an
unsupported flag; the corrected command used config.ignore-scripts=true.
Shared cache was preserved; removed local dependency links are reproducible from
the previous lockfile if rollback is required.

Batch 2: jsonwebtoken 9.0.3 and @types/jsonwebtoken 9.0.10 pinned. Offline metadata
was unavailable; authorized registry preparation downloaded 13 runtime packages
and 2 declaration packages. Scripts disabled; free storage before: 137 GiB.
Same disposable checkout/cache cleanup boundaries apply. Full notices remain due.

Batch 3: pinned react-markdown10.1.0 and remark-gfm4.0.1, lifecycle scripts
disabled. pnpm reported 96 packages downloaded/added, 511 reused. Retained in
the logged checkout and existing shared cache; do not erase the shared cache.
Transitive release-notice collection remains required before publication.

Batch4: @mozilla/readability0.6.0 and jsdom26.1.0 pinned, scripts disabled;
36 packages downloaded/added, 607 reused. Free space before: 137 GiB. Existing
checkout/cache retention rules apply. whatwg-encoding deprecation reported;
no unrequested package upgrade performed. Notices still required.

Batch5: cron-parser5.10.0 promoted from existing transitive cache to a pinned direct
dependency using offline mode and disabled scripts. Report: 643 reused, zero
downloaded, zero added package files. Free space before: 137 GiB. Existing shared
cache must not be deleted; disposable checkout links follow the cleanup policy above.

Calendar review remediation: Luxon3.7.2 promoted from the same existing cache to
an explicit dependency, offline and scripts disabled. 643 reused, zero downloaded,
zero added package files. Original MIT notice retained. Same cleanup scope applies.
# Owner signing protocol preparation

Preflight: 137 GiB available on the temporary filesystem. Earlier E55 directory
and both queried pnpm cache indexes are absent. Scoped evaluation directory:
`/private/tmp/cr-owner-signing.gwHGwO`; this exact directory is the cleanup target
after the adapter evaluation. Do not delete shared package stores.

Prepare ssh2 1.17.0 with lifecycle scripts and optional packages disabled, with
its own cache. This authorizes no agent socket, credentials, listener or provider
call. Keep the lock and notices for provenance. Outcome pending below.

Completed: npm installed five packages with scripts/optional dependencies disabled.
Retained size 2.9 MiB (1.8 MiB packages, 1.1 MiB isolated cache). Lock retained at
`research/owner-signing/package-lock.json`, SHA256
`92698bc95ad39bb265d4f50604382b1db8edaf931357501e21459a93b1ffb401`.
ssh2 agent.js SHA256 matches the earlier evaluated source:
`cc6987488bf45f73e0ac5d8bbe59912b70a144cd73b53c83919f188f4cc3f2be`.
Directory remains retained for bounded integration work; no shared cache cleanup.
No app dependency or bundled release was changed. Full third-party text inventory
remains required before shipping this separately installed runtime.
