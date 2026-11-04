# b8-named-presets (D01a) specification — PLAN

Revision history:
- r1 (PLAN): first draft.
- r2 (PLAN, this commit): applied Claude plan-review findings F1–F10 (see evidence). No implementation.

Delivery base: `cloud-base/b8-named-presets` `1828b4474a6caa5a90b22ff09f849e26c633ed99` (one task commit above source `cook/b7-providers` `412d0c149fe8e272c491900d7a9164f80ecb612a`; ancestry verified with `git merge-base --is-ancestor`, exit 0).
BUILD estimate: 6–10 hours; split only at the seams in §10 through lead continuations.

## 0. Goal, owner musts and exclusions

Goal: owner CRUD for multiple named five-role presets per project, persisted restart-safe in PostgreSQL, with full browser flows. Picking a preset copies an editable draft into the U81 selection form; it grants nothing.

| # | Owner must (task) | Behavior | Proof (§9 ids) |
|---|---|---|---|
| M1 | Multiple named presets of five roles with effort and reviewer multiplicity; plan roles independent | Strict preset shape §2; plan slots never read from or written to a preset | T1, T2, B1 |
| M2 | Preset JSON only B8 roles/counts; refuse override/limit/ack/consent/cap/providerRoute/extra keys at write AND read | Strict parser on write; same parser on every row read; SQL CHECK closes top/role keys | T3, P3 |
| M3 | Name trimmed 1–80, no TAB/CR/LF, case-insensitive unique per tenant/project via expression index | §2.3 + §3.1 index | T4, P4 |
| M4 | No seeded lineup, no count cap, no automatic default | Empty catalog until owner creates; no default column/pointer | T5, P1 |
| M5 | Ineligible-but-structural presets save, are visibly stale, never authorize preparation | `stale[]` on read; Pick only fills draft; U81 preview remains sole gate | T6, B2 |
| M6 | Catalog + state tables, versioned result `{operation,presetId,version}` ≤4 KiB | §3 | T7, P2 |
| M7 | Owner-only project-scoped read/manage with preflight and precommit recheck | §4.1 | T8, P5 |
| M8 | Idempotency-Key on every mutation; replay after deletion; conflicts on changed body/older version | §4.3 | T9, P6 |
| M9 | One anchored `editPut` alternative in both Node factories; POST remove; 8 KiB outer envelope | §5 | N1–N3, G1 |
| M10 | Browser CRUD/reload/conflict/stale/focus/error/retry/late response on phone and desktop | §6 | B1–B4 |
| M11 | One lead-allocated up/down pair, minimum grants, six-role revokes, ledger/pins/preflight/counts in one commit; down refuses retained rows | §7 | P7–P9 |
| M12 | Restart persistence, 20-writer barrier races, atomic rollback | §8 | P10–P12 |
| M13 | Stable contract handed to D01b without preauthorizing its migration | §11 | review only |

Approved exclusions: no default pointer, Save-as-default or editable Start (D01b); no provider chooser or `providerRoute` storage in presets (U83a); no paid run, cap, consent or reservation (U83b); no Start/admission change; no model launch; no package additions; no change to `composeLoopSettingsV1`, `LoopPolicyServiceV1`, the checker or input/journal integrity readers. POLICY-ENFORCED-GREEN is not claimed (R62/P72 evidence is an integration prerequisite outside this chunk).

## 1. Existing code facts and missing predecessors

Present on this base (inspected; line numbers at `1828b44`):

