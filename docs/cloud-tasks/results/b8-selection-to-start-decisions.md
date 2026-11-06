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

## D22 — T-SNAPSHOT prerequisite build candidate

The revision-4 physical amendment supplies the current roster/availability bundle producer, closed codec, shared nonblocking filesystem fence and transaction-lifetime facade. The snapshot remains exactly rosterDigest, availabilityDigest and revision. P71 saved-input/default lineage stays separate; no provider data, new policy store or migration is added.

All participating roster and monitor publications invalidate current before mutation. A dirty marker takes precedence across incomplete current publication. Source directory custody is private/service-owned and is the one writable addition in the configured config subtree. Transaction aliases share the outer lease; uncertain database outcomes retain poisoned custody. No automatic fence takeover is permitted.

This is a build candidate against the new T-TOOLS candidate, not a released pair. Counted macOS and production-role PG17 evidence remain required. B1/B2 and U81-C remain separate continuations.


The round-1 blockers and uncommitted handoff above are historical; the round-2 continuation below supersedes that handoff.

## D23 — T-SNAPSHOT round-2 lead decision and qualification boundary

The lead accepts checked pathname mkdir/rename/unlink in Node, together with no-follow descriptor reads, ownership/mode/link/ancestor validation and retained root/fence inode and nonce checks, as the implementation of the directory-relative I/O clause. M1 is resolved by this explicit lead decision; no native addon is introduced. Retained leases now recheck the fence inode and exact owner nonce before source reads/publication as well as release.

The B7 merge resolves M2: the three real-tools P71/provider/Start cases and the complete B7 portable suites pass against tools `064eb462f3a055da9d3487502108a5292e21eeb0`. The required complete counted macOS gate must bind the containing clean product commit to that tools SHA and the lead receipt. Its final receipt and exact command results belong in BUILD-B8-TSNAPSHOT-R2.md, an external build output; this document does not substitute for that receipt.

T-SNAPSHOT adds zero tables/migrations. B1/B2 remain separate and unbuilt; no selection-to-start admission or worker readiness is claimed.

Round-2 Git staging exits 128 (index.lock creation refused); the brief requires leaving changes uncommitted. The mandatory complete gate exits 1 on dirty qualification tree, with no PASS receipt. The lead must commit and rerun it on the resulting clean product SHA. Standalone diagnostic/portable results do not replace that qualification.


## D24 — U81-B round-2 execution slice and precise remainder

The lead's round-2 predecessor is ecd87444bed284677fbcbf23c77a60ecbfc8394b; tools 064eb462f3a055da9d3487502108a5292e21eeb0 and T-SNAPSHOT are now qualified prerequisites. Earlier missing-prerequisite statements above describe historical attempts only.

The accepted LOW-2 sizing split is refined to an additive first part, **U81-B1a checker execution**: policy-to-adapter elapsed-time forwarding, entry-to-spawn preparation budget, exactly one 1000-ms admission reserve, positive integer per-call allowances below the unchanged legacy configuration floor, cutoff/abort refusal, TERM/KILL/reap/temporary cleanup, snapshot error/release reporting and their unit/guard-off regressions. This slice enables no new admission path and changes no binding/schema or SQL.

**U81-B1b integrated service admission** remains: one frozen full candidate/command identity for intake/normalized-or-unchanged Confirm/Start; bound acceptance and verified accepted lineage; authority, input, pins, snapshot and exact-candidate revalidation; source guard before writes; deadline-bounded transaction waits/precommit; immutable dispatch capsule from admitted claim; exact-target safe status/selectionTarget; admission T1-T9/T11/T12/T14 plus real-reader zero-claim and service mutation proofs. It must integrate the B1a execution argument using the full remaining-to-D allowance, with no caller reserve subtraction. Monotonic expiry and wall-clock acceptance remain separate fences.

**U81-B2 SQL/PG integration** remains the complete section 4.4 same-commit set with lead-allocated migration filenames, strict optional record/intent predicates, production-role timestamp/claim freshness, legacy and delayed/copied-record positives, fresh/upgrade/down/refused-down/atomic failure, real PG17 caller barriers, per-fence guard-off and aligned grants/ledger/schema pins. B1b must not be described as SQL-backed completion before B2.

