# b8-paid-cap-mechanism status
Phase: BUILD — CAP-A FIX only
Baseline: cook/b8-paid-cap 15431739ec5dddae885bc3fde29206342514c29c
Candidate: uncommitted CAP-A FIX worktree; git add exited 128 because index.lock creation was refused; lead must commit; no retry/escalation or commit attempt followed
Review input: NEEDS-FIX, HIGH 0 / MEDIUM 1 / LOW 4; all five findings locally addressed, independent CLEAN disposition pending
Completed: profile/mode-bound frozen ceilings; malformed resolution refusal; single admission per consumed capability; specification restored to fba6ae026; helper exports proposed for review in D16; independent literal digest expectations; committed reproducible guard mutations
Red-first: MEDIUM-1 0/1, LOW-2 1/8, LOW-3 0/1 pass/fail; intended behavioral defects observed before fixes
Checks PASS: paid-run wildcard 71/71 and affected usage/provider 63/63, zero skips; check and check:demo; loaders; quarantine 0 entries; whitespace
Guard probes: 14/14 killed; 70/70 green baseline and 70/70 restored after each mutation; no original source modified by probes
Lane coverage: exit 1, exactly 3 unregistered files (paid-run-admission, paid-run-bound, paid-run-guard-mutations); final package registration remains CAP-B
Not rerun: Vite build (prior dependency-symlink write refusal), product-shell/browser qualification, pinned Linux parity and independent reviews; earlier results are historical only
Pending: reviewer/lead disposition of D16 exports and independent CLEAN review of the fixed CAP-A candidate; CAP-B remains withheld
Production: paidExecutionReady=false; durable PG17 consent/ledger, owner endpoints, complete resolver, broker, reviewed provider profile and real-probe qualification remain later work
Owner questions: Q1/Q2 test-only cap/lifetime constants authorize no real spending
Cleanup: foreground checks completed; disposable test directories removed; no server, real model/provider or PG cluster started; node_modules remains its original unstaged symlink; no push or Git identity configuration change
Status: BLOCKED: git index.lock creation refused; lead must commit fixed CAP-A; CLEAN review still required before CAP-B
