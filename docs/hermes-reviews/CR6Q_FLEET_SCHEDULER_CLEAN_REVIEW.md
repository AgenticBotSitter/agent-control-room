# CR6Q clean independent review — fleet and scheduler integrity

**Capsule:** CR6Q-REV-002 (wave `CR6Q-REVIEW-2`)
**Reviewed commit:** `c5dcb81cd1167caa4804b5f3c2483d3503b70946` — "fix(cr6q): harden fleet scheduler integrity"
**Reviewer route:** `marvin-macos` · **Mode:** independent-review · **Effects:** none · **Source repairs:** none
**Report date basis:** integration head `5bc6c4d5dd6b1340e2474ae30a5c23c3c44b601b`

## Independence declaration

Written before reading any CR6Q-REV-001 conclusion or the intake disposition of PR #156:

- The reviewer profile (`marvin-macos`, claimant `@MarvinAi5`) authored **none** of the reviewed product commits. Every commit touching `src/`, `tests/`, or `docs/` contracts at and before the reviewed head is authored by the architect identity (`Alastair Fraser <alastairfraser@Alastairs-Mac-mini.local>`, the Codex producer route).
- The reviewer profile did not author or perform the first independent review (CR6Q-REV-001); per the issue thread that review was claimed and submitted by the `ziggy-windows` route. No overlap exists.
- Method: the reviewed commit's full diff was read first, then the surrounding contracts (`eligibility.ts`, `freshness.ts`, `fleet-signal-store.ts`, `fleet-eligibility-service.ts`, `reservation-store.ts`, `allocation.ts`, `constraints.ts`, `availability.ts`, `budget-store.ts`, `read-service.ts`) were inspected directly from the worktree. All conclusions below are from this profile's own source analysis and test runs.

## Method and evidence run

Executed inside an isolated worktree (`agent/marvin-macos/cr6q-rev-002`) branched from `origin/integration/cr5d-synthetic-executor-1` at `5bc6c4d5`. Repository dependencies were **reused from a pre-existing checkout on the same machine whose `pnpm-lock.yaml` blob (`2641216d…`) is identical across `main`, the integration tip, and the worktree base**; no install, download, or network fetch occurred at any point. Stage-zero probe: `ready_for_runtime_check`.

| Command (exact) | Result |
|---|---|
| `npm run test:cr6q` | 41 tests, 41 passed, 0 failed (exit 0) |
| `npm run check` | `tsc --noEmit` clean (exit 0) |
| `git diff --check integration/cr5d-synthetic-executor-1...HEAD` | clean (exit 0) |
| `npm test` (reviewer-run corroboration, not an acceptance command) | 339 tests, 337 passed, 0 failed, 2 skipped (platform-gated), exit 0 |

The full-suite numbers independently match the automated evidence recorded in `docs/CR6Q_ACCEPTANCE.md` ("339 tests, 337 passed, 0 failed, 2 intentional platform skips"). One local, content-free prerequisite: a tracking ref for the integration branch was created in the worktree so the third acceptance command's literal string resolves; no commit content depends on it.

## Review areas

### Policy bypass

No bypass found. In `src/scheduler/v1/allocation.ts`, every candidate is evaluated through `reasons()` (`allocation.ts:51`), which returns `["invalid_candidate"]` for malformed input and otherwise unions declared `exclusions`, availability, constraint, and placement rejections **before** eligibility filtering (`allocation.ts:54-57`); the scored set (`allocation.ts:57-62`) contains only candidates with zero rejection reasons, so no excluded candidate can be selected regardless of score. Constraint evaluation (`src/scheduler/v1/constraints.ts:57-70`) is total: malformed input yields `invalid_candidate`, cost/privacy/quality/deadline/maintenance/draining rejections are computed from declared facts only, and soft deadlines correctly do not reject. Hard exclusions are not convertible into scores; there is no path from a rejection reason to the winner selection except the empty case (`allocation.ts:67`).

### Starvation and deterministic ordering

No starvation path found. The starvation lane (`allocation.ts:63-66`) selects the longest-queued eligible candidate once `queueAgeMinutes >= STARVATION_BOUND_MINUTES_V1` (1440, exported at `allocation.ts:26`), and both lanes terminate in the same stable key (`projectId:workItemId:routeId`) so equal-score ties are deterministic. The starvation override takes precedence over score, so a high-priority stream cannot indefinitely displace old work. Note the bound is bounded-age-based, not deadline-aware; that is consistent with the contract's declared scope (deterministic ordering, not SLA scheduling).

