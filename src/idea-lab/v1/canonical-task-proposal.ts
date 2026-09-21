import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import type { TaskReceipt } from "../../web/v1/task-wire";
import type { WebTaskService } from "../../web/v1/task-service";
import { buildIdeaLabCanonicalTaskPlanV1, type IdeaLabCanonicalTaskPlanV1 } from "./canonical-task-plan";
import type { IdeaLabCanonicalTaskLinkStoreV1 } from "./canonical-task-link-store";
import { buildIdeaLabOwnerPromptV1 } from "./discussion-prompt";
import { IdeaLabErrorV1 } from "./errors";
import { parseIdeaLabSessionV1 } from "./contracts";
import { ideaIdSchemaV1 } from "./schemas";

/**
 * Thin bridge from a planned Idea Lab round to the ordinary proposed-task
 * service. It deliberately has no runner, queue, provider, retry, or result
 * handling: those remain the existing shared Control Room lifecycle.
 *
 * The project is constructor-owned rather than supplied by a browser request.
 * Persistent session-to-project linking is the following migration package;
 * this bridge is safe to use only after its caller has already selected the
 * ordinary project that owns the discussion.
 */
export class IdeaLabCanonicalTaskProposalServiceV1 {
  constructor(private readonly tasks: Pick<WebTaskService, "propose">,
    private readonly scope: Readonly<{ projectId: string }>, private readonly links?: IdeaLabCanonicalTaskLinkStoreV1) {
    if (!ideaIdSchemaV1.safeParse(scope.projectId).success) throw new Error("idea_task_proposal_config_invalid");
  }

  async proposeRound(identity: VerifiedWebIdentity, input: {
    session: unknown;
    round: number;
    contributions: readonly unknown[];
  }): Promise<Readonly<{ plans: readonly IdeaLabCanonicalTaskPlanV1[]; receipts: readonly { receipt: TaskReceipt; replayed: boolean }[] }>> {
    const session = parseIdeaLabSessionV1(input.session);
    if (!Number.isInteger(input.round) || input.round < 1 || input.round > session.maxRounds) {
      throw new IdeaLabErrorV1("invalid_input");
    }
    const ownerPrompt = buildIdeaLabOwnerPromptV1(session);
    const plans = session.participants.map((participant) => buildIdeaLabCanonicalTaskPlanV1({ session,
      projectId: this.scope.projectId, participantId: participant.participantId, round: input.round,
      ownerPrompt, contributions: input.contributions,
    })).sort((left, right) => left.taskKey.localeCompare(right.taskKey));
    if (this.links) {
      await this.links.bindSession(plans[0]!);
      // Check every turn before proposing the first one. A changed later-round
      // snapshot must fail closed rather than create an unlinked task and only
      // then discover its provenance conflict.
      for (const plan of plans) await this.links.assertPlanAvailable(plan);
    }
    const receipts = [] as { receipt: TaskReceipt; replayed: boolean }[];
    for (const plan of plans) {
      // The key is a deterministic digest of the complete plan. The existing
      // task service binds it to the authenticated owner and rejects changed
      // replays, then writes the normal request/workflow/job bundle.
      const result = await this.tasks.propose(identity, this.scope.projectId, plan.taskDraft,
        `idea-round-proposal:${plan.planDigest.slice(7)}`);
      if (this.links) await this.links.record(plan, result.receipt);
      receipts.push(result);
    }
    return Object.freeze({ plans: Object.freeze(plans), receipts: Object.freeze(receipts) });
  }
}
