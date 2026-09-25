// Stops the Mac-local task host, then the tunnel mac:up started. Repeat-safe.
// Usage: pnpm mac:down -- --protected-root ABS_PATH   (or CONTROL_ROOM_PROTECTED_ROOT)
import { hostCommand, protectedRootFromArguments, readPid, readTunnel, runtimePaths, stopRecorded, tunnelCommand } from "./stack.mjs";

const root = protectedRootFromArguments(process.argv.slice(2));
if (!root) { console.error("mac:down --protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required"); process.exit(2); }
const paths = runtimePaths(root);
// The host drains its queue worker on SIGTERM; give it time before forcing.
const host = await stopRecorded(paths.hostPid, hostCommand(root), 45);
console.log(`mac:down task host ${host}`);
let tunnel = "not_running";
try {
  const settings = await readTunnel(root);
  if (settings) tunnel = await stopRecorded(paths.tunnelPid, tunnelCommand(settings), 5);
  else if (await readPid(paths.tunnelPid)) tunnel = "unverifiable (tunnel.json removed; pid left alone)";
} catch {
  // Without valid settings the recorded pid cannot be verified, so it is never signalled.
  tunnel = (await readPid(paths.tunnelPid)) ? "unverifiable (tunnel.json invalid; pid left alone)" : "not_running";
}
console.log(`mac:down tunnel ${tunnel}`);
process.exit(host !== "still_running" && (tunnel === "stopped" || tunnel === "not_running") ? 0 : 1);
