import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import { computeEffectOperationDigest, sha256Digest } from "../../security";
import { CanonicalStore } from "../../persistence/canonical-store";
import { effectIntentRecordSchema, jobRecordSchema } from "../../domain/v1";
import { newsCollectionState, newsCollectionStatusSchema, newsCollectionHistorySchema } from "./news-collection-status-wire";
import { appendAuditWith } from "../../audit/audit-store";
import { absFeedCollectionConfigurationSchema } from "../../project-adapters/abs-news/v1/feed-collection";
import { absDiscoveryJobConfigurationSchema } from "../../project-adapters/abs-news/v1/discovery-job-configuration";
import { PostgresNewsSourceSettings } from "../../project-adapters/abs-news/v1/source-settings";
import { AbsFeedPlanStore } from "../../project-adapters/abs-news/v1/feed-plan-store";
import { buildAbsFeedProposedWork } from "../../project-adapters/abs-news/v1/feed-job-plan";
import { WebSessionAuthority } from "./session-authority";
import { WebProjectService } from "./project-service";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";

const inputSchema = z.object({ sourceDigest: digestSchema, idempotencyKey: localId.refine(value => value.length >= 12) }).strict();
const templateSchema = z.object({ configuration: z.union([absFeedCollectionConfigurationSchema, absDiscoveryJobConfigurationSchema]),
  executorId: localId.refine(value => value !== "executor:unassigned"), windowSeconds: z.number().int().min(60).max(3600) }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });

/** Fixed server-configured source. Owner can propose a collection, not supply a URL,
 * executor or ceiling. No HTTP mounting, ready transition, effect grant or queue write. */
