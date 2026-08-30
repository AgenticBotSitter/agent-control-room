import { timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateSqliteSchemaV1 } from "../../harness/codex-v1/private-sqlite-schema";
import { bindInMemoryRollbackCheckpointStoreV1, canonicalJson, hmacSha256Tag, ROLLBACK_CHECKPOINT_SCHEMA_V1, rollbackCheckpointDigestV1, sha256Digest,
  type RollbackCheckpointStoreV1, type RollbackCheckpointV1 } from "../../security";
import { exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { parseReadyFrontierReadyPolicyV1 } from "./ready-policy";
import { readyFrontierDigestSchemaV1, readyFrontierIdSchemaV1 } from "./schemas";
import type { ReadyFrontierReadyPolicyV1 } from "./ready-policy-types";

interface MetadataRowV1 { tenant_id: string; workspace_id: string; revision: number; record_count: number; state_digest: string; state_auth_tag: string; }
interface PolicyRowV1 { ledger_sequence: number; policy_id: string; policy_revision: number; policy_state: string;
  policy_digest: string; recorded_at: string; policy_json: string; record_auth_tag: string; }

const EXPECTED_OBJECTS = ["index:idx_frontier_ready_policy_identity", "table:frontier_ready_policy_metadata",
  "table:frontier_ready_policy_record"] as const;
const EXPECTED_COLUMNS = {
  frontier_ready_policy_metadata: [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 }, { name: "tenant_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "workspace_id", type: "TEXT", notnull: 1, pk: 0 }, { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "record_count", type: "INTEGER", notnull: 1, pk: 0 }, { name: "state_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "state_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
  frontier_ready_policy_record: [
    { name: "ledger_sequence", type: "INTEGER", notnull: 0, pk: 1 }, { name: "policy_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "policy_revision", type: "INTEGER", notnull: 1, pk: 0 }, { name: "policy_state", type: "TEXT", notnull: 1, pk: 0 },
    { name: "policy_digest", type: "TEXT", notnull: 1, pk: 0 }, { name: "recorded_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "policy_json", type: "TEXT", notnull: 1, pk: 0 }, { name: "record_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
} as const;
const EXPECTED_SQL = {
  frontier_ready_policy_metadata: `CREATE TABLE frontier_ready_policy_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
    state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76)
  )`,
  frontier_ready_policy_record: `CREATE TABLE frontier_ready_policy_record (
    ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL CHECK(policy_revision>=1),
    policy_state TEXT NOT NULL CHECK(policy_state IN ('active','suspended','revoked')), policy_digest TEXT NOT NULL CHECK(length(policy_digest)=71),
    recorded_at TEXT NOT NULL, policy_json TEXT NOT NULL, record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76),
    UNIQUE(policy_id,policy_revision), UNIQUE(policy_digest)
  )`,
  idx_frontier_ready_policy_identity: "CREATE INDEX idx_frontier_ready_policy_identity ON frontier_ready_policy_record(policy_id,policy_revision)",
} as const;

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never { throw new ReadyFrontierContractErrorV1(code); }
function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right);
}
const activeReadyPolicyGuards = new WeakMap<object, { policyId: string; revision: number; policyDigest: string }>();
export function authorizesReadyFrontierReadyPolicyGuardV1(value: unknown, policyId: string,
  revision: number, policyDigest: string): boolean {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return false;
  const binding = activeReadyPolicyGuards.get(value as object);
  return binding?.policyId === policyId && binding.revision === revision && binding.policyDigest === policyDigest;
}
function prepare(path: string): void {
  if (!isAbsolute(path) || !process.getuid) fail("integrity_failed");
  const uid = process.getuid(), parent = statSync(dirname(path));
  if (!parent.isDirectory() || parent.uid !== uid || (parent.mode & 0o077) !== 0) fail("integrity_failed");
  try {
    const value = lstatSync(path);
    if (!value.isFile() || value.isSymbolicLink() || value.uid !== uid || value.nlink !== 1 || (value.mode & 0o077) !== 0) fail("integrity_failed");
  } catch (error) {
    if (error instanceof ReadyFrontierContractErrorV1) throw error;
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") fail("integrity_failed");
    closeSync(openSync(path, "wx", 0o600));
  }
}

const readyPolicyStores = new WeakSet<object>();

export class ReadyFrontierReadyPolicyStoreV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  #operationActive = false;
  #pendingGuardOperations = 0;
  #guardTail: Promise<void> = Promise.resolve();
  readonly #checkpointRead: RollbackCheckpointStoreV1["read"];
  readonly #checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  readonly #checkpointAdvance: RollbackCheckpointStoreV1["advance"];
  readonly #tenantId: string;
  readonly #workspaceId: string;
  readonly #maximumRecords: number;

  constructor(path: string, tenantId: string, workspaceId: string, keyValue: unknown,
    checkpointStore: RollbackCheckpointStoreV1, maximumRecords = 1_000) {
    const key = exactHostUint8ArrayV1(keyValue, 128);
    if (!key || key.byteLength < 32 || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 10_000) fail("integrity_failed");
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, tenantId); parseExactReadyFrontierV1(readyFrontierIdSchemaV1, workspaceId);
    const checkpoint = bindInMemoryRollbackCheckpointStoreV1(checkpointStore);
    if (!checkpoint) fail("integrity_failed");
    this.#tenantId = tenantId; this.#workspaceId = workspaceId; this.#maximumRecords = maximumRecords;
    this.#key = key.copy(); this.#checkpointRead = checkpoint.read;
    this.#checkpointInitialize = checkpoint.initialize;
    this.#checkpointAdvance = checkpoint.advance;
    prepare(path); this.#db = new DatabaseSync(path);
    try {
      const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1) fail("integrity_failed");
      this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
      if (version === 0) this.#db.exec(`CREATE TABLE frontier_ready_policy_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
        state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76));
        CREATE TABLE frontier_ready_policy_record (
        ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1), policy_id TEXT NOT NULL, policy_revision INTEGER NOT NULL CHECK(policy_revision>=1),
        policy_state TEXT NOT NULL CHECK(policy_state IN ('active','suspended','revoked')), policy_digest TEXT NOT NULL CHECK(length(policy_digest)=71),
        recorded_at TEXT NOT NULL, policy_json TEXT NOT NULL, record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76),
        UNIQUE(policy_id,policy_revision), UNIQUE(policy_digest));
        CREATE INDEX idx_frontier_ready_policy_identity ON frontier_ready_policy_record(policy_id,policy_revision); PRAGMA user_version=1;`);
      assertPrivateSqliteSchemaV1(this.#db, EXPECTED_OBJECTS, EXPECTED_COLUMNS, EXPECTED_SQL); this.#initializeOrVerify();
    } catch (error) {
      this.#key.fill(0); this.#db.close(); if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("integrity_failed");
    }
    readyPolicyStores.add(this); Object.freeze(this);
  }

  recordPolicy(value: unknown): { policy: ReadyFrontierReadyPolicyV1; replayed: boolean } {
    const policy = parseReadyFrontierReadyPolicyV1(value, this.#key);
    if (policy.tenantId !== this.#tenantId || policy.workspaceId !== this.#workspaceId) fail("scope_mismatch");
    if (this.#operationActive || this.#pendingGuardOperations > 0) fail("policy_inactive");
    this.#operationActive = true; let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE"); began = true;
      const current = this.#verify();
      const exact = current.policies.find((item) => item.policy.policyId === policy.policyId && item.policy.revision === policy.revision);
      if (exact) {
        if (!same(exact.policy.policyDigest, policy.policyDigest)) fail("replay_drift");
        this.#db.exec("COMMIT"); return { policy: exact.policy, replayed: true };
      }
      if (current.metadata.record_count >= this.#maximumRecords) fail("capacity_exceeded");
      const prior = [...current.policies].reverse().find((item) => item.policy.policyId === policy.policyId)?.policy;
      if (!prior) {
        if (policy.revision !== 1 || policy.previousPolicyDigest !== null) fail("replay_drift");
      } else {
        if (prior.state === "revoked" || policy.revision !== prior.revision + 1 || policy.previousPolicyDigest !== prior.policyDigest
          || Date.parse(policy.recordedAt) <= Date.parse(prior.recordedAt)) fail("replay_drift");
        if ((policy.action === "suspend" || policy.action === "revoke")
          && (policy.policyCeilingDigest !== prior.policyCeilingDigest
            || policy.parentStandingPolicyDigest !== prior.parentStandingPolicyDigest)) fail("policy_denied");
      }
      const ledgerSequence = current.metadata.record_count + 1;
      const material = { tenantId: this.#tenantId, workspaceId: this.#workspaceId, ledgerSequence,
        policyId: policy.policyId, policyRevision: policy.revision, policyState: policy.state,
        policyDigest: policy.policyDigest, recordedAt: policy.recordedAt };
      this.#db.prepare(`INSERT INTO frontier_ready_policy_record(ledger_sequence,policy_id,policy_revision,policy_state,policy_digest,recorded_at,policy_json,record_auth_tag)
        VALUES(?,?,?,?,?,?,?,?)`).run(ledgerSequence, policy.policyId, policy.revision, policy.state, policy.policyDigest,
        policy.recordedAt, canonicalJson(policy), hmacSha256Tag(this.#key, material));
      const rows = this.#rows(), revision = current.metadata.revision + 1, count = current.metadata.record_count + 1;
      const digest = this.#stateDigest(rows), tag = this.#stateTag(revision, count, digest);
      this.#db.prepare("UPDATE frontier_ready_policy_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE singleton=1")
        .run(revision, count, digest, tag);
      this.#checkpointAdvance(rollbackCheckpointDigestV1(this.#checkpoint(current.metadata)), this.#checkpoint({
        tenant_id: this.#tenantId, workspace_id: this.#workspaceId, revision, record_count: count,
        state_digest: digest, state_auth_tag: tag }));
      this.#verify(); this.#db.exec("COMMIT"); began = false; return { policy, replayed: false };
    } catch (error) {
      if (began) { try { this.#db.exec("ROLLBACK"); } catch { /* preserve the originating failure */ } }
      if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("integrity_failed");
    } finally { this.#operationActive = false; }
  }

  policy(policyId: string, revision: number): ReadyFrontierReadyPolicyV1 | undefined {
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, policyId);
    if (!Number.isSafeInteger(revision) || revision < 1) fail("invalid_input");
    return this.#verify().policies.find((item) => item.policy.policyId === policyId && item.policy.revision === revision)?.policy;
  }
  latestPolicy(policyId: string): ReadyFrontierReadyPolicyV1 | undefined {
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, policyId);
    return [...this.#verify().policies].reverse().find((item) => item.policy.policyId === policyId)?.policy;
  }
  listPolicies(): ReadyFrontierReadyPolicyV1[] { return this.#verify().policies.map((item) => item.policy); }
  async withCurrentPolicy<T>(policyId: string, revision: number, policyDigest: string,
    operation: (policy: ReadyFrontierReadyPolicyV1, activeGuard: object) => Promise<T>): Promise<T> {
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, policyId);
    parseExactReadyFrontierV1(readyFrontierDigestSchemaV1, policyDigest);
    if (!Number.isSafeInteger(revision) || revision < 1) fail("invalid_input");
    let release!: () => void;
    const prior = this.#guardTail;
    this.#guardTail = new Promise<void>((resolve) => { release = resolve; });
    this.#pendingGuardOperations += 1;
    await prior;
    this.#operationActive = true; let began = false; let activeGuard: object | undefined;
    try {
      this.#db.exec("BEGIN IMMEDIATE"); began = true;
      const latest = [...this.#verify().policies].reverse().find((item) => item.policy.policyId === policyId)?.policy;
      if (!latest || latest.revision !== revision || latest.policyDigest !== policyDigest || latest.state !== "active") fail("policy_inactive");
      activeGuard = Object.freeze(Object.create(null)) as object;
      activeReadyPolicyGuards.set(activeGuard, { policyId, revision, policyDigest });
      const result = await operation(latest, activeGuard); this.#db.exec("COMMIT"); began = false; return result;
    } catch (error) {
      if (began) { try { this.#db.exec("ROLLBACK"); } catch { /* preserve the originating failure */ } }
      if (error instanceof ReadyFrontierContractErrorV1) throw error; throw error;
    } finally {
      if (activeGuard) activeReadyPolicyGuards.delete(activeGuard);
      this.#operationActive = false; this.#pendingGuardOperations -= 1; release();
    }
  }
  closeDatabase(): void {
    if (this.#operationActive || this.#pendingGuardOperations > 0) fail("policy_inactive"); this.#key.fill(0); this.#db.close();
  }

  #initializeOrVerify(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const metadata = this.#metadata();
      const count = (this.#db.prepare("SELECT COUNT(*) count FROM frontier_ready_policy_record").get() as { count: number }).count;
      const checkpoint = this.#readCheckpoint();
      if (!metadata) {
        if (count !== 0 || checkpoint) fail("integrity_failed");
        const revision = 1, recordCount = 0, digest = this.#stateDigest([]), tag = this.#stateTag(revision, recordCount, digest);
        this.#db.prepare("INSERT INTO frontier_ready_policy_metadata(singleton,tenant_id,workspace_id,revision,record_count,state_digest,state_auth_tag) VALUES(1,?,?,?,?,?,?)")
          .run(this.#tenantId, this.#workspaceId, revision, recordCount, digest, tag);
        this.#checkpointInitialize(this.#checkpoint({ tenant_id: this.#tenantId, workspace_id: this.#workspaceId,
          revision, record_count: recordCount, state_digest: digest, state_auth_tag: tag }));
      } else this.#verify();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK"); if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("integrity_failed");
    }
  }

  #verify(): { metadata: MetadataRowV1; policies: Array<{ row: PolicyRowV1; policy: ReadyFrontierReadyPolicyV1 }> } {
    const metadata = this.#metadata();
    if (!metadata || metadata.tenant_id !== this.#tenantId || metadata.workspace_id !== this.#workspaceId) fail("scope_mismatch");
    const rows = this.#rows();
    if (metadata.record_count !== rows.length || metadata.revision !== rows.length + 1) fail("integrity_failed");
    const policies: Array<{ row: PolicyRowV1; policy: ReadyFrontierReadyPolicyV1 }> = [];
    const latest = new Map<string, ReadyFrontierReadyPolicyV1>();
    for (const [index, row] of rows.entries()) {
      if (row.ledger_sequence !== index + 1) fail("integrity_failed");
      let raw: unknown; try { raw = JSON.parse(row.policy_json); } catch { fail("integrity_failed"); }
      let policy: ReadyFrontierReadyPolicyV1;
      try { policy = parseReadyFrontierReadyPolicyV1(raw, this.#key); } catch { fail("integrity_failed"); }
      const material = { tenantId: this.#tenantId, workspaceId: this.#workspaceId, ledgerSequence: row.ledger_sequence,
        policyId: row.policy_id, policyRevision: row.policy_revision, policyState: row.policy_state,
        policyDigest: row.policy_digest, recordedAt: row.recorded_at };
      if (canonicalJson(policy) !== row.policy_json || row.policy_id !== policy.policyId
        || row.policy_revision !== policy.revision || row.policy_state !== policy.state
        || row.policy_digest !== policy.policyDigest || row.recorded_at !== policy.recordedAt
        || !same(row.record_auth_tag, hmacSha256Tag(this.#key, material))) fail("integrity_failed");
      const prior = latest.get(policy.policyId);
      if (!prior) {
        if (policy.revision !== 1 || policy.previousPolicyDigest !== null) fail("integrity_failed");
      } else if (prior.state === "revoked" || policy.revision !== prior.revision + 1
        || policy.previousPolicyDigest !== prior.policyDigest || Date.parse(policy.recordedAt) <= Date.parse(prior.recordedAt)
        || ((policy.action === "suspend" || policy.action === "revoke")
          && (policy.policyCeilingDigest !== prior.policyCeilingDigest
            || policy.parentStandingPolicyDigest !== prior.parentStandingPolicyDigest))) fail("integrity_failed");
      latest.set(policy.policyId, policy); policies.push({ row, policy });
    }
    if (!same(metadata.state_digest, this.#stateDigest(rows))
      || !same(metadata.state_auth_tag, this.#stateTag(metadata.revision, metadata.record_count, metadata.state_digest))) fail("integrity_failed");
    const checkpoint = this.#readCheckpoint();
    if (!checkpoint || rollbackCheckpointDigestV1(checkpoint) !== rollbackCheckpointDigestV1(this.#checkpoint(metadata))) fail("integrity_failed");
    return { metadata, policies };
  }

  #metadata(): MetadataRowV1 | undefined {
    return this.#db.prepare("SELECT tenant_id,workspace_id,revision,record_count,state_digest,state_auth_tag FROM frontier_ready_policy_metadata WHERE singleton=1")
      .get() as MetadataRowV1 | undefined;
  }
  #rows(): PolicyRowV1[] {
    return this.#db.prepare("SELECT ledger_sequence,policy_id,policy_revision,policy_state,policy_digest,recorded_at,policy_json,record_auth_tag FROM frontier_ready_policy_record ORDER BY ledger_sequence")
      .all() as unknown as PolicyRowV1[];
  }
  #stateDigest(rows: PolicyRowV1[]): string {
    return sha256Digest({ tenantId: this.#tenantId, workspaceId: this.#workspaceId,
      records: rows.map((row) => ({ ledgerSequence: row.ledger_sequence, policyId: row.policy_id,
        policyRevision: row.policy_revision, policyState: row.policy_state, policyDigest: row.policy_digest,
        recordedAt: row.recorded_at, recordAuthTag: row.record_auth_tag })) });
  }
  #stateTag(revision: number, count: number, digest: string): string {
    return hmacSha256Tag(this.#key, { tenantId: this.#tenantId, workspaceId: this.#workspaceId,
      revision, recordCount: count, stateDigest: digest });
  }
  #checkpointScope(): string {
    return `ready-frontier-ready-policy:${sha256Digest({ tenantId: this.#tenantId, workspaceId: this.#workspaceId })}`;
  }
  #checkpoint(metadata: MetadataRowV1): RollbackCheckpointV1 {
    return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: this.#checkpointScope(), revision: metadata.revision,
      recordCount: metadata.record_count, stateDigest: metadata.state_digest, stateAuthTag: metadata.state_auth_tag };
  }
  #readCheckpoint(): RollbackCheckpointV1 | undefined {
    try { return this.#checkpointRead(this.#checkpointScope()); } catch { fail("integrity_failed"); }
  }
}

