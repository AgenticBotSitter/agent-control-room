# b8-saved-selections (U82) — PLAN specification

Phase: PLAN (specification only; no implementation is authorized by this document).
Delivery base: `cloud-base/b8-saved-selections` at `337cca3d24d589195f3e49f1db0b6bcbd3a7fc8c`, one task/playbook commit above source `cook/b7-providers` at `412d0c149fe8e272c491900d7a9164f80ecb612a` (verified on origin; ancestry check exit 0, one commit apart, diff touches only the task file and the playbook).
Result branch: `cloud/b8-saved-selections`.

## Revision history

| Rev | Date (UTC) | Change |
|---|---|---|
| 1 | 2026-11-04 | First PLAN draft for Sol spec review. |

## 0. Goal, musts and exclusions

Goal: saved and last B8 selections that reload durably and are re-checked against current policy, roster, effort and route availability. Every run must get fresh override and acknowledgement authority. History must stay immutable. The three P71 loop limits must be traceable from policy to the worker's actual outcomes. All of this extends U81's selection modules. There is no second store.

| # | Owner must | Behaviour | Proof (section 8) |
|---|---|---|---|
| M1 | Save through the existing P71 selection PUT | Whole-layer replacement that changes only the B8 members and preserves the other members | T1, T2, T3, PG1, PG2 |
| M2 | Last means the latest durably accepted Start | A verified read of the signed input bound to that Start | T5, T6, PG3, PG4 |
| M3 | Loads use current reality | Stale slots are explained, left unapplied and block preparation | T7, T8, B1 |
| M4 | Fresh run authority | Override controls reset to explicit false; no inherited consent or acknowledgement | T9, T10 |
| M5 | Immutable history | Saves, loads and refreshes never rewrite signed inputs or copies | T11, PG5 |
| M6 | Three real limits | Traced through text, argv, Confirm and PG lineage; enforced by actual worker outcomes | T12, Q1 to Q3 |
| M7 | Independent tests, races and mutations | Real pool and process restarts, a 20-caller barrier, replay, mutation probes | PG1 to PG6, MU1 to MU5 |

Approved exclusions:
- No preset catalog (D01a) and no default pointer (D01b).
- No provider chooser or offers (U83a).
- No paid execution, caps or consent storage (U83b).
- No new migration.
- No new policy store, composer, checker wrapper, signature verifier or identity source.

## 1. Existing code facts (inspected at the delivery base)

### P71 composition: `src/web/v1/loop-policy-compose.ts`
- `parseLoopSettingsV1(text, layer)` (line 12) is a strict JSON parse with these rules:
  - at most 64 KiB;
  - non-finite numbers, `__proto__`, `prototype` and `constructor` are refused;
  - secret material is refused through `assertNoSecretMaterial`;
  - `layer=true` refuses a top-level `overrides` member (line 15).
- `composeLoopSettingsV1({defaultsText, project?, selection?, runEdits?})` (line 41) deep-merges in this order: defaults < project < selection < runEdits. It produces canonical sorted text plus a newline, or the exact defaults bytes when nothing is layered. It returns `{text, sha256}`.

### P71 service and HTTP
`src/web/v1/loop-policy-service.ts`, class `LoopPolicyServiceV1`:
- `snapshot(tx, projectId, runEdits?)` (line 117), `assertSnapshot` (line 120) and `check` (line 124):
  - `check` throws `loop_policy_check_unavailable` when no checker exists;
  - `check` throws `LoopPolicyRefusedV1(reasons)` when the result is not eligible.
- `view(identity, projectId)` (line 129) needs `loop_policy.read`. It returns `{project, selection}`, each as `{version, settingsText}`.
- `put(identity, projectId, layer, {expectedVersion, settings}, key)` (line 138) needs `loop_policy.manage` at risk high. It:
  - takes the project row lock;
  - checks the expectedVersion;
  - supports replay through `last_idempotency_key` plus `last_request_digest`; a changed body is a conflict;
  - runs a two-transaction check with `assertSnapshot` recheck;
  - appends to `control_loop_policy_events`.
