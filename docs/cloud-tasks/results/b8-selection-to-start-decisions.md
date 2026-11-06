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


## D28 — Round-5 transport slice and SQL grant-parser scope stop

The lead supplies read-only tools pin ec2359ece1921a7510ce191cc078ab5e7e3175cb and explicitly assigns full host requalification to the lead. Section 5.1 product transport is retained: new intake dispatch preserves the signed binding and carries server-derived custody beside it; configured intakeDriver requires custody. Driver binding/receipt decoders accept the new plain binding and preserve the retained owned-envelope branch. Product native case inventory extends 38 to 41 children, with no prior title removed or renamed. This is transport evidence, not U81-B admission or worker qualification.

The B1b/B2 experiment reaches a new mandatory spec/code stop. Section 4.4 requires EXECUTE for control_loop_selection_ack_timestamp_v1(text) in private_web_roles.sql. The closed allowedFunctionGrant in scripts/mac-local/database-upgrade-grants.mjs rejects that helper; desiredMacGrantsV1 throws upgrade_grant_source_refused in the required native upgrade tests. That file is absent from the reviewed complete same-commit set and the allowed paths. A pure one-variable probe accepts the restored predecessor role files and refuses them with only the required helper grant added. No allowlist widening is improvised.

Only transport implementation/tests/registration remain in the product tree. All dependent B1b/B2 SQL/grants/pins/service/schema/test experiments are retained in ignored scratch for the lead, and restored out of the submitted product. Migration IDs 0316/0317 remain unconsumed, baseline counts stay 264/265, and no new schema pin is submitted. The continuation must name the narrow grant-parser amendment and its existing tests, then finish B1b/B2, all down/re-up ordering, signed legacy upgrade, SQL/service guard-off and timing evidence, complete required lanes and independent reviews. The Git index lock was refused, so the lead must commit the retained changes; no new commit is claimed.


### D28 round-6 authorization superseding the grant-parser stop

Choice: The lead explicitly authorizes the one exact timestamp-helper EXECUTE allowlist entry in the Mac upgrade parser and its existing regression tests, as part of section 4.4's same-commit grant set. Resume B1b/B2 on 666bc96c1c9ebe0bd6bffad0d0f57b2a7acb475d; section 5.1 transport is already committed there. This supersedes only the scope stop recorded above.
Options: leave the mandated grant refused; authorize this single function signature for private-web only.
Why: the helper is read by the acknowledgement CHECK as the production web login. Regression proofs must reject every other role/signature, while allowing the exact desired grant and application. No general function allowlist expansion is authorized.
Affected spec item: 4.4 complete same-commit set; migrations 0316/0317; D28 historical round-5 stop. Baseline counts remain 264/265. Full host requalification stays lead-owned on reviewed tools ec2359ece1921a7510ce191cc078ab5e7e3175cb.


### D28 round-6 reproduced second-boundary stop

The authorized single allowedFunctionGrant entry makes desiredMacGrantsV1 accept the exact helper grant, but grantSql independently refuses the same grant because knownFunctionGrant does not recognize that function. An executable regression reaches applyMacGrantDiffV1 with the exact missing helper tuple and fails upgrade_unexpected_function_grant before any SQL. This is the next-door convergence boundary of section 4.4, not a provider or database error. The continuation explicitly permits only the allowedFunctionGrant entry, so adding the separate knownFunctionGrant entry is outside that narrow authorization.

A scratch-only single-variable probe shows: authorized entry alone accepts desired source but refuses application with zero SQL calls; adding only the exact known signature in a disposable module permits the exact private-web GRANT and still refuses a wrong role/signature; the original control refuses again. No database was opened. No broader allowlist change is submitted. The required continuation must authorize that second exact knownFunctionGrant signature entry and its existing convergence regression, then resume B1b/B2 with the complete same-commit set. All dependent product/SQL/test experiments are preserved in ignored scratch and restored out of this candidate; migration IDs remain unconsumed.

Boundary suite baseline at unchanged 666bc96c1: 11 tests, 2 pass, 9 fail, zero skips. The restored draft plus the authorized entry produces the same nine failing titles and counts; the final restored product does too. These failures pre-exist this round. No boundary implementation or test was edited.

