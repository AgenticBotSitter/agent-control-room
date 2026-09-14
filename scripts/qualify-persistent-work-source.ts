/**
 * Persistent-work source qualification runner (issue #215).
 *
 * One deterministic, effect-free qualification pass over the already-accepted
 * signing, completion-gate and independent-checkpoint contracts as a single
 * persistent-work boundary. Each scenario builds disposable in-memory or
 * scripted adapters, drives only production validation/parsing/compare code,
 * and returns a sanitized machine-readable record. A record is either
 * `pass` (the boundary held for fabricated-but-consistent inputs) or
 * `blocked` (the exact missing or mismatched input is named). No failure
 * path approves work, rewrites history, advances a checkpoint twice, or
 * treats uncertainty as completion.
 *
 * Effect-freedom rules for this file (proven statically by the sibling test):
 * no network, no subprocess, no credential or key material of any kind
 * (public or private), no filesystem access, no database connection, no
 * clock or randomness reads (exact replay must be byte-identical). Fabricated
 * digests via sha256Digest over fixed labels only.
 */

import { stageCompletionCheckpoint } from "../src/completion-gate/v1/staged-checkpoint";
import { createEtcdCompletionCheckpointStoreV1 } from "../src/completion-gate/v1/etcd-checkpoint-store";
import { parseEtcdCheckpointRecord } from "../src/completion-gate/v1/etcd-checkpoint-record";
import { parseEtcdCheckpointAdvanceReceipt } from "../src/completion-gate/v1/etcd-checkpoint-advance";
import {
  InMemoryRollbackCheckpointStoreV1,
  rollbackCheckpointDigestV1,
  type RollbackCheckpointV1,
} from "../src/security/rollback-checkpoint";
import { redactSecrets, assertNoSecretMaterial } from "../src/security/redaction";
import { sha256Digest } from "../src/security/digest";
import {
  createBoundedOwnerSignature,
  type OwnerSigningProtocol,
} from "../src/harness/v1/bounded-owner-signature";
import {
  createArtifactBackupInventoryV1,
  verifyRestoredArtifactBackupInventoryV1,
} from "../src/artifacts/v1/artifact-backup-inventory";
import {
  securityRecoveryCheckpointPeer,
  syntheticArtifactInventory,
} from "../tests/helpers/security-recovery-fault-matrix";

export const QUALIFICATION_SCHEMA_V1 = "control-room.persistent-work-source-qualification/v1" as const;

export type QualificationVerdict = "pass" | "blocked";

export interface SourceQualificationRecord {
  schema: typeof QUALIFICATION_SCHEMA_V1;
  case: string;
  verdict: QualificationVerdict;
  reason: string;
  evidence: Record<string, string | number | boolean>;
  redactedPaths: string[];
}

export interface SourceRestoreEvidenceBundle {
  databaseRestoreDigest?: unknown;
  artifactInventory?: unknown;
}

