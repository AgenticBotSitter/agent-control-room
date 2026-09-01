# CR13A-LIVE-020 independent security and integrity review

**Disposition:** rejected
**Immutable base:** `737d9744c00129882af00094a84eae1f28a5a5a2`
**Immutable target:** `456f4d1f715e583c18f6533075a9d83346a22b95`
**Review mode:** independent report only; no repository repair or external effect

## Blocking findings

### High: unauthenticated database state was presented as authenticated telemetry

`AuthenticatedFleetTelemetryFreshnessSourceV1` read `control_node_fleet_current` and labelled any structurally valid,
timely telemetry row `current` with basis `authenticated_telemetry`. It did not verify corresponding authenticated history,
an ingress receipt, signature, HMAC, or other provenance.

The reviewer inserted a valid telemetry-shaped current row directly, confirmed zero corresponding history rows, and
observed `state: current` with `basis: authenticated_telemetry`. The projection still granted no approval, command, lease,
live-panel, or execution authority, but the block's core authenticated-freshness claim was false. This blocked acceptance.

### Medium: behavioral values executed at protected read boundaries

Source-controlled values were accessed before exact data capture at the database-row, protected-roster-result, and public
projection boundaries. Independent Proxy probes observed 8 database-row traps, 5 roster-result traps, and 18 public-
projection traps. Enrollment value/binding, registry read input, freshness array, and freshness item boundaries correctly
rejected the same class of values without executing traps. This blocked acceptance.

### Low: required diff check failed

`git diff --check 737d9744c00129882af00094a84eae1f28a5a5a2..456f4d1f715e583c18f6533075a9d83346a22b95`
failed on trailing whitespace at line 3 of the acceptance document.

## Successful attacks and checks

The reviewer confirmed fail-closed cross-tenant/node/connection binding, missing-node handling, changed replay, backwards
renewal, duplicate active route/profile, capacity, concurrency, read/write consistency, append-only guards, wrong-key and
row/chain/head tamper detection, partial deletion detection, malformed/stale/future telemetry handling, non-telemetry
separation, authority separation, browser redaction, authentication ordering, GET-only routing, no fixture fallback, and
UI wording. Deleting the complete row stream and its head reconstructed pre-stream state; that remains the explicitly
excluded complete-database-rollback case.

TypeScript, ESLint, focused 13/13 tests, combined 29/29 tests, migrations 0001-0034 with 114 tables, production build, and
4/4 rendered routes passed. Only the required diff check failed. PGlite was the only database exercised; real PostgreSQL
locking, process restart/crash behavior, native enrollment, Hermes, SSH, provider, credential store, deployment, and
external networking were not exercised.

The reviewer removed its temporary probe, made no repository edits, and returned a clean working tree.