### D28 round-7 authorization: complete timestamp-helper convergence

The lead authorizes every grant-table entry needed for this one function to converge, including allowedFunctionGrant and knownFunctionGrant, plus existing regression tests. Add only public.control_loop_selection_ack_timestamp_v1(text); desired and applied grants remain private-web-only. No other function expands. The unchanged predecessor boundary suite reproduces 2/11 pass and 9/11 fail, so it is reported without repair. Resume preserved B1b/B2 and retain the 264/265 baseline. Full host gate remains lead-owned.

### D28 round-7 implementation and remaining gates

Both exact timestamp-helper grant checks are implemented; the existing regression proves desired-source acceptance, exact private-web GRANT, excess-grant REVOKE and wrong-role/signature/version refusals. No other function is added. B1b service and B2 same-commit migration/grant/pin/ledger candidate are retained for review; IDs 0316/0317 are no longer described as unconsumed in this candidate. Catalog counts remain 264/265. Prior round-5/6 scope stops are historical and superseded.

The preserved rollback drafts needed forward/reverse ordering repairs in the allowed desk, candidate and bridge PG suites. These are migration integration changes; signed data and landed migrations remain unchanged. Source guard/eligibility/deadline/replay/provenance tests distinguish checked candidate authority from preview and from a merely retained claim.

The lead still owns full host requalification on tools ec2359ece1921a7510ce191cc078ab5e7e3175cb. Missing cached Squawk/Chromium, exact-head independent reviews, Linux parity and final checks withhold BUILD-READY. An index.lock refusal prevents staging/commit in this builder session; retained candidate needs a lead commit and exact-head gates. No readiness or actual-worker authorization is inferred.

### R7 deciding next-door regression

Required P71 real-provider intake fails in the retained draft: the existing native defaults already have structured roles/counts, so the broad B8 detector sends a legacy no-context caller into mandatory B8 guard admission. This caller has neither a selection guard nor the later configured-provider selection hook. Section 4.2 requires preserving that legacy lane, while sections 3/5 require B8 missing-guard/provider-hook refusal. A generic fallback or rewriting the existing positive would weaken those fences. Stop dependent implementation pending a reviewed server-derived discriminator for native legacy settings versus new product B8 commands, including retained Confirm/Start. D28 grant convergence is resolved; the rest is a blocked draft, not completed B1b/B2. Independent code/attack/CI reviews and full qualification remain pending.

R7 final: HIGH 1 / MEDIUM 1 / LOW 0. The additional MEDIUM is the P72 empty-down/re-up case in tests/loop-policy-enforcement.test.ts, whose chain also needs acknowledgement migrations but is outside the exact allowed file set. Leave it unchanged pending the lead's narrow test-ordering authorization. Full improvement: 913 tests, 902 pass, 7 fail, 4 inherited skips; initial full improvement PG: 86 tests, 79 pass, 7 fail, zero skips, with the repaired seven bridge chains subsequently 7/7. Production ledger prefix: 3/3; main production: 118 tests, 79 pass, 39 fail; seven caused grant-pruner failures repaired and rerun 7/7, remaining 32 unchanged setup-hook errors not qualified. No consolidated broad PASS is claimed.

The redundant production_table_grants.sql DO grant was removed after it broke the existing grants pruner. That file matches HEAD; helper EXECUTE is granted by the authorized private-web role source and converged by the exact known/allowed helper entries. Final ledger verification and grant regression 23/23 pass; final native SQL/20-caller/deadline-lock lane 2/2 passes. No table-count or schema-pin weakening. The legacy routing regression and missing P72 allowed-test entry remain blocking. Candidate is a retained uncommitted draft; staging was refused. All started foreground commands returned; native harness teardown and final cleanup are recorded externally.

Status: BLOCKED: next-door legacy P71 compatibility FAIL; P72 rollback chain outside allowed set


## D29 — Request-scoped server issuance, retained per input

