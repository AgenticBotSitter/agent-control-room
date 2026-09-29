/**
 * Owner-attended, read-only check for a future local Control Room service.
 * It reads one private configuration file, verifies the already-existing
 * release and protected paths, and returns only a redacted result.  It never
 * writes a plist, creates a directory, installs a LaunchAgent, or starts work.
 */
import { readFile } from "node:fs/promises";
import { preflightMacosLocalServiceV1 } from "../src/harness/v1/macos-local-service-preflight";

const args = process.argv.slice(2).filter(value => value !== "--");
const ownerAttended = args.filter(value => value === "--owner-attended").length === 1;
const definitionIndexes = args.reduce<number[]>((all, value, index) => value === "--service-definition" ? [...all, index] : all, []);
const definitionPath = definitionIndexes.length === 1 && definitionIndexes[0] !== args.length - 1
  ? args[definitionIndexes[0]! + 1] : undefined;
const known = new Set(["--owner-attended", "--service-definition", ...(definitionPath ? [definitionPath] : [])]);
const valid = ownerAttended && typeof definitionPath === "string" && definitionPath.length > 0
  && args.every(value => known.has(value));

async function configuration(path: string): Promise<unknown> {
  const contents = await readFile(path, "utf8");
  // This is a small service definition, not an arbitrary export or log.
  if (Buffer.byteLength(contents) > 32 * 1024) throw new Error("service_configuration_too_large");
  return JSON.parse(contents) as unknown;
}

if (!valid) {
  console.error("Usage: node --import tsx scripts/preflight-macos-local-service.ts --owner-attended --service-definition PRIVATE_SERVICE_DEFINITION_JSON");
  process.exitCode = 2;
} else {
  try {
    const result = await preflightMacosLocalServiceV1(await configuration(definitionPath));
    // Deliberately omit the generated plist, label and all owner paths.  This
    // report proves only that a later, separately authorized setup step may be
    // reviewed; it is never a running-service status.
    console.log(JSON.stringify({ schema: result.schema, ready: result.ready, startsWork: false }, null, 2));
  } catch {
    console.log(JSON.stringify({ ready: false, startsWork: false,
      failureReason: "macos_local_service_preflight_refused" }, null, 2));
    process.exitCode = 1;
  }
}
