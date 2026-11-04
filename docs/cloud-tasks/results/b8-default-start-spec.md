# b8-default-start (D01b) — PLAN specification

Phase: PLAN. Task: `docs/cloud-tasks/b8-default-start.md`. Playbook: `docs/cloud-tasks/playbook/CLOUD-LEAD.md`.
Source base: `cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a`. Delivery base: `cloud-base/b8-default-start` at `174c5da122c2d9bf8ee470e95cb6c5b4dce302b9`. That is one commit above the source; ancestry was verified.
This document is a proposal for the Sol spec gate. It authorizes no implementation, migration-number reservation, model launch or paid execution.

## Revision history

- r1 (PLAN): initial specification.
- r1.1 (PLAN): plan-review helper findings folded in. See `b8-default-start-evidence.md` §4.

## 0. Goal, owner musts and approved exclusions

D01b gives the owner one optional default preset per project. The owner can set it, change it and clear it. "Save as default" saves an edited selection and points the default at it in one atomic step. Picking a preset or the default fills an editable draft before Start, and Start goes through the actual worker after fresh revalidation and fresh override and acknowledgement authority. The system never picks a default and never seeds one.

| # | Owner must (task item) | Behaviour | Proof |
|---|---|---|---|
| M1 | Inspect predecessors and actual Start; extend, do not duplicate (1) | §1 facts; §2 dependency map; only D01a/U81/U82 modules are extended | review; G-list §9.5 |
| M2 | Nullable default pointer with integrity (2) | §3 migration: checked column plus composite FK `ON DELETE RESTRICT`; service delete clears the pointer atomically | P2–P5 |
| M3 | Exact default API and atomic Save (3) | §4 GET/PUT/POST `/loop-selection/default` | T1–T6, P6–P8 |
| M4 | Result grammar widened only by D01b; safe down (4) | §3.2 result CHECK; §3.3 down refusals | P9–P11 |
| M5 | Editable owner flow, local edits, renewed authority (5) | §6 UI state machine reusing U81/U82 | B1–B6, T7 |
| M6 | Shared transport alternative, strict refusals (6) | §5 one anchored `editPut` alternative | N1–N3 |
| M7 | Independent persistence/race/browser proof (7) | §9 P/B lists, 20-caller barrier, guard-off probes G1–G8 | §9 |
| M8 | Actual Start through the worker, withheld gate (8) | §7 Start chain and §10 native packet | Q1–Q4 (native) |

Approved exclusions:
- No provider chooser and no `providerRoute` persistence in presets or defaults (U83a).
- No paid run, cap, consent or reservation (U83b). Paid execution stays disabled.
- No second composer, policy or limits store, checker wrapper, identity source or default table.
- No change to `composeLoopSettingsV1`, `LoopPolicyServiceV1`, the checker or the signed input/journal readers.
- No package additions and no model launch in PLAN or BUILD.
- POLICY-ENFORCED-GREEN and DEFAULT-START-GREEN are not claimed by any cloud run.

## 1. Existing code and caller facts (inspected at the delivery base)

