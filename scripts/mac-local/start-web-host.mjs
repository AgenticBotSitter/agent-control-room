import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";
import { pinnedVersionLine } from "./executable-version.mjs";

const execFile = promisify(execFileCallback);
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

export async function readPinnedMacExecutableVersion(executablePath, runtime = { execFile }) {
  if (!isAbsolute(executablePath) || resolve(executablePath) !== executablePath) throw new Error("mac_local_executable_invalid");
  try {
    const result = await runtime.execFile(executablePath, ["--version"], {
      windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 4_096,
      encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
    });
    return pinnedVersionLine(result.stdout);
  } catch { throw new Error("mac_local_executable_version_unavailable"); }
}

/** Non-executing startup introspection for the owner-protected model policy.
 * A changed CLI surface makes only that worker unavailable. */
export async function verifyPinnedMacModelPolicy(worker, runtime = { execFile }) {
  if (!worker?.modelPolicy || !isAbsolute(worker.executablePath) || resolve(worker.executablePath) !== worker.executablePath) return false;
  const run = async args => (await runtime.execFile(worker.executablePath, args, {
    windowsHide: true, timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 262_144,
    encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: process.env.HOME ?? "", NODE_ENV: "production" },
  })).stdout;
  try {
    if (worker.kind === "codex") {
      const [models, help] = await Promise.all([run(["debug", "models"]), run(["exec", "--help"])]);
      return help.includes("--model") && worker.modelPolicy.models.every(model => models.includes(model));
    }
    const help = await run(["--help"]);
    if (worker.kind === "claude-code") return help.includes("--model") && help.includes("--effort");
    return help.includes("--model") && help.includes("--provider") && help.includes("--profile");
  } catch { return false; }
}

export async function startMacLocalWebHost(input, runtime = {}) {
  if (!input || typeof input.protectedRoot !== "string") throw new Error("mac_local_web_host_arguments_invalid");
  const releaseRoot = new URL("../../dist-vps/server/", import.meta.url);
  const [healthProbeKey, healthReleaseId] = await Promise.all([
    runtime.loadHealthProbeKey ?? loadHealthProbeKeyV1(input.protectedRoot),
    runtime.hostReleaseIdentity ?? hostReleaseIdentityV1(fileURLToPath(releaseRoot)),
  ]);
  const load = runtime.load ?? (path => import(path));
  const [hostModule, loaderModule, postgresModule, servingModule, rendererModule, intakeModule] = await Promise.all([
    load(new URL("macLocalHost.js", releaseRoot).href), load(new URL("macLocalProtectedLoader.js", releaseRoot).href),
    load(new URL("privatePostgres.js", releaseRoot).href), load(new URL("serving.js", releaseRoot).href),
    load(new URL("index.js", releaseRoot).href), load(new URL("workIntakePrivateService.js", releaseRoot).href),
  ]);
  if (typeof hostModule.createMacLocalProtectedHostV1 !== "function" || typeof loaderModule.loadMacLocalProtectedConfigurationFromRootV1 !== "function"
    || typeof loaderModule.loadOwnerWebPushConfigFromRootV1 !== "function"
    || typeof postgresModule.createPrivatePostgresDatabase !== "function" || typeof servingModule.loadPrivateClientAssets !== "function"
    || typeof rendererModule.default !== "function"
    || typeof loaderModule.loadWorkIntakeServerConfigurationFromRootV1 !== "function"
    || typeof intakeModule.prepareWorkIntakePrivateServiceV1 !== "function")
    throw new Error("mac_local_web_host_release_invalid");
  const assets = await servingModule.loadPrivateClientAssets(fileURLToPath(new URL("../../dist-vps/client", import.meta.url)));
  const [configuration,installed,ownerWebPush] = await Promise.all([
    loaderModule.loadMacLocalProtectedConfigurationFromRootV1(input.protectedRoot),
    loaderModule.loadWorkIntakeServerConfigurationFromRootV1(input.protectedRoot),
    loaderModule.loadOwnerWebPushConfigFromRootV1(input.protectedRoot)]);
  verifyIntakeRoster(configuration,installed);
  const host = hostModule.createMacLocalProtectedHostV1({
    loadConfiguration: async () => configuration,
    readVersion: runtime.readVersion ?? readPinnedMacExecutableVersion,
    verifyModelPolicy: runtime.verifyModelPolicy ?? verifyPinnedMacModelPolicy,
    openDatabase: postgresModule.createPrivatePostgresDatabase,
    ...(installed ? { workBatchIntegrityKey: Uint8Array.from(Buffer.from(installed.integrityKey, "base64url")) } : {}),
    ...(ownerWebPush ? { ownerWebPush } : {}),
    healthProbeKey, healthReleaseId, healthStartedAt: hostStartedAt,
    assets, render: rendererModule.default,
  });
  return startHostWithOptionalIntake(host, installed, intakeModule);
}

