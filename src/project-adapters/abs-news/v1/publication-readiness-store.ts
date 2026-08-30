import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import {
  exactProjectWorkspaceJsonV1,
  ProjectWorkspaceContractErrorV1,
  projectWorkspaceSafeIdSchemaV1,
} from "../../../project-workspace/v1";
import {
  parseAbsNewsPublicationDisabledDispositionV1,
  parseAbsNewsPublicationReadinessAssessmentV1,
  type AbsNewsPublicationDisabledDispositionV1,
  type AbsNewsPublicationReadinessAssessmentV1,
} from "./publication-readiness";

const scopeSchema = z.object({
  tenantId: projectWorkspaceSafeIdSchemaV1,
  workspaceId: projectWorkspaceSafeIdSchemaV1,
  projectId: projectWorkspaceSafeIdSchemaV1,
}).strict();
const recordInputSchema = z.object({ assessment: z.unknown(), disposition: z.unknown() }).strict();
type Scope = z.infer<typeof scopeSchema>;
type Kind = "assessment" | "disposition";
type Row = {
  kind: Kind;
  record_id: string;
  record_digest: string;
  semantic_key: string;
  payload: string;
  record_auth_tag: string;
  recorded_at: string;
};
type Meta = {
  tenant_id: string;
  workspace_id: string;
  project_id: string;
  revision: number;
  record_count: number;
  state_digest: string;
  state_auth_tag: string;
};
const TABLES = ["abs_news_publication_readiness_metadata", "abs_news_publication_readiness_records"];
const SCHEMA_OBJECTS = [
  "index:abs_news_publication_readiness_semantic",
  "table:abs_news_publication_readiness_metadata",
  "table:abs_news_publication_readiness_records",
];

function snapshot<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    return schema.parse(exactProjectWorkspaceJsonV1(value));
  } catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }
}

export interface AbsNewsPublicationReadinessRecordV1 {
  assessment: AbsNewsPublicationReadinessAssessmentV1;
  disposition: AbsNewsPublicationDisabledDispositionV1;
}

export class SqliteAbsNewsPublicationReadinessStoreV1 {
  readonly #db: DatabaseSync;
  readonly #key: Uint8Array;
  readonly #scope: Scope;
  #closed = false;

