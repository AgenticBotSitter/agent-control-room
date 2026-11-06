# b8-selection-to-start (U81) — PLAN specification r5

Phase: PLAN. This document is ready for independent specification re-review; no CLEAN verdict is claimed. It authorizes no implementation, model launch or paid execution.

- Delivery base: `cloud-base/b8-selection-to-start` at `fa673cc8f81ce1dac457ce383b47b2f3ac31f026` (one task/playbook commit above source).
- Source base: `cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a` (verified on origin; ancestor of the delivery base; the only diff is the two task documents).
- Revision branch: `plan/b8-selection-to-start` from `origin/cloud/b8-selection-to-start` at `43f09d589fcea359653a9d500f706bc61c999db3`.

Contract reference: **approved B8 selection spec R4** governs the selection shape, launcher/provider distinction, acknowledgement scope and final-family restriction. The separate browser override-name amendment in §2.4 is recorded explicitly; sibling plans are consumers, not a substitute contract.

## 0. Goal, owner musts and approved exclusions

U81 delivers one end-to-end admission feature. An owner edits a B8 lineup selection and sees a pure server preview: the checker's single eligibility decision and reasons, the final reservation, role efforts and review counts. The owner then prepares an immutable request whose bytes match that preview, confirms the exact saved draft, and starts it separately. An ordinary review-family conflict is admitted only with a freshly bound, server-derived acknowledgement that the checker itself evaluates.

| # | Owner must | Behaviour (section) | Proof (section 9) |
|---|---|---|---|
| M1 | Selection = plan/spec/build/final slots + plan/spec/code review arrays, counts 0–3/0–3/1–3; slot = model/launcher route/effort | Strict B8 projection codec on preview **and intake** (2) | T1, T2 |
| M2 | Five preset roles map to spec/spec_reviews/build/code_reviews/final; plan roles independent | Five-role projection (2.1), consumed later by D01a | T1 |
| M3 | Final never shares builder family (incl. fallback/either override); never waivable | Checker-owned rule; acceptance context can never satisfy it (4, 6) | T5, T7, R-tools |
| M4 | Only ordinary review-family conflict is acknowledgeable; preview creates no authority | Pre-stamped bound record evaluated by the checker (4) | T6–T9 |
| M5 | Paid consent, cap, family acknowledgement never saved in selections/presets/defaults | Codec refusals + P71 layer `overrides` refusal (2.3) | T3 |
| M6 | Each new run resets overrides; installed defaults cannot restore them | Explicit false run reset (2.4) | T3 |
| M7 | One P71 selection layer; non-B8 members preserved; whole-layer save at current expectedVersion | Layer codec `mergeSelectionLayerV1` (2.3); save control deferred to U82 | T4 |
| M8 | No silent model/route replacement, seeded lineup, preset cap or automatic default | Requested vs effective reported; no fill (3) | T2, T10 |
| M9 | Start uses exact saved bytes and current checks | Admission check of saved bytes at Confirm/Start (5) | T11, T12 |
| M10 | Editing invalidates preview/Confirm/Start and resets acceptance; honest UI | Panel state machine across intake, decisions and run panel (7) | B1–B6 |
| M11 | Native paid readiness remains false | `paidExecutionReady:false` unchanged; paid slot ⇒ product blocker (3) | T10 |

Approved exclusions: saving selections, last selection and current-route revalidation (U82); presets (D01a); default pointer and editable Start (D01b); provider chooser and offers (U83a); the paid-run mechanism (U83b); P72 locked edits and scoped waivers; any change to the policy, provider or paid-run implementations beyond the additive hooks named in section 8; any real-model launch.

## 1. Existing code and caller facts (inspected at the delivery base)

| Area | Fact | Location |
|---|---|---|
| P71 composer | `composeLoopSettingsV1({defaultsText, project?, selection?, runEdits?})` → `{text, sha256}`. Deep merge: objects merge, arrays and scalars replace. Canonical sorted encoding with a trailing newline, 64 KiB cap. | `src/web/v1/loop-policy-compose.ts:40-50` |
| P71 parser | `parseLoopSettingsV1(text, layer)`: strict JSON, no proto keys, no secrets. Layers may not contain `overrides`; run edits may. | `loop-policy-compose.ts:12-27` |
| P71 service | `LoopPolicyServiceV1(db, scope, tools:{settingsText, checkSettings?(text)})`. `snapshot(tx, projectId, runEdits?)` locks both layers `FOR UPDATE`. Also `assertSnapshot`. `check(snapshot)` returns nothing, throws `LoopPolicyRefusedV1(reasons)` when ineligible, and throws `loop_policy_check_unavailable` when there is no checker. Also `view`, `put` (check outside the transaction, recheck under locks), and `recordInputSources`/`copyInputSources` with `waiverId: null`. | `src/web/v1/loop-policy-service.ts:59-143` |
| P71 HTTP | `GET /api/v1/projects/:id/loop-policy`, `PUT …/loop-policy/(project\|selection)`; 422 `policy_refused` with reasons; query strings refused | `src/web/v1/loop-policy-http.ts` |
| Checker | `LoopAdapterV1.checkSettings?(text)` spawns `cr.py check lineup --settings <tmp> --availability <file> --json`. It accepts exit 0/3 only and decodes exactly `{eligible, reasons[{code, explanation}]}` (strict, sanitized). **No projection or context argument exists.** | `src/web/v1/improve-control-room-loop-adapter.ts:250,651-697` |
| Roster | Export columns `name, launcher, provider, family, class, roles, efforts, default_effort, cost, on, note, nick, max_build_grade`; rules stay in `cr models check` | `src/web/v1/loop-roster-columns.ts` |
| Provider routes | `LoopAdapterV1.providerRoutes?.{resolveStartRoute(settingsText), paidExecutionReady:false}`; `loopProviderRouteSchemaV1 = {providerId, model}` | adapter `:108,243,701` |
| Loop wire | Intake body `{description, settingsEdits?}`; confirm `{expectedVersion, expectedRevision, requestSha256, settingsSha256}`; start `{expectedVersion, expectedRevision, runLinkId}`. Strict `loopBridgeBindingSchemaV1` (schemaVersion 1, 15 keys). The effort enum is inline in `improvementTemplateChoiceSchemaV1` (not exported). | `src/improve-control-room/v1/schemas.ts:21,175-217` |
| Loop service | Intake flow: `policy.snapshot` in a transaction, then `policy.check` **outside** it, then `assertSnapshot` under authority→project→head→layers locks. Then `saveLoopDraft` with the composed text, `recordInputSources` and a signed claim. `#dispatch` runs inside the freshness window (`beforeSpawn`), then `#complete` runs under locks. Confirm revises the draft when the engine normalizes the description (detected from the observed status before the claim). An earlier-confirm lookup by `binding->>'localVersion'` exists. **No policy check runs at Confirm/Start.** | `src/web/v1/improve-control-room-loop-service.ts:514-745` (confirm lookup `:611-615`) |
| Journal | `#verify` (digest + HMAC `loop-improvement-command/v1`), `#verifyResult`, `#pins`. One Start claim per request. Exact key/body replay. Uncertain claims are never re-executed. `actor.now` stamps the claim inside the admission transaction. | same file `:67-133,559-705` |
| Desk lineage | `saveLoopDraft`, `reviseLoopDraft`, `recordLoopRunLink`, `authorizeLoopStart`, `loopBridgeLineage`. `loopBridgeTransaction(identity, projectId, mutation, op)`: a mutation needs `tasks.propose` high plus the project `FOR UPDATE` lock; a read needs `projects.read` low. | `src/improve-control-room/v1/service.ts:491-700` (`:663-680`) |
| Adapter admission | Each non-stop command writes `expect.json` from `contract.admissionExpectation(binding, {operation, commandId})`. Intake/start write the signed `settings.json` copy. `available(op)` requires `qualifiedOperations` + `admissionExpectation`. | adapter `:225-230,476-512` |
| SQL | The `binding` column CHECK closes the top-level key set (15 keys). `control_loop_improvement_commands_check1` closes per-operation body keys. 0306 replaced `check1` NOT VALID to admit `settingsEdits`; 0307 validates it. The 0306 down refuses retained `settingsEdits` rows (23514). | `db/migrations/0302…:13-38,49-86`, `0306…:58-80`, `0307…`, `db/down/0306…` |
| HTTP routes | `…/improvements/loop/(desk\|intake\|:rid/(status\|approval-document\|confirm\|start\|stop\|approve\|answer))` | `src/web/v1/improve-control-room-http.ts:26` |
| Process wiring | Loop policy/provider/roster handlers are registered in `mac-local-web-process.ts:330-348,886` and `private-process.ts:971-973` | — |
| UI | `improvement-intake-form.tsx` (description only), `improvement-decisions.tsx` (Confirm/approve/answer), `improvement-run-panel.tsx` (Start/Stop; mounts decisions), `improve-control-room-workspace.tsx` (mounts run panel and intake form) | `private-app/app/` |
| Lanes | All scripts named in 9 exist except the NEW ones marked NEW | `package.json` |
| Absent | Nothing in loop policy, loop service, adapter, schemas, SQL or UI implements R296, a family policy, a review-only family rule, a lineup projection, `acceptSameFamilyRisk` or `sameFamilyAcknowledgement`. The only "review-only" matches are unrelated (news/task-assignment code). `cr.py` is not in the repository. | evidence |

