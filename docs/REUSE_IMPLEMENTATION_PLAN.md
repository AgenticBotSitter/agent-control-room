# Reuse-led completion plan — working draft

Source checkpoint: `0d3031d`, with linked subsequent local research. This is an incomplete implementation plan, not a
claim that the comparison goal is finished or authorization to deploy. It records
settled choices and makes pending decisions explicit. The authoritative remaining
experiments are in [the closure checklist](REUSE_COMPARISON_CLOSURE.md); candidate
evidence and alternatives remain in its linked dossiers and
[decision register](research/reuse-comparisons/decision-register.md).

## Delivery contract

Deliver one private, usable orchestration system: separate project pages; ordinary
tasks returning retained, reviewable results and linked revisions; continuously
productive eligible workers; bounded multi-bot Idea Lab; ABS article-to-research;
recoverable daily operation. Hermes and Codex are required runtime integrations.
Additional harnesses and consumer/media packs are explicit later modules, not a
reason to leave the required product perpetually unfinished.

PostgreSQL is the sole transactional write authority. PGlite is local test/development
only. Access remains the chosen login perimeter. Upstream queues, sessions and
messages cannot independently approve effects or declare reviewed completion.
Preserve canonical project/job/attempt/review IDs and private configuration.

## Settled source reuse

| Decision | Implement / retain | Do not import or replace | Remaining implementation acceptance |
| --- | --- | --- | --- |
| DR-01 | Existing fixed-panel selection loop, bounded to six participants and three rounds | Hermes dynamic planner solely to replace this loop; this does not reject Hermes execution | Existing round/budget/receipt tests plus saved discussion promotion; real participants separately qualified |
| DR-02 | Attributed Control Center collection modules; rss-parser 3.13.0 and fast-xml-parser 5.11.0 at their existing boundaries | A second full collector or custom compatibility parser without a named uncovered need | Repeat collection, archive and provenance through current task APIs; real approved feeds later |
| DR-03 | pnpm 11.19.0 prepared runtime identity graph | New generic dependency resolver; npm CLI graph assumptions on this pnpm layout | Frozen clean preparation, exact platform graph and build binding |
| DR-04 | CycloneDX library 10.2.0 public LicenseEvidenceGatherer, build-time only, plus four explicit retained-text exceptions | Whole CycloneDX CLI graph reader; single-text checker as sole original-text collector | Snapshot-safe bounded reads; complete built/copied/vendor/asset attribution, including collector notices |
| DR-05 | jsonwebtoken9.0.3 behind existing synchronous verifier and retained CR policy | Async migration solely to adopt jose; a new login provider; dual token libraries | Actual typed package import, identity/caller regressions, full notices/build and owner login separately |
| DR-06 | Current immutable task/attempt/receipt authority; Maestro routing is conditional reuse for a named notification gap | Unchanged Maestro local inbox/wake status as task acknowledgement; a new general notification framework without a required channel | Actual native lifecycle still required; future notification adoption needs ingress/digest/restart/transport fit, not wake-as-completion |
| DR-07 | Readability0.6.0 + jsdom26.1.0 as the default bounded extraction primitive; retain existing collection | Custom article scoring, HTML repair/selector engine, or an extra reader service solely for extraction | Source-bound detail/storage/rendering, lineage/fallback, bounded resources and complete package/file notices; not full reader completion |
| DR-08 | Native Git detached worktree operation behind existing workspace identity/lease checks | Unchanged AO branch-oriented Restore as the exact checkout port; a new worktree engine | Actual concrete port, detached readback, concurrent ownership, failed-create/restart reconciliation and no-loss conflict/dirty handling; AO remains selective preservation donor |

These decisions currently delete zero production lines. They avoid unnecessary new
infrastructure; they are not evidence that every existing custom component is needed.
Other selections below remain pending their discriminating local tests.

RC10 actual client/RSC/SSR build now works with the existing notice plugin in an
owned staging root. Its three missing third-party text records resolve to already
retained originals; no new collector or repeated download is justified. Implement
explicit pinned exceptions, cross-environment aggregation, project/copied-code/asset
and external-runtime inputs as described in
[the actual-build resolution map](research/reuse-comparisons/f9-build-notice-resolution.md).
This is not notice-complete release acceptance; final assembly/negative tests remain.

RC9 [readiness source mapping](research/reuse-comparisons/f8-readiness-integration-map.md)
finds internal readiness/admission but no dedicated JSON health route in the
inspected private application. Add a narrowly reviewed read-only projection and
monitor configuration; do not assume earlier synthetic Kuma JSON is that route.
Preserve Access and distinguish listener200 from dependency/task readiness. Reuse
the upstream monitoring engine instead of creating one for this small app seam.

