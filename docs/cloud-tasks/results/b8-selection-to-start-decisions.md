# b8-selection-to-start decisions (PLAN r3)

These decisions supersede the conflicting r2 helper dispositions. Independent re-review is pending.

## D1 — One approved selection codec

Choice: Use roles plus matching top-level review counts and strict model/route/effort slots; separate persisted five-role preset projection and run overrides.
Options: Flat role aliases/launcher slots/in-selection overrides; approved roles/count shape.
Why: Restores the approved B8 contract and a shared slot schema for U82/D01a/D01b; no product family policy.
Affected spec item: 2, S4

## D2 — Explicit false reset

Choice: Run envelope accepts booleans, writes both override switches explicitly and defaults each to false for new runs.
Options: Reject false; inherit installed true; explicit false reset.
Why: U82/D01b fragments must reach intake/checker as false without persisting any override or authority.
Affected spec item: 2.4, S4

## D3 — One layer merger

Choice: U81 owns mergeSelectionLayerV1; later saved selections extend this export in place and retain every valid non-B8 member at expectedVersion.
Options: Duplicate merger in saved.ts; one foundation export.
Why: Avoids conflicting shared writers and preserves providerRoute/other roles without saving acceptance.
Affected spec item: 2.3, S4

## D4 — Shared selection authority

Choice: U81 selection service owns owner-only/project loop_selection.read low and loop_selection.manage high with resourceType loop_selection. P71 layer saves retain loop_policy.manage.
Options: tasks.propose preview mode; named selection actions.
Why: WebSessionAuthority already accepts action strings and rechecks grants at commit. Task launch grants remain separate and unchanged.
Affected spec item: 3, S5

## D5 — Exact candidate before checker

Choice: Allocate one server candidate commandId/run in preflight, build full post-normalization binding, check outside locks, revalidate and insert precisely that candidate.
Options: Check a partial context then sign a larger binding; check full candidate.
Why: Checker must see the approved {mode:admission,binding,commandId} that is actually committed. No draft write before guard/revalidation.
Affected spec item: 4.2, S1

## D6 — Approved optional acknowledgement

Choice: Use sameFamilyAcknowledgement, exactly six fields, only intake/confirm/start. New true intent on any of those actions mints a fresh record.
Options: Renamed/expanded record; approved name/scope.
Why: Keeps Option A, current body compatibility and tools semantics; no owner decision is reopened.
Affected spec item: 4.1–4.3, S1/S3

## D7 — Reuse only accepted provenance

Choice: Unchanged Confirm/Start may copy exact accepted_at from verified accepted intake/confirm lineage. Changed input requires fresh explicit intent.
Options: Age expiry on every record; accepted provenance plus candidate freshness.
Why: Claim alone cannot authorize; accepted lineage has no invented age expiry, and exact replay never remints or redispatches.
Affected spec item: 4.3, S2/S3

## D8 — SQL timing by row kind

Choice: Freshness <5 seconds applies only to new-true-intent claims. Results/reconciliation and copied records do not get an elapsed-age predicate.
Options: Same freshness on every row; claim-only new-intent timing.
Why: Results repeat the claim binding with later created_at; copied provenance must remain usable. Strict absent-or-validated disjunctions and timestamp validation preserve legacy rows.
Affected spec item: 4.4, S2

## D9 — Actual snapshot prerequisite

Choice: Define a fail-closed snapshot guard port and withhold U81-B until the lead releases the physical producer/current reader/serialization protocol and allowed files.
Options: Pretend policy.assertSnapshot or a spy covers availability; explicitly unreleased prerequisite.
Why: No implementable atomic availability reader exists on the pinned base. A tools post-claim fence cannot prove zero product claims.
Affected spec item: 5, S6

## D10 — Per-command dispatch capsule

Choice: Carry frozen commandId/bindingDigest/snapshot/lineupDigest from checker result through admitted, #dispatch, adapter, invoke and admissionExpectation.
Options: Mutable last-check cache; new binding fields; immutable optional per-command argument.
Why: Concurrent checks cannot exchange digests; the binding gains only its approved optional record. Exact replay never spawns.
Affected spec item: 5, S1

## D11 — Exact-target UI projection

Choice: Add approved safe status selection projection; previewSaved derives target server-side for normalization/reload; show unchecked renewal at Confirm or Start only when acceptance is not current.
Options: Settings-hash-only gate; exact request/version/hash/engine/epoch target.
Why: Normalized input shares settings bytes but cannot inherit acceptance; checkbox is never restored. Frozen uncertain actions reconcile before replacement.
Affected spec item: 7, S3

## D12 — Tools remain one policy core

Choice: Add optional preview-intent/full-admission context and validated projection to existing hook; release exact schema/revision/digest and strict review-only final/manual/chained/recovery proofs.
Options: Second checker/product family rules; shared checker core.
Why: Current F10c is provider routing only and does not qualify B8 acknowledgement/snapshot semantics. Do not widen approve/answer record scope.
Affected spec item: 6, S1/S6

## D13 — Bounded continuations

Choice: Use U81-A foundation, U81-B admission/PG after prerequisites, U81-C UI/transport, each <=6 hours with exact writer/files/evidence.
Options: One 8–12-hour BUILD; named bounded stops.
Why: Preserves six-hour budget and review time; every missing integration/native gate stays pending.
Affected spec item: 8.1/9/10, S7

## D14 — Integration order and route distinction

Choice: U81→U82→D01a→D01b share exports sequentially; U83a consumes U81/U82 and only configured-provider validation waits on it. Paid cap runs independently.
Options: Circular requirement for every launcher route; distinct launcher/provider contracts.
Why: B8 slots always have a launcher route. Provider choice, billing and family acceptance never grant paid consent/readiness; later paid integration consumes whole-window priceRowDigest and the exact server candidate.
Affected spec item: 8.1, cross-chunk ownership