| Fact | Location |
|---|---|
| `composeLoopSettingsV1({defaultsText, project?, selection?, runEdits?})`. It deep-merges in this order: defaults, project layer, selection layer, run edits. Layers refuse `overrides`; run edits may carry it. Output is sorted-key canonical text plus `\n`, at most 65536 bytes, with its sha256. | `src/web/v1/loop-policy-compose.ts:12-51` |
| `LoopPolicyServiceV1`: `snapshot(tx, projectId, runEdits?)`, `assertSnapshot`, `check` (throws `LoopPolicyRefusedV1`), `view`, `put(identity, projectId, layer, input, key)`, `recordInputSources`, `copyInputSources`. It uses `WebSessionAuthority(..., "loop_policy")` with actions `loop_policy.read` and `loop_policy.manage` (owner, high risk). Writes lock the project row `FOR UPDATE`. Rows are integrity-checked by sha256 and parsed again on every read. | `src/web/v1/loop-policy-service.ts:26-144` |
| P71 HTTP: `GET /api/v1/projects/:p/loop-policy`, `PUT …/loop-policy/(project|selection)`. Same-origin or local-owner verification; query strings refused; `privateRequestBudgets.default`; 201 for a new write, 200 for a replay; 422 `policy_refused`. | `src/web/v1/loop-policy-http.ts:8-48` |
| Intake is the only operation that takes `settingsEdits` (string). Its body is `{description, settingsEdits?}` strict. Confirm, Start, Stop, Approve and Answer have closed bodies. | `src/improve-control-room/v1/schemas.ts:176-187` |
| Intake runs three steps. (1) Preflight transaction: `#policy.snapshot`. (2) `#policy.check` outside any transaction. (3) Admission transaction: fresh snapshot, `assertSnapshot`, `saveLoopDraft({description, settingsText: fresh.text})`, `recordInputSources`. Confirm revises the draft and `copyInputSources`. Start re-reads the signed lineage and does not recompose. | `src/web/v1/improve-control-room-loop-service.ts:514-640` |
| The adapter passes per-command settings copies to `intake/confirmRequest/start(..., settingsText?)`. `providerRoutes.resolveStartRoute(settingsText)` exists with `paidExecutionReady: false`. | `src/web/v1/improve-control-room-loop-adapter.ts:209-259, 293-296, 701-702` |
| Transport `requestHead`: `editPut` is an anchored allow-list (skills/recurring-rules items, `loop-providers/:id`, `loop-policy/(project|selection)`). Every other PUT gets 405. Production mode has `allowDelete:false`; Mac-local mode has `allowDelete:true`; setup mode has `allowPost:false`. | `src/web/v1/private-node-handler.ts:60-131` |
| Node factories `createPrivateNodeHandler` and `createMacLocalNodeHandler`. Both compose `LoopPolicyServiceV1` and its HTTP handler. | `private-node-handler.ts:239,262`; `private-process.ts:372,973`; `mac-local-web-process.ts:330,347` |
| Browser intake sends `{description}` only, and its key is `loop-intake:<uuid>`. Start and Stop use `loopImprovementBrowserClient.start/stop` with a frozen action body and key. | `private-app/app/improvement-intake-form.tsx:15-16`; `src/web/v1/improve-control-room-loop-browser-client.ts:31-62` |
| Last migration on this base: `0309_control_loop_provider_prices.sql` (ledger order 177). The down chain lives in `db/down/`. | `deploy/postgres/migration-ledger.json:1062` |
| Grants: `db/roles/private_web_roles.sql:322-334`. Revokes from the other roles: `db/roles/production_table_grants.sql:212-222`. Desired grants: `deploy/postgres/desired-grants.json`. | as listed |
| Schema pins: `privateWebSchemaDigest` and `src/updater/v1/policy/release-schema-digest.json`. Preflight column sets: `private-database-preflight.ts:282-285`. | `src/web/v1/private-database-preflight.ts:93` |
| Public table counts: 264 (`tests/improve-control-room-desk-postgres.test.ts:402,630`) and 255 (`tests/improve-control-room-desk.test.ts:722`). D01b adds no table. | as listed |
| Test DB: unit tests use PGlite (`tests/helpers/web-task.ts`). Real-cluster tests use `tests/helpers/disposable-postgres-cluster.ts`, which resolves `PG_BIN` and requires PostgreSQL 17. CI installs PG17 from the official apt repository (`.github/workflows/ci.yml:59-126`, Node 22). | as listed |
| Script names verified present in `package.json`: `test:improve-control-room`, `test:improve-control-room-postgres`, `test:postgres-production`, `test:private-postgres-production-boundary`, `check`, `check:demo`, `build`, `check:migrations`, `check:test-loaders`, `test:test-loaders`, `check:test-quarantine`, `test:loop-policy:real`, `test:improve-control-room-loop-browser`, `test:improve-control-room-loop-providers-browser`, `test:improve-control-room-loop-ui-mutations`. | `package.json` |

### 1.1 Absent on this base (dependencies, not present APIs)

None of these exist on the delivery base:
- `src/web/v1/loop-selection-*`;
- `private-app/app/loop-selection-panel.tsx` and `private-app/app/loop-presets-panel.tsx`;
- `control_loop_selection_presets` and `control_loop_selection_preset_state`;
- `loop_selection.*` authority actions.

Their PLAN-READY specifications exist on result branches. They were read for interface alignment only and nothing from them is merged here. Their heads were recorded at PLAN time:

| Chunk | Result branch head (PLAN-READY, unreviewed here) |
|---|---|
| U81 `b8-selection-to-start` | `cloud/b8-selection-to-start` `43f09d589fcea359653a9d500f706bc61c999db3` |
| U82 `b8-saved-selections` | `cloud/b8-saved-selections` `588c0b7b0d94b59c21d2e1ac2acb2333c85772de` |
| D01a `b8-named-presets` | `cloud/b8-named-presets` `67fcde7ae52c9a7c9c3f4570a63d1ae96c097a57` |

Every name below that is taken from those specifications is marked **(pred)**. At the BUILD recheck, the **released** names are substituted. Any interface change returns this spec to the Sol spec gate.

## 2. Dependency order and ownership

