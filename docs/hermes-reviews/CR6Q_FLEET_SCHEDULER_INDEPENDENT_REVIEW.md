# CR-6Q independent fleet and scheduler integrity review (CR6Q-REV-001)

- **Reviewed head (immutable base pin from capsule):** `c5dcb81cd1167caa4804b5f3c2483d3503b70946` ("fix(cr6q): harden fleet scheduler integrity"), which is an ancestor of integration head `3fdcce9c08bf60ed4e880a3350b1ece691e5f344` (`integration/cr5d-synthetic-executor-1`). Only the pinned base's product sources were reviewed; commits after it on the integration branch are docs/capsule-only (`docs/BUILD_STATUS.md`, `docs/CR6Q_ACCEPTANCE.md`, capsule JSON) and were read as context, not product evidence.
- **Reviewer:** Ziggy (route `ziggy-windows`), independent jobber #155 / capsule `CR6Q-REV-001`.
- **Independence declaration:** the reviewer profile authored **none** of the reviewed commits. Every commit visible on the reviewed head is authored by `Alastair Fraser <alastairfraser@Alastairs-Mac-mini.local>` (verified via `git log` over the integration head before reading any review conclusions). No author overlap exists; the independence gate passes.
- **Method:** read-only source inspection plus execution of exactly the capsule's three acceptance commands in a fresh worktree. No code, test, contract, workflow, or acceptance-criteria change was made. Effects: none (ledger below).

## Verification commands (observed, this run)

| Command | Result |
|---|---|
| `npm run test:cr6q` | exit 0 — 41 tests, 41 pass, 0 fail, 0 skipped |
| `npm run check` | exit 0 (TypeScript `tsc --noEmit`, no output) |
| `git diff --check integration/cr5d-synthetic-executor-1...HEAD` | exit 0 (no whitespace errors; worktree clean at this point) |

Dependencies were installed into an isolated worktree with `pnpm install --frozen-lockfile --offline` (warm store, no network download) — a setup prerequisite for the capsule's "repository dependencies" tool requirement, not a review effect. Passing tests alone are not treated as proof that no finding exists (per capsule semantic acceptance).

## Area-by-area review

### 1. Policy bypass — not reproduced

`chooseAllocationV1` builds each candidate's rejection reasons first (`invalid`, caller `exclusions`, availability, constraints, placement) and only scores candidates with zero reasons (`src/scheduler/v1/allocation.ts:51-66`). The starvation lane is drawn exclusively from the already-filtered eligible set (`allocation.ts:64-66`), so an excluded candidate cannot win via age. `evaluateSchedulingConstraintsV1` rejects invalid inputs closed with `invalid_candidate` before any comparison (`src/scheduler/v1/constraints.ts:42-58`). Owner Focus writes require a durable `security.authorize` decision and throw `owner_focus_forbidden` otherwise, and deliberately create no reservation, scheduler change, outbox event, dispatch, or external effect (`src/operator-surfaces/v1/owner-focus-command-service.ts:16-19,29-58`). The pin upsert is metadata-only and cannot alter "feasibility, authority, capacity, or fair-share policy" per its own type contract (`src/operator-surfaces/v1/types.ts:168`).

### 2. Starvation and deterministic ordering — not reproduced

`STARVATION_BOUND_MINUTES_V1 = 1_440` (`allocation.ts:31`); the oldest eligible candidate at/above the bound wins before score order, with a stable `projectId:workItemId:routeId` tie-break (`allocation.ts:63-66`). Score components are all finite-bounded inputs and the decision is wall-clock-free. Seeded tests cover 100 arrival-order invariance cases and 100 starvation/exclusion cases (`tests/scheduler-properties.test.ts:39-44,49-63`, both `for (let seed = 1; seed <= 100; seed += 1)`), asserting the starved old candidate wins and excluded candidates never do. Observed: all 41 focused tests pass.

### 3. Capacity and budget races — not reproduced

