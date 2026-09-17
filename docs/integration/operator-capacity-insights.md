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
| `workers[]` | `FleetWorkerSummaryV1` rows in the `OperatorSurfaceSnapshotV1` served at `/api/v1/operator-surface` (`src/operator-surfaces/v1/types.ts`, parsed by `parseOperatorSurfaceSnapshotV1`) |
| `workers[].attribution` | The row's own `capacityState`, `availableSlots` and `totalSlots` only — nothing else |
| `workers[].capacity` | The same slots, plus that row's `telemetryState` and `lastObservedAt` |
| `capacity` totals | Sum of `availableSlots` / `totalSlots` over the fleet rows that are both self-reported and fresh; `reportingWorkers` is that row count |
| `excluded.unattributed` / `excluded.notFresh` | The same fleet rows, split by why they are left out of every total |
| `activeWork` | `ActiveWorkProjectionV1.state` over `leased` / `running` / `waiting_approval` |
| `queuePressure` | `BottleneckProjectionV1` rows (`resourceKey`, `utilizationPercent`, `blockedWorkItemIds`, `explanation`) |
| `reviewDelay` | `ActionInboxItemV1` rows with `kind: "review"` and `state: "open"`; `oldestCreatedAt` is the earliest `createdAt` among them |
| `idle` | `FleetWorkerSummaryV1.state === "idle"` observations |
| `modelOutcomes` | Caller-supplied `ReportedModelOutcomeRecordV1` records, validated against the self-reported field rules mirrored from `scripts/public-model-outcomes.mjs` |

The read path is `readOperatorCapacityViewV1`, which reuses
`fetchOperatorSurfaceSnapshotV1` — the browser reader for the server-bound projection.
A failed, refused, unparseable or unfinished read returns `unavailable` with a code
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

## Attribution and freshness are two different questions

The projection keeps them apart, because only one of them is about who a row belongs to:

- **Attribution** is `self_reported` when the row itself carries a usable slot report
  (`capacityState: "reported"` with both slot counts present and `availableSlots <=
  totalSlots`), and `unattributed` otherwise. A row is never counted in a total for a
  worker other than the one that row describes, so a shared account or an interrupted
  session cannot have its numbers folded into another row's total: a row with no report
  of its own contributes nothing and is named in `excluded.unattributed`.
- **Freshness** is the second, separate filter. A self-reported row whose
  `telemetryState` is `stale`, or whose `lastObservedAt` is more than
  `CAPACITY_FRESHNESS_MINUTES_V1` (30) before the snapshot, or which has no observation
  at all, is left out of the totals and named in `excluded.notFresh`. The panel says in
  words that freshness is not an attribution failure.
- The two reason codes are distinct and the panel prints the matching sentence: a
  `stale` telemetry state or an observation older than the window is `observation_stale`
  ("the last observation is older than the freshness window"); a missing observation or
  a `missing` telemetry state is `observation_missing` ("no current observation is
  recorded"); a row with no usable slot report is `not_reported`.

## Rules that keep the numbers honest

- **Oldest only if known for all.** `oldestCreatedAt` is reported only when every open
  review records a parseable `createdAt`. The oldest of a subset is never presented as
  the oldest overall; when it cannot be established the panel says no delay is claimed.
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
mirrored exactly (`REPORTED_EFFORTS_V1`), including `unknown`, which that script treats
as a valid reported effort (`parseReportedModel`, `EFFORTS`). One divergence, in the
stricter direction: the script keeps a record whose effort is outside the vocabulary,
groups it under `unknown` and counts it as an invalid-or-missing report, while this
projection drops that record from the sample count entirely rather than reporting its
model under a guessed effort.

## Not measured here

- No live agent, provider, harness, installation or queue run is exercised by this
  surface: model-outcome evidence is passed in by the caller.
- `idle` and `queuePressure` remain inferences of the projection; they are labelled as
  such and are not load or utilization measurements of a real machine.
- The panel is a private-app component rendered from a view object; the packet's tests
  render it directly and do not claim a live server round trip or a browser run.
- The source projection carries no shared-account or interrupted-session field. The rule
  above is therefore about what the projection counts (only a row's own report), not
  about detecting those conditions in the source.
## Mounted on the Workers page (issue #327)

The existing, unmodified `PrivateOperatorCapacityWorkspace` is mounted
read-only under the connection inventory in
`private-app/app/connections/workspace.tsx`, inside `PrivateConnectionView`.
A single mount point covers both render paths: `PrivateConnections` renders
that view, so `/workers` and `/connections` each show the panel exactly once
— it is deliberately not added to the wrapper separately, which would mount
it twice.

The two reads are independent: the inventory reads through
`readPrivateConnections`, the panel through `readOperatorCapacityViewV1`.
One panel's unavailable state never blocks or hides the other — each renders
its own loading and unavailable branches side by side. The old inventory
sentence claiming capacity data is "unavailable in this view" is corrected to
say that data is not part of the inventory and lives in the panel below,
without overstating it (read-only, evidence-labelled, own unavailable
states). No route, schema, write, or authorization capability was added.
