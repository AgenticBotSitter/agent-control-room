# Operator capacity insights

Issue #299 (OPS-014). Projection: `src/web/v1/operator-capacity-browser-client.ts`.
Panel: `private-app/app/operator-capacity-workspace.tsx`.
Tests: `tests/product-configuration-summary.test.tsx` (operator capacity cases).

## What it is

One read-only projection of evidence that already exists, plus one private panel that
renders it. The projection turns a canonical operator surface snapshot into an operator
capacity view (`control-room-operator-capacity-view/v1`) and never invents a figure to
fill a gap. It schedules nothing, reserves nothing, assigns nothing and authorizes
nothing: `boundary` is `{ readOnly: true, canAssign: false, canSchedule: false,
canAuthorize: false }`, and the panel repeats that limit in text.

## Source records (exact)

| View section | Canonical source record |
| --- | --- |
| `workers[]`, `capacity`, `unattributed` | `FleetWorkerSummaryV1` rows in the `OperatorSurfaceSnapshotV1` served at `/api/v1/operator-surface` (`src/operator-surfaces/v1/types.ts`, parsed by `parseOperatorSurfaceSnapshotV1`) |
| `capacity` totals | Sum of the `availableSlots` / `totalSlots` of the fleet rows whose own capacity is attributable; `reportingWorkers` is that row count |
| `activeWork` | `ActiveWorkProjectionV1.state` over `leased` / `running` / `waiting_approval` |
| `queuePressure` | `BottleneckProjectionV1` rows (`resourceKey`, `utilizationPercent`, `blockedWorkItemIds`, `explanation`) |
| `reviewDelay` | `ActionInboxItemV1` rows with `kind: "review"` and `state: "open"`; `oldestCreatedAt` is the earliest `createdAt` among them |
| `idle` | `FleetWorkerSummaryV1.state === "idle"` observations |
| `modelOutcomes` | Caller-supplied `ReportedModelOutcomeRecordV1` records, validated against the self-reported field rules mirrored from `scripts/public-model-outcomes.mjs` |

The read path is `readOperatorCapacityViewV1`, which reuses
`fetchOperatorSurfaceSnapshotV1` — the browser reader for the server-bound projection.
A failed, refused or unparseable read returns `unavailable` with a code
(`authentication_required`, `operator_surface_unavailable`, `invalid_response`,
`request_failed`); no cached, sample or saved view is substituted.

## Evidence classes

Every section carries its class, so a reader can tell a measurement from an estimate:

- `measured` — the source record reports the value.
- `inferred` — derived, with the `basis` printed next to it. Queue pressure is
  `inferred` (utilization is the projection's own estimate over canonical blocked work
  ids, not machine load). Idle is `inferred` (a reported worker state, not measured idle
  minutes).
- `unavailable` — carrying a reason code the panel prints in words: `not_reported`,
  `observation_stale`, `observation_missing`, `source_unavailable`,
  `evidence_not_served`. An unavailable section never renders a zero.

## Rules that keep the numbers honest

- **Freshness.** `CAPACITY_FRESHNESS_MINUTES_V1` is 30. A worker row whose
  `telemetryState` is `missing` is unavailable; `stale`, a missing `lastObservedAt`, or
  an observation older than the window is `observation_stale`. Capacity is never
  carried forward as current.
- **Attribution.** A worker row is only counted in a total when its own row reports its
  own capacity. Shared-account and interrupted-session rows are excluded from every
  total and named in `unattributed` (`count`, `workerIds`); the panel states this in
  text instead of folding them in. A row reporting slots without a reportable capacity
  is refused by the surface's own schema, which is why the projection can treat a
  missing slot count as unavailable.
- **Rates are shares, rounds are raw.** `reworkRate` is the share of counted samples
  that reported at least one rework round; `reworkRounds` is the total rounds reported.
  One sample with three rounds is one reworked sample, never three.
- **Only-when-reported.** Every optional model-outcome field (`reworkCount`, `rejected`,
  `elapsedMinutes`, `inputTokens`, `outputTokens`, `costMicrousd`) is summarized only
  when every counted sample reports it. A field only some samples report is left
  undefined and named in `unreported`; a partial figure is never scaled up to the
  sample count.
- **No winner below the floor.** `COMPARABLE_MINIMUM_V1` is 5 samples. Below it the
  summary still shows the observed fields and says these are observations without a
  winner.
- **No pricing.** Cost is rendered from what a worker reported (`costMicrousd`); nothing
  is priced, looked up or billed, and there is no provider call.

## Deliberate divergence from the public parser

`scripts/public-model-outcomes.mjs` is the canonical public parser for self-reported
model, effort and cost fields, but it is Node-only (it imports `node:url`), so this
browser module mirrors its field rules instead of importing it. The effort vocabulary is
mirrored exactly (`REPORTED_EFFORTS_V1`). One divergence, in the stricter direction: the
Node script groups a record whose effort is outside the vocabulary under `unknown` and
marks it invalid, while this projection drops that record from the sample count entirely
rather than reporting its model under a guessed effort.

## Not measured here

- No live agent, provider, harness, installation or queue run is exercised by this
  surface: model-outcome evidence is passed in by the caller.
- `idle` and `queuePressure` remain inferences of the projection; they are labelled as
  such and are not load or utilization measurements of a real machine.
- The panel is a private-app component rendered from a view object; the packet's tests
  render it directly and do not claim a live server round trip.