U81-A accepted LOWs: one shared project-preview route regex and direct handler 413 coverage; any structured plan/spec/build/final run-edit member deliberately opts into the complete B8 codec; overrides-only edits now also reject unbound authority fields. D01a must consume the existing exact loopSelectionPresetSchemaV1 five-key export, rather than introduce a second preset parser. Browser response validation and cancellation normalization remain U81-C's client/UI boundary; this execution slice does not change that client.

T-SNAPSHOT accepted LOWs: inode-swap tests retain the same nonce (and the original fence inode in the root-swap case), public file errors are sanitized while internal missing-file bootstrap stays intact, successful COMMIT followed by failed release reports database_outcome_uncertain and poisons custody, and the explicit real-tools script now uses the required anchored test name. The portable command uses the merged branch's exact host-case exclusions; neither inherited skip nor fixture counts are real-tools qualification. Native test timeout now measures the integer remaining-to-D allowance, without an extra reserve.


## D25 — U81-B round-3 spec/code audit stop

The assigned predecessor is a33e097af351374b525160198f1729563afc9750. The round-3 brief supplies isolated PG ports, migration IDs 0316/0317 and cached Squawk, resolving those round-2 inputs. The pre-edit audit found §4.4 still states application/native-public table counts 263/264 and forbids incrementing them, while the assigned predecessor's fixture/candidate/desk assertions agree on 264/265. Per the brief and cr-build step 1, stop before dependent implementation; preserve all current pins and landed migrations. The lead must reconcile the reviewed §4.4 baseline with the assigned predecessor before B1b/B2 resumes. No migration ID is consumed and no admission change is implemented in this round.


## D26 — U81-B round-4 catalog baseline correction

The lead resolves D25: section 4.4 predates the B6/B7 merge, which added one application table. Read its baseline as application 264 / native public 265. U81-B adds no catalog tables; preserve all existing table-count assertions exactly. Round 4 resumes B1b and B2 on af113aee3, with migration IDs 0316/0317 and reserved PG test ports supplied by the lead. This decision supersedes the round-3 baseline blocker.


## D27 — U81-B round-4 exact-binding transport audit stop

Sections 4.2 and 5 require the full checked journal binding and its unchanged digest in selectionDispatch through intake invocation and admissionExpectation. The assigned predecessor has a second intake envelope: when the report-only intakeDriver capability is configured, improve-control-room-loop-service.ts derives loopOwnedIntakeBindingSchemaV1 by adding tenantId, workspaceId, projectId, requestId, ownerIdentityId and settingsDigest to the journal binding, then dispatches that owned envelope. Its digest differs from the checked candidate. The existing adapter rejects a selectionDispatch whose bindingDigest differs from the invoked binding.

The released T-TOOLS contract at 064eb462f3a055da9d3487502108a5292e21eeb0 also closes the selection binding shape. A pure synthetic probe against its actual selectionProjection/admissionExpectation accepts the plain candidate, accepts the owned envelope in the existing product schema, then refuses that owned envelope both with the original capsule and with a recomputed capsule digest. No checker, worker, provider or network is involved. This is conditional on intakeDriver; it is not a claim that the driver-free fixture path fails.

The reviewed plan predates this report-only custody boundary. A lead-reviewed product/tools transport amendment must preserve both the exact checked selection binding and report-only intake custody/receipt/recovery authority. Do not strip custody, alter signed bytes, restamp/rebind after checking, guess a tools mapping or silently disable the capability. Per the explicit spec/code stop rule, round 4 removes its unfinished product/test/SQL/grant/pin edits. Only this baseline decision, the transport finding and evidence/status remain. B1b and B2 remain unbuilt; IDs 0316/0317 are not consumed.

Amendment disposition (§5.1): choose (b), the smallest separate-custody tools extension. Product-only transport on tools pin 064eb462f3a055da9d3487502108a5292e21eeb0 is insufficient: bridge/a2-contract.mjs:674,729 and cr.py:4807–4816 require custody inside the original binding and join its digest to the saved admission. Keep the exact checked binding/digest unchanged; carry authenticated custody beside it, save that custody with the intake admission and join recovery against it. Preserve legacy owned envelopes/receipts without rewriting retained data. Section 5.1 names the exact product/tools files, red-first tests and refusal/replay proofs. A new reviewed tools pin, matching qualification receipt and full `test:loop-selection:host` gate are mandatory before dependent admission resumes; no implementation or green result is claimed here.

Status: amendment specified; U81-B admission BLOCKED pending replacement tools contract, pin and full requalification
