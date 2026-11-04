# b8-saved-selections — technical decisions (PLAN)

Choice: D1. Use the P71 `selection` layer row as the only saved-selection store. Saves go through the existing `PUT /api/v1/projects/:p/loop-policy/selection`.
Options: a new selection table or a per-owner layer; extending `control_loop_policy_layers` with a new layer kind; reusing the P71 layer.
Why: the task forbids a parallel store. P71 already supplies expectedVersion, idempotent replay, the body digest, authority, the checker gate and append-only events (`loop-policy-service.ts:138-183`). Reusing it adds no migration.
Affected spec item: 2

Choice: D2. The client composes the whole-layer replacement with a pure `mergeSelectionLayerV1(currentLayerText, b8Edit)`, starting from the layer it last viewed. The stale-version conflict comes from P71.
Options: a server-side merge endpoint (a new write route); client-side replacement; adding partial-update semantics to the P71 PUT.
Why: P71's PUT replaces the whole layer at an expectedVersion, so a merge against the viewed version cannot erase a concurrent member: the version check rejects it. A new write route would widen the PUT/DELETE surface. Changing P71 semantics is outside U82's ownership.
Affected spec item: 2

Choice: D3. "Last" is derived read-only from the signed input at `binding.localVersion` of the latest result with `state='accepted'`. Ordering is `result.created_at DESC, command_id DESC`, and the read fails closed on the first row that does not verify.
Options: store a "last" pointer on Start; read the selection layer version from `control_loop_policy_input_sources`; skip tampered rows and fall back to older ones.
Why: a pointer would be a second store and a write on Start. Layer versions identify a layer row that may since have been overwritten. Only the signed `settings_text` holds the exact bytes the run used. Skipping tampered rows would let tampering choose the result. `waiting` maps to "dispatched" (`improve-control-room-loop-service.ts:299`), and a claim without a result is uncertain, so neither counts as accepted.
Affected spec item: 3

Choice: D4. Add no index or migration for the last-selection query.
Options: a new index on `(tenant_id, project_id, owner_identity_id, operation, entry_kind, created_at)`; no index.
Why: Start claims are unique per request, so the result set is bounded by the owner's requests in the project. The task permits a migration only if it is indispensable and the lead authorizes it. BUILD measures the query plan in the PG lane. If the cost is unacceptable, that is raised to the lead as a revised-scope request and not added unilaterally.
Affected spec item: 3, 8

Choice: D5. `loopBridgeSavedInput` is a narrow public wrapper over the private `#loopRoot` and `#loopInput(version)`.
Options: copy the verification into the loop service; widen `loopBridgeLineage` with a version parameter.
Why: the task names this wrapper. Widening `loopBridgeLineage` would change existing callers, which rely on getting the latest version. Copying the verification would create a second verifier.
Affected spec item: 3

Choice: D6. A stale slot is reported and left unapplied, and Prepare is disabled. A missing route hook means `route_unchecked`.
Options: best-effort substitution; silently dropping slots; treating a missing hook as available.
Why: the task requires no silent replacement and fail-closed behaviour when something is unavailable.
Affected spec item: 4

Choice: D7. Every new run merges explicit-false override run edits at intake.
Options: rely on layers lacking `overrides`; reset in the browser only; reset at Start.
Why: runEdits has the highest compose precedence (`loop-policy-compose.ts:43`), so explicit false beats installed true defaults. Layers already cannot carry `overrides` (line 15). Start does not recompose (it uses signed text, `loop-service:660`), so the reset must happen at intake composition. A checker refusal is surfaced and never bypassed.
Affected spec item: 5

Choice: D8. The three limits stay in defaults and the project layer, and are traced through existing artifacts: the signed text, the settings hash, the command `settings.json`, and the input sources. The product display uses a pure `readLoopLimitsV1` projection.
Options: dedicated limit columns; a limits table; counters kept in the product.
Why: the task forbids a second mutable limit store and direct counter assignment. The worker is external and owns the counters. The product proves lineage, and the qualified worker lane proves enforcement.
Affected spec item: 6

Choice: D9. Plan-review helper not run; two read-only inspection helpers were used.
Options: run a Claude plan-review helper; not run one.
Why: the playbook makes it optional. I verified the inspection helpers' citations directly. A Claude review could not satisfy the Sol gate in any case.
Affected spec item: all