## 2. One shared selection codec (NEW `src/web/v1/loop-selection-wire.ts`)

### 2.1 Approved closed shape, consumed by all four sequential chunks

```ts
export const loopSelectionEffortSchemaV1 = z.enum(["default","low","medium","high","xhigh","max"]); // NEW export, schemas.ts:21 values
type Effort = z.infer<typeof loopSelectionEffortSchemaV1>;
export type LoopSelectionSlotV1 = { model: string; route: string; effort: Effort }; // route is a launcher
export type LoopSelectionV1 = {
  roles: { plan: LoopSelectionSlotV1; spec: LoopSelectionSlotV1; build: LoopSelectionSlotV1; final: LoopSelectionSlotV1;
    plan_reviews: LoopSelectionSlotV1[]; spec_reviews: LoopSelectionSlotV1[]; code_reviews: LoopSelectionSlotV1[] };
  plan_review_count: number; spec_review_count: number; code_review_count: number;
};
```

Export NEW strict `loopSelectionSlotSchemaV1` and `loopSelectionSchemaV1`. Model and route preserve roster-valid strings without independent 128/64/32-byte restrictions; the roster columns export names, not a grammar or eligibility validator. Retain the existing secret/control-character rejection and overall settings/body budgets. The checker validates roster membership, launcher compatibility and the released effort vocabulary. Route is the launcher name, not providerId/base address; effort is the enum above. A roster-valid 129–179-character model must survive the codec unchanged, as must any longer string accepted by the released roster/checker contract; do not import the separate providerRoute model limit into B8 slots. Every object is closed. Counts are integers 0–3/0–3/1–3 and equal their matching array lengths. No schemaVersion, flat/camelCase role aliases, launcher key, overrides, consent, cap or acknowledgement inside selection JSON. Reject extra keys and secret material. Repeated models/types are structural positives; only the checker decides their eligibility.

D01a imports this exact slot schema. Its stored strict five-role projection has **only five top-level keys** spec/spec_reviews/build/code_reviews/final, as its existing plan specifies; it has no roles wrapper or independent persisted count keys. Pick copies these into the full selection.roles and derives matching spec_review_count/code_review_count from their arrays; plan/plan_reviews/plan_review_count stay independent. Thus preset array bounds use the same shared count rules without two conflicting count encodings. Its projection never includes overrides or providerRoute. No product slot-family/role-eligibility export exists or is added: catalog annotations are informational, and eligibility always comes from the shared checker preview.

### 2.2 Persisted selection and run-edit parsing are separate

NEW `encodeSelectionEditsV1(selection, overrides)` emits the full approved roles/count fields and a separate run-only overrides object; NEW `decodeSelectionEditsV1(text)` projects/validates those fields and returns `{selection, overrides}`. Validate parsed structure and canonicalize with P71; do not demand byte-identical JSON spelling or reject explicit false. When B8 roles/counts occur in intake, require the complete valid projection. An overrides-only run edit is independently parsed; non-B8 run edits retain P71 validation. Preserve unrelated valid run-edit members; never strip a providerRoute or silently replace a role. The U83a integration writer assembles the optional separate providerRoute in the caller, after encoding B8 edits: parse the encoded object, replace the **whole** providerRoute with the explicitly chosen complete pair, validate that pair with B7/U83a, preserve unrelated members, and canonicalize through P71 on the server. Do not put the pair inside LoopSelectionV1 or add another B8 encoder. With no explicit route edit, preserve the effective inherited pair. The same frozen assembled settingsEdits reaches preview and intake. At the later U83a continuation, extend the preview request envelope/service/HTTP/client additively with optional providerRoute (absent keeps the existing {selection,overrides} API); its handler performs this same caller assembly before the shared compose/check path. Until that hook lands, an explicit pair is unavailable, while route-free launcher selections continue. Every supplied B8 slot carries all three keys, every review array and count is explicit. Limit text with P71's existing 64 KiB parser; HTTP retains its smaller body budget.

The product wire names above are settled. The exact **tools settings** override names and any translation of tools-native slots must be released in prerequisite T-TOOLS (6), then implemented only in this shared encoder/decoder and tested against the approved shape. A differing tools spelling cannot silently change the product codec. U82/D01a/D01b consume these exports; they do not add another merge/slot parser.

### 2.3 Persistence and whole-layer merge

P71 `parseLoopSettingsV1(text, true)` continues to reject all layer overrides. `mergeSelectionLayerV1(currentLayerText, selection) → text` replaces only the seven B8 role members and three top-level counts, retaining all valid non-B8 members (including nested non-B8 roles if present) semantically unchanged. Preserve providerRoute and any other valid B7 member, revalidate with B7/P71, and write the whole layer at its current expectedVersion. Do not promise identical whitespace after canonical encoding. A stale version conflicts without overwriting. U81 owns this sole export; U82 extends it in place, never duplicates it in a saved module. An explicit U83a route replacement is a caller operation **after** this merger returns: parse the returned whole layer, replace the complete providerRoute, validate with B7/U83a and canonicalize with P71 before the one expectedVersion PUT. No route argument is added to the shared merger; its signature and all roles-only consumers remain unchanged. No save UI or extra store in U81.

### 2.4 Run overrides and reset

NEW `LoopSelectionRunOverridesV1 = {reviewFamily:boolean, standardFinal:boolean}` is the separate preview/run envelope; defaults are **both false**. Parser `parseSelectionRunOverridesV1` (NEW in wire.ts) accepts true and false, rejects null/unknown keys and supplies false for omitted switches on a **new B8 run**. The encoder always writes both values, so installed true defaults are explicitly suppressed by `{reviewFamily:false,standardFinal:false}`. A preview takes `{selection,overrides}`; selection JSON and presets never carry this envelope. U82/D01b use this same reset parser when loading saved/preset/default values. Deliberate current-run true edits are explicit owner choices; reviewFamily still needs separate bound acceptance and standardFinal never waives final-family exclusion. Recorded wire-name amendment to **approved B8 selection spec R4**, S1 route paragraph: that paragraph names preview booleans allow_same_family_review/allow_standard_final; the shared product envelope instead uses reviewFamily/standardFinal as already fixed by D01a/D01b. Map reviewFamily → allow_same_family_review and standardFinal → allow_standard_final at the single tools boundary, qualified by T-TOOLS with false/false, true/false, false/true and true/true round trips through preview and intake. This explicitly records the deviation; it does not assert a new approved spec revision. If the released tools nesting differs, T-TOOLS must pin that nesting before implementation; the product names remain fixed. Tools-native override mapping is T-TOOLS. Legacy non-B8 flows keep their existing P71 behavior; historical Start never gets recomposed or reset.

## 3. One preview and selection authority

NEW `LoopSelectionServiceV1` in `src/web/v1/loop-selection-service.ts` owns the shared service and `WebSessionAuthority(db, scope, clock, "loop_selection")`. It enforces project-scoped owner-only `loop_selection.read` (low) for preview and safe selection reads, and defines `loop_selection.manage` (high) for later catalog/default mutations. ResourceType is audit metadata; the action, owner/project scope, expiry/revocation and precommit recheck enforce the grant. A tasks.propose grant alone cannot authorize preview. P71 selection-layer saves still require `loop_policy.manage`, not selection.manage. Intake/Confirm/Start keep existing `tasks.propose` high owner authority; selection grants do not replace it. U81 supplies NEW `withSelectionAuthorityV1(identity,projectId,mode,operation)` in this service (`mode` read/manage; protected shared service helper reused by sequential extensions, no HTTP grant-mint endpoint), later chunks reuse it; no new grant is seeded automatically and no new `loopBridgeTransaction("preview")` mode is added.

