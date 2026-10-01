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
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedDirectlyV1 } from "./dev/invoked-directly.mjs";
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
import { captureFleetConnectorReleaseManifestV1 } from "../src/fleet/v1/connector-release";
import { captureReleaseTrustV1, verifyConnectorReleaseAdvertisementV1, type ReleaseTrustV1 } from "./release-signing.mjs";

export const FLEET_GATEWAY_CONFIGURATION_V1 = "control-room.fleet-gateway/v1";
// requestTimeout limits receipt of a request body; it does not limit how long
// a body-less long-poll response may remain open.
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
  /** Public release trust is sent during one-time enrollment. The private key
   * is held by the root updater and never appears in this gateway process. */
  releaseTrust: ReleaseTrustV1;
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

export async function loadFleetConnectorReleaseV1(root = join(dirname(fileURLToPath(import.meta.url)), "fleet", "release"),
  trustValue?: ReleaseTrustV1) {
  const trust = captureReleaseTrustV1(trustValue);
  const manifestBody = await readFile(join(root, "manifest.json"), "utf8");
  let parsed: unknown;
  try { parsed = JSON.parse(manifestBody); } catch { throw new Error("fleet_connector_release_refused"); }
  const manifest = captureFleetConnectorReleaseManifestV1(parsed);
  const bundle = await readFile(join(root, manifest.file));
  const digest = createHash("sha256").update(bundle).digest("hex");
  if (bundle.length !== manifest.size || digest !== manifest.sha256) throw new Error("fleet_connector_release_refused");
  const embeddedKeyId = /^\/\/ Control Room embedded release key ID: (sha256:[a-f0-9]{64})$/mu
    .exec(bundle.subarray(0, Math.min(bundle.length, 16 * 1024)).toString("utf8"))?.[1];
  if (embeddedKeyId !== trust.keyId) throw new Error("fleet_connector_release_refused");
  let advertised: unknown;
  try { advertised = JSON.parse(await readFile(join(root, "connector-release.json"), "utf8")); }
  catch { throw new Error("fleet_connector_release_refused"); }
  let advertisement;
  try { advertisement = verifyConnectorReleaseAdvertisementV1(advertised, trust); }
  catch { throw new Error("fleet_connector_release_refused"); }
  if (advertisement.version !== manifest.version || advertisement.file !== manifest.file
    || advertisement.sha256 !== manifest.sha256 || advertisement.size !== manifest.size
    || advertisement.builtFrom !== manifest.builtFrom) throw new Error("fleet_connector_release_refused");
  return Object.freeze({ bundle, manifest, manifestBody, advertisement });
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
  let releaseTrust: ReleaseTrustV1;
  try { releaseTrust = captureReleaseTrustV1(input.releaseTrust); }
  catch { throw new Error("fleet_gateway_configuration_refused"); }
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
    releaseTrust,
    trustedClientHeader: trustedClientHeader as FleetGatewayTrustedClientHeaderV1,
    trustedProxyAddresses: Object.freeze([...(trustedProxyAddresses as string[])]) });
}

async function readProtectedConfigurationFileV1(path: string, maxBytes: number) {
  const refused = () => { throw new Error("fleet_gateway_configuration_refused"); };
  const before = await lstat(path).catch(refused);
  if (!before?.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maxBytes
    || process.platform !== "win32" && (before.mode & 0o037) !== 0) refused();
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)).catch(refused);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) refused();
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
      || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) refused();
    return bytes.toString("utf8");
  } finally { await handle.close(); }
}

/** The public release trust has its own root-written, group-readable file.
 * Keeping it out of gateway.json lets key rotation update trust without
 * rewriting the gateway's unrelated database and ingress configuration. */
export async function loadFleetGatewayConfigurationFileV1(path: string): Promise<FleetGatewayConfigurationV1> {
  let input: Record<string, unknown>;
  try { input = JSON.parse(await readProtectedConfigurationFileV1(path, 1024 * 1024)) as Record<string, unknown>; }
  catch { throw new Error("fleet_gateway_configuration_refused"); }
  const trustPath = join(dirname(path), "release-trust.json");
  let trust: ReleaseTrustV1;
  try { trust = captureReleaseTrustV1(JSON.parse(await readProtectedConfigurationFileV1(trustPath, 64 * 1024))); }
  catch { throw new Error("fleet_gateway_configuration_refused"); }
  if (input.releaseTrust !== undefined) throw new Error("fleet_gateway_configuration_refused");
  return captureFleetGatewayConfigurationV1({ ...input, releaseTrust: trust });
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
  const config = await loadFleetGatewayConfigurationFileV1(path);
  const fleetDatabase = createPrivatePostgresDatabase(config.database);
  const intakeDatabase = config.workIntake ? createPrivatePostgresDatabase(config.workIntake.database) : undefined;
  const projectEvents = config.harnessIntegrityKey ? new TaskProjectEventWriterV1(new ProjectEventStoreV1(
    fleetDatabase.client, deriveProjectEventIntegrityKeyV1(Buffer.from(config.harnessIntegrityKey, "base64url")),
    () => new Date().toISOString())) : undefined;
  const store = createFleetGatewayStoreFromConfigurationV1(fleetDatabase.client, config, projectEvents);
  // An unreadable mode refuses every claim; say why once so the owner is not left guessing.
  if (await store.operationsMode() === "unknown")
    process.stderr.write("fleet gateway: operations mode unreadable, so no new claims: check workIntake.integrityKey\n");
  const proposals = intakeDatabase && config.workIntake ? new WorkBatchServiceV1(new WorkBatchStoreV1(intakeDatabase.client,
    new Uint8Array(Buffer.from(config.workIntake.integrityKey, "base64url")))) : undefined;
  const connectorRelease = await loadFleetConnectorReleaseV1(undefined, config.releaseTrust);
  const handler = createFleetGatewayHandlerV1({ store, ...(proposals ? { proposals } : {}),
    admission: await prepareFleetGatewayAdmissionV1(config, store),
    releaseTrust: config.releaseTrust,
    connectorRelease,
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

if (invokedDirectlyV1(process.argv[1], import.meta.url)) {
  main(process.argv[2]).catch(error => { process.stderr.write(`${error instanceof Error ? error.message : "failed"}\n`); process.exitCode = 1; });
}
