import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function parseArguments(args) {
  if (args.length === 1 && args[0] === "--help") return { help: true };
  const checkOnly = args[0] === "--check";
  const offset = checkOnly ? 1 : 0;
  if (args.length !== 2 + offset || args[offset] !== "--configuration" || !isAbsolute(args[offset + 1])
    || !args[offset + 1].endsWith(".mjs") || [...args[offset + 1]].some(character => character.charCodeAt(0) < 32))
    throw new Error("github_broker_arguments_invalid");
  return { configurationPath: args[offset + 1], checkOnly };
}

export async function readProtectedConfiguration(path, { trustedOwnerUid = 0, openFile = open } = {}) {
  let handle;
  try {
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")
      || !Number.isSafeInteger(trustedOwnerUid) || !Number.isInteger(constants.O_NOFOLLOW)) throw new Error();
    handle = await openFile(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.uid !== BigInt(trustedOwnerUid) || (before.mode & 0o022n) !== 0n
      || before.size < 1n || before.size > 256n * 1024n) throw new Error();
    const source = await handle.readFile("utf8");
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || Buffer.byteLength(source, "utf8") !== Number(after.size)
      || source.includes("\0")) throw new Error();
    return source;
  } catch { throw new Error("github_broker_configuration_invalid"); }
  finally { try { await handle?.close(); } catch {} }
}

export async function validateConfigurationPath(path, options) {
  await readProtectedConfiguration(path, options);
}

const installedRuntime = Object.freeze({
  signals: process,
  report: message => console.log(message),
  reportError: message => console.error(message),
  async loadOperator(path) {
    const source = await readProtectedConfiguration(path);
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  },
  loadRelease: () => import("../dist-vps/server/githubWorkerBroker.js"),
});

export async function runGitHubWorkerBroker(args, runtime = installedRuntime) {
  const parsed = parseArguments(args);
  if (parsed.help) {
    runtime.report("Usage: node scripts/run-github-worker-broker.mjs --configuration /absolute/operator-config.mjs");
    runtime.report("       node scripts/run-github-worker-broker.mjs --check --configuration /absolute/operator-config.mjs");
    runtime.report("Starts the private loopback broker. Installation and activation require separate approval.");
    return 0;
  }
  const controller = new AbortController();
  const stop = () => controller.abort();
  const stopped = new Promise(resolveStopped => controller.signal.addEventListener("abort", resolveStopped, { once: true }));
  runtime.signals.once("SIGTERM", stop); runtime.signals.once("SIGINT", stop);
  let service;
  try {
    const [operator, release] = await Promise.all([
      runtime.loadOperator(parsed.configurationPath), runtime.loadRelease(),
    ]);
    if (operator.schema !== "control-room.github-broker-operator/v1"
      || typeof operator.createConfiguration !== "function") throw new Error();
    service = await operator.createConfiguration({ signal: controller.signal, runtime: release });
    if (controller.signal.aborted) throw new Error();
    if (parsed.checkOnly) {
      await service.close();
      runtime.report("Control Room GitHub worker broker configuration check passed; no listener was opened.");
      return 0;
    }
    await service.start();
    if (controller.signal.aborted) throw new Error();
    runtime.report("Control Room GitHub worker broker ready on private loopback.");
    await stopped;
    await service.close();
    runtime.report("Control Room GitHub worker broker closed.");
    return 0;
  } catch {
    controller.abort();
    try { await service?.close(); } catch { runtime.reportError("Broker cleanup uncertain; operator attention required."); return 1; }
    runtime.reportError("Control Room GitHub worker broker startup failed.");
    return 1;
  } finally {
    runtime.signals.off("SIGTERM", stop); runtime.signals.off("SIGINT", stop);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { process.exitCode = await runGitHubWorkerBroker(process.argv.slice(2)); }
  catch { console.error("Control Room GitHub worker broker launcher refused setup."); process.exitCode = 1; }
}