`preview(identity, projectId, {selection,overrides})` authorizes first, reads active project and P71 layers through NEW `policy.snapshotRead(tx,projectId,runEdits)`, and captures the current snapshot expectation (5). No project write lock or layer write, claim, acceptance, preset or default is created. `snapshotRead` is a narrow P71 additive read helper, using consistent layer reads and returning the existing snapshot type. After the transaction ends, call the **existing** checker hook with `{mode:"preview",sameFamilyIntent:overrides.reviewFamily}`; one checker makes every family/role/effort/fallback decision. Preview intent is hypothetical only and cannot be reused as admission authority.

Return NEW `LoopSelectionPreviewV1`: `available:true`, unchanged `check:{eligible,reasons}`, separate product `blockers:[{code,explanation}]`, settingsSha256/defaultsSha256/layerVersions, the validated ordered lineup and rosterDigest/availabilityDigest/lineupDigest. Projection includes requested/effective model, route, effort, family/class/cost, candidate refusals beside slots, reservedFinal/fallback, `family_policy:"review-only"` and waived reasons. A paid candidate adds `paid_execution_unavailable`; readiness remains false. Missing checker/projection/reason, unsupported configured-provider validation or missing snapshot prerequisite gives `available:false` with its reason, never guessed eligibility. No second family rule or silent replacement.

Prepare requires available + checker eligible + no product blockers. A family-intent preview can show prospective eligibility but requires an explicitly checked, initially unchecked acknowledgement before preparing that run. Editing any field resets it and invalidates preview. Free/subscription **launcher route** slots have no dependency on U83a's provider chooser; a separately configured `providerRoute:{providerId,model}` needs the B7/U83a validation hook and fails unavailable when that hook is absent. Do not label every slot with a launcher route as an unreleased configured-provider choice.

## 4. Approved acknowledgement and exact candidate admission

### 4.1 Record and scope (S1)

Add optional non-nullable `sameFamilyAcknowledgement` to `loopBridgeBindingSchemaV1`, keeping outer schemaVersion=1. Exactly six keys:

```json
{"schema_version":1,"rule":"R296","run":"<binding.loopRunId>","by":"owner","accepted_at":"<server offset timestamp>","acknowledgement":"same-family-risk-accepted"}
```

Reject extra/null/wrong literals, wrong run, impossible/naive/future dates. Authenticated row owner plus the signed binding supplies input/version/request/settings/engine context; add no fields to this record. Optional `acceptSameFamilyRisk?:true` is allowed on **intake, confirm and start** only; false/null/client record/run/by/time refuses. Stop/approve/answer bodies and record scope remain unchanged. Do not copy a new acknowledgement into approve/answer bindings. Manual/chained/final/recovery tools reuse the accepted Start lineage under T-TOOLS; a wider product record contract would need a separate amendment, not this BUILD.

### 4.2 Candidate ordering and exact check (S1)

For each new intake/Confirm/Start after authorization and exact prior-key lookup, allocate **one candidate commandId** with the current loop-command grammar in preflight. Intake also calls reserveRun once there; Confirm/Start use the saved run. Freeze a candidate with exact parsed body, saved/composed settings text, and the **entire** `LoopBridgeBindingV1`. Intake has localVersion=1, description byte hash, composed settings hash, null runLink/authorization/inputVersion/revision/evidence and pinned adapter/tool identity. RequestId is not a binding field; it is still created only when the checked draft is saved. No preflight draft write is needed.

For Confirm read verified local input plus the external observation outside locks, apply today's normalization rule in memory, and construct the binding with **resulting** localVersion (old+1 only if description differs), normalized requestSha256, unchanged settings copy, observed inputVersion/revision and exact body. Start uses exact saved settings/request/version and current observed engine input/revision/run link/authorization. Copy/rederive acceptance only as 4.3 permits. Call `checkSettings(text,{mode:"admission",binding:candidate.binding,commandId:candidate.commandId},execution)` outside all transactions. Both no-record ordinary candidates and record-bearing candidates use this full context once T-TOOLS is qualified; preserve a legacy no-context path only for the explicitly unchanged legacy compatibility lane.

**One admission timing budget (r5; all times in ms):** keep the exact frozen binding, including accepted_at; never restamp it after checking. For fresh intent, stamp accepted_at at freeze using the authenticated server wall clock. The monotonic budget is defined once here:

| Stage | Deadline / allowance |
|---|---|
| Candidate freeze | `F = frozenMono`, `W = admissionFreshnessMs` (configured integer 1–5000, service.ts:59–60), `D = F + W` |
| One reserve and checker cutoff | `R = 1000`, `C = D - R`; service checker signal fires at C |
| Execution call entry at E | NEW server-only third execution argument `{signal,timeoutMs}` passes through policy.checkWith → adapter.checkSettings; `timeoutMs = floor(D - E)` measures to the **candidate deadline**, with no reserve subtracted |
| Preparation / child spawn at S | Preparation consumes that same allowance. Immediately before spawn, `remainingMs = timeoutMs - (S - E)`; child timeout is `min(adapterConfiguredTimeoutMs, floor(remainingMs - R))`. This is the sole reserve subtraction in the child budget, equivalent to measuring from S to C, never from S to C minus R again. A nonpositive child budget or already aborted signal refuses before spawn |
| Checked success / cleanup / locks / precommit | Check must finish before C. Reap/temporary-file cleanup and locked revalidation/commit consume the remaining time to D; recompute `D - nowMono` for each wait and immediately before COMMIT. Commit must occur strictly before D; no stage resets F or grants a fresh W |
| SQL fresh intent | Independently enforce §4.4's wall-clock claim age, strictly less than 5 seconds and nonnegative, for newly minted true intent; copied accepted_at has no elapsed-age expiry |

The execution argument is separate from the unchanged approved second context. At each forwarding hop, deduct elapsed forwarding time from timeoutMs before calling the next hook; no hop subtracts another reserve. The adapter captures its matching E and remaining-to-D allowance at entry and observes the signal throughout queued preparation and child execution, so delayed forwarding/preparation cannot restart or expand the allowance. The signal scopes checker execution only; once checker and cleanup settle, clear its timer, while transaction waits remain bounded by D. The new per-call timeout may be below the adapter configuration's 100-ms floor; validate it as a positive integer without weakening the legacy configuration check (adapter.ts:305–306). A configured W at or below R is unavailable for this path; shorter usable windows retain the same single reserve. Cancellation sends TERM/KILL, reaps the child and removes temporary files before settling; a bare Promise.race that leaves a checker running is forbidden. Cleanup may exhaust the reserve: then admission refuses with zero draft/source/waiver/claim writes, and cleanup must still finish. There is no automatic retry or acknowledgement renewal. Preview and legacy no-context P71 checks retain their existing configurable 30000-ms default; preview creates no candidate authority. The admission checker ceiling is C, including preparation, rather than the legacy timeout. T-TOOLS qualification must measure the chosen checker within this budget; otherwise U81-B stays unavailable. This implements the frozen-binding admission ordering of **approved B8 selection spec R4**, S1, without changing its context or freshness contract.

Under current authority→exclusive project→head→policy→waiver lock order, re-read lineage/pins/snapshot/grants, validate the observation against the same current local state, compare the complete candidate binding and commandId, and assert the §4.2 monotonic deadline and §4.4 wall-clock fresh-intent age. Bound lock/statement waits and the precommit callback by the remaining candidate deadline; any exhausted budget rolls back. Before saving/revising any draft, source, waiver or claim, run the current snapshot guard (5). On drift/mismatch refuse atomically with zero rows/claims. Save/revise with existing lineage methods, verify their generated version/hashes equal the candidate, record/copy P71 sources, then insert the exact checked binding and candidate commandId. A post-write mismatch rolls back the transaction. Never allocate another run/commandId or reconstruct a smaller checker context at insertion. Same-key concurrent contenders recheck replay before writes; only the winning checked candidate can commit. A lost candidate's IDs confer no authority.

### 4.3 Fresh intent, accepted lineage and replay (S2/S3)

A new true intent always mints a **new** six-field record for that action using the authenticated server clock, even if an older accepted record exists. It requires the explicit same-family review override. A flag without that override refuses acknowledgement_not_applicable. It cannot waive the final-builder rule. With no fresh intent, intake has no record; unchanged Confirm/Start may copy an exact record only from a verified earlier intake/confirm **accepted result** matching run, owner, local input version, request hash and settings hash. A claim alone or refused/waiting/uncertain result is not acceptance. Verify both HMAC/digests and receipt binding; derive provenance by the verified journal scan, with no extra record field.

