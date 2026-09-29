#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const shippedReleaseRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

function refused() { throw new Error("local_setup_host_arguments_invalid"); }

export function parseLocalSetupHostArguments(args) {
  if (!Array.isArray(args)) refused();
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ help: true });
  if (args.length !== 8) refused();
  const expected = new Set(["--release-root", "--journal-root", "--installation-id", "--port"]), values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!expected.has(flag) || values.has(flag) || typeof value !== "string") refused();
    values.set(flag, value);
  }
  if (values.size !== expected.size) refused();
  const releaseRoot = values.get("--release-root"), journalRoot = values.get("--journal-root");
  const installationId = values.get("--installation-id"), portText = values.get("--port");
  if (typeof releaseRoot !== "string" || !isAbsolute(releaseRoot) || resolve(releaseRoot) !== releaseRoot || releaseRoot !== shippedReleaseRoot
    || typeof journalRoot !== "string" || !isAbsolute(journalRoot) || resolve(journalRoot) !== journalRoot
    || typeof installationId !== "string" || !installationIdPattern.test(installationId)
    || typeof portText !== "string" || !/^[1-9][0-9]{0,4}$/u.test(portText)) refused();
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port !== 3210) refused();
  return Object.freeze({ releaseRoot, journalRoot, installationId, port });
}

const installedRuntime = Object.freeze({
  signals: process,
  ownerUid: () => process.getuid?.(),
  report: message => process.stdout.write(message),
  reportError: message => console.error(message),
  loadRelease: () => Promise.all([
    import("../dist-vps/server/localSetupHost.js"),
    import("../dist-vps/server/serving.js"),
    import("../dist-vps/server/index.js"),
    import("../dist-vps/server/taskHost.js"),
  ]),
});

/** Explicit, fixed-release local setup entrypoint. Import and construction are
 * inert. It opens no browser and reports readiness only after the reviewed
 * loopback service has actually bound and confirms its own readiness. */
export async function runLocalSetupHost(args, runtime = installedRuntime) {
  let parsed;
  try { parsed = parseLocalSetupHostArguments(args); }
  catch {
    runtime.reportError("Control Room local setup host refused its arguments.");
    return 2;
  }
  if (parsed.help) {
    runtime.report("Usage: node scripts/run-local-setup-host.mjs --release-root /absolute/shipped-release-root --journal-root /absolute/private-journal-root --installation-id SAFE_ID --port 3210\n");
    runtime.report("Starts only the local setup page. It does not open a browser or activate a worker.\n");
    return 0;
  }
  const ownerUid = runtime.ownerUid?.();
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    runtime.reportError("Control Room local setup host requires an owner-local runtime.");
    return 1;
  }
  let host;
  try {
    const [hostModule, serving, renderer, lifecycleModule] = await runtime.loadRelease();
    if (typeof hostModule?.createInstalledLocalSetupHostV1 !== "function" || typeof serving?.loadPrivateClientAssets !== "function"
      || typeof renderer?.default !== "function" || typeof lifecycleModule?.startPrivateHostLifecycle !== "function") throw new Error();
    const clientRoot = fileURLToPath(new URL("../dist-vps/client", import.meta.url));
    const assets = await serving.loadPrivateClientAssets(clientRoot);
    const lifecycle = lifecycleModule.startPrivateHostLifecycle({ signals: runtime.signals, async start(signal) {
      if (signal.aborted) throw new Error("local_setup_host_start_canceled");
      host = hostModule.createInstalledLocalSetupHostV1({ journalRoot: parsed.journalRoot, installationId: parsed.installationId,
        ownerUid, port: parsed.port, assets, render: renderer.default, isApplicationReady: () => true,
        async closeApplication() {} });
      const cancel = () => { void host?.close().catch(() => {}); };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        await host.start();
        if (signal.aborted || !host.isReady()) throw new Error("local_setup_host_start_unavailable");
        return host;
      } catch (error) {
        await host?.close();
        throw error;
      } finally { signal.removeEventListener("abort", cancel); }
    } });
    await lifecycle.ready;
    if (!host?.isReady()) throw new Error("local_setup_host_start_unavailable");
    runtime.report(`${JSON.stringify({ schema: "control-room.local-setup-host-readiness/v1", state: "ready",
      origin: `http://127.0.0.1:${parsed.port}`, path: "/setup" })}\n`);
    const completed = await lifecycle.completed;
    if (completed.status !== "closed") throw new Error("local_setup_host_cleanup_uncertain");
    return 0;
  } catch {
    runtime.reportError("Control Room local setup host did not become ready; cleanup may require owner attention.");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runLocalSetupHost(process.argv.slice(2));
