import { timingSafeEqual } from "node:crypto";
import { closeSync, lstatSync, openSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertPrivateSqliteSchemaV1 } from "../../harness/codex-v1/private-sqlite-schema";
import {
  bindInMemoryRollbackCheckpointStoreV1,
  canonicalJson,
  hmacSha256Tag,
  ROLLBACK_CHECKPOINT_SCHEMA_V1,
  rollbackCheckpointDigestV1,
  sha256Digest,
  type RollbackCheckpointStoreV1,
  type RollbackCheckpointV1,
} from "../../security";
import { exactHostUint8ArrayV1 } from "../../security/host-value";
import { ReadyFrontierContractErrorV1 } from "./errors";
import { parseExactReadyFrontierV1 } from "./exact";
import { parseReadyFrontierProductionBoundaryAssessmentV1 } from "./production-boundary";
import {
  assessReadyFrontierProductionProofsV1,
  parseReadyFrontierProductionProofObservationV1,
  parseReadyFrontierProductionTrustAnchorV1,
  verifyReadyFrontierProductionProofEnvelopeV1,
  verifyReadyFrontierProductionTrustBundleV1,
} from "./production-proof";
import { readyFrontierIdSchemaV1, readyFrontierTimeSchemaV1 } from "./schemas";
import type {
  ReadyFrontierProductionProofAssessmentV1,
  ReadyFrontierProductionProofEnvelopeV1,
  ReadyFrontierProductionProofObservationV1,
  ReadyFrontierProductionTrustAnchorV1,
  ReadyFrontierProductionTrustBundleV1,
} from "./production-proof-types";
import type { ReadyFrontierProductionBoundaryAssessmentV1 } from "./production-boundary-types";

interface MetadataRowV1 {
  tenant_id: string; workspace_id: string; revision: number; record_count: number;
  state_digest: string; state_auth_tag: string;
}
interface ArtifactRowV1 {
  ledger_sequence: number; artifact_kind: "trust_bundle" | "proof"; artifact_id: string;
  artifact_digest: string; recorded_at: string; artifact_json: string; record_auth_tag: string;
}
interface StoredProofV1 {
  assessment: ReadyFrontierProductionBoundaryAssessmentV1;
  envelope: ReadyFrontierProductionProofEnvelopeV1;
  observation: ReadyFrontierProductionProofObservationV1;
}

const EXPECTED_OBJECTS = ["index:idx_frontier_production_proof_artifact_identity",
  "table:frontier_production_proof_artifact", "table:frontier_production_proof_metadata"] as const;
