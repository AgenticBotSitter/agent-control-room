# b8-paid-cap-mechanism status
Phase: BUILD — CAP-B round 2 implementation and local checks complete
Baseline: cook/b8-paid-cap b973364ab035ae29ef3ea51f3773dade5978cbcf
Decision: lead D17 settlement-only recovery; spec amendment only in section 7.2 T5, pending independent review. Existing CAP-A D17 cache-profile content preserved under D19.
Completed: durable journal/exclusive lease/replay; one bounded executor; Stop/deadline/stream/identity/usage; request snapshots/full replay identity; no-authority settlement-only recovery; scripted provider/driver; residual CAP-A malformed-context LOW-1; product-shell registration.
Behavioral proof: 131/131 pass with zero skips/cancellations; true child SIGKILL at reserve/dispatch/settle retains 0 / 6M uncertain / 2.7M settled and no spending authority; parent independently derives trusted run/pin, mints no consent. Twenty contenders yield exactly three cap winners and seventeen refusals; independent concurrency high-water 2.
Guards: all 22 mutations killed; every restore green (71 CAP-A and 60 CAP-B), zero skips.
Other local checks: usage/provider 63/63; product-shell 707 tests / 704 pass / 0 fail / 3 inherited Chromium layout skips; self-check 2 assertions and zero sends; check/check:demo; loaders; 936 reachable tests; quarantine 0; whitespace; 13-assertion custody audit PASS.
Build: default Vite pre-config cache write through symlink is denied; exact npm run build PASS with a worktree-only environment/preload supplying runner loader and cacheDir under .test-tmp. No tracked config/build/dependency changes.
Pending: independent code/attack/CI and D17 amendment reviews; supplied pinned Linux parity; painted browser layout (Chromium not provisioned in allowed scratch). No BUILD-READY or CAPPED-PAID-RUN-GREEN claim.
Runtime: Node v22.23.4, darwin arm64; no Linux qualification claimed.
Production: paidExecutionReady remains false; no real paid calls, endpoint/broker, PG ledger or migration. Q1/Q2 test-only.
Custody: git add exited 128, index.lock creation refused. No retry/escalation/commit command reached; all fourteen allowed files remain uncommitted for the lead. New SHA none; retained HEAD b973364ab035ae29ef3ea51f3773dade5978cbcf. Dependency symlink excluded; no push or identity config edit.
Cleanup: foreground commands complete; checkpoint/mutation children killed or exited and reaped; resource cleanup test passes; no owned cluster/listener/provider. Native PG not started because ipcs was denied (pipeline printed zero is not a qualifying count).
Status: BLOCKED: git index.lock refused; independent reviews and pinned Linux parity pending; painted browser layout unverified
