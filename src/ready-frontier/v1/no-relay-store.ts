import { timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateSqliteSchemaV1 } from "../../harness/codex-v1/private-sqlite-schema";
import { canonicalJson, hmacSha256Tag, ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1,
  sha256Digest, type RollbackCheckpointStoreV1, type RollbackCheckpointV1 } from "../../security";
import { exactHostDataSnapshotV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { bindReadyFrontierMaterializationServiceV1, type ReadyFrontierMaterializationServiceV1 } from "./materialization-service";
import { buildReadyFrontierNoRelayRunV1, parseReadyFrontierNoRelayRequestV1,
  parseReadyFrontierNoRelayRunV1, projectReadyFrontierNoRelayV1,
  READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1, validateReadyFrontierFakeDeliveryForRunV1 } from "./no-relay";
import { bindReadyFrontierFixedRepositoryClockV1, bindReadyFrontierInMemoryFakeDeliveryV1,
  parseReadyFrontierRepositoryClockV1, type ReadyFrontierFixedRepositoryClockV1,
  type ReadyFrontierInMemoryFakeDeliveryV1 } from "./no-relay-coordinator";
import { READY_FRONTIER_ACTIVATION_PACKET_V1, READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1,
  type ReadyFrontierActivationPacketV1, type ReadyFrontierFakeDeliveryRequestV1,
  type ReadyFrontierNoRelayProjectionV1, type ReadyFrontierNoRelayResultV1,
  type ReadyFrontierNoRelayRunStateV1, type ReadyFrontierNoRelayRunV1 } from "./no-relay-types";
import { parseExactReadyFrontierV1 } from "./exact";
import { readyFrontierDigestSchemaV1, readyFrontierIdSchemaV1, readyFrontierTimeSchemaV1 } from "./schemas";
import { readyFrontierActivationPacketSchemaV1 } from "./no-relay-schemas";
import { bindReadyFrontierPromotionServiceV1, type ReadyFrontierPromotionServiceV1 } from "./promotion-service";
import { READY_FRONTIER_PROMOTION_REQUEST_V1, type ReadyFrontierPromotionBuildInputV1 } from "./ready-policy-types";

interface MetadataRowV1 { tenant_id: string; workspace_id: string; revision: number; record_count: number;
  state_digest: string; state_auth_tag: string; }
interface RunRowV1 { run_id: string; version: number; state: ReadyFrontierNoRelayRunStateV1;
  request_digest: string; run_digest: string; updated_at: string; payload: string; record_auth_tag: string; }
export interface ReadyFrontierNoRelayStartV1 {
  runId: string; tenantId: string; workspaceId: string; projectId: string; requestDigest: string;
  materializationReceiptDigest: string; promotionReceiptDigest: string; jobId: string; routeId: string;
  handoffId: string; handoffPacketDigest: string; deliveryId: string; deliveryDeadline: string; startedAt: string;
}

const EXPECTED_OBJECTS = ["index:idx_frontier_no_relay_current", "table:frontier_no_relay_metadata",
  "table:frontier_no_relay_run"] as const;
const EXPECTED_COLUMNS = {
  frontier_no_relay_metadata: [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 }, { name: "tenant_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "workspace_id", type: "TEXT", notnull: 1, pk: 0 }, { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "record_count", type: "INTEGER", notnull: 1, pk: 0 }, { name: "state_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "state_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
  frontier_no_relay_run: [
    { name: "run_id", type: "TEXT", notnull: 1, pk: 1 }, { name: "version", type: "INTEGER", notnull: 1, pk: 2 },
    { name: "state", type: "TEXT", notnull: 1, pk: 0 }, { name: "request_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "run_digest", type: "TEXT", notnull: 1, pk: 0 }, { name: "updated_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "payload", type: "TEXT", notnull: 1, pk: 0 }, { name: "record_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
} as const;
const EXPECTED_SQL = {
  frontier_no_relay_metadata: "CREATE TABLE frontier_no_relay_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),record_count INTEGER NOT NULL CHECK(record_count>=0),state_digest TEXT NOT NULL,state_auth_tag TEXT NOT NULL)",
  frontier_no_relay_run: "CREATE TABLE frontier_no_relay_run(run_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),state TEXT NOT NULL CHECK(state IN ('delivery_started','acknowledged_repository_simulation','terminal_ambiguous','expired_before_delivery')),request_digest TEXT NOT NULL,run_digest TEXT NOT NULL UNIQUE,updated_at TEXT NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,PRIMARY KEY(run_id,version))",
  idx_frontier_no_relay_current: "CREATE INDEX idx_frontier_no_relay_current ON frontier_no_relay_run(run_id,version)",
} as const;

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
const noRelayStores = new WeakSet<object>();
const noRelayStoreCapabilities = new WeakMap<object, object>();
const activationEligibleRuns = new WeakSet<object>();
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right);
}
function prepare(path: string): void {
  if (!isAbsolute(path) || !process.getuid) fail("integrity_failed");
  const uid = process.getuid(), parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) fail("integrity_failed");
  try {
    const value = lstatSync(path);
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid || value.nlink !== 1
      || (value.mode & 0o077) !== 0) fail("integrity_failed");
  } catch (error) {
    if (error instanceof ReadyFrontierContractErrorV1) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") fail("integrity_failed");
    closeSync(openSync(path, "wx", 0o600));
  }
}