D01b BUILD needs these on its BUILD base, each released and inspected again before BUILD:
1. **U81 released (pred).** Selection wire and codec (`loop-selection-wire.ts`), `encodeSelectionEditsV1` to intake `settingsEdits`, preview service and HTTP (`POST …/loop-selection/preview`), the `acceptSameFamilyRisk` Confirm flag and its bound R296 record, the `selection_override_not_run_scoped` blocker, the `loop_selection.read/manage` actions, the selection panel and the browser client.
2. **U82 released (pred).** `revalidateLoopSelectionV1` (stale codes `model_off|model_missing|effort_removed|route_unavailable|route_unchecked|checker_unavailable`), `freshRunOverrideEditsV1`, `readLoopLimitsV1`, and the `mergeSelectionLayerV1` whole-layer save that preserves `providerRoute`.
3. **D01a released (pred).** `control_loop_selection_preset_state` (one version counter per tenant/project, `last_idempotency_key`, `last_request_digest`, `last_result`), `control_loop_selection_presets` (PK `(tenant_id,project_id,preset_id)`, `preset_id ~ '^preset:[a-f0-9]{32}$'`, case-insensitive unique name), the strict five-role preset parser, the `stale` projection, and CRUD (`POST …/presets`, `PUT …/presets/:id`, `POST …/presets/:id/remove`). Its §3.3 reservation and lock algorithm and its §4.3 replay rules also come from here.
4. **U83a (`b8-all-provider-choice`)** is optional for the cloud BUILD. If it is integrated, D01b calls its route-validation hook through U82's `revalidateLoopSelectionV1` and adds no consumer of its own. Without it, routed slots stay `route_unchecked` and block Prepare. The default never stores a `providerRoute`.
5. **U83b (`b8-paid-cap-mechanism`)** is not a prerequisite. Paid execution stays disabled (`paidExecutionReady:false`, U81 blocker `paid_execution_unavailable`).

Ownership:
- D01b owns the default pointer, `set_default`/`save_default`, the `/default` routes, the default UI controls and the editable-Start glue.
- D01a keeps the CRUD base semantics. D01b's only edit to them is in the delete path (§3.4).
- U81 and U82 keep the codec, preview, admission, revalidation and override reset.
- The lead names one writer each for: `private-node-handler.ts` `editPut`; the migration ledger, grants, `desired-grants.json`, both pins, preflight sets and the down-chain tests; `package.json` script lists; the mount in `improve-control-room-workspace.tsx`.

## 3. Default state with integrity

### 3.1 NEW migration `db/migrations/<NNNN>_control_loop_selection_default.sql`

NNNN is allocated by the lead in merge order, after D01a's migration. Nothing is reserved here.

```sql
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
ALTER TABLE control_loop_selection_preset_state
  ADD COLUMN default_preset_id text
    CONSTRAINT control_loop_selection_default_id_check
    CHECK (default_preset_id IS NULL OR default_preset_id ~ '^preset:[a-f0-9]{32}$');
ALTER TABLE control_loop_selection_preset_state
  ADD CONSTRAINT control_loop_selection_default_fk
  FOREIGN KEY (tenant_id,project_id,default_preset_id)
  REFERENCES control_loop_selection_presets(tenant_id,project_id,preset_id)
  ON DELETE RESTRICT;   -- MATCH SIMPLE: NULL pointer is unchecked, so "unset" needs no row
-- Widen only the result grammar (see 3.2). The constraint name is the one D01a lands,
-- re-read at BUILD (pred). It is dropped and re-added in the same statement list.
ALTER TABLE control_loop_selection_preset_state DROP CONSTRAINT <d01a_last_result_check>;
ALTER TABLE control_loop_selection_preset_state ADD CONSTRAINT <d01a_last_result_check> CHECK (( <3.2 predicate> ) IS TRUE);
```

Properties:
- **Cross-project pointer is impossible.** The FK reuses the state row's own `(tenant_id, project_id)`, so a pointer can only name a preset of the same tenant and project. A direct SQL attempt to point at another project's preset ID fails with 23503.
- **Raw referenced delete refuses.** `DELETE FROM control_loop_selection_presets` on the default row fails with 23503 because of `RESTRICT`.
- **Settings are never copied into state.** The state row keeps only catalog version and replay metadata plus the pointer. Selection bytes stay in the preset row.
- **The `ADD COLUMN` is nullable with no default,** so it is a metadata-only change on PG17. The `ADD CONSTRAINT … FOREIGN KEY` validates existing rows, which are all NULL. This matches the non-blocking-shape rules in `docs/MIGRATION_NON_BLOCKING_SHAPES.md`. BUILD rechecks against that document; if it requires `NOT VALID` plus a separate validate migration, BUILD follows the 0306/0307 pattern and the lead allocates two IDs.

### 3.2 Result grammar (state `last_result`)

The widened CHECK, written as one predicate:
- exactly the keys `operation`, `presetId`, `version`;
- `operation IN ('create','update','delete','set_default','save_default')`;
- `version` is an integer number from 1 to 9007199254740991;
- `presetId` is either a JSON string matching `^preset:[a-f0-9]{32}$`, or JSON `null` **only when** `operation='set_default'`;
- `octet_length(last_result::text) <= 4096`. This bound and the types and shape are unchanged from D01a.

Before this migration, D01a's CHECK still refuses `set_default` and `save_default`. P9 proves it on the D01a-only schema.

### 3.3 NEW `db/down/<NNNN>_control_loop_selection_default.sql`

