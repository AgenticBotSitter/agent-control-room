# E15 — reuse upstream version checks; qualify drift claims

2026-09-06. Retained E01 pg-boss 12.30.0, schema version 40; local PGlite only.

## Decision

Reuse the existing package startup version check. With `migrate: false`, upstream
`index.js` calls `contractor.check()`, which rejects a missing installation or a
version unequal to its pinned package schema version. Our producer and worker
already use that setting. No duplicate custom version checker was added.

Treat `detectSchemaDrift()` as diagnostic evidence, not a complete fail-closed schema
acceptance gate. `contractor.js` deliberately catches failures of some catalog probes
and can skip function inspection. Its `ok` value does not attest probe completeness.
It also treats extra indexes as informational. Any strict deployment acceptance must
establish complete inspection separately; do not expand operational-role grants just
to run an administrator's diagnostic scan.

## Tests

- Producer preparation rejects versions 39, 41 and an empty version table. Each
  version table remains unchanged; no canonical work is enqueued.
- Owned worker startup rejects the same cases, closes its SQL port once and performs
  no pickup. The queued synthetic job stays created; no migration or retry occurs.
- On a fresh installation the upstream drift report is ok. Injecting a failure of
  the function-definition catalog query still returns ok, proving the documented gap.
- Removing job_common_i11 produces a missing-index report while schemaVersion stays
  40, proving version equality alone is not full integrity evidence.
- 41 combined package checks pass; targeted ESLint and whitespace validation pass.

Initial index-deletion test used job_i11, which belongs to the non-partitioned physical
layout rather than this installation's job_common layout. It failed before deletion.
The test was corrected to the source-confirmed job_common_i11; no product behavior
was changed to hide that fixture error.

## Remaining

Version rejection is now directly proven through both adapters on PGlite. Strict full
schema acceptance, real PostgreSQL validation, worker LOGIN/settings/bootstrap and
browser submission remain. No downloads, runtime installation, service or provider
effects. No custom infrastructure adopted in this block.
