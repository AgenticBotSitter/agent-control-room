# Assignment recommendations (WORK-014)

A recommendation is shown **before** an assignment is made. It explains why one configured
machine is a reasonable choice for one task, states the capability, platform, capacity and
policy basis for that judgement, and reports what it does not know as unknown. It reserves
nothing, starts nothing and grants nothing.

Contract version: `control-room-assignment-recommendation/v1`.

## Where it lives

| Artifact | Role |
| --- | --- |
| `src/assignment-recommendation/v1/types.ts` | Projection, basis and limit vocabulary; the reported-effort set |
| `src/assignment-recommendation/v1/evidence.ts` | Canonical eligibility + capacity + historical-outcome evidence for one candidate |
| `src/assignment-recommendation/v1/recommendation.ts` | The total, effect-free projection function and the scope guard |
| `src/assignment-recommendation/v1/schema.ts` | Strict Zod schema for the projection |
| `private-app/app/assignment-recommendation.tsx` | Read-only presentation inside the task assignment panel |
| `private-app/app/task-assignment.tsx` | Computes the projection from the assignment options response and mounts the panel |
| `tests/vps-built-assignment.test.mjs` | Focused checks for basis, honesty, scope and read-only shape |

## What the recommendation reuses

- **Eligibility** — `src/node-fleet/v1/eligibility.ts` (`evaluateFleetEligibility`). The
  recommendation calls the same total policy function the assignment path calls, with the
  same required capability probe, scratch floor, optional benchmark and verification flag.
  Every refusal reason it returns is carried into the projection's basis and explanation, so a
  stale, missing or mismatched signal is visible as such rather than as a silent "no".
- **Capacity** — the candidate's `maxConcurrentTasks` and `activeTaskCount`, which are the
  declared route facts the assignment path already serializes on. Capacity is reported, never
  re-derived, and a full route is excluded from the ranking.
- **Historical model outcomes** — reported rows grouped by model class and effort, the same
  grouping `scripts/public-model-outcomes.mjs` publishes. Class strings are validated against
  the report's own model-class shape, so an incomparable class cannot be averaged into a
  recommendation. An effort class is recommended only when a group of at least
  `MIN_HISTORY_SAMPLE_V1` (2) comparable observations has a strictly better accepted ratio
  than every other group.
- **Policy** — the required capability, allowed platforms and verification requirement are the
  caller's packet facts; the projection states them as basis entries.

## The honesty rules

- Unknown stays unknown. An unreported effort, duration or token count is labelled
  `unknown` / `unreported` with a `limit` entry naming exactly what is missing. No price,
  speed, model or provider is inferred, and no default is substituted.
- Stale, missing, conflicting or incomparable evidence never produces a silent guess. It
  produces either `limited` (a named machine plus the missing evidence in `limits`) or
  `unavailable` (no machine, `recommendation: null`, and the eligibility reasons in the
  explanation).
- `state` is `recommended` only when the projection carries no limits at all. That is the
  normal case only for fully reported history; otherwise the surface says `limited`.
- The projection is bound to one `projectId`, `jobId` and `inputDigest`. The presentation
  refuses a projection whose scope does not match the task in hand
  (`recommendationScopeMatchesV1`), so a recommendation computed for another task can never be
  rendered against this one.

## Authority

`authority` is literal `false` on every field (`startsWork`, `assignsWork`,
`grantsExecutionAuthority`), the module imports no store, transport or browser client, and no
server module imports it. Choosing a different machine — including the panel's
"prefer this machine" control, which only moves the existing machine selection — still goes
through the same protected assignment check, the same execution approval and the same local
checks. A recommendation is not a reservation and not permission.

## Browser boundary (explicit limit)

The private assignment surface reads **configured routes only**
(`candidateEvidence: "configured_routes_only"` in `task-assignment-wire.ts`). Route capacity,
fleet signals and historical outcomes for a task are not readable from that surface, so the
browser projection (`evaluateConfiguredRouteRecommendationV1`) reports them as unknown and
declares `capacity_evidence_missing`, `effort_unreported`, `eligibility_incomplete`,
`cost_unreported` and `usage_unreported`. It does not guess them.

Wiring the server-side evidence into the options response is a follow-up packet: it needs
`src/web/v1/task-assignment-wire.ts` and the coordinator, which are outside this package's
`writeScopes`. The module already accepts that evidence (`evaluateAssignmentRecommendationV1`)
and the focused checks drive it with the real fixture signals and outcome rows, so the
follow-up is a transport change, not a new decision surface.

## Checks

```bash
pnpm test                      # build + the vps-built lane, including tests/vps-built-assignment.test.mjs
pnpm check:demo                # tsc --noEmit over the product surface
pnpm test:product-shell        # the private shell lane
node scripts/check-test-lane-coverage.mjs
```

The focused checks cover: canonical eligibility reuse (a current signal yields
`capability_probe_current`; an expired one yields `unavailable` with `telemetry_stale` and
`capability_expired`), unknown evidence staying unknown, effort selection with an
insufficient sample, a tied/conflicting group and an incomparable group, project/task/digest
scoping, the schema round-trip, and the read-only shape (no fetch, no database client, no
write path, no clock of its own, no server importer).