```sql
BEGIN;
SET LOCAL lock_timeout = '1s'; SET LOCAL statement_timeout = '5s';
LOCK TABLE control_loop_selection_preset_state IN ACCESS EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM control_loop_selection_preset_state
             WHERE default_preset_id IS NOT NULL
                OR last_result->>'operation' IN ('set_default','save_default')) THEN
    RAISE EXCEPTION 'loop selection default retained' USING ERRCODE = '23514';
  END IF;
END $$;
ALTER TABLE control_loop_selection_preset_state DROP CONSTRAINT <d01a_last_result_check>;
ALTER TABLE control_loop_selection_preset_state ADD CONSTRAINT <d01a_last_result_check> CHECK (( <D01a predicate verbatim> ) IS TRUE);
ALTER TABLE control_loop_selection_preset_state DROP CONSTRAINT control_loop_selection_default_fk;
ALTER TABLE control_loop_selection_preset_state DROP COLUMN default_preset_id;
COMMIT;
```

- The down is atomic: a refusal rolls back everything, and the schema digest equals the pre-down digest (pattern of `tests/loop-policy.test.ts:73-99`).
- The down never rewrites `last_result` or any signed history. A retained `set_default` or `save_default` result means the down refuses. Clearing it would need a later ordinary D01a write such as `update`, which replaces `last_result`.
- An empty down restores the D01a schema digest exactly. P11 measures it on the landed D01a base and never copies an old value.

### 3.4 Service delete (D01a delete path, extended)

D01a's `POST …/presets/:id/remove` runs under the one state-row lock. After the replay and version checks:
1. If `state.default_preset_id = :id`, run `UPDATE state SET default_preset_id = NULL` in the **same** statement that increments `version` and writes `last_*`.
2. Then `DELETE` the preset.
3. One version increment. Result `{operation:'delete', presetId:id, version}`.

The UPDATE runs before the DELETE, so RESTRICT is satisfied. A failure at any step rolls back pointer, preset and state together (P8 fault injection).

## 4. Exact default API and atomic Save

All routes extend the U81 selection HTTP handler (pred `src/web/v1/loop-selection-http.ts`), which D01a already extends with `/presets`:

| Method | Path | Body (strict) | Result |
|---|---|---|---|
| GET | `/api/v1/projects/:p/loop-selection/default` | none | `{version, presetId}`. `version` is the catalog version, 0 before the first write. `presetId` is `null` when unset. |
| PUT | `/api/v1/projects/:p/loop-selection/default` | exactly `{expectedVersion, presetId}`; `presetId` is a preset ID string or `null` (clear) | `{operation:'set_default', presetId, version, replayed}` |
| POST | `/api/v1/projects/:p/loop-selection/default` | exactly `{expectedVersion, selection}` plus **exactly one** of `presetId` or `name` | `{operation:'save_default', presetId, version, replayed}` |

Rules:
- **Shape.** `expectedVersion` is an integer from 0 to MAX_SAFE_INTEGER-1. `presetId` matches `^preset:[a-f0-9]{32}$`. `name` follows D01a's name rules. `selection` is parsed with D01a's strict five-role preset parser (pred). That parser refuses `plan`, `plan_reviews`, `overrides`, limits, acknowledgements, paid consent, cap, `providerRoute` and any extra key, plus secrets through `assertNoSecretMaterial`. Missing `selection`, both or neither target, `null` for `presetId` or `name` on POST, extra keys and a query string are all `invalid_request` (400) with zero writes.
- **POST with `presetId`** updates that existing preset's `selection_text` and `selection_sha256` **without renaming**, then sets the pointer to it. An unknown or other-project `presetId` gives `not_found` with zero writes.
- **POST with `name`** creates a new preset with ID `preset:<32 hex>` from `randomBytes(16)`. It then sets the pointer to it. A case-insensitive name collision gives `conflict` (`name_conflict`) with zero writes.
- **PUT with a `presetId`** points at an existing same-project preset, otherwise `not_found`. **PUT with `null`** clears. Clearing when already unset is still a versioned write: version+1, result `presetId:null`. That keeps replay semantics uniform (decision D4).
- **Atomic.** Each request has one transaction and one state-row lock. Preset write and pointer write happen in one `UPDATE` of state (`version=version+1, default_preset_id=$p, last_*`). The rowcount must be 1 and the `WHERE` must include `version=$expected`. If the pointer write fails, the preset write rolls back too.
- **Two transactions, same as D01a (pred §4.4).**
  - A read-only preflight runs `loop_selection.manage` (owner, high), scope, replay check, version check and existence/name pre-check.
  - The commit transaction repeats all of them under the state reservation or lock (D01a §3.3 `INSERT … ON CONFLICT DO NOTHING` for version 0), writes, and re-checks authority before commit.
  - No checker spawn and no roster read on writes.
  - Authority actions are U81's `loop_selection.read/manage` (pred). D01b adds no new action.
