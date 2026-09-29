// Stops and removes the Mac-local launchd user agent. Data and protected configuration are untouched;
// afterwards mac:up starts the task host directly again until --install-service is used.
// Usage: pnpm mac:uninstall-service
import { uninstallService } from "./service.mjs";

try { console.log(`mac:uninstall-service ${await uninstallService()}`); }
catch (error) { console.error(`mac:uninstall-service FAILED ${error instanceof Error ? error.message : "unknown"}`); process.exit(1); }