RC7 integration constraint: [the inspected article boundary](research/reuse-comparisons/f7-article-integration-map.md)
rules out storing fetched articles as completed native results. Rich reading needs
its own source-bound optional projection or evidence binding using reviewed storage
primitives, preserving story digests and existing research actions. Current summary
and source-link access must survive extraction failure. Existing byte stores also
cap objects at65,536 bytes; a larger article cannot be silently truncated or force an
unreviewed shared result-limit increase. Actual extraction comparisons do not yet
prove that application seam or select a new persistent service.

RC2 implementation constraint: the tested TS SDK exec stream has no native turn ID.
Its actual output maps to existing decoder/result functions but cannot substitute
for the App Server observer without changing that identity contract. Retain current
identity/terminal/transport-error safeguards and compare actual Python/App Server
mapping before choosing. See [seven new cases](research/reuse-comparisons/f2-observer-fit.md).
RC6 [journal/update primitive tests](research/reuse-comparisons/f6-update-fit.md)
support reuse of existing durable state and close/recover code, not a claim that
continuous pickup, release switching or fleet drain already exists. Those remain
explicit implementation work; do not replace them with supervisor restart loops.

RC3 root decision: preserve the existing result/review authority UI. The unchanged
Hermes Desktop MessageRow derives Approve/Deny controls from assistant prose and is
not a replacement for those controls. Its presentation pieces remain candidates,
but adapting them must remove that misleading action path rather than attach no-op
callbacks. Actual renderer/media closure and complete navigation remain open. See
[mounted comparison](research/reuse-comparisons/f3-journey-fit.md) and
[independent root review](research/reuse-comparisons/f3-journey-review.md).

RC5 now has a real permission tradeoff, not merely two service names. Tested
OpenBao2.6.2 read/update blocks deletion and missing-head recreation while retaining
CAS; tested etcd3.7.1 READWRITE also permits deletion. OpenBao's startup/unseal,
policy/token and storage operations are additional integration costs; etcd already
has a CR-specific checkpoint adapter. Do not pick by test count or small cold-run
RSS alone. The next shared adapter cases must preserve actual CR scope/digest and
revision binding, uncertainty without repeated writes, restore/custody boundaries
and staged SQL commit failure. Retain one selected anchor only, never hot fallback
to a stale second store. [Actual OpenBao evidence](research/reuse-comparisons/f5-openbao-service-fit.md).

The [OpenBao identity source map](research/reuse-comparisons/f5-openbao-identity-map.md)
rules out translating data-version created_time into stable key identity. Its
ordinary data CAS differs from etcd's combined create/mod/value comparisons. Resolve
the actual object-binding and restore model before creating a Bao-specific adapter;
do not fabricate equivalent etcd responses or quietly broaden metadata permissions.

## Outcome-to-implementation ledger

Existing capability summaries come from the [26-outcome map](REMAINING_WORK_REUSE_MAP.md),
not new production acceptance. RC references identify comparison blockers, not owner
permission blockers. Every row needs exact changed/deleted files and measured cost
added after selection; unknown cost is not zero.

