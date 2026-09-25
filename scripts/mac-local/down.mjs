// Stops the Mac-local task host. The database connection is direct and has no local tunnel process.
// Usage: pnpm mac:down -- --protected-root ABS_PATH   (or CONTROL_ROOM_PROTECTED_ROOT)
import { hostCommand, protectedRootFromArguments, runtimePaths, stopRecorded } from "./stack.mjs";

const root = protectedRootFromArguments(process.argv.slice(2));
if (!root) { console.error("mac:down --protected-root ABSOLUTE_PATH (or CONTROL_ROOM_PROTECTED_ROOT) is required"); process.exit(2); }
const paths = runtimePaths(root);
// The host drains its queue worker on SIGTERM; give it time before forcing.
const host = await stopRecorded(paths.hostPid, hostCommand(root), 45);
console.log(`mac:down task host ${host}`);
process.exit(host !== "still_running" ? 0 : 1);
