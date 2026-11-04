# b8-selection-to-start (U81) — PLAN specification

Phase: PLAN. This document is a proposal for Sol spec review. It authorizes no implementation, model launch or paid execution.

- Delivery base: `cloud-base/b8-selection-to-start` at `fa673cc8f81ce1dac457ce383b47b2f3ac31f026` (one task/playbook commit above source).
- Source base: `cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a` (verified on origin; ancestor of the delivery base; the only diff is the two task documents).
- Result branch: `cloud/b8-selection-to-start`.

## 0. Goal, owner musts and approved exclusions

U81 delivers one end-to-end admission feature. An owner edits a B8 lineup selection and sees a pure server preview: the checker's single eligibility decision and reasons, the final reservation, role efforts and review counts. The owner then prepares an immutable request whose bytes match that preview, confirms the exact saved draft, and starts it separately. An ordinary review-family conflict is admitted only with a freshly bound, server-derived acknowledgement that the checker itself evaluates.

| # | Owner must | Behaviour (section) | Proof (section 9) |
|---|---|---|---|
| M1 | Selection = plan/spec/build/final slots + plan/spec/code review arrays, counts 0–3/0–3/1–3; slot = model/launcher route/effort | Strict B8 projection codec on preview **and intake** (2) | T1, T2 |
| M2 | Five preset roles map to spec/spec_reviews/build/code_reviews/final; plan roles independent | Codec role map constant (2.1), consumed later by D01a | T1 |
| M3 | Final never shares builder family (incl. fallback/either override); never waivable | Checker-owned rule; acceptance context can never satisfy it (4, 6) | T5, T7, R-tools |
| M4 | Only ordinary review-family conflict is acknowledgeable; preview creates no authority | Pre-stamped bound record evaluated by the checker (4) | T6–T9 |
| M5 | Paid consent, cap, family acknowledgement never saved in selections/presets/defaults | Codec refusals + P71 layer `overrides` refusal (2.3) | T3 |
| M6 | Each new run resets overrides; installed defaults cannot restore them | Override-origin blocker (2.4) | T3 |
| M7 | One P71 selection layer; non-B8 members preserved; whole-layer save at current expectedVersion | Layer codec `mergeSelectionLayerV1` (2.5); save control deferred to U82 | T4 |
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
| Absent | Nothing in loop policy, loop service, adapter, schemas, SQL or UI implements R296, a family policy, a review-only family rule, a lineup projection, `acceptSameFamilyRisk` or `familyRiskAcceptance`. The only "review-only" matches are unrelated (news/task-assignment code). `cr.py` is not in the repository. | evidence |

## 2. Selection model and codec (NEW `src/web/v1/loop-selection-wire.ts`, browser-safe)

### 2.1 Browser shape (closed)

```ts
export const loopSelectionEffortSchemaV1 = z.enum(["default","low","medium","high","xhigh","max"]); // same values as schemas.ts:21; NEW export
type Slot = { model: string /* roster name */; launcher: string /* roster launcher route */; effort: Effort };
type LoopSelectionV1 = {
  schemaVersion: 1;
  plan: Slot; spec: Slot; build: Slot; final: Slot;
  planReviews: Slot[];  // 0..3
  specReviews: Slot[];  // 0..3
  codeReviews: Slot[];  // 1..3
  overrides?: { reviewFamily?: true; standardFinal?: true };   // run-only (2.4)
};
export const loopPresetRoleMapV1 = { spec: "spec", spec_reviews: "specReviews", build: "build", code_reviews: "codeReviews", final: "final" } as const;
```

Strings use the existing id/label grammars. Every object uses zod `.strict()`. The codec rejects arrays outside their bounds, extra keys, override values of `false`/`null`, client acceptance/paid/cap members, and secrets (`assertNoSecretMaterial`). Duplicate models or types are not a product rule. They pass the codec, and the checker decides (T5 covers both outcomes).

### 2.2 Settings mapping (exact names are a tools prerequisite)

