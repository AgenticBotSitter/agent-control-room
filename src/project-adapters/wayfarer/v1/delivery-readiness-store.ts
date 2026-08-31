import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { exactProjectWorkspaceJsonV1, ProjectWorkspaceContractErrorV1,
  projectWorkspaceSafeIdSchemaV1 as id } from "../../../project-workspace/v1";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import {
  parseWayfarerDeliveryDisabledDispositionV1,
  parseWayfarerDeliveryReadinessAssessmentV1,
  type WayfarerDeliveryDisabledDispositionV1,
  type WayfarerDeliveryReadinessAssessmentV1,
} from "./delivery-readiness";
import { WAYFARER_DELIVERY_BOUNDARY_IDS_V1, type WayfarerDeliveryBoundaryIdV1 } from "./delivery-preparation";

type Scope = { tenantId: string; workspaceId: string; projectId: string };
type Kind = "assessment" | "disposition";
type Row = { kind: Kind; boundary_id: WayfarerDeliveryBoundaryIdV1; record_id: string; record_digest: string;
  semantic_key: string; payload: string; record_auth_tag: string; recorded_at: string };
type Meta = { tenant_id: string; workspace_id: string; project_id: string; revision: number; record_count: number;
  state_digest: string; state_auth_tag: string };
const scopeSchema = z.object({ tenantId: id, workspaceId: id, projectId: id }).strict();
const inputSchema = z.object({ assessment: z.unknown(), disposition: z.unknown() }).strict();
const boundarySchema = z.enum(WAYFARER_DELIVERY_BOUNDARY_IDS_V1);
const TABLES = ["wayfarer_delivery_readiness_metadata", "wayfarer_delivery_readiness_records"];
const OBJECTS = ["index:wayfarer_delivery_readiness_semantic", "table:wayfarer_delivery_readiness_metadata",
  "table:wayfarer_delivery_readiness_records"];

function snapshot<T>(schema: z.ZodType<T>, value: unknown): T {
  try { return schema.parse(exactProjectWorkspaceJsonV1(value)); }
  catch (error) { if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
}
function json(value: string): unknown { try { return JSON.parse(value) as unknown; }
  catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); } }

export interface WayfarerDeliveryReadinessRecordV1 {
  assessment: WayfarerDeliveryReadinessAssessmentV1;
  disposition: WayfarerDeliveryDisabledDispositionV1;
}