- **Idempotency.** `Idempotency-Key` is required, with syntax `^[A-Za-z0-9:_-]{16,100}$`. The digest is `sha256Digest({operation, projectId, presetId|null, body})`. Here `operation` is `set_default` or `save_default`, and `presetId` is the body target, or `null` for clear and for name-create. Behaviour:
  - Same latest key and same digest: return the stored `last_result` with `replayed:true` and HTTP 200, including after a later preset delete.
  - Same latest key, different digest: 409.
  - An older key is not remembered. Its retry goes through the version check, which gives 409.
  - New writes return 201.
- **Failures.** 40P01 and 40001 map to `conflict` (the existing `rethrowLoopPolicyErrorV1` pattern). A 23503 from the FK cannot happen on the service path, because existence is checked under the same state lock that delete takes. If it occurs anyway it maps to `conflict` and is never swallowed.
- **GET** is read-only (`{ readOnly: true }`). It never spawns a checker and never starts a worker.

## 5. Shared transport and refusal

Add one alternative to `editPut` in `src/web/v1/private-node-handler.ts` (shared writer):

```ts
|| /^\/api\/v1\/projects\/[^/?]+\/loop-selection\/default$/.test(target)
```

- The D01a preset alternative, the provider and policy alternatives and the skills/recurring-rules alternatives stay byte-identical.
- POST needs no transport change. There is no DELETE route.
- `allowPost`, `allowDelete`, the CSRF and origin checks, `bodyAllowed` and `privateRequestBudgets` are unchanged.
- Worst-case body size: selection about 4800 bytes after escaping (D01a §5), plus name up to 640, plus keys and version under 120. That is about 5560 bytes, under `privateRequestBudgets.default` (8192). No budget entry is added.
- Setup mode keeps `allowPost:false`, so PUT `/default` stays 405 there.

## 6. Editable owner flow (UI)

These are extensions of the U81 selection panel and the D01a presets panel (both pred). Files: `private-app/app/loop-presets-panel.tsx` (D01a NEW, extended) and the U81 panel (extended). Client methods are added to the U81 browser client (pred `src/web/v1/loop-selection-browser-client.ts`): `readDefault`, `setDefault(expectedVersion, presetId|null)`, `saveAsDefault(expectedVersion, selection, {presetId}|{name})`. They use the same fetch options as the existing clients (`credentials:'same-origin'`, `cache:'no-store'`, `redirect:'error'`). The idempotency key is generated once per user action and reused for retries of that action.

State machine (draft is local; nothing persists until an explicit save):
1. **Load.** The panel reads `GET /default`, D01a `GET /presets` and the U81 form. No preset fills the form automatically and no lineup is seeded. When a default exists, the panel shows a "Use default (<name>)" action. The owner must press it.
2. **Pick preset or default.** This copies the five B8 roles into the form, leaves the plan slots as they are, resets both override controls to off, unticks the acknowledgement and clears preview and prepared state. It then runs U82 `revalidateLoopSelectionV1` straight away. Stale slots show readable reasons from §2 item 2, and Prepare is disabled with its explanation. A slot is never substituted silently.
3. **Edit.** Any change returns the form to `editing`, which clears preview, the prepared hash and acceptance. It never mutates a preset or the default.
4. **Save** (D01a update or create) and **Save as default** (POST `/default`) are explicit buttons. Save as default offers "update <picked preset>", which uses `presetId`, or "save as new preset <name>", which uses `name`. On success the form keeps its values, and the catalog and default views refresh.
5. **Policy locks.** If the P71 view or R62/P72 lock data (an integration prerequisite, see §10) marks a member locked, that control is read-only. A pick that conflicts with a lock is stale (`policy_locked`), and Prepare is disabled. Without released lock data the UI shows nothing extra and claims no enforcement.
6. **Prepare / Confirm / Start.** This is the U81 flow. Prepare is enabled only when the preview is eligible with no blockers, or when the only conflict is an acknowledgeable review-family conflict and the box is ticked. Prepare sends intake with `settingsEdits = encodeSelectionEditsV1(form) + freshRunOverrideEditsV1()` (U81/U82). Confirm sends `acceptSameFamilyRisk` only when required. Start is a separate button (existing `start`).
7. **Revision after prepare.** An edit after a prepared request leaves the old request untouched. Preparing again creates a **new** intake (new key, new request ID). That requires a new Confirm and fresh acceptance. A default change never rewrites an existing request or run.
8. **Late, retried and uncertain responses.**
   - Each panel request carries a sequence number. A response older than the latest applied catalog version or sequence is discarded.
   - Before creating a replacement after a timeout or uncertainty, the client re-reads the **exact** command by its stored idempotency key through the existing status path. If the command turns out to be accepted, the UI shows that request and never opens a duplicate.
   - Receipt `LAUNCH_UNCERTAIN` blocks Start and replacement until status resolves it.
9. **Layout.** At 390×844 touch and at 1280×850: no horizontal overflow, targets of at least 44 px, focus moved to the error or result, and a readable explanation on every disabled action.

## 7. Actual Start chain (no new admission path)

