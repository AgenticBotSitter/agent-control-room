import { isAbsolute, join, normalize, resolve } from "node:path";
import { z } from "zod";
import { captureFleetGatewayConfigurationV1, FLEET_GATEWAY_CONFIGURATION_V1,
  type FleetGatewayConfigurationV1 } from "../../../scripts/run-fleet-gateway";
import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from
  "../../web/v1/private-postgres";

export const MACOS_FLEET_GATEWAY_PORT_V1 = 8443 as const;

const safeAbsolutePath = (value: string) => isAbsolute(value) && normalize(value) === value
  && resolve(value) === value && value !== "/" && !value.endsWith("/")
  && !/[\u0000-\u001f\u007f]/u.test(value);
const key = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export type MacosFleetGatewayInstallInputV1 = Readonly<{
  tenantId: string;
  database: PrivatePostgresConfiguration;
  workIntakeDatabase: PrivatePostgresConfiguration;
  workIntakeIntegrityKey: string;
  harnessIntegrityKey: string;
  /**
   * The release's signing trust, REQUIRED.
   *
   * MEASURED, and this is a merge casualty worth recording. `captureFleetGatewayConfigurationV1`
   * began requiring `releaseTrust` (the connector-release signature key the gateway
   * verifies a worker's bundle against) on the `cook/v1` side, and this installer module
   * was written before that. The result after the merge was `fleet_gateway_configuration_refused`
   * from three updater tests, all of which pass on `cook/installer` alone - the installer
   * simply had never been run against the newer parser.
   *
   * It is an INPUT rather than something generated here, because the key is the RELEASE's
   * and not the installer's: a generated key would let the gateway accept connector
   * releases signed by whatever generated it. The installer receives it from the staged
   * release and passes it through; this module validates and forwards it and nothing more.
   */
  releaseTrust: unknown;
}>;

/** Builds the exact loopback Mac-local gateway configuration written by the installer. */
export function createMacosFleetGatewayConfigurationV1(installRoot: string,
  input: unknown): FleetGatewayConfigurationV1 {
  if (!safeAbsolutePath(installRoot)) throw new Error("fleet_gateway_install_configuration_refused");
  const parsed = z.object({
    tenantId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u),
    database: z.unknown(),
    workIntakeDatabase: z.unknown(),
    workIntakeIntegrityKey: key,
    harnessIntegrityKey: key,
    releaseTrust: z.unknown(),
  }).strict().parse(input);
  const database = validatePrivatePostgresConfiguration(parsed.database as PrivatePostgresConfiguration);
  const workIntakeDatabase = validatePrivatePostgresConfiguration(parsed.workIntakeDatabase as PrivatePostgresConfiguration);
  if (database.username !== "control_room_fleet" || workIntakeDatabase.username !== "control_room_work_intake_agent") {
    throw new Error("fleet_gateway_install_configuration_refused");
  }
  return captureFleetGatewayConfigurationV1({
    schema: FLEET_GATEWAY_CONFIGURATION_V1,
    tenantId: parsed.tenantId,
    port: MACOS_FLEET_GATEWAY_PORT_V1,
    database,
    workIntake: Object.freeze({ database: workIntakeDatabase,
      integrityKey: parsed.workIntakeIntegrityKey }),
    harnessIntegrityKey: parsed.harnessIntegrityKey,
    // The RELEASE's trust, forwarded unchanged: `captureFleetGatewayConfigurationV1`
    // validates it, so this module neither trusts nor rewrites it.
    releaseTrust: parsed.releaseTrust,
    // The daemon binds 127.0.0.1. Per-worker bearer credentials are loaded from PostgreSQL;
    // the Mac-local install never trusts a forwarded client-address header.
    trustedProxyAddresses: Object.freeze([]),
    trustedClientHeader: "none",
  });
}

export function macosFleetGatewayConfigurationFileV1(installRoot: string): string {
  return join(installRoot, "Protected", "config", "fleet-gateway.json");
}