Choice: replace the process profile with §4.2.1's fixed server issuance boundary. NEW authenticated `selection-intake` calls NEW `intakeSelection` and issues product-b8; existing description-only/native intake remains native-p71 in **both real app factories**. A required, runtime-validated private origin argument has no missing/default-to-native behaviour. Both operations retain the existing closed intake body and journal operation; no client kind, process mode, new table or binding field. Preview remains pure. The later B8 panel must use the B8 operation.

Lead-accepted residual (round 3, option b): legacy/native intake keeps dispatching structured settings exactly as at HEAD, with existing P71/P72 policy locks, settings validation and B7 paid admission. A caller may choose that legacy operation for selection-bearing settings. U81-B is the product-B8 lane boundary, **not an anti-bypass boundary for the legacy lane**; no tools-side rejection without a selection expectation is claimed. Reason: the unchanged native P71 real-provider positive must keep accepting structured defaults. The kind cannot be forged and retained B8 rows cannot be downgraded; new legacy requests still have this accepted compatibility path.

Options: existing saved snapshot/policy fact; text/guard/config inference; server issuance at intake. T-SNAPSHOT is shared current state and native P71 also saves policy source rows, so no existing per-request discriminator suffices. Persist explicit `admission_kind` in the immutable source row with signed input/claim, copy it exactly and resolve retained Confirm/Start/selectionTarget/status by verified lineage, comparing copied kind with version 1. For provenance-bearing requests, missing/invalid/disagreeing version-1/current provenance blocks new admission with typed `WebAccessError("service_unavailable")`/503; status keeps the request visible with the existing UNAVAILABLE gate. Database PK/triggers supply immutability, not a claim to detect arbitrary out-of-band replacement of the sole fact. Historical signed 0301-before-0310 lineage with **no source rows at any version** preserves native Confirm/Start/status and no-source copy behaviour, never B8 authority. That exception relies on verified absence of any earlier B8 writer, atomic mandatory version-1 source creation on every new intake and immutable rows; a B8 source-insert failure rolls back the request. A missing current/version-1 row when any source exists refuses B8 Confirm/Start, with status blocked/UNAVAILABLE. Resolve status provenance explicitly outside the old selection projection catch and before the unlinked-intake early return. Cross-endpoint key reuse conflicts; exact same-endpoint replay never remints or redispatches.

Migration: allocated A=0316 / Av=0317 supersede §4.4's historical placeholder-allocation sentence (that sentence is outside this amendment's allowed edit scope); keep D30's numbers/order. Catalog-add the NOT NULL column with temporary native-p71 default, drop that default in the same transaction, and validate the legal-value CHECK in 0317. No row UPDATE or trigger surgery. Backfill requires proof no product-B8 writer predates deployment; otherwise stop rollout. Down refuses retained product-b8 rows even without acknowledgement. Name both concerns in all four migration/down headers.

Why/checks: unchanged P71 provider positive and real-factory description-only intake stay accepted without B8 context; B8 missing guard/source/projection/provider hook refuses with zero additional writes/claims/dispatch. Native true acknowledgement intent refuses. Each real factory must also prove the accepted residual through legacy structured-body intake/Confirm/Start with a recording adapter: exact signed settings bytes/hash, no admission checker context, no `selectionDispatch` expectation and no worker launch. Identical-body unguarded B8 still refuses with zero claims. §4.2.1 names exact files, every B8 fixture's issuance method, retained/copy/status/backfill tests, real-factory tests and separate guard-off checks. Guard wiring changes `src/web/v1/improve-control-room-loop-service.ts`, `src/web/v1/private-process.ts` and `src/web/v1/mac-local-web-process.ts`: pass raw `loopSources`, with NEW server-only `selectionReady?: () => boolean` (absent/false/throwing refuses B8); factories make it true only after source start, seeded/exported roster start and initial capture succeed. Check readiness inside the existing candidate budget; preserve coordinator `instanceof`, deadline binding and transaction-alias registration before `assertCurrent`. Do not reuse the preview wrapper; `loop-selection-snapshot.ts` needs no change. Startup/B5 recovery constructors need no new config forwarding or classification default. D30 stays unchanged. Sensitive: run admission, retained data, SQL and concurrency; Frontier builder. The required qualified-host command explicitly executes all five constrained test files, including `loop-selection-native.test.ts`; the native real script remains required. Open qualification items are the real-factory dispatch, historical upgrade, readiness/alias positive and provider/PG17/host evidence; none is claimed executed here. This document-only amendment claims no executable fix or qualification; independent review and later BUILD gates remain required.

