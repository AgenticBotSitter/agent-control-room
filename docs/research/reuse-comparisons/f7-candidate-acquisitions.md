# F7 candidate source acquisition

2026-09-08. Storage before acquisition:140GiB free. Global retained cap4GiB;
this cohort cap3MB, each source file capped400KB, requests bounded15seconds.
Owned root `/private/tmp/cr-f7-candidates.8g4o3m`.

Public commit/tree API inspection selected immutable Miniflux, FreshRSS and RSSHub
files. API responses were inspected but not retained. Initial sandbox DNS lookup
failed (no files acquired); explicit read-only network permission then succeeded.
No authentication, private repository, writes to GitHub or Actions.

`research/reuse-comparisons/f7-candidates-fetch.mjs` downloaded17 exact source,
license and test files totaling253,905bytes, no archives/install/toolchains. Full
URLs, bytes, pins and SHA256 are in `f7-candidates-source-receipt.json`; that receipt
was preserved before cleanup. Source files were inspected, not executed. No service,
PHP/Go runtime, database, agent or provider started.

Final exact-root lsof found no handles; no candidate process had been started.
Exact owned root removed and absence verified.284KiB allocated source/receipt files
were removed; public pinned sources can be reacquired with the retained fetch script.
Sanitized source receipt and findings remain local in the repository.
