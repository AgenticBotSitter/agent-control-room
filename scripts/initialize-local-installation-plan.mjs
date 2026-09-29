#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const MAX_TOPOLOGY_BYTES = 64 * 1024;

function refused() { throw new Error("local_installation_plan_arguments_invalid"); }

export function parseLocalInstallationPlanArguments(args) {
  if (!Array.isArray(args)) refused();
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ help: true });
  const controllerOnly = args.filter(value => value === "--controller-only").length === 1;
  const topologyCount = args.filter(value => value === "--topology-plan").length;
  if ((controllerOnly === (topologyCount === 1)) || (controllerOnly ? args.length !== 8 : args.length !== 9)
    || args.filter(value => value === "--owner-attended").length !== 1) refused();
  const values = new Map(), expected = new Set(["--journal-root", "--installation-id", "--release-digest", "--topology-plan"]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--owner-attended" || flag === "--controller-only") continue;
    if (!expected.has(flag) || values.has(flag) || index === args.length - 1) refused();
    const value = args[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) refused();
    values.set(flag, value); index += 1;
  }
  if (values.size !== (controllerOnly ? 3 : expected.size)) refused();
  const journalRoot = values.get("--journal-root"), installationId = values.get("--installation-id");
  const releaseDigest = values.get("--release-digest"), topologyPlanPath = values.get("--topology-plan");
  if (typeof journalRoot !== "string" || !isAbsolute(journalRoot) || resolve(journalRoot) !== journalRoot
    || (!controllerOnly && (typeof topologyPlanPath !== "string" || !isAbsolute(topologyPlanPath) || resolve(topologyPlanPath) !== topologyPlanPath))
    || typeof installationId !== "string" || !installationIdPattern.test(installationId)
    || typeof releaseDigest !== "string" || !digestPattern.test(releaseDigest)) refused();
  return Object.freeze({ journalRoot, installationId, releaseDigest,
    ...(controllerOnly ? { controllerOnly: true } : { topologyPlanPath }) });
}

const installedRuntime = Object.freeze({
  ownerUid: () => process.getuid?.(),
  async readTopology(path) {
    const bytes = await readFile(path);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_TOPOLOGY_BYTES) refused();
    return JSON.parse(bytes.toString("utf8"));
  },
  loadBootstrap: () => import("../dist-vps/server/localInstallationPlanBootstrap.js"),
  report: message => process.stdout.write(message),
  reportError: message => console.error(message),
});

export async function runInitializeLocalInstallationPlan(args, runtime = installedRuntime) {
  let parsed;
  try { parsed = parseLocalInstallationPlanArguments(args); }
  catch {
    runtime.reportError("Control Room refused the local installation plan arguments.");
    return 2;
  }
  if (parsed.help) {
    runtime.report("Usage: node scripts/initialize-local-installation-plan.mjs --owner-attended --journal-root ABSOLUTE_PRIVATE_JOURNAL_ROOT --installation-id SAFE_ID --release-digest sha256:... (--controller-only | --topology-plan ABSOLUTE_REVIEWED_TOPOLOGY_JSON)\n");
    runtime.report("Creates only revision zero of the durable setup plan; it does not install, activate, or start anything.\n");
    return 0;
  }
  const ownerUid = runtime.ownerUid?.();
  if (!Number.isSafeInteger(ownerUid) || ownerUid < 0) {
    runtime.reportError("Control Room requires an owner-local runtime to initialize the installation plan.");
    return 1;
  }
  try {
    const [suppliedTopology, module] = await Promise.all([
      parsed.controllerOnly ? Promise.resolve(undefined) : runtime.readTopology(parsed.topologyPlanPath),
      runtime.loadBootstrap(),
    ]);
    if (typeof module?.initializeLocalInstallationPlanV1 !== "function") throw new Error();
    const topologyPlan = parsed.controllerOnly
      ? module.createControllerOnlyInstallationTopologyV1?.() : suppliedTopology;
    if (topologyPlan === undefined) throw new Error();
    const result = await module.initializeLocalInstallationPlanV1({ ownerAttended: true,
      journalRoot: parsed.journalRoot, installationId: parsed.installationId,
      releaseDigest: parsed.releaseDigest, topologyPlan }, { ownerUid: () => ownerUid });
    runtime.report(`${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    runtime.reportError("Control Room did not initialize the local installation plan; the reviewed inputs or saved plan conflicted.");
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  process.exitCode = await runInitializeLocalInstallationPlan(process.argv.slice(2));