## D30 — Lead authorization: P72 empty-down/re-up ordering only

Choice (lead decision already made): `tests/loop-policy-enforcement.test.ts` may change only its existing `P72 empty enforcement down re-up restores exact shape and retained unlocked layers refuse` chain (about lines 328–345): unwind `db/down/0317_control_loop_selection_acknowledgement_validate.sql`, then `db/down/0316_control_loop_selection_acknowledgement.sql` before the existing 0315/0314 downs; after the existing 0314/0315 ups and validation assertions, restore `db/migrations/0316_control_loop_selection_acknowledgement.sql`, then `db/migrations/0317_control_loop_selection_acknowledgement_validate.sql`, before the final restored-shape assertion.
Why: R7 MEDIUM F2 needs reverse/forward dependency order. Keep the predecessor digest assertion and existing retained-layer/refused-down assertions exactly; no other change to that file is authorized. This spec run records the decision only and leaves the test untouched.
Check (REQUIRED in later BUILD): `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^P72 empty enforcement down re-up restores exact shape and retained unlocked layers refuse$' tests/loop-policy-enforcement.test.ts` must pass its predecessor and restored digest assertions without skips/quarantine. Retain native PG17 migration integration gates from §9/10.
Affected spec item: 4.4/9; narrowly supersedes D28's R7 P72 allowed-file stop, not its other outstanding gates.


## D31 — Lead authorization: P71 empty-downgrade ordering only

Choice: the existing P71 empty-downgrade chain may unwind 0317 then 0316 first and, where restoring migrations, restore them last, matching D30's dependency order. Preserve its predecessor digest assertion.
Options: leave the new acknowledgement/provenance schema in the predecessor digest; unwind the dependent pair before the existing chain.
Why: the lead explicitly authorized the latter in the round-8 continuation. The retained draft already adds the two downs; the existing P71 test has no forward restore chain. No predecessor assertion was changed. Final verification remains pending.
Affected spec item: 4.2.1/4.4/9; no broader policy-test changes are authorized.

## R8 scope stop — typed unavailable constructor

The round-8 LOW-2 instruction and D29 require a real `WebAccessError("service_unavailable")`. At the build base, `src/web/v1/access-verifier.ts:7-8` excludes `service_unavailable` from the constructor's code union. `http-common.ts` already maps that code to HTTP 503. The constructor file is absent from the exact allowed files. TypeScript rejects all six new typed uses. Per the continuation's spec/code stop rule, dependent implementation stops; no cast, generic-error substitute or out-of-scope edit is made. A narrow authorization to add that one union member is required before resuming. The retained candidate is incomplete and unqualified.


## D32 — Round-9 additive type authorization

The lead authorizes adding service_unavailable to WebAccessError's code union in src/web/v1/access-verifier.ts. This single additive type member admits D29's required typed HTTP 503 refusal; http-common already maps it. No existing caller behavior changes. Round 9 also permits strictly additive types/constants/exports/test registration outside named files when required by the spec, with each file and reason listed in the report. The historical R8 constructor scope stop is superseded; all executable qualification remains required.


## R9 required down/re-up conflict (not a new policy decision)

D32's additive constructor member compiles. D29 factory/provenance recording cases pass in both real applications. Required native PG17 and unchanged D30 P72 restoration checks expose a separate conflict: section 4.2.1 ADD/DROP admission_kind changes its physical attnum from 7 to 8 after down/re-up. The product and updater schema readers both include attnum. A disposable PG17 catalog comparison finds exactly one differing digest row, control_loop_policy_input_sources.admission_kind; all other manifest rows are identical. Fresh digest is 2bbd9c8d6a2ec92afc08b8d6eccb101b11293842e20ec3c22be4b0618062a2f6; re-up digest is 1c2f8faf3fbde0cf4b315386ec94410d6c3b624038139521839c4e5d579581bd. Predecessor digest assertions remain unchanged and pass before re-up.

