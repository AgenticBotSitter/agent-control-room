/**
 * Persistent-work source qualification runner (issue #215).
 *
 * One deterministic, effect-free qualification pass over the already-accepted
 * signing, completion-gate and independent-checkpoint contracts as a single
 * persistent-work boundary. Each scenario builds disposable in-memory or
 * scripted adapters, drives only production validation/parsing/compare code,
 * and returns a sanitized machine-readable record.
 *
 * Synthetic testing vs aggregate disposition: every scenario runs on
 * fabricated-but-consistent inputs, so a scenario `pass` proves internal
 * logic only and NEVER becomes acceptance evidence. The aggregate
 * disposition (summarizeQualification) stays `blocked` until real #63/#65
 * restore identities are supplied — which this effect-free package cannot do,
 * so the disposition is always blocked here. No failure path approves work,
 * rewrites history, advances a checkpoint twice, or treats uncertainty as
 * completion.
 *
 * Effect-freedom rules for this file (proven statically by the sibling test):
 * no network, no subprocess, no credential or private-key material of any
 * kind, no filesystem access, no database connection, no clock or randomness
 * reads (exact replay must be byte-identical). Fabricated digests via
 * sha256Digest over fixed labels only. The two signing fixtures below are
 * static public data minted once offline (keypair destroyed at mint): a
 * well-formed ed25519 SPKI and the one signature over the exact canonical
 * completion bytes. Neither is key material and neither can authorize
 * altered completion or recovery evidence.
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
  "valid-signing-path",
  "tampered-completion-evidence-refused",
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

/** Canonical completion-signing bytes. The signature binds the exact staged
 * completion and restore evidence — project/cluster scope, staged and
 * completed checkpoint digests, completed revision, database restore identity
 * and artifact-set identity — in one fixed-key-order representation. Any
 * alteration of that evidence produces different bytes, which the minted
 * signature does not verify and the scripted channel refuses to sign. */
export interface CompletionSignFields {
  scope: string;
  stagedDigest: string;
  completedDigest: string;
  completedRevision: number;
  databaseRestoreDigest: string;
  artifactDigest: string;
}

export function completionSignBytes(fields: CompletionSignFields): Buffer {
  return Buffer.from(JSON.stringify({
    domain: "persistent-work-source/completion/v1",
    scope: fields.scope,
    stagedDigest: fields.stagedDigest,
    completedDigest: fields.completedDigest,
    completedRevision: fields.completedRevision,
    databaseRestoreDigest: fields.databaseRestoreDigest,
    artifactDigest: fields.artifactDigest,
  }), "utf8");
}

/** Static public fixtures minted once offline over the exact canonical bytes
 * of the deterministic valid journey below (keypair destroyed at mint). The
 * signature verifies those bytes only and cannot authorize anything else. */
const SIGNING_PROOF_SPKI =
  "MCowBQYDK2VwAyEAgWWo444YxzWesl7Pnfsa6WEY-UnxtLYX2GDoLCbpFwo";
const SIGNING_PROOF_SIGNATURE =
  "xJkib6XejlBlfEFUKbCw1bTWDxCFSefPEEhE78ksQDBFAC83VFRg-caw8nVSMecgEtNBPWuEtNtNHzJWORlhAQ";

/** Deterministic evidence of the valid journey: fixed checkpoints, the anchor
 * restore bundle, and the canonical signing bytes built from them. Shared by
 * the journey, the signing path, and the tamper-refusal scenario so all three
 * operate on the same bound evidence. */
function validCompletionEvidence(): CompletionSignFields & { signBytes: Buffer } {
  const stagedDigest = rollbackCheckpointDigestV1(checkpointAt(1, 0, "anchor"));
  const completedDigest = rollbackCheckpointDigestV1(checkpointAt(2, 1, "completed"));
  const { artifactDigest } = requireRestoreEvidence(completeEvidenceBundle());
  const fields: CompletionSignFields = {
    scope: SCOPE,
    stagedDigest,
    completedDigest,
    completedRevision: 2,
    databaseRestoreDigest: ANCHOR_DATABASE_RESTORE_DIGEST,
    artifactDigest,
  };
  return { ...fields, signBytes: completionSignBytes(fields) };
}