`encodeSelectionEditsV1(sel)` produces a P71 run-edit string `{"roles":{plan,spec,build,final,plan_reviews,spec_reviews,code_reviews},"overrides"?:{…}}` whose slot objects are `{model, launcher, effort}`. The existing B5 fixture corroborates `roles.code_reviews` as an array (`tests/helpers/improve-control-room-first-website.ts:138-144`). The other member names and the `overrides` member names **must be pinned from the released tools expectation schema (6)**. At the BUILD recheck, if the released names differ, 2.2 is blocked until the spec is corrected and re-reviewed. Every B8 member is written in full: slots always carry all three keys and arrays replace, so deep merge cannot leave lower-layer keys.

`decodeSelectionEditsV1(text)` is the inverse used by the **intake** path. When an intake `settingsEdits` contains any B8 member (`roles` or `overrides`), the whole B8 part must decode strictly, and it must round-trip byte-for-byte through the encoder. Otherwise the result is `invalid_request` with zero rows. Non-B8 run edits remain generic P71 edits, unchanged.

### 2.3 Never-saved members

`mergeSelectionLayerV1` and `decodeSelectionEditsV1` refuse acknowledgement, paid-consent and cap members. P71 `parseLoopSettingsV1(text, true)` already refuses `overrides` in layers, and this spec does not loosen it.

### 2.4 Override origin (product admission blocker, not checker eligibility)

If the composed text contains an `overrides` B8 member that differs from this run's edit, the product adds blocker `selection_override_not_run_scoped`. That happens when installed defaults carry it while the run edit omits it. A blocker refuses preview-to-Prepare and admission. It never changes the checker's `eligible`/`reasons`.

### 2.5 Layer codec for U82 (foundation only)

`mergeSelectionLayerV1(currentLayerText, selection) → text` replaces exactly the B8 `roles` members. It preserves every other valid member byte-equivalently, including `providerRoute:{providerId, model}` validated with `loopProviderRouteSchemaV1`. U82 must use it as the only writer through the existing P71 `PUT …/loop-policy/selection` at the current `expectedVersion`. U81 ships the function and its tests; it adds no save control.

## 3. One preview policy (NEW `src/web/v1/loop-selection-service.ts`)

`LoopSelectionServiceV1(db, scope, { desk, policy: LoopPolicyServiceV1, adapter: Pick<LoopAdapterV1,"checkSettings"|"providerRoutes"> })`.

`preview(identity, projectId, { selection })`:

1. **NEW authority shape (explicit):** `loopBridgeTransaction` gains an additive mode `"preview"`: `tasks.propose` high, read-only transaction, no project `FOR UPDATE`. Preview spawns a checker, so it is not a plain read. Inside it, the NEW additive `policy.snapshotRead(tx, projectId, runEdits)` (layers `FOR SHARE`) composes defaults + project + selection layers + `encodeSelectionEditsV1(selection)`. The existing `snapshot` is unchanged.
2. Outside every transaction: `adapter.checkSettings(text, { schemaVersion: 1, phase: "preview" })`, the additive context in section 6.
3. It returns the following, with no DB write, no claim and no acknowledgement:

```ts
type LoopSelectionPreviewV1 = {
  schemaVersion: 1; available: true;
  check: { eligible: boolean; reasons: { code: string; explanation: string }[] };   // exactly the checker's, unchanged
  blockers: { code: "paid_execution_unavailable" | "selection_override_not_run_scoped"; explanation: string }[]; // product-only
  settingsSha256: string; defaultsSha256: string; layerVersions: { project: number; selection: number };
  lineup: LoopSelectionProjectionV1;   // checker projection: rosterDigest, availabilityDigest, ordered slots
                                       // {role, index, requested, effective{model,launcher,family,class,effort,cost}},
                                       // reservedFinal, fallback, reviewFamilyPolicy, acknowledgeable: boolean
  lineupDigest: string;                // sha256 of the canonical projection
} | { schemaVersion: 1; available: false; reason: "checker_unavailable" | "projection_unavailable" | "reason_missing" };
```

Preview is `available:false`, never a guessed eligible, in these cases: the checker is missing; the projection is missing or invalid; an ineligible result has no reasons; or the projection's ordered roles/counts differ from the request. Differing effective model/effort values are shown, never substituted. Prepare is enabled only when `check.eligible && blockers.length === 0`, or when the only ineligibility is an acknowledgeable review-family conflict (`lineup.acknowledgeable`) and the owner ticks the acknowledgement. No lineup is seeded, because an incomplete selection fails the codec.

## 4. Acknowledgement (bound record, evaluated by the checker)

