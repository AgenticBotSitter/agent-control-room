# F4 — AO gitworktree dependency and lifecycle closure

Research only, 2026-09-08. AO pin `24e101914976a14145d7302f49626db3541ef8b5`. Control Room task base `fd03365`. No application changes, GitHub writes, agent calls or production effects.

Follow-up: `f4-workspace-recheck.md` records exact hash guards, an explicit launch environment and directly retained stdout/exit from one corrected real-Git rerun. Original results below are historical operator observations; do not treat all of them as direct persisted receipts.

## Decision

AO remains a strong **worktree lifecycle implementation donor**, not a drop-in replacement for Control Room's authority/lease manager. Its preservation, conflict retention and stale registration recovery are substantive implementations, rather than README claims. Narrow compilation succeeded offline, followed by an actual isolated Git preservation round trip. No claim of integrated Control Room acceptance.

## Exact dependency closure

The selected backend package imports local `internal/domain`, `internal/ports`, `internal/gitdefault`, `internal/process`, and transitively `pkg/contract`. The 72-file acquisition receipt enumerates exact paths and SHA-256 values. All applicable Darwin files in this closure import only standard library or these local packages. Windows alone additionally needs `golang.org/x/sys/windows` from its build-tagged process helper; Windows compilation has not been attempted.

The upstream module declares Go 1.25.7. Full-backend database, terminal and websocket dependencies are not necessary for this narrow package. A disposable module retained the original module name and Go version, copied source files unchanged, and omitted unrelated module requirements. This is a **research packaging adaptation**, not proof that the entire backend has no external dependencies. No module downloads occurred.

## Source findings and safety corrections

- `Options` exposes Binary, ManagedRoot, RepoResolver and Logger. Command injection is the private same-package `Workspace.run` field, **not a public Options seam**.
- A fake `Workspace.run` is not a process fence. `StashUncommitted` executes temporary-index `git add -A` and `git write-tree` through `process.CommandContext`; cherry-pick does likewise. These require separate real-Git fixture review.
- `New()` immediately sweeps its `.discarded` directory in background goroutines. It must receive a newly-created owned managed root. It is not an inert constructor against arbitrary paths.
- `StashUncommitted` rejects stale/unregistered managed paths; uses temporary Git index, commit-tree and `refs/ao/preserved/<session>`; ignored files are not included. `ApplyPreserved` uses a three-way no-commit cherry-pick; conflict preserves the reference and markers; success removes the preserved reference.
- ForceDestroy deliberately bypasses dirty refusal. Its caller must first authorize preservation/deletion; it must never be mapped to closing a UI view. Normal Destroy detects dirty state after moving aside and restores the path on refusal. Reclaim distinguishes removed and already absent.
- Upstream preservation/reclaim tests use bare-origin/seed/push/clone helpers. They were read, **not run**, because this scope excludes remotes and clone even on local disk.

## Executed evidence

1. Existing Control Room test: `node --import tsx --test --test-name-pattern='Codex workspace lifecycle' tests/codex-harness-contract.test.ts` — **1 passed**, fake port, about 201ms. Not real Git.
2. Official Go 1.25.7 darwin-arm64 archive, 58,034,655 bytes, SHA-256 `ff18369ffad05c57d5bed888b660b31385f3c913670a83ef557cdfd98ea9ae1b`; checksum matched official go.dev metadata before extraction/use.
3. Unchanged selected upstream tests `TestCommandArgs` (10 subcases), `TestConfiguredBaseRefCandidates`, `TestParseWorktreePorcelain`, `TestManagedPathSafety` — **4 top-level tests passed**, package execution 0.216s. These are argument/parser/path tests, **not a fake-runner lifecycle test and not actual worktree operations**. Selected package compiled with all upstream test files present but only this exact regex ran.
4. New `TestControlRoomOwnedPreservation` — **1 passed**, actual Git 2.50.1 and unchanged AO implementation, 0.29s test / 0.549s package. Proved dirty Destroy refusal, tracked/untracked snapshot, ignored-file exclusion, ForceDestroy, Restore, ApplyPreserved, successful reference deletion and empty remote list. This is an adapted research fixture, **not the unchanged upstream integration test**; it replaces the upstream remote/clone fixture with an empty local `git init`. It does not test conflicts, stale registration, branch contention, immutable revision binding or a Control Room-to-Go protocol.
5. Unchanged `TestCreateReusesRegisteredWorktreeAtExpectedPath` — **1 passed**, fake runner, 0.160s package. This covers existing registered path reuse, not actual Git execution. Its runner fails unexpected commands; direct preservation/cherry-pick paths are not entered by this selected test.

