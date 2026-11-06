# b8-selection-to-start status
Phase: BUILD — U81-B round 10
Base: cook/b8-selection-u81b b671cccbdf91e0ab56fef039cba4c47e26455548
Candidate: HEAD plus retained uncommitted B1b/B2 implementation; no commit created (index.lock refused)
Spec gate: lead round-10 continuation; D33 review HIGH 0, D34/D35 amendments recorded
Budget: 2026-11-06T10:34:06.501731+00:00, deadline 2026-11-06T16:34:06.501731+00:00, elapsed 117.9 minutes
Completed: integrated B8 admission, readiness/provenance, immutable exactly-one-to-one admission table/native backfill, deferred reverse FK, compatible rollback, count/grant/pin updates; B2a status regression and historical raw-draft-key refusal
Checks: final five 147/147; latest full PG 84/86 (two IPC-precheck refusals); focused bridge 4/4; exact P72 1/1; native 44/44; UI 52/52 PASS. Final affected eight {'tests': 408, 'pass': 407, 'fail': 0, 'skipped': 1}. Broad {'tests': 941, 'pass': 935, 'fail': 1, 'skipped': 5}; stable production {'tests': 118, 'pass': 86, 'fail': 32, 'skipped': 0}; boundary 2/11. Full results/limits in evidence and R10 report.
Reviews: exact built-head Crouton then DeepSeek pending after lead commit; no independent CLEAN claim
Pending qualification: named failing/missing gates, full host, Linux parity and separately authorized worker/device proof
Owner questions: none new; rollout precondition and prior questions unchanged
Next action: lead commit/reviews and resolution or qualification of the explicitly retained gate failures
Cleanup: all owned foreground commands returned; disposable PG cleanup and owned-cluster audit completed; no real worker/provider or live-install operation
Status: BLOCKED: broader/environment qualification gates fail; index.lock prevents commit
