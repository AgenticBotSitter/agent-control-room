# F4 workspace focused remediation receipt

2026-09-08. Addresses the three reproduction/evidence findings in `f4-workspace-independent-review.md`; not an independent reviewer rerun.

## Corrected run

`f4-workspace-prepare.mjs` now refuses a missing/extra flattened source file, symbolic-link source, wrong length or wrong SHA-256 against the previously committed 72-file receipt **before copying any source**. It refuses an existing module directory. `f4-workspace-run.mjs` rechecks the prepared tree, exact Go module declaration and all upstream hashes before adding the clearly separate research fixture and compiling.

`f4-workspace-verify-test.mjs` directly exercised three negative cases, each child exit 1 with module directory still absent: wrong hash, missing file, extra file. All were restored before the positive prepare. These are synthetic verifier tests, not upstream tests.

The retained launcher passes a literal environment allowlist rather than inheriting `process.env`. It supplies an owned HOME/TMPDIR/cache, offline Go controls, fixed system Git PATH and disabled system/global Git config. No inherited GIT_DIR, WORK_TREE, INDEX_FILE, OBJECT_DIRECTORY, ALTERNATE_OBJECT_DIRECTORIES or CONFIG_PARAMETERS reaches the child. The actual Go test additionally asserts those variables are absent before creating the fixture. Existing synthetic identity, empty hooks/templates and credential-helper controls remain. This is environment isolation, not an OS network/process sandbox.

Direct `spawnSync` output/status is retained in `f4-workspace-recheck-evidence.json`: single actual `TestControlRoomOwnedPreservation` **passed**, exit 0, no signal/error, 7,912ms including compilation, 0.30s test / 0.510s package. Outer timeout is 60s including compiler; inner Go timeout is 40s. GOMAXPROCS=2, GOMEMLIMIT=256MiB, -p1, CGO disabled. No previous pure or fake-runner tests were repeated. Scope remains the actual Git snapshot/removal/restore/apply journey, not conflicts/restarts or the Control Room port.

## Acquisition and cleanup

Exact owned root: `/private/tmp/control-room-f4-workspace.bnHstI`. Initial free disk 140GiB. Reacquired exactly the 72 upstream paths/bytes/hashes and URL prefix in `f4-workspace-acquisitions.json`; no additional upstream source. Official Go URL, 58,034,655-byte archive and SHA-256 were the same as the original receipt; SHA-256 verified before extraction. Archive removed after extraction. Root before compile235MiB; after compile316MiB, below revised400MiB cohort cap. No module download, global toolchain installation, user-repository Git commands, providers or services.

Entire owned root subsequently removed and absence verified. Source and executable retention zero; only research scripts and sanitized evidence retained.

The outer timeout targets the Go driver; it is **not proven descendant-process-tree containment**. This run exited normally with status0 and no timeout/signal, including the fixture's wait for discard workers. A post-run `ps` check was denied by the sandbox (`operation not permitted`), so there is no independent process-inventory confirmation. Cleanup is based on the observed completed command and root-absence verification, not an assumption that a timeout kills every descendant. No process inventory is claimed.

## Earlier observations — transcribed, not direct retained capture

The earlier tool outputs were observed during the original run; the original closure report was narrative, not a persisted raw receipt. The following short excerpts are **transcribed from prior tool output**, not newly executed or independently captured:

```text
--- PASS: TestControlRoomOwnedPreservation (0.29s)
PASS
ok github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree 0.549s

--- PASS: TestCreateReusesRegisteredWorktreeAtExpectedPath (0.00s)
PASS
ok github.com/aoagents/agent-orchestrator/backend/internal/adapters/workspace/gitworktree 0.160s
```

Earlier pure/path test count and 0.216s package duration remain operator-recorded observations. The corrected directly retained run supersedes the reproduction limitations for the **single real-Git fixture only**, not all earlier tests.
