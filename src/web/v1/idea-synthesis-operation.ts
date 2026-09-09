import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { appendAuditWith } from "../../audit/audit-store";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { IdeaLabBotRunStoreV1 } from "../../idea-lab/v1/coordinator-store";
import { DeterministicIdeaLabSynthesisEngineV1 } from "../../idea-lab/v1/synthesis-engine";
import { ideaDigestSchemaV1, ideaIdSchemaV1 } from "../../idea-lab/v1/schemas";
import { WebSessionAuthority } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";

export const ideaSynthesisInputSchema = z.object({ sessionDigest: ideaDigestSchemaV1, runId: ideaIdSchemaV1 }).strict();
const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });

/** Owner-requested extractive recap. No provider call or project decision. */
export class WebIdeaSynthesisOperation {
  private readonly authority: WebSessionAuthority;
  private readonly key: Uint8Array;
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string }, key: Uint8Array,
    clock: () => number = Date.now) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("idea_key_invalid");
    this.key = Uint8Array.from(key); this.authority = new WebSessionAuthority(db, scope, clock, "idea_lab_session");
  }
  async synthesize(identity: VerifiedWebIdentity, sessionId: string, value: unknown) {
    const input = ideaSynthesisInputSchema.safeParse(value);
    if (!input.success || !ideaIdSchemaV1.safeParse(sessionId).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated({ ...identity }, async (tx, actor) => {
      actor.require("idea_lab.session_read", undefined, true); actor.require("idea_lab.synthesize", undefined, true);
      await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, this.scope.workspaceId]);
      const db = joined(tx), store = new IdeaLabProjectRegistryStoreV1(db, this.key);
      const session = await store.getSession(this.scope.tenantId, sessionId);
      if (!session || session.workspaceId !== this.scope.workspaceId) throw new WebAccessError("not_found");
      if (session.sessionDigest !== input.data.sessionDigest) throw new WebAccessError("conflict");
      const run = await new IdeaLabBotRunStoreV1(db, this.key).getForSession(session);
      if (!run || run.runId !== input.data.runId || run.state !== "completed" || run.messagesUsed !== session.maxMessages)
        throw new WebAccessError("conflict");
      const contributions = await store.listContributions(this.scope.tenantId, sessionId);
      if (contributions.length !== session.maxMessages || run.attempts.length !== session.maxMessages
        || run.attempts.some(a => a.state !== "completed"
          || !session.participants.some(p => p.participantId === a.participantId && p.identityDigest === a.participantIdentityDigest)
          || !contributions.some(c => c.contributionDigest === a.contributionDigest
          && c.participantId === a.participantId && c.round === a.round))) throw new WebAccessError("conflict");
      let synthesis = await store.getSynthesis(this.scope.tenantId, sessionId); const replayed = !!synthesis;
      if (!synthesis) {
        if (await store.getDecision(this.scope.tenantId, sessionId)) throw new WebAccessError("conflict");
        synthesis = new DeterministicIdeaLabSynthesisEngineV1().build(session, contributions, actor.now);
        await store.recordSynthesis(synthesis);
        await appendAuditWith(tx, { id: `audit:idea-synthesis:${synthesis.synthesisDigest.slice(7)}`, ...this.scope,
          actorId: actor.id, actorType: "human", action: "idea_lab.synthesize", targetType: "idea_lab_session", targetId: sessionId,
          idempotencyKey: `idea-synthesis:${session.sessionDigest.slice(7)}`, occurredAt: actor.now,
          safeMetadata: { sessionDigest: session.sessionDigest, synthesisDigest: synthesis.synthesisDigest, state: "extractive_recap_saved" } });
      }
      return { sessionId, sessionDigest: session.sessionDigest, runId: run.runId, synthesisDigest: synthesis.synthesisDigest,
        replayed, startsWork: false as const };
    });
  }
}