### 4.1 Browser intent

The intake and confirm bodies gain the optional `acceptSameFamilyRisk: z.literal(true)`. `false`, `null`, or any client run/actor/time/acknowledgement member is `invalid_request`. Start/stop/approve/answer bodies are unchanged.

### 4.2 Record

The claim binding gains one **optional, non-nullable** key, `familyRiskAcceptance`:

```json
{"schema_version":1,"rule":"R296","run":"<binding.loopRunId>","by":"owner","accepted_at":"<server ISO 8601 with offset>","acknowledgement":"same-family-risk-accepted"}
```

It has no other fields. Owner, input version and hashes come from the signed claim (`owner_identity_id`, `localVersion`, `requestSha256`, `settingsSha256`). `loopBridgeBindingSchemaV1` stays `schemaVersion: 1` with the key `.optional()`, so legacy rows still parse and verify.

### 4.3 Pre-stamped derivation (closes "checker never sees the record")

The settings text never acts as authority. `overrides.reviewFamily:true` only expresses the explicit override. The checker admits an ordinary review-family conflict only when it receives **both** that override in the bytes **and** a bound record in the admission context (tools packet 6.3).

- **Intake with intent:** the pre-claim read transaction (the one that already takes the policy snapshot) runs three steps in order:
  1. Reserve the run id (`adapter.reserveRun()` moves from the claim transaction into this preflight).
  2. Stamp `accepted_at = actor.now`.
  3. Build the exact record.

  Outside the transaction, the service calls `adapter.checkSettings(text, { schemaVersion:1, phase:"admission", operation:"intake", run, settingsSha256, familyRiskAcceptance: record })`. The claim transaction then:
  - rechecks `assertSnapshot`;
  - requires `accepted_at ≤ actor.now` and `actor.now − accepted_at < admissionFreshnessMs` (≤ 5000 ms);
  - signs the same record and `loopRunId` into the binding.

  An expired window means `conflict` with zero claims. The flag without `overrides.reviewFamily` is `conflict` (`acknowledgement_not_applicable`). A final/builder same-family result stays ineligible whatever the context (`standardFinal` is a separate edit and never waives).
- **Intake without intent:** this is today's path. `policy.check(snapshot)` is unchanged, and an ordinary flow stays positive.
- **Confirm:** the preflight already reads the observed status. If `observed.description === local.input.description`, Confirm will not revise. The service then reuses the record from the verified intake claim, but only if that claim's verified result is `accepted` and run, owner, `localVersion`, `requestSha256` and `settingsSha256` are all equal. A body flag is then redundant: it is accepted and ignored, and the original timestamp is kept. If the descriptions differ, Confirm will revise to a new input version. The body must then carry a fresh flag, and a new record is pre-stamped exactly as for intake. Without the flag, the admission check runs with `null` and refuses through the checker if acceptance is required.
- **Start / approve / answer:** the record is copied from the verified **accepted** Confirm claim for the same `localVersion`. That claim is found with the existing lookup pattern (`operation='confirm' AND binding->>'localVersion'=$v AND entry_kind='claim'`, `#verify` + `#verifyResult`, `result.state='accepted'`), with run/owner/hashes equal. These operations never derive a new record. Approve/answer bindings carry the same record, so every later expectation (`admissionExpectation`) and the recovery binding's `startBindingDigest` cover it. This is the product half of "one policy core across Start/manual/chained/final/recovery"; the engine half is tools packet 6.4.
- Refused, waiting or uncertain claims never establish acceptance. An exact key/body replay returns the original claim: one timestamp, one claim, one dispatch. A changed body under the same key is `conflict`. An uncertain prior intake/confirm must be reconciled through the existing exact replay before any replacement.

### 4.4 SQL (NEW migration pair; IDs allocated by the lead)

`db/migrations/<lead-id>_control_loop_selection_acknowledgement.sql` plus `<lead-id+1>_…_validate.sql` and matching `db/down/` files, following the 0306/0307 pattern:

- Replace the `binding` column CHECK `NOT VALID` (the lead reads its catalog name from `pg_constraint` on the landed schema) so it admits the optional `familyRiskAcceptance`, and only when:
  - the object has exactly the six keys, `schema_version=1`, `rule='R296'`, `run = binding->>'loopRunId'`, `by='owner'` and `acknowledgement='same-family-risk-accepted'`;
  - `accepted_at` matches `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$`;
  - the operation is in `('intake','confirm','start','approve','answer')`.
