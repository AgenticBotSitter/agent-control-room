import { getControlRoomLocalPilotPortsV1 } from "@/app/control-room-local-pilot-runtime";
import type { ProjectEventReadSourceV1 } from "@/src/project-events/v1";
import type { ProjectWorkspaceOwnerReadScopeAuthorityV1 } from "@/src/project-workspace/v1";

export interface ProjectEventStreamRuntimeV1 {
  scopeAuthority: ProjectWorkspaceOwnerReadScopeAuthorityV1;
  eventSource: ProjectEventReadSourceV1;
}

/** No browser-supplied database, identity, tenant, or event-writer composition is accepted. */
export function getProjectEventStreamRuntimeV1():ProjectEventStreamRuntimeV1|undefined {
  return getControlRoomLocalPilotPortsV1()?.projectEvents;
}