Stop dependent B1b/B2 implementation under the brief's spec/code rule. No catalog edits, reader normalization, weakened assertion, table recreation, signed row rewrite or trigger surgery is chosen. The lead must supply a reviewed rollback/digest design consistent with the retained-history and exact-shape requirements. B1a checker execution and D27 transport are existing committed seams; D32 alone is a completed additive type fix. The retained admission/provenance/SQL candidate remains incomplete. Missing historical upgrade, all-versions-empty cross-endpoint, unlinked-status and remaining qualification evidence must still be finished after the conflict is resolved.


## D33 — Admission-kind storage without physical column drift

Choice: use NEW 1:1 `control_loop_policy_input_admissions`. Replace only D29/§4.2.1's storage/backfill/rollback instructions; all other issuance, copy, historical-native, readiness and refusal rules remain. No reversible migration may ADD/DROP a column on an existing table. D30/P72 and native PG17 exact restoration gates remain unchanged.

Option (1) is unsafe within that contract: 0310's `control_loop_policy_input_sources` has only `tenant_id`, `request_id`, `input_version`, `defaults_sha256`, `layer_versions`, `waiver_id`. Its immutable `layer_versions` permits exactly numeric `project`/`selection` and is unsigned; `defaults_sha256` is a hash and 0314 makes `waiver_id` a waiver FK. No signed metadata exists. 0301's signed immutable `control_loop_improvement_inputs.description/settings_text` are exact engine bytes, checked with their hashes by `service.ts`'s `#verifyLoop`; settings are caller-composed in `loop-policy-compose.ts`, with no reserved server metadata slot. Adding/stripping a marker changes checker/dispatch bytes or breaks saved/observed hashes. Its signed `idempotency_key` is caller supplied and replay-bearing. Do not overload keys, hashes or authentication tags. Option (2) is the only safe storage-only mechanism found. It needs a **lead D26 amendment: application 264→265, native public 265→266** after up, reverting on down. D33 proposes this exception; it does not authorize implementation/count-assertion edits.

0316/0317 outline (same allocated filenames, transaction/timeouts and acknowledgement SQL; all four headers name both concerns):

- **0316 up:** replace source-column DDL with the following. Before rollout prove no deployed product-B8 writer ever existed; otherwise stop for review. Backfill every source version, never update sources/signed history or disable triggers.

```sql
CREATE TABLE control_loop_policy_input_admissions (
  tenant_id text NOT NULL, request_id text NOT NULL,
  input_version bigint NOT NULL, admission_kind text NOT NULL,
  PRIMARY KEY (tenant_id,request_id,input_version),
  CONSTRAINT control_loop_policy_input_admissions_kind_check
    CHECK (admission_kind IN ('native-p71','product-b8'))
);
ALTER TABLE control_loop_policy_input_admissions
  ADD CONSTRAINT control_loop_policy_input_admissions_source_fk
  FOREIGN KEY (tenant_id,request_id,input_version)
  REFERENCES control_loop_policy_input_sources(tenant_id,request_id,input_version)
  ON DELETE RESTRICT NOT VALID;
CREATE TRIGGER control_loop_policy_input_admissions_immutable
  BEFORE UPDATE OR DELETE ON control_loop_policy_input_admissions
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
CREATE TRIGGER control_loop_policy_input_admissions_no_truncate
  BEFORE TRUNCATE ON control_loop_policy_input_admissions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
INSERT INTO control_loop_policy_input_admissions
  (tenant_id,request_id,input_version,admission_kind)
SELECT tenant_id,request_id,input_version,'native-p71'
FROM control_loop_policy_input_sources;
```

