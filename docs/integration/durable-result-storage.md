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

## Known gap: the neutral reservation PostgreSQL adapter

`src/artifacts/v1/neutral-reservation-postgres.ts` is **not delivered here.** The
harness-neutral publisher persists reservations through `NeutralReservationPort`
(`src/artifacts/v1/neutral-reservation-port.ts`), and the production adapter needs a
dedicated neutral sibling table that does not exist in migrations 0001–0076.

It cannot reuse the native table: `db/migrations/0071_cr15b_native_result_write_reservations.sql`
pins `reservation->>'schema' = 'control-room.native-result-write-reservation/v1'` in a CHECK
constraint, while the neutral publisher writes `control-room.durable-result-write-reservation/v1`.
Both port documents state the native-only constraint is never widened.

Creating the neutral table requires a migration, a role grant and a regenerated migration
ledger — all outside this package's owned paths, and `risk:shared` schema work. Until the
lead-owned migration lands, production composition must inject a reservation port, and the
inventory reader fails closed when neither a native reservation row nor a port is supplied.

Consequently the acceptance property "reconstructing the application over the same
PostgreSQL database and persistent directory returns the same verified receipt without
writing again" is **not** proven for neutral records against a real database. The existing
restart evidence uses the test-only persistent port, which shares process memory across
reconstructions and is not durability.