### Capacity and budget races

No race found in the ledger model. `ResourceReservationStore.acquire` (`src/scheduler/v1/reservation-store.ts:56-79`) runs head-row `SELECT … FOR UPDATE` (`reservation-store.ts:60`), expires due actives, replay-checks by id with `FOR UPDATE` (`reservation-store.ts:63`), sums active units, and rejects over-capacity with `resource_unavailable` — serialized by (tenant, resource) head lock. `ProjectBudgetStore.reserve` serializes identically by (tenant, project) budget head (`src/scheduler/v1/budget-store.ts:15-22`) and is fail-closed on replay mismatches (`budget_reservation_conflict`). The future-time hole is closed: `acquire` now rejects `acquiredAt > now` (`reservation-store.ts:57`), with regression coverage at `tests/scheduler-reservation-store.test.ts:19`.

Two semantic observations (findings F-2 below) arise around replay after expiry; neither is a capacity race — capacity accounting remains exact because expired rows are excluded from the `SUM` and the head lock serializes all mutators.

### Platform-status drift

No drift found. The fleet projection no longer equates administrative `active` state with liveness: an active node is rendered `online` only when fresh usable telemetry exists, otherwise `degraded` with `telemetry_missing`/`telemetry_stale` (`src/operator-surfaces/v1/read-service.ts:62,70-71`). The dedicated regression (`tests/operator-surface-read-service.test.ts:118`) proves stale, future, blocked, and expired telemetry/capability rows cannot render as current, and that tenant 2 sees none of tenant 1's nodes.

### Stale, future, or untrusted evidence

No reproduction of the closed findings. The read-source SQL (`read-service.ts:38-46`) gates every count and the observation timestamp on `trust IN ('reported','verified')`, `observed_at <= now`, and (for freshness/capability) `expires_at > now`; capability presentation additionally requires `outcome='pass'`, with `verified` reserved for `trust='verified'` (`read-service.ts:64-66`). Future evidence cannot render current: `observed_at <= $2` excludes it and the test proves a future-observed node reads `degraded`/`stale`/`unavailable`, not fresh. Freshness at the pure boundary (`src/node-fleet/v1/freshness.ts:5-7`) rejects future-observed and expired signals. Ingest-side integrity is enforced in `src/node-fleet/v1/fleet-signal-store.ts`: per-tenant/node binding with `identity_mismatch` (`:16`), strict sequence monotonicity with digest-pinned replay (`:67-78`), and read-back schema re-validation (`:30-34`).

Residual exposure, recorded as F-1: freshness is bounded by the signal's **self-declared** `expiresAt`; the contract places no upper bound on that lifetime (`src/node-fleet/v1/schemas.ts:84-95` only requires `expiresAt > observedAt`).

### Mixed-identity composition and tenant isolation

No composition or isolation break found. The pure evaluator now refuses any mixed (tenant, node) signal set up front with `signal_identity_mismatch` (`src/node-fleet/v1/eligibility.ts:41-42`), exercised by the cross-node capability regression (`tests/node-fleet-contract.test.ts:136-139`). The stored-path caller (`src/node-fleet/v1/fleet-eligibility-service.ts:17`) sources signals strictly from `FleetSignalStore.current({tenantId, nodeId})`, and the store double-binds tenant/node on read and read-back. The read service re-parses each node payload and fails closed when tenant id, node id, or state disagree with the row (`read-service.ts:54`), and the read scope rejects a future-granted scope (`read-service.ts:198`). Every query in the reservation, budget, and signal stores is tenant-scoped; no cross-tenant join or unscoped query was found in the reviewed surfaces.

### Redaction and bounded effects

No redaction break found. Fleet summaries expose only worker id, platform, state/state-reason codes, timestamps, and enum states — no payload contents, host material, or free text; malformed payloads fail closed with the safe `invalid_read_scope` code rather than leaking diagnostics. Error surfaces across the reviewed modules carry safe enum codes only (`FleetSignalStoreError`, `ResourceReservationError`, `ProjectBudgetError`, `OperatorSurfaceReadError`). The reviewed code paths are read-only or ledger-local; nothing in the diff performs an effect, and the report itself claims none.

### Default-suite registration

Confirmed fixed. `package.json` on the integration branch registers the operator API/UI, Owner Focus, target-guard, and platform-qualification safety tests in the default `test` script, and `test:cr6q` covers the nine CR-6Q-relevant files. The reviewer's own `npm test` run (above) independently corroborates the recorded counts.