- `recordInputSources` (line 184) and `copyInputSources` (line 190) write `control_loop_policy_input_sources`, an append-only table.

HTTP (`src/web/v1/loop-policy-http.ts`): `GET /api/v1/projects/:p/loop-policy`, and `PUT .../loop-policy/(project|selection)` with an `idempotency-key` header. A refusal is HTTP 422 `policy_refused` with its reasons.

### Storage: `db/migrations/0306_control_loop_policy.sql`
- `control_loop_policy_layers` has primary key `(tenant_id, project_id, layer)`.
  - `layer` is `project` or `selection`.
  - Columns: `version`, `settings_text`, `settings_sha256`, `updated_by`, `updated_at`, `last_idempotency_key`, `last_request_digest`.
- `control_loop_policy_events` is append-only.
- `control_loop_policy_input_sources` has primary key `(tenant_id, request_id, input_version)`. It stores `defaults_sha256` and `layer_versions {project, selection}`, and `waiver_id IS NULL` is enforced.

### Intake applies the policy; Start does not recompose
`src/web/v1/improve-control-room-loop-service.ts`:
- Intake preflight calls `#policy.snapshot(tx, p, body.settingsEdits)` and then `check` (around lines 537-539).
- Admission re-snapshots, runs `assertSnapshot`, then `saveLoopDraft`, which stores the composed text as the signed input `settings_text`. Then `recordInputSources` (lines 577-583).
- Confirm normalisation creates a new input version through `copyInputSources` (line 609).
- Start (`start` body `{expectedVersion, expectedRevision, runLinkId}`, `src/improve-control-room/v1/schemas.ts:182`) uses the already-signed `local.input.settings_text` (line 660). It records the binding with:
  - `localVersion = local.input.version`;
  - `requestSha256` and `settingsSha256` from that input (lines 643-647).
- The claim gets `command_id = loop-command:<32 hex>` and `created_at = actor.now` (line 657).
- The result row is appended by `#complete` or by recovery, with its own `created_at`.
- An uncertain receipt (`LAUNCH_UNCERTAIN`) means a claim exists with no result.

### Immutable per-command copies: `src/web/v1/improve-control-room-loop-adapter.ts`
- `commandFile` (lines 458-475) writes `<workRoot>/loop-command-<hex>/settings.json` with `wx` and mode 0600. On EEXIST the bytes must be identical.
- `invoke` (line 483) requires `loopByteHashV1(text) === binding.settingsSha256`.
- Start's argv is `start <run> --settings <file> --availability <file> --json --expect <file>` (lines 499-505).
- The installed defaults are `settingsText`, read from a pinned `settingsFile` (line 329).
- The checker spawns `cr.py check lineup --settings --availability --json` (lines 651-699). It exits 0 or 3 and returns `{eligible, reasons}`.

### Signed readers: `src/improve-control-room/v1/service.ts`
- `#loopRoot(tx, projectId, requestId, ownerId?)` (line 432) and `#loopInput(tx, root, version?)` (line 441) are private. `#loopInput` reads either an exact version or the latest one, then runs `#verifyLoop("inputs")`, which checks:
  - the record digest;
  - the HMAC;
  - `sha256(description) = request_sha256`;
  - `sha256(settings_text) = settings_sha256`.
- `loopBridgeTransaction(identity, projectId, mutation, fn)` (line 663) runs reads under `#loopReadAuthority` with `projects.read`.
- `loopBridgeLineage` (line 682) is always the latest version.
- The journal verifier `#verify` (loop-service lines 67-77) and `#verifyResult` (lines 92-98) are private to the loop service.

### Journal: `db/migrations/0302_control_loop_improvement_commands.sql`
- Table `control_loop_improvement_commands`, append-only, with `entry_kind` claim or result.
- `result.state` is one of `accepted`, `waiting`, `refused`.
- A unique index allows one Start claim per request.
- There is no index on project or owner. The requests table has the index `(tenant_id, project_id, created_at DESC, id DESC)` (0301 line 104).