export class ReadyFrontierNoRelayStoreV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  readonly #checkpointRead: RollbackCheckpointStoreV1["read"];
  readonly #checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  readonly #checkpointAdvance: RollbackCheckpointStoreV1["advance"];
  readonly #tenantId: string;
  readonly #workspaceId: string;
  readonly #maximumRecords: number;
  #closed = false;

  constructor(path: string, tenantId: string, workspaceId: string,
    keyValue: unknown, checkpointStore: RollbackCheckpointStoreV1, maximumRecords = 1_000) {
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, tenantId);
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, workspaceId);
    const key = exactHostUint8ArrayV1(keyValue, 128);
    if (!key || key.byteLength < 32 || !Number.isSafeInteger(maximumRecords) || maximumRecords < 2
      || maximumRecords > 10_000) fail("integrity_failed");
    this.#tenantId = tenantId; this.#workspaceId = workspaceId; this.#maximumRecords = maximumRecords;
    this.#key = key.copy(); this.#checkpointRead = checkpointStore.read.bind(checkpointStore);
    this.#checkpointInitialize = checkpointStore.initialize.bind(checkpointStore);
    this.#checkpointAdvance = checkpointStore.advance.bind(checkpointStore);
    prepare(path); this.#db = new DatabaseSync(path);
    try {
      const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
      if (version !== 0 && version !== 1) fail("integrity_failed");
      this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
      if (version === 0) this.#db.exec(`CREATE TABLE frontier_no_relay_metadata(singleton INTEGER PRIMARY KEY CHECK(singleton=1),tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),record_count INTEGER NOT NULL CHECK(record_count>=0),state_digest TEXT NOT NULL,state_auth_tag TEXT NOT NULL);
        CREATE TABLE frontier_no_relay_run(run_id TEXT NOT NULL,version INTEGER NOT NULL CHECK(version>=1),state TEXT NOT NULL CHECK(state IN ('delivery_started','acknowledged_repository_simulation','terminal_ambiguous','expired_before_delivery')),request_digest TEXT NOT NULL,run_digest TEXT NOT NULL UNIQUE,updated_at TEXT NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,PRIMARY KEY(run_id,version));
        CREATE INDEX idx_frontier_no_relay_current ON frontier_no_relay_run(run_id,version); PRAGMA user_version=1;`);
      assertPrivateSqliteSchemaV1(this.#db, EXPECTED_OBJECTS, EXPECTED_COLUMNS, EXPECTED_SQL);
      this.initializeOrVerify();
      noRelayStores.add(this); noRelayStoreCapabilities.set(this, Object.freeze(Object.create(null))); Object.freeze(this);
    } catch (error) {
      this.#key.fill(0); this.#db.close(); if (error instanceof ReadyFrontierContractErrorV1) throw error;
      fail("integrity_failed");
    }
  }

  current(runIdValue: unknown): ReadyFrontierNoRelayRunV1 | undefined {
    const runId = parseExactReadyFrontierV1(readyFrontierIdSchemaV1, runIdValue);
    this.verify(); const row = this.currentRow(runId); return row ? this.verified(row) : undefined;
  }

  canStart(state: "delivery_started" | "expired_before_delivery"): boolean {
    if (state !== "delivery_started" && state !== "expired_before_delivery") fail("invalid_input");
    this.verify(); return this.rows().length + (state === "delivery_started" ? 2 : 1) <= this.#maximumRecords;
  }

  begin(capability: unknown, input: ReadyFrontierNoRelayStartV1, state: "delivery_started" | "expired_before_delivery"):
    { run: ReadyFrontierNoRelayRunV1; replayed: boolean } {
    this.authorize(capability); this.open(); this.verify();
    const existing = this.current(input.runId);
    if (existing) {
      const first = this.firstRow(input.runId);
      if (!first || this.verified(first).state !== state
        || existing.requestDigest !== input.requestDigest || existing.tenantId !== input.tenantId
        || existing.workspaceId !== input.workspaceId || existing.projectId !== input.projectId
        || existing.materializationReceiptDigest !== input.materializationReceiptDigest
        || existing.promotionReceiptDigest !== input.promotionReceiptDigest || existing.jobId !== input.jobId
        || existing.routeId !== input.routeId || existing.handoffId !== input.handoffId
        || existing.handoffPacketDigest !== input.handoffPacketDigest || existing.deliveryId !== input.deliveryId
        || existing.deliveryDeadline !== input.deliveryDeadline || existing.startedAt !== input.startedAt) fail("replay_drift");
      return { run: existing, replayed: true };
    }
    const requiredRecords = state === "delivery_started" ? 2 : 1;
    if (this.rows().length + requiredRecords > this.#maximumRecords) fail("capacity_exceeded");
    if (input.tenantId !== this.#tenantId || input.workspaceId !== this.#workspaceId) fail("scope_mismatch");
    parseExactReadyFrontierV1(readyFrontierDigestSchemaV1, input.requestDigest);
    parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, input.startedAt);
    const run = buildReadyFrontierNoRelayRunV1({ ...input, deliveryAttemptCount: 1,
      state, safeReason: state === "delivery_started" ? "delivery_outcome_ambiguous" : "delivery_window_expired",
      updatedAt: input.startedAt, acknowledgedAt: null, acknowledgementDigest: null,
      repositorySimulationOnly: true, createsAttempt: false, createsLease: false, claimsJob: false,
      dispatchesOrExecutes: false, contactsProvider: false, messagesAgent: false, mutatesGitHub: false,
      grantsExternalEffect: false }, this.#key);
    return this.transaction(() => { this.insert(run, 1); this.advance(); return { run, replayed: false }; });
  }

  complete(capability: unknown, runIdValue: unknown, requestDigestValue: unknown, input: { state: "acknowledged_repository_simulation"
    | "terminal_ambiguous"; updatedAt: string; acknowledgementDigest?: string }): ReadyFrontierNoRelayRunV1 {
    this.authorize(capability);
    const runId = parseExactReadyFrontierV1(readyFrontierIdSchemaV1, runIdValue),
      requestDigest = parseExactReadyFrontierV1(readyFrontierDigestSchemaV1, requestDigestValue),
      updatedAt = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, input.updatedAt);
    this.open(); this.verify(); const prior = this.current(runId);
    if (!prior || prior.requestDigest !== requestDigest) fail("replay_drift");
    if (prior.state !== "delivery_started") {
      const acknowledgementDigest = input.state === "acknowledged_repository_simulation"
        ? parseExactReadyFrontierV1(readyFrontierDigestSchemaV1, input.acknowledgementDigest) : undefined;
      if (prior.state === input.state && prior.updatedAt === updatedAt
        && (input.state !== "acknowledged_repository_simulation"
          || prior.acknowledgementDigest === acknowledgementDigest)) return prior;
      fail("replay_drift");
    }
    const acknowledgementDigest = input.state === "acknowledged_repository_simulation"
      ? parseExactReadyFrontierV1(readyFrontierDigestSchemaV1, input.acknowledgementDigest) : null;
    const { schema: _schema, runDigest: _runDigest, runAuthTag: _runAuthTag, ...priorUnsigned } = prior;
    void _schema; void _runDigest; void _runAuthTag;
    const next = buildReadyFrontierNoRelayRunV1({ ...priorUnsigned, state: input.state,
      safeReason: input.state === "acknowledged_repository_simulation" ? "fake_handoff_acknowledged" : "delivery_outcome_ambiguous",
      updatedAt, acknowledgedAt: input.state === "acknowledged_repository_simulation" ? updatedAt : null,
      acknowledgementDigest }, this.#key);
    if (this.rows().length + 1 > this.#maximumRecords) fail("capacity_exceeded");
    return this.transaction(() => { this.insert(next, 2); this.advance(); return next; });
  }

  recoverUnsettled(capability: unknown, recoveredAtValue: unknown): ReadyFrontierNoRelayRunV1[] {
    this.authorize(capability);
    const recoveredAt = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, recoveredAtValue);
    this.verify(); const recovered: ReadyFrontierNoRelayRunV1[] = [];
    for (const run of this.listCurrent()) if (run.state === "delivery_started") {
      recovered.push(this.complete(capability, run.runId, run.requestDigest,
        { state: "terminal_ambiguous", updatedAt: recoveredAt }));
    }
    return recovered;
  }

  listCurrent(): ReadyFrontierNoRelayRunV1[] {
    this.verify(); return this.#db.prepare(`SELECT r.* FROM frontier_no_relay_run r JOIN
      (SELECT run_id,max(version) version FROM frontier_no_relay_run GROUP BY run_id) c
      ON c.run_id=r.run_id AND c.version=r.version ORDER BY r.run_id`).all()
      .map((row) => this.verified(row as unknown as RunRowV1));
  }

  closeDatabase(): void { if (!this.#closed) { this.#key.fill(0); this.#db.close(); this.#closed = true; } }

  private initializeOrVerify(): void {
    const metadata = this.metadata(), checkpoint = this.readCheckpoint();
    if (!metadata) {
      if (this.rows().length !== 0 || checkpoint) fail("integrity_failed");
      const revision = 1, recordCount = 0, stateDigest = this.stateDigest([]),
        stateAuthTag = this.stateTag(revision, recordCount, stateDigest);
      this.#db.prepare("INSERT INTO frontier_no_relay_metadata VALUES(1,?,?,?,?,?,?)")
        .run(this.#tenantId, this.#workspaceId, revision, recordCount, stateDigest, stateAuthTag);
      try { this.#checkpointInitialize(this.checkpoint(revision, recordCount, stateDigest, stateAuthTag)); }
      catch { fail("integrity_failed"); }
    } else this.verify();
  }

  private verify(): { metadata: MetadataRowV1; rows: RunRowV1[] } {
    this.open(); const metadata = this.metadata(), rows = this.rows();
    if (!metadata || metadata.tenant_id !== this.#tenantId || metadata.workspace_id !== this.#workspaceId
      || metadata.record_count !== rows.length || metadata.revision !== rows.length + 1) fail("integrity_failed");
    const prior = new Map<string, ReadyFrontierNoRelayRunV1>();
    for (const row of rows) {
      const run = this.verified(row), previous = prior.get(run.runId);
      if (row.version === 1) {
        if (previous || (run.state !== "delivery_started" && run.state !== "expired_before_delivery")) fail("integrity_failed");
      } else if (row.version !== 2 || !previous || previous.state !== "delivery_started"
        || (run.state !== "acknowledged_repository_simulation" && run.state !== "terminal_ambiguous")
        || run.requestDigest !== previous.requestDigest || run.deliveryId !== previous.deliveryId
        || run.promotionReceiptDigest !== previous.promotionReceiptDigest
        || Date.parse(run.updatedAt) < Date.parse(previous.updatedAt)) fail("integrity_failed");
      prior.set(run.runId, run);
    }
    const stateDigest = this.stateDigest(rows);
    if (!same(metadata.state_digest, stateDigest)
      || !same(metadata.state_auth_tag, this.stateTag(metadata.revision, metadata.record_count, stateDigest))) fail("integrity_failed");
    const checkpoint = this.readCheckpoint();
    if (!checkpoint || rollbackCheckpointDigestV1(checkpoint) !== rollbackCheckpointDigestV1(
      this.checkpoint(metadata.revision, metadata.record_count, stateDigest, metadata.state_auth_tag))) fail("integrity_failed");
    return { metadata, rows };
  }

  private insert(run: ReadyFrontierNoRelayRunV1, version: number): void {
    const payload = canonicalJson(run), recordAuthTag = hmacSha256Tag(this.#key, { tenantId: this.#tenantId,
      workspaceId: this.#workspaceId, runId: run.runId, version, state: run.state,
      requestDigest: run.requestDigest, runDigest: run.runDigest, updatedAt: run.updatedAt,
      payloadDigest: sha256Digest(run) });
    this.#db.prepare("INSERT INTO frontier_no_relay_run VALUES(?,?,?,?,?,?,?,?)")
      .run(run.runId, version, run.state, run.requestDigest, run.runDigest, run.updatedAt, payload, recordAuthTag);
  }

  private verified(row: RunRowV1): ReadyFrontierNoRelayRunV1 {
    let raw: unknown; try { raw = JSON.parse(row.payload); } catch { fail("integrity_failed"); }
    let run: ReadyFrontierNoRelayRunV1;
    try { run = parseReadyFrontierNoRelayRunV1(raw, this.#key); } catch { fail("integrity_failed"); }
    const expected = hmacSha256Tag(this.#key, { tenantId: this.#tenantId, workspaceId: this.#workspaceId,
      runId: row.run_id, version: Number(row.version), state: row.state, requestDigest: row.request_digest,
      runDigest: row.run_digest, updatedAt: row.updated_at, payloadDigest: sha256Digest(run) });
    if (canonicalJson(run) !== row.payload || run.runId !== row.run_id || run.state !== row.state
      || run.requestDigest !== row.request_digest || run.runDigest !== row.run_digest || run.updatedAt !== row.updated_at
      || run.tenantId !== this.#tenantId || run.workspaceId !== this.#workspaceId
      || !same(row.record_auth_tag, expected)) fail("integrity_failed");
    return run;
  }

  private advance(): void {
    const metadata = this.metadata(); if (!metadata) fail("integrity_failed");
    const rows = this.rows(), revision = metadata.revision + 1, recordCount = rows.length,
      stateDigest = this.stateDigest(rows), stateAuthTag = this.stateTag(revision, recordCount, stateDigest);
    const result = this.#db.prepare(`UPDATE frontier_no_relay_metadata SET revision=?,record_count=?,state_digest=?,
      state_auth_tag=? WHERE singleton=1 AND revision=?`).run(revision, recordCount, stateDigest, stateAuthTag, metadata.revision);
    if (Number(result.changes) !== 1) fail("integrity_failed");
    try { this.#checkpointAdvance(rollbackCheckpointDigestV1(this.checkpoint(metadata.revision,
      metadata.record_count, metadata.state_digest, metadata.state_auth_tag)),
    this.checkpoint(revision, recordCount, stateDigest, stateAuthTag)); } catch { fail("integrity_failed"); }
  }

  private metadata(): MetadataRowV1 | undefined {
    const row = this.#db.prepare("SELECT tenant_id,workspace_id,revision,record_count,state_digest,state_auth_tag FROM frontier_no_relay_metadata WHERE singleton=1")
      .get() as MetadataRowV1 | undefined;
    return row ? { ...row, revision: Number(row.revision), record_count: Number(row.record_count) } : undefined;
  }
  private rows(): RunRowV1[] { return this.#db.prepare("SELECT * FROM frontier_no_relay_run ORDER BY run_id,version").all() as unknown as RunRowV1[]; }
  private currentRow(runId: string): RunRowV1 | undefined {
    return this.#db.prepare("SELECT * FROM frontier_no_relay_run WHERE run_id=? ORDER BY version DESC LIMIT 1").get(runId) as RunRowV1 | undefined;
  }
  private firstRow(runId: string): RunRowV1 | undefined {
    return this.#db.prepare("SELECT * FROM frontier_no_relay_run WHERE run_id=? AND version=1").get(runId) as RunRowV1 | undefined;
  }
  private stateDigest(rows: RunRowV1[]): string { return sha256Digest({ tenantId: this.#tenantId, workspaceId: this.#workspaceId,
    records: rows.map((row) => ({ runId: row.run_id, version: Number(row.version), state: row.state,
      requestDigest: row.request_digest, runDigest: row.run_digest, updatedAt: row.updated_at,
      recordAuthTag: row.record_auth_tag })) }); }
  private stateTag(revision: number, recordCount: number, stateDigest: string): string {
    return hmacSha256Tag(this.#key, { tenantId: this.#tenantId, workspaceId: this.#workspaceId,
      revision, recordCount, stateDigest });
  }
  private checkpointScope(): string { return `ready-frontier-no-relay:${sha256Digest({ tenantId: this.#tenantId,
    workspaceId: this.#workspaceId })}`; }
  private checkpoint(revision: number, recordCount: number, stateDigest: string,
    stateAuthTag: string): RollbackCheckpointV1 { return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1,
      scope: this.checkpointScope(), revision, recordCount, stateDigest, stateAuthTag }; }
  private readCheckpoint(): RollbackCheckpointV1 | undefined {
    try { return this.#checkpointRead(this.checkpointScope()); } catch { fail("integrity_failed"); }
  }
  private open(): void { if (this.#closed) fail("integrity_failed"); }
  private authorize(capability: unknown): void {
    if (!capability || typeof capability !== "object" || isHostProxyV1(capability)
      || noRelayStoreCapabilities.get(this) !== capability) fail("policy_denied");
  }
  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE"); try { const result = operation(); this.#db.exec("COMMIT"); return result; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { /* preserve the originating failure */ } throw error; }
  }
}

const noRelayStoreCurrent = ReadyFrontierNoRelayStoreV1.prototype.current;
const noRelayStoreCanStart = ReadyFrontierNoRelayStoreV1.prototype.canStart;
const noRelayStoreBegin = ReadyFrontierNoRelayStoreV1.prototype.begin;
const noRelayStoreComplete = ReadyFrontierNoRelayStoreV1.prototype.complete;
const noRelayStoreRecover = ReadyFrontierNoRelayStoreV1.prototype.recoverUnsettled;
const noRelayStoreList = ReadyFrontierNoRelayStoreV1.prototype.listCurrent;
Object.freeze(ReadyFrontierNoRelayStoreV1.prototype);

/** Builds a blocked packet only for the exact acknowledged run object returned by the composed coordinator. */
export function buildReadyFrontierActivationPacketV1(input: { packetId: string; run: ReadyFrontierNoRelayRunV1;
  createdAt: string }, runIntegrityKeyValue: unknown, packetIntegrityKeyValue: unknown): ReadyFrontierActivationPacketV1 {
  const snapshot = exactHostDataSnapshotV1(input, ["packetId", "run", "createdAt"]);
  if (!snapshot) fail("invalid_input");
  if (!snapshot.run || typeof snapshot.run !== "object" || isHostProxyV1(snapshot.run)
    || !activationEligibleRuns.has(snapshot.run)) fail("policy_denied");
  const packetId = parseExactReadyFrontierV1(readyFrontierIdSchemaV1, snapshot.packetId);
  const createdAt = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, snapshot.createdAt);
  const run = parseReadyFrontierNoRelayRunV1(snapshot.run, runIntegrityKeyValue);
  if (run.state !== "acknowledged_repository_simulation" || Date.parse(createdAt) < Date.parse(run.updatedAt)) fail("policy_denied");
  const packetKeyView = exactHostUint8ArrayV1(packetIntegrityKeyValue, 128);
  if (!packetKeyView || packetKeyView.byteLength < 32) fail("integrity_failed");
  const packetKey = packetKeyView.copy();
  try {
    const unsigned = parseExactReadyFrontierV1(readyFrontierActivationPacketSchemaV1.omit({ packetDigest: true,
      packetAuthTag: true }), { schema: READY_FRONTIER_ACTIVATION_PACKET_V1, packetId,
      tenantId: run.tenantId, workspaceId: run.workspaceId, simulationRunId: run.runId,
      simulationRunDigest: run.runDigest, acceptedAuto030Commit: "adf0804a52a13d544192afc90506c3e989254ffd",
      acceptedAuto030ReviewSha256: "sha256:18df9e9611c5f9053962b776b8261304512b98244ba7b627fd99f4821a79fa2",
      requiredProductionGateCodes: [...READY_FRONTIER_PRODUCTION_ACTIVATION_GATES_V1],
      state: "blocked_pending_production_proof", createdAt, repositorySimulationOnly: true,
      productionOwnerApprovalPresent: false, productionPolicyEnrolled: false, productionConsumerQualified: false,
      productionDatabaseQualified: false, canActivateItself: false, permitsProtectedMaterial: false, permitsNetwork: false,
      permitsGitHubMutation: false, permitsAgentOrProviderContact: false, permitsDispatchOrExecution: false,
      permitsExternalEffects: false });
    const withDigest = { ...unsigned, packetDigest: sha256Digest(unsigned) };
    return parseExactReadyFrontierV1(readyFrontierActivationPacketSchemaV1, { ...withDigest,
      packetAuthTag: hmacSha256Tag(packetKey, { packetId: withDigest.packetId,
        simulationRunDigest: withDigest.simulationRunDigest, packetDigest: withDigest.packetDigest }) }) as ReadyFrontierActivationPacketV1;
  } finally { packetKey.fill(0); }
}

/**
 * Repository-only end-to-end coordinator. Every collaborator is captured into an ECMAScript-private closure
 * after exact registration; no writable runtime property can replace a validated service, store, fake, or clock.
 */
export class ReadyFrontierNoRelayCoordinatorV1 {
  readonly #activeRuns = new Set<string>();
  readonly #runIntegrityKey: Uint8Array;
  readonly #store: ReadyFrontierNoRelayStoreV1;
  readonly #storeCapability: object;
  readonly #materialize: NonNullable<ReturnType<typeof bindReadyFrontierMaterializationServiceV1>>;
  readonly #promote: NonNullable<ReturnType<typeof bindReadyFrontierPromotionServiceV1>>;
  readonly #deliver: NonNullable<ReturnType<typeof bindReadyFrontierInMemoryFakeDeliveryV1>>;
  readonly #now: () => string;

  constructor(materializer: ReadyFrontierMaterializationServiceV1,
    promoter: ReadyFrontierPromotionServiceV1, store: ReadyFrontierNoRelayStoreV1,
    fakeDelivery: ReadyFrontierInMemoryFakeDeliveryV1,
    deliveryClock: ReadyFrontierFixedRepositoryClockV1, runIntegrityKeyValue: unknown) {
    const runIntegrityKey = exactHostUint8ArrayV1(runIntegrityKeyValue, 128);
    const materialize = bindReadyFrontierMaterializationServiceV1(materializer);
    const promote = bindReadyFrontierPromotionServiceV1(promoter);
    const deliver = bindReadyFrontierInMemoryFakeDeliveryV1(fakeDelivery);
    const now = bindReadyFrontierFixedRepositoryClockV1(deliveryClock);
    const storeCapability = !store || typeof store !== "object" || isHostProxyV1(store)
      || !noRelayStores.has(store) || Object.getPrototypeOf(store) !== ReadyFrontierNoRelayStoreV1.prototype
      || !Object.isFrozen(store) ? undefined : noRelayStoreCapabilities.get(store);
    if (!runIntegrityKey || runIntegrityKey.byteLength < 32 || !materialize || !promote || !deliver || !now
      || !storeCapability) fail("policy_denied");
    this.#runIntegrityKey = runIntegrityKey.copy(); this.#materialize = materialize; this.#promote = promote;
    this.#store = store; this.#storeCapability = storeCapability; this.#deliver = deliver; this.#now = now;
    Object.freeze(this);
  }

  async run(value: unknown): Promise<ReadyFrontierNoRelayResultV1> {
    const request = parseReadyFrontierNoRelayRequestV1(value), requestDigest = sha256Digest(request);
    if (this.#activeRuns.has(request.runId)) fail("policy_inactive");
    const existing = noRelayStoreCurrent.call(this.#store, request.runId);
    if (existing) {
      if (existing.requestDigest !== requestDigest) fail("replay_drift");
      if (existing.state === "delivery_started") {
        const recovered = noRelayStoreComplete.call(this.#store, this.#storeCapability,
          existing.runId, existing.requestDigest, { state: "terminal_ambiguous",
            updatedAt: Date.parse(request.observedAt) < Date.parse(existing.updatedAt)
              ? existing.updatedAt : request.observedAt });
        return { run: recovered, materializationReplayed: true, promotionReplayed: true, runReplayed: true };
      }
      if (existing.state === "acknowledged_repository_simulation") activationEligibleRuns.add(Object.freeze(existing));
      return { run: existing, materializationReplayed: true, promotionReplayed: true, runReplayed: true };
    }
    this.#activeRuns.add(request.runId);
    try {
      const deliveryPreflightNow = this.readDeliveryClock();
      if (Date.parse(deliveryPreflightNow) < Date.parse(request.promotedAt)) fail("replay_drift");
      const preflightState = Date.parse(deliveryPreflightNow) >= Date.parse(request.deliveryDeadline)
        ? "expired_before_delivery" as const : "delivery_started" as const;
      if (!noRelayStoreCanStart.call(this.#store, preflightState)) fail("capacity_exceeded");
      const materialization = await this.#materialize(request.materializationRequest), materialized = materialization.receipt;
      const promotionInput: ReadyFrontierPromotionBuildInputV1 = {
        request: { schema: READY_FRONTIER_PROMOTION_REQUEST_V1, requestId: request.promotionRequestId,
          tenantId: materialized.tenantId, workspaceId: materialized.workspaceId,
          materializationReceiptId: materialized.receiptId, materializationReceiptDigest: materialized.receiptDigest,
          jobId: materialized.job.id, standingPolicyId: materialized.standingPolicyId,
          standingPolicyRevision: materialized.standingPolicyRevision,
          standingPolicyDigest: materialized.standingPolicyDigest, readyPolicyId: request.readyPolicyId,
          readyPolicyRevision: request.readyPolicyRevision, readyPolicyDigest: request.readyPolicyDigest,
          requestedAt: request.promotionRequestedAt, promotedAt: request.promotedAt,
          reservationExpiresAt: request.reservationExpiresAt,
          trigger: "standing_ready_policy_repository_simulation", repositorySimulationOnly: true,
          createsApproval: false, createsSchedule: false, permitsReadyTransition: true,
          permitsDatabaseSchedulerReservation: true, permitsInternalJobberHandoff: true,
          permitsClaimOrLease: false, permitsDispatchOrExecution: false, permitsProviderContact: false,
          permitsAgentMessage: false, permitsGitHubMutation: false, permitsExternalEffects: false },
        materializationReceipt: materialized,
      };
      const promotion = await this.#promote(promotionInput), receipt = promotion.receipt;
      if (receipt.tenantId !== request.tenantId || receipt.workspaceId !== request.workspaceId) fail("scope_mismatch");
      const deliveryId = `frontier.fake-delivery:${sha256Digest({ runId: request.runId,
        handoffPacketDigest: receipt.handoff.packetDigest }).slice(7, 31)}`;
      const deliveryNow = this.readDeliveryClock();
      if (Date.parse(deliveryNow) < Date.parse(deliveryPreflightNow)
        || Date.parse(deliveryNow) < Date.parse(receipt.promotedAt)) fail("replay_drift");
      const delivery: ReadyFrontierFakeDeliveryRequestV1 = {
        schema: READY_FRONTIER_FAKE_DELIVERY_REQUEST_V1, runId: request.runId, deliveryId,
        tenantId: receipt.tenantId, workspaceId: receipt.workspaceId, projectId: receipt.readyJob.projectId,
        jobId: receipt.readyJob.id, routeId: receipt.handoff.routeId, handoffId: receipt.handoff.handoffId,
        handoffPacketDigest: receipt.handoff.packetDigest, promotionReceiptDigest: receipt.receiptDigest,
        deliveryStartedAt: deliveryNow, deliveryDeadline: request.deliveryDeadline,
        transport: "injected_fake", repositorySimulationOnly: true,
        createsAttempt: false, createsLease: false, claimsJob: false, dispatchesOrExecutes: false,
        contactsProvider: false, messagesAgent: false, mutatesGitHub: false, grantsExternalEffect: false,
      };
      const start = { runId: request.runId, tenantId: receipt.tenantId, workspaceId: receipt.workspaceId,
        projectId: receipt.readyJob.projectId, requestDigest, materializationReceiptDigest: materialized.receiptDigest,
        promotionReceiptDigest: receipt.receiptDigest, jobId: receipt.readyJob.id, routeId: receipt.handoff.routeId,
        handoffId: receipt.handoff.handoffId, handoffPacketDigest: receipt.handoff.packetDigest,
        deliveryId, deliveryDeadline: request.deliveryDeadline, startedAt: deliveryNow };
      const began = noRelayStoreBegin.call(this.#store, this.#storeCapability, start,
        Date.parse(deliveryNow) >= Date.parse(request.deliveryDeadline) ? "expired_before_delivery" : "delivery_started");
      if (began.replayed || began.run.state !== "delivery_started") return { run: began.run,
        materializationReplayed: materialization.replayed, promotionReplayed: promotion.replayed,
        runReplayed: began.replayed };
      let acknowledgement: ReturnType<typeof validateReadyFrontierFakeDeliveryForRunV1>;
      try {
        acknowledgement = validateReadyFrontierFakeDeliveryForRunV1(delivery,
          await this.#deliver.deliver(Object.freeze(delivery)));
      } catch (error) {
        if (this.#deliver.isRepositoryInterruption(error)) throw error;
        const ambiguous = noRelayStoreComplete.call(this.#store, this.#storeCapability,
          request.runId, requestDigest, { state: "terminal_ambiguous", updatedAt: this.safeNow(deliveryNow) });
        return { run: ambiguous, materializationReplayed: materialization.replayed,
          promotionReplayed: promotion.replayed, runReplayed: false };
      }
      const completed = noRelayStoreComplete.call(this.#store, this.#storeCapability,
        request.runId, requestDigest, { state: "acknowledged_repository_simulation",
          updatedAt: acknowledgement.acknowledgedAt,
          acknowledgementDigest: acknowledgement.acknowledgementDigest });
      activationEligibleRuns.add(Object.freeze(completed));
      return { run: completed, materializationReplayed: materialization.replayed,
        promotionReplayed: promotion.replayed, runReplayed: false };
    } finally { this.#activeRuns.delete(request.runId); }
  }

  recoverUnsettled(recoveredAt: unknown): ReadyFrontierNoRelayRunV1[] {
    return noRelayStoreRecover.call(this.#store, this.#storeCapability, recoveredAt);
  }
  projection(tenantId: string): ReadyFrontierNoRelayProjectionV1 {
    return projectReadyFrontierNoRelayV1({ tenantId, runs: noRelayStoreList.call(this.#store) }, this.#runIntegrityKey);
  }
  close(): void { this.#runIntegrityKey.fill(0); }
  private readDeliveryClock(): string { return parseReadyFrontierRepositoryClockV1(this.#now); }
  private safeNow(fallback: string): string {
    try { const now = parseReadyFrontierRepositoryClockV1(this.#now);
      return Date.parse(now) < Date.parse(fallback) ? fallback : now; }
    catch { return fallback; }
  }
}

Object.freeze(ReadyFrontierNoRelayCoordinatorV1.prototype);
