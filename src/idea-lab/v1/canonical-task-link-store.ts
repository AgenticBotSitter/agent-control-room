import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import { dataMethodV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { taskReceiptSchema, type TaskReceipt } from "../../web/v1/task-wire";
import { type IdeaLabCanonicalTaskPlanV1, parseIdeaLabCanonicalTaskPlanV1 } from "./canonical-task-plan";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { ideaDigestSchemaV1, ideaIdSchemaV1, ideaTimeSchemaV1 } from "./schemas";

export const IDEA_LAB_CANONICAL_TASK_LINK_V1 = "control-room-idea-lab-canonical-task-link/v1" as const;

const linkSchema = z.object({
  contractVersion: z.literal(IDEA_LAB_CANONICAL_TASK_LINK_V1),
  tenantId: ideaIdSchemaV1,
  workspaceId: ideaIdSchemaV1,
  projectId: ideaIdSchemaV1,
  sessionId: ideaIdSchemaV1,
  sessionDigest: ideaDigestSchemaV1,
  taskKey: ideaIdSchemaV1,
  participantId: ideaIdSchemaV1,
  round: z.number().int().min(1).max(3),
  taskPlanDigest: ideaDigestSchemaV1,
  taskInputDigest: ideaDigestSchemaV1,
  jobId: ideaIdSchemaV1,
  requestId: ideaIdSchemaV1,
  createdAt: ideaTimeSchemaV1,
  plan: z.unknown(),
  linkDigest: ideaDigestSchemaV1,
}).strict();
export type IdeaLabCanonicalTaskLinkV1 = z.infer<typeof linkSchema>;
type Query = DatabaseSession["query"];
type Transaction = DatabaseClient["transaction"];

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function withoutDigest(value: IdeaLabCanonicalTaskLinkV1): Omit<IdeaLabCanonicalTaskLinkV1, "linkDigest"> {
  const { linkDigest: _ignored, ...unsigned } = value;
  return unsigned;
}
function bindingDigest(plan: IdeaLabCanonicalTaskPlanV1): string {
  return sha256Digest({ contractVersion: "control-room-idea-lab-canonical-task-session-binding/v1",
    tenantId: plan.tenantId, workspaceId: plan.workspaceId, projectId: plan.projectId,
    sessionId: plan.sessionId, sessionDigest: plan.sessionDigest });
}
function buildLink(planValue: unknown, receiptValue: unknown): IdeaLabCanonicalTaskLinkV1 {
  const plan = parseIdeaLabCanonicalTaskPlanV1(planValue);
  const receipt = taskReceiptSchema.parse(receiptValue);
  if (receipt.projectId !== plan.projectId || receipt.submission !== "proposed" || receipt.startsWork) {
    throw new IdeaLabErrorV1("scope_mismatch");
  }
  const unsigned = {
    contractVersion: IDEA_LAB_CANONICAL_TASK_LINK_V1,
    tenantId: plan.tenantId,
    workspaceId: plan.workspaceId,
    projectId: plan.projectId,
    sessionId: plan.sessionId,
    sessionDigest: plan.sessionDigest,
    taskKey: plan.taskKey,
    participantId: plan.participantId,
    round: plan.round,
    taskPlanDigest: plan.planDigest,
    taskInputDigest: plan.inputDigest,
    jobId: receipt.jobId,
    requestId: receipt.requestId,
    createdAt: receipt.createdAt,
    plan,
  };
  return linkSchema.parse({ ...unsigned, linkDigest: sha256Digest(unsigned) });
}
function parseLink(value: unknown): IdeaLabCanonicalTaskLinkV1 {
  const link = parseExactIdeaLabV1(linkSchema, value);
  const plan = parseIdeaLabCanonicalTaskPlanV1(link.plan);
  if (link.linkDigest !== sha256Digest(withoutDigest(link))
    || link.tenantId !== plan.tenantId || link.workspaceId !== plan.workspaceId || link.projectId !== plan.projectId
    || link.sessionId !== plan.sessionId || link.sessionDigest !== plan.sessionDigest || link.taskKey !== plan.taskKey
    || link.participantId !== plan.participantId || link.round !== plan.round || link.taskPlanDigest !== plan.planDigest
    || link.taskInputDigest !== plan.inputDigest) throw new IdeaLabErrorV1("integrity_failed");
  return link;
}

/** Append-only provenance links. They make the discussion-to-task relationship
 * durable, but never carry task state, an execution permission, or a result. */
export class IdeaLabCanonicalTaskLinkStoreV1 {
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
    this.#transaction = ((callback) => transaction.call(db, callback)) as Transaction;
    this.#key = key.copy(); Object.freeze(this);
  }
  #tag(kind: string, tenantId: string, id: string, digest: string) {
    return hmacSha256Tag(this.#key, { kind, tenantId, id, digest });
  }
  #verify(kind: string, tenantId: string, id: string, digest: string, supplied: string) {
    if (!safeEqual(this.#tag(kind, tenantId, id, digest), supplied)) throw new IdeaLabErrorV1("integrity_failed");
  }

  /** Records or verifies the one ordinary project that owns this discussion.
   * This is intentionally performed before proposing a task, so a conflicting
   * project cannot receive even one stray proposed task. */
  async bindSession(planValue: unknown): Promise<{ replayed: boolean }> {
    const plan = parseIdeaLabCanonicalTaskPlanV1(planValue);
    const binding = bindingDigest(plan);
    return this.#transaction(async (tx) => {
      const session = await tx.query<{ project_id: string; session_digest: string; binding_digest: string; binding_auth_tag: string }>(
        `SELECT project_id,session_digest,binding_digest,binding_auth_tag FROM control_idea_canonical_task_sessions
         WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE`, [plan.tenantId, plan.sessionId]);
      if (session.rows[0]) {
        const stored = session.rows[0];
        this.#verify("idea_task_session", plan.tenantId, plan.sessionId, stored.binding_digest, stored.binding_auth_tag);
        if (stored.project_id !== plan.projectId || stored.session_digest !== plan.sessionDigest || stored.binding_digest !== binding) {
          throw new IdeaLabErrorV1("scope_mismatch");
        }
        return { replayed: true };
      }
      const tag = this.#tag("idea_task_session", plan.tenantId, plan.sessionId, binding);
      await tx.query(`INSERT INTO control_idea_canonical_task_sessions(tenant_id,session_id,session_digest,workspace_id,project_id,
        binding_digest,binding_auth_tag,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (tenant_id,session_id) DO NOTHING`, [plan.tenantId, plan.sessionId, plan.sessionDigest,
        plan.workspaceId, plan.projectId, binding, tag, new Date().toISOString()]);
      const inserted = await tx.query<{ project_id: string; session_digest: string; binding_digest: string; binding_auth_tag: string }>(
        `SELECT project_id,session_digest,binding_digest,binding_auth_tag FROM control_idea_canonical_task_sessions
         WHERE tenant_id=$1 AND session_id=$2 FOR UPDATE`, [plan.tenantId, plan.sessionId]);
      const stored = inserted.rows[0];
      if (!stored) throw new IdeaLabErrorV1("integrity_failed");
      this.#verify("idea_task_session", plan.tenantId, plan.sessionId, stored.binding_digest, stored.binding_auth_tag);
      if (stored.project_id !== plan.projectId || stored.session_digest !== plan.sessionDigest || stored.binding_digest !== binding) {
        throw new IdeaLabErrorV1("scope_mismatch");
      }
      return { replayed: false };
    });
  }

  /** Refuses a changed plan for an already linked participant turn before a
   * caller asks the normal task service to create anything. */
  async assertPlanAvailable(planValue: unknown): Promise<void> {
    const plan = parseIdeaLabCanonicalTaskPlanV1(planValue);
    const result = await this.#query<{ payload: unknown; link_auth_tag: string }>(
      `SELECT payload,link_auth_tag FROM control_idea_canonical_task_links WHERE tenant_id=$1 AND task_key=$2`,
      [plan.tenantId, plan.taskKey]);
    const row = result.rows[0];
    if (!row) return;
    const existing = parseLink(row.payload);
    this.#verify("idea_task_link", existing.tenantId, existing.taskKey, existing.linkDigest, row.link_auth_tag);
    if (existing.taskPlanDigest !== plan.planDigest) throw new IdeaLabErrorV1("scope_mismatch");
  }

  async record(planValue: unknown, receiptValue: unknown): Promise<{ link: IdeaLabCanonicalTaskLinkV1; replayed: boolean }> {
    const link = buildLink(planValue, receiptValue);
    await this.bindSession(link.plan);
    return this.#transaction(async (tx) => {
      const existing = await tx.query<{ payload: unknown; link_auth_tag: string }>(
        `SELECT payload,link_auth_tag FROM control_idea_canonical_task_links WHERE tenant_id=$1 AND task_key=$2 FOR UPDATE`,
        [link.tenantId, link.taskKey]);
      if (existing.rows[0]) {
        const stored = parseLink(existing.rows[0].payload);
        this.#verify("idea_task_link", stored.tenantId, stored.taskKey, stored.linkDigest, existing.rows[0].link_auth_tag);
        if (stored.linkDigest !== link.linkDigest) throw new IdeaLabErrorV1("duplicate_record");
        return { link: stored, replayed: true };
      }
      const tag = this.#tag("idea_task_link", link.tenantId, link.taskKey, link.linkDigest);
      await tx.query(`INSERT INTO control_idea_canonical_task_links(tenant_id,task_key,session_id,session_digest,workspace_id,project_id,
        participant_id,round,task_plan_digest,task_input_digest,job_id,request_id,link_digest,link_auth_tag,payload,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16)`, [link.tenantId, link.taskKey,
        link.sessionId, link.sessionDigest, link.workspaceId, link.projectId, link.participantId, link.round,
        link.taskPlanDigest, link.taskInputDigest, link.jobId, link.requestId, link.linkDigest, tag, JSON.stringify(link), link.createdAt]);
      return { link, replayed: false };
    });
  }

  async list(tenantId: string, sessionId: string): Promise<IdeaLabCanonicalTaskLinkV1[]> {
    ideaIdSchemaV1.parse(tenantId); ideaIdSchemaV1.parse(sessionId);
    const result = await this.#query<{ payload: unknown; link_auth_tag: string }>(
      `SELECT payload,link_auth_tag FROM control_idea_canonical_task_links WHERE tenant_id=$1 AND session_id=$2
       ORDER BY round,participant_id`, [tenantId, sessionId]);
    return result.rows.map((row) => {
      const link = parseLink(row.payload);
      this.#verify("idea_task_link", link.tenantId, link.taskKey, link.linkDigest, row.link_auth_tag);
      return link;
    });
  }
}