### Roster and providers
- `LoopRosterServiceV1` (`src/web/v1/loop-roster-service.ts`) has rows with `name`, `launcher`, `provider`, `family`, `roles`, `efforts`, `default_effort` and `on`. These rows are the source for whether a model is off and whether an effort still exists.
- The provider route is `loopProviderRouteSchemaV1 {providerId, model}` (adapter line 108). The adapter hook `providerRoutes.resolveStartRoute(text)` (lines 701-727) has `paidExecutionReady: false`.
- `LoopProviderServiceV1` owns providers and the `ProviderSecretPresenceV1.availability` check.

### The three limits
- `max_questions_per_step`, `max_sendbacks` and `max_escalations` appear nowhere in `src/`, `tests/`, `db/` or `config/`.
- The defaults file is installation-owned. The runner (`tools/loop/bridge/cr-entry.py`, `cr.py`) is external and not in this public repository.
- The product only surfaces `QUESTION_LIMIT` as a blocked or finalization code (`improve-control-room-loop-attention-wire.ts:10,82`).
- Counter persistence exists only in a synthetic test ledger (`tests/improve-control-room-loop-recovery.test.ts:345`).

### U81 is not released
- `cloud/b8-selection-to-start` contains only its task file (commit `fa673cc8f81c`). No `src/web/v1/loop-selection-*` file exists on this base.
- Every U81 interface named below is a **U81 prerequisite (unreleased)**, not a fact.

## 2. One chosen mechanism

There is no new table and no new store. The selection layer row stays the single store for saved B8 choices. "Last" is derived, read-only, from the signed input that the latest accepted Start bound. The limits live where P71 already puts every setting:
- the installed defaults and the project layer;
- the per-run copy, which is the composed signed `settings_text`.

U82 adds pure functions and two narrow readers on top of U81's selection service. Data flow:

```
GET loop-policy (P71 view) ──► U81 strict B8 projection ──► U82 revalidate(current policy, roster, effort, route hook)
lastSelection ──► loopBridgeSavedInput (signed input @ binding.localVersion) ──► same projection ──► same revalidate
save: U81 form B8 edit ──► U82 mergeSelectionLayer(current layer text) ──► P71 PUT selection (expectedVersion, key)
new run: U81 preparation ──► U82 freshRunEdits (overrides reset to explicit false) ──► intake settingsEdits ──► P71 compose/check
```

## 3. Interfaces (all NEW unless marked existing)

### 3.1 `src/web/v1/loop-selection-saved.ts`
NEW. A sequential extension of U81's `loop-selection-*` family. It has no I/O except through the injected readers.

- `projectLoopSelectionV1(settingsText): LoopSelectionV1`
  - Consumes the strict projection owned by **U81**: the same member names and the same 0-3/0-3/1-3 count rules.
  - Refuses extra keys, override, acknowledgement, paid, cap and limit members, and secrets.
  - Poisoned or non-strict JSON throws `invalid_request`. It is never partially applied.
- `mergeSelectionLayerV1(currentLayerText, b8Edit): string`
  - Parses the current layer with `parseLoopSettingsV1(text, true)`.
  - Replaces only the U81-defined B8 members.
  - Copies every other top-level member byte-for-value unchanged, including `providerRoute`.
  - Refuses when any preserved member fails its owner's validator. `providerRoute` uses `loopProviderRouteSchemaV1`. It does not drop the member.
  - Returns the canonical text that is passed to PUT.
- `revalidateLoopSelectionV1(selection, current): LoopSelectionLoadV1`
  - `current = {policySnapshotText, roster rows, effort table, routeCheck?}`.
  - Returns `{applied: Slot[], stale: {slot, code, explanation}[], preparable: boolean}`.
  - Stale codes:
    - `model_off`: the roster row is off;
    - `model_missing`;
    - `effort_removed`: the effort is not in the row's `efforts`;
    - `route_unavailable`: the U83a hook says unavailable;
    - `route_unchecked`: no hook was released or the hook threw;
    - `checker_unavailable`.
  - A stale slot is never substituted. `preparable` is false while any stale slot remains.
