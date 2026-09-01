# CR13A-LIVE-020 durable connection registry acceptance

**Status:** accepted implementation candidate `ed5bb96d2a80c6fa98bf68d2a118ed2501a22384`; integration pending
**Effect boundary:** local PostgreSQL-compatible migration and PGlite tests only; no SSH, Hermes, provider, credential, production database, deployment, or network effect

## Delivered boundary

- Migration `0034_cr13a_connection_registry.sql` adds an append-only protected enrollment history with tenant/node foreign
  keys, immutable revisions, a per-tenant digest chain and authenticated stream head, expiry indexing, and
  update/delete/truncate guards.
- `ConnectionRegistryStoreV1` accepts only a previously sanitized signed-enrollment result with an exact
  tenant/node/connection binding. Records carry a keyed authentication tag, payload digest, sequence, and previous-record
  digest. The authenticated head and complete-chain reconstruction detect row mutation or partial deletion. Exact replay
  is inert; changed replay, backwards renewal, duplicate active route/profile identity, cross-scope input, over-capacity
  input, and damaged rows fail closed.
- Registry reconstruction verifies every selected current row before building the existing duplicate- and expiry-safe roster. Protected connection, enrollment, node, route, profile, issuer, host-key, and tenant identities remain server-side.
- `NodeFleetSignalIngress` now emits a server-keyed telemetry receipt only after the signed frame passes node-protocol
  authentication and fleet persistence. `AuthenticatedFleetTelemetryFreshnessSourceV1` reads and verifies that receipt;
  it never reads the mutable fleet-current projection. A timely receipt can produce `current`; expired/future receipts
  are `stale`; no receipt is `missing`. Discovery, capability, benchmark, enrollment, and direct fleet-table rows do not
  imply recency.
- The protected Connection Center reports enrollment, exact runtime compatibility, signal freshness, qualification, and live-panel state as separate facts. A current signal still grants no approval, command, lease, execution, or live-panel authority.
- The repository-fake local pilot now reads its connection inventory from the durable PGlite-backed registry and signal
  state from the keyed receipt store. The default remains honestly empty.

## Security invariants

1. Owner authentication and tenant derivation still precede roster or freshness reads at the HTTP boundary.
2. Raw identifiers required to correlate enrollment with node telemetry never enter the browser projection; the UI receives ordinal presentation references only.
3. Enrollment never proves a recent signal. A recent signal never proves compatibility, qualification, permission, availability, health, or execution eligibility.
4. Only a receipt carrying a valid server HMAC can support `authenticated_telemetry`. Direct fleet-current/history rows,
   a receipt inserted without the server key, browser heartbeat, or caller-provided status fail closed.
5. PGlite remains local-development/test storage only. This block does not contact or configure the private production PostgreSQL primary.

## Rejected review and remediation

The first independent review is preserved unchanged in `reviews/CR13A_LIVE_020_INDEPENDENT_REVIEW.md`. It confirmed one
High false-provenance finding, one Medium behavioral-boundary finding spanning database rows, roster output, and the
public projection parser, and one Low whitespace failure. Passing producer tests did not override that rejection.

The remediation replaces the fleet-current read with the keyed post-authentication receipt, exact-captures database rows,
complete protected rosters, and complete public projections before semantic access, removes the whitespace failure, binds
registry write time to the enrollment's server evaluation time, and rejects chronology regression.

The different independent remediation reviewer closed the High and Medium findings after reproducing the attacks and
running additional receipt, registry, authority, and redaction probes. It rejected immutable target `d858d8e` only because
the exact cumulative `git diff --check` still found four trailing-space lines in the preserved predecessor packet. That
negative report is preserved in `reviews/CR13A_LIVE_020_REMEDIATION_REREVIEW.md`; the four documentation lines are repaired
in the final candidate.

## Verification recorded for the remediation candidate

- TypeScript check passes.
- Focused Connection Center and durable-registry verification passes 15/15; combined CR13A passes 31/31.
- The complete npm lifecycle passes: unchanged 769/769 pretests, 418/420 core tests with two intentional platform skips,
  and 266/266 posttests.
- TypeScript, full lint, macOS stage zero, production build, whitespace validation, and 4/4 rendered routes pass.
- Migrations `0001` through `0034` apply and verify 115 PostgreSQL tables.
- Restart recovery, renewal, exact replay, changed replay, cross-tenant binding, duplicate routes, row mutation/deletion,
  forged fleet-current isolation, forged receipt rejection, signed-ingress receipt creation, behavioral database/roster/
  public-projection rejection, current/stale/missing telemetry, discovery-not-liveness, qualification separation, and
  locator-redaction regressions pass in focused verification.

## Remaining gate

Independent confirmation accepted the exact final candidate. The product tree was identical to the security-reviewed
remediation, both negative reports remained intact, the exact cumulative whitespace command passed, and the focused suite
passed 15/15. The accepted report is `reviews/CR13A_LIVE_020_FINAL_CONFIRMATION.md`, SHA-256
`764813a39fb57944408a3949e4c89a1c9f1d35913f4c0bd28b670c1a6b446b3e`.

Ordinary GitHub CI and owner-approved integration remain. No live enrollment ingestion endpoint, native qualification,
SSH control, provider call, production database composition, or deployment is authorized by this block.