## Findings

All findings below are low severity or informational. None reproduced an unsafe behavior, bypass, race, or drift. Dispositions use the capsule vocabulary (confirmed / not reproduced / retained gate / unsupported).

### F-1 — Signal lifetime is self-declared and unbounded (severity: low, disposition: confirmed)

`FleetSignalEnvelope.expiresAt` has no ceiling: the only cross-field rule is `expiresAt > observedAt` (`src/node-fleet/v1/schemas.ts:95`). A compromised or misbehaving producer can declare a telemetry or capability signal valid for an arbitrarily long horizon, and the eligibility boundary (`freshness.ts:5-7`) and read-source SQL will honor it until that instant. Concrete scenario: a node emits one passing capability probe with `expiresAt` one year out; it remains `provisional`/eligible for that year even if the node dies immediately after, because no further telemetry is required to keep the capability row "fresh." This does not contradict any acceptance criterion — the contract explicitly retains "no self-reported fleet signal becomes independently verified" — but a maximum-signal-lifetime cap per kind would bound how stale self-reported evidence can present as current. Suggested disposition: retain as contract hygiene for the next CR6B consumer-contract pass; not a CR-6Q closure blocker.

### F-2 — Reservation replay after expiry returns the expired row honestly but `replayed: true` (severity: low, disposition: confirmed)

`ResourceReservationStore.acquire` on an existing id compares the full request and, if identical, returns the stored row with `replayed: true` (`reservation-store.ts:63-68`) even when a prior `reconcile` has already flipped that row to `expired`. The returned record is truthful (`state: "expired"`), and capacity stays exact because expired rows are excluded from the usage sum. The failure mode is consumer-side: a caller keying on `replayed: true` as "the reservation is active" would proceed without re-acquiring. Concrete scenario: worker A reserves, its lease expires via reconcile, the worker's retry with the byte-identical request gets `replayed: true` and treats the returned object as a grant. Suggested disposition: either reject replay of expired rows or document that callers must check `reservation.state` on every acquire; hygiene, not a ledger defect.

### F-3 — `telemetry_missing` and `telemetry_stale` overlap in presentation (severity: informational, disposition: confirmed)

`evaluateFleetEligibility` pushes `telemetry_missing` when a telemetry signal is absent or trust-blocked/unavailable, and `telemetry_stale` when present-but-not-currently-usable (`eligibility.ts:45-46`); the read service maps a node with only blocked/unusable telemetry to `telemetryState: "missing"` with reason `telemetry_missing` (`read-service.ts:55,62-63`). The reason code can therefore conflate "no telemetry exists" with "telemetry exists but is not currently trusted/usable." Consumers keying on the reason string for alerting cannot distinguish the two. Non-blocking; matches the hygiene note already queued for the next consumer contract. Passing tests alone were not treated as proof of absence for the areas above; each claim is anchored to the source lines inspected.

## Areas checked with no findings

Scheduler scoring/tie-break determinism, availability-window matching (`src/scheduler/v1/availability.ts` normalized-window validation), placement constraint evaluation, budget reserve/release/replay fail-closed behavior, signal sequence/digest replay protection, discovery-fingerprint benchmark binding (`eligibility.ts` benchmark branch), read-scope time validation, and canonical node payload re-validation in the read source: all inspected, none produced a finding.

## Retained gates (not re-litigated)

The deployment-identity proof for injected authentication headers, the "self-reported evidence is provisional by design" boundary, CR-6E owner acceptance, native macOS key-store qualification, per-platform supervisor rehearsals, and the effect-free (planning/accounting-only) status of the scheduler and reservation ledger all remain Codex-owned gates. This review neither confirms nor weakens them; nothing here converts a gate into a pass.

## Close recommendation

**accept** — the reviewed remediation commit addresses the five closed findings it records (mixed-identity eligibility, expired/invalid capability presentation, administrative-state-as-live-state, future-time acceptance, default-suite registration) with correct, tested implementations; this clean review found no new policy bypass, starvation path, capacity race, platform-status drift, stale/future-evidence presentation, tenant-isolation, or redaction defect. Findings F-1 through F-3 are low/informational hygiene items for Codex disposition and do not, in this reviewer's judgment, block CR-6Q closure. This recommendation does not approve or merge CR-6Q and does not alter the Codex acceptance matrix; retained deployment and native gates stand.