- `freshRunOverrideEditsV1(): string`
  - Returns the run-edits fragment that sets both override controls, which U81 names (review-family override and standard-final override), to explicit `false`.
  - It contains no acknowledgement, consent or cap. See section 6.
- `readLoopLimitsV1(settingsText): {maxQuestionsPerStep, maxSendbacks, maxEscalations, afterLimit}`
  - A read-only projection used for Confirm display and lineage assertions.
  - The member paths must match the qualified tools' settings schema. This is a **technical prerequisite P-L**: the paths are not in the public repository.
  - Missing or ill-typed values give `limits_unavailable`. The Confirm step then shows unavailable and blocks. It never assumes a default.

### 3.2 Bridge readers
These are existing classes with NEW methods.

**`ImproveControlRoomDeskServiceV1.loopBridgeSavedInput(tx, projectId, requestId, ownerId, version)`**
- Lives in `src/improve-control-room/v1/service.ts` as a narrow public wrapper.
- Returns `await this.#loopInput(await this.#loopRoot(tx, projectId, requestId, ownerId), version)`, i.e. the verified exact-version input row.
- Adds no new verification code: it reuses `#loopRoot` and `#verifyLoop`.
- It is transaction-local and must be called inside `loopBridgeTransaction`.

**`ImproveControlRoomLoopServiceV1.lastSelection(identity, projectId)`**
- Lives in `src/web/v1/improve-control-room-loop-service.ts`.
- Steps:
  1. Validate the project id.
  2. Open `loopBridgeTransaction(identity, projectId, false, …)`. This means `projects.read`, a read-only authority and the self-project check.
  3. Additionally require `loop_policy.read` on the project, the same action as P71 `view`. The B8 projection discloses selection choices.
  4. Query the candidates:
     ```sql
     SELECT r.* FROM control_loop_improvement_commands r
     JOIN control_loop_improvement_commands c
       ON c.tenant_id=r.tenant_id AND c.command_id=r.command_id AND c.entry_kind='claim'
     WHERE r.tenant_id=$1 AND r.project_id=$2 AND r.owner_identity_id=$3
       AND r.operation='start' AND r.entry_kind='result'
       AND r.result->>'state'='accepted'
     ORDER BY r.created_at DESC, r.command_id DESC
     LIMIT 8
     ```
  5. Walk the rows in that order. For each, run the existing `#verify` on claim and result plus `#verifyResult(result, claim)`, and require all of the following:
     - `claim.binding` equals `result.binding`;
     - `loopBridgeSavedInput(..., claim.binding.localVersion)` succeeds;
     - `input.request_sha256 = binding.requestSha256`;
     - `input.settings_sha256 = binding.settingsSha256`.
  6. Return `{source: "last", commandId, acceptedAt, selection: projectLoopSelectionV1(input.settings_text)}` for the first row that verifies.
- A verification failure throws `loop_improvement_integrity_failed`. It fails closed and does not skip to an older row, because skipping would let tampering select an older choice.
- Only `state='accepted'` counts:
  - `waiting` (dispatched), `refused`, a claim without a result (uncertain) and the engine's running label are all excluded;
  - an uncertain Start becomes last only after exact receipt reconciliation (`#complete` or `#reconcileRecovery`) appends an accepted result.
- It never writes: there is no selection-layer write, no journal write, and no session write beyond the existing suppressed bootstrap.
- `LIMIT 8` bounds the read only. Since the first verified row wins and a failure throws, a limit of 1 would behave the same. 8 is kept for diagnostics of duplicate timestamps.
- No new index. Decision D4 records the measured-cost follow-up.

### 3.3 HTTP and client
Both are NEW routes inside U81's selection HTTP module (`src/web/v1/loop-selection-http.ts`, U81-owned, extended):
- `GET /api/v1/projects/:p/loop-selection/last` returns `{source, commandId, acceptedAt, selection}`, or 404 `none`.
- `GET /api/v1/projects/:p/loop-selection/saved` returns the P71 selection layer version plus `projectLoopSelectionV1` plus the revalidation.