Normalized Confirm changes request/version and needs new intent when review acceptance is required. Unchanged Confirm and Start can reuse accepted provenance indefinitely without an invented acceptance age expiry; current session/grant and each new candidate's admission window still apply. A new true intent at Start is supported. Preserve the exact accepted_at when copying; do not refresh or silently ignore a supplied true intent. Exact same key/body returns the original binding, timestamp and result and never rechecks/remints/redispatches it as a new action. An uncertain action reconciles by its frozen exact key/body first; changed body on the same key conflicts, and replacement stays unavailable until reconciliation.

### 4.4 Additive SQL, timing and same-commit migration integration (S2/S7)

NEW migration `<A>_control_loop_selection_acknowledgement.sql`, following validation migration `<Av>_control_loop_selection_acknowledgement_validate.sql`, and matching down files. The lead allocates actual IDs in merge order and records exact filenames in the BUILD continuation; A/Av are placeholders, not reserved numbers. Do not edit landed 0302/0306/0307 bytes or rewrite signed JSON. Replace the catalog-named binding CHECK and `control_loop_improvement_commands_check1` NOT VALID; widen only the optional record key and intake/confirm/start true intent. Preserve all other predicates. Validate all new constraints in Av.

Use explicit closed disjunctions:

- `((binding ? 'sameFamilyAcknowledgement') IS NOT TRUE OR (<operation IN intake/confirm/start AND strict six-field/run/timestamp predicates>) IS TRUE)`.
- `(((binding->'body') ? 'acceptSameFamilyRisk') IS NOT TRUE OR (<operation IN intake/confirm/start AND value = 'true'::jsonb AND validated record present>) IS TRUE)`.

Both absent is legal for ordinary/retained legacy claim/result rows. Present null, missing inner fields, extra fields, wrong run/literals, false or string true cannot slip through SQL NULL behavior. Intake record requires true intent; Confirm/Start record with omitted intent is a potential copied record whose verified provenance is checked by the service. Approve/answer/stop cannot carry it.

Timestamp validation must reject nonexistent calendar dates, invalid offsets/naive text and future timestamps: shape regex alone is insufficient. Use NEW schema-owned SQL function `control_loop_selection_ack_timestamp_v1(text) RETURNS timestamptz` in A (strict ISO offset grammar + round-trip calendar validation; safely catch invalid cast and return NULL). Revoke default PUBLIC EXECUTE; grant only needed production roles in the same-commit grants set. Its valid parsed result must be non-null and `accepted_at <= created_at` for any record-bearing row. The TS decoder applies equivalent strict validation; never rely on JS Date normalization.

**Freshness applies only when `entry_kind='claim'` AND body contains new true intent:** require `created_at - accepted_at < interval '5 seconds'` (and nonnegative). Do not impose elapsed freshness on results/reconciliation, or omitted-intent copied records. A result repeats the exact binding but has its own created_at. Every new candidate obeys the configured monotonic admission budget in §4.2 regardless of copied record age. SQL cannot prove cross-row provenance; the service proves it under locks.

Down refuses 23514 with any retained new key/intent row, leaving schema/ledger unchanged; otherwise restore the prior exact checks, remove the helper after dependent constraints and safely re-up. Av down/up follows the existing validation pattern. Acknowledgement changes constraints/function only, so table counts stay at the measured landed baseline.

The lead DB writer owns this complete same-commit set: `db/roles/private_web_roles.sql`, `db/roles/production_table_grants.sql`, `deploy/postgres/desired-grants.json`, `deploy/postgres/migration-ledger.json`, `db/setup/production_migration_ledger.sql`, `src/updater/v1/policy/release-schema-digest.json`, `src/web/v1/private-database-preflight.ts`, `src/web/v1/private-fixture-preparation.ts`, `tests/improve-control-room-loop-candidate-postgres.test.ts`, `tests/improve-control-room-desk-postgres.test.ts`, plus the new migration/down files and tests/loop-selection-postgres.test.ts. Recompute both schema pins and grants/ledger together. On this source, fixture/application tables=263 (private-fixture-preparation.ts:121), native public=264 (candidate:188), unlike the older approved R4 baseline. A/Av add zero tables; do not increment those counts. Candidate inherited fixture counts and desk catalog pins must remain aligned. Extend **all** candidate empty-down/re-up and BASE-upgrade chains (candidate:262 onward, :364 onward), and desk empty-dependent reverse-down chain (:852 onward), with Av/A in reverse ledger order before existing 0309→0301; restore forward on re-up. Never drop a PG pin or fixture check to make a migration pass.

## 5. Snapshot and immutable dispatch transport (S1/S6)

**Observed missing prerequisite T-SNAPSHOT:** current `policy.assertSnapshot` checks only defaults/layers/text; it cannot compare roster or availability. Roster DB version/export metadata exists (`LoopRosterServiceV1.#read`), but the tools availability producer/current-lock reader is not present in this repository. Neither a process-local last-check cache nor an adapter spy implements a transactional admission reader. Product admission dependent on this guarantee is withheld until a separately reviewed lead/tools packet releases the real producer, snapshot format, current reader and lock order. Cloud foundation tests can exercise the port but cannot qualify zero-claim integration from a fake.

NEW port owned by the lead-named shared admission writer, declared in `loop-selection-service.ts`:

```ts
type SelectionSnapshotV1 = Readonly<{ rosterDigest:string; availabilityDigest:string; revision:string }>;
interface LoopSelectionSnapshotGuardV1 {
  capture(): Promise<SelectionSnapshotV1>; // current authoritative snapshot; outside admission
  assertCurrent(tx: DatabaseSession, checked: SelectionSnapshotV1): Promise<void>;
}
type LoopSelectionDispatchV1 = Readonly<{ commandId:string; bindingDigest:string;
  snapshot:SelectionSnapshotV1; lineupDigest:string }>;
```

This is a NEW prerequisite port, not a claimed existing export or permission to invent an availability store. `assertCurrent` must read the authoritative roster/availability revision/digests under the released shared producer lock, after authority/project/head/policy/waiver in the one documented lock order; no checker/process under locks. Missing guard, unreadable current state or revision/digest mismatch refuses **before any draft/source/claim write**. Producer publication and DB admission must share a serialization protocol; file stat/mtime alone and tools' later fence are insufficient. Lead must amend allowed physical reader/producer files and pin the released implementation before admission continuation U81-B; this spec does not authorize editing the private tools checkout or a new DB table to fill the gap.

Capture a snapshot before checking; the checker must attest it evaluated those same roster/availability digests (T-TOOLS); drift during checking refuses. Freeze per-command `LoopSelectionDispatchV1` from that result and the exact candidate command/binding digest. The commit transaction returns it with `admitted` only after assertCurrent succeeds. Extend `#dispatch`'s admitted type, adapter `intake`/`confirmRequest`/`start` with an additive final optional `selectionDispatch` argument, their `invoke` closure, and `contract.admissionExpectation(binding,{operation,commandId,selectionDispatch})`. No shared mutable cache: invoke verifies commandId/bindingDigest and frozen snapshot, then serializes that exact expectation to its owned expect.json. No new binding fields. Legacy callers may omit it; B8 context-bearing candidates may not. Replay/reconciliation does not dispatch again and needs no rebuilt expectation.

Two separate guarantees: (1) real current-reader drift after check/before claim ⇒ zero Start claims/workers; (2) drift after a claim/before spawn ⇒ tools compares the frozen expectation under its mutation lock, emits refusal, dispatches zero workers, but the existing claim remains. Existing beforeSpawn freshness still applies. Post-claim uncertainty keeps the existing no-redispatch recovery behavior. Do not call (2) a zero-claim proof. Approve/answer/manual/chained/final/recovery tools fences derive the authoritative accepted Start expectation under T-TOOLS; product bindings for those commands remain unchanged pending qualification.

### 5.1 D27 amendment — checked binding beside report-only custody

**Choose (b): a minimal tools extension; (a) cannot preserve recovery on pin `064eb462f3a055da9d3487502108a5292e21eeb0`.** `bridge/a2-contract.mjs:150–155,189–193,359–370` closes the selection binding/context and checks the dispatch digest. More decisively, `:661–679,715–740` requires custody inside the original intake binding; `cr.py:4802–4816` independently enforces that and joins its digest to the saved intake admission. A plain admitted binding plus a later reconstructed owned binding fails that join. Do not disable intakeDriver or widen the selection schema.