export const SCENARIO_NAMES = [
  "valid-staged-completion",
  "database-first-split",
  "checkpoint-first-split",
  "lost-acknowledgement",
  "checkpoint-write-timeout",
  "stale-checkpoint-rollback",
  "checkpoint-advance-contract-guards",
  "revoked-or-mismatched-signer",
  "incomplete-artifact-restore",
  "wrong-database-restore-identity",
  "missing-restore-evidence",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

const TENANT_ID = "synthetic-qualifier";
const SCOPE = `completion-gate:${TENANT_ID}`;

/** Fabricated anchor only. The real database restore identity is owner-authorized
 * work under #63 and does not exist in this effect-free package. */
const ANCHOR_DATABASE_RESTORE_DIGEST = sha256Digest("persistent-work-source:database-restore:anchor");

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

class QualificationBlocked extends Error {
  constructor(reason: string) {
    super(`source-qualification blocked: ${reason}`);
    this.name = "QualificationBlocked";
  }
}

const blocked = (reason: string): never => {
  throw new QualificationBlocked(reason);
};

function checkpointAt(revision: number, recordCount: number, label: string): RollbackCheckpointV1 {
  return {
    schema: "control-room-rollback-checkpoint/v1",
    scope: SCOPE,
    revision,
    recordCount,
    stateDigest: sha256Digest(`persistent-work-source:state:${label}`),
    stateAuthTag: `hmac-sha256:${sha256Digest(`persistent-work-source:tag:${label}`).slice("sha256:".length)}`,
  };
}

function anchorInventory() {
  return syntheticArtifactInventory();
}

/** The combined restore gate. Missing or mismatched #63/#65 evidence is a
 * bounded blocked state, never a fabricated pass. */
function requireRestoreEvidence(bundle: unknown): { artifactDigest: string } {
  if (!bundle || typeof bundle !== "object") {
    return blocked("missing-database-restore-evidence:missing-artifact-restore-evidence");
  }
  const { databaseRestoreDigest, artifactInventory } = bundle as SourceRestoreEvidenceBundle;
  if (typeof databaseRestoreDigest !== "string" || !DIGEST_PATTERN.test(databaseRestoreDigest)) {
    return blocked("missing-database-restore-evidence");
  }
  if (databaseRestoreDigest !== ANCHOR_DATABASE_RESTORE_DIGEST) {
    return blocked("wrong-database-restore-identity");
  }
  try {
    const verified = verifyRestoredArtifactBackupInventoryV1({
      expected: anchorInventory(),
      restored: artifactInventory,
    });
    return { artifactDigest: verified.verificationDigest };
  } catch {
    return blocked("incomplete-artifact-restore");
  }
}

function completeEvidenceBundle(): SourceRestoreEvidenceBundle {
  return {
    databaseRestoreDigest: ANCHOR_DATABASE_RESTORE_DIGEST,
    artifactInventory: structuredClone(anchorInventory()),
  };
}

function validStagedCompletion(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  const anchor = checkpointAt(1, 0, "anchor");
  const anchorDigest = rollbackCheckpointDigestV1(anchor);
  const store = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  store.initialize(anchor);
  const staged = stageCompletionCheckpoint(store, TENANT_ID);
  const completed = checkpointAt(2, 1, "completed");
  const completedDigest = rollbackCheckpointDigestV1(completed);
  staged.checkpoints.advance(anchorDigest, completed);
  staged.flush();
  const observed = store.read(SCOPE);
  if (!observed || observed.revision !== 2 || rollbackCheckpointDigestV1(observed) !== completedDigest) {
    return blocked("staged-completion-not-observable");
  }
  const { artifactDigest } = requireRestoreEvidence(completeEvidenceBundle());
  return {
    case: "valid-staged-completion",
    verdict: "pass",
    reason: "staged-completion-verified",
    evidence: {
      anchorRevision: 1,
      completedRevision: 2,
      anchorDigest,
      completedDigest,
      databaseRestoreDigest: ANCHOR_DATABASE_RESTORE_DIGEST,
      artifactDigest,
      checkpointAdvances: 1,
      workApproved: false,
    },
  };
}

function databaseFirstSplit(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  const anchor = checkpointAt(1, 0, "anchor");
  const anchorDigest = rollbackCheckpointDigestV1(anchor);
  const store = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  store.initialize(anchor);
  const staged = stageCompletionCheckpoint(store, TENANT_ID);
  // The database side claims a completion the checkpoint anchor never staged.
  const forked = checkpointAt(2, 1, "database-first-fork");
  try {
    staged.checkpoints.advance(rollbackCheckpointDigestV1(forked), forked);
  } catch {
    const observed = store.read(SCOPE);
    if (observed && rollbackCheckpointDigestV1(observed) === anchorDigest) {
      return {
        case: "database-first-split",
        verdict: "blocked",
        reason: "completion-checkpoint-split:database-first",
        evidence: { anchorRevision: 1, anchorDigest, checkpointAdvances: 0, workApproved: false },
      };
    }
  }
  return blocked("split-accepted-database-first-completion");
}

function checkpointFirstSplit(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  const anchor = checkpointAt(1, 0, "anchor");
  const anchorDigest = rollbackCheckpointDigestV1(anchor);
  const store = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  store.initialize(anchor);
  const staged = stageCompletionCheckpoint(store, TENANT_ID);
  // The checkpoint moved first, out of band; the staged database view is stale.
  const moved = checkpointAt(2, 1, "checkpoint-first-move");
  store.advance(anchorDigest, moved);
  const staleClaim = checkpointAt(2, 1, "checkpoint-first-stale");
  try {
    staged.checkpoints.advance(anchorDigest, staleClaim);
    staged.flush();
  } catch {
    return {
      case: "checkpoint-first-split",
      verdict: "blocked",
      reason: "completion-checkpoint-split:checkpoint-first",
      evidence: {
        anchorDigest,
        movedDigest: rollbackCheckpointDigestV1(moved),
        checkpointAdvances: 1,
        workApproved: false,
      },
    };
  }
  return blocked("split-accepted-checkpoint-first-completion");
}

async function lostAcknowledgement(): Promise<Omit<SourceQualificationRecord, "schema" | "redactedPaths">> {
  const anchor = checkpointAt(1, 0, "anchor");
  const anchorDigest = rollbackCheckpointDigestV1(anchor);
  const peer = securityRecoveryCheckpointPeer({ ...anchor, scope: SCOPE });
  const store = peer.open();
  const current = await store.read(SCOPE);
  if (!current || rollbackCheckpointDigestV1(current) !== anchorDigest) {
    return blocked("lost-acknowledgement-fixture-unreadable");
  }
  peer.setWriteFault("lost_ack");
  try {
    await store.advance(anchorDigest, checkpointAt(2, 1, "completed"));
  } catch {
    const stats = peer.stats();
    // The write committed remotely but the acknowledgement was lost: the
    // outcome is uncertain, so it must not count as completion, and no
    // second advance may be attempted to "repair" it.
    return {
      case: "lost-acknowledgement",
      verdict: "blocked",
      reason: "lost-checkpoint-acknowledgement",
      evidence: {
        anchorDigest,
        transactions: stats.transactions,
        committedWrites: stats.committedWrites,
        treatedAsCompletion: false,
        workApproved: false,
      },
    };
  }
  return blocked("lost-acknowledgement-treated-as-completion");
}

async function checkpointWriteTimeout(): Promise<Omit<SourceQualificationRecord, "schema" | "redactedPaths">> {
  const anchor = checkpointAt(1, 0, "anchor");
  const anchorDigest = rollbackCheckpointDigestV1(anchor);
  const peer = securityRecoveryCheckpointPeer({ ...anchor, scope: SCOPE });
  const store = peer.open();
  peer.setWriteFault("timeout");
  try {
    await store.advance(anchorDigest, checkpointAt(2, 1, "completed"));
  } catch {
    const stats = peer.stats();
    return {
      case: "checkpoint-write-timeout",
      verdict: "blocked",
      reason: "checkpoint-write-timeout-uncertain",
      evidence: {
        anchorDigest,
        transactions: stats.transactions,
        committedWrites: stats.committedWrites,
        treatedAsCompletion: false,
        workApproved: false,
      },
    };
  }
  return blocked("timed-out-advance-treated-as-completion");
}

function staleCheckpointRollback(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  const anchor = checkpointAt(1, 0, "anchor");
  const anchorDigest = rollbackCheckpointDigestV1(anchor);
  const store = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  store.initialize(anchor);
  const second = checkpointAt(2, 1, "second");
  const secondDigest = rollbackCheckpointDigestV1(second);
  store.advance(anchorDigest, second);
  // A stale presenter replays the superseded anchor digest: rollback attempt.
  try {
    store.advance(anchorDigest, checkpointAt(3, 2, "rollback-replay"));
  } catch {
    const observed = store.read(SCOPE);
    if (observed && rollbackCheckpointDigestV1(observed) === secondDigest) {
      return {
        case: "stale-checkpoint-rollback",
        verdict: "blocked",
        reason: "stale-checkpoint-rollback-refused",
        evidence: { anchorRevision: 2, anchorDigest: secondDigest, workApproved: false },
      };
    }
  }
  return blocked("stale-checkpoint-advance-accepted");
}

function checkpointAdvanceContractGuards(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  const anchor = checkpointAt(1, 0, "anchor");
  const key = Buffer.from("persistent-work-source/checkpoint");
  const binding = { clusterId: "17", createRevision: "1", key, scope: SCOPE };
  const value = Buffer.from(JSON.stringify({ ...anchor, scope: SCOPE }));
  const response = {
    header: { cluster_id: "17", revision: "1" },
    count: "1" as const,
    more: false as const,
    kvs: [{
      key: Buffer.from(key),
      value,
      create_revision: "1",
      mod_revision: "1",
      version: "1",
      lease: "0" as const,
    }],
  };
  const parsed = parseEtcdCheckpointRecord(response, { ...binding, key: Buffer.from(key) });
  if (rollbackCheckpointDigestV1(parsed.checkpoint) !== rollbackCheckpointDigestV1({ ...anchor, scope: SCOPE })) {
    return blocked("checkpoint-record-positive-parse-mismatch");
  }
  let guards = 0;
  try {
    parseEtcdCheckpointRecord({ header: { cluster_id: "18", revision: "1" }, count: "1", more: false, kvs: [] }, binding);
  } catch { guards += 1; }
  try {
    parseEtcdCheckpointAdvanceReceipt({ unexpected: true }, "17", "1");
  } catch { guards += 1; }
  try {
    createEtcdCompletionCheckpointStoreV1({
      binding: { ...binding, scope: "unrelated-scope" },
      timeoutMs: 40,
      range: (_request, _deadline, callback) => {
        callback(new Error("scripted range must not dispatch"));
        return { cancel() {} };
      },
      txn: (_request, _deadline, callback) => {
        callback(new Error("scripted txn must not dispatch"));
        return { cancel() {} };
      },
    });
  } catch { guards += 1; }
  if (guards !== 3) return blocked("checkpoint-contract-guard-bypassed");
  return {
    case: "checkpoint-advance-contract-guards",
    verdict: "pass",
    reason: "checkpoint-contracts-hold",
    evidence: {
      positiveRecordRevision: parsed.checkpoint.revision,
      modRevision: parsed.modRevision,
      guardsHeld: guards,
      workApproved: false,
    },
  };
}

function revokedOrMismatchedSigner(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  // No key material exists in this package, public or private: the mismatched
  // identity below cannot parse as a key, so construction itself must refuse.
  // The scripted channel additionally models a revoked signer; it is never
  // reached because the identity gate fires first.
  const revokedChannel: OwnerSigningProtocol = Object.freeze({
    on() { return {}; },
    off() { return {}; },
    sign(_key: Buffer, _bytes: Buffer, callback: (error: unknown) => void) {
      callback(new Error("scripted signer revoked"));
      return {};
    },
  });
  try {
    createBoundedOwnerSignature({
      protocol: revokedChannel,
      close() {},
      publicKeySpki: "mismatched-signer-identity",
      timeoutMs: 100,
    });
  } catch {
    return {
      case: "revoked-or-mismatched-signer",
      verdict: "blocked",
      reason: "signer-identity-rejected",
      evidence: { signatureProduced: false, workApproved: false },
    };
  }
  return blocked("mismatched-signer-identity-accepted");
}

function incompleteArtifactRestore(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  const expected = anchorInventory();
  const restored = structuredClone(expected);
  const entries = restored.entries as Array<{ contentHash: string }>;
  entries[0] = { ...entries[0], contentHash: sha256Digest("persistent-work-source:artifact:mutated") };
  const mutated = createArtifactBackupInventoryV1({
    tenantId: restored.tenantId,
    releaseId: restored.releaseId,
    releaseDigest: restored.releaseDigest,
    databaseSchemaVersion: restored.databaseSchemaVersion,
    databaseSchemaDigest: restored.databaseSchemaDigest,
    storageNamespace: restored.storageNamespace,
    storageNamespaceDigest: restored.storageNamespaceDigest,
    entries,
  });
  try {
    verifyRestoredArtifactBackupInventoryV1({ expected, restored: mutated });
  } catch {
    return {
      case: "incomplete-artifact-restore",
      verdict: "blocked",
      reason: "incomplete-artifact-restore",
      evidence: {
        expectedDigest: expected.inventoryDigest,
        restoredDigest: mutated.inventoryDigest,
        entryCount: mutated.entryCount,
        workApproved: false,
      },
    };
  }
  return blocked("mutated-artifact-inventory-accepted");
}

function wrongDatabaseRestoreIdentity(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  try {
    requireRestoreEvidence({
      databaseRestoreDigest: sha256Digest("persistent-work-source:database-restore:wrong"),
      artifactInventory: structuredClone(anchorInventory()),
    });
  } catch (error) {
    if (error instanceof QualificationBlocked && error.message.includes("wrong-database-restore-identity")) {
      return {
        case: "wrong-database-restore-identity",
        verdict: "blocked",
        reason: "wrong-database-restore-identity",
        evidence: { anchorDigest: ANCHOR_DATABASE_RESTORE_DIGEST, workApproved: false },
      };
    }
    throw error;
  }
  return blocked("wrong-database-restore-identity-accepted");
}

function missingRestoreEvidence(): Omit<SourceQualificationRecord, "schema" | "redactedPaths"> {
  try {
    requireRestoreEvidence(undefined);
  } catch (error) {
    if (
      error instanceof QualificationBlocked
      && error.message.includes("missing-database-restore-evidence")
      && error.message.includes("missing-artifact-restore-evidence")
    ) {
      return {
        case: "missing-restore-evidence",
        verdict: "blocked",
        reason: "missing-database-restore-evidence:missing-artifact-restore-evidence",
        evidence: { fabricatedPass: false, workApproved: false },
      };
    }
    throw error;
  }
  return blocked("missing-restore-evidence-accepted");
}

function emitRecord(result: Omit<SourceQualificationRecord, "schema" | "redactedPaths">): SourceQualificationRecord {
  const record: SourceQualificationRecord = {
    schema: QUALIFICATION_SCHEMA_V1,
    case: result.case,
    verdict: result.verdict,
    reason: result.reason,
    evidence: result.evidence,
    redactedPaths: [],
  };
  const { value, redactedPaths } = redactSecrets(record);
  const sanitized = value as SourceQualificationRecord;
  sanitized.redactedPaths = redactedPaths;
  assertNoSecretMaterial(sanitized, "source-qualification record");
  return Object.freeze({ ...sanitized, evidence: Object.freeze({ ...sanitized.evidence }) });
}

/** Runs one scenario and returns its sanitized record. Never throws: an
 * unexpected failure is itself a bounded blocked record, never a pass. */
export async function qualifyPersistentWorkSource(scenario: ScenarioName): Promise<SourceQualificationRecord> {
  try {
    switch (scenario) {
      case "valid-staged-completion": return emitRecord(validStagedCompletion());
      case "database-first-split": return emitRecord(databaseFirstSplit());
      case "checkpoint-first-split": return emitRecord(checkpointFirstSplit());
      case "lost-acknowledgement": return emitRecord(await lostAcknowledgement());
      case "checkpoint-write-timeout": return emitRecord(await checkpointWriteTimeout());
      case "stale-checkpoint-rollback": return emitRecord(staleCheckpointRollback());
      case "checkpoint-advance-contract-guards": return emitRecord(checkpointAdvanceContractGuards());
      case "revoked-or-mismatched-signer": return emitRecord(revokedOrMismatchedSigner());
      case "incomplete-artifact-restore": return emitRecord(incompleteArtifactRestore());
      case "wrong-database-restore-identity": return emitRecord(wrongDatabaseRestoreIdentity());
      case "missing-restore-evidence": return emitRecord(missingRestoreEvidence());
    }
  } catch (error) {
    const detail = error instanceof QualificationBlocked
      ? error.message.replace("source-qualification blocked: ", "")
      : `internal-error:${error instanceof Error ? error.message : "unknown"}`;
    return emitRecord({ case: scenario, verdict: "blocked", reason: detail, evidence: { workApproved: false } });
  }
}

/** Runs the full suite in scenario order. */
export async function qualifyAllPersistentWorkSources(): Promise<SourceQualificationRecord[]> {
  const records: SourceQualificationRecord[] = [];
  for (const scenario of SCENARIO_NAMES) records.push(await qualifyPersistentWorkSource(scenario));
  return records;
}

const invokedDirectly = typeof process !== "undefined"
  && Array.isArray(process.argv)
  && process.argv.length > 1
  && (process.argv[1].endsWith("qualify-persistent-work-source.ts") || process.argv[1].endsWith("qualify-persistent-work-source.js"));

if (invokedDirectly) {
  qualifyAllPersistentWorkSources().then(records => {
    for (const record of records) console.log(JSON.stringify(record));
  }).catch(error => {
    console.error(`source-qualification failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