- `src/web/v1/loop-policy-compose.ts`: `parseLoopSettingsV1(text, layer)` (strict JSON ≤65536 bytes via `parseStrictJsonV1`, refuses `__proto__/prototype/constructor`, non-finite numbers, `overrides` in a layer, secret material via `assertNoSecretMaterial`); `composeLoopSettingsV1({defaultsText,project,selection,runEdits})`.
- `src/web/v1/loop-policy-service.ts`: `LoopPolicyServiceV1` with `view`, `put(identity,projectId,layer,input,key)`, two-transaction check-then-commit pattern, `#scope` (project row `FOR UPDATE` on write; project+head `FOR SHARE`, template `control-room`, lifecycle `active`), idempotency key syntax `^[A-Za-z0-9:_-]{16,100}$`, id syntax `^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$`, `rethrowLoopPolicyErrorV1` maps 40P01/40001 to `conflict`. Selection layer is stored in `control_loop_policy_layers` row `layer='selection'`.
- `src/web/v1/loop-policy-http.ts`: GET `/api/v1/projects/:id/loop-policy`, PUT `/loop-policy/(project|selection)`; inner cap `privateRequestBudgets.default`; 413/422 mapping.
- `src/web/v1/session-authority.ts`: `WebSessionAuthority(db,scope,clock,resourceType)`; `actor.require(action,projectId,ownerOnly,risk)` records each check and re-runs all of them in `transactionWithPreCommitCheck`'s precommit callback (~lines 127–131). This is the "authenticated preflight AND precommit recheck" mechanism to reuse.
- `src/web/v1/loop-provider-service.ts`: catalog+state pattern (`control_loop_provider_state` reservation via `INSERT … ON CONFLICT (tenant_id) DO NOTHING RETURNING`, replay by `last_idempotency_key/last_request_digest`), PUT upsert + POST `/remove`.
- `src/web/v1/loop-roster-service.ts`: roster rows carry `name, launcher, family, roles, efforts, default_effort` — the source for family/effort/launcher eligibility.
- `src/web/v1/improve-control-room-loop-adapter.ts:108`: `loopProviderRouteSchemaV1` (`{providerId, model}`), consumed at line ~706 from settings key `providerRoute`.
- `src/web/v1/private-node-handler.ts:80-87`: shared `requestHead` used by `createPrivateNodeHandler` (239) and `createMacLocalNodeHandler` (262) (also demo 254; setup 299 has `allowPost:false`). `editPut` alternatives: skills/recurring-rules, loop-providers item, loop-policy project|selection.
- `src/web/v1/private-request-budgets.ts`: `default: 8192`; PUT budgets only for recurring-rules/skills; loop routes use 8192.
- `private-app/app/loop-provider-panel.tsx`, `loop-roster-panel.tsx`, mounted in `private-app/app/improve-control-room-workspace.tsx:104-105`; fetch pattern `credentials:'same-origin', cache:'no-store', redirect:'error'`, `idempotency-key` header.
- Migrations: last on base `db/migrations/0309_control_loop_provider_prices.sql` (ledger order 177); down chain `db/down/0305…0309`; grants in `db/roles/private_web_roles.sql:322-334` (not ledgered, applied by `scripts/mac-local/narrow-role-provision.mjs`, `database-upgrade-grants.mjs`, `src/updater/v1/pg/apply-release-schema.mjs:421`) and six-role revokes in `db/roles/production_table_grants.sql:212-222`; ledger `deploy/postgres/migration-ledger.json`; desired grants `deploy/postgres/desired-grants.json`; pins `src/web/v1/private-database-preflight.ts:93` `privateWebSchemaDigest` and `src/updater/v1/policy/release-schema-digest.json`; preflight read/insert/delete/column sets in `private-database-preflight.ts` (~137-141, 197-204, 284-288, 850); catalog counts `tests/improve-control-room-desk-postgres.test.ts:402,630` (264) and `tests/improve-control-room-desk.test.ts:722` (255).

Missing on this base (verified: no `src/web/v1/loop-selection-*`, no `loop_selection`/`loop-selection` in src/db/private-app/tests):

- **U81 (`b8-selection-to-start`)**: selection wire/schema (plan/spec/build/final slots; plan/spec/code review arrays 0–3/0–3/1–3; slot `{model,route,effort}`), selection service/HTTP/browser client, preview/admission/acknowledgement, family-conflict evaluation, `loop_selection.read/manage` actions and the selection audit resource type.
- **U82 (`b8-saved-selections`)**: whole-layer save preserving non-B8 members at current expectedVersion, load/current-route revalidation, reset semantics.

D01a BUILD therefore depends on U81+U82 being integrated into the BUILD base. The names used below for their modules (`loop-selection-wire.ts`, `loop-selection-service.ts`, `loop-selection-http.ts`, `loop-selection-browser-client.ts`, `private-app/app/loop-selection-panel.tsx`, `tests/loop-selection*.test.ts`) are the U81 task's NEW-file prefix; the exact filenames, exported schema names and service class name must be re-inspected and substituted at BUILD start (renewed spec/base inspection, playbook BUILD step 1). Any mismatch that changes an interface below returns to the Sol spec gate.

## 2. Strict preset shape

### 2.1 Preset selection JSON (stored and on the wire)

```json
{
  "spec":         {"model":"<roster name>","route":"<launcher>","effort":"<roster effort>"},
  "spec_reviews": [ slot, … ],          // 0..3
  "build":        slot,
  "code_reviews": [ slot, … ],          // 1..3
  "final":        slot
}
```