  constructor(path: string, scopeValue: unknown, options: { integrityKey: Uint8Array; mode: "create" | "open" }) {
    this.#scope = snapshot(scopeSchema, scopeValue);
    try {
      hmacSha256Tag(options.integrityKey, { purpose: "abs-news-publication-readiness-ledger" });
    } catch {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    this.#key = new Uint8Array(options.integrityKey);
    this.#db = new DatabaseSync(path);
    const version = Number((this.#db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);
    if (options.mode === "create") {
      if (version !== 0) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      this.createSchema();
      this.initialize();
    } else if (version !== 1) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    } else {
      this.verifyIntegrity();
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#key.fill(0);
      this.#db.close();
      this.#closed = true;
    }
  }

  record(inputValue: unknown): { record: AbsNewsPublicationReadinessRecordV1; replayed: boolean } {
    const input = snapshot(recordInputSchema, inputValue);
    const assessment = parseAbsNewsPublicationReadinessAssessmentV1(input.assessment);
    const disposition = parseAbsNewsPublicationDisabledDispositionV1(input.disposition);
    this.scope(assessment);
    this.scope(disposition);
    if (assessment.readiness !== "blocked" || disposition.assessmentId !== assessment.assessmentId
      || disposition.assessmentDigest !== assessment.assessmentDigest
      || disposition.blockingGateIds.join("|") !== assessment.blockingGateIds.join("|")
      || Date.parse(disposition.recordedAt) < Date.parse(assessment.assessedAt)) {
      throw new ProjectWorkspaceContractErrorV1("replay_drift");
    }
    this.verifyIntegrity();
    return this.transaction(() => {
      const existingAssessment = this.current("assessment", assessment.assessmentId);
      const existingDisposition = this.current("disposition", disposition.dispositionId);
      if (existingAssessment || existingDisposition) {
        if (!existingAssessment || !existingDisposition
          || existingAssessment.record_digest !== assessment.assessmentDigest
          || existingDisposition.record_digest !== disposition.dispositionDigest) {
          throw new ProjectWorkspaceContractErrorV1("replay_drift");
        }
        this.verified(existingAssessment);
        this.verified(existingDisposition);
        return { record: { assessment, disposition }, replayed: true };
      }
      const latest = this.latestAssessmentRow();
      const latestDisposition = latest ? this.bySemantic("disposition", latest.record_id) : undefined;
      if (latest && (!latestDisposition || Date.parse(assessment.assessedAt) <= Date.parse(latestDisposition.recorded_at))) {
        throw new ProjectWorkspaceContractErrorV1("unsupported_action");
      }
      this.insert("assessment", assessment.assessmentId, assessment.assessmentDigest, assessment.assessmentId,
        assessment.assessedAt, assessment);
      this.insert("disposition", disposition.dispositionId, disposition.dispositionDigest, assessment.assessmentId,
        disposition.recordedAt, disposition);
      this.advance();
      return { record: { assessment, disposition }, replayed: false };
    });
  }

  latest(): AbsNewsPublicationReadinessRecordV1 | undefined {
    this.verifyIntegrity();
    const assessmentRow = this.latestAssessmentRow();
    if (!assessmentRow) return undefined;
    const dispositionRow = this.bySemantic("disposition", assessmentRow.record_id);
    if (!dispositionRow) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    const assessment = this.verified(assessmentRow) as AbsNewsPublicationReadinessAssessmentV1;
    const disposition = this.verified(dispositionRow) as AbsNewsPublicationDisabledDispositionV1;
    if (disposition.assessmentDigest !== assessment.assessmentDigest
      || disposition.blockingGateIds.join("|") !== assessment.blockingGateIds.join("|")) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    return { assessment, disposition };
  }

  verifyIntegrity(): { revision: number; recordCount: number; stateDigest: string } {
    this.open();
    this.schema();
    const meta = this.meta();
    const state = this.state();
    const expectedTag = hmacSha256Tag(this.#key,
      this.metaMaterial(Number(meta.revision), Number(meta.record_count), meta.state_digest));
    if (meta.tenant_id !== this.#scope.tenantId || meta.workspace_id !== this.#scope.workspaceId
      || meta.project_id !== this.#scope.projectId || Number(meta.record_count) !== state.recordCount
      || meta.state_digest !== state.stateDigest || meta.state_auth_tag !== expectedTag
      || Number(meta.revision) < 1) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    return { revision: Number(meta.revision), recordCount: state.recordCount, stateDigest: state.stateDigest };
  }

  private insert(kind: Kind, recordId: string, recordDigest: string, semanticKey: string,
    recordedAt: string, value: unknown): void {
    const payload = JSON.stringify(value);
    const recordAuthTag = hmacSha256Tag(this.#key, {
      kind,
      scope: this.#scope,
      id: recordId,
      digest: recordDigest,
      semanticKey,
      payloadDigest: sha256Digest(value),
      recordedAt,
    });
    this.#db.prepare("INSERT INTO abs_news_publication_readiness_records VALUES(?,?,?,?,?,?,?)")
      .run(kind, recordId, recordDigest, semanticKey, payload, recordAuthTag, recordedAt);
  }

  private verified(row: Row): unknown {
    const value = row.kind === "assessment"
      ? parseAbsNewsPublicationReadinessAssessmentV1(parseJson(row.payload))
      : parseAbsNewsPublicationDisabledDispositionV1(parseJson(row.payload));
    const digest = row.kind === "assessment"
      ? (value as AbsNewsPublicationReadinessAssessmentV1).assessmentDigest
      : (value as AbsNewsPublicationDisabledDispositionV1).dispositionDigest;
    const expectedTag = hmacSha256Tag(this.#key, {
      kind: row.kind,
      scope: this.#scope,
      id: row.record_id,
      digest: row.record_digest,
      semanticKey: row.semantic_key,
      payloadDigest: sha256Digest(value),
      recordedAt: row.recorded_at,
    });
    if (row.record_digest !== digest || row.record_auth_tag !== expectedTag) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    return value;
  }

  private current(kind: Kind, recordId: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM abs_news_publication_readiness_records WHERE kind=? AND record_id=?")
      .get(kind, recordId) as Row | undefined;
  }