**Transport (later BUILD only):** keep the full checked journal binding, canonical bytes, commandId, acknowledgement and digest unchanged through service → adapter → `admissionExpectation` and `selection.binding`. Add NEW optional server-only `intakeCustody` after `selectionDispatch` on adapter intake, forwarded beside the binding in expectation context and serialized as sibling `intake_custody`. Use the existing closed `loopIntakeCustodySchemaV1`: the six added fields tenantId/workspaceId/projectId/requestId/ownerIdentityId/settingsDigest, plus existing localVersion. Derive custody only from the verified signed claim/scope; localVersion/settingsDigest must equal binding.localVersion/settingsSha256. B8 with configured intakeDriver requires it; other operations refuse it. No client, selection, acknowledgement or journal-schema additions.

Tools validate and atomically save custody with the accepted intake admission under the existing mutation lock. Exact-command replay must compare custody too: changed/missing custody cannot replay or downgrade a custody-bearing admission. The intake receipt digest remains the checked binding digest. Driver `intakeBinding` and receipt `intake_binding` carry that exact plain binding; custody stays beside it. Recovery must join commandId, binding digest, request/settings hashes and input version to the unique accepted admission **and compare every custody member with its saved intake_custody**. Only runLinkId is added at recovery, as today. Preserve legacy owned-binding receipt/recovery as a distinct branch only when the original admission has no sibling; never rewrite retained signed rows or receipts.

Preserve verified accepted-result and current owner/project authority checks, completed-result/revision/input fences, atomic single consumption, saved-receipt restart recovery and uncertainty without redispatch. Advance stops at Confirm and cannot confirm/authorize/Start a worker. Update service refusal-evidence, completion and reconciliation digest joins for the plain-binding branch while retaining legacy joins. Never restamp or rebind after checking.

**Exact later implementation files:** product `src/web/v1/improve-control-room-loop-service.ts` (`#intakeEngineBinding`, `#dispatch`, refusal/completion, `#advanceIntake`); `src/web/v1/improve-control-room-loop-adapter.ts` (intake/invoke/context, driver binding/receipt schemas/equality); `tests/loop-selection.test.ts`, `tests/improve-control-room-loop-recovery.test.ts`, `tests/loop-selection-native.test.ts`. Tools paths relative to loop: `bridge/a2-contract.mjs`; `cr.py` (`bridge_expectation`, `bridge_compare`, `bridge_record`, `intake_driver_authority`, replay); `bridge/test_contract.mjs`, `test_a2_intake_driver.py`, `test_b8_selection.py`. Keep `bridge/selection-schema.json` closed/unchanged. No transport migration/table; the existing U81-B acknowledgement migration stays separate.

**REQUIRED red-first tests:** configured-intakeDriver B8 must assert identical canonical checker/dispatch/expectation/receipt binding bytes and digest with sibling custody (today's wrapped dispatch fails). Real-contract/locked-CLI synthetic completed intake must admit sibling custody, advance once to Confirm, reopen and replay with zero extra advance (today's context/driver guards refuse). Refuse each missing/changed custody field, commandId, digest, input version, completed-result hash and cross-owner/project/request substitution without partial effect; absent saved custody cannot qualify the new branch. Retained legacy owned recovery stays positive. Guard-off each custody/durable-join/replay fence, prove intended failure, restore/pass. No real launches.

REQUIRED targeted commands after tests exist: product `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection.test.ts tests/improve-control-room-loop-recovery.test.ts`, with `CONTROL_ROOM_B5_INTAKE_CONTRACT` set to the replacement module; tools from loop root `node bridge/test_contract.mjs` and qualified interpreter `-B test_a2_intake_driver.py` / `-B test_b8_selection.py`. Transport cases require deciding assertions and zero skips/quarantine. These commands are specified, not run here.

**Requalification:** release a reviewed new immutable tools commit replacing `064eb46` and matching qualification receipt (actual toolsSha, interpreterSha256, inventorySha256, schemaDigest, moduleSha256, entrypointSha256). Preserve the selection schema digest if unchanged; never reuse the old module hash/receipt or invent the new pin. Lead supplies clean pinned trees and existing host inputs: `CONTROL_ROOM_A2_TEST_LOOP`, `CR_PYTHON`, `CONTROL_ROOM_B8_PRODUCT_SHA`, `CONTROL_ROOM_B8_TOOLS_SHA`, `CONTROL_ROOM_B8_INTERPRETER_SHA256`, `CONTROL_ROOM_B8_TOOLS_GATE_TIMEOUT_MS`, `CONTROL_ROOM_B8_QUALIFICATION_RECEIPT`. REQUIRED `pnpm run test:loop-selection:host` on the qualified disposable macOS host must pass all 13 tools suites and both U81/P71 product lanes, zero skips. Retain §9–10 PG17/concurrency/Linux and independent code/attack/CI gates; actual-worker proof still needs separate authorization. Builder: Frontier (sensitive launch admission/durable custody). Open input: replacement pin/receipt. Dependent U81-B admission stays blocked until implementation and full requalification; this amendment authorizes neither now.

## 6. Released tools prerequisite (T-TOOLS; not supplied by current F10c)

Add NEW optional context compatibly to the one `LoopAdapterV1.checkSettings` and P71 tools hook: `{mode:"preview",sameFamilyIntent:boolean}` OR `{mode:"admission",binding:LoopBridgeBindingV1,commandId:string}`. Omission retains current P71 behavior. NEW `policy.checkWith(text,context,execution?)` (execution is the server-only `{signal,timeoutMs}` from §4.2) returns the unchanged eligible/reasons and validated optional lineup instead of a second checker wrapper. The full candidate check, strict review-only family policy, current snapshot attestation and expectation transport use one tools policy core.

Retain proposed NEW optional `LoopAdapterContractV1.selectionProjection` pin for argument serialization/projection decoding; missing pin makes context-bearing selection unavailable. Lead must release exact context/expectation/settings member mapping, projection schema (including `family_policy:"review-only"`, waived reasons and snapshot digests), revision and measured schemaDigest before dependent integration. No guessed digest or unbound CLI flag. The tools persist accepted intake→Confirm→Start lineage; manual/chained/final/recovery consult its verified Start authority and preserve full receipt/expectation binding. Do not widen product record scope to compensate. All final paths, Standard final and fallback refuse builder-family final under either/both overrides; ordinary review-family waiver alone is allowed.

T-TOOLS and T-SNAPSHOT must be reconciled/reviewed together; neither today's F10c route contract nor mock `selectionProjection` qualifies them. Missing either blocks U81-B integrated admission, real-tools/native gates and SELECTION-TO-START-GREEN. It does not block the bounded foundation continuation, and no owner policy question is reopened.

## 7. UI, exact displayed target and reload (S3)

Add optional approved `selection:{requestSha256,settingsSha256,sameFamilyReview:boolean,acceptanceCurrent:boolean}` to `loopDecisionStatusSchemaV1` in `improve-control-room-loop-attention-wire.ts`. Server derives it from verified local/signed lineage and **the displayed engine draft/status**. For normalized Confirm, requestSha256 is engine.requestSha256; target localVersion is current+1 when engine.draft differs, otherwise current. For Start, use the saved confirmed input/version. An old accepted record for A gives acceptanceCurrent=false for normalized B even when settings hash is unchanged. Missing/unverifiable projection disables acceptance-dependent actions; legacy historical display remains readable.

Selection service owns NEW `previewSaved(identity,projectId,requestId,{operation:"confirm"|"start",expectedVersion,expectedRevision,requestSha256,settingsSha256,sameFamilyIntent?:boolean})`, exposed by POST `…/improvements/loop/:rid/selection/preview`. sameFamilyIntent is hypothetical preview input, defaults false and maps only to the preview checker context; acceptSameFamilyRisk and client acknowledgement objects are rejected here. It uses selection.read plus normal owner/project read authority, derives the exact candidate target/settings on the server through the bridge's NEW internal read-only `selectionTarget` helper, and runs the same preview checker. Return target identity and prepared settings hash plus the usual preview; **no** record/claim/ID allocation/draft write. NEW bridge method `selectionTarget(identity,projectId,requestId,operation)` returns server-only `{settingsText,targetLocalVersion,requestSha256,settingsSha256,engineInputVersion,engineRevision,sameFamilyReview,acceptanceCurrent}` from verified current lineage and its outside-transaction engine observation; re-read lineage/grants before returning and refuse drift. It is not U82's historical lastSelection wrapper. The public route echoes only target identity, the safe selection projection and normal preview, never settingsText or raw accepted records. GET status never runs a checker and returns no raw settings/identity/acceptance object.

On initial intake the panel previews `{selection,overrides}`. On normalization or reload before Confirm/Start, use status→previewSaved for that exact displayed target. Show a fresh unchecked control whenever sameFamilyReview && !acceptanceCurrent; explicit current tick sets true intent on Confirm **or Start**. Unchanged accepted lineage needs no tick. A supplied fresh tick always sends true and mints new acceptance. No absent intent silently accepts normalized input.