Rules for both:
- GET only; no query string; same-origin or local-owner verification exactly as in `loop-policy-http.ts`.
- `privateResponseHeaders`. No generic PUT or DELETE allowance is added.

Saving reuses the existing `PUT .../loop-policy/selection`. The U81 client sends:
- `mergeSelectionLayerV1(viewed.selection.settingsText, edit)`;
- `expectedVersion: viewed.selection.version`;
- a fresh idempotency key per save intent, reused on retry.

The U81 selection panel and client (`private-app/app/...` file named by U81) get:
- "Load saved" and "Load last" actions;
- stale-slot reasons;
- a disabled "Prepare" with its reason.

## 4. Spec items to behaviour

### Item 1: inspect and extend one path
- Section 1 lists the inventory. Released: P71 compose, service and HTTP; the signed readers; the journal; the roster; the provider route schema and hook. Unreleased: U81, U83a hook consumer semantics, U83b, and the qualified tools.
- Forbidden duplicates: a second selection table, a limits reader that stores anything, a composer, a signature verifier, a per-owner layer.
- `readLoopLimitsV1` is a pure projection and not a store.

### Item 2: versioned project save
- Only through the P71 PUT, with its expectedVersion, idempotency and `loop_policy.manage` high.
- The whole layer is replaced through `mergeSelectionLayerV1` from the *currently viewed* layer, so non-B8 members such as `providerRoute` survive.
- A stale expectedVersion gets P71 `conflict` (409). The client re-views, re-merges and asks the owner. There is no silent retry with a new version.
- Strict B8 projection: the source and the stored JSON are both validated, on read through `#layers`/`parseLoopSettingsV1` and on projection.
- The project layer supplies limits. They are never written by a selection save: `mergeSelectionLayerV1` refuses limit members in the B8 edit.

### Item 3: last means accepted Start
Covered by section 3.2.

### Item 4: load against current reality
- Saved and last loads, and later presets through D01a, all go through `revalidateLoopSelectionV1` with current policy (`LoopPolicyServiceV1.view` plus compose), roster rows, efforts and the route hook.
- Stale slots are reported and left unapplied; Prepare is disabled.
- Poisoned JSON throws. A missing checker is `checker_unavailable`, never eligible.
- U83a handoff: U82 calls only the released U83a validation hook. That is the existing `providerRoutes.resolveStartRoute` contract or U83a's successor. Without it the result is `route_unchecked`, which blocks preparation of routed slots. U82 does not read provider tables.

### Item 5: fresh authority and immutable history
- Every new preparation merges `freshRunOverrideEditsV1()` into intake `settingsEdits`. runEdits has the highest precedence, so explicit false beats an installed default of true.
- If the checker refuses that composed text, for example because policy forbids the reset, Prepare is refused with the checker's reasons. U82 never retries without the reset.
- No acknowledgement, consent or cap is read from saved, last, preset or default data, because the projection refuses those members. U81's preview-hash, Confirm, Start and uncertain-command rules are unchanged.
- Policy refresh, saves and last loads never touch `control_loop_improvement_inputs`, the journal, `control_loop_policy_input_sources` or command copies. All of these are append-only by trigger or by signature.

### Item 6: three real limits
- **Source:** the installed defaults, optionally the project layer. Never the selection layer.
- **Path into the run:** compose → signed input `settings_text` → `settings_sha256` in the binding → `commandFile` `settings.json` (argv `--settings`) → `control_loop_policy_input_sources` (defaults hash and layer versions).
- **Confirm:** the Confirm view shows `readLoopLimitsV1(signed settings_text)`, read through the existing lineage, next to the settings hash.
- **Enforcement:** the external worker enforces and counts. The product only observes: blocked `QUESTION_LIMIT`, send-back asks and escalation waits arrive through the existing gate projection.
- **Proof:** the required proofs Q1 to Q3 (section 8) run the qualified worker. Argv-only or stubbed counters cannot earn SAVED-SELECTIONS-GREEN.

### Items 7 and 8
Sections 8 and 9.