function scriptedSigningChannel(mode: "valid" | "revoked", expectedSignBytes: Buffer): OwnerSigningProtocol {
  return Object.freeze({
    on() { return {}; },
    off() { return {}; },
    sign(_key: Buffer, bytes: Buffer, callback: (error: unknown, signature?: Buffer) => void) {
      // The valid channel releases the minted signature for the exact bound
      // evidence only; altered evidence (different bytes) is refused, and the
      // revoked channel refuses everything.
      if (mode === "valid" && bytes.equals(expectedSignBytes)) {
        callback(null, Buffer.from(SIGNING_PROOF_SIGNATURE, "base64url"));
      } else {
        callback(new Error(mode === "valid" ? "scripted signer unexpected material" : "scripted signer revoked"));
      }
      return {};
    },
  });
}

function boundedSigner(mode: "valid" | "revoked", expectedSignBytes: Buffer) {
  return createBoundedOwnerSignature({
    protocol: scriptedSigningChannel(mode, expectedSignBytes),
    close() {},
    publicKeySpki: SIGNING_PROOF_SPKI,
    timeoutMs: 100,
  });
}

async function validStagedCompletion(): Promise<Omit<SourceQualificationRecord, "schema" | "redactedPaths">> {
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
  // The completion journey is owner-authorized: sign the canonical bytes
  // built from the LIVE staged evidence (observed revision, observed
  // digests, required restore bundle) through the production bounded signer
  // over the scripted valid channel. The minted signature verifies those
  // bytes only — altered evidence produces different bytes and is refused.
  const signBytes = completionSignBytes({
    scope: SCOPE,
    stagedDigest: anchorDigest,
    completedDigest,
    completedRevision: observed.revision,
    databaseRestoreDigest: ANCHOR_DATABASE_RESTORE_DIGEST,
    artifactDigest,
  });
  let signature: Uint8Array;
  try {
    signature = await boundedSigner("valid", signBytes).sign(signBytes, new AbortController().signal);
  } catch {
    return blocked("staged-completion-signing-unavailable");
  }
  if (Buffer.from(signature).toString("base64url") !== SIGNING_PROOF_SIGNATURE) {
    return blocked("staged-completion-signature-mismatch");
  }
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
      signatureLength: signature.length,
      signatureDigest: sha256Digest(Buffer.from(signature).toString("base64url")),
      syntheticInput: true,
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
      syntheticInput: true,
      workApproved: false,
    },
  };
}

async function revokedOrMismatchedSigner(): Promise<Omit<SourceQualificationRecord, "schema" | "redactedPaths">> {
  // (a) A mismatched identity cannot parse as a key: construction itself must
  // refuse before any channel is reached. No key material exists in this
  // package, public or private.
  try {
    createBoundedOwnerSignature({
      protocol: scriptedSigningChannel("revoked", validCompletionEvidence().signBytes),
      close() {},
      publicKeySpki: "mismatched-signer-identity",
      timeoutMs: 100,
    });
  } catch {
    // (b) A structurally valid SPKI passes construction and reaches the
    // channel, which refuses it (revoked consent). This is the revoked path:
    // shape-valid, authorization-denied.
    try {
      await boundedSigner("revoked", validCompletionEvidence().signBytes).sign(validCompletionEvidence().signBytes, new AbortController().signal);
    } catch {
      return {
        case: "revoked-or-mismatched-signer",
        verdict: "blocked",
        reason: "revoked-signer-refused",
        evidence: {
          malformedIdentityRejected: true,
          revokedChannelRefused: true,
          signatureProduced: false,
          workApproved: false,
        },
      };
    }
    return blocked("revoked-signer-accepted");
  }
  return blocked("mismatched-signer-identity-accepted");
}

async function validSigningPath(): Promise<Omit<SourceQualificationRecord, "schema" | "redactedPaths">> {
  // The well-formed SPKI passes construction, the scripted valid channel
  // returns the offline-minted signature for the exact canonical completion
  // bytes, and the production signer verifies it internally before resolving.
  // Internal logic only: synthetic input.
  const { signBytes } = validCompletionEvidence();
  try {
    const signature = await boundedSigner("valid", signBytes).sign(signBytes, new AbortController().signal);
    if (signature.length === 64 && Buffer.from(signature).toString("base64url") === SIGNING_PROOF_SIGNATURE) {
      return {
        case: "valid-signing-path",
        verdict: "pass",
        reason: "signing-path-verified",
        evidence: {
          signatureLength: signature.length,
          signatureDigest: sha256Digest(SIGNING_PROOF_SIGNATURE),
          syntheticInput: true,
          workApproved: false,
        },
      };
    }
  } catch {
    // Fall through to the bounded failure below.
  }
  return blocked("signing-path-unavailable");
}