Every status/preview/prepare/Confirm/Start response application is keyed by project/requestId, target localVersion, request/settings hashes, engine inputVersion/revision and UI epoch. Any edit/pick/reload/replacement clears the checkbox and invalidates preview/actions. Late A cannot enable B. Prepared draft hash must equal the checked preview; composition drift requires preview again. After preparation, lineup edits use visible replacement intake/settingsEdits and retain old input, renewed Confirm and separate Start. Do not mutate a linked intake copy or bypass P72. Frozen uncertain command key/body must reconcile before preview/acceptance changes or replacement; never mint new consent/acknowledgement on retry.

Existing mounts/callers: workspace → selection panel + intake; decisions for Confirm; run panel for separate Start/Stop and saved-target re-preview. Generic browser command client already accepts frozen JSON. Reasons stay beside disabled controls; first blocking reason focused, readable at 390×844 touch and 1280×850, ≥44px targets and no overflow. Viewports do not replace real-device proof.

## 8. ALLOWED FILES and continuation ownership (later BUILD only)

| Existing file(s) | Narrow change / single writer |
|---|---|
| `src/improve-control-room/v1/schemas.ts` | intake/confirm/start intent; exact optional acknowledgement; U81 |
| `src/web/v1/improve-control-room-loop-service.ts` | candidate preflight/check/compare and bounded precommit deadline; accepted provenance; dispatch capsule; internal selectionTarget; lead-named admission writer |
| `src/web/v1/improve-control-room-loop-adapter.ts` | one context/projection decoder, server-only per-call signal/remaining timeout, and additive per-command transport to invoke/admissionExpectation; same admission writer |
| `src/web/v1/loop-policy-service.ts` | additive snapshotRead/checkWith only; lead-named policy writer |
| `src/web/v1/improve-control-room-loop-attention-wire.ts`, `src/web/v1/improve-control-room-http.ts` | safe status projection and saved-target preview route; U81 |
| `src/web/v1/mac-local-web-process.ts`, `src/web/v1/private-process.ts` | inject shared service/guard and register handler; lead wiring writer |
| `private-app/app/improve-control-room-workspace.tsx`, `private-app/app/improvement-intake-form.tsx`, `private-app/app/improvement-decisions.tsx`, `private-app/app/improvement-run-panel.tsx` | panel/intake, normalized Confirm/reload, separate Start/renewal; U81 |
| `tests/loop-policy.test.ts`, `tests/private-node-handler.test.ts`, `tests/improve-control-room-loop-bridge.test.ts`, `tests/improve-control-room-loop-bridge-b2.test.ts`, `tests/improve-control-room-loop-bridge-postgres.test.ts`, `tests/improve-control-room-loop-ui.test.tsx`, `tests/improve-control-room-loop-attention.test.tsx` | additive context and ordinary legacy/transport/journal/UI regression; U81 |
| `package.json`, `.github/workflows/ci.yml` | explicit unit/PG/mutation/browser/real-tool lane registration; lead registration writer |
| Every concrete shared migration/grant/pin/preflight/fixture/candidate/desk file in 4.4 | DB writer, same commit as A/Av |

NEW files: `src/web/v1/loop-selection-wire.ts` (shared codec); `src/web/v1/loop-selection-service.ts` (authority/preview/guard port); `src/web/v1/loop-selection-http.ts` and `src/web/v1/loop-selection-browser-client.ts` (POST project selection/preview and saved-target preview); `private-app/app/loop-selection-panel.tsx` (workspace/intake caller); `tests/loop-selection.test.ts`, `tests/loop-selection-postgres.test.ts`, `tests/loop-selection-mutations.test.ts`, `tests/loop-selection-native.test.ts`, `tests/browser/loop-selection.spec.ts`; A/Av migration/down files from 4.4. No package addition. Existing `src/improve-control-room/v1/service.ts` authority/lineage APIs are reused unchanged; the rejected preview transaction mode is removed.

All POSTs preserve same-origin owner/JSON/query rejection and `privateRequestBudgets.default` 8192-byte outer budget; no idempotency key for pure preview. No generic PUT/DELETE or budget widening; U81 needs neither. Later preset/default PUT alternatives belong to D01a/D01b with separate review.

### 8.1 Six-hour continuation seams (S7)

The task's 8–12-hour feature is not one six-hour authorization. Each lead continuation names exact predecessor head, allowed files/shared writers and pending gates; reserve 90 minutes for independent reviews/checks and 30 for evidence/cleanup, leaving at most 4 hours for implementation per continuation. If the named work cannot fit, stop with pending evidence and obtain a narrower exact-head lead continuation; do not silently enlarge the six-hour authorization.

| Continuation, maximum 6 h each | Concrete deliverable and deciding evidence | Stop boundary |
|---|---|---|
| U81-A foundation | wire/service/http/client, narrow P71 snapshotRead/checkWith declarations/consumer, NEW unit tests and registration; approved slot/count codec, false-reset, preserved layer members, owner-only selection actions and pure checker preview; codec/preview-only portions of T1–T5/T10/T14, T12-P and project-preview T13 | context/snapshot mocks are contract tests only; no admission/UI/native green |
| U81-B admission + PG, after reviewed A **and released T-TOOLS/T-SNAPSHOT packet** | service/adapter/schemas/attention, policy additive hooks, migration/down + complete 4.4 set; explicitly own cancellable execution plumbing, preparation cutoff, sub-floor per-call validation, TERM/KILL/reap/temp cleanup and deadline-bounded locks/precommit; admission portions of T1–T5/T10/T14 plus T6–T9/T11/T12, exact-candidate/capsule, real current-reader zero-claim, SQL delayed-result/copied-record, production-login PG17/replay/concurrency and guard-off proofs | missing physical reader/producer allowed-file amendment blocks this continuation; no fake can fill it; cancellation plus admission/DB evidence must fit the 4-hour implementation allowance or stop for a narrower continuation; UI/native still pending |
| U81-C UI + integration, after reviewed B | workspace/intake/decisions/run panel, panel/browser/native tests, process wiring and final lane registration; normalization/reload/Start renewal/frozen-key tests, saved-preview T13/real transport and adjacent regressions | actual tools/worker/device identity/argv/Stop and Linux qualification remain separately authorized; no SELECTION-TO-START-GREEN until they pass |

U81 owns shared selection exports and selection.read/manage actions. Integrate U81 → U82 → D01a → D01b sequentially, re-inspecting actual predecessor SHA/API before each continuation. U82 reuses mergeSelectionLayerV1 and false-reset parser; D01a imports slot schema and five-role projection, with checker-only eligibility; D01b uses the same reset/authority. No nonexistent U81 eligibility export or second saved merge. U83a consumes fixed U81/U82; launcher routes qualify independently, only configured-provider choices wait for its hook. Lead coordinates one writer for Start/adapter/schema/policy, process/outer transport, migrations/grants/pins and package/CI. No branch existence earns compatibility. Paid-cap CAP-A/B can proceed independently, but its row-set priceRowDigest, roster-vs-served identity, one paid pair and consumed authority remain mandatory for future paid consumers; no sibling enables paid readiness.

## 9. Required BUILD commands and expected evidence

Every command below is REQUIRED in its named continuation; no command is run as part of this PLAN revision. Use cached tools only, no downloads. Record nonzero deciding passes, zero skipped/quarantined replacements and actual TAP/exit results. Run every command from the revision branch at the BUILD head, on Node 22 with PostgreSQL 17 (`PG_BIN` supplied by the lead). `CONTROL_ROOM_B8_BASE` must be the pinned integrated predecessor SHA from the continuation, not a floating ref. The repository uses pnpm (`pnpm-lock.yaml`, `packageManager: pnpm@11.19.0`), so `pnpm run X` is the task's `npm run X`. Names marked NEW stay NEW until the lead registers them.

### 9.1 Affected tests (deciding)

```sh
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 \
  tests/loop-selection.test.ts tests/loop-policy.test.ts tests/improve-control-room-loop-bridge.test.ts \
  tests/improve-control-room-loop-ui.test.tsx tests/loop-providers.test.ts tests/private-node-handler.test.ts tests/improve-control-room-loop-bridge-b2.test.ts \
  tests/improve-control-room-loop-attention.test.tsx
```

**Red-first through existing entry points.** These must fail on the delivery base through `ImproveControlRoomLoopServiceV1.mutate` / the existing improvements HTTP handler / `composeLoopSettingsV1`, never through an import error:

