import { getControlRoomLocalPilotPortsV1 } from "@/app/control-room-local-pilot-runtime";
import { createLocalPilotProjectTaskHandlerV1 } from "@/src/local-pilot/v1/project-task-http";

// Resolve the explicitly configured development runtime per request, never during
// route import. Ordinary previews and production do not gain a local-pilot fallback.
export async function GET(request: Request) {
  return createLocalPilotProjectTaskHandlerV1(getControlRoomLocalPilotPortsV1()?.projectTasks)(request);
}
export async function POST(request: Request) {
  return createLocalPilotProjectTaskHandlerV1(getControlRoomLocalPilotPortsV1()?.projectTasks)(request);
}
