# b8-selection-to-start decisions (PLAN r5)

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

Choice: U81 owns mergeSelectionLayerV1; later saved selections consume this unchanged two-argument export and retain every valid non-B8 member at expectedVersion.
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

## D15 — Remove codec-only string limits (R2A MEDIUM)
Choice: preserve roster-valid model/launcher/effort values without independent byte caps.
Options: remove caps; amend all consumers and approved spec.
Why: one exported slot codec must admit the same valid roster choices as D01b and the checker.
Affected spec item: 2.1, T1.

## D16 — Budget the exact frozen candidate (R2A MEDIUM)
Choice: bound admission checker preparation/child and transaction by the existing at-most-five-second window; pass execution signal/timeout separately from approved context, cancel/reap, never restamp acceptance.
Options: check for up to 30 seconds then always refuse; weaken fresh-intent SQL; explicit smaller cancellable admission budget.
Why: preserves exact checked binding and SQL freshness. Slow qualified tools remain unavailable until measured within budget; preview retains its legacy timeout.
Affected spec item: 4.2, 6, T12-P (preview), T12 (admission).

## D17 — Preview intent and caller route assembly (R2A LOWs)
Choice: previewSaved uses sameFamilyIntent only. U83a caller assembles a complete optional providerRoute after the unchanged encoder/merger and before shared preview/intake/save validation.
Options: preview action consent; route dropped by roles-only encoder; separate caller assembly.
Why: preview cannot mint acceptance; strict B8/preset JSON stays roles-only while explicit provider choice survives unsaved intake.
Affected spec item: 2.2–2.3, 7, T4.

## D18 — Record preview-name deviation and committed provenance (R2A LOWs)
Choice: retain fixed consumer product names reviewFamily/standardFinal, record the approved B8 selection spec R4 preview-body deviation and require exact tools mapping; candidate is its containing commit over committed r3.
Options: silently deviate; change the CLEAN D01b contract; record and qualify the mapping.
Why: avoids a second codec and stale uncommitted handoff prose without asserting approval of a new spec revision.
Affected spec item: 2.4, revision history, status/evidence.

## D19 — One reserve and executable evidence ownership (R3)
Choice: §4.2 is the sole end-to-end timing definition; execution timeout measures to the candidate deadline, child budget subtracts one reserve, and service signal uses the same cutoff. U81-A owns T12-P only; U81-B owns T12 and the explicit cancellation protocol.
Options: double subtraction / admission evidence in foundation; one deadline and named evidence owners.
Why: the nonzero-preparation success case now has slack; the foundation can prove its own stop boundary. Cancellation and DB work must fit the stated implementation allowance or require a narrower lead continuation. Frozen encoder/merger signatures and approved B8 selection spec R4 remain unchanged.
Affected spec item: 4.2, 8.1, T12-P/T12; MEDIUM-1, MEDIUM-2, LOW-1.

## D20 — U81-A BUILD seam and review LOW-1 labels

Lead continuation authorizes only U81-A at reviewed r5 head 936cef0483ce0a151ff17591ae5c97c697ee4de1. T13-project means the project selection/preview route through both no-listener outer Node handlers; U81-A owns it. T13-saved means the saved-target preview route plus full process wiring; U81-C owns it. T10 is the preview/readiness assertion in U81-A; it does not supply admission evidence to U81-B. This records the round-3 LOW-1 label clarification without editing the reviewed spec. LOW-2 is respected by deferring all U81-B work.

The foundation projection is a product contract exercised only with scripted checkers and snapshot ports. No tools schema/revision/digest, availability producer or admission reader is invented; the installed legacy checker lacks the projection and fails selection preview unavailable. T-TOOLS/T-SNAPSHOT remain mandatory before dependent integration.

The completed foundation preserves non-B8 P71 role members in run-edit projections and resets both switches even for overrides-only new-run edits. It validates requested-slot coverage and checker-attested preview digests without adding a second family policy. The exact tools projection pin and physical admission snapshot reader remain unreleased; no admission authority is created by preview. Build implementation is complete; remaining environment/commit gates are reported in evidence and status.


## D21 — U81-B prerequisite audit and bounded split

The lead continuation supplies product predecessor `7105bd85159e3273cb692135ececa84f0ab379cb` and read-only tools pin `03c3595f40317de0d1bdc97675377ce3ae4f58e3`. Inspection confirms that this tools pin does not release T-TOOLS or T-SNAPSHOT: its bridge contract exports no selectionProjection, its admissionExpectation requires exactly operation/commandId, and its check-lineup CLI has no context input. The product guard remains an interface only; policy.assertSnapshot still compares defaults/layers/text, with no authoritative availability/roster reader. Spec sections 5, 6 and 8.1 explicitly withhold B until the physical reader/producer protocol and allowed-file amendment are released. No fake reader, cache, new availability table, guessed projection digest or tools edit is substituted.

LOW-2 split, preserving the reviewed contract: **U81-B1 admission/cancellation** owns service/adapter/schema/attention/policy changes, complete frozen candidate and accepted lineage, deadline/cancellation/reap/temp cleanup, dispatch capsule, and admission T1–T5/T14, T6–T9/T11/T12 unit/mutation evidence with the released real reader. **U81-B2 SQL/PG integration** owns allocated A/Av migrations/down plus the entire section 4.4 same-commit grants/ledger/schema pins/preflight/fixture/candidate/desk set, selection-PG registration, production-login fresh/upgrade/down/refused-down/delayed-result/copied-record/barrier/guard-off proofs. B1 cannot claim end-to-end SQL-backed acknowledgement until B2 lands; B2 cannot detach any section 4.4 file from its migrations. Both require the reviewed release packet; B2 additionally requires lead-allocated migration IDs. No part is implemented in this blocked attempt.

LOW-1 remains resolved by D20: T10 is A preview/readiness only; T13-project is A and T13-saved/real transport is C. No invented T10 admission case. Next continuation must name the exact tools projection/context/expectation/settings mapping and measured latency, physical producer/current reader/serialization lock protocol, and their allowed files. The supplied tools commit alone does not satisfy these releases.

Status: BLOCKED: U81-B requires released T-TOOLS/T-SNAPSHOT and physical reader allowed-file amendment
