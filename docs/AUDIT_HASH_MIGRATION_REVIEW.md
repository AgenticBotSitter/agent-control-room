# Audit hash completeness correction

## Confirmed defect

Applying all migrations through 0057 to disposable in-memory PGlite allowed a
version-1 audit row with non-null partition/sequence and NULL event_digest,
prev_hash and event_hash. The original trigger's regex comparisons evaluate to
SQL NULL for missing hashes, so the IF condition does not reject the row.
The reproduction inserted and counted one incomplete row; no live data was used.

## Forward-only fix

Migration 0058 adds a validated constraint requiring all three hashes for v1.
Legacy v0 remains unchanged. Existing incomplete v1 history causes the migration
to fail for operator review; it is not repaired, erased or supplied invented hashes.
The existing trigger continues to reject malformed non-null hashes.

The private schema fingerprint was recomputed from all migrated catalog objects:
`5108e1c9aa7f5b09d1f81b75d6f0595f09a0695ab04706d23d33382f2a167c16`.
The new regression is included in the normal private test command.

## Verification

`node --import tsx --test tests/audit-required-hashes.test.mjs tests/audit-config.test.ts tests/web-database-roles.test.ts`
exited 0: 20 tests passed, zero failed/skipped. Tests exercise all seven missing-hash
combinations, complete/v0 positives, malformed hash rejection, fingerprint equality
and refusal of an upgrade over incomplete history without changing that history.
Standalone TypeScript check also exited 0.

Independent read-only reviewer `release_readiness_review` found no concrete defect
in these three files, relative to private base `825fdc4`:

- db/migrations/0058_audit_chain_required_hashes.sql:
  `0d757ee0e751c3ef0f5a71524ce0184a7c9bea581aa46fbd7204de166b3460ac`
- tests/audit-required-hashes.test.mjs:
  `fa2aeafcf9fc351319bf1c04f5008aaffcc322ad6d8ac6f667cf272ce61ef4f2`
- src/web/v1/private-database-preflight.ts:
  `c33b9eb8d26dbfb91c9337d6fa6364b38b5a6b0e991b07ce3b943320b1856804`

The reviewer inspected logic and test coverage, not a real PostgreSQL deployment.
No live database, provider, listener or external account was changed.

## Required before source release

Propagate the migration and regression into the isolated source candidate, add the
test to its selected commands, recompute its distinct generalized-schema fingerprint,
refresh reconstruction/inventory records, and rerun candidate checks. Do not copy
the private schema digest into that differently generalized tree. Until this is done,
the candidate retains the confirmed defect and must not be published as corrected.
Production PostgreSQL rehearsal and deployment remain separately scoped work.