export class SqliteWayfarerDeliveryReadinessStoreV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  readonly #scope: Scope;
  #closed = false;

  constructor(path: string, scopeValue: unknown, options: { integrityKey: Uint8Array; mode: "create" | "open" }) {
    this.#scope = snapshot(scopeSchema, scopeValue);
    try { hmacSha256Tag(options.integrityKey, { purpose: "wayfarer-delivery-readiness-ledger" }); }
    catch { throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
    this.#key = new Uint8Array(options.integrityKey);
    this.#db = new DatabaseSync(path);
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (options.mode === "create") {
      if (version !== 0) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      this.createSchema();
      this.initialize();
    } else if (version !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    else this.verifyIntegrity();
  }

  close(): void { if (!this.#closed) { this.#key.fill(0); this.#db.close(); this.#closed = true; } }

  record(inputValue: unknown): { record: WayfarerDeliveryReadinessRecordV1; replayed: boolean } {
    const input = snapshot(inputSchema, inputValue), assessment = parseWayfarerDeliveryReadinessAssessmentV1(input.assessment),
      disposition = parseWayfarerDeliveryDisabledDispositionV1(input.disposition);
    this.scope(assessment);
    this.scope(disposition);
    if (assessment.readiness !== "blocked" || disposition.boundaryId !== assessment.boundaryId
      || disposition.assessmentId !== assessment.assessmentId || disposition.assessmentDigest !== assessment.assessmentDigest
      || disposition.candidatePackageDigest !== assessment.candidatePackageDigest
      || disposition.blockingGateIds.join("|") !== assessment.blockingGateIds.join("|")
      || Date.parse(disposition.recordedAt) < Date.parse(assessment.assessedAt)) {
      throw new ProjectWorkspaceContractErrorV1("replay_drift");
    }
    this.verifyIntegrity();
    return this.transaction(() => {
      const oldAssessment = this.current("assessment", assessment.assessmentId),
        oldDisposition = this.current("disposition", disposition.dispositionId);
      if (oldAssessment || oldDisposition) {
        if (!oldAssessment || !oldDisposition || oldAssessment.boundary_id !== assessment.boundaryId
          || oldDisposition.boundary_id !== assessment.boundaryId || oldAssessment.record_digest !== assessment.assessmentDigest
          || oldDisposition.record_digest !== disposition.dispositionDigest) {
          throw new ProjectWorkspaceContractErrorV1("replay_drift");
        }
        this.verified(oldAssessment);
        this.verified(oldDisposition);
        return { record: { assessment, disposition }, replayed: true };
      }
      const latest = this.latestAssessmentRow(assessment.boundaryId);
      const latestDisposition = latest ? this.bySemantic("disposition", assessment.boundaryId, latest.record_id) : undefined;
      if (latest && (!latestDisposition || Date.parse(assessment.assessedAt) <= Date.parse(latestDisposition.recorded_at))) {
        throw new ProjectWorkspaceContractErrorV1("unsupported_action");
      }
      this.insert("assessment", assessment.boundaryId, assessment.assessmentId, assessment.assessmentDigest,
        assessment.assessmentId, assessment.assessedAt, assessment);
      this.insert("disposition", disposition.boundaryId, disposition.dispositionId, disposition.dispositionDigest,
        assessment.assessmentId, disposition.recordedAt, disposition);
      this.advance();
      return { record: { assessment, disposition }, replayed: false };
    });
  }

  latest(boundaryValue: unknown): WayfarerDeliveryReadinessRecordV1 | undefined {
    const boundary = snapshot(boundarySchema, boundaryValue);
    this.verifyIntegrity();
    const assessmentRow = this.latestAssessmentRow(boundary);
    if (!assessmentRow) return undefined;
    const dispositionRow = this.bySemantic("disposition", boundary, assessmentRow.record_id);
    if (!dispositionRow) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    const assessment = this.verified(assessmentRow) as WayfarerDeliveryReadinessAssessmentV1;
    const disposition = this.verified(dispositionRow) as WayfarerDeliveryDisabledDispositionV1;
    if (assessment.boundaryId !== boundary || disposition.boundaryId !== boundary
      || disposition.assessmentDigest !== assessment.assessmentDigest
      || disposition.candidatePackageDigest !== assessment.candidatePackageDigest
      || disposition.blockingGateIds.join("|") !== assessment.blockingGateIds.join("|")) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    return { assessment, disposition };
  }

  verifyIntegrity(): { revision: number; recordCount: number; stateDigest: string } {
    this.open();
    this.schema();
    const meta = this.meta(), state = this.state(), revision = Number(meta.revision), count = Number(meta.record_count);
    const expected = hmacSha256Tag(this.#key, this.metaMaterial(revision, count, meta.state_digest));
    if (meta.tenant_id !== this.#scope.tenantId || meta.workspace_id !== this.#scope.workspaceId
      || meta.project_id !== this.#scope.projectId || count !== state.recordCount || meta.state_digest !== state.stateDigest
      || meta.state_auth_tag !== expected || revision < 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return { revision, recordCount: count, stateDigest: state.stateDigest };
  }

  private createSchema(): void {
    this.#db.exec("BEGIN IMMEDIATE; CREATE TABLE wayfarer_delivery_readiness_metadata(tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,record_count INTEGER NOT NULL,state_digest TEXT NOT NULL,state_auth_tag TEXT NOT NULL); CREATE TABLE wayfarer_delivery_readiness_records(kind TEXT NOT NULL CHECK(kind IN ('assessment','disposition')),boundary_id TEXT NOT NULL CHECK(boundary_id IN ('private_upload','public_publication')),record_id TEXT NOT NULL,record_digest TEXT NOT NULL UNIQUE,semantic_key TEXT NOT NULL,payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(kind,record_id)); CREATE UNIQUE INDEX wayfarer_delivery_readiness_semantic ON wayfarer_delivery_readiness_records(kind,boundary_id,semantic_key); PRAGMA user_version=1; COMMIT;");
  }
  private initialize(): void {
    const state = this.state(), revision = 1;
    this.#db.prepare("INSERT INTO wayfarer_delivery_readiness_metadata VALUES(?,?,?,?,?,?,?)").run(this.#scope.tenantId,
      this.#scope.workspaceId, this.#scope.projectId, revision, state.recordCount, state.stateDigest,
      hmacSha256Tag(this.#key, this.metaMaterial(revision, state.recordCount, state.stateDigest)));
  }
  private insert(kind: Kind, boundary: WayfarerDeliveryBoundaryIdV1, recordId: string, recordDigest: string,
    semanticKey: string, recordedAt: string, value: unknown): void {
    const payload = JSON.stringify(value), tag = hmacSha256Tag(this.#key, { kind, boundary, scope: this.#scope, id: recordId,
      digest: recordDigest, semanticKey, payloadDigest: sha256Digest(value), recordedAt });
    this.#db.prepare("INSERT INTO wayfarer_delivery_readiness_records VALUES(?,?,?,?,?,?,?,?)")
      .run(kind, boundary, recordId, recordDigest, semanticKey, payload, tag, recordedAt);
  }
  private verified(row: Row): unknown {
    const value = row.kind === "assessment" ? parseWayfarerDeliveryReadinessAssessmentV1(json(row.payload))
      : parseWayfarerDeliveryDisabledDispositionV1(json(row.payload));
    const recordDigest = row.kind === "assessment" ? (value as WayfarerDeliveryReadinessAssessmentV1).assessmentDigest
      : (value as WayfarerDeliveryDisabledDispositionV1).dispositionDigest;
    const boundary = (value as WayfarerDeliveryReadinessAssessmentV1 | WayfarerDeliveryDisabledDispositionV1).boundaryId;
    const expected = hmacSha256Tag(this.#key, { kind: row.kind, boundary: row.boundary_id, scope: this.#scope,
      id: row.record_id, digest: row.record_digest, semanticKey: row.semantic_key, payloadDigest: sha256Digest(value),
      recordedAt: row.recorded_at });
    if (row.boundary_id !== boundary || row.record_digest !== recordDigest || row.record_auth_tag !== expected) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    return value;
  }
  private state(): { recordCount: number; stateDigest: string } {
    const rows = this.#db.prepare("SELECT * FROM wayfarer_delivery_readiness_records ORDER BY kind,boundary_id,record_id")
      .all() as unknown as Row[];
    const records = rows.map((row) => { this.verified(row); return { kind: row.kind, boundary: row.boundary_id,
      id: row.record_id, digest: row.record_digest, semanticKey: row.semantic_key, tag: row.record_auth_tag,
      recordedAt: row.recorded_at }; });
    return { recordCount: records.length, stateDigest: sha256Digest({ scope: this.#scope, records }) };
  }
  private advance(): void {
    const meta = this.meta(), state = this.state(), revision = Number(meta.revision) + 1;
    const result = this.#db.prepare("UPDATE wayfarer_delivery_readiness_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE revision=?")
      .run(revision, state.recordCount, state.stateDigest,
        hmacSha256Tag(this.#key, this.metaMaterial(revision, state.recordCount, state.stateDigest)), meta.revision);
    if (Number(result.changes) !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }
  private meta(): Meta {
    const rows = this.#db.prepare("SELECT * FROM wayfarer_delivery_readiness_metadata").all() as unknown as Meta[];
    if (rows.length !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return rows[0]!;
  }
  private metaMaterial(revision: number, recordCount: number, stateDigest: string) {
    return { kind: "metadata", scope: this.#scope, revision, recordCount, stateDigest };
  }
  private schema(): void {
    const tableRows = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{ name: string }>;
    const objectRows = this.#db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as unknown as Array<{ type: string; name: string }>;
    const tables = tableRows.map((row) => row.name);
    const objects = objectRows.map((row) => `${row.type}:${row.name}`);
    if (tables.join("|") !== TABLES.join("|") || objects.join("|") !== OBJECTS.join("|")) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
  }
  private current(kind: Kind, recordId: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM wayfarer_delivery_readiness_records WHERE kind=? AND record_id=?")
      .get(kind, recordId) as Row | undefined;
  }
  private bySemantic(kind: Kind, boundary: WayfarerDeliveryBoundaryIdV1, semanticKey: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM wayfarer_delivery_readiness_records WHERE kind=? AND boundary_id=? AND semantic_key=?")
      .get(kind, boundary, semanticKey) as Row | undefined;
  }
  private latestAssessmentRow(boundary: WayfarerDeliveryBoundaryIdV1): Row | undefined {
    return this.#db.prepare("SELECT * FROM wayfarer_delivery_readiness_records WHERE kind='assessment' AND boundary_id=? ORDER BY recorded_at DESC,record_id DESC LIMIT 1")
      .get(boundary) as Row | undefined;
  }
  private scope(value: Scope): void {
    if (value.tenantId !== this.#scope.tenantId || value.workspaceId !== this.#scope.workspaceId
      || value.projectId !== this.#scope.projectId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
  }
  private open(): void { if (this.#closed) throw new ProjectWorkspaceContractErrorV1("integrity_failed"); }
  private transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); this.#db.exec("COMMIT"); return value; }
    catch (error) { try { this.#db.exec("ROLLBACK"); } catch { void 0; } throw error; }
  }
}
