import { z } from "zod";
import type { DatabaseClient } from "../../persistence/database";
import { SecurityStore, sha256Digest, type VerifiedAuthentication } from "../../security";
import { buildIdeaLabDecisionV1 } from "./contracts";
import { IdeaLabErrorV1 } from "./errors";
import { parseExactIdeaLabV1 } from "./exact";
import { capturedIdeaTimeMillisecondsV1, ideaCodeSchemaV1, ideaIdSchemaV1,
  projectCreationSpecSchemaV1 } from "./schemas";
import { IdeaLabProjectRegistryStoreV1 } from "./store";
import type { IdeaLabDecisionV1, ProjectRegistryProjectionV1 } from "./types";

const ownerIntentSchema = z.object({
  decision: z.enum(["create_project", "save", "reject"]), safeReasonCode: ideaCodeSchemaV1,
  project: projectCreationSpecSchemaV1.optional(),
}).strict();

export class IdeaLabOwnerDecisionServiceErrorV1 extends Error {
  constructor(readonly safeCode: "invalid_owner_decision" | "authentication_required" | "owner_forbidden" |
    "idea_not_found" | "decision_conflict" | "owner_boundary_unavailable") { super(safeCode); }
}

export interface IdeaLabOwnerDecisionResultV1 {
  decision: IdeaLabDecisionV1; project?: ProjectRegistryProjectionV1; replayed: boolean;
  authorization: { policyDecisionId: string; permitDigest: string; expiresAt: string };
}

/** Authenticated owner-only service. Browser input never supplies tenant, workspace, or owner identity. */
export class IdeaLabOwnerDecisionServiceV1 {
  readonly #security: SecurityStore; readonly #registry: IdeaLabProjectRegistryStoreV1;
  constructor(db: DatabaseClient, integrityKey: Uint8Array) {
    this.#security = new SecurityStore(db); this.#registry = new IdeaLabProjectRegistryStoreV1(db, integrityKey);
  }
  async apply(input: { sessionId: unknown; intent: unknown; authentication: VerifiedAuthentication; now: string }): Promise<IdeaLabOwnerDecisionResultV1> {
    let sessionId: string, intent: z.infer<typeof ownerIntentSchema>;
    try { sessionId = ideaIdSchemaV1.parse(input.sessionId); intent = parseExactIdeaLabV1(ownerIntentSchema, input.intent); }
    catch { throw new IdeaLabOwnerDecisionServiceErrorV1("invalid_owner_decision"); }
    if ((intent.decision === "create_project") !== !!intent.project
      || capturedIdeaTimeMillisecondsV1(input.now) === undefined) {
      throw new IdeaLabOwnerDecisionServiceErrorV1("invalid_owner_decision");
    }
    let session, synthesis, contributions;
    try {
      session = await this.#registry.getSession(input.authentication.tenantId, sessionId);
      if (!session) throw new IdeaLabErrorV1("not_found");
      synthesis = await this.#registry.getSynthesis(session.tenantId, session.sessionId);
      contributions = await this.#registry.listContributions(session.tenantId, session.sessionId);
      if (!synthesis) throw new IdeaLabErrorV1("not_found");
    } catch { throw new IdeaLabOwnerDecisionServiceErrorV1("idea_not_found"); }
    const idSuffix = session.sessionDigest.slice(7, 31), policySuffix = sha256Digest({ sessionDigest: session.sessionDigest,
      authenticationProvider: input.authentication.provider, authenticationSubject: input.authentication.subject }).slice(7,31),
      policyDecisionId = `policy.idea:${policySuffix}`;
    let policy;
    try {
      policy = await this.#security.authorize({ decisionId: policyDecisionId, authentication: input.authentication,
        requiredRoleKey: "owner", requiredActorType: "human", request: { tenantId: session.tenantId,
          action: "idea_lab.owner_decide", resourceType: "idea_lab_session", resourceId: session.sessionId,
          risk: "low", externalEffect: false, occurredAt: input.now } });
    } catch { throw new IdeaLabOwnerDecisionServiceErrorV1("owner_boundary_unavailable"); }
    if (!policy.allowed) throw new IdeaLabOwnerDecisionServiceErrorV1("owner_forbidden");
    const ownerIdentityDigest = sha256Digest({ tenantId: session.tenantId, identityId: policy.identityId, purpose: "idea_lab_owner_v1" });
    let decision: IdeaLabDecisionV1;
    try { decision = buildIdeaLabDecisionV1(session, synthesis, contributions, { ...intent, ownerIdentityDigest, decidedAt: input.now }); }
    catch { throw new IdeaLabOwnerDecisionServiceErrorV1("invalid_owner_decision"); }
    try {
      const permit = await this.#registry.authorizeOwnerDecision({ authorizationId: `authorization.idea:${idSuffix}`,
        policyDecisionId, decision });
      const recorded = await this.#registry.recordAuthorizedDecision(decision, permit.authorizationDigest);
      return { ...recorded, authorization: { policyDecisionId, permitDigest: permit.authorizationDigest, expiresAt: policy.expiresAt } };
    } catch (error) {
      if (error instanceof IdeaLabErrorV1 && ["duplicate_record", "project_conflict", "state_conflict"].includes(error.safeCode)) {
        throw new IdeaLabOwnerDecisionServiceErrorV1("decision_conflict");
      }
      if (error instanceof IdeaLabErrorV1 && error.safeCode === "authorization_denied") {
        throw new IdeaLabOwnerDecisionServiceErrorV1("owner_forbidden");
      }
      throw new IdeaLabOwnerDecisionServiceErrorV1("owner_boundary_unavailable");
    }
  }
}
