import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { parseIdeaLabSynthesisV1, parseIdeaLabDecisionV1 } from "../../idea-lab/v1/contracts";
import { WebSessionAuthority } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { catalogProjectIdSchema } from "./project-wire";
import { IdeaLabBotRunStoreV1 } from "../../idea-lab/v1/coordinator-store";

const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const result = await work(tx); await check(); return result; } });

/** Private read composition for existing retained discussions, not an operator or provider adapter. */
export class WebIdeaService {
  private readonly authority: WebSessionAuthority;
  private readonly key?: Uint8Array;
  constructor(db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey?: Uint8Array, clock: () => number = Date.now, private readonly creationConfigured = false, private readonly stopConfigured = false,
    private readonly decisionConfigured = false, private readonly startConfigured = false, private readonly synthesisConfigured = false) {
    this.authority = new WebSessionAuthority(db, scope, clock, "idea_lab_session");
    if (integrityKey !== undefined) {
      if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("idea_key_invalid");
      this.key = Uint8Array.from(integrityKey);
    }
  }
  async list(identity: VerifiedWebIdentity, after?: string) {
    if (after !== undefined && !catalogProjectIdSchema.safeParse(after).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      actor.require("idea_lab.session_list", undefined, true);
      if (!this.key) return { availability: "not_configured" as const, sessions: [], nextCursor: null,
        execution: "not_configured" as const, canCreate: false, observedAt: actor.now };
      const page = await new IdeaLabProjectRegistryStoreV1(joined(tx), this.key).listSessionPage(this.scope.tenantId, this.scope.workspaceId, after);
      return { availability: "configured" as const, sessions: page.sessions.map(session => ({
        sessionId: session.sessionId, sessionDigest: session.sessionDigest, title: session.title, ideaSummary: session.ideaSummary,
        targetCustomer: session.targetCustomer, participantCount: session.participants.length, maxRounds: session.maxRounds,
        createdAt: session.createdAt,
      })), nextCursor: page.nextCursor, execution: this.startConfigured ? "authorization_required" as const : "not_configured" as const, observedAt: actor.now,
      canCreate: this.creationConfigured && actor.can("idea_lab.session_create", undefined, true) && actor.can("idea_lab.session_read", undefined, true) };
    });
  }
  async detail(identity: VerifiedWebIdentity, sessionId: string) {
    if (!catalogProjectIdSchema.safeParse(sessionId).success) throw new WebAccessError("invalid_request");
    return this.authority.authenticated(identity, async (tx, actor) => {
      // Session IDs are not project IDs. A workspace-wide owner read grant is required.
      actor.require("idea_lab.session_read", undefined, true);
      if (!this.key) throw new Error("idea_not_configured");
      const store = new IdeaLabProjectRegistryStoreV1(joined(tx), this.key);
      const session = await store.getSession(this.scope.tenantId, sessionId);
      if (!session || session.workspaceId !== this.scope.workspaceId) throw new WebAccessError("not_found");
      const run = await new IdeaLabBotRunStoreV1(joined(tx), this.key).getForSession(session);
      const contributions = await store.listContributions(this.scope.tenantId, sessionId);
      const synthesis = await store.getSynthesis(this.scope.tenantId, sessionId);
      const decision = await store.getDecision(this.scope.tenantId, sessionId);
      // READ COMMITTED may observe new records between queries. Validate this exact
      // returned tuple, not only each getter's independently reread dependencies.
      if (synthesis) parseIdeaLabSynthesisV1(synthesis, session, contributions);
      if (decision) {
        if (!synthesis) throw new Error("idea_snapshot_changed");
        parseIdeaLabDecisionV1(decision, session, synthesis);
      }
      if (run && (run.attempts.some(a => a.round > session.maxRounds
        || !session.participants.some(p => p.participantId === a.participantId && p.identityDigest === a.participantIdentityDigest)
        || a.state === "completed" && !contributions.some(c => c.contributionDigest === a.contributionDigest
          && c.participantId === a.participantId && c.round === a.round))
        || run.state === "completed" && run.messagesUsed !== session.maxMessages)) throw new Error("idea_snapshot_changed");
      const canDecide = this.decisionConfigured && !!synthesis && !decision && (!run || run.state === "completed")
        && actor.can("idea_lab.owner_decide", undefined, true);
      return { session, contributions, synthesis: synthesis ?? null, decision: decision ?? null, canDecide,
        canSynthesize: this.synthesisConfigured && !!run && run.state === "completed" && !synthesis && !decision
          && contributions.length === session.maxMessages && actor.can("idea_lab.synthesize", undefined, true),
        canStart: this.startConfigured && !run && !synthesis && !decision && !contributions.length
          && actor.can("idea_lab.panel_start", undefined, true),
        canPromote: canDecide && actor.can("projects.create", undefined, true),
        canStop: this.stopConfigured && !!run && ["prepared", "running"].includes(run.state) && !run.cancellationRequestedAt
          && actor.can("idea_lab.panel_cancel", undefined, true),
        run: run ? { runId: run.runId, sessionId: run.sessionId, sessionDigest: run.sessionDigest, state: run.state,
          messagesUsed: run.messagesUsed, maxMessages: session.maxMessages, costUsd: run.costUsd,
          providerContacted: run.providerContacted, updatedAt: run.updatedAt, retryPermitted: run.retryPermitted,
          cancellationRequestedAt: run.cancellationRequestedAt ?? null,
          attempts: run.attempts.map(a => ({ participantId: a.participantId, round: a.round, state: a.state })) } : null,
        execution: this.startConfigured ? "authorization_required" as const : "not_configured" as const, observedAt: actor.now };
    });
  }
}
