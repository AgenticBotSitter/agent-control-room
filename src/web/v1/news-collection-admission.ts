import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { CanonicalStore } from "../../persistence/canonical-store";
import { DOMAIN_CONTRACT_VERSION, effectIntentRecordSchema, approvalRecordSchema, jobRecordSchema } from "../../domain/v1";
import { SecurityStore } from "../../security/security-store";
import { appendAuditWith } from "../../audit/audit-store";
import { computeEffectOperationDigest, sha256Digest } from "../../security";
import { localId, digestSchema } from "../../harness/v1/native-run-identifiers";
import type { AbsFeedJobReference } from "../../persistence/pg-boss-abs-feed-worker";
import { AbsFeedPlanStore } from "../../project-adapters/abs-news/v1/feed-plan-store";
import { ABS_FEED_JOB } from "../../project-adapters/abs-news/v1/feed-job-plan";
import { PostgresNewsSourceSettings } from "../../project-adapters/abs-news/v1/source-settings";
import { WebSessionAuthority } from "./session-authority";
import { WebProjectService } from "./project-service";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";

const scopeSchema = z.object({ tenantId: localId, workspaceId: localId, projectId: localId, nodeId: localId, executorId: localId }).strict();
const inputSchema = z.object({ jobId: localId, inputDigest: digestSchema }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });

/** Owner admission for a separately configured collector assignment. No runtime factory or
 * network invocation. Startup must qualify that collector before installing this operation.
 * Queue delivery still requires a durable pre-effect claim and fresh authority validation. */
