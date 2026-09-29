import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { dataMethodV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { ideaDigestSchemaV1, ideaIdSchemaV1, ideaTimeSchemaV1 } from "./schemas";

export const IDEA_LAB_PROMOTION_TASK_LINK_V1 = "control-room-idea-lab-promotion-task-link/v1" as const;
const linkSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_PROMOTION_TASK_LINK_V1),
  tenantId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1,
  decisionDigest: ideaDigestSchemaV1,
  projectId: ideaIdSchemaV1,
  jobId: ideaIdSchemaV1,
  requestId: ideaIdSchemaV1,
  createdAt: ideaTimeSchemaV1,
  startsWork: z.literal(false),
  grantsAssignmentAuthority: z.literal(false),
  grantsApproval: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
  linkDigest: ideaDigestSchemaV1,
}).strict();
export type IdeaLabPromotionTaskLinkV1 = z.infer<typeof linkSchema>;
type Transaction = DatabaseClient["transaction"];
type Query = DatabaseSession["query"];

function safeEqual(left: string, right: string) {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function withoutDigest(value: IdeaLabPromotionTaskLinkV1) {
  const { linkDigest: _ignored, ...unsigned } = value;
  return unsigned;
}
function build(value: unknown): IdeaLabPromotionTaskLinkV1 {
  const input = parseExactIdeaLabV1(linkSchema.omit({ linkDigest: true }), value);
  return linkSchema.parse({ ...input, linkDigest: sha256Digest(input) });
}
function parse(value: unknown): IdeaLabPromotionTaskLinkV1 {
  const link = parseExactIdeaLabV1(linkSchema, value);
  if (link.linkDigest !== sha256Digest(withoutDigest(link))) throw new IdeaLabErrorV1("integrity_failed");
  return link;
}

/** Immutable provenance from an owner decision to the ordinary proposed task
 * created for the promoted project. The task lifecycle remains authoritative. */
export class IdeaLabPromotionTaskLinkStoreV1 {
  readonly #query: Query;
  readonly #transaction: Transaction;
  readonly #key: Uint8Array;
  constructor(db: DatabaseClient, integrityKey: Uint8Array) {
    if (!db || typeof db !== "object" || isHostProxyV1(db)) throw new IdeaLabErrorV1("invalid_input");
    const query = dataMethodV1(db, "query") as Query | undefined;
    const transaction = dataMethodV1(db, "transaction") as Transaction | undefined;
    const key = exactHostUint8ArrayV1(integrityKey, 32);
    if (!query || !transaction || !key) throw new IdeaLabErrorV1("invalid_input");
    this.#query = ((statement, params) => query.call(db, statement, params)) as Query;
    this.#transaction = ((work) => transaction.call(db, work)) as Transaction;
    this.#key = key.copy(); Object.freeze(this);
  }
  #tag(link: IdeaLabPromotionTaskLinkV1) {
    return hmacSha256Tag(this.#key, { kind: "idea_promotion_task_link", tenantId: link.tenantId,
      sessionId: link.sessionId, digest: link.linkDigest });
  }
  #verify(link: IdeaLabPromotionTaskLinkV1, supplied: string) {
    if (!safeEqual(this.#tag(link), supplied)) throw new IdeaLabErrorV1("integrity_failed");
  }
  async get(tenantId: string, sessionId: string): Promise<IdeaLabPromotionTaskLinkV1 | undefined> {
    const result = await this.#query<{ tenant_id: string; session_id: string; decision_digest: string; project_id: string;
      job_id: string; request_id: string; link_digest: string; link_auth_tag: string; created_at: string | Date }>(
      `SELECT tenant_id,session_id,decision_digest,project_id,job_id,request_id,link_digest,link_auth_tag,created_at
       FROM control_idea_promotion_task_links WHERE tenant_id=$1 AND session_id=$2`, [tenantId, sessionId]);
    const row = result.rows[0];
    if (!row) return undefined;
    const link = parse({ contractVersion: IDEA_LAB_PROMOTION_TASK_LINK_V1, tenantId: row.tenant_id,
      sessionId: row.session_id, decisionDigest: row.decision_digest, projectId: row.project_id,
      jobId: row.job_id, requestId: row.request_id, createdAt: new Date(row.created_at).toISOString(),
      startsWork: false, grantsAssignmentAuthority: false, grantsApproval: false, grantsExecutionAuthority: false,
      linkDigest: row.link_digest });
    this.#verify(link, row.link_auth_tag); return link;
  }
  async record(value: Omit<IdeaLabPromotionTaskLinkV1, "linkDigest">) {
    const link = build(value), tag = this.#tag(link);
    return this.#transaction(async tx => {
      const inserted = await tx.query<{ link_digest: string }>(`INSERT INTO control_idea_promotion_task_links(tenant_id,session_id,decision_digest,project_id,job_id,
        request_id,link_digest,link_auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (tenant_id,session_id) DO NOTHING RETURNING link_digest`, [link.tenantId, link.sessionId, link.decisionDigest,
        link.projectId, link.jobId, link.requestId, link.linkDigest, tag, link.createdAt]);
      const result = await tx.query<{ tenant_id: string; session_id: string; decision_digest: string; project_id: string;
        job_id: string; request_id: string; link_digest: string; link_auth_tag: string; created_at: string | Date }>(
        `SELECT tenant_id,session_id,decision_digest,project_id,job_id,request_id,link_digest,link_auth_tag,created_at
         FROM control_idea_promotion_task_links WHERE tenant_id=$1 AND session_id=$2 FOR SHARE`,
        [link.tenantId, link.sessionId]);
      const row = result.rows[0];
      if (!row) throw new IdeaLabErrorV1("integrity_failed");
      const stored = parse({ ...withoutDigest(link), decisionDigest: row.decision_digest, projectId: row.project_id,
        jobId: row.job_id, requestId: row.request_id, createdAt: new Date(row.created_at).toISOString(), linkDigest: row.link_digest });
      this.#verify(stored, row.link_auth_tag);
      if (stored.linkDigest !== link.linkDigest) throw new IdeaLabErrorV1("duplicate_record");
      return { link: stored, replayed: inserted.rows.length === 0 };
    });
  }
}