```
default pointer ─► D01a preset row (strict parse, sha256 check) ─► form (editable)
form ─► U81 encodeSelectionEditsV1 + U82 freshRunOverrideEditsV1 ─► intake settingsEdits
intake ─► LoopPolicyServiceV1.snapshot/check/assertSnapshot ─► saveLoopDraft(settingsText=composed) + recordInputSources
confirm (+acceptSameFamilyRisk, U81 R296 record) ─► start(runLinkId) ─► adapter.start(settingsText copy) ─► worker
```

- The default contributes only through the form. It never becomes a P71 layer.
- The three persisted limits come from defaults and the project layer, through U82 `readLoopLimitsV1` (pred, with the P-L path prerequisite).
- The signed input, `settings.json` copy, argv, Confirm display and `control_loop_policy_input_sources` must all equal the composed bytes.
- Family acceptance stays bound by U81's record. A default renews no money authority and no family authority.

## 8. Files (BUILD proposals, after Sol CLEAN and lead continuation)

Extended, owned by D01b:
- `src/web/v1/loop-selection-service.ts` (pred) gains `viewDefault`, `setDefault`, `saveAsDefault`, and the delete-pointer clear inside D01a's delete.
- `src/web/v1/loop-selection-http.ts` (pred) gains the `/default` GET/PUT/POST branch.
- `src/web/v1/loop-selection-wire.ts` (pred) gains the strict `defaultSetBodyV1`, `defaultSaveBodyV1` and result schemas.
- `src/web/v1/loop-selection-browser-client.ts` (pred) gains three methods.
- `private-app/app/loop-presets-panel.tsx` (pred) and the U81 selection panel (pred) gain the default UI.

Shared, one lead-named writer:
- `src/web/v1/private-node-handler.ts` (one `editPut` alternative).
- NEW `db/migrations/<NNNN>_control_loop_selection_default.sql` and `db/down/<NNNN>_control_loop_selection_default.sql`.
- `db/roles/private_web_roles.sql`: `GRANT UPDATE (default_preset_id) ON control_loop_selection_preset_state TO control_room_private_web;` and nothing else. The table-level revokes from D01a already cover the new column for other roles.
- `deploy/postgres/desired-grants.json`.
- `deploy/postgres/migration-ledger.json`, through `node scripts/generate-migration-ledger.mjs` and verified by `node scripts/verify-migration-ledger.mjs`.
- `src/web/v1/private-database-preflight.ts`: add `default_preset_id` to the update-column set, plus the `privateWebSchemaDigest` pin.
- `src/updater/v1/policy/release-schema-digest.json`.
- Down-chain tests that rebuild earlier baselines, which must apply this down first: `tests/loop-policy.test.ts:101`, `tests/loop-providers.test.ts`, and any test greping `0309_` (`tests/improve-control-room-*-postgres.test.ts`).
- Catalog counts stay unchanged (no new table). BUILD measures them and asserts no change.
- `package.json`: NEW browser script `test:improve-control-room-loop-default-browser` and NEW real lane `test:loop-selection-default:real`.

NEW tests (unregistered until the lead registers them):
- `tests/loop-selection-default.test.ts` (PGlite unit and HTTP);
- `tests/loop-selection-default-postgres.test.ts` (PG17 production login);
- `tests/browser/loop-selection-default.spec.ts`.

## 9. REQUIRED future BUILD checks

### 9.1 Unit and HTTP (`tests/loop-selection-default.test.ts`, NEW)

- **T1.** GET before any write gives `{version:0, presetId:null}`.
- **T2.** Save as default with `name` and then with `presetId`:
  - each gives exactly one state version increment;
  - the pointer equals the target;
  - the `presetId` branch keeps the name and changes `selection_sha256`;
  - the `name` branch creates exactly one preset.
- **T3.** PUT set, then PUT replace, then PUT `null` clear. Versions are +1 each, and the results are `set_default` with the ID or with `null`.
- **T4 strict refusals, each with zero rows changed (row snapshot equality):**
  - missing `selection`;
  - both `presetId` and `name`, or neither;
  - `presetId:null` on POST;
  - `name:null`;
  - extra key;
  - `overrides`, `plan`, `providerRoute`, `paidConsent` or `cap` in the selection;
  - a secret-looking value;
  - non-integer or negative `expectedVersion`;
  - a query string;
  - a missing or bad idempotency key;
  - an unknown or foreign-project `presetId`, which gives 404.
- **T5 authority.** These are refused before any write:
  - non-owner;
  - operator;
  - expired session;
  - revoked between preflight and commit;
  - foreign scope.
  GET never calls `checkSettings` and never calls an adapter operation (spy counts 0).
- **T6 replay.**
  - Same key and same body after a later preset delete replays the stored result (200).
  - Same key with an altered body gives 409.
  - An older key gives 409 from the version check.
  - A stale `expectedVersion` gives 409.
- **T7 flow glue.** The fresh-run edits that a picked default produces contain the override controls as explicit `false` and no acknowledgement. A composed text whose defaults contain `overrides:true` raises U81 blocker `selection_override_not_run_scoped` (pred).

### 9.2 Node transport (extend `tests/private-node-handler.test.ts`)

