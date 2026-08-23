import type { DatabaseClient } from "../persistence/database";
import { sha256Digest } from "./digest";
import {
  evaluatePolicy,
  type AuthenticatedPrincipal,
  type AuthorizationRequest,
  type PolicyDecision,
  type RoleGrant,
} from "./policy";

function json(value: unknown): string {
  return JSON.stringify(value);
}

export interface VerifiedAuthentication {
  tenantId: string;
  provider: string;
  subject: string;
  verifiedAt: string;
  expiresAt: string;
  strongFactor?: AuthenticatedPrincipal["strongFactor"];
}

/** Provider adapters verify raw credentials; policy code receives only this normalized proof. */
export interface IdentityVerifier<TCredential> {
  verify(credential: TCredential, now: string): Promise<VerifiedAuthentication>;
}

export interface BootstrapOwnerInput extends VerifiedAuthentication {
  identityId: string;
  grantId: string;
  displayName: string;
}

export interface RecordedDecision extends PolicyDecision {
  id: string;
  identityId: string;
  expiresAt: string;
}

function subjectDigest(provider: string, subject: string): string {
  return sha256Digest({ provider, subject });
}

export class SecurityStore {
  constructor(private readonly db: DatabaseClient) {}

  /** Deployment-only bootstrap primitive. It is intentionally not exposed by an HTTP route. */
  async bootstrapOwner(input: BootstrapOwnerInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(`SELECT id FROM tenants WHERE id=$1 FOR UPDATE`, [input.tenantId]);
      const existing = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM control_identities WHERE tenant_id=$1`,
        [input.tenantId],
      );
      if (existing.rows[0]?.count !== "0") throw new Error("Owner bootstrap is already consumed for this tenant");
      await tx.query(
        `INSERT INTO control_identities
          (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
         VALUES ($1,$2,'human',$3,$4,$5,'active',$6,$6)`,
        [input.identityId, input.tenantId, input.displayName, input.provider, subjectDigest(input.provider, input.subject), input.verifiedAt],
      );
      await tx.query(
        `INSERT INTO control_role_grants
          (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
         VALUES ($1,$2,$3,'owner',$4::jsonb,$5::jsonb,'critical',true,false,$6,$6)`,
        [input.grantId, input.tenantId, input.identityId, json(["*"]), json(["*"]), input.verifiedAt],
      );
    });
  }

  async authorize(input: {
    decisionId: string;
    authentication: VerifiedAuthentication;
    request: AuthorizationRequest;
  }): Promise<RecordedDecision> {
    const { authentication, request } = input;
    if (authentication.tenantId !== request.tenantId) throw new Error("Authentication tenant does not match authorization request");
    if (Date.parse(authentication.verifiedAt) > Date.parse(request.occurredAt)) throw new Error("Authentication is from the future");

    return this.db.transaction(async (tx) => {
      const identity = await tx.query<{ id: string; actor_type: AuthenticatedPrincipal["actorType"]; state: string }>(
        `SELECT id,actor_type,state FROM control_identities
         WHERE tenant_id=$1 AND auth_provider=$2 AND auth_subject_digest=$3 FOR UPDATE`,
        [authentication.tenantId, authentication.provider, subjectDigest(authentication.provider, authentication.subject)],
      );
      const actor = identity.rows[0];
      if (!actor || actor.state !== "active") throw new Error("Authentication does not resolve to an active identity");

      const rows = await tx.query<{
        id: string; allowed_actions: string[]; project_ids: string[]; risk_ceiling: RoleGrant["riskCeiling"];
        allow_external_effects: boolean; require_strong_factor: boolean; expires_at?: string; revoked_at?: string;
      }>(
        `SELECT id,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,expires_at,revoked_at
         FROM control_role_grants WHERE tenant_id=$1 AND identity_id=$2`,
        [authentication.tenantId, actor.id],
      );
      const grants: RoleGrant[] = rows.rows.map((row) => ({
        id: row.id,
        allowedActions: row.allowed_actions,
        projectIds: row.project_ids,
        riskCeiling: row.risk_ceiling,
        allowExternalEffects: row.allow_external_effects,
        requireStrongFactor: row.require_strong_factor,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      }));
      const principal: AuthenticatedPrincipal = {
        tenantId: authentication.tenantId,
        identityId: actor.id,
        actorType: actor.actor_type,
        authenticatedAt: authentication.verifiedAt,
        expiresAt: authentication.expiresAt,
        strongFactor: authentication.strongFactor,
      };
      const decision = evaluatePolicy(principal, grants, request);
      const fiveMinutes = Date.parse(request.occurredAt) + 5 * 60_000;
      const expiryCandidates = [Date.parse(authentication.expiresAt), fiveMinutes];
      if (decision.strongFactorEvidenceId && authentication.strongFactor) expiryCandidates.push(Date.parse(authentication.strongFactor.expiresAt));
      const expiresAt = new Date(Math.min(...expiryCandidates)).toISOString();
      if (Date.parse(expiresAt) <= Date.parse(request.occurredAt)) throw new Error("Authorization proof has no valid lifetime");

      await tx.query(
        `INSERT INTO control_policy_decisions
          (id,tenant_id,identity_id,action,resource_type,resource_id,project_id,risk,external_effect,allowed,
           reason_codes,grant_ids,strong_factor_evidence_id,request_digest,decided_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)`,
        [input.decisionId, request.tenantId, actor.id, request.action, request.resourceType, request.resourceId,
          request.projectId ?? null, request.risk, request.externalEffect, decision.allowed, json(decision.reasonCodes),
          json(decision.matchedGrantIds), decision.strongFactorEvidenceId ?? null, decision.requestDigest, request.occurredAt, expiresAt],
      );
      return { ...decision, id: input.decisionId, identityId: actor.id, expiresAt };
    });
  }
}