- Replace `control_loop_improvement_commands_check1` `NOT VALID`, admitting `acceptSameFamilyRisk` only as JSON `true` and only in intake/confirm bodies. All other predicates stay byte-identical to 0306.
- Row-level CHECKs (a NEW constraint, `NOT VALID` then validated):
  - (a) intake: body flag ⇔ record present;
  - (b) start/approve/answer: no body flag;
  - (c) record present ⇒ `(binding->'familyRiskAcceptance'->>'accepted_at')::timestamptz <= created_at`, which refuses future records;
  - (d) when the body flag is present: `created_at − accepted_at < interval '5 seconds'`.
  - The service enforces confirm reuse and the cross-row lineage, which a row CHECK cannot see. Each layer gets its own guard-off test.
- The validate migration validates all three. The down migration refuses (23514) while any row carries the key or flag; otherwise it restores the 0306/0307 definitions. No history is rewritten.
- Lead-owned items, in one commit, measured on the landed baseline:
  - the migration ledger (`deploy/postgres/migration-ledger.json`, `db/setup/production_migration_ledger.sql`);
  - grants (`deploy/postgres/desired-grants.json` if affected);
  - both schema pins (the private web schema digest read by `src/web/v1/private-database-preflight.ts`, and the release-pin tests);
  - preflight/fixture/catalog counts;
  - rollback chains.

## 5. Admission fences

- Checker and route work run outside transactions. **NEW** for Confirm and Start: a pre-transaction read of the saved `settings_text`, lineage and record, then `adapter.checkSettings(savedText, { schemaVersion:1, phase:"admission", operation, run, settingsSha256, familyRiskAcceptance: record|null })`. The existing admission transaction then re-reads under authority→project→policy (layers read lock)→waiver. P72 waivers are absent today, and `waiverId:null` is asserted. It refuses on any change to owner, input version, hashes, run link or record. Start checks the exact saved bytes and never recomposes from current layers/defaults.
- A missing checker gives `loop_policy_check_unavailable` with zero claims. A checker refusal gives 422 reasons with zero claims.
- **Lineup drift fence:** the admission check returns `lineupDigest` (6.2). It passes into the claim path as an additive member of the `admissionExpectation` context (`{operation, commandId, lineupDigest}`), so the binding gets no new field. The tools compare it under their mutation lock at spawn (tools packet 6.3), which turns roster/availability drift between check and spawn ("off after preview", "drift at dispatch") into an engine refusal. Product cloud proof covers four cases:
  - The digest passed equals the check's digest.
  - A scripted adapter that changes availability between check and claim makes the claim-transaction recheck refuse with zero spawns.
  - A scripted expectation compare refuses with an `INELIGIBLE` receipt and no second dispatch.
  - The existing `beforeSpawn` freshness window (`admissionFreshnessMs ≤ 5000`) is unchanged.
- Post-claim spawn failure gives the existing `LAUNCH_UNCERTAIN` receipt, never retried as execution. No external work runs under locks.

## 6. Tools prerequisite packet (unreleased; blocks real-tools qualification, not the cloud BUILD)

1. Additive `checkSettings(text, context?)` on `LoopAdapterV1` and `LoopPolicyServiceV1.tools`. An omitted context keeps today's behaviour, so P71 callers are byte-unchanged. `policy.check(snapshot)` is unchanged. A NEW `policy.checkWith(text, context)` returns `{eligible, reasons, lineup?}` without throwing on ineligible; preview and acknowledgement admission use it.
2. Additive contract pin `LoopAdapterContractV1.selectionProjection?: { schemaVersion:1; args(contextFile: string): string[]; decode(output: unknown): LoopSelectionProjectionV1 }`. If it is omitted, preview and every context-bearing admission are unavailable. Ordinary no-context admission stays on today's path.
3. A released, exact expectation schema + tooling revision + digest. It must declare:
   - the B8 member names (2.2) and the projection fields (3);
   - R296 semantics: acknowledgement is valid only with the override in the bytes **and** the bound context record whose `run` matches;
   - the strict review-only family policy, and that final/builder family is never waivable;
   - how `familyRiskAcceptance` and `lineupDigest` are read from `expect.json` and compared under the A2 lock.

   No digest is guessed here.
