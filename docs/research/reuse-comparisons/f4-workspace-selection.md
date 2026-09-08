# Workspace responsibility selection — root proposal for challenge

2026-09-08; inspected current `src/harness/codex-v1/workspace.ts` at base
`2fb66d7`, real-Git AO evidence in `f4-workspace-next-fit.md` and its receipts.
This is a proposed narrow decision, not final independent acceptance or a claim
that the workspace implementation is finished. No new Git operations ran here.

## Proposed choice

Keep `CodexWorkspaceManagerV1` for canonical identity and lease validation. Do not
replace its three-operation port with unchanged AO `Workspace.Restore`. Reuse
native Git's detached-worktree operation through a small bounded adapter for the
required initial checkout responsibility. Do not build a new worktree engine.

AO remains the preferred evaluated donor for automatic stash/merge preservation
mechanics when integrating those specific responsibilities. No-loss handling of
dirty work, conflicts, stale state, restart and duplicate ownership remains required
in RC4; it is not deferred by calling automatic repair optional. That is not authority
to copy its whole service or immediately add Go/IPC. Preserve the actual AO
behavior as regression scenarios even if no AO source is shipped initially.

## Why the competing interface does not fit unchanged

The actual AO real-Git experiment returned originally requested BaseRef A after
the attached branch advanced to D; observed HEAD was D. That is correct for its
branch-oriented design, not evidence of a defective implementation. Control Room
requires observed HEAD equal to the admitted full commit and a detached checkout.
AO also chooses project/session nested paths; CR chooses an exact direct child
derived from canonical run identity. Neither AO BaseRef nor registration alone
supplies the CR physical device/inode or active lease.

Wrapping AO with an additional `git checkout --detach` would mutate after AO's
own restore operation and require new partial-failure/recovery handling. Relabeling
its BaseRef as observed HEAD is not adaptation. Replacing the CR lease contract
solely to accept that output would replace application authority for no required
user feature. These concrete differences, not ecosystem unfamiliarity, justify
excluding unchanged AO Restore from this particular port.

## What is and is not already implemented

The current manager validates identities and uses an in-memory active-lease map.
Search of `src` and `tests` finds its interface/manager and contract-test injected
ports, not a concrete production `createDetachedWorktree` implementation. Therefore
this proposal retains validation code, not a claimed working native workspace.
Crash recovery, concurrent preparation and post-create verification failure are
still implementation cases. Do not infer persistent ownership from this map.

## Exact scope and comparative cost

| Route | Required changes | Avoided machinery / remaining cost |
| --- | --- | --- |
| Native Git plus existing manager (proposed) | Add concrete inspect/create/remove adapter and its bounded process boundary; verify real HEAD, canonical paths and physical identities; integrate existing journal for recoverable ownership | No added Go executable packaging or general sidecar protocol. New CR-specific admission/recovery glue remains and must be reviewed. Git handles worktree semantics. |
| AO whole workspace port | Go packaging/IPC, path translation, detached-commit adaptation, actual identity readback, ownership reconciliation, error mapping and cross-language tests | Reuses tested preservation/conflict mechanics but does not eliminate the CR-specific checks or journal. No measured total effort advantage yet. |
| AO selective helpers | Pin/copy or invoke only needed preservation/conflict operations, preserve license and source notices, audit imported subprocess closure | Useful only once that feature is required; translation to TypeScript would be new implementation, not unchanged proven code. |

Production deletion: zero. No schema migration is selected by this narrow choice.
An AO Go helper can ship as a compiled executable; this does not require installing
a separate Go runtime on each worker. Count platform builds, distribution, updates
and IPC, not an invented mandatory runtime service.
Existing estimates of AO adapter/recovery days remain estimates, not measured
effort. No comparative throughput, steady memory or Windows qualification exists.
The retained tests used actual AO source and Git, not a whole running AO service;
its entire service overhead cannot be attributed to a selective helper without
measurement. Candidate licenses and exact imported closure must follow the prior
AO dossier when any code is actually selected for shipment.

## Implementation acceptance, not another candidate census

Use an owned empty repository and actual Git to exercise the proposed adapter
through the unchanged manager: detached exact HEAD, duplicate preparation,
path/physical identity change, branch advancement, failed create/readback,
preserved dirty work, lost response and restart reconciliation. Verify rejected
or uncertain operations never remove an unowned directory. Cleanup acts only on
the recorded checkout; no broad prune/reset. Actual process/OS behavior remains
per-platform qualification; a fake port cannot establish it.

Reopen AO adoption if required preserved-work recovery materially expands the thin
adapter, upstream provides an exact detached/path interface, or actual integration
cost defeats this comparison. Do not quietly grow a custom stash/merge/preservation
framework under the initial checkout choice. Independent review must challenge
whether the proposed scope really stays thin before this becomes a settled DR.
