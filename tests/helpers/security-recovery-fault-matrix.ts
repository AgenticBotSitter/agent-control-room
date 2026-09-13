import { createEtcdCompletionCheckpointStoreV1 } from "../../src/completion-gate/v1/etcd-checkpoint-store";
import { parseRollbackCheckpointV1, type RollbackCheckpointV1 } from "../../src/security/rollback-checkpoint";
import { createArtifactBackupInventoryV1, type ArtifactBackupInventoryV1,
  type ArtifactBackupInventoryEntryV1 } from "../../src/artifacts/v1/artifact-backup-inventory";
import { sha256Digest } from "../../src/security";

export type CheckpointReadFault = "none" | "missing" | "wrong_tenant" | "wrong_scope" | "wrong_cluster"
  | "wrong_create_revision" | "replaced_key" | "changed_digest" | "changed_tag";
export type CheckpointWriteFault = "none" | "conditional_failure" | "lost_ack" | "timeout" | "late_ack";

/** Effect-free in-memory RPC peer. It drives the production etcd access/parser/CAS code. */
export function securityRecoveryCheckpointPeer(initialValue: RollbackCheckpointV1, timeoutMs = 40) {
  const initial = parseRollbackCheckpointV1(initialValue);
  const binding = { clusterId: "121", createRevision: "7", key: Buffer.from("synthetic/security-recovery"), scope: initial.scope };
  let bytes = Buffer.from(JSON.stringify(initial)), revision = 8, version = 1;
  let readFault: CheckpointReadFault = "none", writeFault: CheckpointWriteFault = "none";
  let ranges = 0, transactions = 0, committedWrites = 0, cancels = 0;
  const transactionShapes: Array<{ failureCount: number; successCount: number }> = [];
  let late: ((error: unknown, response?: unknown) => void) | undefined;

  const response = () => {
    const checkpoint = parseRollbackCheckpointV1(JSON.parse(bytes.toString("utf8")));
    const value = readFault === "wrong_tenant" ? { ...checkpoint, scope: "completion-gate:tenant:wrong" }
      : readFault === "wrong_scope" ? { ...checkpoint, scope: "unrelated-scope" }
      : readFault === "changed_digest" ? { ...checkpoint, stateDigest: sha256Digest("changed-state") }
      : readFault === "changed_tag" ? { ...checkpoint, stateAuthTag: `hmac-sha256:${"0".repeat(64)}` }
      : checkpoint;
    return {
      header: { cluster_id: readFault === "wrong_cluster" ? "122" : binding.clusterId, revision: String(revision) },
      count: readFault === "missing" ? "0" : "1", more: false,
      kvs: readFault === "missing" ? [] : [{
        key: readFault === "replaced_key" ? Buffer.from("synthetic/replaced") : Buffer.from(binding.key),
        value: Buffer.from(JSON.stringify(value)),
        create_revision: readFault === "wrong_create_revision" ? "8" : binding.createRevision,
        mod_revision: String(revision), version: String(version), lease: "0",
      }],
    };
  };
  const receipt = () => ({ header: { cluster_id: binding.clusterId, revision: String(revision) }, succeeded: true,
    responses: [{ response: "response_put", response_put: {} }] });

  const open = () => createEtcdCompletionCheckpointStoreV1({ binding, timeoutMs,
    range(_request, _deadline, callback) {
      ranges++;
      callback(null, response());
      return { cancel() { cancels++; } };
    },
    txn(request, _deadline, callback) {
      transactions++;
      transactionShapes.push({ failureCount: request.failure.length, successCount: request.success.length });
      if (writeFault === "conditional_failure") {
        callback(null, { header: { cluster_id: binding.clusterId, revision: String(revision) }, succeeded: false, responses: [] });
        return { cancel() { cancels++; } };
      }
      if (writeFault === "timeout") {
        late = callback;
        return { cancel() { cancels++; } };
      }
      const put = request.success[0]?.request_put;
      if (!put) throw new Error("synthetic_checkpoint_request_invalid");
      bytes = Buffer.from(put.value); revision++; version++; committedWrites++;
      if (writeFault === "late_ack") late = callback;
      else if (writeFault === "lost_ack") callback(new Error("synthetic_lost_acknowledgement"));
      else callback(null, receipt());
      return { cancel() { cancels++; } };
    },
  });

  return Object.freeze({ open,
    setReadFault(value: CheckpointReadFault) { readFault = value; },
    setWriteFault(value: CheckpointWriteFault) { writeFault = value; },
    replace(value: RollbackCheckpointV1) { bytes = Buffer.from(JSON.stringify(parseRollbackCheckpointV1(value))); },
    acknowledgeLate() { late?.(null, receipt()); late = undefined; },
    checkpoint: () => parseRollbackCheckpointV1(JSON.parse(bytes.toString("utf8"))),
    stats: () => ({ ranges, transactions, committedWrites, cancels }),
    transactionShapes: () => structuredClone(transactionShapes),
  });
}

const inventoryHeader = { tenantId: "tenant:synthetic", releaseId: "release:synthetic",
  releaseDigest: sha256Digest("release"), databaseSchemaVersion: "schema:synthetic",
  databaseSchemaDigest: sha256Digest("schema"), storageNamespace: "namespace:synthetic",
  storageNamespaceDigest: sha256Digest("namespace") };

export function syntheticInventoryEntry(artifactId: string, label: string): ArtifactBackupInventoryEntryV1 {
  return { artifactId, contentHash: sha256Digest(`content:${label}`), sizeBytes: Buffer.byteLength(label),
    manifestDigest: sha256Digest(`manifest:${label}`), receiptDigest: sha256Digest(`receipt:${label}`) };
}

export function syntheticArtifactInventory(entries: readonly ArtifactBackupInventoryEntryV1[] = [
  syntheticInventoryEntry("artifact:synthetic:a", "a"), syntheticInventoryEntry("artifact:synthetic:b", "b"),
], header: Partial<typeof inventoryHeader> = {}): ArtifactBackupInventoryV1 {
  return createArtifactBackupInventoryV1({ ...inventoryHeader, ...header, entries });
}

export async function completionMutationCounts(db: { query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }> }, tenantId: string) {
  const records = await db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_completion_gate_records WHERE tenant_id=$1", [tenantId]);
  const state = await db.query<{ revision: number; record_count: number; state_digest: string; state_auth_tag: string }>(
    "SELECT revision,record_count,state_digest,state_auth_tag FROM control_completion_gate_integrity WHERE tenant_id=$1", [tenantId]);
  return { recordCount: Number(records.rows[0]?.count ?? -1), integrity: state.rows[0] };
}