`ResourceReservationStore.acquire` serializes on a per-tenant/resource head row via `SELECT ... FOR UPDATE` before summing active units, and rejects over-capacity claims with `resource_unavailable` (`src/scheduler/v1/reservation-store.ts:59-70`). Budget reservations serialize on a per-tenant/project head row the same way (`src/scheduler/v1/budget-store.ts:16`). Replay of an identical request returns `replayed: true` with digest comparison and `reservation_conflict` on divergence; release after expiry records `expired` rather than a post-hoc release; reconciliation expires by `expires_at <= now` (`reservation-store.ts:62-92,95-105`) — replay-safe. The future-`acquiredAt` guard is new in the remediation: `Date.parse(input.acquiredAt) > Date.parse(now)` throws `invalid_reservation` (`reservation-store.ts:57`), with a new regression assertion (`tests/scheduler-reservation-store.test.ts:19`). Concurrency: 16 concurrent one-unit claims on capacity 1 produce exactly 1 fulfillment and 15 `resource_unavailable` rejections (`tests/scheduler-acceptance.test.ts:25-45`), observed passing.

### 4. Platform-status drift — not reproduced

The fleet projection no longer maps administrative `active` state to `online` unconditionally. `online` requires `fresh_telemetry_count > 0`, where "fresh" demands a usable trust (`reported|verified`), `observed_at <= now`, and `expires_at > now` in the same SQL row expression (`src/operator-surfaces/v1/read-service.ts:42-43,60-63`). Otherwise an active node renders `degraded` with `stateReasonCode` `telemetry_stale` or `telemetry_missing` (`read-service.ts:63,69`). The regression test seeds fresh, expired, future, and blocked nodes and asserts only the fresh one renders `online` (`tests/operator-surface-read-service.test.ts:118+`), observed passing. `lastObservedAt` is clamped to candidates that exist and are not in the future, and a read with no non-future observation fails closed with `invalid_read_scope` (`read-service.ts:61-67`).

### 5. Stale or future evidence — not reproduced

Signal freshness rejects `observedAt > now` (`signal_from_future`) and `expiresAt <= now` (`signal_expired`) (`src/node-fleet/v1/freshness.ts:6-7`); the evaluator additionally requires usable trust before any capability/benchmark consideration (`src/node-fleet/v1/eligibility.ts:34-37`). The projection counts passing, unexpired, non-future, usable-trust capability rows for `provisional`, requires `trust='verified'` for `verified`, and renders expired passing evidence as `expired` rather than hiding or promoting it (`read-service.ts:42-44,64-66`). The future-granted read scope is rejected: `Date.parse(scope.grantedAt) > Date.parse(now)` throws `invalid_read_scope` (`read-service.ts:198`; regression `tests/operator-surface-read-service.test.ts:59`). The reservation future-start guard is covered in area 3. The projection never marks self-reported evidence as `verified`, consistent with the schema-level rule that node-submitted signals cannot self-report verified trust (`src/node-fleet/v1/schemas.ts:96`).

### 6. Mixed-identity composition and tenant isolation — not reproduced

The eligibility boundary now computes the set of `tenantId\0nodeId` identities across the input signals and returns `signal_identity_mismatch` before any evaluation when it exceeds one (`src/node-fleet/v1/eligibility.ts:41-42`), so telemetry from one node cannot be combined with capability from another. Regression: mixed-tenant-node signal set is rejected with exactly that reason (`tests/node-fleet-contract.test.ts:136-140`). Persistence binds every signal row to `(tenant_id, node_id)`, requires the node to exist in the same tenant, and validates sequence continuity plus payload digest for replay (`src/node-fleet/v1/fleet-signal-store.ts:62-78`); reads re-validate the stored payload against the row's tenant/node/kind/sequence/fingerprint/trust/times and fail closed on any mismatch (`fleet-signal-store.ts:29-37`). The read service re-parses the node payload and throws unless tenant, id, and state match the row (`read-service.ts:53`); all queries are tenant-parameterized.

### 7. Redaction and bounded effects — not reproduced

`assertNoSecretMaterial` runs on ingest, current read, and history read of fleet signals (`fleet-signal-store.ts:17,37,57`), and the security suite covers canary-style rejection (`tests/security.test.ts:123-125`). The Owner Focus write path emits no outbox event, reservation, or dispatch (area 1). Fleet summaries carry `capacityState: "unavailable"` as a fixed value (`read-service.ts:71`), so absent capacity cannot be fabricated as reported. Error channels use fixed safe codes (`ResourceReservationError`, `OperatorSurfaceReadError`, `FleetSignalStoreError`, `OwnerFocusCommandError`); no raw host identity, path, or diagnostic is included in review scope sources. The schedule projection keeps schedule expressions and dispatch authority server-side (`src/operator-surfaces/v1/types.ts:121`).

### 8. Default-suite registration and retained deployment/native gates — documented

