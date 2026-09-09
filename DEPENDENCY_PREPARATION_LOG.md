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