export class WebNewsCollectionPlanning {
  private readonly template: z.infer<typeof templateSchema>;
  private readonly authority: WebSessionAuthority;
  private readonly projects: WebProjectService;
  private readonly key: Uint8Array;
  readonly sourceDigest: string;
  constructor(db: DatabaseClient, template: unknown, key: Uint8Array, clock: () => number = Date.now) {
    this.template = templateSchema.parse(template);
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("news_plan_key_invalid"); this.key = Uint8Array.from(key);
    this.sourceDigest = sha256Digest(this.template);
    const { tenantId, workspaceId } = this.template.configuration;
    this.authority = new WebSessionAuthority(db, { tenantId, workspaceId }, clock, "task");
    this.projects = new WebProjectService(db, { tenantId, workspaceId }, clock);
  }
  async describe(identity: VerifiedWebIdentity) {
    return this.authority.authenticated(identity, async (tx, actor) => {
      const { configuration } = this.template, { tenantId, workspaceId, projectId, source } = configuration;
      actor.require("tasks.read", projectId);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      let sourceCurrent = true;
      if ("limits" in configuration) {
        const setting = await new PostgresNewsSourceSettings(joined(tx), { tenantId, workspaceId, projectId }, this.key).get(source.sourceId);
        sourceCurrent = !!setting?.source.enabled && setting.revision === configuration.expectedRevision
          && setting.source.name === source.sourceLabel && setting.source.url === source.endpointUrl;
      }
      return { projectId, sourceId: source.sourceId, configured: true as const, sourceDigest: this.sourceDigest,
        sourceLabel: source.sourceLabel, endpointUrl: source.endpointUrl,
        mode: "limits" in configuration ? "discovery" as const : "feed" as const,
        allowedOrigins: "limits" in configuration ? [...configuration.allowedOrigins] : [new URL(source.endpointUrl).origin + "/"],
        limits: "limits" in configuration ? { ...configuration.limits }
          : { timeoutMs: configuration.timeoutMs, maxAttempts: 1, maxDocumentBytes: configuration.maxBytes, maxReservedBodyBytes: configuration.maxBytes },
        canRefresh: sourceCurrent && project.lifecycle === "active" && actor.can("tasks.propose", projectId, true) && actor.can("tasks.approve", projectId, true),
        sourceCurrent, startsWork: false as const };
    });
  }
  /** Saved evidence only: no enqueue, lease transition, source fetch or retry.
   * Without a job ID, rediscover the latest retained plan for this fixed source. */
  async status(identity: VerifiedWebIdentity, jobId?: string) {
    if (jobId !== undefined && !localId.safeParse(jobId).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      const { tenantId, workspaceId, projectId, source } = this.template.configuration;
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const result = { projectId, sourceId: source.sourceId, configured: true, observedAt: actor.now };
      const db = joined(tx), plans = new AbsFeedPlanStore(db, { tenantId, workspaceId, projectId }, this.key);
      let selected = jobId;
      if (selected === undefined) {
        // Source identity and ordering live in signed plans. Filtering unsigned
        // JSON first could hide corrupted work. Refuse an incomplete inventory;
        // exact-job reads remain available for larger histories.
        const candidates = (await tx.query<{ job_id: string }>(
          "SELECT job_id FROM control_abs_feed_plans WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3 LIMIT 101",
          [tenantId, workspaceId, projectId])).rows;
        if (candidates.length > 100) throw new Error("news_collection_history_requires_exact_job");
        let latest: { id: string; createdAt: string } | undefined;
        for (const row of candidates) {
          const candidate = await plans.get(row.job_id);
          if (!candidate) throw new Error("news_collection_status_unavailable");
          if (candidate.plan.configuration.source.sourceId !== source.sourceId) continue;
          if (!latest || Date.parse(candidate.job.createdAt) > Date.parse(latest.createdAt)
            || candidate.job.createdAt === latest.createdAt && candidate.job.id > latest.id)
            latest = { id: candidate.job.id, createdAt: candidate.job.createdAt };
        }
        selected = latest?.id;
      }
      if (!selected) return newsCollectionStatusSchema.parse({ ...result, latest: null });
      // The collector settles job and effect atomically under this job lock.
      // Hold a shared lock so the projection cannot mix before/after settlement.
      await tx.query("SELECT id FROM control_jobs WHERE tenant_id=$1 AND id=$2 FOR SHARE", [tenantId, selected]);
      const work = await plans.get(selected);
      if (!work || work.plan.configuration.source.sourceId !== source.sourceId) throw new WebAccessError("not_found");
      const canonical = new CanonicalStore(db), job = jobRecordSchema.parse(await canonical.get(tenantId, "job", selected));
      const suffix = sha256Digest({ tenantId, projectId, jobId: selected, inputDigest: work.job.inputDigest }).slice(7, 47);
      const rawEffect = await canonical.get(tenantId, "effect_intent", `effect:abs-feed:${suffix}`);
      const effect = rawEffect ? effectIntentRecordSchema.parse(rawEffect) : null;
      if (effect && (effect.tenantId !== tenantId || effect.jobId !== selected || effect.attemptId !== `attempt:abs-feed:${suffix}`
        || effect.approvalId !== `approval:abs-feed:${suffix}` || effect.idempotencyKey !== `abs-feed-effect:${suffix}`
        || effect.operation !== work.job.authority.allowedOperations[0] || effect.destination !== work.job.authority.allowedNetworkDestinations[0]
        || effect.operationDigest !== computeEffectOperationDigest(effect, projectId)
        || effect.state === "confirmed" && !digestSchema.safeParse(effect.destinationReceipt).success))
        throw new Error("news_collection_status_unavailable");
      return newsCollectionStatusSchema.parse({ ...result, latest: { jobId: selected, jobState: job.state,
        effectState: effect?.state ?? null, state: newsCollectionState(job.state, effect?.state ?? null),
        updatedAt: effect && Date.parse(effect.updatedAt) > Date.parse(job.updatedAt) ? effect.updatedAt : job.updatedAt } });
    });
  }
  async history(identity: VerifiedWebIdentity, after?: string) {
    if (after !== undefined && !localId.safeParse(after).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      const { tenantId, workspaceId, projectId, source } = this.template.configuration;
      actor.require("tasks.read", projectId);
      await this.projects.getViewInSession(tx, actor, projectId);
      const candidates = (await tx.query<{ job_id: string }>(
        `SELECT job_id FROM control_abs_feed_plans WHERE tenant_id=$1 AND workspace_id=$2 AND project_id=$3
         AND ($4::text IS NULL OR job_id COLLATE "C">$4::text COLLATE "C")
         ORDER BY job_id COLLATE "C" ASC LIMIT 26`,
        [tenantId, workspaceId, projectId, after ?? null])).rows;
      const page = candidates.slice(0, 25), plans = new AbsFeedPlanStore(joined(tx), { tenantId, workspaceId, projectId }, this.key);
      const entries: { jobId: string; createdAt: string }[] = [];
      for (const row of page) {
        const work = await plans.get(row.job_id);
        if (!work) throw new Error("news_collection_history_unavailable");
        if (work.plan.configuration.source.sourceId === source.sourceId)
          entries.push({ jobId: work.job.id, createdAt: work.job.createdAt });
      }
      return newsCollectionHistorySchema.parse({ projectId, sourceId: source.sourceId, configured: true, observedAt: actor.now,
        after: after ?? null, scanned: page.length, nextCursor: candidates.length > 25 ? page.at(-1)!.job_id : null, entries });
    });
  }
  async propose(identity: VerifiedWebIdentity, value: unknown) {
    const parsed = inputSchema.safeParse(value);
    if (!parsed.success) throw new WebAccessError("invalid_request");
    const input = parsed.data, { configuration, executorId, windowSeconds } = this.template;
    if (input.sourceDigest !== sha256Digest(this.template)) throw new WebAccessError("conflict");
    return this.authority.authenticated(identity, async (tx, actor) => {
      const { tenantId, workspaceId, projectId } = configuration;
      actor.require("tasks.read", projectId, true); actor.require("tasks.propose", projectId, true);
      // Serialize with plan saves and current owner operations; the outer authority owns precommit.
      await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, workspaceId]);
      const project = await this.projects.getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active") throw new WebAccessError("conflict");
      if ("limits" in configuration) {
        const setting = await new PostgresNewsSourceSettings(joined(tx), { tenantId, workspaceId, projectId }, this.key).get(configuration.source.sourceId);
        if (!setting?.source.enabled || setting.revision !== configuration.expectedRevision
          || setting.source.name !== configuration.source.sourceLabel || setting.source.url !== configuration.source.endpointUrl)
          throw new WebAccessError("conflict");
      }
      const suffix = sha256Digest({ tenantId, workspaceId, projectId, ownerId: actor.id, requestKey: input.idempotencyKey }).slice(7, 47);
      const jobId = `job:abs-feed:${suffix}`, store = new AbsFeedPlanStore(joined(tx), { tenantId, workspaceId, projectId }, this.key);
      const prior = await store.get(jobId);
      if (prior) {
        if (sha256Digest(prior.plan.configuration) !== sha256Digest(configuration) || prior.request.requestedBy.actorId !== actor.id
          || prior.job.authority.allowedExecutor !== executorId
          || Date.parse(prior.job.authority.expiresAt) - Date.parse(prior.plan.plannedAt) !== windowSeconds * 1000)
          throw new WebAccessError("conflict");
        return { jobId, inputDigest: prior.job.inputDigest, sourceDigest: input.sourceDigest, replayed: true, startsWork: false as const };
      }
      const work = buildAbsFeedProposedWork({ plan: { schema: "limits" in configuration ? "control-room.abs-discovery-plan/v1" : "control-room.abs-feed-plan/v1", jobId, configuration, plannedAt: actor.now },
        requestId: `request:abs-feed:${suffix}`, workflowId: `workflow:abs-feed:${suffix}`, ownerId: actor.id, executorId,
        expiresAt: new Date(Date.parse(actor.now) + windowSeconds * 1000).toISOString() });
      await store.saveProposed(work);
      await appendAuditWith(tx, { id: `audit:abs-feed-plan:${suffix}`, tenantId, workspaceId, actorId: actor.id, actorType: "human",
        action: "tasks.propose", targetType: "job", targetId: jobId, idempotencyKey: `abs-feed-plan:${suffix}`, occurredAt: actor.now,
        safeMetadata: { inputDigest: work.job.inputDigest, sourceDigest: input.sourceDigest, startsWork: false } });
      return { jobId, inputDigest: work.job.inputDigest, sourceDigest: input.sourceDigest, replayed: false, startsWork: false as const };
    });
  }
}
