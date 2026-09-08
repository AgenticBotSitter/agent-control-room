import { DatabaseSync } from "node:sqlite";
import { assertNoSecretMaterial, sha256Digest } from "../../security";
import { localPolicyDecisionSchema } from "./schemas";
import type { LocalPolicyDecisionV1 } from "./types";

export interface AdmissionIdentityV1 {
  tenantId: string;
  nodeId: string;
  projectId: string;
  jobId: string;
  attemptId: string;
  operationDigest: string;
}

export interface DurableAdmissionInputV1 {
  messageId: string;
  identity: AdmissionIdentityV1;
  decision: LocalPolicyDecisionV1;
  recordedAt: string;
}

export interface DurableAdmissionRecordV1 extends DurableAdmissionInputV1 {
  admissionId: string;
  operationKey: string;
  decisionDigest: string;
  disposition: "accepted" | "refused";
}

export class AdmissionConflictError extends Error {
  constructor() {
    super("Local admission conflicts with durable history");
    this.name = "AdmissionConflictError";
  }
}

export function computeAdmissionOperationKey(identity: AdmissionIdentityV1): string {
  return sha256Digest(identity);
}

export function computeAdmissionId(identity: AdmissionIdentityV1, decision: LocalPolicyDecisionV1): string {
  return computeAdmissionIdFromDigests(identity, decision.requestDigest, decision.ceilingDigest, decision.authorityDigest);
}

export function computeAdmissionIdFromDigests(
  identity: AdmissionIdentityV1,
  requestDigest: string,
  ceilingDigest: string,
  authorityDigest: string,
): string {
  return sha256Digest({
    operationKey: computeAdmissionOperationKey(identity),
    requestDigest,
    ceilingDigest,
    authorityDigest,
  });
}

export class SqliteLocalAdmissionStore {
  private readonly db: DatabaseSync;

  constructor(path: string, options: { testOnlyAllowEphemeral?: boolean } = {}) {
    if ((path === ":memory:" || path.startsWith("file:")) && !options.testOnlyAllowEphemeral) {
      throw new Error("Durable admission store requires a filesystem path");
    }
    this.db = new DatabaseSync(path);
    try {
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_admissions (
        admission_id TEXT PRIMARY KEY,
        operation_key TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        operation_digest TEXT NOT NULL,
        request_digest TEXT NOT NULL,
        ceiling_digest TEXT NOT NULL,
        authority_digest TEXT NOT NULL,
        decision_digest TEXT NOT NULL,
        decision_json TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK(disposition IN ('accepted','refused')),
        recorded_at TEXT NOT NULL,
        UNIQUE(operation_key,request_digest,ceiling_digest,authority_digest)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS local_admissions_one_accept
        ON local_admissions(operation_key) WHERE disposition='accepted';
      CREATE TABLE IF NOT EXISTS local_admission_messages (
        message_id TEXT PRIMARY KEY,
        admission_id TEXT NOT NULL REFERENCES local_admissions(admission_id) ON DELETE RESTRICT
      );
      PRAGMA user_version=1;
    `);
    } catch (error) { this.db.close(); throw error; }
  }

  close(): void {
    this.db.close();
  }

  record(input: DurableAdmissionInputV1): "recorded" | "duplicate" {
    const decision = localPolicyDecisionSchema.parse(input.decision);
    assertNoSecretMaterial({ messageId: input.messageId, identity: input.identity, decision }, "local admission");
    const operationKey = computeAdmissionOperationKey(input.identity);
    const admissionId = computeAdmissionId(input.identity, decision);
    const decisionDigest = sha256Digest(decision);
    const disposition = decision.accepted ? "accepted" : "refused";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const priorMessage = this.db.prepare(
        `SELECT a.admission_id,a.decision_digest FROM local_admission_messages m JOIN local_admissions a ON a.admission_id=m.admission_id WHERE m.message_id=?`,
      ).get(input.messageId) as { admission_id: string; decision_digest: string } | undefined;
      if (priorMessage) {
        if (priorMessage.admission_id !== admissionId || priorMessage.decision_digest !== decisionDigest) throw new AdmissionConflictError();
        this.db.exec("COMMIT");
        return "duplicate";
      }
      const priorAdmission = this.db.prepare(
        `SELECT decision_digest FROM local_admissions WHERE admission_id=?`,
      ).get(admissionId) as { decision_digest: string } | undefined;
      if (priorAdmission) {
        if (priorAdmission.decision_digest !== decisionDigest) throw new AdmissionConflictError();
        this.db.prepare(`INSERT INTO local_admission_messages(message_id,admission_id) VALUES (?,?)`).run(input.messageId,admissionId);
        this.db.exec("COMMIT");
        return "duplicate";
      }
      if (disposition === "accepted" && this.db.prepare(
        `SELECT 1 FROM local_admissions WHERE operation_key=? AND disposition='accepted'`,
      ).get(operationKey)) throw new AdmissionConflictError();
      this.db.prepare(
        `INSERT INTO local_admissions(
          admission_id,operation_key,tenant_id,node_id,project_id,job_id,attempt_id,operation_digest,
          request_digest,ceiling_digest,authority_digest,decision_digest,decision_json,disposition,recorded_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        admissionId,operationKey,input.identity.tenantId,input.identity.nodeId,input.identity.projectId,
        input.identity.jobId,input.identity.attemptId,input.identity.operationDigest,decision.requestDigest,
        decision.ceilingDigest,decision.authorityDigest,decisionDigest,JSON.stringify(decision),disposition,input.recordedAt,
      );
      this.db.prepare(`INSERT INTO local_admission_messages(message_id,admission_id) VALUES (?,?)`).run(input.messageId,admissionId);
      this.db.exec("COMMIT");
      return "recorded";
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* retain the original safe conflict */ }
      if (error instanceof AdmissionConflictError) throw error;
      if (error instanceof Error && error.message.includes("local_admissions_one_accept")) throw new AdmissionConflictError();
      throw error;
    }
  }