| Outcome | Existing base and proposed integration boundary | Decision still needed | Finish evidence and migration / rollback constraint |
| --- | --- | --- | --- |
| A1 Website/database | Compiled launcher, operator config and migration/role checks; PostgreSQL plus host supervisor | RC6/RC9 persistence and recovery fit | Dedicated DB/roles, restart and restored restricted-login checks. Preserve other apps; back up before migrations; no unproved down-migration |
| A2 Owner login | Access verification and bootstrap; DR-05 selects jsonwebtoken for standard token processing | Implement selected typed import and retained-policy parity; actual owner acceptance still open | Verified owner subject, wrong-owner denial, expiry/logout/origin; preserve synchronous verifier and existing downstream freshness, never enable bypass as rollback |
| A3 Execution approval | Canonical packets, paired issuer and review controller; tested ssh2 signing seam | RC5 custody/interface selection | Exact consent/key/packet binding and uncertainty hold; real key and attended consent are separate gates; preserve pending packet identities |
| A4 Rollback integrity | Async completion checkpoint interface | RC5 etcd vs OpenBao | CAS contention/lost response/restart/restore then independent target custody. Preserve checkpoint history and never silently reset a high-water mark |
| A5 Task/result/revision | Current task/native/result/review services and synthetic joined journey | RC1/RC2 complete engine/client mapping | One real authorized result and reviewed revision, retained after reconnect. Preserve attempt IDs and journals; uncertainty forbids automatic repeat |
| A6 Project pages | Current catalog/lifecycle/tabs | RC3 Desktop vs WebUI module fit | Create/open/archive/reopen, mobile/keyboard/reload; close view does not stop job. Keep canonical project IDs and reversible presentation-only changes |
| A7 Results/Needs Me | Protected results and attention services | RC2/RC3 result and presentation mapping plus RC9 readiness/operations evidence | Missing/late/held/reviewable results remain actionable; queue success is not approval. Retain old result/download records during UI replacement |
| B1 Continuous fleet | Capacity/claim model and installed pg-boss | RC1 pg-boss vs DBOS vs Hatchet; continuous loop still missing | Concurrent eligible work, review waits not blocking unrelated jobs, drain/restart. One active engine; drain and reconcile before cutover |
| B2 Schedules | Occurrence/policy/profile/budget contracts | RC1 scheduling comparison | DST/missed-run/duplicate occurrence and pre-claim eligibility; preserve occurrence identities across scheduler migration |
| B3 Codex | Partial adapter and historical qualification | RC2 official supported client/transport | Exact run/events/usage/cancel/resume binding on supported hosts. Pin protocol, preserve explicit IDs; no silent new run on resume failure |
| B4 Host installation | One-task entrypoint/journal assembly, non-installable historical templates | RC6 launchd/systemd and Windows session vs service mode | Versioned install/enroll/uninstall with correct account/profile/ACL; retain previous immutable package and journal; no restart-loop pseudo-worker |
| B5 Session monitoring | Herdr read-only research adapter | RC2/RC3 authenticated mapping and selected UI | Project-scoped offline/stale/duplicate sessions; read-only application boundary. No implicit interactive terminal permission; removable observer |
| B6 Reconnect/cleanup | Current journals/recovery/stop components | RC2/RC6 lifecycle ownership | Intended process tree stopped or explicitly unknown, late results retained; rollback cannot discard journal or misidentify a run |
| B7 Team/workspaces | Canonical ownership and jobber workflow | RC4 Maestro vs AO modules vs native rooms | Duplicate/stale messages, conflicting checkout/lease, restart; isolated workspace and reviewed output; no alternate claimant/auto-merge authority |
| B8 Artifacts | Metadata/storage and Hermes retrieval experiments | RC2 native file-to-run intake | Bound project/run/attempt, actual size/hash/type/path and protected download. Retain bytes/checksums; avoid replacing broad filesystem APIs wholesale |
| B9 Capabilities/usage | Native profile/skill and worker manifests | RC2 capability normalization | Pre-claim platform/tool mismatch refusal; measured vs estimated usage. Version adapters; keep native skill runtime rather than fork it |
| C1 Idea Lab | Roster/turn/budget/recap records and DR-01 loop | RC3/RC4 UI, execution and durable delivery | Multiple real participants, bounded cancellation and saved synthesis; retain contribution IDs/receipts on restart |
| C2 Idea promotion | Promotion/backlinks and experiment templates | RC3/RC4 saved discussion-to-task fit | Project page plus correctly bound resources and completed first task; promotion alone never provisions execution authority |
| C3 ABS reading | Already borrowed collection/curation/history and DR-02 | RC7 reader/source additions only for uncovered functions | Approved sources, readable provenance, repeat/archive behavior; preserve story/evidence digests or explicitly version normalization |
| C4 Article research | Research proposal and ordinary task path | RC2/RC7 restart/uncertainty mapping | Actual sourced research/guide, review and linked revision; no automatic publishing/setup effects; retain source-to-result linkage |
| C5 Later extensions | Generic consumer/harness contracts | RC7 explicit disposition of each known optional candidate | Document interfaces/licenses/future host tests; synthetic public examples, no private-data rewrite; optional packs removable independently |
| D1 Backup/restore | Existing native dump/restore procedure | RC9 logical restore vs cluster tools | Current-schema rows/ownership/ACL/restricted-login/artifact restoration; verified persistent storage. No cluster-wide change for a dedicated app backup |
| D2 Monitoring | Current diagnostics/attention | RC9 Kuma daemon and Beszel fit | Actual protected outage alert, persistent config and resource trend; monitoring cannot settle jobs. Disable separately without weakening app authority |
| D3 Updates | Releases and recovery contracts | RC6 immutable package/drain compatibility | Canary, preserved journals/results, supported mixed versions and rollback. Destructive schema change needs separate migration strategy |
| D4 Daily acceptance | Existing deterministic and split-memory suites | RC9 integrated PG/browser/load protocol | Multi-agent sustained bounded workload, mobile, expired auth, dropped responses, restart/restore and measured memory; failures remain visible |
| D5 Public contribution | Existing export/provenance/review material; DR-03/04 | RC10 complete release scope and substantial packets | Exact source/license inventory, generic examples, reproducible local checks, reviewed export and economical CI; never publish private configuration |

## Substantial build batches and dependency order

1. **Close comparison decisions.** Finish RC1–RC10's decision-changing cases, not
   repeated happy paths. Record surveyed alternatives, actual interface tests,
   adaptation/removal lists, costs and independent findings. Update this draft into
   an approved plan before describing unresolved replacements as selected.