export async function startHostWithOptionalIntake(host, installed, intakeModule) {
  let active, intake;
  try {
    if (installed) intake = await intakeModule.prepareWorkIntakePrivateServiceV1({ ...installed,
      integrityKey: Uint8Array.from(Buffer.from(installed.integrityKey, "base64url")) });
    active = await host.start();
    if (!intake) return active;
    await intake.start();
    return Object.freeze({
      isReady: active.isReady.bind(active),
      async close() {
        const results = await Promise.allSettled([intake.close(), active.close()]);
        if (results.some(result => result.status === "rejected")) throw new Error("mac_local_web_host_cleanup_uncertain");
      },
    });
  } catch (error) {
    const cleanup = await Promise.allSettled([intake?.close(), active?.close()]);
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
  if (!input || typeof input.protectedRoot !== "string") throw new Error("mac_local_web_host_arguments_invalid");
  const releaseRoot = new URL("../../dist-vps/server/", import.meta.url);
  const [healthProbeKey, healthReleaseId] = await Promise.all([
    runtime.loadHealthProbeKey ?? loadHealthProbeKeyV1(input.protectedRoot),
    runtime.hostReleaseIdentity ?? hostReleaseIdentityV1(fileURLToPath(releaseRoot)),
  ]);
  const load = runtime.load ?? (path => import(path));
  const [hostModule, loaderModule, providerModule, postgresModule, queueModule, servingModule, rendererModule,
    intakeModule] = await Promise.all([
    load(new URL("macLocalHost.js", releaseRoot).href), load(new URL("macLocalProtectedLoader.js", releaseRoot).href),
    load(new URL("macLocalTaskProvider.js", releaseRoot).href), load(new URL("privatePostgres.js", releaseRoot).href),
    load(new URL("nativeQueueFactories.js", releaseRoot).href),
    load(new URL("serving.js", releaseRoot).href), load(new URL("index.js", releaseRoot).href),
    load(new URL("workIntakePrivateService.js", releaseRoot).href),
  ]);
  if (typeof hostModule.createMacLocalProtectedHostV1 !== "function" || typeof loaderModule.loadMacLocalProtectedConfigurationFromRootV1 !== "function"
    || typeof loaderModule.loadOwnerWebPushConfigFromRootV1 !== "function"
    || typeof loaderModule.loadMacLocalDatabaseRolesFromRootV1 !== "function" || typeof providerModule.loadMacLocalTaskProviderFromRootV1 !== "function"
    || typeof providerModule.requireMacLocalThreeAgentReadinessV1 !== "function"
    || typeof postgresModule.createPrivatePostgresDatabase !== "function" || typeof queueModule.createInstalledNativeQueueFactories !== "function"
    || typeof servingModule.loadPrivateClientAssets !== "function"
    || typeof rendererModule.default !== "function"
    || typeof loaderModule.loadWorkIntakeServerConfigurationFromRootV1 !== "function"
    || typeof intakeModule.prepareWorkIntakePrivateServiceV1 !== "function") throw new Error("mac_local_web_host_release_invalid");
  const [assets, provider, installed, configuration, ownerWebPush] = await Promise.all([
    servingModule.loadPrivateClientAssets(fileURLToPath(new URL("../../dist-vps/client", import.meta.url))),
    providerModule.loadMacLocalTaskProviderFromRootV1(input.protectedRoot),
    loaderModule.loadWorkIntakeServerConfigurationFromRootV1(input.protectedRoot),
    loaderModule.loadMacLocalProtectedConfigurationFromRootV1(input.protectedRoot),
    loaderModule.loadOwnerWebPushConfigFromRootV1(input.protectedRoot),
  ]);
  verifyIntakeRoster(configuration,installed);
  const host = hostModule.createMacLocalProtectedHostV1({
    loadConfiguration: async () => configuration,
    loadDatabaseRoles: () => loaderModule.loadMacLocalDatabaseRolesFromRootV1(input.protectedRoot),
    readVersion: runtime.readVersion ?? readPinnedMacExecutableVersion,
    verifyModelPolicy: runtime.verifyModelPolicy ?? verifyPinnedMacModelPolicy,
    openDatabase: postgresModule.createPrivatePostgresDatabase,
    ...(installed ? { workBatchIntegrityKey: Uint8Array.from(Buffer.from(installed.integrityKey, "base64url")) } : {}),
    ...(ownerWebPush ? { ownerWebPush } : {}),
    healthProbeKey, healthReleaseId, healthStartedAt: hostStartedAt,
    createTaskApplication: async hostInput => {
      providerModule.requireMacLocalThreeAgentReadinessV1(provider, hostInput.workerReadiness);
      return provider.createTaskApplication({ ...hostInput, protectedRoot: input.protectedRoot });
    },
    startQueueWorker: queueModule.createInstalledNativeQueueFactories({
      openWorkerDatabase: postgresModule.createPrivatePostgresDatabase,
    }).startNativeWorker,
    hostProcessId: process.pid,
    assets, render: rendererModule.default,
  });
  return startHostWithOptionalIntake(host, installed, intakeModule);
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
