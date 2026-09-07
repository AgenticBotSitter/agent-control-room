import { getControlRoomLocalPilotPortsV1 } from "@/app/control-room-local-pilot-runtime";
import { createLocalPilotSessionHandlerV1 as issue,
  createLocalPilotSessionStatusHandlerV1 as status } from "@/src/local-pilot/v1/session-http";

export function createLocalPilotSessionHandlerV1(
  runtime = getControlRoomLocalPilotPortsV1()?.sessionIssuer,
) { return issue(runtime); }

export function createLocalPilotSessionStatusHandlerV1(
  runtime = getControlRoomLocalPilotPortsV1()?.sessionIssuer,
  clock: () => string = () => new Date().toISOString(),
) { return status(runtime, clock); }

export const POST = createLocalPilotSessionHandlerV1();
export const GET = createLocalPilotSessionStatusHandlerV1();
