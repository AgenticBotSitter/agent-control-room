import { execFile as execFileCallback } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { isAbsolute, resolve } from "node:path";

const execFile = promisify(execFileCallback);

function recordedExecutableVersion(stdout) {
  const lines = stdout.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const version = lines.find(line => /(?:^|\s)(?:v?\d+\.\d+|version\b)/iu.test(line));
  if (!version || version.length > 240 || /[\u0000-\u001f\u007f]/u.test(version))
    throw new Error("mac_local_executable_version_unavailable");
  return version;
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
    return recordedExecutableVersion(result.stdout);
  } catch { throw new Error("mac_local_executable_version_unavailable"); }
}

export async function startMacLocalWebHost(input, runtime = {}) {
  if (!input || typeof input.protectedRoot !== "string") throw new Error("mac_local_web_host_arguments_invalid");
  const releaseRoot = new URL("../../dist-vps/server/", import.meta.url);
  const load = runtime.load ?? (path => import(path));
  const [hostModule, loaderModule, postgresModule, servingModule, rendererModule] = await Promise.all([
    load(new URL("macLocalHost.js", releaseRoot).href), load(new URL("macLocalProtectedLoader.js", releaseRoot).href),
    load(new URL("privatePostgres.js", releaseRoot).href), load(new URL("serving.js", releaseRoot).href),
    load(new URL("index.js", releaseRoot).href),
  ]);
  if (typeof hostModule.createMacLocalProtectedHostV1 !== "function" || typeof loaderModule.loadMacLocalProtectedConfigurationFromRootV1 !== "function"
    || typeof postgresModule.createPrivatePostgresDatabase !== "function" || typeof servingModule.loadPrivateClientAssets !== "function"
    || typeof rendererModule.default !== "function") throw new Error("mac_local_web_host_release_invalid");
  const assets = await servingModule.loadPrivateClientAssets(fileURLToPath(new URL("../../dist-vps/client", import.meta.url)));
  const host = hostModule.createMacLocalProtectedHostV1({
    loadConfiguration: () => loaderModule.loadMacLocalProtectedConfigurationFromRootV1(input.protectedRoot),
    readVersion: runtime.readVersion ?? readPinnedMacExecutableVersion,
    openDatabase: postgresModule.createPrivatePostgresDatabase,
    assets, render: rendererModule.default,
  });
  return host.start();
}

/** Starts the same protected host with the one fixed owner-held task provider.
 * This is intentionally a separate command from `mac:host`: invoking the
 * website does not also activate a queue or a local agent. */
export async function startMacLocalTaskHost(input, runtime = {}) {
  if (!input || typeof input.protectedRoot !== "string") throw new Error("mac_local_web_host_arguments_invalid");
  const releaseRoot = new URL("../../dist-vps/server/", import.meta.url);
  const load = runtime.load ?? (path => import(path));
  const [hostModule, loaderModule, providerModule, postgresModule, queueModule, servingModule, rendererModule] = await Promise.all([
    load(new URL("macLocalHost.js", releaseRoot).href), load(new URL("macLocalProtectedLoader.js", releaseRoot).href),
    load(new URL("macLocalTaskProvider.js", releaseRoot).href), load(new URL("privatePostgres.js", releaseRoot).href),
    load(new URL("nativeQueueFactories.js", releaseRoot).href),
    load(new URL("serving.js", releaseRoot).href), load(new URL("index.js", releaseRoot).href),
  ]);
  if (typeof hostModule.createMacLocalProtectedHostV1 !== "function" || typeof loaderModule.loadMacLocalProtectedConfigurationFromRootV1 !== "function"
    || typeof loaderModule.loadMacLocalDatabaseRolesFromRootV1 !== "function" || typeof providerModule.loadMacLocalTaskProviderFromRootV1 !== "function"
    || typeof providerModule.requireMacLocalThreeAgentReadinessV1 !== "function"
    || typeof postgresModule.createPrivatePostgresDatabase !== "function" || typeof queueModule.createInstalledNativeQueueFactories !== "function"
    || typeof servingModule.loadPrivateClientAssets !== "function"
    || typeof rendererModule.default !== "function") throw new Error("mac_local_web_host_release_invalid");
  const [assets, provider] = await Promise.all([
    servingModule.loadPrivateClientAssets(fileURLToPath(new URL("../../dist-vps/client", import.meta.url))),
    providerModule.loadMacLocalTaskProviderFromRootV1(input.protectedRoot),
  ]);
  const host = hostModule.createMacLocalProtectedHostV1({
    loadConfiguration: () => loaderModule.loadMacLocalProtectedConfigurationFromRootV1(input.protectedRoot),
    loadDatabaseRoles: () => loaderModule.loadMacLocalDatabaseRolesFromRootV1(input.protectedRoot),
    readVersion: runtime.readVersion ?? readPinnedMacExecutableVersion,
    openDatabase: postgresModule.createPrivatePostgresDatabase,
    createTaskApplication: async input => {
      providerModule.requireMacLocalThreeAgentReadinessV1(provider, input.workerReadiness);
      return provider.createTaskApplication(input);
    },
    startQueueWorker: queueModule.createInstalledNativeQueueFactories({
      openWorkerDatabase: postgresModule.createPrivatePostgresDatabase,
    }).startNativeWorker,
    assets, render: rendererModule.default,
  });
  return host.start();
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