4. One policy core across Start/manual/chained/final/recovery lives in the tools engine. The product passes the same record to every expectation (4.3). The current F10c provider-route work does not supply this contract.
5. Qualified tools acknowledgement/expectation and R62/P72 release evidence remain integration prerequisites. This BUILD may not claim POLICY-ENFORCED-GREEN or SELECTION-TO-START-GREEN.

## 7. UI

NEW `private-app/app/loop-selection-panel.tsx` and NEW `src/web/v1/loop-selection-browser-client.ts`. Edits to `improve-control-room-workspace.tsx`, `improvement-intake-form.tsx`, `improvement-decisions.tsx` and `improvement-run-panel.tsx`.

- The panel is mounted above `ImprovementIntakeForm`. The intake form gains an optional `selection` prop: `{ settingsEdits, acceptSameFamilyRisk?, previewSha256, epoch }`. Without the prop, it behaves exactly as today.
- State: `editing → previewing → previewed(hash) → prepared(requestId, settingsSha256) → confirmed → started`.
  - Any edit returns to `editing`, clears the preview, disables Prepare, and unticks the acknowledgement.
  - A per-request epoch discards late responses from an earlier epoch.
- NEW `GET …/improvements/loop/:rid/selection` is a read-only signed-lineage projection with **no checker spawn**: `{ localVersion, requestSha256, settingsSha256, acceptance: { accepted_at } | null, previewRequired: { acknowledgement: boolean } | null }`. The values come from the verified claims/receipts and the display.
  - `improvement-decisions.tsx` enables Confirm only when the projection's `settingsSha256` equals the panel's `previewSha256` for the same request. Otherwise it shows a visible reason. On reload it shows "Preview again to confirm", because the browser holds no authority.
  - The acknowledgement flag is sent on Confirm only when `acceptance === null` and the preview required it.
  - `improvement-run-panel.tsx` disables Start with an explanation whenever the selection projection is stale or unmatched.
- After preparation, any lineup change requires a visible replacement intake (a new request with `settingsEdits`). The old bytes are retained, and the new request needs its own Confirm and a separate Start. The checkbox is never restored after reload.
- Accessibility: reasons and blockers are text lists. A disabled button has its explanation next to it. Focus moves to the status region. Targets are 44px. There is no horizontal overflow at 390 px.

## 8. Files

Existing files (narrow edits, BUILD only after Sol CLEAN + lead continuation):

| File | Change | Writer |
|---|---|---|
| `src/improve-control-room/v1/schemas.ts` | optional intake/confirm flag; optional binding record | U81 |
| `src/web/v1/improve-control-room-loop-service.ts` | 4.3 derivation, 5 admission checks, strict intake B8 decode | U81 |
| `src/web/v1/improve-control-room-loop-adapter.ts` | additive context, `selectionProjection` pin, `lineupDigest` expectation context | U81 (adapter caller); lead approves |
| `src/improve-control-room/v1/service.ts` | additive `"preview"` mode of `loopBridgeTransaction` | lead-named shared writer |
| `src/web/v1/loop-policy-service.ts` | additive `checkWith`, `snapshotRead`, tools type | lead-named shared writer |
| `src/web/v1/improve-control-room-http.ts` | `…/loop/:rid/selection` GET | U81 |
| `src/web/v1/mac-local-web-process.ts`, `src/web/v1/private-process.ts` | register preview handler | lead (process wiring) |
| `private-app/app/improve-control-room-workspace.tsx`, `improvement-intake-form.tsx`, `improvement-decisions.tsx`, `improvement-run-panel.tsx` | mount panel; selection prop; Confirm/Start gates | U81 |
| `tests/private-node-handler.test.ts`, `tests/improve-control-room-loop-bridge.test.ts`, `tests/loop-policy.test.ts` | transport/route regression; legacy positive flows | U81 |
| `package.json` | register new tests and lanes (9) | lead (package/CI lanes) |
| migration ledger/grants/pins | 4.4 | lead |

