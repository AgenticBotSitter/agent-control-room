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
The [closure checklist](REUSE_COMPARISON_CLOSURE.md) consolidates the remaining
decisive work into ten substantial packets with explicit local versus target gates,
covering all26 outcomes. It is not a substitute for completing those experiments.

## What the deeper comparison has established

| Responsibility | Candidate comparison and current evidence | Decision-changing work still needed |
| --- | --- | --- |
| Queue, scheduling, continuous work | Existing pg-boss integration versus actual DBOS package and Hatchet source. DBOS supports transactional admission worth comparing; its PGlite migration attempts failed. | Disposable real-PostgreSQL shared cases; current Hatchet interface; actual recovery/schedule and migration cost. PGlite failure is not proof of a PostgreSQL incompatibility. |
| Agent execution and files | Eight actualTS SDK process-transport cases with synthetic executable cross currentresult checks;13actualPythonrouter and6currentJSONLchecks compare correlation/buffering/closure. Prior Hermes file retrieval and Herdr evidence remains scoped. | FullSDKclientpolicy comparison, Hermes lifecycle/file-to-project bridge, uncertainty and native cancellation. Output buffering/redaction and canonical settlement still need wrappers; no native agent qualified. |
| Project/session/conversation UI | Actual Desktop component and WebUI helper/action code mounted through protected Control Room project reads in Chrome. Composite identity and logout cache glue were necessary; Desktop keyboard focus needs adaptation. | Review's delayed-response ordering finding was corrected; 17 browser checks now record held 200 with two projects, later 401 and exact-response release without label resurrection. Full transcript/list, mobile/CSS and complete keyboard comparison still open. |
| Multi-agent discussions and coding workspaces | Actual Hermes durable/planner13checks, Maestro writer6checks and12mappedplanner cases. Narrow recommendation retains fixed-panel loop. AO now passes actual ownedGit preservation/restore plus selected upstream tests using an isolated offline Go toolchain. | Maestro complete delivery; actualCR-to-Go immutable-revision/lease mapping; conflict/stale/restart/branch ownership. Native execution policy and durable binding remain separate. |
| Owner custody and independent integrity | Prior ssh2 scoped evidence plus actual etcd/OpenBao code and tests inspected. etcd WRITE also permits delete; OpenBao has separate policy paths. | Shared real-service contention, lost response, restart/restore and split-commit cases; actual owner custody is a separate live gate. Neither service's installation proves independent recovery. |
| Installation and rolling updates | WinSW stop/restart/source tests inspected against Task Scheduler and current OS templates. Personal logged-in agents and dedicated service accounts are different deployment contexts. | Actual inert lifecycle/update evidence on supported platforms. Historical templates are not installers; restarting a one-task command does not make a continuous worker. |
| ABS/news and later content packs | Eleven attributed Control Center files reconciled;60checks include actual borrowed collection→ordinary task→synthetic execution/result/review. Two actual parsers differ on title/relative URL/caps. Miniflux/FreshRSS/RSSHub additional source screening recorded. | Parity-preserving parser/translation consolidation; decisive new-service tests only for uncovered source/extraction needs; live feeds and actual research agents remain unqualified. |
| Login, backup, monitoring and acceptance | Eleven actualKuma HTTPbranch/client cases map through currenthealth builder, including login200 rejection withJSONquery,503,reset andtimeout. pgBackRest physicalcluster restore differs from initial dedicatedDBlogical restore. Access remains selected provider. | Fullmonitor daemon/persistence/alerts, Beszel, disposable current-schema restore and standardJWTlibrary comparison. No production login/health/DB acceptance inferred. |
| Licensing and contributor delivery | Current30dependencies versus old28notice inventory exposes accounting drift. Missing entities notice traced to matching installed code at registrygitHead; source manifest version discrepancy preserved. | Complete new transitive graph and actual built distribution notice assembly, selected assets and release checks. Retained research license text is not an updated shipping package. |

Evidence details: [F1](research/reuse-comparisons/f1-queue-fit.md),
[F2](research/reuse-comparisons/f2-codex-interfaces.md),
[F3](research/reuse-comparisons/f3-mounted-fit.md),
[F4](research/reuse-comparisons/f4-planner-fit.md),
[F5](research/reuse-comparisons/f5-checkpoint-comparison.md),
[F6](research/reuse-comparisons/f6-supervisor-fit.md),
[F7](research/reuse-comparisons/f7-existing-reconciliation.md),
[F8](research/reuse-comparisons/f8-operations.md),
[F9](research/reuse-comparisons/f9-shipping-license-scope.md).
These are feature-specific observations, not whole-product reliability rankings.

## How we close the comparisons

Latest bounded comparisons:

