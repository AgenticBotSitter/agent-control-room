import { sha256Digest } from "./digest";

export type RiskClass = "low" | "medium" | "high" | "critical";

export interface AuthenticatedPrincipal {
  tenantId: string;
  identityId: string;
  actorType: "human" | "agent" | "service" | "node";
  authenticatedAt: string;
  expiresAt: string;
  strongFactor?: {
    evidenceId: string;
    method: "webauthn" | "passkey" | "recovery";
    verifiedAt: string;
    expiresAt: string;
  };
}

export interface RoleGrant {
  id: string;
  allowedActions: string[];
  projectIds: string[];
  riskCeiling: RiskClass;
  allowExternalEffects: boolean;
  requireStrongFactor: boolean;
  expiresAt?: string;
  revokedAt?: string;
}

export interface AuthorizationRequest {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  projectId?: string;
  risk: RiskClass;
  externalEffect: boolean;
  occurredAt: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reasonCodes: string[];
  matchedGrantIds: string[];
  requestDigest: string;
  strongFactorEvidenceId?: string;
}

const riskRank: Record<RiskClass, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function actionAllowed(actions: string[], requested: string): boolean {
  return actions.includes("*") || actions.includes(requested);
}

export function evaluatePolicy(principal: AuthenticatedPrincipal, grants: RoleGrant[], request: AuthorizationRequest): PolicyDecision {
  const reasons: string[] = [];
  const requestTime = Date.parse(request.occurredAt);
  const authenticatedTime = Date.parse(principal.authenticatedAt);
  const sessionExpiry = Date.parse(principal.expiresAt);
  if (![requestTime, authenticatedTime, sessionExpiry].every(Number.isFinite)) reasons.push("invalid_timestamp");
  if (principal.tenantId !== request.tenantId) reasons.push("tenant_mismatch");
  if (sessionExpiry <= requestTime) reasons.push("session_expired");
  if (authenticatedTime > requestTime) reasons.push("authentication_from_future");

  const eligible = reasons.length ? [] : grants.filter((grant) => {
    if (grant.revokedAt && (!Number.isFinite(Date.parse(grant.revokedAt)) || Date.parse(grant.revokedAt) <= requestTime)) return false;
    if (grant.expiresAt && (!Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= requestTime)) return false;
    if (!actionAllowed(grant.allowedActions, request.action)) return false;
    if (request.projectId && !grant.projectIds.includes("*") && !grant.projectIds.includes(request.projectId)) return false;
    if (riskRank[request.risk] > riskRank[grant.riskCeiling]) return false;
    if (request.externalEffect && !grant.allowExternalEffects) return false;
    return true;
  });
  if (!eligible.length && !reasons.length) reasons.push("no_matching_grant");

  const needsStrongFactor = request.externalEffect && (request.risk === "high" || request.risk === "critical")
    || eligible.some((grant) => grant.requireStrongFactor);
  const strongFactorValid = principal.strongFactor
    && Number.isFinite(Date.parse(principal.strongFactor.verifiedAt))
    && Number.isFinite(Date.parse(principal.strongFactor.expiresAt))
    && Date.parse(principal.strongFactor.verifiedAt) <= requestTime
    && Date.parse(principal.strongFactor.expiresAt) > requestTime;
  if (eligible.length && needsStrongFactor && !strongFactorValid) reasons.push("strong_factor_required");

  return {
    allowed: reasons.length === 0 && eligible.length > 0,
    reasonCodes: reasons.length ? reasons : ["allowed"],
    matchedGrantIds: eligible.map((grant) => grant.id).sort(),
    requestDigest: sha256Digest(request),
    strongFactorEvidenceId: strongFactorValid ? principal.strongFactor?.evidenceId : undefined,
  };
}