  findByMessage(messageId: string): DurableAdmissionRecordV1 | undefined {
    const row = this.db.prepare(
      `SELECT a.*,m.message_id FROM local_admission_messages m JOIN local_admissions a ON a.admission_id=m.admission_id WHERE m.message_id=?`,
    ).get(messageId) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  findEquivalent(identity: AdmissionIdentityV1, requestDigest: string, ceilingDigest: string, authorityDigest: string): DurableAdmissionRecordV1 | undefined {
    const admissionId = computeAdmissionIdFromDigests(identity, requestDigest, ceilingDigest, authorityDigest);
    const row = this.db.prepare(
      `SELECT a.*,m.message_id FROM local_admissions a LEFT JOIN local_admission_messages m ON m.admission_id=a.admission_id
       WHERE a.admission_id=? ORDER BY m.message_id LIMIT 1`,
    ).get(admissionId) as Record<string, unknown> | undefined;
    return row ? this.fromRow(row) : undefined;
  }

  count(): number {
    return Number((this.db.prepare(`SELECT count(*) AS count FROM local_admissions`).get() as { count: number }).count);
  }

  private fromRow(row: Record<string, unknown>): DurableAdmissionRecordV1 {
    const record: DurableAdmissionRecordV1 = {
      admissionId: String(row.admission_id), operationKey: String(row.operation_key), messageId: String(row.message_id),
      identity: {
        tenantId: String(row.tenant_id), nodeId: String(row.node_id), projectId: String(row.project_id),
        jobId: String(row.job_id), attemptId: String(row.attempt_id), operationDigest: String(row.operation_digest),
      },
      decision: localPolicyDecisionSchema.parse(JSON.parse(String(row.decision_json))),
      decisionDigest: String(row.decision_digest), disposition: row.disposition as "accepted" | "refused",
      recordedAt: String(row.recorded_at),
    };
    if (computeAdmissionOperationKey(record.identity) !== record.operationKey
      || computeAdmissionId(record.identity, record.decision) !== record.admissionId
      || sha256Digest(record.decision) !== record.decisionDigest
      || (record.decision.accepted ? "accepted" : "refused") !== record.disposition) throw new AdmissionConflictError();
    return record;
  }
}