The remediation added the protected operator API/UI, Owner Focus, target-guard, and platform-qualification-safety test files to the default `npm test` script (`package.json`, remediation commit). A programmatic comparison of the `test` script file list against the parent commit shows **13** files added and none removed (62 file arguments now, 49 before). The acceptance record states "Fourteen effect-free security, protected-API, and operator-surface test files were outside `npm test`" (`docs/CR6Q_ACCEPTANCE.md:26`). Counting methodology may differ (for example counting logical groups rather than file arguments), but as written the number does not match the observed diff; see Finding F-1. Retained gates are honestly framed as not proven by this review: proxy-injected `oai-authenticated-user-id` trust, no self-reported signal becoming verified, separate CR-6E owner acceptance, native key-store/supervisor gates, and the effect-free planning-only status of the scheduler (`docs/CR6Q_ACCEPTANCE.md:35-41`). Nothing in the reviewed head converts those gates into passes.

## Findings

| ID | Severity | Evidence | Scenario | Disposition |
|---|---|---|---|---|
| F-1 | informational | `docs/CR6Q_ACCEPTANCE.md:26` says "Fourteen" test files were added to the default suite; the diff of the `test` script shows 13 added file arguments (49 → 62), none removed | A reviewer relying on the acceptance doc's count would mis-audit suite coverage; the mismatch is documentation drift, not a missing test — all 13 observed additions are effect-free suites consistent with the finding's intent | confirmed (documentation accuracy only) |
| F-2 | informational | `stateReasonCode` is emitted as `telemetry_stale`/`telemetry_missing` by the fleet projection (`src/operator-surfaces/v1/read-service.ts:63`) and is validated only as a free-form safe-id string (`src/operator-surfaces/v1/validators.ts:62`); the scheduler's eligibility vocabulary uses the same reason codes for a different purpose (`src/node-fleet/v1/eligibility.ts:7-8`) | An operator surface consumer that treats `stateReasonCode` as the scheduler eligibility vocabulary could conflate "node is degraded for lack of fresh telemetry" with "candidate was rejected as fleet-ineligible for stale telemetry". Semantics align closely enough that no incorrect behavior is demonstrated; this is a vocabulary-contract ambiguity for a future CR to resolve explicitly | not reproduced (no failure scenario demonstrated; noted for contract hygiene) |
| F-3 | informational | `docs/CR6Q_ACCEPTANCE.md:12` reports "`npm test`: 339 tests, 337 passed" as automated evidence | This reviewer ran only the three capsule-authorized acceptance commands and did not re-run the full suite; the 339/337 figure remains documented (not observed) evidence in this report | retained gate (full-suite re-verification stays with Codex's final review head, alongside the build/render/migration reruns already marked outstanding) |

No policy bypass, starvation, capacity race, drift, stale/future-evidence, identity, tenant-isolation, or redaction defect was reproduced. No secret, raw host identity, private infrastructure detail, or personal path appears in the reviewed sources or this report.

## Effects ledger

| Effect | Count | Detail |
|---|---|---|
| Authorized GitHub issue comment (claim) | 1 | `/claim ziggy-windows` on #155 |
| Worktree + branch creation (packet-mandated setup) | 1 each | `agent/ziggy-windows/cr6q-rev-001` from `origin/integration/cr5d-synthetic-executor-1` |
| Dependency install (tool prerequisite, frozen lockfile, offline) | 1 | `pnpm install --frozen-lockfile --offline`, exit 0 |
| Acceptance command executions | 3 | exactly the capsule's three commands, once each |
| Repo or contract modifications | 0 | none; this report is the sole file change |
| Native probes, installs beyond lockfile, credential use, external services, restarts | 0 | none |

Cleanup: the worktree is the packet's producer checkout and is retained for the PR; nothing else was created. This report, the result manifest, and the PR are the packet's outputs.

## Close recommendation

`changes required` is **not** warranted: no code or contract defect was found. The packet-level recommendation for this review is **accept** — the eight matrix areas hold at the pinned head with the evidence above — with two non-blocking documentation notes (F-1 count mismatch in `docs/CR6Q_ACCEPTANCE.md:26`, F-2 vocabulary note) left for Codex disposition, which owns the CR-6Q acceptance matrix. This review does not approve, merge, or close CR-6Q, does not alter the Codex acceptance matrix, and does not authorize CR-7 to begin; per the acceptance record, CR-7 must not begin until the independent reviewer reports a disposition and Codex closes or explicitly retains every finding.
