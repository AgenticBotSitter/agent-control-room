import type { Stats } from "node:fs";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { createServer as createNodeServer, type Server, type ServerOptions } from "node:http";
import { isAbsolute, join, resolve } from "node:path";
import type { DatabaseClient } from "../../persistence/database";
import { ProjectEventStoreV1 } from "../../project-events/v1/store";
import { deriveProjectEventIntegrityKeyV1 } from "../../project-events/v1/key";
import { TaskProjectEventWriterV1 } from "../../project-events/v1/task-lifecycle";
import type { MacLocalDatabaseRolesV1 } from "../../web/v1/mac-local-database-roles";
import type { MacLocalProtectedConfigurationV1 } from "../../web/v1/mac-local-protected-configuration";
import { readInstallationOperationsModeV1 } from "../../web/v1/operations-mode-service";
import type { PrivatePostgresConfiguration } from "../../web/v1/private-postgres";
import type { WorkIntakeServerConfigurationV1 } from "../../work-intake/v1/installed-configuration";
import { WorkBatchServiceV1, WorkBatchStoreV1 } from "../../work-intake/v1";
import { captureFleetConnectorReleaseManifestV1, type FleetConnectorReleaseManifestV1 } from "./connector-release";
import { createFleetGatewayHandlerV1, type FleetGatewayHttpOptionsV1 } from "./gateway-http";
import { FleetGatewayStoreV1 } from "./gateway-store";
import { createFleetGatewayAdmissionV1 } from "./gateway-http";
import { captureReleaseTrustV1, verifyConnectorReleaseAdvertisementV1,
  type ReleaseTrustV1 } from "../../../scripts/release-signing.mjs";

export const MAC_LOCAL_FLEET_GATEWAY_PORT_V1 = 3212;
export const MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1 = `http://127.0.0.1:${MAC_LOCAL_FLEET_GATEWAY_PORT_V1}`;
export const MAC_LOCAL_FLEET_GATEWAY_SERVER_OPTIONS_V1 = Object.freeze({ requestTimeout: 15_000,
  headersTimeout: 5_000, connectionsCheckingInterval: 1_000, maxHeaderSize: 8192, highWaterMark: 8 * 1024 });

type OpenedDatabase = Readonly<{ client: DatabaseClient; close(): Promise<void> }>;
type ConnectorRelease = NonNullable<FleetGatewayHttpOptionsV1["connectorRelease"]>;
type GatewayWorkIntake = Pick<WorkIntakeServerConfigurationV1, "database" | "integrityKey">;
type FleetOwnerBinding = Readonly<{ ownerAuthority: DatabaseClient; gatewayOrigin?: string;
  connectorRelease?: FleetConnectorReleaseManifestV1; afterDecision?: () => Promise<unknown> }>;

function fleetRoles(roles: MacLocalDatabaseRolesV1) {
  if (!roles.fleetGateway || !roles.fleetOwner) throw new Error("mac_local_fleet_roles_missing");
  return Object.freeze({ gateway: roles.fleetGateway, owner: roles.fleetOwner });
}

/** Reads the connector release the gateway serves. A missing release is an
 * allowed web-only state (codes still work); malformed bytes always refuse. */
