import { timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { exactProjectWorkspaceJsonV1 } from "../../project-workspace/v1";
import { assertNoSecretMaterial, hmacSha256Tag, sha256Digest } from "../../security";
import {
  ROLLBACK_CHECKPOINT_SCHEMA_V1,
  rollbackCheckpointDigestV1,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security/rollback-checkpoint";

export const OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1 = "control-room-operations-fake-lifecycle-ledger/v1" as const;

export type OperationsFakeLifecycleKindV1 =
  | "backup_job"
  | "recovery_target_claim"
  | "recovery_phase"
  | "recovery_cleanup"
  | "recovery_attestation";
export type OperationsFakeLifecycleStateV1 =
  | "authorized"
  | "claimed"
  | "marked"
  | "succeeded"
  | "failed_before_marker"
  | "failed"
  | "ambiguous";

export interface OperationsFakeLifecycleOperationV1 {
  contractVersion: typeof OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1;
  operationId: string;
  operationDigest: string;
  kind: OperationsFakeLifecycleKindV1;
  parentOperationId?: string;
  position?: number;
  targetIdentityDigest?: string;
  markerRequired: boolean;
  authorizedAt: string;
  expiresAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface OperationsFakeLifecycleMarkerV1 {
  contractVersion: typeof OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1;
  operationId: string;
  operationDigest: string;
  markerEvidenceDigest: string;
  recordedAt: string;
  containsEffectOutput: false;
  grantsExecutionAuthority: false;
  markerDigest: string;
}

export interface OperationsFakeLifecycleReceiptV1 {
  contractVersion: typeof OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1;
  operationId: string;
  operationDigest: string;
  state: "succeeded" | "failed_before_marker" | "failed" | "ambiguous";
  safeCode: string;
  evidenceDigest?: string;
  recordedAt: string;
  containsBytes: false;
  containsRawOutput: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  receiptDigest: string;
}

export interface OperationsFakeLifecycleRecordV1 {
  operation: OperationsFakeLifecycleOperationV1;
  state: OperationsFakeLifecycleStateV1;
  marker?: OperationsFakeLifecycleMarkerV1;
  receipt?: OperationsFakeLifecycleReceiptV1;
  updatedAt: string;
}

type Row = {
  operation_id: string;
  operation_digest: string;
  kind: OperationsFakeLifecycleKindV1;
  parent_operation_id: string | null;
  position: number | null;
  target_identity_digest: string | null;
  marker_required: number;
  operation_json: string;
  state: OperationsFakeLifecycleStateV1;
  marker_json: string | null;
  receipt_json: string | null;
  updated_at: string;
};
type MetadataRow = { ledger_identity_digest: string; revision: number; high_water_at: string; state_auth_tag: string };

const initialHighWater = "1970-01-01T00:00:00.000Z";
const operationTableSql = `CREATE TABLE operations_fake_lifecycle_records (
  operation_id TEXT PRIMARY KEY,
  operation_digest TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('backup_job','recovery_target_claim','recovery_phase','recovery_cleanup','recovery_attestation')),
  parent_operation_id TEXT,
  position INTEGER,
  target_identity_digest TEXT,
  marker_required INTEGER NOT NULL CHECK(marker_required IN (0,1)),
  operation_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('authorized','claimed','marked','succeeded','failed_before_marker','failed','ambiguous')),
  marker_json TEXT,
  receipt_json TEXT,
  updated_at TEXT NOT NULL
)`;
const metadataTableSql = `CREATE TABLE operations_fake_lifecycle_metadata (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  ledger_identity_digest TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>=1),
  high_water_at TEXT NOT NULL,
  state_auth_tag TEXT NOT NULL
)`;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const idPattern = /^[a-z0-9][a-z0-9:._-]{2,239}$/;
const safeCodePattern = /^[a-z0-9][a-z0-9._-]{1,119}$/;
const iso = (value: string) => Number.isFinite(Date.parse(value));
const equal = (left: string, right: string) => {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
};

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("operations fake lifecycle value invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("|") !== [...keys].sort().join("|")) throw new Error("operations fake lifecycle value invalid");
  return record;
}

function parseOperation(value: unknown): OperationsFakeLifecycleOperationV1 {
  const required = ["authorizedAt", "contractVersion", "expiresAt", "grantsApproval", "grantsExecutionAuthority", "kind",
    "markerRequired", "operationDigest", "operationId"];
  const snapshot = exactProjectWorkspaceJsonV1(value), raw = snapshot as Record<string, unknown> | undefined;
  const optional = [raw?.parentOperationId === undefined ? undefined : "parentOperationId",
    raw?.position === undefined ? undefined : "position", raw?.targetIdentityDigest === undefined ? undefined : "targetIdentityDigest"]
    .filter((item): item is string => Boolean(item));
  const item = exactObject(snapshot, [...required, ...optional]);
  if (item.contractVersion !== OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1 || typeof item.operationId !== "string" || !idPattern.test(item.operationId)
    || typeof item.operationDigest !== "string" || !digestPattern.test(item.operationDigest)
    || !["backup_job", "recovery_target_claim", "recovery_phase", "recovery_cleanup", "recovery_attestation"].includes(String(item.kind))
    || typeof item.markerRequired !== "boolean" || typeof item.authorizedAt !== "string" || !iso(item.authorizedAt)
    || typeof item.expiresAt !== "string" || !iso(item.expiresAt) || Date.parse(item.expiresAt) <= Date.parse(item.authorizedAt)
    || item.grantsApproval !== false || item.grantsExecutionAuthority !== false
    || (item.parentOperationId !== undefined && (typeof item.parentOperationId !== "string" || !idPattern.test(item.parentOperationId)))
    || (item.position !== undefined && (!Number.isSafeInteger(item.position) || Number(item.position) < 0 || Number(item.position) > 99))
    || (item.targetIdentityDigest !== undefined && (typeof item.targetIdentityDigest !== "string" || !digestPattern.test(item.targetIdentityDigest)))) {
    throw new Error("operations fake lifecycle operation invalid");
  }
  assertNoSecretMaterial(item, "operations fake lifecycle operation");
  return item as unknown as OperationsFakeLifecycleOperationV1;
}

export function buildOperationsFakeLifecycleReceiptV1(input: Omit<OperationsFakeLifecycleReceiptV1, "contractVersion" | "containsBytes" |
  "containsRawOutput" | "grantsApproval" | "grantsExecutionAuthority" | "receiptDigest">): OperationsFakeLifecycleReceiptV1 {
  const material: Omit<OperationsFakeLifecycleReceiptV1, "receiptDigest"> = {
    contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1, operationId: input.operationId,
    operationDigest: input.operationDigest, state: input.state, safeCode: input.safeCode,
    ...(input.evidenceDigest ? { evidenceDigest: input.evidenceDigest } : {}), recordedAt: input.recordedAt,
    containsBytes: false, containsRawOutput: false, grantsApproval: false, grantsExecutionAuthority: false,
  };
  return parseOperationsFakeLifecycleReceiptV1({ ...material, receiptDigest: sha256Digest(material) });
}

export function parseOperationsFakeLifecycleReceiptV1(value: unknown): OperationsFakeLifecycleReceiptV1 {
  const snapshot = exactProjectWorkspaceJsonV1(value), raw = snapshot as Record<string, unknown> | undefined;
  const keys = ["containsBytes", "containsRawOutput", "contractVersion", "grantsApproval", "grantsExecutionAuthority",
    "operationDigest", "operationId", "receiptDigest", "recordedAt", "safeCode", "state",
    ...(raw?.evidenceDigest === undefined ? [] : ["evidenceDigest"])];
  const item = exactObject(snapshot, keys);
  if (item.contractVersion !== OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1 || typeof item.operationId !== "string" || !idPattern.test(item.operationId)
    || typeof item.operationDigest !== "string" || !digestPattern.test(item.operationDigest)
    || !["succeeded", "failed_before_marker", "failed", "ambiguous"].includes(String(item.state))
    || typeof item.safeCode !== "string" || !safeCodePattern.test(item.safeCode)
    || (item.evidenceDigest !== undefined && (typeof item.evidenceDigest !== "string" || !digestPattern.test(item.evidenceDigest)))
    || typeof item.recordedAt !== "string" || !iso(item.recordedAt) || item.containsBytes !== false || item.containsRawOutput !== false
    || item.grantsApproval !== false || item.grantsExecutionAuthority !== false
    || typeof item.receiptDigest !== "string" || !digestPattern.test(item.receiptDigest)) throw new Error("operations fake lifecycle receipt invalid");
  assertNoSecretMaterial(item, "operations fake lifecycle receipt");
  const material = { ...item }; delete material.receiptDigest;
  if (sha256Digest(material) !== item.receiptDigest) throw new Error("operations fake lifecycle receipt digest mismatch");
  return item as unknown as OperationsFakeLifecycleReceiptV1;
}

function parseMarker(value: unknown): OperationsFakeLifecycleMarkerV1 {
  const item = exactObject(exactProjectWorkspaceJsonV1(value), ["containsEffectOutput", "contractVersion", "grantsExecutionAuthority", "markerDigest",
    "markerEvidenceDigest", "operationDigest", "operationId", "recordedAt"]);
  if (item.contractVersion !== OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1 || typeof item.operationId !== "string" || !idPattern.test(item.operationId)
    || typeof item.operationDigest !== "string" || !digestPattern.test(item.operationDigest)
    || typeof item.markerEvidenceDigest !== "string" || !digestPattern.test(item.markerEvidenceDigest)
    || typeof item.recordedAt !== "string" || !iso(item.recordedAt) || item.containsEffectOutput !== false
    || item.grantsExecutionAuthority !== false || typeof item.markerDigest !== "string" || !digestPattern.test(item.markerDigest)) {
    throw new Error("operations fake lifecycle marker invalid");
  }
  const material = { ...item }; delete material.markerDigest;
  if (sha256Digest(material) !== item.markerDigest) throw new Error("operations fake lifecycle marker digest mismatch");
  return item as unknown as OperationsFakeLifecycleMarkerV1;
}

function preparePrivatePath(path: string, mode: "create" | "open"): void {
  if (path === ":memory:") return;
  const uid = process.getuid?.(), parent = lstatSync(dirname(path));
  if (!parent.isDirectory() || parent.isSymbolicLink() || (uid !== undefined && parent.uid !== uid)
    || (process.platform !== "win32" && (parent.mode & 0o077) !== 0)) throw new Error("operations fake ledger path is not private");
  try {
    const file = lstatSync(path);
    if (mode === "create") throw new Error("operations fake ledger already exists");
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || (uid !== undefined && file.uid !== uid)
      || (process.platform !== "win32" && (file.mode & 0o077) !== 0)) throw new Error("operations fake ledger path is not private");
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    if (mode === "open") throw new Error("operations fake ledger missing");
    closeSync(openSync(path, "wx", 0o600));
  }
}

export class SqliteOperationsFakeLifecycleLedgerV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  readonly #checkpointRead: RollbackCheckpointStoreV1["read"];
  readonly #checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  readonly #checkpointAdvance: RollbackCheckpointStoreV1["advance"];
  readonly #clock: () => string;

  constructor(path: string, private readonly ledgerIdentityDigest: string, options: {
    integrityKey: Uint8Array;
    checkpointStore: RollbackCheckpointStoreV1;
    mode: "create" | "open";
    testOnly: true;
    clock?: () => string;
  }) {
    if (!digestPattern.test(ledgerIdentityDigest) || options.testOnly !== true) throw new Error("operations fake ledger is test-only");
    hmacSha256Tag(options.integrityKey, { purpose: "operations-fake-lifecycle-ledger-key-check" });
    this.#key = new Uint8Array(options.integrityKey); this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#checkpointRead = options.checkpointStore.read.bind(options.checkpointStore);
    this.#checkpointInitialize = options.checkpointStore.initialize.bind(options.checkpointStore);
    this.#checkpointAdvance = options.checkpointStore.advance.bind(options.checkpointStore);
    if (path === ":memory:" && options.mode !== "create") throw new Error("operations fake in-memory ledger cannot reopen");
    preparePrivatePath(path, options.mode); this.#db = new DatabaseSync(path);
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if ((options.mode === "create" && version !== 0) || (options.mode === "open" && version !== 1)) {
      this.#db.close(); throw new Error("operations fake ledger schema invalid");
    }
    this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    if (options.mode === "create") {
      this.#db.exec(`${operationTableSql};${metadataTableSql};`);
      const tag = this.stateTag(1, initialHighWater);
      this.#db.prepare("INSERT INTO operations_fake_lifecycle_metadata(singleton,ledger_identity_digest,revision,high_water_at,state_auth_tag) VALUES(1,?,?,?,?)")
        .run(ledgerIdentityDigest, 1, initialHighWater, tag);
      this.#db.exec("PRAGMA user_version=1");
      this.#checkpointInitialize(this.checkpoint(this.metadata()));
    } else {
      this.assertSchema(); this.assertState(); this.reconcileInterruptedOperations();
    }
  }

  close(): void { this.#db.close(); this.#key.fill(0); }

  authorize(operationValue: OperationsFakeLifecycleOperationV1): OperationsFakeLifecycleRecordV1 {
    return this.transaction(() => {
      const operation = parseOperation(operationValue), existing = this.getRow(operation.operationId);
      if (existing) {
        const record = this.verifyRow(existing);
        if (record.operation.operationDigest !== operation.operationDigest || JSON.stringify(record.operation) !== JSON.stringify(operation)) {
          throw new Error("operations fake lifecycle authorization conflict");
        }
        return record;
      }
      if (operation.kind === "recovery_target_claim" && operation.targetIdentityDigest) {
        const used = this.#db.prepare("SELECT operation_id FROM operations_fake_lifecycle_records WHERE kind='recovery_target_claim' AND target_identity_digest=? LIMIT 1")
          .get(operation.targetIdentityDigest) as { operation_id: string } | undefined;
        if (used) throw new Error("operations recovery target already used");
      }
      this.observe(operation.authorizedAt);
      this.#db.prepare(`INSERT INTO operations_fake_lifecycle_records(operation_id,operation_digest,kind,parent_operation_id,position,
        target_identity_digest,marker_required,operation_json,state,updated_at) VALUES(?,?,?,?,?,?,?,?,'authorized',?)`)
        .run(operation.operationId, operation.operationDigest, operation.kind, operation.parentOperationId ?? null,
          operation.position ?? null, operation.targetIdentityDigest ?? null, operation.markerRequired ? 1 : 0,
          JSON.stringify(operation), operation.authorizedAt);
      return this.verifyRow(this.requireRow(operation.operationId));
    });
  }

  claim(operationId: string, claimedAt: string): { disposition: "dispatch" | "in_progress" | "terminal"; record: OperationsFakeLifecycleRecordV1 } {
    return this.transaction(() => {
      const row = this.requireRow(operationId), record = this.verifyRow(row), operation = record.operation;
      if (!iso(claimedAt) || Date.parse(claimedAt) < Date.parse(operation.authorizedAt) || Date.parse(claimedAt) >= Date.parse(operation.expiresAt)) {
        throw new Error("operations fake lifecycle claim time invalid");
      }
      if (row.state === "claimed" || row.state === "marked") return { disposition: "in_progress", record };
      if (this.isTerminal(row.state)) return { disposition: "terminal", record };
      this.observe(claimedAt);
      this.#db.prepare("UPDATE operations_fake_lifecycle_records SET state='claimed',updated_at=? WHERE operation_id=? AND state='authorized'")
        .run(claimedAt, operationId);
      return { disposition: "dispatch", record: this.verifyRow(this.requireRow(operationId)) };
    });
  }

  recordMarker(operationId: string, markerEvidenceDigest: string, recordedAt: string): OperationsFakeLifecycleRecordV1 {
    return this.transaction(() => {
      const row = this.requireRow(operationId), record = this.verifyRow(row);
      if (!record.operation.markerRequired || !digestPattern.test(markerEvidenceDigest) || !iso(recordedAt)
        || Date.parse(recordedAt) < Date.parse(row.updated_at)) throw new Error("operations fake lifecycle marker invalid");
      if (row.state === "marked") return record;
      if (row.state !== "claimed") throw new Error("operations fake lifecycle marker transition invalid");
      const material: Omit<OperationsFakeLifecycleMarkerV1, "markerDigest"> = {
        contractVersion: OPERATIONS_FAKE_LIFECYCLE_LEDGER_V1, operationId,
        operationDigest: record.operation.operationDigest, markerEvidenceDigest, recordedAt,
        containsEffectOutput: false, grantsExecutionAuthority: false,
      };
      const marker = parseMarker({ ...material, markerDigest: sha256Digest(material) }); this.observe(recordedAt);
      this.#db.prepare("UPDATE operations_fake_lifecycle_records SET state='marked',marker_json=?,updated_at=? WHERE operation_id=? AND state='claimed'")
        .run(JSON.stringify(marker), recordedAt, operationId);
      return this.verifyRow(this.requireRow(operationId));
    });
  }

  settle(operationId: string, receiptValue: OperationsFakeLifecycleReceiptV1): OperationsFakeLifecycleRecordV1 {
    return this.transaction(() => {
      const row = this.requireRow(operationId), record = this.verifyRow(row), receipt = parseOperationsFakeLifecycleReceiptV1(receiptValue);
      if (receipt.operationId !== operationId || receipt.operationDigest !== record.operation.operationDigest
        || Date.parse(receipt.recordedAt) < Date.parse(row.updated_at)) throw new Error("operations fake lifecycle settlement conflict");
      if (this.isTerminal(row.state)) {
        if (!record.receipt || record.receipt.receiptDigest !== receipt.receiptDigest) throw new Error("operations fake lifecycle settlement conflict");
        return record;
      }
      if ((record.operation.markerRequired && row.state !== "marked") || (!record.operation.markerRequired && row.state !== "claimed")
        || receipt.state === "failed_before_marker") throw new Error("operations fake lifecycle settlement transition invalid");
      this.observe(receipt.recordedAt);
      this.#db.prepare("UPDATE operations_fake_lifecycle_records SET state=?,receipt_json=?,updated_at=? WHERE operation_id=?")
        .run(receipt.state, JSON.stringify(receipt), receipt.recordedAt, operationId);
      return this.verifyRow(this.requireRow(operationId));
    });
  }

  failBeforeMarker(operationId: string, safeCode: string, recordedAt: string): OperationsFakeLifecycleRecordV1 {
    const row = this.requireRecord(operationId);
    if (row.state !== "claimed") throw new Error("operations fake lifecycle failure transition invalid");
    return this.transaction(() => {
      const current = this.requireRow(operationId), record = this.verifyRow(current);
      if (current.state !== "claimed" || !safeCodePattern.test(safeCode) || !iso(recordedAt)
        || Date.parse(recordedAt) < Date.parse(current.updated_at)) throw new Error("operations fake lifecycle failure invalid");
      const receipt = buildOperationsFakeLifecycleReceiptV1({ operationId, operationDigest: record.operation.operationDigest,
        state: "failed_before_marker", safeCode, recordedAt }); this.observe(recordedAt);
      this.#db.prepare("UPDATE operations_fake_lifecycle_records SET state='failed_before_marker',receipt_json=?,updated_at=? WHERE operation_id=? AND state='claimed'")
        .run(JSON.stringify(receipt), recordedAt, operationId);
      return this.verifyRow(this.requireRow(operationId));
    });
  }

  requireRecord(operationId: string): OperationsFakeLifecycleRecordV1 { this.assertState(); return this.verifyRow(this.requireRow(operationId)); }
  list(parentOperationId?: string): OperationsFakeLifecycleRecordV1[] {
    this.assertState();
    const rows = parentOperationId === undefined
      ? this.#db.prepare("SELECT * FROM operations_fake_lifecycle_records ORDER BY operation_id").all() as Row[]
      : this.#db.prepare("SELECT * FROM operations_fake_lifecycle_records WHERE parent_operation_id=? ORDER BY position,operation_id").all(parentOperationId) as Row[];
    return rows.map((row) => this.verifyRow(row));
  }

  private reconcileInterruptedOperations(): void {
    const pending = this.rows().filter((row) => row.state === "claimed" || row.state === "marked");
    for (const row of pending) {
      this.transaction(() => {
        const current = this.requireRow(row.operation_id), record = this.verifyRow(current), recordedAt = this.nextObservedAt();
        const state = current.state === "marked" ? "ambiguous" as const : "failed_before_marker" as const;
        const safeCode = current.state === "marked" ? "ledger_reopened_after_effect_marker" : "ledger_reopened_before_effect_marker";
        const receipt = buildOperationsFakeLifecycleReceiptV1({ operationId: record.operation.operationId,
          operationDigest: record.operation.operationDigest, state, safeCode, recordedAt });
        this.observe(recordedAt);
        this.#db.prepare("UPDATE operations_fake_lifecycle_records SET state=?,receipt_json=?,updated_at=? WHERE operation_id=?")
          .run(state, JSON.stringify(receipt), recordedAt, row.operation_id);
      });
    }
  }

  private assertSchema(): void {
    const rows = this.#db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'operations_fake_lifecycle_%' ORDER BY name")
      .all() as Array<{ name: string; sql: string }>;
    if (rows.length !== 2 || rows[0]?.name !== "operations_fake_lifecycle_metadata" || rows[1]?.name !== "operations_fake_lifecycle_records"
      || rows[0].sql !== metadataTableSql || rows[1].sql !== operationTableSql) throw new Error("operations fake ledger schema invalid");
  }

  private verifyRow(row: Row): OperationsFakeLifecycleRecordV1 {
    const operation = parseOperation(JSON.parse(row.operation_json));
    if (operation.operationId !== row.operation_id || operation.operationDigest !== row.operation_digest || operation.kind !== row.kind
      || (operation.parentOperationId ?? null) !== row.parent_operation_id || (operation.position ?? null) !== row.position
      || (operation.targetIdentityDigest ?? null) !== row.target_identity_digest || Number(operation.markerRequired) !== row.marker_required
      || !iso(row.updated_at)) throw new Error("operations fake lifecycle row invalid");
    const marker = row.marker_json ? parseMarker(JSON.parse(row.marker_json)) : undefined;
    const receipt = row.receipt_json ? parseOperationsFakeLifecycleReceiptV1(JSON.parse(row.receipt_json)) : undefined;
    if ((row.state === "authorized" || row.state === "claimed") && (marker || receipt)) throw new Error("operations fake lifecycle row invalid");
    if (row.state === "marked" && (!marker || receipt) || this.isTerminal(row.state) && !receipt
      || marker && (marker.operationId !== row.operation_id || marker.operationDigest !== row.operation_digest)
      || receipt && (receipt.operationId !== row.operation_id || receipt.operationDigest !== row.operation_digest || receipt.state !== row.state)) {
      throw new Error("operations fake lifecycle row invalid");
    }
    return { operation, state: row.state, ...(marker ? { marker } : {}), ...(receipt ? { receipt } : {}), updatedAt: row.updated_at };
  }

  private rows(): Row[] { return this.#db.prepare("SELECT * FROM operations_fake_lifecycle_records ORDER BY operation_id").all() as Row[]; }
  private getRow(operationId: string): Row | undefined { return this.#db.prepare("SELECT * FROM operations_fake_lifecycle_records WHERE operation_id=?").get(operationId) as Row | undefined; }
  private requireRow(operationId: string): Row { const row = this.getRow(operationId); if (!row) throw new Error("operations fake lifecycle operation missing"); return row; }
  private isTerminal(state: OperationsFakeLifecycleStateV1): boolean { return ["succeeded", "failed_before_marker", "failed", "ambiguous"].includes(state); }
  private metadata(): MetadataRow {
    const row = this.#db.prepare("SELECT ledger_identity_digest,revision,high_water_at,state_auth_tag FROM operations_fake_lifecycle_metadata WHERE singleton=1").get() as MetadataRow | undefined;
    if (!row) throw new Error("operations fake ledger metadata missing"); return row;
  }
  private nextObservedAt(): string {
    const now = this.#clock(); if (!iso(now)) throw new Error("operations fake ledger clock invalid");
    return new Date(Math.max(Date.parse(now), Date.parse(this.metadata().high_water_at))).toISOString();
  }
  private observe(at: string): void {
    const current = this.metadata();
    if (!iso(at) || Date.parse(at) < Date.parse(current.high_water_at)) throw new Error("operations fake ledger clock rollback");
    this.#db.prepare("UPDATE operations_fake_lifecycle_metadata SET high_water_at=? WHERE singleton=1").run(at);
  }
  private stateMaterial(revision: number, highWaterAt: string) {
    return { ledgerIdentityDigest: this.ledgerIdentityDigest, revision, highWaterAt, records: this.rows() };
  }
  private stateTag(revision: number, highWaterAt: string): string { return hmacSha256Tag(this.#key, this.stateMaterial(revision, highWaterAt)); }
  private checkpoint(row: MetadataRow): RollbackCheckpointV1 {
    const records = this.rows();
    return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: `operations-fake-ledger:${this.ledgerIdentityDigest}`,
      revision: Number(row.revision), recordCount: records.length,
      stateDigest: sha256Digest(this.stateMaterial(Number(row.revision), row.high_water_at)), stateAuthTag: row.state_auth_tag };
  }
  private assertState(): RollbackCheckpointV1 {
    const row = this.metadata();
    if (row.ledger_identity_digest !== this.ledgerIdentityDigest || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1
      || !iso(row.high_water_at) || !equal(row.state_auth_tag, this.stateTag(Number(row.revision), row.high_water_at))) {
      throw new Error("operations fake ledger integrity failed");
    }
    for (const item of this.rows()) this.verifyRow(item);
    const expected = this.checkpoint(row), known = this.#checkpointRead(expected.scope);
    if (!known || rollbackCheckpointDigestV1(known) !== rollbackCheckpointDigestV1(expected)) throw new Error("operations fake ledger rollback detected");
    return expected;
  }
  private refreshTag(): RollbackCheckpointV1 {
    const current = this.metadata(), revision = Number(current.revision) + 1;
    const tag = this.stateTag(revision, current.high_water_at);
    this.#db.prepare("UPDATE operations_fake_lifecycle_metadata SET revision=?,state_auth_tag=? WHERE singleton=1 AND revision=?")
      .run(revision, tag, Number(current.revision));
    return this.checkpoint(this.metadata());
  }
  private transaction<T>(callback: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.assertState(), result = callback(), next = this.refreshTag();
      this.#checkpointAdvance(rollbackCheckpointDigestV1(prior), next); this.#db.exec("COMMIT"); return result;
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }
}
