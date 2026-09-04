# CR13A-LIVE-170 retained-resource handoff acceptance

**Status:** exact effect-free product verified; independent review pending
**Product target/tree:** `7e76e1980541075f9a1fa45479d20f06a823ef29` /
`c432b862e86b3100d524073fcf4b37a9a9cf02cc`
**Design parent:** `922ae645f265c88d04a6ed78fa7fefbc18ced4b7`
**Stacked LIVE-160 base:** `ca36780704a9fe85c0e4c2fbca95cfc9e57e480e`
**Model/effort:** `gpt-5.6-sol`, `xhigh`

## Outcome

The product freezes the physical driver's future same-resource handoff seam as atomic, private, non-serializable, and
single-use. The custody provider must retain the exact operating-system resource until the driver accepts it; the driver
may not create a replacement. Failure or uncertainty requires terminal close, independent zero-resource observation,
and a durable spend/close/tombstone chain without retry, rebind, or reopen.

The repository fake honestly records that no driver handoff port or capability exists and keeps
`driverReservationHandoffGapPresent` plus `exclusivePortCustodyMissing`. No address, port, native resource, private
handle, capability, or physical authority is exposed or created.

## Producer verification

Exact product `7e76e1980541075f9a1fa45479d20f06a823ef29` passed macOS stage zero, TypeScript, lint, 8/8 focused tests,
165/165 connection tests, 182/182 CR13A tests, and the complete registered lifecycle: 769/769 pretests, 419 core
passes plus two established Windows-only skips, and 392/392 posttests. Production build passed all 5 phases; 4/4
rendered routes passed; migrations 0001-0036 verified 119 PostgreSQL tables; whitespace validation passed.

The package-level `npm run db:verify` wrapper could not create the `tsx` CLI's private IPC pipe inside the restricted
sandbox. The repository's deterministic verifier was therefore invoked through the already accepted Node loader as
`node --import tsx scripts/verify-migrations.ts`; it passed all 36 migrations and 119 tables. This was an execution-
environment limitation, not a product or database failure.

Every host observation, port selection/reservation, native-resource creation/retention, handoff issue/spend/call,
native-backend construction, listener/IPC/socket/timer attempt, network observation, protected read, authority grant,
runtime wiring, and external effect remained zero or false.

## Pending review and limits

A different report-only, zero-repair reviewer must run the immutable fixed-command packet, inspect provenance,
privacy, callable, import, issuer, and consumer boundaries, report 0 High/Medium/Low, and reproduce all zero-effect
counts. The product may not change during review.

Even acceptance permits ordinary owner-controlled integration only. It does not modify or invoke the physical driver's
native port, create a custody provider/resource, issue a handoff, clear a blocker, assemble a candidate, make a physical
attempt, activate a runtime, or grant production authority.