export async function loadMacLocalFleetReleaseTrustV1(protectedRoot: string, runtime = {
  lstat, realpath, open, getuid: () => process.getuid?.() ?? -1,
  getgid: () => process.getgid?.() ?? -1, getgroups: () => process.getgroups?.() ?? [],
}): Promise<ReleaseTrustV1> {
  const refused = (): never => { throw new Error("mac_local_fleet_release_trust_refused"); };
  if (!isAbsolute(protectedRoot) || resolve(protectedRoot) !== protectedRoot) refused();
  try {
    const supplied = await runtime.lstat(protectedRoot);
    if (!supplied.isDirectory() || supplied.isSymbolicLink()) refused();
    const metadata = (entry: Stats) => {
      if (process.platform === "win32") return;
      const uid = runtime.getuid();
      if ((entry.mode & 0o027) !== 0 || entry.uid !== supplied.uid || entry.uid !== 0 && entry.uid !== uid
        || entry.gid !== supplied.gid || (entry.mode & 0o050) !== 0 && (entry.uid !== 0
          || uid !== 0 && entry.gid !== runtime.getgid() && !runtime.getgroups().includes(entry.gid))) refused();
    };
    const canonicalRoot = await runtime.realpath(protectedRoot);
    const configRoot = join(canonicalRoot, "config"), path = join(configRoot, "release-trust.json");
    for (const directory of [canonicalRoot, configRoot]) {
      const entry = await runtime.lstat(directory);
      metadata(entry);
      if (!entry.isDirectory() || entry.isSymbolicLink()
        || process.platform !== "win32" && (entry.mode & 0o027) !== 0) refused();
    }
    const before = await runtime.lstat(path);
    metadata(before);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > 64 * 1024
      || process.platform !== "win32" && (before.mode & 0o027) !== 0) refused();
    const handle = await runtime.open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) refused();
      const bytes = await handle.readFile();
      const after = await handle.stat();
      if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) refused();
      return captureReleaseTrustV1(JSON.parse(bytes.toString("utf8")));
    } finally { await handle.close(); }
  } catch { return refused(); }
}

