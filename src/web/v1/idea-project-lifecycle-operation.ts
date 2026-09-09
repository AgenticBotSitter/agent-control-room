import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { sha256Digest } from "../../security";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { IdeaLabProjectLifecycleServiceV1, IdeaLabProjectLifecycleServiceErrorV1 } from "../../idea-lab/v1/lifecycle-service";
import { CONTROL_ROOM_IDEA_ADAPTER_V1, ideaIdSchemaV1 } from "../../idea-lab/v1/schemas";
import { WebSessionAuthority } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { ideaProjectTransitionSchema, ideaLifecycleProjectSchema } from "./project-wire";
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });

/** Reuses the signed registry and owner lifecycle policy in one revocable web
 * transaction. The command ledger retains exact receipts after later transitions.
 * Composition must verify the lifecycle SQL grants before mounting this operation. */
export class WebIdeaProjectLifecycleOperation {
  private readonly authority: WebSessionAuthority;
  private readonly key: Uint8Array;
  private readonly scope: { tenantId: string; workspaceId: string };
  constructor(db: DatabaseClient, scope: { tenantId: string; workspaceId: string },
    key: Uint8Array, clock: () => number = Date.now) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("idea_key_invalid");
    this.key = Uint8Array.from(key);
    this.scope = { ...scope };
    this.authority = new WebSessionAuthority(db, this.scope, clock);
  }

  async transition(identity: VerifiedWebIdentity, projectId: string, value: unknown, key: string) {
    const parsed = ideaProjectTransitionSchema.safeParse(value);
    if (!parsed.success || !ideaIdSchemaV1.safeParse(projectId).success
      || !/^[A-Za-z0-9_-]{16,100}$/.test(key)) throw new WebAccessError("invalid_request");
    const input = parsed.data, action = `idea_lab.project_${input.action}`;
    const digest = sha256Digest({ ...this.scope, action, projectId, value: input });
    identity = { ...identity };
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.project_read", projectId, true);
      actor.require(action, projectId, true);
      const row = await tx.query(`SELECT id FROM projects WHERE tenant_id=$1 AND workspace_id=$2
        AND id=$3 AND adapter_id=$4 FOR UPDATE`,
      [this.scope.tenantId, this.scope.workspaceId, projectId, CONTROL_ROOM_IDEA_ADAPTER_V1]);
      if (row.rows.length !== 1) throw new WebAccessError("not_found");
      const db = joined(tx), store = new IdeaLabProjectRegistryStoreV1(db, this.key);
      if (!await store.getProjectInSession(tx, this.scope.tenantId, this.scope.workspaceId, projectId))
        throw new WebAccessError("not_found");
      const existing = (await tx.query<{ request_digest: string; result: unknown }>(
        `SELECT request_digest,result FROM control_web_project_commands
        WHERE tenant_id=$1 AND identity_id=$2 AND idempotency_key=$3`, [this.scope.tenantId, actor.id, key])).rows[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new WebAccessError("conflict");
        const project = ideaLifecycleProjectSchema.parse(existing.result);
        if (project.projectId !== projectId) throw new Error("idea_lifecycle_receipt_invalid");
        return { project, replayed: true };
      }
      const commandId = `web.idea.lifecycle:${sha256Digest({ ...this.scope, identityId: actor.id, key }).slice(7)}`;
      const result = await new IdeaLabProjectLifecycleServiceV1(db, this.key, () => actor.now).transition({
        commandId, projectId, ...input, requestedAt: actor.now }, {
        tenantId: this.scope.tenantId, provider: identity.provider, subject: identity.subject,
        verifiedAt: identity.issuedAt, expiresAt: new Date(Math.min(Date.parse(identity.expiresAt),
          Date.parse(identity.verificationExpiresAt))).toISOString(),
      }).catch(error => {
        if (error instanceof IdeaLabProjectLifecycleServiceErrorV1) {
          if (error.safeCode === "state_conflict") throw new WebAccessError("conflict");
          if (error.safeCode === "invalid_lifecycle_request") throw new WebAccessError("invalid_request");
          if (error.safeCode === "owner_forbidden") throw new WebAccessError("access_denied");
          if (error.safeCode === "project_not_found") throw new WebAccessError("not_found");
        }
        throw error;
      });
      const project = ideaLifecycleProjectSchema.parse({ projectId: result.projectId, title: result.title,
        summary: result.summary, lifecycle: result.lifecycleState, version: result.version,
        createdAt: result.createdAt, updatedAt: result.updatedAt });
      await appendAuditWith(tx, { id: `audit:${commandId}`, ...this.scope, projectId,
        actorId: actor.id, actorType: "human", action, targetType: "project", targetId: projectId,
        idempotencyKey: key, occurredAt: actor.now, safeMetadata: { lifecycle: project.lifecycle, version: project.version } });
      await tx.query(`INSERT INTO control_web_project_commands(tenant_id,identity_id,idempotency_key,request_digest,result,occurred_at)
        VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [this.scope.tenantId, actor.id, key, digest, JSON.stringify(project), actor.now]);
      return { project, replayed: false };
    });
  }
}