const EXPECTED_COLUMNS = {
  frontier_production_proof_metadata: [
    { name: "singleton", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "tenant_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "workspace_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "revision", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "record_count", type: "INTEGER", notnull: 1, pk: 0 },
    { name: "state_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "state_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
  frontier_production_proof_artifact: [
    { name: "ledger_sequence", type: "INTEGER", notnull: 0, pk: 1 },
    { name: "artifact_kind", type: "TEXT", notnull: 1, pk: 0 },
    { name: "artifact_id", type: "TEXT", notnull: 1, pk: 0 },
    { name: "artifact_digest", type: "TEXT", notnull: 1, pk: 0 },
    { name: "recorded_at", type: "TEXT", notnull: 1, pk: 0 },
    { name: "artifact_json", type: "TEXT", notnull: 1, pk: 0 },
    { name: "record_auth_tag", type: "TEXT", notnull: 1, pk: 0 },
  ],
} as const;
const EXPECTED_SQL = {
  frontier_production_proof_metadata: `CREATE TABLE frontier_production_proof_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
    state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76)
  )`,
  frontier_production_proof_artifact: `CREATE TABLE frontier_production_proof_artifact (
    ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1),
    artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('trust_bundle','proof')),
    artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL CHECK(length(artifact_digest)=71),
    recorded_at TEXT NOT NULL, artifact_json TEXT NOT NULL,
    record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76),
    UNIQUE(artifact_kind,artifact_id), UNIQUE(artifact_digest)
  )`,
  idx_frontier_production_proof_artifact_identity:
    "CREATE INDEX idx_frontier_production_proof_artifact_identity ON frontier_production_proof_artifact(artifact_kind,artifact_id)",
} as const;

function fail(code: ReadyFrontierContractErrorV1["safeCode"]): never {
  throw new ReadyFrontierContractErrorV1(code);
}
function same(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function key(value: unknown): Uint8Array {
  const parsed = exactHostUint8ArrayV1(value, 128);
  if (!parsed || parsed.byteLength < 32) fail("integrity_failed");
  return parsed.copy();
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

export class ReadyFrontierProductionProofStoreV1 {
  readonly #db!: DatabaseSync;
  readonly #ledgerKey: Uint8Array;
  readonly #planKey: Uint8Array;
  readonly #tenantId: string;
  readonly #workspaceId: string;
  readonly #anchor: ReadyFrontierProductionTrustAnchorV1;
  readonly #maximumRecords: number;
  readonly #checkpointRead: RollbackCheckpointStoreV1["read"];
  readonly #checkpointInitialize: RollbackCheckpointStoreV1["initialize"];
  readonly #checkpointAdvance: RollbackCheckpointStoreV1["advance"];
  #operationActive = false;

  constructor(path: string, tenantId: string, workspaceId: string, ledgerKeyValue: unknown,
    activationPacketIntegrityKey: unknown, anchorValue: unknown,
    checkpointStore: RollbackCheckpointStoreV1, maximumRecords = 1_000) {
    this.#ledgerKey = key(ledgerKeyValue); this.#planKey = key(activationPacketIntegrityKey);
    try {
      this.#tenantId = parseExactReadyFrontierV1(readyFrontierIdSchemaV1, tenantId);
      this.#workspaceId = parseExactReadyFrontierV1(readyFrontierIdSchemaV1, workspaceId);
      this.#anchor = parseReadyFrontierProductionTrustAnchorV1(anchorValue);
      if (this.#anchor.tenantId !== tenantId || this.#anchor.workspaceId !== workspaceId
        || !Number.isSafeInteger(maximumRecords) || maximumRecords < 1 || maximumRecords > 10_000) fail("scope_mismatch");
      this.#maximumRecords = maximumRecords;
      const checkpoint = bindInMemoryRollbackCheckpointStoreV1(checkpointStore);
      if (!checkpoint) fail("integrity_failed");
      this.#checkpointRead = checkpoint.read; this.#checkpointInitialize = checkpoint.initialize;
      this.#checkpointAdvance = checkpoint.advance;
      prepare(path); this.#db = new DatabaseSync(path);
      const version = (this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (version !== 0 && version !== 1) fail("integrity_failed");
      this.#db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
      if (version === 0) this.#db.exec(`CREATE TABLE frontier_production_proof_metadata (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), tenant_id TEXT NOT NULL, workspace_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK(revision>=1), record_count INTEGER NOT NULL CHECK(record_count>=0),
        state_digest TEXT NOT NULL CHECK(length(state_digest)=71), state_auth_tag TEXT NOT NULL CHECK(length(state_auth_tag)=76));
        CREATE TABLE frontier_production_proof_artifact (
        ledger_sequence INTEGER PRIMARY KEY CHECK(ledger_sequence>=1),
        artifact_kind TEXT NOT NULL CHECK(artifact_kind IN ('trust_bundle','proof')),
        artifact_id TEXT NOT NULL, artifact_digest TEXT NOT NULL CHECK(length(artifact_digest)=71),
        recorded_at TEXT NOT NULL, artifact_json TEXT NOT NULL,
        record_auth_tag TEXT NOT NULL CHECK(length(record_auth_tag)=76),
        UNIQUE(artifact_kind,artifact_id), UNIQUE(artifact_digest));
        CREATE INDEX idx_frontier_production_proof_artifact_identity
        ON frontier_production_proof_artifact(artifact_kind,artifact_id); PRAGMA user_version=1;`);
      assertPrivateSqliteSchemaV1(this.#db, EXPECTED_OBJECTS, EXPECTED_COLUMNS, EXPECTED_SQL);
      this.#initializeOrVerify(); Object.freeze(this);
    } catch (error) {
      this.#ledgerKey.fill(0); this.#planKey.fill(0);
      if (this.#db!) { try { this.#db.close(); } catch { /* construction failure */ } }
      if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("integrity_failed");
    }
  }

  recordTrustBundle(value: unknown, receivedAtValue: unknown):
    { bundle: ReadyFrontierProductionTrustBundleV1; replayed: boolean } {
    const bundle = verifyReadyFrontierProductionTrustBundleV1(value, this.#anchor);
    const receivedAt = parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, receivedAtValue);
    if (bundle.body.tenantId !== this.#tenantId || bundle.body.workspaceId !== this.#workspaceId
      || Date.parse(receivedAt) < Date.parse(bundle.body.issuedAt)
      || Date.parse(receivedAt) >= Date.parse(bundle.body.expiresAt)) fail("scope_mismatch");
    return this.#mutate(() => {
      const current = this.#verify();
      const exact = current.bundles.find((item) => item.bundle.body.bundleId === bundle.body.bundleId);
      if (exact) {
        if (!same(exact.bundle.body.bodyDigest, bundle.body.bodyDigest)) fail("replay_drift");
        return { bundle: exact.bundle, replayed: true };
      }
      if (current.rows.length >= this.#maximumRecords) fail("capacity_exceeded");
      const prior = current.bundles.at(-1)?.bundle;
      if (!prior) {
        if (bundle.body.revision !== 1 || bundle.body.previousBundleDigest !== null) fail("replay_drift");
      } else if (bundle.body.revision !== prior.body.revision + 1
        || bundle.body.previousBundleDigest !== prior.body.bodyDigest
        || Date.parse(bundle.body.issuedAt) <= Date.parse(prior.body.issuedAt)) fail("replay_drift");
      this.#append("trust_bundle", bundle.body.bundleId, bundle.body.bodyDigest, receivedAt, bundle, current.metadata);
      return { bundle, replayed: false };
    });
  }

  recordProof(value: unknown): { observation: ReadyFrontierProductionProofObservationV1; replayed: boolean } {
    const input = parseExactReadyFrontierV1({ parse(candidate: unknown) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("invalid");
      const item = candidate as Record<string, unknown>;
      if (Object.keys(item).sort().join(",") !== "assessment,envelope,receivedAt"
        || typeof item.receivedAt !== "string") throw new Error("invalid");
      return item;
    } }, value) as Record<string, unknown>;
    return this.#mutate(() => {
      const current = this.#verify(), bundle = current.bundles.at(-1)?.bundle;
      if (!bundle) fail("policy_inactive");
      const observation = verifyReadyFrontierProductionProofEnvelopeV1({ envelope: input.envelope,
        assessment: input.assessment, trustBundle: bundle, receivedAt: input.receivedAt },
      this.#planKey, this.#anchor);
      const envelope = input.envelope as ReadyFrontierProductionProofEnvelopeV1;
      const assessment = parseReadyFrontierProductionBoundaryAssessmentV1(input.assessment, this.#planKey);
      const exact = current.proofs.find((item) => item.observation.proofId === observation.proofId);
      if (exact) {
        if (!same(exact.observation.envelopeDigest, observation.envelopeDigest)
          || !same(exact.observation.observationDigest, observation.observationDigest)) fail("replay_drift");
        return { observation: exact.observation, replayed: true };
      }
      if (current.rows.length >= this.#maximumRecords) fail("capacity_exceeded");
      const stored: StoredProofV1 = { assessment, envelope, observation };
      this.#append("proof", observation.proofId, observation.envelopeDigest,
        observation.receivedAt, stored, current.metadata);
      return { observation, replayed: false };
    });
  }

  assess(proofAssessmentId: string, assessmentValue: unknown, evaluatedAt: string):
    ReadyFrontierProductionProofAssessmentV1 {
    parseExactReadyFrontierV1(readyFrontierIdSchemaV1, proofAssessmentId);
    parseExactReadyFrontierV1(readyFrontierTimeSchemaV1, evaluatedAt);
    const current = this.#verify(), bundle = current.bundles.at(-1)?.bundle;
    if (!bundle) fail("policy_inactive");
    return assessReadyFrontierProductionProofsV1({ proofAssessmentId, assessment: assessmentValue,
      currentTrustBundle: bundle, observations: current.proofs.map((item) => item.observation), evaluatedAt },
    this.#planKey, this.#anchor);
  }

  listObservations(): ReadyFrontierProductionProofObservationV1[] {
    return this.#verify().proofs.map((item) => structuredClone(item.observation));
  }

  currentTrustBundle(): ReadyFrontierProductionTrustBundleV1 | undefined {
    const bundle = this.#verify().bundles.at(-1)?.bundle;
    return bundle ? structuredClone(bundle) : undefined;
  }

  closeDatabase(): void {
    if (this.#operationActive) fail("policy_inactive");
    this.#ledgerKey.fill(0); this.#planKey.fill(0); this.#db.close();
  }

  #mutate<T>(operation: () => T): T {
    if (this.#operationActive) fail("policy_inactive");
    this.#operationActive = true; let began = false;
    try {
      this.#db.exec("BEGIN IMMEDIATE"); began = true;
      const result = operation(); this.#db.exec("COMMIT"); began = false; return result;
    } catch (error) {
      if (began) { try { this.#db.exec("ROLLBACK"); } catch { /* preserve original */ } }
      if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("integrity_failed");
    } finally { this.#operationActive = false; }
  }

  #append(kind: ArtifactRowV1["artifact_kind"], id: string, digest: string, recordedAt: string,
    artifact: unknown, metadata: MetadataRowV1): void {
    const sequence = metadata.record_count + 1;
    const material = { tenantId: this.#tenantId, workspaceId: this.#workspaceId,
      ledgerSequence: sequence, artifactKind: kind, artifactId: id, artifactDigest: digest, recordedAt };
    this.#db.prepare(`INSERT INTO frontier_production_proof_artifact
      (ledger_sequence,artifact_kind,artifact_id,artifact_digest,recorded_at,artifact_json,record_auth_tag)
      VALUES(?,?,?,?,?,?,?)`).run(sequence, kind, id, digest, recordedAt, canonicalJson(artifact),
      hmacSha256Tag(this.#ledgerKey, material));
    const rows = this.#rows(), revision = metadata.revision + 1, count = metadata.record_count + 1;
    const stateDigest = this.#stateDigest(rows), stateAuthTag = this.#stateTag(revision, count, stateDigest);
    this.#db.prepare(`UPDATE frontier_production_proof_metadata SET
      revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE singleton=1`)
      .run(revision, count, stateDigest, stateAuthTag);
    this.#checkpointAdvance(rollbackCheckpointDigestV1(this.#checkpoint(metadata)), this.#checkpoint({
      tenant_id: this.#tenantId, workspace_id: this.#workspaceId, revision, record_count: count,
      state_digest: stateDigest, state_auth_tag: stateAuthTag,
    }));
    this.#verify();
  }

  #initializeOrVerify(): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const metadata = this.#metadata(), count = (this.#db.prepare(
        "SELECT COUNT(*) count FROM frontier_production_proof_artifact").get() as { count: number }).count;
      const checkpoint = this.#readCheckpoint();
      if (!metadata) {
        if (count !== 0 || checkpoint) fail("integrity_failed");
        const revision = 1, recordCount = 0, stateDigest = this.#stateDigest([]),
          stateAuthTag = this.#stateTag(revision, recordCount, stateDigest);
        this.#db.prepare(`INSERT INTO frontier_production_proof_metadata
          (singleton,tenant_id,workspace_id,revision,record_count,state_digest,state_auth_tag)
          VALUES(1,?,?,?,?,?,?)`).run(this.#tenantId, this.#workspaceId, revision, recordCount,
          stateDigest, stateAuthTag);
        this.#checkpointInitialize(this.#checkpoint({ tenant_id: this.#tenantId,
          workspace_id: this.#workspaceId, revision, record_count: recordCount,
          state_digest: stateDigest, state_auth_tag: stateAuthTag }));
      } else this.#verify();
      this.#db.exec("COMMIT");
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { /* preserve original */ }
      if (error instanceof ReadyFrontierContractErrorV1) throw error; fail("integrity_failed");
    }
  }

  #verify(): { metadata: MetadataRowV1; rows: ArtifactRowV1[];
    bundles: Array<{ row: ArtifactRowV1; bundle: ReadyFrontierProductionTrustBundleV1 }>;
    proofs: Array<{ row: ArtifactRowV1; observation: ReadyFrontierProductionProofObservationV1 }> } {
    const metadata = this.#metadata(), rows = this.#rows();
    if (!metadata || metadata.tenant_id !== this.#tenantId || metadata.workspace_id !== this.#workspaceId
      || metadata.record_count !== rows.length || metadata.revision !== rows.length + 1) fail("integrity_failed");
    const bundles: Array<{ row: ArtifactRowV1; bundle: ReadyFrontierProductionTrustBundleV1 }> = [];
    const proofs: Array<{ row: ArtifactRowV1; observation: ReadyFrontierProductionProofObservationV1 }> = [];
    const ids = new Set<string>(), digests = new Set<string>();
    for (const [index, row] of rows.entries()) {
      if (row.ledger_sequence !== index + 1 || ids.has(`${row.artifact_kind}:${row.artifact_id}`)
        || digests.has(row.artifact_digest)) fail("integrity_failed");
      ids.add(`${row.artifact_kind}:${row.artifact_id}`); digests.add(row.artifact_digest);
      const recordMaterial = { tenantId: this.#tenantId, workspaceId: this.#workspaceId,
        ledgerSequence: row.ledger_sequence, artifactKind: row.artifact_kind,
        artifactId: row.artifact_id, artifactDigest: row.artifact_digest, recordedAt: row.recorded_at };
      if (!same(row.record_auth_tag, hmacSha256Tag(this.#ledgerKey, recordMaterial))) fail("integrity_failed");
      let raw: unknown; try { raw = JSON.parse(row.artifact_json); } catch { fail("integrity_failed"); }
      if (row.artifact_kind === "trust_bundle") {
        let bundle: ReadyFrontierProductionTrustBundleV1;
        try { bundle = verifyReadyFrontierProductionTrustBundleV1(raw, this.#anchor); }
        catch { fail("integrity_failed"); }
        const prior = bundles.at(-1)?.bundle;
        if ((!prior && (bundle.body.revision !== 1 || bundle.body.previousBundleDigest !== null))
          || (prior && (bundle.body.revision !== prior.body.revision + 1
            || bundle.body.previousBundleDigest !== prior.body.bodyDigest
            || Date.parse(bundle.body.issuedAt) <= Date.parse(prior.body.issuedAt)))
          || row.artifact_id !== bundle.body.bundleId || row.artifact_digest !== bundle.body.bodyDigest
          || row.recorded_at < bundle.body.issuedAt || row.recorded_at >= bundle.body.expiresAt
          || canonicalJson(bundle) !== row.artifact_json) fail("integrity_failed");
        bundles.push({ row, bundle });
      } else {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)
          || Object.keys(raw as object).sort().join(",") !== "assessment,envelope,observation") fail("integrity_failed");
        const stored = raw as StoredProofV1, bundle = bundles.at(-1)?.bundle;
        if (!bundle) fail("integrity_failed");
        let expected: ReadyFrontierProductionProofObservationV1;
        try {
          expected = verifyReadyFrontierProductionProofEnvelopeV1({ envelope: stored.envelope,
            assessment: stored.assessment, trustBundle: bundle, receivedAt: row.recorded_at },
          this.#planKey, this.#anchor);
        } catch { fail("integrity_failed"); }
        let observation: ReadyFrontierProductionProofObservationV1;
        try { observation = parseReadyFrontierProductionProofObservationV1(stored.observation); }
        catch { fail("integrity_failed"); }
        if (canonicalJson(expected) !== canonicalJson(observation) || canonicalJson(stored) !== row.artifact_json
          || row.artifact_id !== observation.proofId || row.artifact_digest !== observation.envelopeDigest
          || row.recorded_at !== observation.receivedAt) fail("integrity_failed");
        proofs.push({ row, observation });
      }
    }
    if (!same(metadata.state_digest, this.#stateDigest(rows))
      || !same(metadata.state_auth_tag, this.#stateTag(metadata.revision, metadata.record_count,
        metadata.state_digest))) fail("integrity_failed");
    const checkpoint = this.#readCheckpoint();
    if (!checkpoint || rollbackCheckpointDigestV1(checkpoint)
      !== rollbackCheckpointDigestV1(this.#checkpoint(metadata))) fail("integrity_failed");
    return { metadata, rows, bundles, proofs };
  }

  #metadata(): MetadataRowV1 | undefined {
    return this.#db.prepare(`SELECT tenant_id,workspace_id,revision,record_count,state_digest,state_auth_tag
      FROM frontier_production_proof_metadata WHERE singleton=1`).get() as MetadataRowV1 | undefined;
  }
  #rows(): ArtifactRowV1[] {
    return this.#db.prepare(`SELECT ledger_sequence,artifact_kind,artifact_id,artifact_digest,recorded_at,
      artifact_json,record_auth_tag FROM frontier_production_proof_artifact ORDER BY ledger_sequence`)
      .all() as unknown as ArtifactRowV1[];
  }
  #stateDigest(rows: ArtifactRowV1[]): string {
    return sha256Digest({ tenantId: this.#tenantId, workspaceId: this.#workspaceId,
      records: rows.map((row) => ({ ledgerSequence: row.ledger_sequence,
        artifactKind: row.artifact_kind, artifactId: row.artifact_id,
        artifactDigest: row.artifact_digest, recordedAt: row.recorded_at,
        recordAuthTag: row.record_auth_tag })) });
  }
  #stateTag(revision: number, recordCount: number, stateDigest: string): string {
    return hmacSha256Tag(this.#ledgerKey, { tenantId: this.#tenantId, workspaceId: this.#workspaceId,
      revision, recordCount, stateDigest });
  }
  #checkpointScope(): string {
    return `ready-frontier-production-proof:${sha256Digest({ tenantId: this.#tenantId,
      workspaceId: this.#workspaceId, ownerRootKeyDigest: this.#anchor.ownerRootKeyDigest })}`;
  }
  #checkpoint(metadata: MetadataRowV1): RollbackCheckpointV1 {
    return { schema: ROLLBACK_CHECKPOINT_SCHEMA_V1, scope: this.#checkpointScope(),
      revision: metadata.revision, recordCount: metadata.record_count,
      stateDigest: metadata.state_digest, stateAuthTag: metadata.state_auth_tag };
  }
  #readCheckpoint(): RollbackCheckpointV1 | undefined {
    try { return this.#checkpointRead(this.#checkpointScope()); }
    catch { fail("integrity_failed"); }
  }
}

Object.freeze(ReadyFrontierProductionProofStoreV1.prototype);
