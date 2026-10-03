import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
// Separate Mac-local fleet gateway process. Service definitions should launch
// this entry point; the website process only owns the fleet-owner routes.
import { fileURLToPath } from "node:url";
import { parseMacLocalWebHostArguments } from "./start-web-host.mjs";
import { MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1 } from "./stack.mjs";

export async function startMacLocalFleetGateway(input, runtime = {}) {
  if (!input || typeof input.protectedRoot !== "string") throw new Error("mac_local_fleet_gateway_arguments_invalid");
  const releaseRoot = new URL("../../dist-vps/server/", import.meta.url);
  const load = runtime.load ?? (path => import(path));
  const [loader, postgres, fleet] = await Promise.all([
    load(new URL("macLocalProtectedLoader.js", releaseRoot).href),
    load(new URL("privatePostgres.js", releaseRoot).href),
    load(new URL("macLocalFleet.js", releaseRoot).href),
  ]);
  if (typeof loader.loadMacLocalProtectedConfigurationFromRootV1 !== "function"
    || typeof loader.loadMacLocalDatabaseRolesFromRootV1 !== "function"
    || typeof loader.loadWorkIntakeServerConfigurationFromRootV1 !== "function"
    || typeof postgres.createPrivatePostgresDatabase !== "function"
    || typeof fleet.prepareMacLocalFleetGatewayV1 !== "function"
    || typeof fleet.loadMacLocalFleetReleaseTrustV1 !== "function"
    || typeof fleet.loadMacLocalFleetConnectorReleaseV1 !== "function")
    throw new Error("mac_local_fleet_gateway_release_invalid");
  const releaseTrust = await fleet.loadMacLocalFleetReleaseTrustV1(input.protectedRoot);
  const [configuration, databaseRoles, workIntake, connectorRelease] = await Promise.all([
    loader.loadMacLocalProtectedConfigurationFromRootV1(input.protectedRoot),
    loader.loadMacLocalDatabaseRolesFromRootV1(input.protectedRoot),
    loader.loadWorkIntakeServerConfigurationFromRootV1(input.protectedRoot),
    fleet.loadMacLocalFleetConnectorReleaseV1(fileURLToPath(new URL("../fleet/release", import.meta.url)), releaseTrust),
  ]);
  if (!connectorRelease) throw new Error(MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1);
  const service = await fleet.prepareMacLocalFleetGatewayV1({ configuration, databaseRoles,
    ...(workIntake ? { workIntake } : {}), connectorRelease, releaseTrust,
    openDatabase: postgres.createPrivatePostgresDatabase });
  try { await service.start(); return service; }
  catch (error) { await service.close(); throw error; }
}

async function main() {
  const parsed = parseMacLocalWebHostArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log("Usage: node scripts/mac-local/start-fleet-gateway.mjs --owner-attended --protected-root ABSOLUTE_PATH");
    return;
  }
  const active = await startMacLocalFleetGateway(parsed);
  console.log(`Control Room fleet gateway is running on ${active.origin}. Press Control-C to stop.`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await active.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

if (isMainModuleV1(process.argv[1], import.meta.url))
  void main().catch(error => { console.error(`mac-local-fleet-gateway: ${error.message}`); process.exitCode = 1; });
