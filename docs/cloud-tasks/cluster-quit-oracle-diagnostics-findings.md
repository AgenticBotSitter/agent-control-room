# cluster-quit-oracle-diagnostics evidence

Starting HEAD: f75660df89a32cd5d3b7824238746614d7fd8f3a
Implementation base: 9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3

Added unique SIGQUIT-before-SIGKILL existence assertions before both signal-log reads. Existing exact signal sequence, exit outcome, grace duration and socket cleanup assertions remain. Stub close promises are registered before readiness, setup failures kill and await the owned child, and both test finally blocks await close before removing scratch. Added adjacent comments documenting isAlive/short quitGraceMs as sandbox-oriented test seams and preserving default isPostmasterAlive custody. Comment-stripped transpilation matches the original helper exactly. An exact-one-match copied immediate-SIGKILL mutant fails both named ERR_ASSERTION checks (0 pass/2 fail), never ENOENT; both failure teardowns report owned close observed. Restoration gives 2/2 green. No native PostgreSQL was started.

All test/build commands used `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp CONTROL_ROOM_B5_ASSEMBLY_PG=0`. Node v22.23.4; provisioned dependencies only. Commands below ran serially in the task root, or its disposable copied graph for controls.

- quit-prereqs: `python3 ../cloud-build-evidence/prereqs.py cluster-quit-oracle-diagnostics`; exit 0; 0.101s; no test counts (non-test command).
- quit-baseline: `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^stopCluster' tests/disposable-cluster-quit-before-kill.test.mjs`; exit 0; 1.174s; # tests 2; # pass 2; # fail 0; # cancelled 0; # skipped 0.
- quit-focused: `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^stopCluster' tests/disposable-cluster-quit-before-kill.test.mjs`; exit 0; 1.143s; # tests 2; # pass 2; # fail 0; # cancelled 0; # skipped 0.
- quit-mutant-kill-first: `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^stopCluster' tests/disposable-cluster-quit-before-kill.test.mjs`; exit 1; 0.573s; # tests 2; # pass 0; # fail 2; # cancelled 0; # skipped 0.
- quit-restored: `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^stopCluster' tests/disposable-cluster-quit-before-kill.test.mjs`; exit 0; 1.232s; # tests 2; # pass 2; # fail 0; # cancelled 0; # skipped 0.
- quit-regression: `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/disposable-cluster-quit-before-kill.test.mjs`; exit 0; 1.189s; # tests 2; # pass 2; # fail 0; # cancelled 0; # skipped 0.
- quit-typecheck: `node_modules/.bin/tsc --project tsconfig.vps.json --noEmit`; exit 0; 11.965s; no test counts (non-test command).
- quit-helper-comments: `node ../cloud-build-evidence/check-helper.mjs`; exit 0; 0.228s; no test counts (non-test command).

Native gates stayed disabled; no native PostgreSQL, live service or real model was launched. No Linux-only required body remains: these commands are portable synthetic/embedded checks executed on macOS. Native qualification and configured privacy CI remain for integration. The VPS typecheck covers production, not most test files. Private-name checking without a configured list is SKIP, not a configured privacy pass. Copied mutants were restored byte-for-byte between controls and their graph removed; subprocesses ran to completion. No task-owned process remains.

Scans: allowlisted secret scan exit 0, findings 0; private-name guard exit 0 with configured=0/scanned=0 (SKIP); `git diff --check` exit 0. Only the allowlisted test/helper and evidence paths changed. No push performed.