2. **First usable task.** Integrate A1–A5 and essential A6/A7/D1 together: private
   login, approved execution, retained result, review, revision, restart recovery.
   Existing local synthetic child-completion evidence is reusable, not live proof.
   This includes the minimum B4/B6/B8/B9 slice for one enrolled host: an installed
   supported runtime/profile, eligible capabilities, owned lifecycle/journal and
   retained output. It does not wait for fleet-wide installation or continuous pickup.
3. **Productive fleet.** B1–B4/B6/B7/B9 and basic D2/D3: continuous eligible pickup,
   concurrency, review waits, recurrence, drain and versioned installation. First
   qualify one supported runtime/host, then other hosts. B5 read-only observation can
   proceed alongside this; optional terminal control must not delay task readiness.
   B7 adds the selected coding-workspace/message handoff integration with immutable
   lease ownership, conflicts and restart tests. It is not silently deferred to an
   unspecified later phase or required for the first non-coding ordinary task.
4. **Idea Lab and ABS.** C1–C4/B8 on the same task system. Saved discussions promote
   to ordinary projects; articles become sourced, reviewed research. UI/source work
   can run earlier, but real end-to-end acceptance depends on batch 2.
5. **Daily-use release.** Complete D1–D4 combined restore, outage, browser and fleet
   soak. D5 attribution/contributor work accompanies every batch. C5 gets explicit
   future packets, not an unsupported claim of working connectors.

Parallelizable work: selected presentation modules, artifact mapping, attribution
and isolated workspace integration once their contracts are fixed. Serialize queue
ownership changes, schema migrations and release integration. Independent reviewers
do not review their own implementation; root retains security and integration decisions.
External contributors receive sizable bounded packets with acceptance, exclusions,
source pins, touched paths and local checks, not hundreds of one-file relay tasks.

## Cutover and deletion rules

- For each replacement, capture baseline evidence and exact persisted identities;
  execute old/new implementations against the same disposable cases before cutover.
- Keep one authoritative writer. Shadow comparison may observe synthetic/read-only
  data, never start the same real task through both engines.
- Delete overlapping implementation only after the replacement crosses the real
  application interface, failure cases pass and rollback preserves records/journals.
- Pin adopted upstream modules; keep original notices and changed-source attribution.
  Prefer public APIs and thin adapters. Any custom infrastructure exception must name
  the failed candidate seam, maintenance burden and a removal/reopen condition.
- Report install/storage footprint separately from process RAM. Do not turn unknown
  migration effort, sustained memory, unsupported OS or native-provider behavior into
  estimates presented as measurements.

## Goal prompt handoff status

The final implementation prompt is **not ready to run**: selections and exact scope
remain open above. It must eventually instruct execution of the reviewed version of
this plan, reuse first, substantial batches, independent review, preserved identity
and uncertainty boundaries, local verification and scoped target qualification.
It must not silently authorize live calls, production changes or GitHub publication.
The final comparison deliverable must include a copy-ready prompt with these actual
decisions filled in; this paragraph is not a substitute for that deliverable.

## Completion audit for this document

Independent [draft review](research/reuse-comparisons/implementation-plan-draft-review.md)
identified three sequencing gaps. Root disposition: IP-D1 addressed by assigning B7
to productive-fleet delivery; IP-D2 addressed by adding RC9 to A7; IP-D3 addressed by
explicit minimum single-host B4/B6/B8/B9 prerequisites in the first-task batch.
This is draft correction, not final acceptance of unresolved comparisons.

- All 26 original outcome IDs are mapped above; none is declared fully accepted.
- Eight settled narrow decisions (DR-01 through DR-08) are separated from open
  responsibility decisions; an unbuilt outcome can have a settled component choice.
- Exact source/change/deletion lists, comparative costs/rubric, final independent
  review and the final implementation prompt remain unfinished.
- Production E4 gates are not substitutes for local RC experiments. Conversely,
  local simulations do not establish live operation.

### Independent completion-audit disposition

Root accepts the scope correction in
[the completion audit](research/reuse-comparisons/completion-audit-next.md).
Representative integration-fit evidence is required where it can change selection;
completing a new reader, updater or health subsystem is not a prerequisite to
selecting its already-tested upstream primitive. Those features remain required
implementation deliverables, not removed requirements.

The remaining decision-changing priority is: queue transaction/recovery; supported
native lifecycle and Hermes artifact intake; checkpoint object binding/recovery;
monitoring daemon and current-schema restore; then narrow presentation/workspace
seams. Optional C5 candidates still need individual recorded dispositions, not
implementation before this comparison goal closes. Final packets, comparative
costs and the copy-ready goal prompt remain due after those choices are resolved.