- **0317 up:** retain both command CHECK validations; replace source-kind validation with `ALTER TABLE control_loop_policy_input_admissions VALIDATE CONSTRAINT control_loop_policy_input_admissions_source_fk;`. Its kind CHECK is valid from creation. Mirror source SELECT/INSERT grants, including `control_room_private_web`, through §4.4's existing role/convergence files; no mutation grants. Regenerate ledger/digests/fixtures together after the lead decision.
- **0317 down:** retain command unvalidation; replace source-kind handling with `ALTER TABLE control_loop_policy_input_admissions DROP CONSTRAINT control_loop_policy_input_admissions_source_fk;` and the exact FK ADD above, restoring NOT VALID atomically.
- **0316 down:** before DDL, `LOCK TABLE control_loop_policy_input_admissions, control_loop_improvement_commands IN ACCESS EXCLUSIVE MODE;`. Refuse SQLSTATE 23514 if `EXISTS (SELECT 1 FROM control_loop_policy_input_admissions WHERE admission_kind='product-b8')` OR either existing acknowledgement predicate, including unacknowledged B8. Otherwise `DROP TABLE control_loop_policy_input_admissions;` without CASCADE, replacing the column drop; retain predecessor command/helper rollback. Refused down changes nothing and concurrent writers cannot race the check.

Reads/writes: `recordInputSources` inserts exactly one source/admission pair atomically with signed input/claim; no kind default. `copyInputSources` copies exactly one pair and kind or refuses typed 503. Join the pair through verified owned signed lineage for Confirm/Start/selectionTarget/status; version 1/current must agree. The side fact is immutable, not independently signed, under D29's existing threat model. Do not manufacture sources/admissions for 0301-before-0310 inputs: verified **all-versions-empty** source history retains native Confirm/Start/status/no-source copy only, never B8 authority. Any source makes missing/invalid/disagreeing version-1/current pairs refuse 503/blocked UNAVAILABLE. Query failure is not empty.

REQUIRED later BUILD reds in D29's existing five test files: unchanged six source columns/attnums; production-login duplicate/orphan/null/unknown-kind and UPDATE/DELETE/TRUNCATE refusal; pair insert/copy failure rolls back all rows/claims; retained/copy/version-1/current/cross-lineage/replay checks; real 0301-before-0310 native upgrade and every-version backfill preserving signed bytes/tags; all-versions-empty B8 refusal; ambiguous-history rollout stop; unacknowledged B8/acknowledgement and concurrent insert/down refusal. Keep factory/native positives and guard-off tests. Current column draft is red for physical restoration; these new tests are requirements, not executed evidence.

REQUIRED after implementation: run D30's exact named P72 command and the five-file D29 command from the amendment report, including qualified native PG17 fresh/upgrade/down/re-up/refused-down. Pass without quarantine/skips. Keep predecessor digest literal, restored equality and both product/updater attnum readers byte-identical. Existing tables never gain dropped-column slots; recreate the new table whole in the same column order with identical constraints/triggers/validation/grants, so fresh/restored manifest bytes must match exactly. Regenerate fresh pins for the new table; never change the predecessor pin or accept an alternate digest. This is a design argument, not PG17 qualification.

Sensitive: admission, migrations, retained data, grants and concurrent rollback. Frontier builder; production-login database, guard-off, contention and independent attack/CI reviews remain required, followed by the assigned reviewer. Open decision: lead approval of the exact D26 count exception. No build in this amendment.


## D34 — Lead authorization: D33 catalog counts

Choice: application tables 265 / native public 266 after 0316/0317 up; restore 264/265 after down. Update existing fixture/count assertions. D33 adds one new table without modifying existing column positions.
Options: retain zero-table counts; count the new immutable side table.
Why: the round-10 lead explicitly authorizes the measured table-count amendment; no digest-reader or predecessor-pin changes.
Affected spec item: 4.2.1/4.4.

## D35 — Lead authorization: exact pair integrity and rollback grants

Choice: source→admission FK DEFERRABLE INITIALLY DEFERRED plus restrictive admission→source FK and shared PKs enforce exactly one-to-one at commit. Native backfill precedes the reverse FK. 0316 down locks both tables and commands, refuses retained B8 before dropping the table; remove reverse FK before DROP without CASCADE. 0317 down leaves pair FKs validated until 0316 down, avoiding unnecessary NOT VALID re-add. P72 re-up reapplies role SQL and asserts private web INSERT privilege separately from shape digest, which excludes ACLs. Correct obsolete spec referents, column instructions and fixture comment.
Options: application-only pair discipline; commit-time database pair constraint.
Why: round-10 lead decisions resolve D33 review MEDIUM-1/2 and LOW-1..4. Exactly one-to-one is a commit invariant; inserting source then admission in one transaction remains valid. D33's earlier 0317-down outline and pending-count caveat are superseded by D34/D35.
Affected spec item: 4.2.1/4.4/9; P72 chain amendment only.

