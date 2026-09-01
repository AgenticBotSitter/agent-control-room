# CR13A-LIVE-020 durable connection registry acceptance

**Status:** implementation candidate complete; independent security/integrity review required  
**Effect boundary:** local PostgreSQL-compatible migration and PGlite tests only; no SSH, Hermes, provider, credential, production database, deployment, or network effect

## Delivered boundary

- Migration `0034_cr13a_connection_registry.sql` adds an append-only protected enrollment history with tenant/node foreign keys, immutable revisions, expiry indexing, and update/delete/truncate guards.
- `ConnectionRegistryStoreV1` accepts only a previously sanitized signed-enrollment result with an exact tenant/node/connection binding. Records carry a keyed authentication tag and payload digest. Exact replay is inert; changed replay, backwards renewal, duplicate active route/profile identity, cross-scope input, over-capacity input, and damaged rows fail closed.
- Registry reconstruction verifies every selected current row before building the existing duplicate- and expiry-safe roster. Protected connection, enrollment, node, route, profile, issuer, host-key, and tenant identities remain server-side.
- `AuthenticatedFleetTelemetryFreshnessSourceV1` composes the existing authenticated fleet-signal store. Only the five-minute telemetry contract can produce a `current` result. Expired or future telemetry is `stale`; missing telemetry is `missing`. Discovery, capability, and benchmark records do not imply recency.
- The protected Connection Center reports enrollment, exact runtime compatibility, signal freshness, qualification, and live-panel state as separate facts. A current signal still grants no approval, command, lease, execution, or live-panel authority.
- The repository-fake local pilot now reads its connection inventory from the durable PGlite-backed registry and its signal state from the fleet store. The default remains honestly empty.

## Security invariants

1. Owner authentication and tenant derivation still precede roster or freshness reads at the HTTP boundary.
2. Raw identifiers required to correlate enrollment with node telemetry never enter the browser projection; the UI receives ordinal presentation references only.
3. Enrollment never proves a recent signal. A recent signal never proves compatibility, qualification, permission, availability, health, or execution eligibility.
4. Telemetry reaches the freshness source only through the persistence API reserved for authenticated node ingress. No browser heartbeat or caller-provided status is trusted.
5. PGlite remains local-development/test storage only. This block does not contact or configure the private production PostgreSQL primary.

## Verification recorded before review

- TypeScript check passes.
- Focused Connection Center and durable-registry suite passes 13/13.
- Combined CR13A suite passes 29/29.
- Complete npm lifecycle passes: 769/769 pretests, 418/420 core tests with the two intentional platform skips, and
  264/264 posttests.
- Full lint, macOS stage zero, production build, and 4/4 rendered-route checks pass.
- Migrations `0001` through `0034` apply and verify 113 PostgreSQL tables.
- Restart recovery, renewal, exact replay, changed replay, cross-tenant binding, duplicate routes, row tampering,
  behavioral freshness rejection, current/stale/missing telemetry, discovery-not-liveness, qualification separation, and
  locator-redaction regressions pass.

## Remaining gate

A different independent reviewer must inspect the exact frozen candidate and attempt to break persistence integrity,
tenant/node binding, authentication ordering, telemetry provenance/freshness semantics, and browser redaction. Passing producer
tests is not acceptance. No live enrollment ingestion endpoint, native qualification, SSH control, provider call, production
database composition, or deployment is authorized by this block.
