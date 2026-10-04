// Stops the Mac-local task host. The database connection is direct and has no local tunnel process.
// With the launchd user agent installed, the agent is stopped and disabled so it does not return at the
// next login; the next mac:up re-enables it. Data and the agent's plist are left in place.
// Usage: pnpm mac:down -- --protected-root ABS_PATH   (or CONTROL_ROOM_PROTECTED_ROOT)
import { fleetGatewayCommand, protectedRootFromArguments, runtimePaths, stopRecorded, stopRecordedHost } from "./stack.mjs";
import { serviceInstalled, stopService } from "./service.mjs";

const root = protectedRootFromArguments(process.argv.slice(2));
if (!root) { console.error("mac:down --protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required"); process.exit(2); }
const paths = runtimePaths(root);
let service = "not_installed";
try { if (await serviceInstalled()) service = await stopService(); }
catch (error) { service = `failed (${error instanceof Error ? error.message : "unknown"})`; }
console.log(`mac:down service ${service}`);
// A PID record that cannot be proved (unsafe custody, odd content) is kept and reported, and the
// next stop is still attempted: one refused record must not leave the other process running.
const stop = async work => { try { return await work(); } catch (error) {
  return `failed (${error instanceof Error ? error.message : "unknown"}; PID file kept)`; } };
const gateway = await stop(() => stopRecorded(paths.fleetGatewayPid, fleetGatewayCommand(root), 10));
console.log(`mac:down fleet gateway ${gateway}`);
// A host that an earlier mac:up started directly. The host drains its queue worker on SIGTERM; give it time.
const host = await stop(() => stopRecordedHost(paths.hostPid, root, 45));
console.log(`mac:down task host ${host}`);
process.exit([host, gateway, service].every(state => state !== "still_running" && !state.startsWith("failed")) ? 0 : 1);
