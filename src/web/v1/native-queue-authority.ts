import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { nativeTaskSubmissionReferenceSchema, type NativeTaskSubmissionReference } from "../../persistence/native-task-submission";
import { evaluatePolicy, type RoleGrant } from "../../security/policy";
import { sha256Digest } from "../../security";
import type { NativeTaskQueueIntent, NativeTaskQueueScope } from "./native-task-queue";
import type { WebActor } from "./session-authority";
import { WebAccessError } from "./access-verifier";

const iso = (value: string | Date) => new Date(value).toISOString();
const deny = (): never => { throw new WebAccessError("access_denied"); };

/** Internal server delivery authorization, not browser authentication. An HMAC-verified
 * queue intent identifies the approving actor; it does not replace current grants or
 * the caller's signed-packet/canonical revalidation. No sessions or credentials created. */
export class NativeQueueAuthority {
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly store: { readQueueIntentInSession(tx: DatabaseSession, scope: NativeTaskQueueScope): Promise<NativeTaskQueueIntent | null> },
    private readonly clock: () => number) { this.scope = Object.freeze({ ...scope }); }
  async authenticated<T>(input: NativeTaskSubmissionReference,
    operation: (tx: DatabaseSession, actor: WebActor) => Promise<T>): Promise<T> {
    const ref = nativeTaskSubmissionReferenceSchema.parse(input);
    if (ref.tenantId !== this.scope.tenantId) deny();
    let assertFresh: (() => void) | undefined;
    return this.db.transactionWithPreCommitCheck(async tx => {
      const intent = await this.store.readQueueIntentInSession(tx, ref);
      if (!intent || intent.packetDigest !== ref.packetDigest || ref.queueId !== `native-queue:${sha256Digest({
        tenantId: intent.tenantId, jobId: intent.jobId, attemptId: intent.attemptId }).slice(7)}`) return deny();
      const started = this.clock(), checks: (() => void)[] = [];
      assertFresh = () => {
        const now = this.clock();
        if (!Number.isSafeInteger(started) || !Number.isSafeInteger(now) || now < started || now < Date.parse(intent.queuedAt) || now >= intent.deadline) deny();
        for (const check of checks) check();
      };
      assertFresh();
      const actor = (await tx.query<{ id: string }>(`SELECT id FROM control_identities
        WHERE tenant_id=$1 AND id=$2 AND actor_type='human' AND state='active' FOR UPDATE`, [ref.tenantId, intent.queuedBy])).rows[0];
      if (!actor) deny();
      const rows = (await tx.query<{ id: string; role_key: string; allowed_actions: string[]; project_ids: string[];
        risk_ceiling: RoleGrant["riskCeiling"]; allow_external_effects: boolean; require_strong_factor: boolean;
        expires_at: string | Date | null; revoked_at: string | Date | null }>(
        "SELECT * FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2 FOR SHARE", [ref.tenantId, actor.id])).rows;
      const grants = rows.filter(row => row.role_key === "owner").map(row => ({ id: row.id, roleKey: row.role_key,
        allowedActions: row.allowed_actions, projectIds: row.project_ids, riskCeiling: row.risk_ceiling,
        allowExternalEffects: row.allow_external_effects, requireStrongFactor: row.require_strong_factor,
        ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}), ...(row.revoked_at ? { revokedAt: iso(row.revoked_at) } : {}) }));
      const principal = { tenantId: ref.tenantId, identityId: actor.id, actorType: "human" as const,
        authenticatedAt: intent.queuedAt, expiresAt: new Date(intent.deadline).toISOString() };
      const can: WebActor["can"] = (action, projectId, _ownerOnly, risk = "low") => projectId === ref.projectId
        && evaluatePolicy(principal, grants, { tenantId: ref.tenantId, action, resourceType: "task", resourceId: projectId,
          projectId, risk, externalEffect: false, occurredAt: new Date(this.clock()).toISOString() }).allowed;
      const requirePermission: WebActor["require"] = (action, projectId, ownerOnly, risk) => {
        const check = () => { if (!can(action, projectId, ownerOnly, risk)) deny(); }; check(); checks.push(check);
      };
      requirePermission("tasks.read", ref.projectId, true); requirePermission("tasks.approve", ref.projectId, true);
      return operation(tx, { id: actor.id, now: new Date(started).toISOString(), can, require: requirePermission, assertTimeCurrent: assertFresh });
    }, () => { if (!assertFresh) return deny(); assertFresh(); });
  }
}
