#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { verifyInstalledPreparedOperatorReleaseV1 } from
  "./run-private-local-installation-operator.mjs";

const shippedReleaseRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");
const inputSchema = "control-room.private-installed-owner-host-input-composition/v1";

const runtime = Object.freeze({
  async verifyRelease() { await verifyInstalledPreparedOperatorReleaseV1(shippedReleaseRoot); },
  async loadRelease() {
    return import("../dist-vps/server/privateLocalInstallationOperatorCli.js");
  },
  report(message) { process.stdout.write(message); },
  reportError(message) { process.stderr.write(`${message}\n`); },
});

/**
 * Inert shipped preflight for the exact release entry. It deliberately has no
 * owner path, credential, command, callback, environment, or standard-input
 * channel. Until the fixed installed owner-host composition exists, it reports
 * the first missing boundary and starts nothing.
 */
export async function preflightPrivateLocalOwnerHostV1(args, ports = runtime) {
  if (Array.isArray(args) && args.length === 1 && args[0] === "--help") {
    ports.report("Usage: node scripts/preflight-private-local-owner-host.mjs\n");
    ports.report("Checks the shipped owner-host setup boundary without starting setup or reading private input.\n");
    return 0;
  }
  if (!Array.isArray(args) || args.length !== 0) {
    ports.reportError("Control Room owner-host preflight refused its arguments.");
    return 2;
  }
  try {
    await ports.verifyRelease();
    const module = await ports.loadRelease();
    if (typeof module?.createPrivateInstalledOwnerHostProviderV1 !== "function"
      || typeof module?.inspectPrivateInstalledOwnerHostInputCompositionV1 !== "function") throw new Error();
    const input = Object.freeze({ schema: inputSchema });
    const inventory = module.inspectPrivateInstalledOwnerHostInputCompositionV1(input);
    if (!inventory || inventory.status !== "blocked" || !Array.isArray(inventory.blockers)
      || inventory.blockers.length === 0) throw new Error();
    const provider = module.createPrivateInstalledOwnerHostProviderV1(input);
    if (!provider || provider.schema !== "control-room.private-installed-owner-host-provider/v1"
      || provider.status !== "blocked" || typeof provider.blocker !== "string"
      || provider.processLocal !== true || provider.oneUse !== true || provider.performsEffect !== false) throw new Error();
    ports.report(`${JSON.stringify(Object.freeze({
      schema: "control-room.private-installed-owner-host-preflight/v1",
      status: "blocked", blockers: inventory.blockers,
      blocker: provider.blocker,
      performsEffect: false,
      readsCredentials: false,
      readsPrivatePaths: false,
      opensNativeSession: false,
      opensDatabase: false,
      startsService: false,
      startsWorker: false,
      invokesAgent: false,
    }))}\n`);
    return 1;
  } catch {
    ports.reportError("Control Room owner-host preflight is unavailable; no setup action was started.");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await preflightPrivateLocalOwnerHostV1(process.argv.slice(2));