- [Owner-bootstrap async contract](research/reuse-comparisons/f8-bootstrap-async-contract-fit.md):
  30 scenarios execute the actual bootstrap control flow with a delayed real Node
  verifier and fake persistence. Await-only negative controls reach simulated commit
  after expiry/cancellation; freshness-aware adaptation rejects. A discarded precommit
  Promise is separately demonstrated. This is additional caller migration evidence,
  not execution of candidate JWT libraries inside bootstrap or real DB qualification.
- [Parser consolidation](research/reuse-comparisons/f7-parser-decision-fit.md): actual
  legacy decoder with a fast-xml-parser research adapter matches14/18 corpus outputs;
  four explicit compatibility adaptations reach18/18. A corrected single run verifies
  seven source/lock identities and212 files across13 packages before candidate imports;
  candidate entities resolution is now independent of rss-parser. Independent re-review
  closes those two prototype findings. The broader selection corpus then gives11/18
  adapted parity and4/18 borrowed-output parity. DR-02 now retains both maintained
  parsers: avoid a compatibility fork for about2.23MiB possible package allocation
  savings. Independent selection review accepted that narrow planning choice.
- [Full-text collector](research/reuse-comparisons/f9-collector-fit.md): actual
  pnpm-created fixture passes with4.4.2 and exploratory unsupported-on-Node22 5.0.1.
  Crucially,4.4.2 then omits resolvable transitives from the real application graph;
  it is not acceptable as a complete inventory as configured. Preserve existing
  tooling alternatives rather than write a custom walker. Owned52MiB evaluation
  packages/cache/fixtures removed with absence verified; receipts retained.
- [Complete synchronous SDK client](research/reuse-comparisons/f2-client-fit.md):
 15 checks exercise actual Python client and five synthetic stdio peers, including
 explicit refusal and cleanup. Same-turn/wrong-thread streaming, early completion
 before start reply, parent-environment merging and absent request deadlines need
 adapter handling. This is not yet client-to-CR observer mapping or native execution.
- [Next license tools](research/reuse-comparisons/f9-next-fit.md): current manifest
 closure is39 runtime identities, a different scope from the earlier30 direct
 dev+runtime entries. CycloneDX failed its npm graph read; pnpm initially lacked
 store metadata. A clean isolated frozen preparation now yields39/39 native identities
 and closes that graph question (DR-03), but no full license text fields. Full-text
 extraction remains separate. Owned70MiB and later288MiB cohorts removed.
- [Consolidated JWT adapters](research/reuse-comparisons/f8-jwt-consolidated-fit.md):
 actual library parsing/verification preserves99 policy cases and50 projectHTTP
 checks; four further actual-authority preflight cases reject expired identity before
 any DB call, with a fresh positive sentinel. All-caller adaptation and final library
 choice remain; these are synthetic local tests, not actual Access/login acceptance.

The [joined ABS revision fixture](research/reuse-comparisons/cross-journey-revision-fit.md)
now proves that the same borrowed-source task/result carries exact lineage through
changes-requested review to a replayable proposed revision. The extended fixture
preserves a full-capacity refusal, then uses existing quality reconciliation to
release the parent's execution slot without accepting its result. The child receives
a distinct lease at the unchanged limit and assignment replays without another run.
This reuses existing production release logic; no new capacity engine is needed.
Revised-task execution,
restore and candidate transport/queue substitutions remain open. This closes a
specific baseline gap, not the full end-to-end live workflow.

Latest concrete additions: [JWT library fit](research/reuse-comparisons/f8-jwt-fit.md)
executes jose and jsonwebtoken through the current verifier policy (69 mapped checks,
10 library-only observations). [Actual HTTP follow-up](research/reuse-comparisons/f8-jwt-http-fit.md)
adds50 named scenarios and demonstrates the required jose await, denial ordering and
full identity fields. The later consolidated experiment above supersedes the parsing
gap; all-caller execution and final selection remain;
no new auth provider is selected. [Distribution audit](research/reuse-comparisons/f9-distribution-fit.md)
finds115 actual built files without standalone notice/license files and maps external
imports. Source-to-build freshness is unverified; generator comparison and complete
artifact notice assembly remain, rather than assuming another custom tool is needed.
The [tool comparison](research/reuse-comparisons/f9-tooling-fit.md) now screens three
actual pinned implementations and tests, plus three executed installed-npm fixture
checks. The actual Vite/notice-plugin fit below advances that seam; no generic custom notice
engine is selected, and a metadata-only SBOM is not complete license-text assembly.
The [actual Vite plugin fit](research/reuse-comparisons/f9-plugin-fit.md) now passes
six assertion groups. It is the leading bundled-package extraction candidate;
actual vinext multi-environment output, full-text completeness, externals and copied
source attribution remain explicit integration tests, not inferred passes.

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
