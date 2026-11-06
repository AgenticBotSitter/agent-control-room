# b8-selection-to-start status
Phase: BUILD — U81-B round 11 review repairs
Base: cook/b8-selection-u81b 2a5946143d80017698bc0a74935e2d5954884641
Candidate: HEAD plus retained uncommitted R11 repairs; git add refused index.lock (exit 128), no commit attempted
Completed this round: explicit bounded source-first 0316 lock; corrected admissions-table header and ledger; exact-target status failures project blocked UNAVAILABLE; concurrent PG17 backfill/writer test and real-adapter status regression
Checks: focused 3/3 PASS; five-file 149/149 PASS, zero skips; affected eight-file 410 pass / zero fail / one inherited S3 native skip (411 tests, exit 0); full PG17 86/86 PASS, zero skips; check and check:demo PASS; ledger verification PASS. Migration lint NOT RUN successfully: Squawk missing from supplied cached PATH (exit 1).
Unresolved: MEDIUM-1. Spec lines 95/281 require launcher-only B8 Start independent of U83a, while the released B7 resolver requires settings.providerRoute, Start requires body.route, and provider mapping requires an installed provider/model. Spec lines 111–113/8.1 include Start, so unconditional deferral is not authorized. Need reviewed launcher-only admission contract or explicit deferral before dependent implementation.
MEDIUM-2 evidence: unchanged migration already blocks concurrent source insertion via the admission-to-source FK lock; explicit requested lock added and concurrency coverage retained. No false executable race red claim.
Qualification: no B8 Start dispatch qualification; prior broader/environment/native-worker/Linux/host-gate limits remain. No SELECTION-TO-START-GREEN claim. Cleanup: all command sessions completed; harness finally cleanup and owned workspace audit completed; final shared-memory count 2.
Status: BLOCKED: MEDIUM-1 launcher-only Start contract conflicts with released B7 resolver; Squawk unavailable; index.lock prevents commit
