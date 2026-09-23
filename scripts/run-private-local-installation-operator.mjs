#!/usr/bin/env node
import { pathToFileURL, fileURLToPath } from "node:url";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";

const shippedReleaseRoot = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/u, "");

let ownerHostProviderState = "unregistered";
let ownerHostProvider;

/** One process-local reviewed handoff. It accepts no path, environment name,
 * command, or serialized callback and cannot be replaced or reused. */
export function registerPrivateInstalledOwnerHostInputProviderV1(provider) {
  if (ownerHostProviderState !== "unregistered" || typeof provider !== "function" || types.isProxy(provider))
    throw new Error("private_installed_owner_host_input_provider_refused");
  ownerHostProvider = provider;
  ownerHostProviderState = "registered";
  return Object.freeze({ status: "registered", processLocal: true, oneUse: true });
}

async function takePrivateInstalledOwnerHostInputV1() {
  if (ownerHostProviderState !== "registered") throw new Error("owner_held_installed_operator_input_missing");
  ownerHostProviderState = "spent";
  const provider = ownerHostProvider;
  ownerHostProvider = undefined;
  return provider();
}

function inertOwnValue(value, name) {
  if (!value || typeof value !== "object" || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  return descriptor && descriptor.enumerable === true && "value" in descriptor
    ? descriptor.value : undefined;
}

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
    return takePrivateInstalledOwnerHostInputV1();
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
    let loader;
    try {
      const loadOwnerInput = typeof runtime.loadOwnerHeldInstalledOperatorInput === "function"
        ? runtime.loadOwnerHeldInstalledOperatorInput.bind(runtime)
        : installedRuntime.loadOwnerHeldInstalledOperatorInput;
      const ownerInput = await loadOwnerInput();
      const ownerInputStatus = inertOwnValue(ownerInput, "status");
      const ownerInputBlocker = inertOwnValue(ownerInput, "blocker");
      if (ownerInputStatus === "blocked" && typeof ownerInputBlocker === "string") {
        runtime.reportError(`Control Room operator owner-host preflight is blocked: ${ownerInputBlocker}; no setup action was started.`);
        return 1;
      }
      loader = ownerInputStatus === "loader_ready"
        ? module.consumePrivateInstalledOwnerHostInputCompositionV1(ownerInput)
        : module.createPrivateInstalledLocalOperatorLoaderV1(ownerInput);
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