- R1: intake `settingsEdits` with an extra B8 slot key or `code_reviews` length 4 / count mismatch is accepted today → expected `invalid_request`, zero rows.
- R2: intake with `acceptSameFamilyRisk:true` is `invalid_request` today → expected an accepted claim carrying the exact record of 4.2.
- R3: Start today performs no checker call → the expected spy count is 1, against the saved bytes.
- R4: a model turned off between intake and Start reaches dispatch today → expected refusal with zero spawns.
- R5: a forged `sameFamilyAcknowledgement` inserted into a signed row → expected `loop_command_integrity_failed` (today the strict schema already refuses, so R5 is a **regression guard**, not red evidence).

Codec unit tests (T1–T4) exercise NEW functions. They are not red evidence; R1 is their red proof through intake.

Cases (independent expected values):

- **T1 codec:** bounds 0..3/0..3/1..3 at −1/0/3/4 and array/count mismatches; D01a slot passes exported schema, including roster-valid 129–179-character model and launcher strings longer than the removed 64-byte cap; five-role preset has no override; independent plan roles; effort enum.
- **T2 strict refusal:** extra selection/preset keys, null/unknown run overrides (false is valid), client acceptance/run/time members, secrets, oversize → `invalid_request` with zero rows, on both preview and intake.
- **T3:** layers/presets carrying overrides/consent/cap refuse. Installed true defaults plus a new-run false reset compose to false at actual intake and checker; explicit current true edit remains deliberate. Reuse the exact U82/D01b reset fragment; checker eligible/reasons stays unchanged.
- **T4:** layer merge preserves `providerRoute` and unknown valid members; caller replaces an unsaved complete pair after the encoder/merger without losing roles/counts/efforts, identical assembled bytes reach preview/intake/save, and reload keeps the pair. No explicit change preserves inheritance; malformed/partial replacements refuse. A stale `expectedVersion` → conflict.
- **T5:** scripted checker projections cover:
  - final-first four-family reservation;
  - builder and reviewer fallback;
  - an unused eligible Frontier blocking fallback;
  - no outside-builder final;
  - duplicate model/type slots, both accepted and refused by the checker;
  - Trial, class, off, unavailable and unwired slots, each producing its checker reason verbatim;
  - final/builder same family never acknowledgeable.
- **T6:** an ordinary intake/Confirm/Start without acceptance stays positive (regression guard).
- **T7 override matrix:** {none, reviewFamily, standardFinal, both} × {flag absent, flag present} at intake, with expected outcome per cell:
  - none+flag → `acknowledgement_not_applicable`;
  - reviewFamily+flag → record;
  - standardFinal alone never waives final/builder;
  - both+flag → record only for the review conflict.

  It also covers accepted_at preserved across unchanged Confirm/Start after >5 seconds; new true intent at unchanged Confirm/Start mints a fresh timestamp; normalized Confirm requires fresh intent. Checker spy matches **complete** committed binding/commandId for intake, unchanged/normalized Confirm and Start; cross-request/version/revision refuses with zero claims; concurrent commands cannot exchange capsules/digests.
- **T8:** forged, cross-owner, cross-run, other-input-version, null, extra-key, naive-timestamp, future-timestamp and expired-window records → refusal. Replay keeps one timestamp, one claim and one dispatch (spy counts).
- **T9:** preview A/edit B, tampered bytes and off after preview refuse. Real T-SNAPSHOT reader sees roster/availability revision change after check/before claim: zero Start claims and workers. Drift after claim/before spawn is a separate tools refusal: retained claim, zero workers. Missing guard fails closed; scripted port tests do not qualify either integration guarantee. Record lock ordering and producer contention independently.
- **T10:** paid slot → blocker `paid_execution_unavailable`; `paidExecutionReady` stays `false`.
- **T11:** Start checks the exact saved bytes; a layer edited after intake does not change the text Start checks.
- **T12-P preview only (U81-A):** checker unavailable / projection missing / ineligible without reasons → `available:false`; preview never writes a draft/source/waiver/claim or creates acceptance. A preview finishing at 6000 ms succeeds under the legacy configured 30000-ms default, with zero authority. These assertions do not claim admission coverage.
- **T12 admission only (U81-B):** checker unavailable / projection missing / ineligible without reasons → zero claims. Use §4.2's sole timing formula, with all test times measured from freeze. For W=5000, preparation completes and child spawns at 200 ms, checker completes at 3000 ms and commit at 3500 ms: stable success with the same frozen binding; the available child timeout at spawn is 3800 ms (configured timeout nonbinding), so completion is strictly inside its budget. A child held through the 4000-ms cutoff is cancelled/reaped with zero rows; preparation reaching that cutoff starts no child. With a successful early check, a lock held through 5000 ms or precommit reaching the deadline rolls back. For W=1500 and spawn at 100 ms, the child allowance is 400 ms; checker completion at 300 ms and commit at 800 ms succeeds, while crossing the 500-ms cutoff cancels. W≤1000 refuses before spawn. Cover a positive sub-100-ms per-call allowance without relaxing the legacy configuration floor, wall-clock skew/refusal by §4.4, near-deadline precommit, temp-file cleanup even when cancellation exhausts the reserve, and no restamping. Real T-TOOLS qualification reports measured admission latency; slow tools do not pass by extending freshness.
- **T14 selection authority:** properly scoped owner selection.read previews; tasks.propose alone, operator/non-owner, wrong-project, expired/revoked callers spawn zero checkers and write zero rows. Revoke manage between preflight and commit; shared authority helper refuses before mutation. Manage helper is defined now for later catalogs; U81 grants no catalog write endpoint.
- **T13 transport (in `private-node-handler.test.ts`):** both preview routes through both createMacLocalNodeHandler/createPrivateNodeHandler and no-listener nodeExchange refuse cross-origin, wrong content type, query string, oversize body (413), and PUT/DELETE.

### 9.2 Broad, DB, mutation, browser and loader lanes

```sh
export CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1
test -n "$PG_BIN"
"$PG_BIN/postgres" --version
test -n "$CONTROL_ROOM_B8_BASE"
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:improve-control-room
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:improve-control-room-postgres        # + NEW tests/loop-selection-postgres.test.ts registered here
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:postgres-production
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:private-postgres-production-boundary
pnpm run check && pnpm run check:demo && pnpm run build
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:improve-control-room-loop-bridge-mutations
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:improve-control-room-loop-lineage-mutations
pnpm run test:improve-control-room-loop-ui-mutations
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm run test:loop-selection-mutations             # NEW script defined below; isolated port base supplied by lead
pnpm run test:improve-control-room-loop-browser && pnpm run test:improve-control-room-loop-providers-browser
pnpm run test:loop-selection-browser                                 # NEW: CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 playwright test tests/browser/loop-selection.spec.ts
pnpm run check:test-loaders
pnpm run test:test-loaders
node scripts/check-test-lane-coverage.mjs
node scripts/ci/verify-mutation-checks.mjs --anchors-only
pnpm run check:test-quarantine
pnpm db:ledger
pnpm db:verify
pnpm run check:migrations --base "$CONTROL_ROOM_B8_BASE"
node scripts/ci/affected-tests.mjs "$CONTROL_ROOM_B8_BASE"
npm_config_offline=true pnpm run test:hygiene
git diff --check
```

`tests/loop-selection-postgres.test.ts` must cover all of the following on PG17 with the production login role:
- fresh migrate;
- upgrade from the landed head with signed legacy rows that still verify;
- direct SQL CHECK positives/negatives for the six-field record, optional disjunctions, timestamp helper/offset/calendar validation, operation scope and claim-only fresh-intent window;
- fresh true-intent claim at +1 second followed by identical binding result at +8 seconds; exact recovery much later; unchanged omitted-intent Confirm/Start copying accepted_at after >5 seconds; ordinary absent-record claim/result and retained legacy upgrade;
- stale newly minted true intent, future/impossible/null/extra/wrong-run record and true intent without record refuse atomically; an injected migration error leaves ledger/pins/rows unchanged;
- empty down restores the prior schema pin;
- refused-down with a retained row (23514, schema unchanged);
- atomic failure mid-migration;
- a 20-caller barrier on concurrent intake/Confirm/Start, with one claim per key and one Start per request;
- a guard-off proof for each fence. In a throwaway copy, remove the SQL predicate or service check, show the test fails, restore it and show it passes.