export async function loadMacLocalFleetConnectorReleaseV1(root: string,
  trustValue: ReleaseTrustV1): Promise<ConnectorRelease | undefined> {
  let trust: ReleaseTrustV1;
  try { trust = captureReleaseTrustV1(trustValue); }
  catch { throw new Error("fleet_connector_release_refused"); }
  let manifestBody: string;
  try { manifestBody = await readFile(join(root, "manifest.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("fleet_connector_release_refused");
  }
  let manifest: FleetConnectorReleaseManifestV1;
  try { manifest = captureFleetConnectorReleaseManifestV1(JSON.parse(manifestBody)); }
  catch { throw new Error("fleet_connector_release_refused"); }
  // A built-but-unsigned connector (the bundle `mac:up` can build on its own, before an
  // owner ever runs the attended `release:sign` step) is the same "no release to
  // distribute yet" state as no manifest at all, not a malformed one: a standalone
  // single-machine install with no fleet distribution set up must still start.
  let advertisementBody: string;
  try { advertisementBody = await readFile(join(root, "connector-release.json"), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("fleet_connector_release_refused");
  }
  try {
    const bundle = await readFile(join(root, manifest.file));
    if (bundle.length !== manifest.size || createHash("sha256").update(bundle).digest("hex") !== manifest.sha256)
      throw new Error();
    const embeddedKeyId = /^\/\/ Control Room embedded release key ID: (sha256:[a-f0-9]{64})$/mu
      .exec(bundle.subarray(0, Math.min(bundle.length, 16 * 1024)).toString("utf8"))?.[1];
    if (embeddedKeyId !== trust.keyId) throw new Error();
    const advertisement = verifyConnectorReleaseAdvertisementV1(JSON.parse(advertisementBody), trust);
    if (advertisement.version !== manifest.version || advertisement.file !== manifest.file
      || advertisement.sha256 !== manifest.sha256 || advertisement.size !== manifest.size
      || advertisement.builtFrom !== manifest.builtFrom) throw new Error();
    return Object.freeze({ bundle, manifest, manifestBody, advertisement });
  } catch { throw new Error("fleet_connector_release_refused"); }
}

/** The web process owns only the fleet-owner login. The gateway login and
 * listener belong to the separate service below. */
export function prepareMacLocalFleetOwnerV1(input: Readonly<{
  configuration: MacLocalProtectedConfigurationV1;
  databaseRoles: MacLocalDatabaseRolesV1;
  openDatabase(configuration: PrivatePostgresConfiguration): OpenedDatabase;
  connectorRelease?: ConnectorRelease;
  gatewayOrigin?: string;
}>): Readonly<{ fleet: FleetOwnerBinding; close(): Promise<void> }> {
  const roles = fleetRoles(input.databaseRoles);
  const gatewayOrigin = input.gatewayOrigin ?? MAC_LOCAL_FLEET_GATEWAY_ORIGIN_V1;
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(gatewayOrigin)) throw new Error("mac_local_fleet_owner_invalid");
  const database = input.openDatabase(roles.owner);
  if (!database?.client || typeof database.close !== "function") throw new Error("mac_local_fleet_owner_invalid");
  return Object.freeze({
    fleet: Object.freeze({ ownerAuthority: database.client,
      ...(input.connectorRelease ? { gatewayOrigin, connectorRelease: input.connectorRelease.manifest } : {}) }),
    close: database.close.bind(database),
  });
}

/** Complete loopback gateway composition for the Mac service manager. It is
 * inert until start(), binds only 127.0.0.1, and owns every database it opens. */
async function prepareMacLocalFleetGatewayCoreV1(input: Readonly<{
  tenantId: string;
  gatewayDatabase: PrivatePostgresConfiguration;
  workIntake?: GatewayWorkIntake;
  harnessIntegrityKey?: Uint8Array;
  healthProbeKey?: Uint8Array;
  connectorRelease?: ConnectorRelease;
  releaseTrust: ReleaseTrustV1;
  openDatabase(configuration: PrivatePostgresConfiguration): OpenedDatabase;
  createServer?: (options: Readonly<ServerOptions>, listener: Parameters<typeof createNodeServer>[1]) => Server;
  port?: number;
  reconcileIntervalMs?: number;
}>): Promise<Readonly<{ store: FleetGatewayStoreV1; origin: string; start(): Promise<void>; close(): Promise<void> }>> {
  const port = input.port ?? MAC_LOCAL_FLEET_GATEWAY_PORT_V1;
  if (input.healthProbeKey && input.healthProbeKey.length !== 32) throw new Error("mac_local_fleet_gateway_invalid");
  let releaseTrust: ReleaseTrustV1;
  try { releaseTrust = captureReleaseTrustV1(input.releaseTrust); }
  catch { throw new Error("mac_local_fleet_gateway_invalid"); }
  if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error("mac_local_fleet_gateway_invalid");
  if (input.harnessIntegrityKey && input.harnessIntegrityKey.length !== 32)
    throw new Error("mac_local_fleet_gateway_invalid");
  const gatewayDatabase = input.openDatabase(input.gatewayDatabase);
  const intakeDatabase = input.workIntake ? input.openDatabase(input.workIntake.database) : undefined;
  let server: Server | undefined, timer: NodeJS.Timeout | undefined, started = false, closed: Promise<void> | undefined;
  try {
    const integrityKey = input.workIntake
      ? new Uint8Array(Buffer.from(input.workIntake.integrityKey, "base64url")) : undefined;
    const projectEvents = input.harnessIntegrityKey ? new TaskProjectEventWriterV1(new ProjectEventStoreV1(
      gatewayDatabase.client, deriveProjectEventIntegrityKeyV1(input.harnessIntegrityKey), () => new Date().toISOString())) : undefined;
    const store = new FleetGatewayStoreV1(gatewayDatabase.client, {
      tenantId: input.tenantId,
      operationsMode: async () => integrityKey
        ? (await readInstallationOperationsModeV1(gatewayDatabase.client,
          input.tenantId, integrityKey)).mode
        : Promise.reject(new Error("operations_mode_unavailable")),
      ...(projectEvents ? { projectEvents } : {}),
    });
    const admission = createFleetGatewayAdmissionV1();
    for (const credential of await store.activeAdmissionCredentials())
      admission.registerCredential(credential.workerId, credential.credentialDigest);
    const proposals = intakeDatabase && input.workIntake ? new WorkBatchServiceV1(new WorkBatchStoreV1(
      intakeDatabase.client, new Uint8Array(Buffer.from(input.workIntake.integrityKey, "base64url")))) : undefined;
    const handler = createFleetGatewayHandlerV1({ store, admission, releaseTrust,
      ...(proposals ? { proposals } : {}), ...(input.connectorRelease ? { connectorRelease: input.connectorRelease } : {}),
      ...(input.healthProbeKey ? { healthProbeKey: input.healthProbeKey } : {}) });
    const makeServer = input.createServer ?? ((options, listener) => createNodeServer(options, listener));
    server = makeServer(MAC_LOCAL_FLEET_GATEWAY_SERVER_OPTIONS_V1,
      (request, response) => { void handler.handle(request, response); });
    const origin = `http://127.0.0.1:${port}`;
    const close = () => closed ??= (async () => {
      if (timer) clearInterval(timer);
      const listener = server && started ? await new Promise<PromiseSettledResult<void>>(resolve => {
        const timeout = setTimeout(() => resolve({ status: "rejected", reason: new Error("close_timeout") }), 10_000);
        server!.close(error => { clearTimeout(timeout); resolve(error
          ? { status: "rejected", reason: error } : { status: "fulfilled", value: undefined }); });
      }) : { status: "fulfilled", value: undefined } as PromiseFulfilledResult<void>;
      const databases = await Promise.allSettled([gatewayDatabase.close(), intakeDatabase?.close()]);
      if (listener.status === "rejected" || databases.some(result => result.status === "rejected"))
        throw new Error("mac_local_fleet_gateway_cleanup_uncertain");
    })();
    return Object.freeze({ store, origin,
      async start() {
        if (started) throw new Error("mac_local_fleet_gateway_already_started");
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error("mac_local_fleet_gateway_bind_timeout")), 10_000);
          const failed = (error: Error) => { clearTimeout(timeout); reject(error); };
          server!.once("error", failed);
          server!.listen(port, "127.0.0.1", () => { clearTimeout(timeout); server!.off("error", failed); started = true; resolve(); });
        });
        timer = setInterval(() => { void store.reconcile().catch(() => {}); }, input.reconcileIntervalMs ?? 30_000);
        timer.unref?.();
      }, close });
  } catch (error) {
    await Promise.allSettled([gatewayDatabase.close(), intakeDatabase?.close()]);
    throw error;
  }
}