## R10 CI registration detail — allocated PG test default

Choice: the new PG test file defaults to the lead-allocated port base 60520 when no override is supplied; explicit CONTROL_ROOM_PG_TEST_PORT_BASE still controls the same reserved range. No product or existing test default changes.
Options: make CI export a job-specific override; give this new test its already allocated default.
Why: the registered component lane supplies PG_BIN but no port variable. An unset port previously became NaN and prevented its deciding assertions. The focused native PG entry point passes with the override removed, as does the full lane with the supplied override.
Affected spec item: 4.4/9, new test registration; Linux runtime parity remains a later gate.


## R10 historical pre-journal draft key

Choice: when the B8 admission transaction's saveLoopDraft returns replayed, call the existing owned-lineage kind assertion before source/admission insertion or waiver consumption. A historical-native draft refuses typed service_unavailable; native issuance is unchanged.
Options: treat a matching raw draft key as fresh B8 issuance; preserve the saved lineage's historical-native classification.
Why: section 4.2.1's all-versions-empty rule and the round-8 LOW-4 require B8 refusal when no kind exists to compare. A pre-journal signed draft can have an input idempotency key without any command claim. The regression test showed that reusing that key previously minted product-b8 provenance and dispatched; the new guard returns 503 with every row unchanged. It adds no discriminator or new public mode. A separate guard-off mutation and required consolidated reruns verify the fence.
Affected spec item: 4.2.1, T8 historical/cross-endpoint replay.

## D36 — Defer B8 Start; refuse before its one-shot claim

Choice/recommendation: B. U81-B keeps B8 intake/Confirm and returns typed `WebAccessError("service_unavailable")` / HTTP 503 for every new product-b8 Start after authorized exact replay lookup and verified provenance, before allocation, admission writes or dispatch. Status shows `canStart:false`. Successful B8 Start and renewal move to **U81-S — subscription-launcher Start**, with a separately reviewed launcher admission/tools contract. No implementation is made by this amendment.

Options: A adds a server-only launcher admission variant and real-adapter/tools proof for the complete free/subscription lineup; B adds a pre-claim refusal fence and defers successful Start. Neither depends on U83a for launcher-only selections. Native P71 has no reusable launcher-only path: adapter `resolveStartRoute` requires saved providerRoute and concrete `start` requires body.route/admission (`improve-control-room-loop-adapter.ts:1096–1144`); native service supplies installed provider/model mapping even for subscription launchers (`improve-control-room-loop-service.ts:978–988,1054–1074`; `loop-provider-service.ts:201–225`). Reuse of the native configured-provider path alone cannot satisfy A.

Why/cost: B is the smallest safe first change, preserving B7 mapping, paid fences and signed history. Owners can prepare/confirm B8 but must wait for U81-S to start; M9 and end-to-end green remain unmet. Current B8 inserts its one Start claim without startAdmission and only then fails at the adapter; an unconditional post-claim refusal is unacceptable. Known failed/refused admission must leave no new committed Start claim; retain existing uncertain claims/reconciliation and never delete append-only history or redispatch them.

Required regression: **`U81-B D36 failed Start leaves no committed claim through real adapter`**, plus the PG17 production-login sibling, checks typed 503, unchanged row sets, zero workers and retry/concurrency safety; guard-off must fail on the intended assertion. §4.2.2 gives exact files, alternative A, native evidence, commands and sensitive review gates. Those tests are requirements, not executed evidence. This resolves the R11/independent review MEDIUM-1 specification conflict; the implementation defect remains until a later BUILD passes them.

Affected spec item: new 4.2.2; 4.2 candidate scope and 8.1 seam lines. Earlier successful Start/renewal promises and tests apply to U81-S; launcher-only preview/Prepare/Confirm remain independent of U83a.
