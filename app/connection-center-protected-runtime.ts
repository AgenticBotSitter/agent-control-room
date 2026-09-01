import { getControlRoomLocalPilotPortsV1 } from "@/app/control-room-local-pilot-runtime";
import type { ConnectionCenterRosterSourceV1 } from "@/src/connection-center/v1";
import type { VerifiedAuthentication } from "@/src/security";

export interface ConnectionCenterProtectedRuntimeV1 {
  ownerSession: { verify(credential: unknown, now: string): Promise<VerifiedAuthentication> };
  rosterSource: ConnectionCenterRosterSourceV1;
}

/** Production wiring remains absent; the loopback repository-fake pilot can expose only its protected empty roster. */
export function getConnectionCenterProtectedRuntimeV1(): ConnectionCenterProtectedRuntimeV1 | undefined {
  return getControlRoomLocalPilotPortsV1()?.connectionCenter;
}
