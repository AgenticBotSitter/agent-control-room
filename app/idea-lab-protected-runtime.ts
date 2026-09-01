import type { VerifiedAuthentication } from "@/src/security";
import type { IdeaLabOwnerDecisionServiceV1, IdeaLabProtectedOperatorServiceV1 } from "@/src/idea-lab/v1";
import { IDEA_LAB_BOT_RUNTIME_DISABLED_V1 } from "@/src/idea-lab/v1";

export interface IdeaLabProtectedRuntimeV1 {
  ownerSession: { verify(credential: unknown, now: string): Promise<VerifiedAuthentication> };
  ownerDecisionService: IdeaLabOwnerDecisionServiceV1;
  operatorService: IdeaLabProtectedOperatorServiceV1;
}

/** Production wiring remains absent until a protected owner-session adapter is explicitly selected. */
export function getIdeaLabProtectedRuntimeV1(): IdeaLabProtectedRuntimeV1 | undefined { return undefined; }
export const ideaLabProtectedRuntimeDispositionV1 = IDEA_LAB_BOT_RUNTIME_DISABLED_V1;
