# Finished execution reservations: next implementation inventory

2026-09-05, source `5abdc5b`. Read-only independent inventory with root source checks.
This records the next real continuity gap, not a normative state change or implemented
retirement command. It does not inspect or accept excluded draft PR #329.

## Observed gap

The revised-result fixture executes two distinct jobs and completes only the child.
The original run is natively finished, but its output has changes requested and later
becomes superseded. Its canonical job/attempt/lease are intentionally unchanged.
Assignment counts all active canonical leases until a coordinated transition occurs.
Consequently the original reservation can prevent a follow-up assignment on a full node.
The fixture's explicit capacity three demonstrates lineage, not real capacity turnover.

## Existing operations

- `src/domain/v1/state-machines.ts`: jobs and attempts have no retired/superseded outcome;
  leases support released, expired and revoked. A transition-table edge is not write authority.
- `src/persistence/canonical-store.ts`: uncoordinated attempt/lease transitions and
  non-proposed job transitions are refused. There is no coordinated early retirement API.
- `src/web/v1/task-assignment-coordinator.ts`: owner-authorized expiry requires exact
  assignment lineage and an elapsed deadline; it reports no confirmation of native stop.
  It orphans the attempt and expires the lease, rather than accepting revised output.
- `src/persistence/native-task-completion.ts`: exact terminal native evidence, producer
  lineage, latest lease epoch and ready quality evidence precede coordinated success.
  A changes-requested or superseded target cannot use this operation to free its slot.

## Design work owned by root

Choose a truthful canonical outcome for finished execution whose result is not approved,
with durable evidence and replay semantics. Do not report success or native cancellation
merely to recover capacity. Define the relationship to future owner review and expiry,
new lease epochs, terminal races, assignment receipts and quality discovery.

The ordering matters: a submitted replacement supersedes the original only after child
execution, but capacity is needed before child assignment. Eligibility cannot depend only
on that later replacement if it is intended to unblock a capacity-one node. The durable
successor plan exists earlier; current revision planning expects the original job to be
leased/running. Settle this ordering explicitly before freezing the next implementation.

Reuse authenticated completed run/events, actual submitted bytes and exact target/review
evidence. Preserve distinct native finish, artifact receipt and transition timestamps.
Reuse currentness/precommit fences, versioned writes, audit/outbox and signed replay
patterns; no direct fixture writes or inflated production capacity may substitute for proof.

Required new proof includes a real disposable capacity-limited assignment lifecycle,
unchanged source quality history, no repeated native effect, precise replay and refusals
for unavailable evidence, newer epochs, expiry races and uncertain commit acknowledgements.
Root owns protocol/state/SQL decisions; isolated agents can test the settled contract.

## Settled execution-capacity direction

`CR14C_NATIVE_CAPACITY_RELEASE_CONTRACT.md` separates execution occupancy from result
quality. Verified native completion can release only the current lease while preserving
job, attempt and review evidence. No successor is required for eligibility. This avoids
the earlier ordering loop and lets later review/planning occur after capacity is free.
`CR14C_NATIVE_CAPACITY_RELEASE_ACCEPTANCE.md` tracks implementation and proof; the earlier
inventory remains historical, not a claim that a new terminal job outcome was introduced.