export class WebNewsCollectionAdmission {
  private readonly scope: z.infer<typeof scopeSchema>;
  private readonly key: Uint8Array;
  private readonly enqueue: (tx: DatabaseSession, reference: AbsFeedJobReference) => Promise<void>;
  constructor(private readonly db: DatabaseClient, scope: unknown, key: Uint8Array,
    submission: { enqueueInSession(tx: DatabaseSession, reference: AbsFeedJobReference): Promise<void> },
    private readonly clock: () => number = Date.now,
    private readonly collectionMode: "feed" | "discovery" = "feed") {
    this.scope = scopeSchema.parse(scope);
    if (!(key instanceof Uint8Array) || key.length !== 32 || this.scope.executorId === "executor:unassigned") throw new Error("news_admission_config_invalid");
    this.key = Uint8Array.from(key); this.enqueue = submission.enqueueInSession.bind(submission);
  }
  async approve(identity: VerifiedWebIdentity, value: unknown, expectedSourceId?: string) {
    if (expectedSourceId !== undefined) expectedSourceId = localId.parse(expectedSourceId);
    const parsed = inputSchema.safeParse(value); if (!parsed.success) throw new WebAccessError("invalid_request");
    const input = parsed.data, { tenantId, workspaceId, projectId, nodeId, executorId } = this.scope;
    identity = { ...identity }; let deadline: number | undefined;
    const db: DatabaseClient = { query: this.db.query.bind(this.db), transaction: this.db.transaction.bind(this.db),
      transactionWithPreCommitCheck: (work, check) => this.db.transactionWithPreCommitCheck(work, async () => {
        await check(); if (deadline !== undefined && this.clock() >= deadline) throw new WebAccessError("conflict");
      }) };
    return new WebSessionAuthority(db, { tenantId, workspaceId }, this.clock, "task").authenticated(identity, async (tx, actor) => {
      actor.require("tasks.read", projectId, true); actor.require("tasks.approve", projectId, true);
      await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, workspaceId]);
      const project = await new WebProjectService(joined(tx), { tenantId, workspaceId }, this.clock).getViewInSession(tx, actor, projectId);
      if (project.lifecycle !== "active") throw new WebAccessError("conflict");
      const work = await new AbsFeedPlanStore(joined(tx), { tenantId, workspaceId, projectId }, this.key).get(input.jobId);
      if (!work || work.job.inputDigest !== input.inputDigest || work.job.authority.allowedExecutor !== executorId) throw new WebAccessError("conflict");
      if (expectedSourceId !== undefined && work.plan.configuration.source.sourceId !== expectedSourceId)
        throw new WebAccessError("conflict");
      if ((work.plan.schema === "control-room.abs-discovery-plan/v1") !== (this.collectionMode === "discovery"))
        throw new WebAccessError("conflict");
      if (work.plan.schema === "control-room.abs-discovery-plan/v1") {
        const config = work.plan.configuration;
        const setting = await new PostgresNewsSourceSettings(joined(tx), { tenantId, workspaceId, projectId }, this.key).get(config.source.sourceId);
        if (!setting?.source.enabled || setting.revision !== config.expectedRevision
          || setting.source.name !== config.source.sourceLabel || setting.source.url !== config.source.endpointUrl)
          throw new WebAccessError("conflict");
      }
      const canonical = new CanonicalStore(joined(tx)), suffix = sha256Digest({ tenantId, projectId, jobId: input.jobId, inputDigest: input.inputDigest }).slice(7, 47);
      const effectId = `effect:abs-feed:${suffix}`, attemptId = `attempt:abs-feed:${suffix}`, approvalId = `approval:abs-feed:${suffix}`;
      const base = { contractVersion: DOMAIN_CONTRACT_VERSION, tenantId, version: 0, createdAt: actor.now, updatedAt: actor.now };
      const effect = effectIntentRecordSchema.parse({ ...base, kind: "effect_intent", id: effectId, jobId: input.jobId, attemptId,
        operation: work.job.authority.allowedOperations[0], operationDigest: sha256Digest("pending"), destination: work.job.authority.allowedNetworkDestinations[0],
        idempotencyKey: `abs-feed-effect:${suffix}`, risk: "low", state: "proposed", approvalId });
      effect.operationDigest = computeEffectOperationDigest(effect, projectId);
      const reference: AbsFeedJobReference = { schema: "control-room.abs-feed-job/v1", tenantId, projectId,
        jobId: input.jobId, attemptId, effectId, operationDigest: effect.operationDigest };
      const previous = await canonical.get(tenantId, "effect_intent", effectId);
      if (previous) {
        const saved = effectIntentRecordSchema.parse(previous);
        if (saved.jobId !== input.jobId || saved.attemptId !== attemptId || saved.operationDigest !== effect.operationDigest
          || saved.approvalId !== approvalId || saved.operation !== effect.operation || saved.destination !== effect.destination)
          throw new WebAccessError("conflict");
        // History is not resubmission permission, including after operational queue retention.
        return { ...reference, replayed: true, effectState: saved.state, networkContacted: false as const };
      }
      // The workspace lock serializes distinct request keys as well as exact
      // retries. Uncertain effects still occupy the source until resolved.
      // Use retained plans rather than trusting a caller's source identifier.
      const active = await tx.query<{ job_id: string }>(
        `SELECT DISTINCT p.job_id FROM control_abs_feed_plans p
         JOIN control_effect_intents e ON e.tenant_id=p.tenant_id AND e.job_id=p.job_id
         WHERE p.tenant_id=$1 AND p.workspace_id=$2 AND p.project_id=$3
           AND e.state NOT IN ('confirmed','failed','cancelled')`,
        [tenantId, workspaceId, projectId]);
      const plans = new AbsFeedPlanStore(joined(tx), { tenantId, workspaceId, projectId }, this.key);
      for (const row of active.rows) {
        const retained = await plans.get(row.job_id);
        if (!retained || retained.plan.configuration.source.sourceId === work.plan.configuration.source.sourceId)
          throw new WebAccessError("conflict");
      }
      const job = jobRecordSchema.parse(await canonical.get(tenantId, "job", input.jobId));
      deadline = Math.min(Date.parse(job.authority.expiresAt), Date.parse(identity.expiresAt), Date.parse(identity.verificationExpiresAt),
        Date.parse(actor.now) + ABS_FEED_JOB.maximumDurationSeconds * 1000);
      if (job.state !== "proposed" || job.version !== 0 || deadline - Date.parse(actor.now) < ABS_FEED_JOB.maximumDurationSeconds * 1000)
        throw new WebAccessError("conflict");
      const actorRef = { actorId: actor.id, actorType: "human" as const };
      const ready = await canonical.transition({ tenantId, kind: "job", entityId: job.id, expectedVersion: 0, toState: "ready",
        transitionId: `transition:feed-ready:${suffix}`, idempotencyKey: `feed-ready:${suffix}`, actor: actorRef, occurredAt: actor.now });
      await canonical.claimReadyJob({ tenantId, jobId: job.id, expectedJobVersion: ready.entity.version, nodeId,
        attemptId, leaseId: `lease:abs-feed:${suffix}`, transitionId: `transition:feed-claim:${suffix}`,
        idempotencyKey: `feed-claim:${suffix}`, actor: actorRef, acquiredAt: actor.now, expiresAt: new Date(deadline).toISOString() });
      await canonical.create(approvalRecordSchema.parse({ ...base, kind: "approval", id: approvalId, operationDigest: effect.operationDigest,
        scope: projectId, risk: "low", state: "pending", requestedBy: actorRef, requiredActorType: "owner", expiresAt: new Date(deadline).toISOString() }));
      await canonical.create(effect);
      const security = new SecurityStore(joined(tx));
      const authorize = async (action: string, resourceType: string, resourceId: string, id: string) => {
        const decision = await security.authorize({ decisionId: id, requiredRoleKey: "owner", requiredActorType: "human",
          authentication: { tenantId, provider: identity.provider, subject: identity.subject, verifiedAt: identity.issuedAt,
            expiresAt: new Date(deadline!).toISOString() },
          request: { tenantId, action, resourceType, resourceId, projectId, risk: "low", externalEffect: true, occurredAt: actor.now } });
        if (!decision.allowed || decision.identityId !== actor.id) throw new WebAccessError("access_denied");
        // Session locks keep these grants stable, but time can advance during enqueue.
        // Conservatively fence every contributing grant, not just the policy proof lifetime.
        const grants = await tx.query<{ id: string; expires_at: string | null; revoked_at: string | null }>(
          "SELECT id,expires_at,revoked_at FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2 AND id=ANY($3::text[]) FOR SHARE",
          [tenantId, actor.id, decision.matchedGrantIds]);
        if (!grants.rows.length || grants.rows.length !== new Set(decision.matchedGrantIds).size) throw new WebAccessError("access_denied");
        deadline = Math.min(deadline!, Date.parse(decision.expiresAt), ...grants.rows
          .flatMap(grant => [grant.expires_at, grant.revoked_at].filter((value): value is string => value !== null).map(Date.parse)));
        if (!Number.isFinite(deadline) || deadline <= this.clock()) throw new WebAccessError("access_denied");
        return decision.id;
      };
      await canonical.resolveApproval({ tenantId, approvalId, expectedVersion: 0, toState: "approved",
        policyDecisionId: await authorize("approval.decide", "approval", approvalId, `policy:feed-approve:${suffix}`),
        transitionId: `transition:feed-approve:${suffix}`, idempotencyKey: `feed-approve:${suffix}`, actor: actorRef, occurredAt: actor.now });
      await canonical.authorizeEffect({ tenantId, effectIntentId: effectId, expectedVersion: 0,
        policyDecisionId: await authorize("effect.authorize", "effect_intent", effectId, `policy:feed-effect:${suffix}`),
        transitionId: `transition:feed-effect:${suffix}`, idempotencyKey: `feed-effect:${suffix}`, actor: actorRef, occurredAt: actor.now });
      await this.enqueue(tx, reference);
      await appendAuditWith(tx, { id: `audit:feed-admit:${suffix}`, tenantId, workspaceId, actorId: actor.id, actorType: "human",
        action: "tasks.approve", targetType: "job", targetId: job.id, idempotencyKey: `feed-admit:${suffix}`, occurredAt: actor.now,
        safeMetadata: { inputDigest: input.inputDigest, effectId, operationDigest: effect.operationDigest } });
      actor.assertTimeCurrent();
      return { ...reference, replayed: false, effectState: "authorized" as const, networkContacted: false as const };
    });
  }
}
