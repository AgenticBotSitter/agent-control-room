# Persistent-work source qualification (issue #215)

Source-only, effect-free qualification of the persistent-work boundary. It
checks the already-accepted signing, completion-gate and independent-checkpoint
contracts as one boundary and emits a sanitized machine-readable record per
scenario. It never creates a key, contacts etcd, touches PostgreSQL, restores
data, or claims production qualification.

## Files

- `scripts/qualify-persistent-work-source.ts` — the runner. Exports
  `qualifyPersistentWorkSource(scenario)` (one sanitized record, never throws),
  `qualifyAllPersistentWorkSources()` (the full suite in order), and
  `summarizeQualification(records)` (the aggregate disposition, always
  `blocked` in this package — see below). Run directly
  (`node --import tsx scripts/qualify-persistent-work-source.ts`) it prints
  one JSON record per line plus the final disposition line.
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
- Signing boundary: `createBoundedOwnerSignature` with scripted
  `OwnerSigningProtocol` channels. Two static public fixtures minted once
  offline (keypair destroyed at mint): a well-formed ed25519 SPKI and the one
  signature over the exact canonical completion bytes — project/cluster
  scope, staged and completed checkpoint digests, completed revision,
  database restore identity and artifact-set identity in fixed-key-order
  JSON (`completionSignBytes`). Neither fixture is key material. The valid
  channel releases the minted signature for those exact bytes only; the
  revoked channel refuses everything. The valid staged-completion journey
  builds the canonical bytes from its live staged evidence and signs them;
  the tamper scenario alters each of the six bound fields in turn and proves
  no signature is obtainable for any altered variant.
- Artifact restore: `createArtifactBackupInventoryV1` builds the fabricated
  anchor inventory; `verifyRestoredArtifactBackupInventoryV1` compares.
- Sanitization: every record passes through `redactSecrets` and
  `assertNoSecretMaterial` before it is returned.

## Scenarios

| Scenario | Expected record |
|---|---|
| `valid-staged-completion` | `pass` (synthetic): staged rev1→rev2, flushed, observed, restore bundle matches, canonical completion evidence signed (64-byte signature) |
| `database-first-split` | `blocked`: database claims a digest the anchor never staged; anchor untouched, 0 advances |
| `checkpoint-first-split` | `blocked`: checkpoint moved out of band; staged stale claim refused |
| `lost-acknowledgement` | `blocked`: 1 transaction, remote write committed, outcome uncertain — not completion, no retry |
| `checkpoint-write-timeout` | `blocked`: 1 transaction, uncertain — not completion, no retry |
| `stale-checkpoint-rollback` | `blocked`: replay of a superseded digest refused, anchor stays at rev2 |
| `checkpoint-advance-contract-guards` | `pass` (synthetic): positive record parse plus 3 negative guards (wrong cluster, bad receipt, wrong scope) |
| `revoked-or-mismatched-signer` | `blocked`: malformed identity rejected at construction AND valid-shape SPKI refused at the revoked channel, `signatureProduced: false` |
| `valid-signing-path` | `pass` (synthetic): well-formed SPKI reaches the valid channel, minted signature verifies inside the production signer |
| `tampered-completion-evidence-refused` | `pass` (synthetic): each of the six bound identities altered in turn, every altered variant refused a signature |
| `incomplete-artifact-restore` | `blocked`: mutated entry digest mismatch, both digests named |
| `wrong-database-restore-identity` | `blocked`: database digest mismatch against the fabricated anchor |
| `missing-restore-evidence` | `blocked`: `missing-database-restore-evidence:missing-artifact-restore-evidence`, `fabricatedPass: false` |

Every record carries `workApproved: false`. The four `pass` records carry
`syntheticInput: true`: they prove internal logic on fabricated inputs only
and never become acceptance evidence.

## Aggregate disposition

`summarizeQualification` reduces a full suite to one disposition, always
`blocked` with reason
`missing-real-restore-evidence:synthetic-passes-are-internal-logic-only`. Real
#63/#65 restore identities cannot be supplied inside an effect-free package,
so the boundary stays unaccepted no matter how many synthetic scenarios pass.
Exact replay of the full suite is byte-identical (no clock or randomness reads).

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
