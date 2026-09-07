import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { evaluatePolicy, type RoleGrant } from "../../security/policy";
import { sha256Digest } from "../../security/digest";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";

export type WebActor = { id: string; now: string;
  /** Time fences for this locked authorization snapshot, not a post-commit database revocation poll. */
  assertTimeCurrent: () => void;
  can: (action: string, projectId?: string, ownerOnly?: boolean, risk?: RoleGrant["riskCeiling"]) => boolean;
  require: (action: string, projectId?: string, ownerOnly?: boolean, risk?: RoleGrant["riskCeiling"]) => void };
const iso = (value: string | Date) => new Date(value).toISOString();

/** Shared, server-only session/grant transaction for the private application. Never bootstraps an identity. */
export class WebSessionAuthority {
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    private readonly clock: () => number = Date.now,
    private readonly resourceType = "project") {}

  async authenticated<T>(identity: VerifiedWebIdentity,
    operation: (tx: DatabaseSession, actor: WebActor) => Promise<T>): Promise<T> {
    identity = { ...identity };
    const nowMs = this.clock();
    const assertFresh = () => {
      const current = this.clock();
      if (!Number.isSafeInteger(current) || current < nowMs || Date.parse(identity.issuedAt) > current
        || !Number.isFinite(Date.parse(identity.expiresAt)) || Date.parse(identity.expiresAt) <= current
        || !Number.isFinite(Date.parse(identity.verificationExpiresAt)) || Date.parse(identity.verificationExpiresAt) <= current)
        throw new WebAccessError("authentication_required");
    };
    assertFresh();
    const now = new Date(nowMs).toISOString();
    const grantChecks: (() => void)[] = [];
    return this.db.transactionWithPreCommitCheck(async tx => {
      // Serialize each identity's requests and lock its current grants through the operation.
      // Revocation committed before this lock is observed; already-running transactions may finish first.
      const row = (await tx.query<{ id: string }>(`SELECT id FROM control_identities
        WHERE tenant_id=$1 AND auth_provider=$2 AND auth_subject_digest=$3 AND actor_type='human' AND state='active' FOR UPDATE`,
      [this.scope.tenantId, identity.provider, sha256Digest({ provider: identity.provider, subject: identity.subject })])).rows[0];
      if (!row) throw new WebAccessError("access_denied");
      await tx.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [this.scope.tenantId, identity.tokenDigest, row.id, identity.issuedAt, identity.expiresAt]);
      const session = (await tx.query<{ identity_id: string; revoked_at: string | null; expires_at: string; issued_at: string }>(
        `SELECT identity_id,revoked_at,expires_at,issued_at FROM control_web_sessions WHERE tenant_id=$1 AND token_digest=$2 FOR UPDATE`,
        [this.scope.tenantId, identity.tokenDigest])).rows[0];
      if (!session || session.identity_id !== row.id || session.revoked_at || Date.parse(session.expires_at) <= nowMs
        || iso(session.issued_at) !== identity.issuedAt) throw new WebAccessError("authentication_required");
      const grants = (await tx.query<{ id: string; role_key: string; allowed_actions: string[]; project_ids: string[];
        risk_ceiling: RoleGrant["riskCeiling"]; allow_external_effects: boolean; require_strong_factor: boolean;
        expires_at: string | null; revoked_at: string | null }>(
        `SELECT * FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2 FOR SHARE`, [this.scope.tenantId, row.id])).rows
        .filter(g => g.role_key === "owner" || g.role_key === "operator").map(g => ({ id: g.id,
          roleKey: g.role_key, allowedActions: g.allowed_actions, projectIds: g.project_ids, riskCeiling: g.risk_ceiling,
          allowExternalEffects: g.allow_external_effects, requireStrongFactor: g.require_strong_factor,
          ...(g.expires_at ? { expiresAt: iso(g.expires_at) } : {}), ...(g.revoked_at ? { revokedAt: iso(g.revoked_at) } : {}) }));
      const principal = { tenantId: this.scope.tenantId, identityId: row.id, actorType: "human" as const,
        authenticatedAt: identity.issuedAt, expiresAt: new Date(Math.min(Date.parse(session.expires_at), Date.parse(identity.expiresAt))).toISOString() };
      const can = (action: string, projectId?: string, ownerOnly = false, risk: RoleGrant["riskCeiling"] = "low") => {
        const selected = ownerOnly ? grants.filter(g => g.roleKey === "owner") : grants;
        const decision = evaluatePolicy(principal, selected, { tenantId: this.scope.tenantId, action,
          resourceType: this.resourceType, resourceId: projectId ?? this.scope.workspaceId, ...(projectId ? { projectId } : {}),
          risk, externalEffect: false, occurredAt: new Date(this.clock()).toISOString() });
        // Enumeration/create always require a matching wildcard project grant, never just a per-project grant.
        return decision.allowed && (!!projectId || selected.some(g => decision.matchedGrantIds.includes(g.id) && g.projectIds.includes("*")));
      };
      const require = (action: string, projectId?: string, ownerOnly = false, risk: RoleGrant["riskCeiling"] = "low") => {
        const check = () => { if (!can(action, projectId, ownerOnly, risk)) throw new WebAccessError("access_denied"); };
        check(); grantChecks.push(check);
      };
      return operation(tx, { id: row.id, now, can, require,
        assertTimeCurrent: () => { assertFresh(); for (const check of grantChecks) check(); } });
    }, () => { assertFresh(); for (const check of grantChecks) check(); });
  }

  async logout(identity: VerifiedWebIdentity): Promise<void> {
    const started = this.clock();
    const assertFresh = () => {
      const current = this.clock();
      if (!Number.isSafeInteger(current) || current < started || !Number.isFinite(Date.parse(identity.issuedAt))
        || Date.parse(identity.issuedAt) > current || !Number.isFinite(Date.parse(identity.expiresAt))
        || Date.parse(identity.expiresAt) <= current || !Number.isFinite(Date.parse(identity.verificationExpiresAt))
        || Date.parse(identity.verificationExpiresAt) <= current) throw new WebAccessError("authentication_required");
    };
    assertFresh();
    await this.db.transactionWithPreCommitCheck(async tx => {
      // Authentication binds the caller's own assertion. Revoking it never needs project authority,
      // and remains possible after the identity or its grants have been suspended/revoked.
      const actor = (await tx.query<{ id: string }>(`SELECT id FROM control_identities WHERE tenant_id=$1
        AND auth_provider=$2 AND auth_subject_digest=$3 AND actor_type='human' FOR UPDATE`,
      [this.scope.tenantId, identity.provider, sha256Digest({ provider: identity.provider, subject: identity.subject })])).rows[0];
      if (!actor) throw new WebAccessError("authentication_required");
      await tx.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [this.scope.tenantId, identity.tokenDigest, actor.id, identity.issuedAt, identity.expiresAt]);
      const revoked = await tx.query(`UPDATE control_web_sessions SET revoked_at=coalesce(revoked_at,$1)
        WHERE tenant_id=$2 AND token_digest=$3 AND identity_id=$4 AND issued_at=$5 RETURNING token_digest`,
      [new Date(started).toISOString(), this.scope.tenantId, identity.tokenDigest, actor.id, identity.issuedAt]);
      if (revoked.rows.length !== 1) throw new WebAccessError("authentication_required");
    }, assertFresh);
  }
}
