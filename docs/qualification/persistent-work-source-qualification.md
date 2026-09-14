# Persistent-work source qualification (issue #215)

Source-only, effect-free qualification of the persistent-work boundary. It
checks the already-accepted signing, completion-gate and independent-checkpoint
contracts as one boundary and emits a sanitized machine-readable record per
scenario. It never creates a key, contacts etcd, touches PostgreSQL, restores
data, or claims production qualification.

## Files

- `scripts/qualify-persistent-work-source.ts` — the runner. Exports
  `qualifyPersistentWorkSource(scenario)` (one sanitized record, never throws)
  and `qualifyAllPersistentWorkSources()` (the full suite in order). Run
  directly (`node --import tsx scripts/qualify-persistent-work-source.ts`) it
  prints one JSON record per line.
- `scripts/test-persistent-work-source-qualification.ts` — the focused test
  (`node --import tsx --test scripts/test-persistent-work-source-qualification.ts`).
- This document.

## What the runner consumes (exactly as shipped, read-only)

- Staged completion: `stageCompletionCheckpoint` over the synchronous
  `InMemoryRollbackCheckpointStoreV1` (test-only constructor).
- Production etcd checkpoint code: `createEtcdCompletionCheckpointStoreV1`
  driven by the scripted `securityRecoveryCheckpointPeer` (fault injection:
  `lost_ack`, `timeout`), plus `parseEtcdCheckpointRecord` and
  `parseEtcdCheckpointAdvanceReceipt` directly.
- Signing boundary: `createBoundedOwnerSignature` with a scripted
  `OwnerSigningProtocol` channel. No key material exists in this package,
  public or private: the mismatched identity cannot parse as a key, so
  construction itself refuses before the channel is reached.
- Artifact restore: `createArtifactBackupInventoryV1` builds the fabricated
  anchor inventory; `verifyRestoredArtifactBackupInventoryV1` compares.
- Sanitization: every record passes through `redactSecrets` and
  `assertNoSecretMaterial` before it is returned.

## Scenarios

| Scenario | Expected record |
|---|---|
| `valid-staged-completion` | `pass`: staged rev1→rev2, flushed, observed, restore bundle matches |
| `database-first-split` | `blocked`: database claims a digest the anchor never staged; anchor untouched, 0 advances |
| `checkpoint-first-split` | `blocked`: checkpoint moved out of band; staged stale claim refused |
| `lost-acknowledgement` | `blocked`: 1 transaction, remote write committed, outcome uncertain — not completion, no retry |
| `checkpoint-write-timeout` | `blocked`: 1 transaction, uncertain — not completion, no retry |
| `stale-checkpoint-rollback` | `blocked`: replay of a superseded digest refused, anchor stays at rev2 |
| `checkpoint-advance-contract-guards` | `pass`: positive record parse plus 3 negative guards (wrong cluster, bad receipt, wrong scope) |
| `revoked-or-mismatched-signer` | `blocked`: identity rejected, `signatureProduced: false` |
| `incomplete-artifact-restore` | `blocked`: mutated entry digest mismatch, both digests named |
| `wrong-database-restore-identity` | `blocked`: database digest mismatch against the fabricated anchor |
| `missing-restore-evidence` | `blocked`: `missing-database-restore-evidence:missing-artifact-restore-evidence`, `fabricatedPass: false` |

Every record carries `workApproved: false` — including the two `pass` records,
which qualify the source boundary only and grant no execution authority. Exact
replay of the full suite is byte-identical (no clock or randomness reads).

## The restore-evidence gate

The database restore identity from #63 is not shipped at this base
(`deploy/postgres/restore-identity.mjs` does not exist), so the fabricated
anchor digest stands in for it. `requireRestoreEvidence` accepts only a bundle
whose database digest equals the anchor and whose artifact inventory verifies
exactly; anything missing or mismatched is a named `blocked` reason. When the
real #63/#65 evidence lands, the authorized Linux qualification replaces the
fabricated anchor — the gate logic (exact match or bounded block) is unchanged.

## Effect-freedom

The test statically proves the runner imports only ten allowlisted modules and
contains no network, subprocess, credential, filesystem, database, clock, or
randomness surface. The one subtlety found during development: `structuredClone`
demotes `Buffer` to `Uint8Array`, which fails `Buffer.isBuffer` schema checks —
the runner passes freshly built wire values directly instead of cloning them.

## Checks

- `node --import tsx --test scripts/test-persistent-work-source-qualification.ts`
- `pnpm test:owner-signing`
- `pnpm test:checkpoints`
- `pnpm check:demo` (`tsc --noEmit`)
