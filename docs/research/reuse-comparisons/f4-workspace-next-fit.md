# RC4 AO worktree conflict, stale state and immutable-revision fit

2026-09-08. AO pin24e101914976a14145d7302f49626db3541ef8b5.
**One new real-Git scenario passed**, covering previously unexecuted lifecycle
boundaries. AO preserves actual conflicts, reuses registered state across a new
Workspace object and repairs stale registration. It still does not implement CR's
detached immutable-revision/physical-lease contract: actual Restore accepted an
advanced attached branch while returning the originally supplied BaseRef metadata.

## What was not repeated

Read prior f4-workspace closure, recheck, acquisition and direct evidence first.
Did not rerun the earlier writer/preservation success path, four pure argument/path
tests or fake-runner registered-path case. New fixture derives its safe local Git
setup from the previous reviewed fixture but tests conflict, actual duplicate/stale
state and revision mismatch, not the prior successful preserve/apply round trip.

## Actual source and bounded execution

Same72 upstream files and exact hashes reacquired from the prior acquisition manifest.
The actual unchanged gitworktree package and local stdlib-only dependency closure
were compiled offline. Official Go1.25.7 darwin-arm64 archive checked against prior
verified SHA256 ff18369ffad05c57d5bed888b660b31385f3c913670a83ef557cdfd98ea9ae1b;
archive removed before compilation. No Go module downloads, new global toolchain,
package scripts or updated upstream source.

`f4-workspace-next-run.mjs` rechecks all prepared source hashes/exact inventory before
adding only `f4-workspace-next_test.go`. Actual `Restore`, `StashUncommitted`,
`ApplyPreserved`, worktree registration parsing and native Git subprocesses execute.
No fake command results. Private runner refuses remote/fetch/clone/push; direct
preservation/cherry-pick subprocess paths were already inspected and remain outside
that private guard. Sterile environment removes ambient Git variables, system/global
config, credential helpers, hooks/templates and author identity; synthetic identity
is process-local. No user repository, Git remote, SSH, provider or application change.

One Go test, -p1, inner40s timeout, GOMAXPROCS2/GOMEMLIMIT256MiB, outer60s/1MiB output
bound. Completed first execution exit0, no signal,8,265ms including compilation;
test0.47s/package0.692s. No focused repair needed. Source review corrected a namespace
reference before first execution; no failing run was hidden. Direct stdout/status
is retained in `f4-workspace-next-evidence.json`.

## New actual behavior

| Scenario | Observation | Exact scope |
|---|---|---|
| Restore from explicit full40-character commit | Initial worktree HEAD matches that commit | Real local Git; branch-attached creation, not detached. |
| Same session restore after constructing another Workspace | Reuses same registered path | Loss of prior object state, not process crash/reboot or durable CR lease restore. |
| Same branch requested at another session path | ErrBranchCheckedOutElsewhere | Existing branch-contention refusal, not concurrent-race/process locking qualification. |
| Owned worktree directory removed but registration retained | Stash refuses ErrWorkspaceStale; Restore recreates path with original HEAD | Actual stale registration recovery, no user directory removal. |
| Preserve B-over-A then stage C-over-A and apply | ErrPreservedConflict; conflict markers and preserved ref remain; HEAD staysA | Actual three-way merge, not simulated conflict or guaranteed manual resolution. |
| Existing branch advances toD; Restore supplied original BaseRefA | Succeeds, reports BaseRefA, but observed HEAD remainsD | Negative fit for treating BaseRef as proof of immutable revision. Normal branch-oriented semantics, not an upstream bug. |

All repositories were disposable; empty remote list asserted. Worktree directories
were initialized below a fresh managed root so constructor discard sweep could only
see owned fixture data. Cleanup waits for discard workers; no general kill-tree or
network sandbox claim. Entire Go fixture root is removed by test cleanup.

## Mapping to the actual CR lease contract

`src/harness/codex-v1/workspace.ts::CodexWorkspaceManagerV1.prepare` requires:
full40-character commit; physically disjoint canonical repo/workspace roots; direct
run-derived checkout path; actual detached-worktree port; matching observed HEAD;
device/inode identity; active lease digest covering run/path/revision/physical identity.
Cleanup verifies exact active lease and physical identity before remove.

AO's `ports.WorkspaceConfig` ProjectID/SessionID/Branch/BaseRef and WorkspaceInfo
Path/Branch/BaseRef/RepoPath can provide mapping inputs, but not equivalent evidence.
Its normal layout is project/session subdirectories rather than CR's direct
run-derived child. The new actual mismatch proves that returning AO BaseRef as CR
headRevision would be incorrect. Mapping ProjectID/SessionID from canonical IDs does
not grant an active lease or manufacture device/inode observations.

Reconstructing AO discovers Git registration; CR's manager active map is in memory
and does not automatically accept an old lease after reconstruction. That is a
specific integration/restart gap, not permission to remove active-lease checks.
Root must decide whether a reviewed adapter can use AO operations under the current
detached/path contract, or whether borrowing only preservation/recovery helpers is
the smaller honest reuse. No sidecar protocol, new lease/security rule or workaround
was authored in this packet.

## Narrow recommendation and alternatives

AO remains a viable donor for substantial actual preservation/conflict/stale handling,
not a drop-in CR workspace port. Prefer reusing these mechanics over recreating them
when this user outcome is needed. Keep existing manager/identity checks; **zero current
production lines eligible for deletion** from this experiment. Retaining current
port and adding a small reviewed direct-Git implementation is the strongest low-process
alternative, but that would carry new lifecycle implementation instead of AO's tested
machinery. Count Go binary/IPC/distribution and detached adaptation, not whole AO backend.

Decision-changing local evidence now exists for conflict/stale/duplicate-object behavior.
Still unproven: true process restart/lost response, concurrent operations, alternate
Git versions/Windows and the actual CR port mapping. The next mapping requires root
design rather than another fake sidecar benchmark. Prior1–2day adapter plus1–2day
recovery estimate remains an estimate, not measured implementation effort.

Judgment0–5 (higher better): preservation/conflict reuse fit4–5; unchanged CR immutable
port fit1–2; adaptation ease2; custom lifecycle avoided4 if compatible narrow scope is
chosen. Production runtime/maintenance cost unknown, no weighted universal winner.
Do not declare RC4 complete or authorize destructive operations based on these tests.

## Acquisition, resource coordination and cleanup

Source/toolchain URLs and hashes recorded in f4-workspace-next-acquisitions.json.
Free space stayed above20GiB, cohort below400MiB and shared cap4GiB. Coordinated with
the staging agent to avoid concurrent Go/Vite compilation; it had not started heavy
work and resumed only after this process returned. No parent-owned source touched.
Final measured footprint and exact-root cleanup disposition appended below.

Final allocation322,984KiB (about315.4MiB). Exact owned root
`/private/tmp/control-room-f4-workspace.MyR4g2` removed after normal command completion;
absence test exit0. Toolchain, source, compiler cache and disposable Git data removed,
recoverable from logged public pins. No independent OS-wide process inventory claimed;
normal test return, awaited discard workers and root absence are the cleanup evidence.