Register NEW `test:loop-selection-mutations` as `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-mutations.test.ts`; inherited PG_BIN and lead-supplied CONTROL_ROOM_PG_TEST_PORT_BASE identify only disposable PG17 test resources. Register NEW `test:loop-selection-browser` as `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 playwright test tests/browser/loop-selection.spec.ts`; use cached browsers and the existing no-server route fixture. Each command requires positive deciding assertions and zero skipped/quarantine substitutions.

The lead adds the NEW mutation/browser/real-tools scripts and explicit unit/PG/native test files to CI (`.github/workflows/ci.yml` PG17 mutation job, browser job) together with the loader guards.

### 9.3 Real-tools lane (separate, mandatory for qualification)

NEW `test:loop-selection:real` = `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^U81 real selection check$' tests/loop-selection-native.test.ts`. REQUIRED invocation: `test -n "$CONTROL_ROOM_A2_TEST_LOOP" && pnpm run test:loop-selection:real`. Native is a separate explicit lane; broad P71 skip patterns remain intact.

- Native test file is not in broad cloud lanes; add a registration regression in loop-selection.test.ts preserving the P71 skip pattern and requiring the explicit real-tools lane in qualification CI. Do not silently skip missing qualification.
- It requires a qualified `CONTROL_ROOM_A2_TEST_LOOP`.
- It needs at least one deciding pass, zero skipped/quarantined, and real checker/Start/final negatives proving the strict review-only policy and the non-waivable final/builder family.
- It cannot run in this cloud, because the tools are not public.

### 9.4 Browser

`tests/browser/loop-selection.spec.ts` runs at 390×844 (touch) and 1280×850. It must show readable reasons and blockers, disabled-action explanations, focus movement, no overflow and 44px targets, and cover accepted intake A → normalized B → new unchecked control → explicit acceptance → Confirm B → separate Start; unchanged A reuse; reload before Confirm/Start with previewSaved and renewal, no silent acceptance; stale/late A never enabling B; no intent refuses; frozen-key reconciliation before replacement. Viewport evidence is not device evidence.

### 9.5 Native proof boundary

Register NEW `test:loop-selection:worker` as `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=14400000 --test-name-pattern='^U81 actual worker$' tests/loop-selection-native.test.ts`. REQUIRED only in the separately authorized native packet: `test -n "$CONTROL_ROOM_B8_NATIVE_CONFIG" && test -n "$CONTROL_ROOM_B8_EVIDENCE_DIR" && pnpm run test:loop-selection:worker`. These NEW lead-supplied scratch-only variables identify the qualified B5 assembly config/evidence, not a settings home or live install. Use existing `firstWebsiteConfigSchemaV1`, `preflightFirstWebsiteV1`, `loadFirstWebsiteAssemblyV1`, `FirstWebsiteHostV1` from the `tests/helpers/improve-control-room-first-website.ts` and `scripts/workflow-journeys/first-website-proof.ts`; missing assembly/authorization fails preflight before acquisition. No synthetic fixture or absent-env skip passes. Require at least one deciding worker pass, zero skipped/quarantined replacements, Stop and finally cleanup. This lane can launch actual workers only under its later explicit authorization; the current PLAN never does.

The actual Start proof comes later and needs its own authorization. It must join the requested model/route/effort to the independently observed served model/family and input hash. It must record the argv, the settings bytes hash, the Confirm and PG lineage, the result, and Stop cleanup. Scripted workers cannot earn SELECTION-TO-START-GREEN. Qualified assembly and later authorization are blockers; this spec does not substitute an unavailable private engine.

## 10. Reviews required in BUILD

Every continuation requires independent code, attack and CI reviews of its exact head and fixes verified before the lead code gate; the assigned builder/reviewer families follow the lead continuation, never a same-family substitution for the independent gate. Authority/launch, owned command files, retained data/migrations/grants, concurrency and CI registration are sensitive. BUILD also needs affected lanes in the existing lead-supplied pinned Node 22 Linux environment with nproc=2, exact runtime/job parity and no pulls/downloads, plus 20–50 separate PG callers at an observed barrier, real conflicting losers, burst/slow/drop/interruption/retry and finally cleanup of every owned child/pool. PG17 production login fresh/upgrade/down/refused-down/atomic failure is required; PG16/PGlite cannot replace it. Guard-off each authority/provenance/snapshot/final-family/SQL/reset/hash fence separately: prove the altered code loaded, intended assertion fails, restore and pass. Real tools final/manual/chained/recovery and actual worker/device proof remain qualification gates. No generic PUT/DELETE may be added, and no body, guard or lane may be weakened.

## Revision history

- r1 (PLAN): initial specification from `fa673cc8f81ce1dac457ce383b47b2f3ac31f026`.
- r2 (PLAN): addressed the plan-review helper findings:
  - pre-stamped acknowledgement record evaluated by the checker (two HIGH findings);
  - product blockers kept separate from checker eligibility;
  - strict B8 decode on intake;
  - `lineupDigest` drift fence;
  - checker-free selection GET;
  - stronger SQL row predicates;
  - approve/answer record propagation (superseded by approved scope in r3);
  - Start lookup of the accepted Confirm claim;
  - Confirm flag handling;
  - named `"preview"` authority mode (removed in r3 in favor of selection actions);
  - run panel in the file list;
  - red-first only through existing entry points;
  - NEW mutation/browser commands and the transport regression;
  - corrected error code and the effort-enum note;
  - pnpm equivalence.

- **r3 (2026-11-04, specification gate revisions): S1 fixed:** exact approved record/scope and full frozen candidate binding/commandId before checker; explicit service→dispatch→adapter→invoke→expectation capsule. **S2 fixed:** claim-only new-intent freshness; copied records/delayed result/reconciliation positives; strict optional SQL disjunctions/calendar validation. **S3 fixed:** exact-target safe status projection, normalized/reload previewSaved and fresh Start renewal, epoch/frozen-key UI rules. **S4 fixed:** approved roles/count/route slot codec and separate true/false run envelope shared with U82/D01a/D01b. **S5 fixed:** U81 owns owner-only project selection.read/manage authority, P71 saves retain policy.manage. **S6 fixed:** name unreleased T-SNAPSHOT physical producer/current-reader/lock prerequisite and withhold dependent admission; distinguish pre-claim zero-claim proof from post-claim tools refusal. **S7 fixed:** U81-A/B/C six-hour seams, exact migration/fixture/pin/down-chain/CI files and required ledger/lane/loader commands. Reconciled shared writers, checker-owned eligibility, launcher/provider distinction, paid digest handoff and sequential build order. These supersede conflicting r2 helper dispositions; re-review pending.

- **r4 / R2A (2026-11-04), MEDIUM codec bounds:** removed independent slot byte caps; roster/checker strings and existing aggregate budgets govern; T1 covers long valid names.
- **r4 / R2A, MEDIUM freshness budget:** added a server-only cancellable per-call checker budget and a single frozen-candidate deadline through precommit; retained the exact checked accepted_at and SQL five-second fresh-intent rule; T12 covers bounded success, cancellation/reaping and exhausted lock budget.
- **r4 / R2A, LOW preview intent:** previewSaved uses hypothetical sameFamilyIntent, never action acceptance.
- **r4 / R2A, LOW providerRoute channel:** explicit caller assembly after unchanged shared encoder/merger, one preview/intake text, later additive U83a envelope seam; T4 covers unsaved replacements.
- **r4 / R2A, LOW preview wire names:** recorded the approved B8 selection spec R4 wire-name deviation and exact product-to-tools mapping, qualified by T-TOOLS; fixed D01b product names retained.
- **r4 / R2A, LOW stale commit prose:** status/evidence now identify committed r3 af0ee5be886854232ac1406eb390f3a1fc8d4d1d and this r4 revision by its containing commit; no unresolved identity handoff.

- **r5 / R3, MEDIUM-1 — single reserve:** §4.2 states the complete timing budget once, from freeze to commit and SQL. timeoutMs measures to the candidate deadline; the child subtracts the reserve once, and the service signal fires at that same cutoff. T12 adds nonzero preparation, shortened-window and sub-floor cases with strict positive slack; accepted_at and approved B8 selection spec R4 context remain frozen.
- **r5 / R3, MEDIUM-2 — evidence ownership:** split preview-only T12-P into U81-A and admission-only T12 into U81-B; the foundation cannot claim cancellation, lock-overrun or admission green.
- **r5 / R3, LOW-1 — bounded cancellation deliverable:** U81-B explicitly owns signal/timeout plumbing, preparation cutoff, TERM/KILL/reap/temporary cleanup and bounded locks/precommit. Each six-hour seam exposes its four-hour implementation allowance and must stop for a narrower lead continuation if its evidence cannot fit.

Status: PLAN-READY