  private bySemantic(kind: Kind, semanticKey: string): Row | undefined {
    return this.#db.prepare("SELECT * FROM abs_news_publication_readiness_records WHERE kind=? AND semantic_key=?")
      .get(kind, semanticKey) as Row | undefined;
  }

  private latestAssessmentRow(): Row | undefined {
    return this.#db.prepare("SELECT * FROM abs_news_publication_readiness_records WHERE kind='assessment' ORDER BY recorded_at DESC,record_id DESC LIMIT 1")
      .get() as Row | undefined;
  }

  private createSchema(): void {
    this.#db.exec("BEGIN IMMEDIATE; CREATE TABLE abs_news_publication_readiness_metadata(tenant_id TEXT NOT NULL,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,revision INTEGER NOT NULL,record_count INTEGER NOT NULL,state_digest TEXT NOT NULL,state_auth_tag TEXT NOT NULL); CREATE TABLE abs_news_publication_readiness_records(kind TEXT NOT NULL CHECK(kind IN ('assessment','disposition')),record_id TEXT NOT NULL,record_digest TEXT NOT NULL UNIQUE,semantic_key TEXT NOT NULL, payload TEXT NOT NULL,record_auth_tag TEXT NOT NULL,recorded_at TEXT NOT NULL,PRIMARY KEY(kind,record_id)); CREATE UNIQUE INDEX abs_news_publication_readiness_semantic ON abs_news_publication_readiness_records(kind,semantic_key); PRAGMA user_version=1; COMMIT;");
  }

  private initialize(): void {
    const state = this.state();
    const revision = 1;
    this.#db.prepare("INSERT INTO abs_news_publication_readiness_metadata VALUES(?,?,?,?,?,?,?)")
      .run(this.#scope.tenantId, this.#scope.workspaceId, this.#scope.projectId, revision, state.recordCount,
        state.stateDigest, hmacSha256Tag(this.#key, this.metaMaterial(revision, state.recordCount, state.stateDigest)));
  }

  private state(): { recordCount: number; stateDigest: string } {
    const rows = this.#db.prepare("SELECT * FROM abs_news_publication_readiness_records ORDER BY kind,record_id")
      .all() as unknown as Row[];
    const records = rows.map((row) => {
      this.verified(row);
      return { kind: row.kind, id: row.record_id, digest: row.record_digest, semanticKey: row.semantic_key,
        tag: row.record_auth_tag, recordedAt: row.recorded_at };
    });
    return { recordCount: records.length, stateDigest: sha256Digest({ scope: this.#scope, records }) };
  }

  private advance(): void {
    const meta = this.meta();
    const state = this.state();
    const revision = Number(meta.revision) + 1;
    const result = this.#db.prepare("UPDATE abs_news_publication_readiness_metadata SET revision=?,record_count=?,state_digest=?,state_auth_tag=? WHERE revision=?")
      .run(revision, state.recordCount, state.stateDigest,
        hmacSha256Tag(this.#key, this.metaMaterial(revision, state.recordCount, state.stateDigest)), meta.revision);
    if (Number(result.changes) !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }

  private meta(): Meta {
    const rows = this.#db.prepare("SELECT * FROM abs_news_publication_readiness_metadata").all() as unknown as Meta[];
    if (rows.length !== 1) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    return rows[0]!;
  }

  private metaMaterial(revision: number, recordCount: number, stateDigest: string) {
    return { kind: "metadata", scope: this.#scope, revision, recordCount, stateDigest };
  }

  private schema(): void {
    const tables = (this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as Array<{ name: string }>)
      .map((row) => row.name);
    if (tables.join("|") !== TABLES.join("|")) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    const objects = (this.#db.prepare("SELECT type,name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
      .all() as unknown as Array<{ type: string; name: string }>).map((row) => `${row.type}:${row.name}`);
    if (objects.join("|") !== SCHEMA_OBJECTS.join("|")) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }

  private scope(value: { tenantId: string; workspaceId: string; projectId: string }): void {
    if (value.tenantId !== this.#scope.tenantId || value.workspaceId !== this.#scope.workspaceId
      || value.projectId !== this.#scope.projectId) {
      throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
    }
  }

  private open(): void {
    if (this.#closed) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }

  private transaction<T>(operation: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#db.exec("ROLLBACK"); } catch { void 0; }
      throw error;
    }
  }
}
