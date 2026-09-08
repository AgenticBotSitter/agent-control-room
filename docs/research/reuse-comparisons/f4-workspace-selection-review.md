# Independent workspace responsibility selection challenge

2026-09-08. Source-only review of root's proposed selection, current
`src/harness/codex-v1/workspace.ts`, its actual contract-test call sites, F4 teamwork
dossier, workspace next-fit/root review and direct real-Git receipt. No tests,
downloads, Git operations or application changes. Root retains architecture and
selection authority; this review does not close RC4.

## Findings requiring bounded wording clarification

**P2 — distinguish optional automation from required preservation/recovery.** The
proposal calls preservation/conflict/stale mechanics “optional” and selective
helpers useful “once that feature is required.” RC4 closure explicitly requires
workspace mapping with conflicts, stale state, restart and duplicate ownership.
The proposed acceptance paragraph includes dirty preservation/restart but not an
equally explicit disposition for conflict recovery. State that no-loss/refusal,
stale/restart reconciliation and conflict evidence remain required for RC4; only
automatic stash/merge/conflict-resolution features may be optional. Otherwise a
narrow initial-checkout choice could silently become a broader completion claim.
This correction need not add implementation or rerun unchanged AO tests.

**P3 — do not charge a separate Go runtime to the strongest selective alternative.**
“No Go runtime distribution” implies an extra installed runtime that a compiled Go
helper does not necessarily require. Count an additional per-platform executable,
build/update/distribution and reviewed invocation/IPC boundary. The proposal
already correctly avoids charging the full AO application cost to a selective
helper. Preserve that fair comparison; source language itself is not rejection.

## Source-backed parts of the proposal

Search `src`/`tests` for `createDetachedWorktree`, `CodexWorkspacePortV1` and
`new CodexWorkspaceManagerV1` finds the interface/manager plus injected test ports
in `codex-harness-contract.test.ts:1589–1607`. No concrete production port was
found in that scope. This establishes a named missing adapter, not a proven
workspace runtime or absence of every other Git operation in the repository.

Manager prepare validates full commit, canonical disjoint roots, direct hashed
run child, returned repository/path/HEAD and physical identity. Its active map is
in memory. It checks duplicate run identity before asynchronous inspect/create;
this alone is not serialized concurrent preparation. After creation a failed
identity check throws without automatic cleanup/journal adoption. The proposal
correctly retains both as unfinished cases rather than selling the manager as
crash-safe. Detachment itself is an expectation of the named port, not a separately
returned/asserted property in the current manager; actual adapter qualification
must verify detached state instead of assuming HEAD equality proves it.

The real-Git next receipt records one passing scenario with branch advancement,
conflict, stale registration and sequential object reconstruction. AO accepting
advanced attached HEAD D while returning requested BaseRef A is consistent with
its branch semantics. Mapping BaseRef into CR's observed headRevision would be
incorrect. That concrete mismatch and the nested path contract justify rejecting
**unchanged Restore as this exact port**, without rejecting AO preservation reuse.
The receipt is not concurrent race, actual process-crash, Windows or full CR-port
evidence. Earlier preservation success and the new conflict evidence remain useful
and should not be rerun merely to increase comparison counts.

## Strongest alternatives and limits

Native Git already implements detached worktree creation; a bounded wrapper is
reuse of that existing implementation, not necessarily a new worktree engine.
Nevertheless process boundaries, ownership journal mapping, lost acknowledgments,
physical readback and safe deletion are real new CR-specific work. “Small” remains
a proposed scope limit, not measured effort or a completed adapter. The proposal
properly lists these costs, zero production deletion, no schema selection and
reopening AO if preservation complexity expands.

AO's actual selected stdlib/local-internal helper remains a serious alternative:
its restore/stash/apply/conflict mechanics are exercised, and it need not include
the desktop, database or entire application service. Adapting detachment/path
after Restore introduces further effect/recovery boundaries; translating Go
algorithms to TypeScript would also be newly maintained code. Neither a new
sidecar benchmark nor an additional generic candidate search is necessary to
recognize that responsibility tradeoff.

Subject to the two clarifications, the narrow initial-checkout proposal has a
specific reason for CR glue and does not justify rewriting AO's preservation
framework. Actual manager-to-Git acceptance and the remaining RC4 recovery/conflict
mapping must still run before implementation is called finished. No final policy,
deletion or production integration is approved by this review.

## Focused correction disposition

Re-read the current proposal after root's correction. P2 is addressed: the opening
selection now explicitly retains required dirty-work/conflict/stale/restart/duplicate
no-loss and recovery coverage, distinguishing automatic repair from those duties.
P3 is addressed: the cost paragraph explicitly permits a compiled Go helper without
a separately installed Go runtime, and counts per-platform build/distribution,
update and invocation/IPC instead. Original findings remain above for provenance.

No further decision-changing gap found for the **narrow initial-checkout
responsibility choice**. Actual observed AO branch/path mismatch supports not
adopting unchanged Restore as this port; native Git plus existing validation is a
defensible smaller initial boundary. This does not demonstrate the proposed
adapter, quantify a total effort advantage or close RC4. Preserve detached-state
readback, failure-after-create ownership and concurrency/recovery limitations from
this review in the implementation acceptance packet. Root makes the final choice.
