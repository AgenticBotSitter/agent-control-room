import type { VerifiedAuthentication } from "@/src/security";
import type { IdeaLabOwnerDecisionServiceV1, IdeaLabProtectedOperatorServiceV1,IdeaLabProjectLifecycleServiceV1 } from "@/src/idea-lab/v1";
import { IDEA_LAB_BOT_RUNTIME_DISABLED_V1 } from "@/src/idea-lab/v1";
import { getControlRoomLocalPilotPortsV1 } from "@/app/control-room-local-pilot-runtime";

export interface IdeaLabProtectedRuntimeV1 {
  ownerSession: { verify(credential: unknown, now: string): Promise<VerifiedAuthentication> };
  ownerDecisionService: Pick<IdeaLabOwnerDecisionServiceV1,"apply">;
  operatorService: Pick<IdeaLabProtectedOperatorServiceV1,"create"|"start"|"cancel"|"synthesize"|"list"|"get">;
  lifecycleService: Pick<IdeaLabProjectLifecycleServiceV1,"transition"|"get">;
}

/** Production wiring remains absent; only the exact loopback repository-fake pilot can opt in. */
export function getIdeaLabProtectedRuntimeV1(): IdeaLabProtectedRuntimeV1 | undefined { return getControlRoomLocalPilotPortsV1()?.ideaLab; }
export const ideaLabProtectedRuntimeDispositionV1 = IDEA_LAB_BOT_RUNTIME_DISABLED_V1;