- Exactly these five top-level keys, all required. No `plan`, `plan_reviews`, `overrides`, `limits`, `acknowledgements`, `paidConsent`, `cap`, `providerRoute`, `default`, or any other key → `invalid_request` (`preset_extra_key`).
- `slot` is exactly the U81 slot schema (`model`, `route`, `effort`, strict). Byte bounds (r2): roster `name`/`launcher` have no SQL length limit (0305), so the preset parser adds explicit UTF-8 byte bounds per field — `model` ≤ 128, `route` ≤ 64, `effort` ≤ 32 — or adopts tighter U81 bounds if U81 defines them; a roster entry longer than these bounds cannot be stored in a preset (refused 422 `slot_field_too_long`, readable). D01a imports U81's slot schema; it does not define its own. Counts are U81's (spec reviews 0–3, code reviews 1–3).
- Parsing path: `parseLoopSettingsV1(text, true)` (strict JSON, forbidden names, secret scan) then the U81 slot/count schema applied to the five keys with `.strict()`. Recursive check of every slot and count. The same function runs on every row read; the read also re-checks `name` (trimmed, 1–80 code points, no TAB/CR/LF) and `sha256(selection_text) = selection_sha256` (as `LoopPolicyServiceV1.#layers` does); a failing stored row raises `loop_selection_preset_integrity_failed` (500, no partial list), mirroring `loop_policy_integrity_failed`.
- Canonical stored text: `encode`-style sorted-key serialization plus `\n` (reuse the encoder exported from `loop-policy-compose.ts`; if not exported, BUILD exports it — that is the only allowed edit to that file, signature-preserving). Stored text ≤ 4096 bytes (D7); SQL CHECK identical.
- Mapping onto selection: preset `spec→spec`, `spec_reviews→spec review array`, `build→build`, `code_reviews→code review array`, `final→final`. U81's `plan` slot and plan-review array are never touched by Pick.
- Family rule (D9, r2): the final/builder family rule depends on the roster, so it is eligibility, not structure. Writes never consult the roster; a preset whose `final` and `build` resolve to the same roster `family` saves and is reported on read with `stale` code `final_shares_builder_family`. It can never be acknowledged; U81 preview refuses preparation. Ordinary reviewer family conflicts are NOT refused and NOT acknowledged in a preset; acknowledgements are per-run in U81.

### 2.2 Stale evaluation on read
For each preset, compute `stale: {code, explanation}[]` from current roster (model present, `route` equals roster `launcher`, `effort` ∈ `efforts`, role permitted by `roles`, roster `on`) and the final/builder family rule (`final_shares_builder_family`). Empty array = currently eligible. `stale` is never stored and never authorizes; it reuses U81's slot-eligibility function (no second checker).

### 2.3 Name
`name.trim()`; 1–80 Unicode code points after trim (`[...name].length`, matching SQL `char_length`); refuse `\t`, `\r`, `\n` anywhere (before trim); store trimmed. Uniqueness on `lower(name)` per tenant/project. No count cap.

## 3. Catalog and state

### 3.1 NEW migration `db/migrations/<NNNN>_control_loop_selection_presets.sql` (lead allocates NNNN in merge order)

```sql
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';
CREATE TABLE control_loop_selection_preset_state (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  last_idempotency_key text NOT NULL CHECK (last_idempotency_key ~ '^[A-Za-z0-9:_-]{16,100}$'),
  last_request_digest text NOT NULL CHECK (last_request_digest ~ '^sha256:[a-f0-9]{64}$'),
  last_result jsonb NOT NULL CHECK ((octet_length(last_result::text) <= 4096 AND jsonb_typeof(last_result)='object'
    AND last_result ?& ARRAY['operation','presetId','version']
    AND last_result - 'operation' - 'presetId' - 'version' = '{}'::jsonb
    AND last_result->>'operation' IN ('create','update','delete')
    AND jsonb_typeof(last_result->'presetId')='string' AND last_result->>'presetId' ~ '^preset:[a-f0-9]{32}$'
    AND jsonb_typeof(last_result->'version')='number'
    AND (last_result->>'version')::numeric BETWEEN 1 AND 9007199254740991
    AND (last_result->>'version')::numeric = trunc((last_result->>'version')::numeric)) IS TRUE),
  created_by text NOT NULL CHECK (created_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  created_at timestamptz NOT NULL,
  updated_by text NOT NULL CHECK (updated_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT
);
CREATE TABLE control_loop_selection_presets (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  preset_id text NOT NULL CHECK (preset_id ~ '^preset:[a-f0-9]{32}$'),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80 AND name = btrim(name) AND name !~ '[\t\r\n]'),
  selection_text text NOT NULL CHECK ((octet_length(selection_text) <= 4096 AND jsonb_typeof(selection_text::jsonb)='object'
    AND (selection_text::jsonb) ?& ARRAY['spec','spec_reviews','build','code_reviews','final']
    AND (selection_text::jsonb) - ARRAY['spec','spec_reviews','build','code_reviews','final'] = '{}'::jsonb
    AND jsonb_typeof(selection_text::jsonb->'spec')='object' AND jsonb_typeof(selection_text::jsonb->'build')='object'
    AND jsonb_typeof(selection_text::jsonb->'final')='object'
    AND jsonb_typeof(selection_text::jsonb->'spec_reviews')='array' AND jsonb_array_length(selection_text::jsonb->'spec_reviews') <= 3
    AND jsonb_typeof(selection_text::jsonb->'code_reviews')='array'
    AND jsonb_array_length(selection_text::jsonb->'code_reviews') BETWEEN 1 AND 3) IS TRUE),
  selection_sha256 text NOT NULL CHECK (selection_sha256 ~ '^[a-f0-9]{64}$'),
  created_by text NOT NULL CHECK (created_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  created_at timestamptz NOT NULL,
  updated_by text NOT NULL CHECK (updated_by ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id,project_id,preset_id),
  FOREIGN KEY (tenant_id,project_id) REFERENCES projects(tenant_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (tenant_id,project_id) REFERENCES control_loop_selection_preset_state(tenant_id,project_id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX control_loop_selection_presets_name_ci
  ON control_loop_selection_presets (tenant_id, project_id, lower(name));
```

