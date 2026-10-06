import { fileURLToPath } from "node:url";
import { isMainModuleV1 } from "../../installer/shared/is-main-module.mjs";
import { createPrivatePostgresDatabase } from "../../web/v1/private-postgres";
import { captureFleetGatewayConfigurationV1, mainFleetGatewayV1, readProtectedConfigurationFileV1 } from
  "../../../scripts/run-fleet-gateway";
import { loadMacLocalFleetConnectorReleaseV1, prepareInstalledMacLocalFleetGatewayV1 } from "./mac-local-composition";

const production = { readProtectedConfigurationFileV1, loadMacLocalFleetConnectorReleaseV1,
  prepareInstalledMacLocalFleetGatewayV1, createPrivatePostgresDatabase };

export async function runInstalledFleetGatewayV1(path: string | undefined,
  runtime: typeof production = production): Promise<void> {
  if (!path) throw new Error("fleet_gateway_usage_refused");
  let configuration;
  try {
    configuration = captureFleetGatewayConfigurationV1(JSON.parse(
      await runtime.readProtectedConfigurationFileV1(path, 1024 * 1024)));
  } catch { throw new Error("fleet_gateway_configuration_refused"); }
  let healthProbeKey: Uint8Array | undefined;
  if (configuration.healthProbeKeyFile !== undefined) {
    try {
      const encoded = (await runtime.readProtectedConfigurationFileV1(configuration.healthProbeKeyFile, 64)).trim();
      if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error();
      healthProbeKey = new Uint8Array(Buffer.from(encoded, "base64url"));
    } catch { throw new Error("fleet_gateway_configuration_refused"); }
  }
  const connectorRelease = await runtime.loadMacLocalFleetConnectorReleaseV1(
    fileURLToPath(new URL("./fleet/release/", import.meta.url)), configuration.releaseTrust);
  const service = await runtime.prepareInstalledMacLocalFleetGatewayV1({ configuration, connectorRelease,
    openDatabase: runtime.createPrivatePostgresDatabase, ...(healthProbeKey ? { healthProbeKey } : {}) });
  try { await service.start(); }
  catch (error) { await service.close(); throw error; }
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

/** Release entry for the launchd contract in updater/v1/services/bundle.mjs. */
export async function mainFleetGatewayEntryV1(args: readonly string[],
  run: (path: string | undefined) => Promise<void> = runInstalledFleetGatewayV1): Promise<number> {
  return mainFleetGatewayV1(args, run);
}

// The emitted runtime URL must match the actual process entry, including symlinks.
if (isMainModuleV1(process.argv[1], import.meta.url)) {
  void mainFleetGatewayEntryV1(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => {
    process.stderr.write("fleet gateway failed: fleet_gateway_execution_failed\n");
    process.exitCode = 1;
  });
}