export async function prepareMacLocalFleetGatewayV1(input: Readonly<{
  configuration: MacLocalProtectedConfigurationV1;
  databaseRoles: MacLocalDatabaseRolesV1;
  workIntake?: WorkIntakeServerConfigurationV1;
  harnessIntegrityKey?: Uint8Array;
  connectorRelease?: ConnectorRelease;
  releaseTrust: ReleaseTrustV1;
  openDatabase(configuration: PrivatePostgresConfiguration): OpenedDatabase;
  createServer?: (options: Readonly<ServerOptions>, listener: Parameters<typeof createNodeServer>[1]) => Server;
  port?: number;
  reconcileIntervalMs?: number;
}>): Promise<Readonly<{ store: FleetGatewayStoreV1; origin: string; start(): Promise<void>; close(): Promise<void> }>> {
  const roles = fleetRoles(input.databaseRoles);
  return prepareMacLocalFleetGatewayCoreV1({ ...input,
    tenantId: input.configuration.localOwnerSession.tenantId, gatewayDatabase: roles.gateway });
}

/** Adapts the updater's one sealed fleet-gateway.json directly to the same
 * production composition used by the ordinary Mac-local launcher. */
export async function prepareInstalledMacLocalFleetGatewayV1(input: Readonly<{
  configuration: Readonly<{ tenantId: string; port: number; database: PrivatePostgresConfiguration;
    workIntake?: GatewayWorkIntake; harnessIntegrityKey?: string; releaseTrust: ReleaseTrustV1 }>;
  connectorRelease?: ConnectorRelease;
  healthProbeKey?: Uint8Array;
  openDatabase(configuration: PrivatePostgresConfiguration): OpenedDatabase;
}>): Promise<Readonly<{ store: FleetGatewayStoreV1; origin: string; start(): Promise<void>; close(): Promise<void> }>> {
  const harnessIntegrityKey = input.configuration.harnessIntegrityKey === undefined ? undefined
    : new Uint8Array(Buffer.from(input.configuration.harnessIntegrityKey, "base64url"));
  return prepareMacLocalFleetGatewayCoreV1({ tenantId: input.configuration.tenantId,
    gatewayDatabase: input.configuration.database, port: input.configuration.port,
    ...(input.configuration.workIntake ? { workIntake: input.configuration.workIntake } : {}),
    ...(harnessIntegrityKey ? { harnessIntegrityKey } : {}),
    ...(input.connectorRelease ? { connectorRelease: input.connectorRelease } : {}),
    ...(input.healthProbeKey ? { healthProbeKey: input.healthProbeKey } : {}),
    releaseTrust: input.configuration.releaseTrust, openDatabase: input.openDatabase });
}
