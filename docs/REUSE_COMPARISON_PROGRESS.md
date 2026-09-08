# Reuse comparison progress and plan of attack

2026-09-08. Local research checkpoint; application behavior unchanged.

## Direct answer

We have the remaining-outcome map and the candidate comparison program. We do
**not** yet have completed, equivalent integration evaluations of every viable
candidate. Some actual upstream code now crosses real Control Room interfaces;
other options have only code-level inspection or isolated module tests. No final
all-outcomes implementation plan or percentage-complete claim is justified yet.

The [26-outcome map](REMAINING_WORK_REUSE_MAP.md) defines scope. The
[comparison program](REUSE_COMPARISON_PROGRAM.md) defines the method, candidate
coverage, decision rules, resource authorization and two goal prompts. The
[machine-readable index](research/reuse-comparison-index.json) tracks open families.
All outcomes remain comparison-incomplete until their decisive work is closed;
that does **not** mean all their application code is missing.

## What the deeper comparison has established

| Responsibility | Candidate comparison and current evidence | Decision-changing work still needed |
| --- | --- | --- |
| Queue, scheduling, continuous work | Existing pg-boss integration versus actual DBOS package and Hatchet source. DBOS supports transactional admission worth comparing; its PGlite migration attempts failed. | Disposable real-PostgreSQL shared cases; current Hatchet interface; actual recovery/schedule and migration cost. PGlite failure is not proof of a PostgreSQL incompatibility. |
| Agent execution and files | Actual published Codex SDK stream passed through our existing result decoder/projector; selected Python RPC methods exercised. Prior Hermes file retrieval and Herdr experiments remain scoped evidence. | Full supported transport/session comparison, Hermes lifecycle/file-to-project bridge, uncertainty and cancellation. No native agent qualified by these synthetic tests. |
| Project/session/conversation UI | Actual Desktop component and WebUI helper/action code mounted through protected Control Room project reads in Chrome. Composite identity and logout cache glue were necessary; Desktop keyboard focus needs adaptation. | Review's delayed-response ordering finding was corrected; 17 browser checks now record held 200 with two projects, later 401 and exact-response release without label resurrection. Full transcript/list, mobile/CSS and complete keyboard comparison still open. |
| Multi-agent discussions and coding workspaces | Actual Hermes durable/planner code: 13 checks; Maestro durable writer: 6 checks. Different duplicate semantics observed. Hermes full room policy requires a tool absent from current tools-disabled Idea driver. | Pure Hermes planner-to-existing-coordinator mapping, discussion semantic parity, Maestro complete delivery and Agent Orchestrator worktree integration. Do not silently cut current discussion limits to match an upstream planner. |
| Owner custody and independent integrity | Prior ssh2 scoped evidence plus actual etcd/OpenBao code and tests inspected. etcd WRITE also permits delete; OpenBao has separate policy paths. | Shared real-service contention, lost response, restart/restore and split-commit cases; actual owner custody is a separate live gate. Neither service's installation proves independent recovery. |
| Installation and rolling updates | WinSW stop/restart/source tests inspected against Task Scheduler and current OS templates. Personal logged-in agents and dedicated service accounts are different deployment contexts. | Actual inert lifecycle/update evidence on supported platforms. Historical templates are not installers; restarting a one-task command does not make a continuous worker. |
| ABS/news and later content packs | Attributed Control Center modules already integrated. Existing collector/research journeys should be reused, not rebuilt. | Reconcile prior evidence against exact current workflow; compare candidates only for uncovered needs; complete provenance, repeat collection and result mapping cases. |
| Login, backup, monitoring and acceptance | Actual Kuma condition code exercised. Beszel is complementary metrics. pgBackRest restores cluster-level physical state, unlike the immediate dedicated-database logical-restore requirement. Access remains current login direction. | Protected health and real disposable restore including restricted roles/rows/artifacts; metrics/resource evidence. Production configuration remains separate. |
| Licensing and contributor delivery | Exact candidate pins and acquisition receipts; some dependency inventories and existing Apache notices. | Trace selected shipped files, dependencies and assets, redistribution notices, migration/removal and economical release checks. A root license alone is not clearance. |

Evidence details: [F1](research/reuse-comparisons/f1-queue-fit.md),
[F2](research/reuse-comparisons/f2-codex-interfaces.md),
[F3](research/reuse-comparisons/f3-mounted-fit.md),
[F4](research/reuse-comparisons/f4-durable-comparison.md),
[F5](research/reuse-comparisons/f5-checkpoint-comparison.md),
[F6](research/reuse-comparisons/f6-supervisor-fit.md),
[F8](research/reuse-comparisons/f8-operations.md).
These are feature-specific observations, not whole-product reliability rankings.

## How we close the comparisons

1. Give every remaining responsibility a row containing all known relevant candidates,
   the existing implementation and the smallest new-adapter alternative. Record
   targeted searches for uncovered gaps. No claim to have found every Internet repo.
2. Inspect immutable implementation, upstream tests, dependencies and license scope.
   Eliminate candidates only for a documented decisive mismatch, not a README impression.
3. Run each viable decision-changing finalist through the same real application seam
   with disposable data. Compare duplicates, permission expiry, disconnect/restart,
   incomplete results and cleanup as applicable—not just a successful demonstration.
4. Measure the complete integration cost: changed code, removable code, new processes,
   state/migration, resource use, fork maintenance and upgrade exposure. Unknowns stay
   unknown. Working existing code is a real comparison option, not a sunk-cost veto.
5. Independently challenge the preferred choice and strongest alternative. Fix and
   recheck test-fidelity findings before using a pass as decision evidence.
6. Finalize `REUSE_IMPLEMENTATION_PLAN.md` only after decisive local comparisons close.
   Map every outcome to adopt/adapt/retain/remove, exact versions/files, large build
   packets, parity/migration tests, rollback and separately listed live gates.

## Intended substantial implementation batches

The delivery order is stable; exact component selections remain provisional:

1. **One real private task through result, review and revision**, with deployment,
   identity/custody, database persistence and restore foundations.
2. **A productive fleet**, including continuous pickup, schedules, supported connectors,
   platform-specific setup, reconnect and safe updates. Review waits must not stall
   unrelated eligible jobs.
3. **Multi-bot Idea Lab and ABS news-to-research**, using that same task/result route;
   project promotion, separate pages, saved discussion and attributable research.
4. **Daily-use acceptance and recovery**, including monitoring, browser/mobile behavior,
   bounded load, backups, restore and rollback.

Contributor packaging, license notices and large claimable work packets accompany
each batch. Optional future harnesses and content packs remain explicitly listed,
not silently discarded or made prerequisites for the first usable release.

## Goal prompts and current gate

Use **Goal prompt 1** in [the comparison program](REUSE_COMPARISON_PROGRAM.md) to
finish the evidence and implementation plan. That goal is already active in this
task; do not create a duplicate merely to continue it. **Goal prompt 2** is the
implementation template, to be finalized with actual choices after comparison.

One disposable PostgreSQL package setup needs separately requested authorization
for its reviewed package-local symlink script. It remains unrun. Many other
comparisons are unaffected, so this is not a global blocker. No production action,
real credentials, native agents, GitHub writes or Actions are authorized by research.

Latest retained evaluation downloads: F1 222 MiB and F2 184 KiB, with 140 GiB free.
Other completed cohorts report exact cleanup in the [download log](REUSE_DOWNLOAD_LOG.md).