- **N1.** Through both `createPrivateNodeHandler` and `createMacLocalNodeHandler`, using the real handler and service: PUT set, PUT clear, POST save with `name`, POST save with `presetId`, then a replay.
- **N2.** All of these get 405 with zero writes, in both modes:
  - PUT `/loop-selection/default/x`;
  - PUT `/loop-selection/defaults`;
  - PUT with `?a=1`;
  - PUT in setup transport;
  - DELETE `/default`. Production returns 405 from transport. Mac-local refuses in the inner handler.
  A body over 8192 bytes gets 413.
- **N3.** The existing P71, provider and D01a transport tests still pass unchanged.

### 9.3 PostgreSQL 17 (`tests/loop-selection-default-postgres.test.ts`, NEW; production login `control_room_private_web`; disposable cluster helper)

- **P1.** Fresh schema up to and including the new migration: the column exists and is NULL; the FK and CHECK exist; schema digest equals both pins.
- **P2.** As the web login, a raw `DELETE` of the default preset gives 23503, and the rows are unchanged.
- **P3.** As the migrator, a raw `UPDATE` setting the pointer to another project's preset ID gives 23503. A malformed ID gives 23514.
- **P4.** The web role may `UPDATE (default_preset_id)`. It may not `UPDATE` other unlisted columns, `DELETE` state or `TRUNCATE` (42501). The other six roles have no access.
- **P5.** Service delete of the default clears the pointer and deletes the preset, with exactly one version increment and result `delete`.
- **P6 persistence.** Save as default, close the pool, start a new process or pool, then GET default and GET presets: same ID, version and selection bytes. Then edit locally and confirm nothing changed in the DB. Then replace, clear and verify again after a reopen.
- **P7 races.**
  - Twenty callers behind a barrier, spread over at least 4 owner identities, because identity rows serialize writers. This follows D01a P11. Run once at version 0 and once at version N, mixing PUT set, PUT clear and POST save.
  - Expected: exactly one 201, nineteen 409, state version +1, and pointer, preset count and `last_result` consistent with the single winner.
  - Same-key pair: one 201 and one 200 replay. Same key with an altered body: 409.
  - A concurrent service delete against PUT set of the same preset: either delete wins and PUT gives 404, or PUT wins and delete clears the pointer. The pointer never dangles.
- **P8 atomic failure.** A fault hook in the test DB wrapper, not in production code:
  - after the preset write and before the state UPDATE;
  - after the state UPDATE and before commit;
  - a process kill mid-transaction.
  In every case preset, pointer and state are unchanged.
- **P9 pre-migration refusal.** On the D01a-only schema, direct inserts or updates of `last_result` with `set_default`, `save_default` or `presetId:null` give 23514.
- **P10 refused down.** With a non-null pointer, the down gives 23514. With a null pointer but `last_result.operation='set_default'`, it also gives 23514. In both cases the schema digest is unchanged and the rows are unchanged.
- **P11 empty down.** After an ordinary D01a `update` replaces the last result and the pointer is null, the down succeeds and the digest equals the measured D01a digest. Then up again gives the D01b digest. Also covered: upgrade from the measured D01a head with retained D01a rows.
- **P12.** `node scripts/verify-migration-ledger.mjs` passes, desired grants match, and the public table count equals the measured pre-D01b value (unchanged).

### 9.4 Browser (`tests/browser/loop-selection-default.spec.ts`, NEW; 390×844 `hasTouch` and 1280×850)

- **B1.** No default: the form is empty, there is no auto-fill, and Prepare is disabled with an explanation.
- **B2.**
  1. Save as default (new name).
  2. Reload: "Use default" shows the name. Pick it: the form is filled, overrides are off and acceptance is unticked.
  3. Edit one slot: preview is cleared and the default is not mutated (GET equal).
- **B3.** The roster switches the default's model off. The stale reason is readable, Prepare is disabled with an explanation, and nothing is substituted.
- **B4.** Prepare and Confirm with an acknowledgement, then edit, then re-prepare. The result is a new request ID, Confirm and acknowledgement are required again, and the old request is unchanged.
- **B5 late A, edit B.** Delay the response for preset A's pick, pick B, then release A. The form shows B. Save-as-default retry after a network drop reuses the same key, and the server sees one write.
- **B6 uncertainty.** A stubbed `LAUNCH_UNCERTAIN` receipt blocks Start and replacement until status is read. The 409 version-conflict path reloads the catalog and keeps the typed input.
- **Every case.** Targets are at least 44×44, `scrollWidth <= innerWidth`, focus is placed, and every disabled action has text.

Viewport evidence is not device evidence.

### 9.5 Guard-off probes (isolated throwaway copy only; prove the deciding assertion fails, restore, prove it passes)