The catalog table carries the composite project FK directly (target `projects(tenant_id,id)`, unique since 0007) and a second FK to the state row, so a preset can never exist without its project or its state row. Every CHECK is wrapped `(...) IS TRUE` (pattern of 0308 `secret_ref`) so a missing key yields false, not NULL. SQL closes top-level and role keys and counts; slot internals are closed by the service (recursive check). No default column (D01b).

### 3.2 NEW `db/down/<NNNN>_control_loop_selection_presets.sql`
`BEGIN; SET LOCAL lock_timeout/statement_timeout; LOCK TABLE control_loop_selection_presets, control_loop_selection_preset_state IN ACCESS EXCLUSIVE MODE;` raise `'loop selection presets retained'` ERRCODE `23514` if either has rows; else `DROP TABLE control_loop_selection_presets RESTRICT; DROP TABLE control_loop_selection_preset_state RESTRICT; COMMIT;` (pattern of `db/down/0308_control_loop_providers.sql`).

### 3.3 Result and version semantics
- Result exactly `{operation, presetId, version}`; `operation ∈ create|update|delete`; `presetId` non-null (the created/edited/removed ID); `version` = resulting catalog version ≥ 1. HTTP adds `replayed:boolean` only in the HTTP envelope (`{...result, replayed}`), status 201 new / 200 replay, as in policy/provider handlers.
- Catalog version increments by exactly 1 on every successful mutation.
- First mutation (expectedVersion = 0), inside the commit transaction:
  1. `INSERT INTO control_loop_selection_preset_state(… version=1, last_idempotency_key=$key, last_request_digest=$digest, last_result=$result, created_*, updated_* …) ON CONFLICT (tenant_id,project_id) DO NOTHING RETURNING version`.
  2. Row returned → this writer created state at version 1; insert the preset row (create only; update/remove at version 0 are `not_found`/`conflict` before any insert). Done.
  3. No row → `SELECT … FROM control_loop_selection_preset_state WHERE … FOR UPDATE` (the winner's committed row); run replay (same key+digest → return stored `last_result` as replay; same key, other digest → conflict); else `version ≠ expectedVersion(0)` → `conflict`. A loser never compares its 0 with a row it created.
- Existing state (expectedVersion ≥ 1): lock the one state row `FOR UPDATE` first, then replay check, then version check, then mutate presets, then `UPDATE state SET version=version+1, last_* , updated_* WHERE … AND version=$expected` (rowcount must be 1).
- `expectedVersion === Number.MAX_SAFE_INTEGER` → conflict (no overflow), as provider service.

## 4. HTTP, authority and idempotency

### 4.1 Authority
- Actions: `loop_selection.read` (GET) and `loop_selection.manage` (mutations), owner-only (`ownerOnly=true`), mutations at risk `"high"` like `loop_policy.manage`. These are U81's action names; D01a reuses them, it does not add new grants to the policy engine. If U81 lands different names, BUILD substitutes and records it.
- Audit resource type: a distinct `WebSessionAuthority` resourceType `"loop_selection_preset"` (not `loop_policy`, not U81's selection resource) so audit rows separate preset CRUD.
- Every mutation runs `actor.require(...)` inside `authenticated`, which re-checks in precommit (session revoked/expired between preflight and commit → `authentication_required`, nothing written).
- Project scope: reuse the `#scope` semantics of `LoopPolicyServiceV1` (template `control-room`, lifecycle `active`, else `not_found`/`conflict`), but with project row `FOR SHARE` (D3). Every SQL statement filters `tenant_id` AND `project_id`.

### 4.2 Routes (extensions of the U81 selection HTTP handler)
| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/api/v1/projects/:projectId/loop-selection/presets` | none | `{version, presets:[{presetId,name,selection,stale,createdAt,updatedAt}]}`; before first write `{version:0,presets:[]}`; sorted by `lower(name)`, then `presetId` |
| POST | `/api/v1/projects/:projectId/loop-selection/presets` | exactly `{expectedVersion,name,selection}` | create |
| PUT | `/api/v1/projects/:projectId/loop-selection/presets/:presetId` | `{expectedVersion}` plus `name` and/or `selection`; neither → `invalid_request` | update |
| POST | `/api/v1/projects/:projectId/loop-selection/presets/:presetId/remove` | exactly `{expectedVersion}` | delete |

`selection` on the wire is a JSON object (not a string) validated as §2.1; server generates ID, actor and timestamps; clients cannot supply them. Query strings refused. `content-type: application/json` required on mutations; body required. Error mapping through `webFailure`: invalid → 400, not_found → 404, conflict → 409 (`name_taken` reason for the unique-index case), structural refusal → 422 `selection_refused` with reasons, body too large → 413.

### 4.3 Idempotency
- `Idempotency-Key` header required on all three mutations (syntax `^[A-Za-z0-9:_-]{16,100}$`).
- Digest `sha256Digest({operation, projectId, presetId|null, body})`.
- Same key as state's `last_idempotency_key` and same digest → return stored `last_result` with `replayed:true` — including after the target preset was deleted (state row holds it).
- Same latest key, different digest → 409. A key older than the latest is not remembered: its retry is evaluated as a new request and refused by the version check (409) — "older version conflicts".
- Unique-name violation (23505 on `control_loop_selection_presets_name_ci`) → 409 `name_taken`; 40P01/40001 → 409 via `rethrowLoopPolicyErrorV1`.

## 5. Transport (shared file; lead names the writer)

`src/web/v1/private-node-handler.ts` `requestHead` `editPut`: add exactly one alternative

```ts
|| /^\/api\/v1\/projects\/[^/?]+\/loop-selection\/presets\/preset:[a-f0-9]{32}$/.test(target)
```

Because `requestHead` is shared, this applies to `createPrivateNodeHandler` and `createMacLocalNodeHandler` (and demo); setup keeps `allowPost:false` so PUT stays 405 there. Note the route segment contains `:`; BUILD verifies the browser sends it unencoded (`encodeURIComponent` encodes `:` as `%3A`) — the client must build the path from the server-returned ID without `encodeURIComponent` after validating it against `^preset:[a-f0-9]{32}$`, OR the regex accepts `preset(?::|%3A)[a-f0-9]{32}` and the inner handler decodes. Choice: client validates and sends literal `:`; regex accepts only literal `:` (narrowest). Existing provider/policy/skills/recurring alternatives unchanged. POST create/remove need no transport change. No DELETE, no generic PUT, no change to `allowPost`/method/CSRF/body checks, and no new `privateRequestBudgets` entry (D7): envelope ≤ 8192 bytes outer; inner handler uses `privateRequestBudgets.default`.

Size check (worked from the §2.1 bounds): worst slot `{"effort":"<32>","model":"<128>","route":"<64>"}` = 224 value bytes + 33 syntax bytes = 257 bytes; 9 slots (spec, build, final, 3+3 reviews) = 2313 bytes + 5 keys/brackets ≈ 2400 bytes canonical, under the 4096 stored cap. Wire envelope: selection ≤ 2400 (`"`/`\` in values may double, worst ≈ 4800) + name ≤ 320 UTF-8 bytes (×2 escaping worst 640) + `expectedVersion` and keys < 100 → ≤ 5540 bytes, under 8192. Boundary tests: stored text exactly 4096 accepted / 4097 refused (direct parser test); request body exactly 8192 accepted by transport / 8193 → 413.

## 6. Browser UI

- NEW `private-app/app/loop-presets-panel.tsx`, mounted inside the U81 selection panel area in `private-app/app/improve-control-room-workspace.tsx` (shared file; U81 owns its mount; D01a adds one child mount in U81's selection section).
- Uses the U81 selection browser client module extended with `listPresets/createPreset/updatePreset/removePreset` (same fetch options as provider panel: `credentials:'same-origin'`, `cache:'no-store'`, `redirect:'error'`, `idempotency-key: preset:<uuid>`; key generated once per user action and reused on retry of that action).
- Flows: list (name, stale badge with readable reasons), Save current draft as preset (name field), Rename/Edit (PUT), Remove (confirm, POST remove), **Pick** → copies the five roles into the U81 editable draft form only; it never calls the selection-layer save, never changes a default, never sets acknowledgements/overrides/consent. Draft plan slots untouched.
- Conflicts: 409 → reload catalog, show "changed elsewhere", keep the user's typed input; `name_taken` shows inline under the name field with focus moved there. Stale → badge + disabled-reason text on Start path (Start disablement is U81's preview).
- Late responses: each request carries a monotonically increasing sequence; responses older than the latest applied catalog version or sequence are discarded (no overwrite of newer state).
- Accessibility/layout: 44 px minimum targets, focus returns to the triggering control or to the error, no horizontal overflow at 390×844 and 1280×850, error text readable, retry button reuses the same idempotency key.

## 7. Database integration (one integration commit, lead-coordinated writer)

Files the lead's single DB writer edits in ONE commit (none edited in PLAN):
1. NEW `db/migrations/<NNNN>_control_loop_selection_presets.sql` and `db/down/<NNNN>_control_loop_selection_presets.sql` (NNNN allocated by lead in actual merge order; no reservation here).
2. `db/roles/private_web_roles.sql`: `GRANT SELECT, INSERT ON control_loop_selection_preset_state, control_loop_selection_presets TO control_room_private_web; GRANT UPDATE (version,last_idempotency_key,last_request_digest,last_result,updated_by,updated_at) ON control_loop_selection_preset_state TO control_room_private_web; GRANT UPDATE (name,selection_text,selection_sha256,updated_by,updated_at) ON control_loop_selection_presets TO control_room_private_web; GRANT DELETE ON control_loop_selection_presets TO control_room_private_web;` No DELETE/TRUNCATE on state; no TRUNCATE anywhere.
3. `db/roles/production_table_grants.sql`: `REVOKE ALL ON control_loop_selection_presets, control_loop_selection_preset_state FROM control_room_application, control_room_reader, control_room_schedule_admissions, control_room_github_broker, control_room_work_intake, control_room_backup;`
4. `deploy/postgres/migration-ledger.json` regenerated by `node scripts/generate-migration-ledger.mjs`, verified by `node scripts/verify-migration-ledger.mjs`.
5. `deploy/postgres/desired-grants.json` entries for the grants above.
6. Pins: `src/web/v1/private-database-preflight.ts` `privateWebSchemaDigest` and `src/updater/v1/policy/release-schema-digest.json` — re-measured on native PostgreSQL 17 after applying the full chain (never copied, never lowered).
7. `private-database-preflight.ts` read/insert/update-column/delete sets: add both tables (delete set: presets only).
8. Catalog counts: `tests/improve-control-room-desk-postgres.test.ts` (currently 264 at lines 402/630) and `tests/improve-control-room-desk.test.ts:722` (currently 255) — new values MEASURED on the landed base after U81/U82/sibling migrations, expected +2 relative to the measured pre-D01a baseline.
9. Any fixture that lists all public tables (BUILD greps for `control_loop_provider_prices` in tests/fixtures and updates each in the same commit).

Down chain: existing P71-consumer tests that "remove 0308/0309 before rebuilding the pre-P71 baseline" (commits 230e141/412d0c1) must also apply the new down first; BUILD updates those tests in the integration commit.

## 8. Service algorithm (per mutation)

1. Validate path params, key syntax, body (zod strict + §2.1 parser + §2.3 name). Invalid → 400, before any transaction.
2. Preflight transaction (`authenticated`, read-only): require `loop_selection.manage` owner/high; scope; read state (no lock) and catalog; replay check; version check; existence check for update/remove; name pre-check. No roster read on writes. Return replay or proceed.
3. Commit transaction (`authenticated`): require again; scope (project `FOR SHARE`); §3.3 state reservation/lock; replay; version; existence; name pre-check; write preset (INSERT/UPDATE/DELETE); update state with new version and `last_result`; precommit recheck of authority. Any error → whole transaction rolls back (catalog and state together).

## 9. REQUIRED future BUILD checks

All new test files are NEW until registered. Register `tests/loop-selection-presets.test.ts` in `test:improve-control-room` (package.json explicit list), and `tests/loop-selection-presets-postgres.test.ts` in `test:improve-control-room-postgres`; browser spec `tests/browser/loop-selection-presets.spec.ts` as NEW script `test:improve-control-room-loop-presets-browser`. Run `npm run check:test-loaders` and `npm run test:test-loaders` after registration. Exact test names below are the deciding identifiers.

Unit/handler (in-memory DB as existing loop tests use; `tests/loop-selection-presets.test.ts`):
- T1 two presets exercising all five roles, efforts, 0/3 spec reviews and 1/3 code reviews; plan slots of the draft unchanged after Pick.
- T2 Pick returns draft only; selection layer version unchanged (`GET loop-policy` version equal before/after).
- T3 refusal table — each of `overrides`, `limits`, `acknowledgements`, `paidConsent`, `cap`, `providerRoute`, `plan`, unknown key, extra slot key, 4 spec reviews, 0 or 4 code reviews, secret-looking value, `__proto__` — 400/422 and catalog version unchanged; plus a poisoned stored row (direct SQL) makes GET fail closed.
- T4 names: `" a "` stores `"a"`; `""`, 81 chars, TAB/CR/LF refused; `"Alpha"` then `"alpha"` → 409 `name_taken`.
- T5 GET before first write → `{version:0,presets:[]}`; no default field anywhere in the response.
- T6 roster model removed → preset still listed with non-empty `stale`; create of a preset naming an unknown model succeeds with stale; final/builder same family saves with `stale` containing `final_shares_builder_family`, and U81 preview of the picked draft refuses it.
- T7 results exactly `{operation,presetId,version}` keys (plus envelope `replayed`), versions 1,2,3 for create→update→remove.
- T8 non-owner, other project, expired session, revoked-between-preflight-and-commit → 403/401/404 and zero rows written.
- T9 same key+body after delete replays 200 with stored result; same key other body 409; old version 409; missing key 400; empty PUT edit 400.
- N1 Node: real handler create→PUT rename/edit→POST remove→replay through BOTH `createPrivateNodeHandler` and `createMacLocalNodeHandler` (pattern `tests/private-node-handler.test.ts:13` "P71 ${mode} Node PUT…"), no listener.
- N2 Node refusals: PUT to `/presets`, `/presets/preset:UPPER…`, `/presets/<id>/extra`, `?x=1` → 405; DELETE → 405 from transport in `createPrivateNodeHandler` (production `allowDelete:false`) and, in `createMacLocalNodeHandler` (`allowDelete:true`), refused by the inner handler (404/405) — zero writes in both; setup transport PUT → 405; 8200-byte body → 413.
- N3 existing provider/policy/skills/recurring PUT tests still pass (unchanged files).

PostgreSQL 17 (`tests/loop-selection-presets-postgres.test.ts`, production login `control_room_private_web`):
- P1 fresh schema: zero preset/state rows.
- P2 SQL CHECKs reject direct inserts with extra top key, `plan` key, 4 code reviews, bad result shape, version 0.
- P3 poisoned rows inserted by migrator (slot extra key, bad effort type, hash mismatch) → service GET fails closed.
- P4 expression index rejects case-variant duplicate via direct SQL.
- P5 web role: DELETE on state, TRUNCATE on either → permission denied; other six roles → no access.
- P6 replay after delete survives pool close and reopen.
- P7 fresh up; upgrade from measured prior head; down on empty → tables gone; down with retained rows → 23514, tables intact.
- P8 ledger verify; schema digest equals both pins; desired-grants check.
- P9 catalog count = measured baseline + 2.
- P10 restart: create, close pool, new process/pool, GET returns same rows/version.
- P11 (r2) `WebSessionAuthority.authenticated` locks the identity row `FOR UPDATE` on writes, so writers sharing one identity serialize before the state INSERT. P11 therefore spreads writers over at least 4 distinct owner identities (each with its own session) and uses a barrier after preflight so commit transactions reach the state INSERT concurrently. 20 distinct-key barrier writers at version 0 → exactly one 201, nineteen 409, one state row version 1, one preset; repeat at existing version N → one winner, version N+1; same-key pair → one 201 + one 200 replay; same key altered body → 409.
- P12 injected failure after preset write and before state update (test hook in DB client wrapper, not production code) → neither table changed.

Commands (BUILD must record output/exit/counts):
```
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-presets.test.ts tests/private-node-handler.test.ts tests/loop-policy.test.ts tests/loop-providers.test.ts tests/loop-roster.test.ts <U81/U82 selection test files>
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 PG_BIN=<pg17 bin> node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-presets-postgres.test.ts
npm run test:improve-control-room
PG_BIN=<pg17 bin> npm run test:improve-control-room-postgres
PG_BIN=<pg17 bin> npm run test:postgres-production
PG_BIN=<pg17 bin> npm run test:private-postgres-production-boundary
npm run check
npm run check:demo
npm run build
npm run check:migrations
npm run check:test-loaders && npm run test:test-loaders && npm run check:test-quarantine
npm run test:improve-control-room-loop-presets-browser     # NEW
npm run test:improve-control-room-loop-providers-browser   # neighbour regression
npm run test:loop-policy:real                               # qualified-tools exact-name lane: ≥1 deciding pass, 0 skipped
```
`test:improve-control-room` skips `^P71 real settings check$`; that skip is never counted as tools evidence — `test:loop-policy:real` must show ≥1 pass and 0 skipped/quarantined, or the tools gate is reported NOT RUN (native).

Failing-first (red on old behavior, through existing entry points, never missing-module red): write T7/T9/N1 so they call the U81 HTTP handler and Node factories that already exist at BUILD base; before implementation they must fail with 404 (route absent) / 405 (transport), not with import errors.

Guard-off probes (isolated throwaway copy only, restore and re-pass): (G1) remove only the new `editPut` alternative → N1 PUT step fails with 405, restore → pass; (G2) remove BOTH version guards (explicit check and `WHERE version=$expected` rowcount) → P11 at existing version shows >1 winner / version skipped; (G2b) replace `ON CONFLICT DO NOTHING` with plain INSERT → P11 at version 0 shows 23505/500 losers instead of 409; (G3) drop owner-only flag → T8 non-owner write succeeds; (G4) drop replay lookup → T9 retried remove returns 409 (version check), not the 200 replay; (G5) drop the strict extra-key refusal → T3 providerRoute case saves.

Mutation lane: add the preset service to the existing mutation-check mechanism only if the lead assigns it (shared `mutation-checks/` registration); otherwise G1–G5 are the required probes.

Browser (`tests/browser/loop-selection-presets.spec.ts`, NEW; at 390×844 with `hasTouch` and at 1280×850):
- B1 create two presets, reload page, both listed; rename; edit; remove; reload shows final state.
- B2 stale preset shows readable reason; Pick copies roles into the draft; the Start/preview control shows U81's disabled-action explanation; plan slots unchanged.
- B3 name conflict → inline error, focus on name field; 409 version conflict → catalog reloads and typed input kept; network failure → retry reuses the same idempotency key (server sees one create).
- B4 late response: delay the first GET, complete a create, then release the stale GET → UI keeps the newer catalog; every actionable target ≥ 44×44 px; `document.documentElement.scrollWidth <= innerWidth` at both viewports.

Reviews: attack AND CI review (authority + data + migration), pinned Node 22 Linux CI parity on the lead's integration candidate, browser evidence at 390×844 touch and 1280×850 (viewport evidence is not device evidence).

Gate: NAMED-PRESETS-GREEN requires P1–P12 on real PostgreSQL 17 plus T/N/B and G1–G5. No model launch required for CRUD.

## 10. Dependency order and BUILD seams

1. U81 integrated → 2. U82 integrated → 3. D01a seam A (service+wire+HTTP extension, unit tests T1–T9) → seam B (transport alternative, N1–N3, G1) → seam C (DB integration commit by lead's writer, P1–P12) → seam D (panel + browser B1–B4). Each seam is a lead-authorized continuation point if splitting is needed. U83a (provider chooser) and U83b (paid cap) are independent; D01b follows D01a.

Shared writers (lead names one each): `loop-policy-compose.ts` (D10 export only); `private-node-handler.ts` editPut; `private_web_roles.sql`/`production_table_grants.sql`/ledger/desired-grants/both pins/preflight/catalog counts; `package.json` script lists; `improve-control-room-workspace.tsx` mount.

## 11. Handoff contract to D01b

Stable for D01b: table names and keys, `presetId` format `preset:[a-f0-9]{32}`, catalog `version` semantics (one counter per tenant/project in `control_loop_selection_preset_state`), result `{operation,presetId,version}` with `operation ∈ create|update|delete`. D01b may widen the result enum and add a nullable default-pointer column to the state table in its own migration with its own down; D01a does not preimplement, reserve or reference that column. Deleting a preset that D01b later points to is D01b's concern (it must add its own FK/check).

## 12. Cloud scope vs withheld qualification

Buildable on cloud after U81/U82 integration: all T/N/B tests, typecheck/build, browser viewports, guard-off probes, and P1–P12 IF PostgreSQL 17 is available on that machine. On this PLAN machine PostgreSQL 17 could not be obtained (network policy denied apt.postgresql.org and ftp.postgresql.org; only 16.15 present); any later cloud BUILD without PG17 must label P1–P12 **PG17-later** and cannot claim NAMED-PRESETS-GREEN. Withheld/native: qualified tools (`test:loop-policy:real`), real-device evidence, R62/P72 admission release evidence, Linux CI parity on the integration candidate.
