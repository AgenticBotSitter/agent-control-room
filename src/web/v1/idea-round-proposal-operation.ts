import { z } from "zod";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { IdeaLabCanonicalTaskLinkStoreV1 } from "../../idea-lab/v1/canonical-task-link-store";
import { IdeaLabCanonicalTaskProposalServiceV1 } from "../../idea-lab/v1/canonical-task-proposal";
import { IdeaLabProjectRegistryStoreV1 } from "../../idea-lab/v1/store";
import { IdeaLabErrorV1 } from "../../idea-lab/v1/errors";
import { ideaDigestSchemaV1, ideaIdSchemaV1 } from "../../idea-lab/v1/schemas";
import { catalogProjectIdSchema } from "./project-wire";
import { WebSessionAuthority } from "./session-authority";
import { WebAccessError, type VerifiedWebIdentity } from "./access-verifier";
import { WebTaskService } from "./task-service";

export const ideaRoundProposalInputSchema = z.object({
  sessionDigest: ideaDigestSchemaV1,
  projectId: catalogProjectIdSchema,
  // Later rounds require canonical result projection, so this initial endpoint
  // deliberately cannot skip ahead with a caller-supplied contribution list.
  round: z.literal(1),
}).strict();

const joined = (tx: DatabaseSession): DatabaseClient => ({ query: tx.query.bind(tx), transaction: async work => work(tx),
  transactionWithPreCommitCheck: async (work, check) => { const value = await work(tx); await check(); return value; } });

/**
 * Converts a saved Idea Lab discussion into ordinary proposed tasks. It owns
 * no driver, runner, queue, result, retry or completion state. The caller
 * chooses an ordinary project once; the append-only link store then binds that
 * project to the exact saved session and rejects later changes.
 */
export class WebIdeaRoundProposalOperation {
  private readonly authority: WebSessionAuthority;
  private readonly key: Uint8Array;
  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    key: Uint8Array, private readonly tasks: WebTaskService, clock: () => number = Date.now) {
    if (!(key instanceof Uint8Array) || key.length !== 32) throw new Error("idea_key_invalid");
    this.key = Uint8Array.from(key);
    this.authority = new WebSessionAuthority(db, scope, clock, "idea_lab_session");
  }

  async propose(identity: VerifiedWebIdentity, sessionId: string, value: unknown) {
    const input = ideaRoundProposalInputSchema.safeParse(value);
    if (!input.success || !ideaIdSchemaV1.safeParse(sessionId).success) throw new WebAccessError("invalid_request");
    // First lock and validate the saved discussion. Task proposal then performs
    // its own fresh authorization transaction for the selected ordinary project.
    const session = await this.authority.authenticated({ ...identity }, async (tx, actor) => {
      actor.require("idea_lab.session_read", undefined, true);
      // Reuse the existing owner control that previously guarded a panel start;
      // it now authorizes task preparation only, never provider contact.
      actor.require("idea_lab.panel_start", undefined, true);
      await tx.query("SELECT id FROM workspaces WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [this.scope.tenantId, this.scope.workspaceId]);
      const store = new IdeaLabProjectRegistryStoreV1(joined(tx), this.key);
      const saved = await store.getSession(this.scope.tenantId, sessionId);
      if (!saved || saved.workspaceId !== this.scope.workspaceId) throw new WebAccessError("not_found");
      if (saved.sessionDigest !== input.data.sessionDigest) throw new WebAccessError("conflict");
      // A retained legacy run or result is evidence only. It cannot be mixed
      // into this new canonical task lineage.
      if (await store.getSynthesis(this.scope.tenantId, sessionId) || await store.getDecision(this.scope.tenantId, sessionId)
        || (await store.listContributions(this.scope.tenantId, sessionId)).length) throw new WebAccessError("conflict");
      return saved;
    });
    const links = new IdeaLabCanonicalTaskLinkStoreV1(this.db, this.key);
    const service = new IdeaLabCanonicalTaskProposalServiceV1(this.tasks, { projectId: input.data.projectId }, links);
    let result;
    try { result = await service.proposeRound(identity, { session, round: input.data.round, contributions: [] }); }
    catch (error) {
      // The canonical planner's integrity/scope codes deliberately disclose no
      // discussion or project detail through the browser boundary.
      if (error instanceof IdeaLabErrorV1) throw new WebAccessError("conflict");
      throw error;
    }
    return { sessionId: session.sessionId, sessionDigest: session.sessionDigest, projectId: input.data.projectId,
      round: input.data.round, receipts: result.receipts, startsWork: false as const };
  }
}
