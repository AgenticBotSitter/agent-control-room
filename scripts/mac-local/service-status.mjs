// Read-only status for the optional login launch agent.
// Usage: pnpm mac:service-status -- --protected-root ABSOLUTE_PATH
import { protectedRootFromArguments, runtimePaths } from "./stack.mjs";
import { serviceStatus } from "./service.mjs";

const root = protectedRootFromArguments(process.argv.slice(2));
if (!root) {
  console.error("mac:service-status --protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required");
  process.exitCode = 2;
} else {
  try {
    const status = await serviceStatus({ protectedRoot: root, logPath: runtimePaths(root).hostLog, env: process.env });
    console.log(`mac:service-status ${status.state} definition=${status.definition} enabled=${status.enabled ?? "unknown"}${status.pid ? ` pid=${status.pid}` : ""}`);
  } catch (error) {
    console.error(`mac:service-status FAILED ${error instanceof Error ? error.message : "unknown"}`);
    process.exitCode = 1;
  }
}
