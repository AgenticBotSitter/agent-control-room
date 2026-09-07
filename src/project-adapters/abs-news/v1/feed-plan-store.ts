import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../../persistence/database";
import { CanonicalStore } from "../../../persistence/canonical-store";
import { jobRecordSchema } from "../../../domain/v1";
import { localId } from "../../../harness/v1/native-run-identifiers";
import { hmacSha256Tag, sha256Digest } from "../../../security";
import { buildAbsFeedProposedWork, verifyAbsFeedJobPlan } from "./feed-job-plan";

type Work = ReturnType<typeof buildAbsFeedProposedWork>;
const scopeSchema = z.object({ tenantId: localId, workspaceId: localId, projectId: localId }).strict();
type Scope = z.infer<typeof scopeSchema>;
const fail = (): never => { throw new Error("abs_feed_plan_unavailable"); };
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });
function parseWork(value: unknown): Work {
  // Rebuild the fixed proposed shape; no caller-selected state, authority widening or labels.
  if (!value || typeof value !== "object") return fail();
  const work = value as Work;
  try {
    const rebuilt = buildAbsFeedProposedWork({ plan: work.plan, requestId: work.request.id, workflowId: work.workflow.id,
      ownerId: work.request.requestedBy.actorId, executorId: work.job.authority.allowedExecutor, expiresAt: work.job.authority.expiresAt });
    if (sha256Digest(work) !== sha256Digest(rebuilt)) return fail();
    return rebuilt;
  } catch { return fail(); }
}

/** Trusted SQL composition, not owner authentication. Keeps plan plus proposed canonical
 * records atomic; never creates approval, lease, effect or queue delivery. HMAC detects
 * record drift, not database rollback. No connection, migration or role setup here. */
export class AbsFeedPlanStore {
  private readonly scope: Scope;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, scope: Scope, key: Uint8Array) {
    this.scope = scopeSchema.parse(scope);
    if (!(key instanceof Uint8Array) || key.length !== 32) fail(); this.key = Uint8Array.from(key);
  }
  private check(work: Work) {
    const config = work.plan.configuration;
    if (config.tenantId !== this.scope.tenantId || config.workspaceId !== this.scope.workspaceId || config.projectId !== this.scope.projectId) fail();
  }
  private tag(work: Work) { return hmacSha256Tag(this.key, { purpose: "abs-feed-plan/v1", ...this.scope, work }); }
  private async project(tx: DatabaseSession) {
    if (!(await tx.query("SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3 FOR SHARE",
      [this.scope.tenantId, this.scope.workspaceId, this.scope.projectId])).rows.length) fail();
  }
  private async readWith(tx: DatabaseSession, jobId: string): Promise<Work | null> {
    const row = (await tx.query<{ workspace_id: string; project_id: string; input_digest: string; payload: unknown; auth_tag: string }>(
      "SELECT workspace_id,project_id,input_digest,payload,auth_tag FROM control_abs_feed_plans WHERE tenant_id=$1 AND job_id=$2",
      [this.scope.tenantId, jobId])).rows[0];
    if (!row) return null;
    const work = parseWork(row.payload); this.check(work);
    const actual = Buffer.from(row.auth_tag), expected = Buffer.from(this.tag(work));
    if (row.workspace_id !== this.scope.workspaceId || row.project_id !== this.scope.projectId || work.job.id !== jobId
      || row.input_digest !== work.job.inputDigest || actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail();
    const current = (await tx.query<{ payload: unknown; project_id: string }>(
      "SELECT payload,project_id FROM control_jobs WHERE tenant_id=$1 AND id=$2", [this.scope.tenantId, jobId])).rows[0];
    if (!current || current.project_id !== this.scope.projectId) return fail();
    const job = jobRecordSchema.parse(current.payload); verifyAbsFeedJobPlan(job, work.plan);
    if (sha256Digest({ ...job, state: "proposed", version: 0, updatedAt: job.createdAt }) !== sha256Digest(work.job)) fail();
    return work;
  }
  async get(jobId: string) {
    localId.parse(jobId);
    return this.db.transaction(async tx => { await this.project(tx); return this.readWith(tx, jobId); });
  }
  async saveProposed(value: unknown) {
    const work = parseWork(value); this.check(work);
    return this.db.transaction(async tx => {
      if (!(await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, this.scope.workspaceId])).rows.length) fail();
      await this.project(tx);
      const prior = await this.readWith(tx, work.job.id);
      if (prior) { if (sha256Digest(prior) !== sha256Digest(work)) fail(); return { work: prior, replayed: true }; }
      const canonical = new CanonicalStore(joined(tx));
      await canonical.create(work.request); await canonical.create(work.workflow); await canonical.create(work.job);
      await tx.query("INSERT INTO control_abs_feed_plans(tenant_id,workspace_id,project_id,job_id,input_digest,payload,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [this.scope.tenantId, this.scope.workspaceId, this.scope.projectId, work.job.id, work.job.inputDigest, work, this.tag(work)]);
      return { work, replayed: false };
    });
  }
}