export interface ReadyFrontierBoundReadyPolicyGuardV1 {
  <T>(policyId: string, revision: number, policyDigest: string,
    operation: (policy: ReadyFrontierReadyPolicyV1, activeGuard: object) => Promise<T>): Promise<T>;
}

const withCurrentReadyPolicy = ReadyFrontierReadyPolicyStoreV1.prototype.withCurrentPolicy;
Object.freeze(ReadyFrontierReadyPolicyStoreV1.prototype);

/** Captures the exact registered ready-policy guard without later dispatch through the caller-held store. */
export function bindReadyFrontierReadyPolicyGuardV1(value: unknown): ReadyFrontierBoundReadyPolicyGuardV1 | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value) || !readyPolicyStores.has(value)
    || Object.getPrototypeOf(value) !== ReadyFrontierReadyPolicyStoreV1.prototype || !Object.isFrozen(value)) return undefined;
  const store = value as ReadyFrontierReadyPolicyStoreV1;
  return (<T>(policyId: string, revision: number, policyDigest: string,
    operation: (policy: ReadyFrontierReadyPolicyV1, activeGuard: object) => Promise<T>) =>
    withCurrentReadyPolicy.call(store, policyId, revision, policyDigest, operation)) as ReadyFrontierBoundReadyPolicyGuardV1;
}