| Probe | Removed guard | Expected failure |
|---|---|---|
| G1 | the `/default` `editPut` alternative | N1 PUT gets 405 |
| G2 | owner-only on `loop_selection.manage` for `/default` | T5 non-owner write succeeds |
| G3 | the FK (in migration copy) | P2 raw delete succeeds and the pointer dangles |
| G4 | both version guards (explicit check and `WHERE version=$expected`) | P7 shows more than one winner |
| G5 | the existence check under the state lock | T4/P7 PUT to a missing or just-deleted preset reaches the FK. It surfaces as a 23503 conflict or 500 instead of the asserted 404. The FK still prevents a dangling pointer. |
| G6 | the override reset on pick | B2/T7 sees an inherited override or acknowledgement |
| G7 | current-route/roster revalidation on pick | B3 Prepare is enabled |
| G8 | the down refusal | P10 down succeeds with a retained pointer |

### 9.6 Commands (BUILD records exact output, exit, counts and elapsed time)

```
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-default.test.ts tests/private-node-handler.test.ts tests/loop-policy.test.ts tests/loop-providers.test.ts tests/loop-roster.test.ts <released U81/U82/D01a selection and preset test files>
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 PG_BIN=<pg17 bin> node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-default-postgres.test.ts <released D01a postgres test file>
npm run test:improve-control-room
PG_BIN=<pg17 bin> npm run test:improve-control-room-postgres
PG_BIN=<pg17 bin> npm run test:postgres-production
PG_BIN=<pg17 bin> npm run test:private-postgres-production-boundary
npm run check
npm run check:demo
npm run build
npm run check:migrations
npm run check:test-loaders && npm run test:test-loaders && npm run check:test-quarantine
npm run test:improve-control-room-loop-default-browser          # NEW
npm run test:improve-control-room-loop-browser                  # neighbour regression
npm run test:improve-control-room-loop-providers-browser        # neighbour regression
npm run test:improve-control-room-loop-ui-mutations             # affected mutation lane
npm run test:loop-policy:real                                   # existing exact-name real lane
npm run test:loop-selection-default:real                        # NEW exact-name real lane (§10)
```

Expected results:
- New deciding counts: T1–T7, N1–N3 (two factories each), P1–P12, B1–B6 (two viewports each). Each assertion is derived independently from fixtures, not copied from implementation output.
- Broad lanes may skip real-tools cases. A skip is never tools evidence. Each `:real` lane must show at least one deciding pass and zero skipped or quarantined tests, or it is reported NOT RUN (native).

Failing-first:
- T1–T6 and N1 call the released U81 selection handler and the existing Node factories. Before implementation they must fail with 404 (route absent) or 405 (transport), never with an import or setup error.
- P2, P3, P9 and P10 run against the released D01a schema before the migration exists. P2 then shows the raw delete **succeeding**, which proves the RESTRICT is absent.

## 10. Actual Start and the withheld gate (native packet)

DEFAULT-START-GREEN needs all of the following, observed with a **qualified** worker, never a stub:
- **Q1.** An owner-edited default reaches the worker. The model, route, effort and served family that the worker reports are joined to the exact signed input version, settings sha256 and command ID.
- **Q2.** The three persisted limits that the worker reads equal the composed bytes and `readLoopLimitsV1`. Requires U82 P-L, the limit paths.
- **Q3.** For an acknowledged review-family conflict, the bound R296 record reaches the checker in the admission context (U81 tools packet). A final/builder same-family default stays refused.
- **Q4.** Stop during the run, then confirm the worker process tree is reaped and the temporary files are cleaned. The run's journal shows exactly one Start and one Stop.

Proposed NEW exact-name lane `test:loop-selection-default:real`:

```
node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-name-pattern='^D01b real default start$' tests/loop-selection-default.test.ts
```

It needs the qualified tools (`CONTROL_ROOM_A2_TEST_LOOP`, same as `test:loop-policy:real`) and a lead-authorized native machine. A real model launch, if the lead authorizes one, is a separate native authorization.

Prerequisites, all outside this cloud:
- qualified `cr` tools and worker;
- the U81 tools packet (checker context);
- U82 P-L;
- R62/P72 admission, locked-edit and scoped-waiver release evidence;
- U83a route hook for routed slots;
- U83b plus per-call qualification before any paid route.

Real-device evidence (phone and desktop hardware) is separate from viewport evidence. Scripted or native proof is never interchangeable with it.

## 11. Cloud scope versus withheld qualification

- **Buildable on a cloud after U81, U82 and D01a are released:** §9.1, §9.2, §9.4 and §9.5, typecheck and build, loader guards, and §9.3 **only if PG17 is present**.
- **This PLAN machine could not obtain PG17.** The official apt repository and ftp.postgresql.org were both refused by the network proxy, and only Ubuntu 16.15 is present. A later BUILD without PG17 must label P1–P12 **PG17-later**, run them with the commands in §9.6 on a PG17 host, and cannot reach BUILD-READY for DB scope.
- **Withheld:** §10 Q1–Q4; both `:real` lanes; real-device evidence; R62/P72; pinned Node 22 Linux CI parity on the lead's integration candidate; attack and CI reviews (authority, Start, data and migration all change).
