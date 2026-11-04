# b8-named-presets decisions

Phase: PLAN. Each entry follows the playbook record format. These are proposals for the Sol spec gate; none is implementation.

## D1 — Extend the U81/U82 selection service rather than a separate presets service
Choice: Preset CRUD is added as methods (`listPresets`, `createPreset`, `updatePreset`, `removePreset`) on the U81 selection service class and as routes in the U81 selection HTTP handler, sharing its wire module, strict selection parser and browser client.
Options: (a) NEW standalone `loop-preset-service.ts`/`loop-preset-http.ts` modelled on `LoopProviderServiceV1`; (b) extend U81/U82 selection modules.
Why: The task ownership table names D01a a "sequential extension of that same selection service/wire/HTTP/client". A second service would duplicate the slot/count/family parser and become a second identity source for the preset shape. Cost: D01a BUILD cannot start until U81/U82 are integrated (recorded as a blocker in the spec).
Affected spec item: 1, 4.

## D2 — Two tables: catalog rows plus one per-project state row
Choice: `control_loop_selection_presets` (one row per preset) and `control_loop_selection_preset_state` (one row per tenant/project carrying the catalog version and last idempotency key/digest/result).
Options: (a) per-preset version and idempotency columns; (b) single JSON catalog document; (c) catalog rows plus one state row.
Why: The task requires one catalog-wide `expectedVersion`, replay after deletion (a deleted row cannot hold its own replay record) and a single lock point for existing-row writes. (c) mirrors the existing `control_loop_provider_state` pattern (0308) and lets D01b later add a default pointer to the state table without a catalog rewrite.
Affected spec item: 3.

## D3 — First-write race uses INSERT … ON CONFLICT DO NOTHING RETURNING, then lock-and-replay
Choice: At expectedVersion 0 the writer inserts a fully populated version-1 state row with `ON CONFLICT (tenant_id,project_id) DO NOTHING RETURNING`. A writer whose insert returned no row then takes `SELECT … FOR UPDATE` on the winner's row and runs the replay/version check against that row; it never compares its own expected 0 against a row it created itself.
Options: (a) project-row `FOR UPDATE` mutex as in `LoopPolicyServiceV1.#scope`; (b) advisory lock; (c) ON CONFLICT reservation.
Why: The task text requires (c). The project row is still locked `FOR SHARE` for the lifecycle/template check, so project deletion/archival cannot interleave; using `FOR UPDATE` on the project row as well would serialize unrelated project writes (policy layers) behind preset writes, which the task does not ask for.
Affected spec item: 3, 7.

## D4 — Removal by POST `/presets/:id/remove`, edits by PUT `/presets/:id`
Choice: Follow the provider pattern (`PUT /loop-providers/:id`, `POST /loop-providers/:id/remove`).
Options: HTTP DELETE; POST for every mutation.
Why: Task item 5 forbids generic DELETE/PUT. `createPrivateNodeHandler` production mode has `allowDelete:false`, so DELETE would require widening a shared transport switch. Only one anchored `editPut` alternative is added.
Affected spec item: 4, 5.

## D5 — Server-generated preset IDs
Choice: `preset:<32 lowercase hex>` from `randomBytes(16)`; the ID is stored in the state row's last result so that a replay of a create returns the same ID.
Options: client-supplied ID; name-derived slug.
Why: Task item 4 requires server-generated ID. A slug would make rename a key change and leak name collisions across case folding.
Affected spec item: 3, 4.

## D6 — Name uniqueness by expression unique index on `lower(name)`
Choice: `CREATE UNIQUE INDEX … ON control_loop_selection_presets (tenant_id, project_id, lower(name))`; the service maps 23505 on that index to `conflict` with reason `name_taken` and performs a pre-check under the state lock for a readable error.
Options: table `UNIQUE (…, lower(name))` (invalid syntax in PostgreSQL); citext (extension, package/DB change); service-only check.
Why: Task item 2 requires an expression index. The service pre-check gives a deterministic error; the index is the final authority under races.
Affected spec item: 2, 6.

## D7 — Outer body budget stays at the 8 KiB default
Choice: Preset routes do not get a new `privateRequestBudgets` entry. Per-field slot byte bounds (model 128, route 64, effort 32) plus the 80-code-point name bound make the worst canonical preset ≈2400 bytes (stored cap 4096) and the worst escaped request ≈5540 bytes (outer 8192); arithmetic in spec §5.
Options: add a `selection` budget of 64 KiB matching `parseLoopSettingsV1`.
Why: Task item 5 says to stay within the actual outer 8 KiB envelope. Roster names have no SQL length limit (plan review F2), so explicit bounds are required to make the envelope provable. Widening `private-request-budgets.ts` is a shared transport change the lead would have to coordinate.
Affected spec item: 5.

## D8 — Stale presets are stored and flagged, not refused
Choice: Writes validate structure only (strict keys, counts, slot shape, family rule that is structural). Eligibility against the current roster/providers is computed on read as `stale: {code,explanation}[]` per preset and shown in the panel; Pick of a stale preset still copies to the draft, and the draft's own U81 preview refuses preparation.
Options: refuse saving ineligible presets.
Why: Task item 2 explicitly allows structurally valid but currently ineligible presets. Authority remains with U81 preview/admission.
Affected spec item: 2, 5.

## D9 — Final/builder family rule is reported as stale, never a write refusal (revised r2)
Choice: Writes never read the roster. On read, a preset whose final and build models share a roster family carries stale code `final_shares_builder_family`; U81 preview refuses preparation and the rule can never be acknowledged.
Options: refuse at write when both models resolve (r1 draft).
Why: Plan review F6: family is roster-dependent eligibility; the task allows ineligible-but-structural presets to save visibly stale; a write-time refusal would be inconsistent after later roster edits and adds a roster lock to every commit.
Affected spec item: 2.

## D10 — Canonical preset text via the existing encoder
Choice: Export the existing private `encode` function from `src/web/v1/loop-policy-compose.ts` unchanged (export keyword only) and use it for canonical `selection_text`.
Options: (a) write a second canonical encoder in the selection module; (b) store client text verbatim; (c) export the existing one.
Why: (a) would create a second canonical serializer beside the composer; (b) makes digests and replay depend on client key order. (c) is a signature-preserving one-word change; if the lead prefers zero edits to the composer file, (b) with a digest over the parsed value is the fallback and must return to the Sol spec gate.
Affected spec item: 2.

## D11 — Transport regex accepts only a literal `preset:` ID
Choice: The new `editPut` alternative matches `/presets/preset:[a-f0-9]{32}$`; the client validates the server ID and does not percent-encode it.
Options: accept `%3A` too and decode in the inner handler.
Why: Narrowest anchored alternative; one accepted spelling means one digest and one audit resource ID.
Affected spec item: 5.
