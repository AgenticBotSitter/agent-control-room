import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { sha256Digest } from "../../security";
import { buildIdeaLabDecisionV1 } from "../../idea-lab/v1/contracts";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { IdeaLabBotRunStoreV1 } from "../../idea-lab/v1/coordinator-store";
import { IdeaLabOwnerDecisionServiceV1, IdeaLabOwnerDecisionServiceErrorV1, ownerIntentSchema } from "../../idea-lab/v1/owner-decision-service";
import { ideaDigestSchemaV1, ideaIdSchemaV1 } from "../../idea-lab/v1/schemas";
import { WebSessionAuthority } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";

export const ideaDecisionInputSchema = z.object({ sessionDigest: ideaDigestSchemaV1,
  synthesisDigest: ideaDigestSchemaV1, intent: ownerIntentSchema }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });

/** Private-app bridge to the existing owner policy/permit/project service, not a
 * second promotion implementation. Not mounted until its SQL role is verified. */
export class WebIdeaDecisionOperation {
  private readonly authority: WebSessionAuthority;
  private readonly key: Uint8Array;
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    key: Uint8Array, clock: () => number = Date.now) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("idea_key_invalid");
    this.key = Uint8Array.from(key);
    this.authority = new WebSessionAuthority(db, scope, clock, "idea_lab_session");
  }
  async decide(identity: VerifiedWebIdentity, sessionId: string, value: unknown) {
    const input = ideaDecisionInputSchema.safeParse(value);
    if (!input.success || !ideaIdSchemaV1.safeParse(sessionId).success) throw new WebAccessError("invalid_request");
    const { intent } = input.data;
    if ((intent.decision === "create_project") !== !!intent.project) throw new WebAccessError("invalid_request");
    identity = { ...identity };
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.session_read", undefined, true);
      actor.require("idea_lab.owner_decide", undefined, true);
      if (intent.project) actor.require("projects.create", undefined, true);
      const locked = await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE",
        [this.scope.tenantId, this.scope.workspaceId]);
      if (locked.rows.length !== 1) throw new WebAccessError("not_found");
      const db = joined(tx), store = new IdeaLabProjectRegistryStoreV1(db, this.key);
      const session = await store.getSession(this.scope.tenantId, sessionId);
      if (!session || session.workspaceId !== this.scope.workspaceId) throw new WebAccessError("not_found");
      const synthesis = await store.getSynthesis(this.scope.tenantId, sessionId);
      if (!synthesis) throw new WebAccessError("conflict");
      if (session.sessionDigest !== input.data.sessionDigest || synthesis.synthesisDigest !== input.data.synthesisDigest)
        throw new WebAccessError("conflict");
      const run = await new IdeaLabBotRunStoreV1(db, this.key).getForSession(session);
      if (run && (run.state !== "completed" || run.messagesUsed !== session.maxMessages)) throw new WebAccessError("conflict");
      const contributions = await store.listContributions(this.scope.tenantId, sessionId);
      const existing = await store.getDecision(this.scope.tenantId, sessionId);
      const ownerIdentityDigest = sha256Digest({ tenantId: this.scope.tenantId, identityId: actor.id, purpose: "idea_lab_owner_v1" });
      let expected;
      try { expected = buildIdeaLabDecisionV1(session, synthesis, contributions,
        { ...intent, ownerIdentityDigest, decidedAt: existing?.decidedAt ?? actor.now }); }
      catch { throw new WebAccessError("invalid_request"); }
      if (existing && existing.decisionDigest !== expected.decisionDigest) throw new WebAccessError("conflict");
      if (!existing) {
        // All nested policy, permit, project, lifecycle and audit writes join this
        // revocable web-session transaction. Any failure rolls back the whole command.
        const result = await new IdeaLabOwnerDecisionServiceV1(db, this.key).apply({ sessionId, intent,
          authentication: { tenantId: this.scope.tenantId, provider: identity.provider, subject: identity.subject,
            verifiedAt: identity.issuedAt, expiresAt: new Date(Math.min(Date.parse(identity.expiresAt),
              Date.parse(identity.verificationExpiresAt))).toISOString() }, now: actor.now }).catch(error => {
          if (error instanceof IdeaLabOwnerDecisionServiceErrorV1) {
            if (error.safeCode === "decision_conflict") throw new WebAccessError("conflict");
            if (error.safeCode === "invalid_owner_decision") throw new WebAccessError("invalid_request");
            if (error.safeCode === "owner_forbidden") throw new WebAccessError("access_denied");
            if (error.safeCode === "idea_not_found") throw new WebAccessError("not_found");
          }
          throw error;
        });
        if (result.decision.decisionDigest !== expected.decisionDigest) throw new WebAccessError("conflict");
        const suffix = expected.decisionDigest.slice(7);
        await appendAuditWith(tx, { id: `audit:idea-decision:${suffix}`, ...this.scope, actorId: actor.id, actorType: "human",
          action: "idea_lab.owner_decide", targetType: "idea_lab_session", targetId: sessionId,
          idempotencyKey: `idea-decision:${suffix}`, occurredAt: actor.now,
          safeMetadata: { sessionDigest: session.sessionDigest, decisionDigest: expected.decisionDigest, state: intent.decision } });
      }
      return { sessionId, sessionDigest: session.sessionDigest, synthesisDigest: synthesis.synthesisDigest,
        decisionDigest: expected.decisionDigest, decision: expected.decision, projectId: expected.project?.projectId ?? null,
        replayed: !!existing, startsWork: false as const };
    });
  }
}