NEW files:
- `src/web/v1/loop-selection-wire.ts`
- `src/web/v1/loop-selection-service.ts`
- `src/web/v1/loop-selection-http.ts` (`POST /api/v1/projects/:id/loop-selection/preview`: same-origin, JSON, `privateRequestBudgets.default`, no query, no idempotency key, no PUT/DELETE)
- `src/web/v1/loop-selection-browser-client.ts`
- `private-app/app/loop-selection-panel.tsx`
- `tests/loop-selection.test.ts`
- `tests/loop-selection-postgres.test.ts`
- `tests/loop-selection-mutations.test.ts`
- `tests/browser/loop-selection.spec.ts`
- the migration pair and its down files (lead IDs)

Downstream contract: U82, D01a and D01b extend these modules sequentially. U83a supplies route-validation hooks consumed by `loop-selection-service.ts`. U83b is required before any paid execution.

## 9. Required BUILD commands and expected evidence

Run every command from the result branch at the BUILD head, on Node 22 with PostgreSQL 17 (`PG_BIN` set to a PG17 bin directory). The repository uses pnpm (`pnpm-lock.yaml`, `packageManager: pnpm@11.19.0`), so `pnpm run X` is the task's `npm run X`. Names marked NEW stay NEW until the lead registers them.

### 9.1 Affected tests (deciding)

```sh
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 \
  tests/loop-selection.test.ts tests/loop-policy.test.ts tests/improve-control-room-loop-bridge.test.ts \
  tests/improve-control-room-loop-ui.test.tsx tests/loop-providers.test.ts tests/private-node-handler.test.ts
```

**Red-first through existing entry points.** These must fail on the delivery base through `ImproveControlRoomLoopServiceV1.mutate` / the existing improvements HTTP handler / `composeLoopSettingsV1`, never through an import error:

- R1: intake `settingsEdits` with an extra B8 slot key or `codeReviews` count 4 is accepted today → expected `invalid_request`, zero rows.
- R2: intake with `acceptSameFamilyRisk:true` is `invalid_request` today → expected an accepted claim carrying the exact record of 4.2.
- R3: Start today performs no checker call → the expected spy count is 1, against the saved bytes.
- R4: a model turned off between intake and Start is admitted today → expected refusal with zero spawns.
- R5: a forged `familyRiskAcceptance` inserted into a signed row → expected `loop_command_integrity_failed` (today the strict schema already refuses, so R5 is a **regression guard**, not red evidence).

Codec unit tests (T1–T4) exercise NEW functions. They are not red evidence; R1 is their red proof through intake.

Cases (independent expected values):

- **T1 codec:** bounds 0..3/0..3/1..3 at −1/0/3/4; effort enum; preset map constant.
- **T2 strict refusal:** extra keys, `false`/`null` overrides, client acceptance/run/time members, secrets, oversize → `invalid_request` with zero rows, on both preview and intake.
- **T3:** layers carrying `overrides`/consent/cap are refused; defaults carrying overrides → blocker `selection_override_not_run_scoped`, with checker `eligible/reasons` unchanged.
- **T4:** layer merge preserves `providerRoute` and unknown valid members; a stale `expectedVersion` → conflict.
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

  It also covers `accepted_at` preserved across Confirm and Start, and a normalized Confirm requiring a fresh flag.
- **T8:** forged, cross-owner, cross-run, other-input-version, null, extra-key, naive-timestamp, future-timestamp and expired-window records → refusal. Replay keeps one timestamp, one claim and one dispatch (spy counts).
- **T9:** preview A then edit B; a tampered byte; off after preview; drift at admission; drift at dispatch (scripted expectation compare) → refusal with zero worker calls.
- **T10:** paid slot → blocker `paid_execution_unavailable`; `paidExecutionReady` stays `false`.
- **T11:** Start checks the exact saved bytes; a layer edited after intake does not change the text Start checks.
- **T12:** checker unavailable / projection missing / ineligible without reasons → preview `available:false`, admission zero claims.
- **T13 transport (in `private-node-handler.test.ts`):** the preview route refuses cross-origin, wrong content type, query string, oversize body (413), and PUT/DELETE.

### 9.2 Broad, DB, mutation, browser and loader lanes

