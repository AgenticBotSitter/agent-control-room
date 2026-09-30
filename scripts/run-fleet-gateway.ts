// Starts the control-side fleet gateway that remote worker connectors call.
//
//   pnpm fleet:gateway <protected-config.json>
//
// It listens on loopback only. Reach it from other machines through the
// private route you already use for the app (Tailscale Serve, or a Cloudflare
// Tunnel hostname without Cloudflare Access on the /fleet/ path, because the
// connector authenticates with its own machine credential). The config file
// holds the fleet gateway database login and must be readable only by you.
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseClient } from "../src/persistence/database";
import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration,
  type PrivatePostgresConfiguration } from "../src/web/v1/private-postgres";
import { createFleetGatewayAdmissionV1, createFleetGatewayHandlerV1, FleetGatewayStoreV1,
  type FleetGatewayStoreOptionsV1, type FleetGatewayTrustedClientHeaderV1 } from "../src/fleet/v1";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../src/work-intake/v1";
import { ProjectEventStoreV1 } from "../src/project-events/v1/store";
import { TaskProjectEventWriterV1 } from "../src/project-events/v1/task-lifecycle";
import { deriveProjectEventIntegrityKeyV1 } from "../src/project-events/v1/key";
import { readInstallationOperationsModeV1 } from "../src/web/v1/operations-mode-service";

export const FLEET_GATEWAY_CONFIGURATION_V1 = "control-room.fleet-gateway/v1";
export const FLEET_GATEWAY_SERVER_OPTIONS_V1 = Object.freeze({ requestTimeout: 15_000, headersTimeout: 5_000,
  connectionsCheckingInterval: 1_000, maxHeaderSize: 8192, highWaterMark: 8 * 1024 });
export type FleetGatewayConfigurationV1 = Readonly<{ schema: typeof FLEET_GATEWAY_CONFIGURATION_V1; tenantId: string; port: number;
  database: PrivatePostgresConfiguration;
  /** This installation key authenticates both work-intake records and the
   * operations-mode journal. Without it the gateway reports mode "unknown". */
  workIntake?: Readonly<{ database: PrivatePostgresConfiguration; integrityKey: string }>;
  /** The same installation-wide harness integrity key the private web process
   * holds. Without it, hand-off notes still record in the audit log and worker
   * events, but never reach the owner's task timeline. */
  harnessIntegrityKey?: string;
  trustedProxyAddresses: readonly string[]; trustedClientHeader: FleetGatewayTrustedClientHeaderV1 }>;

export function fleetGatewayAdmissionFromConfigurationV1(config:
  Pick<FleetGatewayConfigurationV1, "trustedProxyAddresses" | "trustedClientHeader">) {
  return createFleetGatewayAdmissionV1({ trustedClientHeader: config.trustedClientHeader,
    trustedProxyAddresses: config.trustedProxyAddresses });
}

export async function prepareFleetGatewayAdmissionV1(config:
  Pick<FleetGatewayConfigurationV1, "trustedProxyAddresses" | "trustedClientHeader">, store: FleetGatewayStoreV1) {
  const admission = fleetGatewayAdmissionFromConfigurationV1(config);
  for (const credential of await store.activeAdmissionCredentials())
    admission.registerCredential(credential.workerId, credential.credentialDigest);
  return admission;
}

export function captureFleetGatewayConfigurationV1(value: unknown): FleetGatewayConfigurationV1 {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || input.schema !== FLEET_GATEWAY_CONFIGURATION_V1
    || typeof input.tenantId !== "string" || !Number.isSafeInteger(input.port) || (input.port as number) < 1024
    || (input.port as number) > 65535) throw new Error("fleet_gateway_configuration_refused");
  const database = validatePrivatePostgresConfiguration(input.database as PrivatePostgresConfiguration);
  if (database.username !== "control_room_fleet") throw new Error("fleet_gateway_configuration_refused");
  let workIntake: FleetGatewayConfigurationV1["workIntake"];
  if (input.workIntake !== undefined) {
    const intake = input.workIntake as Record<string, unknown>;
    const intakeDatabase = validatePrivatePostgresConfiguration(intake.database as PrivatePostgresConfiguration);
    if (intakeDatabase.username !== "control_room_work_intake_agent" || typeof intake.integrityKey !== "string"
      || !/^[A-Za-z0-9_-]{43}$/u.test(intake.integrityKey)) throw new Error("fleet_gateway_configuration_refused");
    workIntake = { database: intakeDatabase, integrityKey: intake.integrityKey };
  }
  let harnessIntegrityKey: string | undefined;
  if (input.harnessIntegrityKey !== undefined) {
    if (typeof input.harnessIntegrityKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(input.harnessIntegrityKey))
      throw new Error("fleet_gateway_configuration_refused");
    harnessIntegrityKey = input.harnessIntegrityKey;
  }
  const trustedClientHeader = input.trustedClientHeader ?? "none";
  const trustedProxyAddresses = input.trustedProxyAddresses ?? [];
  if (!(["cf-connecting-ip", "x-forwarded-for-rightmost", "none"] as const).includes(trustedClientHeader as never)
    || !Array.isArray(trustedProxyAddresses) || trustedProxyAddresses.some(address => typeof address !== "string"))
    throw new Error("fleet_gateway_configuration_refused");
  // Reuse the runtime policy validator so configuration and request handling
  // cannot disagree about malformed or missing proxy addresses.
  try {
    fleetGatewayAdmissionFromConfigurationV1({ trustedClientHeader: trustedClientHeader as FleetGatewayTrustedClientHeaderV1,
      trustedProxyAddresses: trustedProxyAddresses as string[] });
  } catch { throw new Error("fleet_gateway_configuration_refused"); }
  return Object.freeze({ schema: FLEET_GATEWAY_CONFIGURATION_V1, tenantId: input.tenantId, port: input.port as number,
    database, ...(workIntake ? { workIntake } : {}), ...(harnessIntegrityKey ? { harnessIntegrityKey } : {}),
    trustedClientHeader: trustedClientHeader as FleetGatewayTrustedClientHeaderV1,
    trustedProxyAddresses: Object.freeze([...(trustedProxyAddresses as string[])]) });
}

