import { timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateSqliteSchemaV1 } from "../../harness/codex-v1/private-sqlite-schema";
import {
  canonicalJson,
  bindInMemoryRollbackCheckpointStoreV1,
  hmacSha256Tag,
  ROLLBACK_CHECKPOINT_SCHEMA_V1,
  rollbackCheckpointDigestV1,
  sha256Digest,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security";
import { exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { buildReadyFrontierSourceV1, evaluateReadyFrontierV1, parseReadyFrontierEvaluationV1,
  parseReadyFrontierSourceV1, projectReadyFrontierOperatorV1 } from "./controller";
import { projectReadyFrontierCycleV1 } from "./cycle-projection";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { readyFrontierCycleInputSchemaV1, readyFrontierIdSchemaV1 } from "./schemas";
import type { ReadyFrontierCycleInputV1, ReadyFrontierEvaluationV1, ReadyFrontierOperatorProjectionV1 } from "./types";
import type { ReadyFrontierCycleProjectionV1 } from "./integration-types";

interface MetadataRowV1 {
  tenant_id: string; revision: number; record_count: number; state_digest: string; state_auth_tag: string;
}
interface CycleRowV1 {
  ledger_sequence: number; cycle_id: string; evaluated_at: string; source_digest: string; policy_digest: string;
  evaluation_digest: string; evaluation_json: string; record_auth_tag: string;
}

const SCHEMA_VERSION = 1;
const EXPECTED_OBJECTS = [
  "index:idx_ready_frontier_cycle_evaluated",
  "table:ready_frontier_cycle",
  "table:ready_frontier_metadata",
] as const;
const EXPECTED_COLUMNS = {
  ready_frontier_metadata: [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "tenant_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "record_count", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "state_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "state_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
  ready_frontier_cycle: [
    { name: "ledger_sequence", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "cycle_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "evaluated_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "source_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "policy_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "evaluation_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "evaluation_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "record_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
} as const;
const EXPECTED_SQL = {
  ready_frontier_metadata: `CREATE TABLE ready_frontier_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
    state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76)
  )`,
  ready_frontier_cycle: `CREATE TABLE ready_frontier_cycle (
    ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), cycle_id TEXT NOT NULL UNIQUE,
    evaluated_at TEXT NOT NULL, source_digest TEXT NOT NULL CHECK(length(source_digest)=71),
    policy_digest TEXT NOT NULL CHECK(length(policy_digest)=71), evaluation_digest TEXT NOT NULL CHECK(length(evaluation_digest)=71),
    evaluation_json TEXT NOT NULL, record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76)
  )`,
  idx_ready_frontier_cycle_evaluated: "CREATE INDEX idx_ready_frontier_cycle_evaluated ON ready_frontier_cycle(evaluated_at,ledger_sequence)",
} as const;

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function same(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8"), b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
function preparePrivatePath(path: string): void {
  if (!isAbsolute(path) || !process.getuid) fail("integrity_failed");
  const uid = process.getuid(), parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) fail("integrity_failed");
  try {
    const existing = lstatSync(path);
    if (!existing.isFile() || existing.isSymbolicLink() || existing.uid !== uid || existing.nlink !== 1 || (existing.mode & 0o077) !== 0) {
      fail("integrity_failed");
    }
  } catch (error) {
    if (error instanceof ReadyFrontierContractErrorV1) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") fail("integrity_failed");
    closeSync(openSync(path, "wx", 0o600));
  }
}

const simulationStores = new WeakSet<object>();

export class ReadyFrontierSimulationStoreV1 {
  readonly #db: DatabaseSync;
  readonly #integrityKey: Uint8Array;
  readonly #checkpointRead: RollbackCheckpointStoreV1["read"];
  readonly #checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  readonly #checkpointAdvance: RollbackCheckpointStoreV1["advance"];
  readonly #tenantId: string;
  readonly #maximumCycles: number;

  constructor(path: string, tenantId: string, integrityKeyValue: unknown,
    checkpointStore: RollbackCheckpointStoreV1, maximumCycles = 1_000) {
    const key = exactHostUint8ArrayV1(integrityKeyValue, 128);
    if (!key || key.byteLength < 32 || !Number.isSafeInteger(maximumCycles) || maximumCycles < 1 || maximumCycles > 10_000) {
      fail("integrity_failed");
    }
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, tenantId);
    const checkpoint = bindInMemoryRollbackCheckpointStoreV1(checkpointStore);
    if (!checkpoint) fail("integrity_failed");
    this.#tenantId = tenantId; this.#maximumCycles = maximumCycles;
    this.#integrityKey = key.copy();
    this.#checkpointRead = checkpoint.read;
    this.#checkpointInitialize = checkpoint.initialize;
    this.#checkpointAdvance = checkpoint.advance;
    preparePrivatePath(path); this.#db = new DatabaseSync(path);
    try {
      const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version !== 0 && version !== SCHEMA_VERSION) fail("integrity_failed");
      this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
      if (version === 0) this.#db.exec(`
        CREATE TABLE ready_frontier_metadata (
          singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL,
          revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
          state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76)
        );
        CREATE TABLE ready_frontier_cycle (
          ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), cycle_id TEXT NOT NULL UNIQUE,
          evaluated_at TEXT NOT NULL, source_digest TEXT NOT NULL CHECK(length(source_digest)=71),
          policy_digest TEXT NOT NULL CHECK(length(policy_digest)=71), evaluation_digest TEXT NOT NULL CHECK(length(evaluation_digest)=71),
          evaluation_json TEXT NOT NULL, record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76)
        );
        CREATE INDEX idx_ready_frontier_cycle_evaluated ON ready_frontier_cycle(evaluated_at,ledger_sequence);
        PRAGMA user_version=1;
      `);
      assertPrivateSqliteSchemaV1(this.#db, EXPECTED_OBJECTS, EXPECTED_COLUMNS, EXPECTED_SQL);
      this.#initializeOrVerify();
    } catch (error) {
      this.#integrityKey.fill(0); this.#db.close();
      if (error instanceof ReadyFrontierContractErrorV1) throw error;
      fail("integrity_failed");
    }
    simulationStores.add(this); Object.freeze(this);
  }

  runCycle(input: ReadyFrontierCycleInputV1): { evaluation: ReadyFrontierEvaluationV1; replayed: boolean } {
    const parsed = parseExactReadyFrontierV1(readyFrontierCycleInputSchemaV1, input) as ReadyFrontierCycleInputV1;
    const source = parseReadyFrontierSourceV1(parsed.source);
    if (source.tenantId !== this.#tenantId) fail("scope_mismatch");
    const relevantIntents = new Set(source.candidates.map((candidate) => candidate.intentDigest));
    const priorById = new Map(source.priorProposals.map((proposal) => [proposal.proposalId, proposal]));
    const current = this.#verifyState(), existing = current.records.find((record) => record.evaluation.cycleId === parsed.cycleId);
    const history = existing ? current.records.filter((record) => record.row.ledger_sequence < existing.row.ledger_sequence) : current.records;
    let added = 0;
    for (const record of history) for (const proposal of record.evaluation.proposals) {
      if (!relevantIntents.has(proposal.intentDigest)) continue;
      const existing = priorById.get(proposal.proposalId);
      if (existing) {
        if (existing.projectId !== proposal.projectId || existing.intentDigest !== proposal.intentDigest
          || existing.evidenceDigest !== proposal.proposalDigest) fail("integrity_failed");
        continue;
      }
      priorById.set(proposal.proposalId, { proposalId: proposal.proposalId, projectId: proposal.projectId,
        intentDigest: proposal.intentDigest, state: "open", observedAt: proposal.proposedAt, evidenceDigest: proposal.proposalDigest });
      added += 1;
    }
    const { sourceDigest: _sourceDigest, ...sourceWithoutDigest } = source; void _sourceDigest;
    const effectiveSource = added === 0 ? source : buildReadyFrontierSourceV1({ ...sourceWithoutDigest,
      historyRevision: source.historyRevision + added, priorProposals: [...priorById.values()] });
    return this.recordEvaluation(evaluateReadyFrontierV1({ ...parsed, source: effectiveSource }, this.#integrityKey));
  }

  recordEvaluation(value: unknown): { evaluation: ReadyFrontierEvaluationV1; replayed: boolean } {
    const evaluation = parseReadyFrontierEvaluationV1(value, this.#integrityKey);
    if (evaluation.tenantId !== this.#tenantId) fail("scope_mismatch");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const current = this.#verifyState(), existing = current.records.find((item) => item.row.cycle_id === evaluation.cycleId);
      if (existing) {
        if (!same(existing.row.evaluation_digest, evaluation.evaluationDigest)) fail("replay_drift");
        this.#db.exec("COMMIT"); return { evaluation: existing.evaluation, replayed: true };
      }
      if (current.metadata.record_count >= this.#maximumCycles) fail("capacity_exceeded");
      const ledgerSequence = current.metadata.record_count + 1;
      const rowMaterial = { tenantId: this.#tenantId, ledgerSequence, cycleId: evaluation.cycleId, evaluatedAt: evaluation.evaluatedAt,
        sourceDigest: evaluation.sourceDigest, policyDigest: evaluation.policyDigest, evaluationDigest: evaluation.evaluationDigest };
      const recordAuthTag = hmacSha256Tag(this.#integrityKey, rowMaterial);
      this.#db.prepare(`INSERT INTO ready_frontier_cycle(ledger_sequence,cycle_id,evaluated_at,source_digest,policy_digest,evaluation_digest,evaluation_json,record_auth_tag)
        VALUES(?,?,?,?,?,?,?,?)`).run(ledgerSequence, evaluation.cycleId, evaluation.evaluatedAt, evaluation.sourceDigest,
        evaluation.policyDigest, evaluation.evaluationDigest, canonicalJson(evaluation), recordAuthTag);
      const nextRows = this.#rows(), revision = current.metadata.revision + 1, recordCount = current.metadata.record_count + 1;
      const stateDigest = this.#computeStateDigest(nextRows), stateAuthTag = this.#stateTag(revision, recordCount, stateDigest);
      this.#db.prepare("UPDATE ready_frontier_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE singleton=1")
        .run(revision, recordCount, stateDigest, stateAuthTag);
      this.#checkpointAdvance(rollbackCheckpointDigestV1(this.#checkpoint(current.metadata.revision, current.metadata.record_count,
        current.metadata.state_digest, current.metadata.state_auth_tag)), this.#checkpoint(revision, recordCount, stateDigest, stateAuthTag));
      this.#verifyState(); this.#db.exec("COMMIT"); return { evaluation, replayed: false };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      if (error instanceof ReadyFrontierContractErrorV1) throw error;
      fail("integrity_failed");
    }
  }

  listEvaluations(): ReadyFrontierEvaluationV1[] { return this.#verifyState().records.map((item) => item.evaluation); }
  evaluation(cycleId: string): ReadyFrontierEvaluationV1 | undefined {
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, cycleId);
    return this.#verifyState().records.find((item) => item.evaluation.cycleId === cycleId)?.evaluation;
  }
  latestOperatorProjection(): ReadyFrontierOperatorProjectionV1 | undefined {
    const latest = this.#verifyState().records.at(-1)?.evaluation;
    return latest ? projectReadyFrontierOperatorV1(latest, this.#integrityKey) : undefined;
  }
  cycleProjection(cycleId: string): ReadyFrontierCycleProjectionV1 | undefined {
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, cycleId);
    const evaluation = this.#verifyState().records.find((item) => item.evaluation.cycleId === cycleId)?.evaluation;
    return evaluation ? projectReadyFrontierCycleV1(evaluation, this.#integrityKey) : undefined;
  }
  latestCycleProjection(): ReadyFrontierCycleProjectionV1 | undefined {
    const latest = this.#verifyState().records.at(-1)?.evaluation;
    return latest ? projectReadyFrontierCycleV1(latest, this.#integrityKey) : undefined;
  }
  cycleProjectionHistory(limit = 20): ReadyFrontierCycleProjectionV1[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail("invalid_input");
    return this.#verifyState().records.slice(-limit).reverse()
      .map((item) => projectReadyFrontierCycleV1(item.evaluation, this.#integrityKey));
  }
  closeDatabase(): void { this.#integrityKey.fill(0); this.#db.close(); }

  #initializeOrVerify(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const metadata = this.#metadata(), rowCount = (this.#db.prepare("SELECT COUNT(*) AS count FROM ready_frontier_cycle").get() as { count: number }).count;
      const checkpoint = this.#readCheckpoint();
      if (!metadata) {
        if (rowCount !== 0 || checkpoint) fail("integrity_failed");
        const revision = 1, recordCount = 0, stateDigest = this.#computeStateDigest([]), stateAuthTag = this.#stateTag(revision, recordCount, stateDigest);
        this.#db.prepare("INSERT INTO ready_frontier_metadata(singleton,tenant_id,revision,record_count,state_digest,state_auth_tag) VALUES(1,?,?,?,?,?)")
          .run(this.#tenantId, revision, recordCount, stateDigest, stateAuthTag);
        this.#checkpointInitialize(this.#checkpoint(revision, recordCount, stateDigest, stateAuthTag));
      } else this.#verifyState();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      if (error instanceof ReadyFrontierContractErrorV1) throw error;
      fail("integrity_failed");
    }
  }

  #verifyState(): { metadata: MetadataRowV1; records: Array<{ row: CycleRowV1; evaluation: ReadyFrontierEvaluationV1 }> } {
    const metadata = this.#metadata(); if (!metadata || metadata.tenant_id !== this.#tenantId) fail("scope_mismatch");
    const rows = this.#rows();
    if (metadata.record_count !== rows.length || metadata.revision !== rows.length + 1) fail("integrity_failed");
    const records: Array<{ row: CycleRowV1; evaluation: ReadyFrontierEvaluationV1 }> = [];
    for (const [index, row] of rows.entries()) {
      if (row.ledger_sequence !== index + 1) fail("integrity_failed");
      let raw: unknown; try { raw = JSON.parse(row.evaluation_json); } catch { fail("integrity_failed"); }
      let evaluation: ReadyFrontierEvaluationV1;
      try { evaluation = parseReadyFrontierEvaluationV1(raw, this.#integrityKey); } catch { fail("integrity_failed"); }
      if (canonicalJson(evaluation) !== row.evaluation_json || row.cycle_id !== evaluation.cycleId
        || row.evaluated_at !== evaluation.evaluatedAt || row.source_digest !== evaluation.sourceDigest
        || row.policy_digest !== evaluation.policyDigest || row.evaluation_digest !== evaluation.evaluationDigest
        || evaluation.tenantId !== this.#tenantId
        || !same(row.record_auth_tag, hmacSha256Tag(this.#integrityKey, { tenantId: this.#tenantId,
          ledgerSequence: row.ledger_sequence, cycleId: row.cycle_id, evaluatedAt: row.evaluated_at,
          sourceDigest: row.source_digest, policyDigest: row.policy_digest, evaluationDigest: row.evaluation_digest }))) fail("integrity_failed");
      records.push({ row, evaluation });
    }
    const stateDigest = this.#computeStateDigest(rows);
    if (!same(metadata.state_digest, stateDigest) || !same(metadata.state_auth_tag,
      this.#stateTag(metadata.revision, metadata.record_count, stateDigest))) fail("integrity_failed");
    const checkpoint = this.#readCheckpoint();
    if (!checkpoint || rollbackCheckpointDigestV1(checkpoint) !== rollbackCheckpointDigestV1(this.#checkpoint(metadata.revision,
      metadata.record_count, metadata.state_digest, metadata.state_auth_tag))) fail("integrity_failed");
    return { metadata, records };
  }

  #metadata(): MetadataRowV1 | undefined {
    return this.#db.prepare("SELECT tenant_id,revision,record_count,state_digest,state_auth_tag FROM ready_frontier_metadata WHERE singleton=1")
      .get() as MetadataRowV1 | undefined;
  }
  #rows(): CycleRowV1[] {
    return this.#db.prepare(`SELECT ledger_sequence,cycle_id,evaluated_at,source_digest,policy_digest,evaluation_digest,evaluation_json,record_auth_tag
      FROM ready_frontier_cycle ORDER BY ledger_sequence`).all() as unknown as CycleRowV1[];
  }
  #computeStateDigest(rows: CycleRowV1[]): string {
    return sha256Digest({ tenantId: this.#tenantId, records: rows.map((row) => ({ ledgerSequence: row.ledger_sequence,
      cycleId: row.cycle_id, evaluatedAt: row.evaluated_at, sourceDigest: row.source_digest, policyDigest: row.policy_digest,
      evaluationDigest: row.evaluation_digest, recordAuthTag: row.record_auth_tag })) });
  }
  #stateTag(revision: number, recordCount: number, stateDigest: string): string {
    return hmacSha256Tag(this.#integrityKey, { tenantId: this.#tenantId, revision, recordCount, stateDigest });
  }
  #checkpointScope(): string { return `ready-frontier:${sha256Digest({ tenantId: this.#tenantId })}`; }
  #checkpoint(revision: number, recordCount: number, stateDigest: string, stateAuthTag: string): RollbackCheckpointV1 {
    return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: this.#checkpointScope(), revision, recordCount, stateDigest, stateAuthTag };
  }
  #readCheckpoint(): RollbackCheckpointV1 | undefined {
    try { return this.#checkpointRead(this.#checkpointScope()); } catch { fail("integrity_failed"); }
  }
}

const simulationEvaluation = ReadyFrontierSimulationStoreV1.prototype.evaluation;
Object.freeze(ReadyFrontierSimulationStoreV1.prototype);

/** Captures the exact registered simulation lookup without later dynamic dispatch through the caller-held store. */
export function bindReadyFrontierSimulationEvaluationV1(value: unknown):
  ((cycleId: string) => ReadyFrontierEvaluationV1 | undefined) | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !simulationStores.has(value)
    || Object.getPrototypeOf(value) !== ReadyFrontierSimulationStoreV1.prototype || !Object.isFrozen(value)) return undefined;
  const store = value as ReadyFrontierSimulationStoreV1;
  return (cycleId: string) => simulationEvaluation.call(store, cycleId);
}