/** Each security-critical identity bound into the signature is altered in
 * turn; every altered variant must fail to obtain a signature through the
 * production signer (the scripted valid channel releases the minted
 * signature for the exact canonical bytes only, and the signer's internal
 * verify would reject any other bytes). Internal logic only. */
const TAMPER_FIELDS = [
  "scope",
  "stagedDigest",
  "completedDigest",
  "completedRevision",
  "databaseRestoreDigest",
  "artifactDigest",
] as const;

async function tamperedCompletionEvidenceRefused(): Promise<Omit<SourceQualificationRecord, "schema" | "redactedPaths">> {
  const valid = validCompletionEvidence();
  const refused: Record<string, boolean> = {};
  for (const field of TAMPER_FIELDS) {
    const tampered: CompletionSignFields = { ...valid };
    if (field === "completedRevision") {
      tampered.completedRevision = valid.completedRevision + 1;
    } else if (field === "scope") {
      tampered.scope = `${valid.scope}:forked`;
    } else {
      (tampered[field] as string) = `${valid[field]}:tampered`;
    }
    const tamperedBytes = completionSignBytes(tampered);
    if (tamperedBytes.equals(valid.signBytes)) {
      return blocked(`tampered-evidence-identical:${field}`);
    }
    try {
      await boundedSigner("valid", valid.signBytes).sign(tamperedBytes, new AbortController().signal);
      return blocked(`tampered-evidence-signed:${field}`);
    } catch {
      refused[field] = true;
    }
  }
  return {
    case: "tampered-completion-evidence-refused",
    verdict: "pass",
    reason: "tampered-evidence-refused",
    evidence: {
      ...refused,
      tamperedFields: TAMPER_FIELDS.length,
      syntheticInput: true,
      workApproved: false,
    },
  };
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
      case "valid-staged-completion": return emitRecord(await validStagedCompletion());
      case "database-first-split": return emitRecord(databaseFirstSplit());
      case "checkpoint-first-split": return emitRecord(checkpointFirstSplit());
      case "lost-acknowledgement": return emitRecord(await lostAcknowledgement());
      case "checkpoint-write-timeout": return emitRecord(await checkpointWriteTimeout());
      case "stale-checkpoint-rollback": return emitRecord(staleCheckpointRollback());
      case "checkpoint-advance-contract-guards": return emitRecord(checkpointAdvanceContractGuards());
      case "revoked-or-mismatched-signer": return emitRecord(await revokedOrMismatchedSigner());
      case "valid-signing-path": return emitRecord(await validSigningPath());
      case "tampered-completion-evidence-refused": return emitRecord(await tamperedCompletionEvidenceRefused());
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

export interface QualificationDisposition {
  schema: typeof QUALIFICATION_SCHEMA_V1;
  disposition: "blocked";
  reason: string;
  scenarios: number;
  syntheticPasses: string[];
  blocked: string[];
}

/** Aggregate disposition over a full suite. Synthetic scenario passes prove
 * internal logic only: without real supplied #63/#65 restore identities the
 * qualification cannot accept the source boundary, so the disposition stays
 * blocked and names exactly what is missing. */
export function summarizeQualification(records: SourceQualificationRecord[]): QualificationDisposition {
  return {
    schema: QUALIFICATION_SCHEMA_V1,
    disposition: "blocked",
    reason: "missing-real-restore-evidence:synthetic-passes-are-internal-logic-only",
    scenarios: records.length,
    syntheticPasses: records.filter(record => record.verdict === "pass").map(record => record.case).sort(),
    blocked: records.filter(record => record.verdict === "blocked").map(record => record.case).sort(),
  };
}

const invokedDirectly = typeof process !== "undefined"
  && Array.isArray(process.argv)
  && process.argv.length > 1
  && (process.argv[1].endsWith("qualify-persistent-work-source.ts") || process.argv[1].endsWith("qualify-persistent-work-source.js"));

if (invokedDirectly) {
  qualifyAllPersistentWorkSources().then(records => {
    for (const record of records) console.log(JSON.stringify(record));
    console.log(JSON.stringify(summarizeQualification(records)));
  }).catch(error => {
    console.error(`source-qualification failed: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  });
}