/** Composes the standalone gateway with the same authenticated operations-mode
 * journal reader as the Mac host. A configuration without the installation
 * key still gets a provider, but that provider fails closed as "unknown". */
export function createFleetGatewayStoreFromConfigurationV1(database: DatabaseClient,
  config: Pick<FleetGatewayConfigurationV1, "tenantId" | "workIntake">,
  projectEvents?: FleetGatewayStoreOptionsV1["projectEvents"]) {
  const integrityKey = config.workIntake
    ? new Uint8Array(Buffer.from(config.workIntake.integrityKey, "base64url")) : undefined;
  const operationsMode = async () => {
    if (!integrityKey) throw new Error("operations_mode_unavailable");
    return (await readInstallationOperationsModeV1(database, config.tenantId, integrityKey)).mode;
  };
  return new FleetGatewayStoreV1(database, { tenantId: config.tenantId, operationsMode,
    ...(projectEvents ? { projectEvents } : {}) });
}

async function main(path: string | undefined) {
  if (!path) throw new Error("Usage: pnpm fleet:gateway <protected-config.json>");
  const info = await stat(path);
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) throw new Error("The gateway config must be readable only by its owner.");
  const config = captureFleetGatewayConfigurationV1(JSON.parse(await readFile(path, "utf8")));
  const fleetDatabase = createPrivatePostgresDatabase(config.database);
  const intakeDatabase = config.workIntake ? createPrivatePostgresDatabase(config.workIntake.database) : undefined;
  const projectEvents = config.harnessIntegrityKey ? new TaskProjectEventWriterV1(new ProjectEventStoreV1(
    fleetDatabase.client, deriveProjectEventIntegrityKeyV1(Buffer.from(config.harnessIntegrityKey, "base64url")),
    () => new Date().toISOString())) : undefined;
  const store = createFleetGatewayStoreFromConfigurationV1(fleetDatabase.client, config, projectEvents);
  const proposals = intakeDatabase && config.workIntake ? new WorkBatchServiceV1(new WorkBatchStoreV1(intakeDatabase.client,
    new Uint8Array(Buffer.from(config.workIntake.integrityKey, "base64url")))) : undefined;
  const script = await readFile(join(dirname(fileURLToPath(import.meta.url)), "fleet", "connector.mjs"), "utf8");
  const handler = createFleetGatewayHandlerV1({ store, ...(proposals ? { proposals } : {}),
    admission: await prepareFleetGatewayAdmissionV1(config, store),
    connectorScript: { body: script, digest: `sha256:${createHash("sha256").update(script).digest("hex")}` },
    onUnexpectedError: error => { process.stderr.write(`fleet gateway: ${error instanceof Error ? error.name : "error"} ${(error as { code?: string }).code ?? ""}\n`); } });
  const server = createServer(FLEET_GATEWAY_SERVER_OPTIONS_V1,
    (request, response) => { void handler.handle(request, response); });
  server.listen(config.port, "127.0.0.1");
  // Owner decisions and elapsed leases are applied on a steady timer as well
  // as right after each owner action.
  const timer = setInterval(() => { void store.reconcile().catch(() => {}); }, 30_000);
  const stop = () => { clearInterval(timer); server.close(); void fleetDatabase.close(); void intakeDatabase?.close(); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
  process.stderr.write(`Fleet gateway listening on 127.0.0.1:${config.port}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv[2]).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; });
}