## 5. Allowed future files (BUILD, after Sol CLEAN and lead continuation)

| File | Kind | Owner and consumer |
|---|---|---|
| `src/web/v1/loop-selection-saved.ts` | NEW | U82; consumed by the U81 selection service, HTTP and client |
| `src/web/v1/loop-selection-*.ts` (U81 service, HTTP, wire) | U81 file, sequential extension | U82 adds the `last` and `saved` routes and wire types |
| `src/improve-control-room/v1/service.ts` | existing | adds only `loopBridgeSavedInput` |
| `src/web/v1/improve-control-room-loop-service.ts` | existing | adds only `lastSelection` (lead-named single writer for loop service) |
| U81 selection panel and client in `private-app/app/` | U81 file, sequential extension | load actions, stale reasons, disabled Prepare |
| `tests/loop-selection-saved.test.ts` | NEW | unit lane |
| `tests/loop-selection-saved-postgres.test.ts` | NEW | PostgreSQL lane |
| `tests/browser/loop-selection-saved.spec.ts` | NEW | browser lane |
| `package.json` scripts | shared, lead-named writer | register the three new test files in the lanes named in section 8 |

No migration, no package addition, no change to P71 compose or service, the adapter, or schemas.

## 6. Override control names

The two override controls and the acknowledgement record are U81's contract:
- the controls are the review-family override and the standard-final override;
- the acknowledgement uses rule R296 and `acceptSameFamilyRisk`.

The existing candidate evidence names them `allowSameFamilyReview` and `allowStandardFinal` (`src/improve-control-room/v1/loop-candidate-wire.ts:35`). `freshRunOverrideEditsV1` must use exactly the settings paths that U81's reviewed spec binds. BUILD rechecks them; a mismatch blocks BUILD.

Layers cannot carry `overrides` at all (compose line 15). Only defaults or runEdits can, so a saved selection is structurally unable to restore them.

## 7. Dependencies and prerequisites

| Prerequisite | Status | Blocks |
|---|---|---|
| U81 `b8-selection-to-start` released (projection, panel, preview/admission, override names) | Unreleased: only its task file exists | All of BUILD; renewed spec and base inspection required |
| U83a route validation hook | Unreleased; the existing `resolveStartRoute` hook exists with paid readiness false | Routed slots stay `route_unchecked` until released |
| P-L: qualified tools' settings paths for the three limits plus `after_limit` | Not in the public repository | `readLoopLimitsV1` and Q1 to Q3 |
| Qualified external `cr` tools and worker | External; `test:loop-policy:real` needs `CONTROL_ROOM_A2_TEST_LOOP` | Q1 to Q3, real checker case |
| R62/P72 admission, locked-edit and scoped-waiver release | Unreleased | No POLICY-ENFORCED-GREEN claim |
| U83b paid-cap mechanism | Not needed for free or subscription save and reload | Any paid run |

D01a and D01b depend on U82 and are not its prerequisites.

## 8. REQUIRED future BUILD checks

Each NEW test must fail first on the old behaviour through a real entry point:
- the HTTP route returns 404 `not_found` before the route exists;
- the PUT erases `providerRoute` with the naive client body.

A missing-module error is not red evidence. Expected counts are minimums per named file.

### Unit
```
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 tests/loop-selection-saved.test.ts tests/loop-policy.test.ts tests/improve-control-room-loop-bridge.test.ts
```

| Test | Assertion |
|---|---|
| T1 | merge preserves `providerRoute` plus one other non-B8 member byte-identically |
| T2 | the B8 edit containing an override, ack, paid, cap or limit member is refused |
| T3 | a poisoned stored layer fails closed |
| T4 | the replay key and body digest are reused on retry |
| T5 | last ordering by `result.created_at` and then `command_id` descending |
| T6 | newer waiting, refused or uncertain Starts are excluded; a tampered newest accepted row throws rather than falling back |
| T7 | each of model off, effort removed and route unavailable is reported stale and unapplied, with `preparable=false` |
| T8 | missing checker gives `checker_unavailable`; missing hook gives `route_unchecked` |
| T9 | an installed default with overrides true plus fresh run edits composes to false |
| T10 | a refused reset is refused, never restored true |
| T11 | a save after Start leaves the signed input and command copy hashes unchanged |
| T12 | composed text, signed input, command `settings.json` bytes and Confirm limits are equal for distinct limit values |

