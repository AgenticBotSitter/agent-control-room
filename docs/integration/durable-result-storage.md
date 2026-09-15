# Durable protected result storage

This describes the operator-configuration contract for durable result bytes and records
what is and is not proven. It complements
[persistent artifact storage composition](persistent-artifact-storage.md), which covers how
the opened adapter is bound across the task services; it does not restate that wiring and
introduces no second filesystem implementation or object-storage service.

## Operator configuration

`src/config/v1/artifact-storage.ts` owns the single place where an untrusted operator file
becomes captured storage configuration. `captureArtifactStorageConfigurationV1(settings, release)`
returns the frozen `{ local, inventory }` value the private task startup already accepts.

The settings name one explicit persistent directory plus the bounded object, file-byte,
total-byte and operation-deadline limits. `captureArtifactStorageSettingsV1` refuses, by
named reason:

| Reason | Refused input |
| --- | --- |
| `artifact_storage_r2_unsupported` | `storageClass: "r2"` |
| `artifact_storage_class_unsupported` | any other storage class |
| `artifact_storage_root_not_canonical` | a relative, traversing, trailing-separator or duplicated-separator path |
| `artifact_storage_root_not_owned` | `/` as the root |
| `artifact_storage_root_invalid` | an empty, oversized, NUL- or newline-bearing path |
| `artifact_storage_total_below_file` | a total smaller than one file |
| `artifact_storage_settings_invalid` | any unknown key, missing field or out-of-range bound |

Two properties are deliberate.

**The path is checked, never repaired.** `resolve()` is used only to detect a
non-canonical path. A configuration that would need repair is refused, so the operator's
recorded intent and the directory actually opened can never differ.

**The namespace digest is always derived.** `artifactStorageNamespaceDigestV1(storageNamespace, rootPath)`
binds the public namespace to one canonical path without returning or publishing that path.
Callers cannot supply a digest — it is an unknown key and is refused — so a stale or forged
digest cannot bind a namespace to a different directory.

`exportArtifactStorageSettingsV1` produces the portable, non-secret form. It carries the
namespace and its digest and deliberately omits `rootPath`: the private host directory is
deployment data, not public product content.

## Storage class

Local persistent filesystem storage is the first public-release mode. R2/S3-compatible
storage is **not supported** and must not be advertised as such. The refusal above is
explicit rather than incidental so that an operator cannot turn on object storage before a
separately tested bounded adapter exists with its own read-after-write verification,
bounded calls and uncertainty rules.

## What the startup boundary now enforces

`capturePrivateArtifactStorageConfigurationV1` delegates the directory and bounds to the
same contract. This is a deliberate tightening of an existing boundary: a non-canonical
root and a total-below-one-file configuration were previously accepted at capture and
surfaced later as an opaque storage error at the first write, or not at all when a storage
port was injected. They now fail closed at configuration capture.

The byte store's own protections are unchanged and remain owned by
`PersistentLocalArtifactStorageV1`: canonical root resolution, `O_EXCL | O_NOFOLLOW`
creation, symlink and traversal refusal, private-mode checks, per-file and total quotas,
the bounded operation deadline and cancellation.

## Evidence

`pnpm test:results` covers the contract above alongside the existing durable-publication,
restart and inventory suites. The added cases prove digest derivation and the refusal of a
supplied digest, every refusal reason in the table, that the smallest usable store (total
equal to file size) is accepted, that the portable export contains no private path, and
that the startup boundary applies the same rules.

All of this is **source-tested with disposable data**. It is not a production, physical
restart, or live backup claim.

## The neutral reservation PostgreSQL adapter

`src/artifacts/v1/neutral-reservation-postgres.ts` implements `NeutralReservationPort`
against `control_durable_result_write_reservations` from the lead-owned migration 0077.
That table is a **sibling** of the native-only table from 0071, not a replacement: 0071's
CHECK pins `control-room.native-result-write-reservation/v1` while the neutral publisher
writes `control-room.durable-result-write-reservation/v1`, and neither that constraint nor
its role boundary is widened here.

The port stays opaque. The adapter holds no key, interprets no reservation body, and leaves
HMAC tags, state transitions and mirror verification in the publisher.

| Method | Behavior |
| --- | --- |
| `findForUpdate` | `SELECT … FOR UPDATE`, which is how a caller transaction serializes against a concurrent writer. The lock clause is asserted at the statement level only — PGlite is single-connection, so no test here observes a real lock |
| `insertFresh` | `ON CONFLICT DO NOTHING`; reports `conflict` for a collision on the primary key `(tenant_id, run_id)` **or** on `UNIQUE (tenant_id, artifact_id)` |
| `compareAndSwap` | Conditional UPDATE matching stored `state` **and** `contract_digest`; reports `false` and changes nothing otherwise |

Two choices are deliberate.

**`ON CONFLICT DO NOTHING` rather than catching a unique violation.** A raised `23505`
aborts the caller's transaction, which would turn an ordinary replay into an unrecoverable
failure. The conflict is reported as a value instead.

**`created_at` and every identity column are absent from `SET`.** The stored creation
instant is preserved and identity is immutable. This matches the port contract, matches the
five columns the evidence role is granted `UPDATE` on, and is independently enforced by the
table's own `guard_durable_result_write_reservation_update()` trigger — the tests exercise
that trigger rather than trusting the adapter alone.

`QueryResult` exposes only `rows`, so both mutations use `RETURNING` to observe whether
exactly one row was affected.

### What the adapter evidence proves

Against a real PostgreSQL database with all 77 migrations applied (PGlite, disposable):
the reservation lands in the neutral table and the native table stays empty; a
**reconstructed publisher with a brand-new port instance over the same database returns the
identical verified receipt and performs no second byte write**; both uniqueness collisions
report `conflict` and leave the surrounding transaction usable; a stale `state` or a stale
`contract_digest` changes nothing; the database trigger refuses an illegal backwards
transition; and `created_at` survives a legal swap.

This satisfies the acceptance property "reconstructing the application over the same
PostgreSQL database and persistent directory returns the same verified receipt without
writing again" for neutral records.

It remains **disposable-database evidence**. It is not a production deployment, a physical
process or host restart, or a live backup and restore claim.