For steps 4/5 the same isolated environment and exact-name regex were used. Real fixture additionally applied `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, process-local config overrides for empty owned hooks/templates and empty credential helper, plus synthetic author/committer environment identity. Initial fixture commit used that synthetic environment (not a persisted identity configuration). It did not invoke any remotes. The private runner refused fetch/clone/push/remote attempts; separately inspected direct Stash/Apply subprocesses remain outside that private runner's guard. No claim of a general process sandbox. Fixture paths were newly-created under owned TMPDIR; constructor sweep saw a new root only.

Command: absolute isolated Go binary, `go test -p 1 -timeout 40s ./internal/adapters/workspace/gitworktree -run '^(TestCommandArgs|TestConfiguredBaseRefCandidates|TestParseWorktreePorcelain|TestManagedPathSafety)$' -v`. Environment: `GOTOOLCHAIN=local GOENV=off GOPROXY=off GOSUMDB=off GOWORK=off GOMAXPROCS=2 GOMEMLIMIT=256MiB`, owned GOCACHE/GOMODCACHE/TMPDIR. This Go timeout limits test execution, not compiler wall time; the command completed before a 60-second intervention was needed. Native Git version is Apple Git 2.50.1; upstream comments reference some recovery behavior checked at 2.54, so that remains a platform comparison, not assumed equivalence.

## Resource limit disclosure

140GiB disk was available beforehand. Archive plus extracted source/toolchain measured 291MiB; verified archive removed before compilation. First compilation cache grew to 81MiB, making the cohort **317MiB**, exceeding the approved 300MiB cap by 17MiB. Further Go commands stopped on detecting this; the owned compiler cache was removed to restore the bound (237MiB). This is a resource-control miss, not hidden passing evidence. Root subsequently revised the internal cohort cap to 400MiB under the unchanged global 4GiB and 20GiB-free limits. Disk remained 140GiB free; the only matching known Control Room temp cohort was this 237MiB root. New tests 4/5 then ran and peak remained 317MiB. Successful pure tests were not repeated. Source/toolchain/cache and all fixtures were subsequently removed as recorded in the acquisition ledger.

## Fit with actual Control Room

`src/harness/codex-v1/workspace.ts` has a 108-line manager and `CodexWorkspacePortV1` abstraction, not the AO preservation implementation. It requires a fixed 40-character revision, detached worktree, disjoint physical roots, run-derived path, observed revision, device/inode identity and exact active lease for removal. The active map is in memory. Existing tests prove that fake-port contract, not restart durability or physical Git behavior.

AO instead creates branch/session-oriented workspaces and reports Path/Branch/BaseRef/SessionID/ProjectID/RepoPath. It does not supply Control Room's immutable revision/device/inode/attempt lease guarantees. Keep those guarantees and the PostgreSQL authority. A Go helper/adapter could supply lower-level operations, but IPC/build/package maintenance and explicit lease-preservation mapping are genuine integration costs.

Estimated next implementation experiment (not approved production work): 1–2 engineer-days for a narrow sidecar protocol and detached-worktree adapter proof, then 1–2 days for lost-response/restart/identity and preservation tests. This estimate excludes cross-platform packaging. There is **no presently justified deletion count**: Control Room's lease manager remains, and its current seam does not already contain an equivalent 2,000-line preservation engine to remove. Avoiding future duplicate Git algorithms is the primary reuse saving. Porting a few selected algorithms may have lower operational cost than importing AO's complete daemon, but requires comparative evidence before selecting that route.

## Next decisive experiment

The empty-local-repository round trip is now done. Next extend it to conflict retention, stale/duplicate/restart registration and branch ownership, then connect the actual Control Room port to a narrow helper while retaining lease/commit invariants. Repeat ambient Git isolation and owned-root safeguards. Actual filesystem replacement and crash/restart acceptance remain unproven until those tests run. Do not reject AO on the basis of tests that have not yet been run; compare the helper packaging cost against a narrowly adapted donor implementation first.