At least 12 passing tests, 0 skipped.

### Lanes
- `npm run test:improve-control-room`, with `tests/loop-selection-saved.test.ts` registered. All existing tests pass.
- `PG_BIN=<pg17 bin> npm run test:improve-control-room-postgres`, with `tests/loop-selection-saved-postgres.test.ts` registered. This runs under a fresh production login:

| Test | Assertion |
|---|---|
| PG1 | save → close pool → stop and restart the PG process → reload |
| PG2 | a stale expectedVersion conflicts without erasing anything |
| PG3 | a forged historical hash, and a cross-owner or cross-project read, are refused |
| PG4 | latest-accepted ordering with real result `created_at` |
| PG5 | events and input sources are append-only after save and last load |
| PG6 | a 20-caller production-role barrier on one selection PUT gives exactly one 201 and 19 conflicts or replays. Same-key/same-body replay is 200; same key with a changed body is a conflict. An interrupted transaction leaves no partial row; the signed history is retained. |

- `npm run test:postgres-production`
- `npm run test:private-postgres-production-boundary`
- `npm run check`, `npm run check:demo`, `npm run build`

### Mutation
Existing lanes: `npm run test:improve-control-room-loop-bridge-mutations` and `npm run test:improve-control-room-loop-lineage-mutations`, plus a NEW U82 probe set registered by the lead-named lane writer. One guard is removed at a time, each in an isolated copy:

| Probe | Guard removed | Test that must fail |
|---|---|---|
| MU1 | expectedVersion | PG2 |
| MU2 | current-route revalidation | T7 |
| MU3 | integrity check in `loopBridgeSavedInput` | PG3 |
| MU4 | override reset | T9 |
| MU5 | limit lineage equality | T12 |

### Browser
NEW `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 playwright test tests/browser/loop-selection-saved.spec.ts`, registered beside `test:improve-control-room-loop-browser`. It runs at 390×844 touch and 1280×850 and checks:
- readable stale reasons;
- an explanation for the disabled Prepare;
- focus order;
- no overflow;
- 44px targets;
- stale, reload and late-response cases.

Viewports do not prove a real device.

### Lane and loader guards
- `npm run test:ci-component-shards`, when registration changes.

### Qualified tools and worker
This is a separately authorized lane, NEW exact name `test:loop-selection-saved:real`. It requires at least one deciding pass and zero skipped or quarantined tests:

| Proof | Behaviour required |
|---|---|
| Q1 | question cap 1 admits one question per logical step, then `QUESTION_LIMIT` |
| Q2 | `after_limit=ask` with send-back cap 0 asks at the first rejection; with cap 2 it asks at the second |
| Q3 | escalation cap 0 disallows redesign; cap 1 permits one reviewed and approved redesign, then waits |

Each proof must show the counters persisted across a worker restart and a retry. A stub, label, skip or zero-test run proves nothing. Run `npm run test:loop-policy:real` alongside with `CONTROL_ROOM_A2_TEST_LOOP` set.

### Reviews and CI
- Claude code, attack and CI reviews, because authority, Start and data are affected.
- Pinned Node 22 Linux CI parity.
- Sol code gate.

## 9. Cloud scope versus withheld qualification

Buildable in the cloud after U81 is released:
- section 3, T1 to T12;
- the PG lanes, if PG17 is available;
- the browser viewports;
- the mutations;
- `check`, `check:demo` and `build`.

Withheld:
- Q1 to Q3 and the real checker, which need the qualified tools and native assembly;
- real-device evidence;
- R62/P72 release evidence;
- PG17 database qualification, which is **PG17-later** for this PLAN run because PostgreSQL 17 could not be obtained on this machine (see status).

SAVED-SELECTIONS-GREEN requires all three actual-worker limit proofs.