```sh
pnpm run test:improve-control-room
PG_BIN=<pg17>/bin pnpm run test:improve-control-room-postgres        # + NEW tests/loop-selection-postgres.test.ts registered here
PG_BIN=<pg17>/bin pnpm run test:postgres-production
PG_BIN=<pg17>/bin pnpm run test:private-postgres-production-boundary
pnpm run check && pnpm run check:demo && pnpm run build
PG_BIN=<pg17>/bin pnpm run test:improve-control-room-loop-bridge-mutations
PG_BIN=<pg17>/bin pnpm run test:improve-control-room-loop-lineage-mutations
pnpm run test:improve-control-room-loop-ui-mutations
PG_BIN=<pg17>/bin pnpm run test:loop-selection-mutations             # NEW: CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 CONTROL_ROOM_PG_TEST_PORT_BASE=<lead> PG_BIN=… run-tests-with-quarantine --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-mutations.test.ts
pnpm run test:improve-control-room-loop-browser && pnpm run test:improve-control-room-loop-providers-browser
pnpm run test:loop-selection-browser                                 # NEW: CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 playwright test tests/browser/loop-selection.spec.ts
pnpm run check:test-loaders && pnpm run test:test-loaders
```

`tests/loop-selection-postgres.test.ts` must cover all of the following on PG17 with the production login role:
- fresh migrate;
- upgrade from the landed head with signed legacy rows that still verify;
- direct SQL CHECK positives/negatives for the record shape, the flag, row predicates (a)–(d), and operation scope;
- empty down restores the prior schema pin;
- refused-down with a retained row (23514, schema unchanged);
- atomic failure mid-migration;
- a 20-caller barrier on concurrent intake/Confirm/Start, with one claim per key and one Start per request;
- a guard-off proof for each fence. In a throwaway copy, remove the SQL predicate or service check, show the test fails, restore it and show it passes.

The lead adds both NEW scripts and the NEW test files to CI (`.github/workflows/ci.yml` PG17 mutation job, browser job) together with the loader guards.

### 9.3 Real-tools lane (separate, mandatory for qualification)

NEW `test:loop-selection:real` = `node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-name-pattern='^U81 real selection check$' tests/loop-selection.test.ts`.

- It is excluded from `test:improve-control-room` by extending the existing `--test-skip-pattern` exactly like P71, with a test asserting both patterns as `loop-policy.test.ts:53` does.
- It requires a qualified `CONTROL_ROOM_A2_TEST_LOOP`.
- It needs at least one deciding pass, zero skipped/quarantined, and real checker/Start/final negatives proving the strict review-only policy and the non-waivable final/builder family.
- It cannot run in this cloud, because the tools are not public.

### 9.4 Browser

`tests/browser/loop-selection.spec.ts` runs at 390×844 (touch) and 1280×850. It must show readable reasons and blockers, disabled-action explanations, focus movement, no overflow and 44px targets, and cover stale preview, reload (no checkbox restore, "Preview again") and late-response (epoch) cases. Viewport evidence is not device evidence.

### 9.5 Native proof boundary

The actual Start proof comes later and needs its own authorization. It must join the requested model/route/effort to the independently observed served model/family and input hash. It must record the argv, the settings bytes hash, the Confirm and PG lineage, the result, and Stop cleanup. Scripted workers cannot earn SELECTION-TO-START-GREEN. Qualified assembly and later authorization are blockers; this spec does not substitute an unavailable private engine.

## 10. Reviews required in BUILD

Authority, Start, data and migration changes need Claude attack and CI reviews plus the Sol code gate. BUILD also needs pinned Node 22 Linux CI parity and interruption/retry/cleanup evidence. No generic PUT/DELETE may be added, and no body, guard or lane may be weakened.

## Revision history

- r1 (PLAN): initial specification from `fa673cc8f81ce1dac457ce383b47b2f3ac31f026`.
- r2 (PLAN): addressed the plan-review helper findings:
  - pre-stamped acknowledgement record evaluated by the checker (two HIGH findings);
  - product blockers kept separate from checker eligibility;
  - strict B8 decode on intake;
  - `lineupDigest` drift fence;
  - checker-free selection GET;
  - stronger SQL row predicates;
  - approve/answer record propagation;
  - Start lookup of the accepted Confirm claim;
  - Confirm flag handling;
  - named `"preview"` authority mode;
  - run panel in the file list;
  - red-first only through existing entry points;
  - NEW mutation/browser commands and the transport regression;
  - corrected error code and the effort-enum note;
  - pnpm equivalence.
