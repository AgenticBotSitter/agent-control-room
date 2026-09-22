#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const shippedReleaseRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

/** Read-only installed-release gate. This is deliberately the prepared-release
 * boundary: node_modules and its durable receipt must already exist. */
export async function verifyInstalledPreparedOperatorReleaseV1(releaseRoot) {
  const [{ readFile }, release] = await Promise.all([
    import("node:fs/promises"),
    import("../src/installer/v1/local-production-dependencies.mjs"),
  ]);
  const manifest = await readFile(resolve(releaseRoot, "RELEASE_MANIFEST.json"));
  await release.verifyPreparedLocalProductionReleaseV1({
    installRoot: dirname(dirname(releaseRoot)), version: basename(releaseRoot),
    expectedManifestDigest: `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
  });
}

const installedRuntime = Object.freeze({
  async verifyRelease() {
    await verifyInstalledPreparedOperatorReleaseV1(shippedReleaseRoot);
  },
  async loadRelease() {
    return import("../dist-vps/server/privateLocalInstallationOperatorCli.js");
  },
  // The release entry never derives protected paths, native custody, database
  // authority, Hermes authority, or service ports from arguments/environment.
  // An owner-attended host must inject the exact reviewed input in-process.
  async loadOwnerHeldInstalledOperatorInput() {
    throw new Error("owner_held_installed_operator_input_missing");
  },
  report(message) { process.stdout.write(message); },
  reportError(message) { process.stderr.write(`${message}\n`); },
  signals: process,
});

export async function runPrivateLocalInstallationOperator(args, runtime = installedRuntime) {
  if (Array.isArray(args) && args.length === 1 && args[0] === "--help") {
    runtime.report("Usage: node scripts/run-private-local-installation-operator.mjs (status | setup-next | start)\n");
    runtime.report("Reads one installed private configuration. It does not accept paths, commands, environment factories, or browser actions.\n");
    return 0;
  }
  if (!Array.isArray(args) || args.length !== 1 || !["status", "setup-next", "start"].includes(args[0])) {
    runtime.reportError("Control Room operator command refused its arguments.");
    return 2;
  }
  try {
    if (typeof runtime.verifyRelease !== "function") throw new Error();
    await runtime.verifyRelease();
    const module = await runtime.loadRelease();
    if (typeof module?.runPrivateLocalInstallationOperatorCliV1 !== "function"
      || typeof module?.createPrivateInstalledLocalOperatorLoaderV1 !== "function") throw new Error();
    if (typeof runtime.loadOwnerHeldInstalledOperatorInput !== "function") {
      runtime.reportError("Control Room operator owner-held dependencies are unavailable; no setup action was started.");
      return 1;
    }
    let loader;
    try {
      loader = module.createPrivateInstalledLocalOperatorLoaderV1(
        await runtime.loadOwnerHeldInstalledOperatorInput());
      if (!loader || loader.status !== "owner_inputs_captured"
        || typeof loader.loadInstalledConfiguration !== "function") throw new Error();
    } catch {
      runtime.reportError("Control Room operator owner-held dependencies are unavailable; no setup action was started.");
      return 1;
    }
    return await module.runPrivateLocalInstallationOperatorCliV1(args, {
      loadInstalledConfiguration: loader.loadInstalledConfiguration,
      report: runtime.report,
      reportError: runtime.reportError,
      signals: runtime.signals,
      createOperator: runtime.createOperator,
      startLifecycle: runtime.startLifecycle,
    });
  } catch {
    runtime.reportError("Control Room operator release entry is unavailable; no setup action was started.");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runPrivateLocalInstallationOperator(process.argv.slice(2));
