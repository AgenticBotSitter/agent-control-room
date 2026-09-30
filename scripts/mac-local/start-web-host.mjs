import { fileURLToPath, pathToFileURL } from "node:url";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { isAbsolute, resolve } from "node:path";
const hostStartedAt = new Date().toISOString();

export async function loadHealthProbeKeyV1(protectedRoot) {
  try {
    const path = join(protectedRoot, "service", "health-probe.key"), entry = await lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o777) !== 0o600) throw new Error();
    const encoded = (await readFile(path, "utf8")).trim();
    if (!/^[A-Za-z0-9_-]{43}$/u.test(encoded)) throw new Error();
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32) throw new Error();
    return key;
  } catch { throw new Error("mac_local_health_probe_key_invalid"); }
}

/** The running host reports the release that contains its own built server,
 * never a caller-selected release. A checkout has no sealed release record. */
export async function hostReleaseIdentityV1(codeDirectory) {
  try {
    const directory = await realpath(codeDirectory);
    const value = JSON.parse(await readFile(join(directory, ".control-room-release.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.version !== "string" || !value.version)
      throw new Error();
    return value.version;
  } catch { return "dev"; }
}

/** Parse only the owner-attended, fixed-root website launch form.  The task
 * lifecycle and queue are deliberately not accepted here: this is the first
 * usable local website, not a shortcut around later worker authorization. */
export function parseMacLocalWebHostArguments(args) {
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ help: true });
  if (args.length !== 3 || args[0] !== "--owner-attended" || args[1] !== "--protected-root"
    || !isAbsolute(args[2]) || resolve(args[2]) !== args[2]
    || [...args[2]].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error("mac_local_web_host_arguments_invalid");
  }
  return Object.freeze({ protectedRoot: args[2] });
}

export async function startMacLocalWebHost(input, runtime = {}) {
  if (!input || typeof input.protectedRoot !== "string") throw new Error("mac_local_web_host_arguments_invalid");
  const releaseRoot = new URL("../../dist-vps/server/", import.meta.url);
  const [healthProbeKey, healthReleaseId] = await Promise.all([
    runtime.loadHealthProbeKey ?? loadHealthProbeKeyV1(input.protectedRoot),
    runtime.hostReleaseIdentity ?? hostReleaseIdentityV1(fileURLToPath(releaseRoot)),
  ]);
  const load = runtime.load ?? (path => import(path));
  const [hostModule, loaderModule, postgresModule, servingModule, rendererModule, intakeModule, fleetModule] = await Promise.all([
    load(new URL("macLocalHost.js", releaseRoot).href), load(new URL("macLocalProtectedLoader.js", releaseRoot).href),
    load(new URL("privatePostgres.js", releaseRoot).href), load(new URL("serving.js", releaseRoot).href),
    load(new URL("index.js", releaseRoot).href), load(new URL("workIntakePrivateService.js", releaseRoot).href),
    load(new URL("macLocalFleet.js", releaseRoot).href),
  ]);
  if (typeof hostModule.createMacLocalProtectedHostV1 !== "function" || typeof loaderModule.loadMacLocalProtectedConfigurationFromRootV1 !== "function"
    || typeof loaderModule.loadOwnerWebPushConfigFromRootV1 !== "function"
    || typeof postgresModule.createPrivatePostgresDatabase !== "function" || typeof servingModule.loadPrivateClientAssets !== "function"
    || typeof rendererModule.default !== "function"
    || typeof loaderModule.loadWorkIntakeServerConfigurationFromRootV1 !== "function"
    || typeof loaderModule.loadMacLocalDatabaseRolesFromRootV1 !== "function"
    || typeof intakeModule.prepareWorkIntakePrivateServiceV1 !== "function"
    || typeof fleetModule.prepareMacLocalFleetOwnerV1 !== "function"
    || typeof fleetModule.loadMacLocalFleetConnectorReleaseV1 !== "function")
    throw new Error("mac_local_web_host_release_invalid");
  const assets = await servingModule.loadPrivateClientAssets(fileURLToPath(new URL("../../dist-vps/client", import.meta.url)));
  const [configuration,installed,ownerWebPush,databaseRoles,connectorRelease] = await Promise.all([
    loaderModule.loadMacLocalProtectedConfigurationFromRootV1(input.protectedRoot),
    loaderModule.loadWorkIntakeServerConfigurationFromRootV1(input.protectedRoot),
    loaderModule.loadOwnerWebPushConfigFromRootV1(input.protectedRoot),
    loaderModule.loadMacLocalDatabaseRolesFromRootV1(input.protectedRoot),
    fleetModule.loadMacLocalFleetConnectorReleaseV1(fileURLToPath(new URL("../fleet/release", import.meta.url)))]);
  verifyIntakeRoster(configuration,installed);
  const fleetOwner = fleetModule.prepareMacLocalFleetOwnerV1({ configuration, databaseRoles,
    openDatabase: postgresModule.createPrivatePostgresDatabase, ...(connectorRelease ? { connectorRelease } : {}) });
  let host;
  try {
    host = hostModule.createMacLocalProtectedHostV1({
      loadConfiguration: async () => configuration,
      connectorOnly: true,
      openDatabase: postgresModule.createPrivatePostgresDatabase,
      ...(installed ? { workBatchIntegrityKey: Uint8Array.from(Buffer.from(installed.integrityKey, "base64url")) } : {}),
      ...(ownerWebPush ? { ownerWebPush } : {}),
      fleet: fleetOwner.fleet,
      healthProbeKey, healthReleaseId, healthStartedAt: hostStartedAt,
      assets, render: rendererModule.default,
    });
  } catch (error) {
    await fleetOwner.close().catch(() => { throw new Error("mac_local_web_host_cleanup_uncertain"); });
    throw error;
  }
  return startHostWithOptionalIntake(host, installed, intakeModule, fleetOwner);
}

export async function startHostWithOptionalIntake(host, installed, intakeModule, fleetOwner = { async close() {} }) {
  let active, intake;
  try {
    if (installed) intake = await intakeModule.prepareWorkIntakePrivateServiceV1({ ...installed,
      integrityKey: Uint8Array.from(Buffer.from(installed.integrityKey, "base64url")) });
    active = await host.start();
    if (intake) await intake.start();
    return Object.freeze({
      ...active,
      // The supervisor's machine-health monitor reads readiness through this
      // host, so it must be the database-backed service signal and not a
      // stand-in that is true until close.
      isReady: active.isReady.bind(active),
      async close() {
        const results = await Promise.allSettled([intake?.close(), active.close(), fleetOwner.close()]);
        if (results.some(result => result.status === "rejected")) throw new Error("mac_local_web_host_cleanup_uncertain");
      },
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([intake?.close(), active?.close(), fleetOwner.close()]);
    if (cleanup.some(result => result.status === "rejected")) throw new Error("mac_local_web_host_cleanup_uncertain");
    throw error;
  }
}

function verifyIntakeRoster(configuration,installed){
  if(!installed)return;
  const roster=new Map((configuration.enablement?.workers??[]).map(worker=>[worker.workerId,worker.kind]));
  if(installed.credentials.length!==roster.size||installed.credentials.some(mapping=>roster.get(mapping.workerId)!==mapping.workerKind))
    throw new Error("work_intake_roster_binding_refused");
}

/** Starts the same protected host with the one fixed owner-held task provider.
 * This is intentionally a separate command from `mac:host`: invoking the
 * website does not also activate a queue or a local agent. */
export async function startMacLocalTaskHost(input, runtime = {}) {
  // The historical task-host command remains the stable launchd entry point,
  // but local bot execution has moved to owner LaunchAgents running the same
  // outbound connector as remote workers. Reuse the website/intake host so
  // this service never loads a task provider, queue worker, or bot CLI.
  return startMacLocalWebHost(input, runtime);
}

async function main() {
  const parsed = parseMacLocalWebHostArguments(process.argv.slice(2));
  if (parsed.help) {
    console.log("Usage: pnpm mac:host -- --owner-attended --protected-root ABSOLUTE_PATH");
    return;
  }
  const active = await startMacLocalWebHost(parsed);
  console.log("Control Room local website is running. Press Control-C to stop.");
  let closed = false;
  const stop = async () => {
    if (closed) return;
    closed = true;
    try { await active.close(); process.exitCode = 0; }
    catch { process.exitCode = 1; }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => { console.error(`mac-local-host: ${error.message}`); process.exitCode = 1; });
}
