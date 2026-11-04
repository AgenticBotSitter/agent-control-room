# b8-paid-cap-mechanism status
Phase: BUILD — CAP-B stopped on specification/code contract gap
Baseline: cook/b8-paid-cap cc81268c9dfbe35a72fe7f00fbf8e59794b1ab5f (reviewed CAP-A CLEAN)
Candidate: uncommitted package registration and evidence/status only; no new commit
Spec gate: reviewed r3; this continuation requires a reviewed recovery-authority clarification
Budget: six-hour limit; stopped early on explicit brief/spec mismatch rule; handoff updated 2026-11-04T21:45:07.002954+00:00
Completed: all three CAP-A tests appended to test:product-shell; temporary red-test scaffold removed; no product code changed
Blocker: spec T5 requires parent reopening after killing the ledger-owning child, but open(admission) requires authentic exact consentId binding; CAP-A uses random consent IDs and process-local private authority maps with no recovery API
Proof: real child/parent entry-point probe passes five assertions (same run/pin, different consentId, serialized child unbranded, parent authentic); child exited and reaped
Checks PASS: existing paid-run wildcard 71/71 zero skips/cancellations; all 14 CAP-A mutations killed with green restores; lane coverage all 934 files; loaders; quarantine 0 entries; whitespace
Not run after mandatory STOP: CAP-B suites/driver/attacks, affected usage/provider, full product-shell, check/check:demo/build, candidate independent reviews and Linux parity; private-name guard unconfigured
Reviews: inherited CAP-A CLEAN; R2 malformed-context LOW remains; registration advisory addressed; no CAP-B review verdict
Pending qualification: all CAP-B gates; PG17 production ledger/consent, broker/profile/endpoint/native paid checks remain separate future work
Owner questions: Q1/Q2 remain test-only; no production spending authorized
Next action: lead-reviewed recovery/report-only reopen or trusted reconstruction contract; lead commit of retained changes because index.lock refused
Cleanup: owned foreground checks/children completed and reaped; no cluster, listener or provider launched; node_modules unchanged/unstaged; no push
Status: BLOCKED: T5 cross-process journal reopen lacks a trusted admission recovery contract; git index.lock creation refused
