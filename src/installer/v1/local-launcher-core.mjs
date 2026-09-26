import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { stageLocalReleaseV1 } from "./local-release-stager.mjs";
import { superviseLocalSetupLauncherHostV1 } from "./local-setup-launcher-supervisor.mjs";

export const LOCAL_LAUNCHER_CORE_V1 = "control-room.local-launcher-core/v1";

const MAX_RELEASE_MANIFEST_BYTES = 16 * 1024 * 1024;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const safeIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const refusalCodes = Object.freeze({
  refused: "local_launcher_core_refused",
  preflight: "local_launcher_core_preflight_refused",
  setup: "local_launcher_core_setup_refused",
  bootstrap: "local_launcher_core_plan_bootstrap_refused",
  setupHost: "local_launcher_core_setup_host_refused",
});

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function refused(codes, key = "refused") {
  const reason = codes[key] ?? codes.refused;
  const error = new Error(reason);
  error.code = reason;
  throw error;
}

function inside(child, parent) {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

async function regularFile(path, root, maximum, codes) {
  const [canonical, stat] = await Promise.all([realpath(path), lstat(path)]).catch(() => refused(codes));
  if (canonical !== path || !inside(path, root) || !stat.isFile() || stat.isSymbolicLink()
    || stat.nlink !== 1 || stat.size < 1 || stat.size > maximum) refused(codes);
  return stat;
}

function validInput(input) {
  return input && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).sort().join(",")
      === "environment,executable,installRoot,installationId,journalRoot,releaseDirectory,schema,topologyPlanDigest,verifiedBundle"
    && input.verifiedBundle && typeof input.verifiedBundle === "object" && !Array.isArray(input.verifiedBundle)
    && Object.keys(input.verifiedBundle).sort().join(",") === "fileCount,releaseManifestDigest,verified,version"
    && input.verifiedBundle.verified === true && typeof input.verifiedBundle.version === "string"
    && Number.isSafeInteger(input.verifiedBundle.fileCount) && input.verifiedBundle.fileCount > 0
    && digestPattern.test(input.verifiedBundle.releaseManifestDigest)
    && typeof input.releaseDirectory === "string" && typeof input.installRoot === "string"
    && typeof input.journalRoot === "string" && typeof input.executable === "string"
    && input.environment && typeof input.environment === "object" && !Array.isArray(input.environment)
    && typeof input.schema === "string" && input.schema.length > 0
    && safeIdPattern.test(input.installationId) && digestPattern.test(input.topologyPlanDigest);
}

async function runJson(runner, spec, codes, failure) {
  const result = await runner(spec);
  if (!result || result.exitCode !== 0 || result.signal !== null || result.oversized || result.timedOut
    || typeof result.stdout !== "string" || (result.stderr !== undefined && typeof result.stderr !== "string")) {
    refused(codes, failure);
  }
  try { return JSON.parse(result.stdout); } catch { return refused(codes, failure); }
}

/**
 * Composes a verified release into the existing effect-free setup path. Hosts
 * supply their already-verified bundle location, private roots, environment,
 * opener, and bounded process runner; this core owns no platform policy.
 */
export async function runLocalLauncherCoreV1(input, dependencies = {}) {
  const codes = { ...refusalCodes, ...(dependencies.refusalCodes ?? {}) };
  if (!validInput(input) || typeof dependencies.runner !== "function" || typeof dependencies.openerRunner !== "function"
    || typeof dependencies.openerExecutable !== "string" || !isAbsolute(dependencies.openerExecutable)
    || dependencies.openerExecutable.includes("\0")) {
    refused(codes);
  }
  const supervisor = dependencies.supervisor ?? superviseLocalSetupLauncherHostV1;
  if (typeof supervisor !== "function") refused(codes);

  const staged = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory: input.releaseDirectory,
    installRoot: input.installRoot });
  if (staged.state !== "verified_release_staged" || staged.version !== input.verifiedBundle.version
    || staged.releaseManifestDigest !== input.verifiedBundle.releaseManifestDigest || staged.usesNetwork
    || staged.installsOrStartsService || staged.createsDatabase || staged.writesCredentials) refused(codes);
  const versionRoot = join(input.installRoot, "versions", staged.version);
  const common = { executable: input.executable, cwd: versionRoot, environment: input.environment, terminationGraceMs: 2_000 };
  const preflight = await runJson(dependencies.runner, { ...common, timeoutMs: 60_000,
    args: [join(versionRoot, "scripts", "prepare-local-installation.mjs"), "--release-root", versionRoot, "--dry-run"] },
  codes, "preflight");
  if (preflight.readyForOwnerSetup !== true || preflight.startsService || preflight.createsDatabase || preflight.writesCredentials) {
    refused(codes);
  }

  const setupScript = join(versionRoot, "scripts", "launch-local-setup.mjs");
  let setup;
  try {
    setup = await runJson(dependencies.runner, { ...common, timeoutMs: 20 * 60_000,
      args: [setupScript, "--owner-attended", "--mode", "begin", "--release-directory", input.releaseDirectory,
        "--install-root", input.installRoot, "--journal-root", input.journalRoot,
        "--installation-id", input.installationId, "--topology-plan-digest", input.topologyPlanDigest] }, codes, "setup");
  } catch (error) {
    if (!(error instanceof Error) || error.message !== codes.setup) throw error;
    // An exact reopening is the only safe fallback. The existing resume path
    // verifies saved release and topology before setup-host opening.
    setup = await runJson(dependencies.runner, { ...common, timeoutMs: 20 * 60_000,
      args: [setupScript, "--owner-attended", "--mode", "resume", "--install-root", input.installRoot,
        "--journal-root", input.journalRoot, "--installation-id", input.installationId,
        "--topology-plan-digest", input.topologyPlanDigest, "--expected-release-version", staged.version,
        "--expected-release-manifest-digest", staged.releaseManifestDigest] }, codes, "setup");
  }
  if (!["source_only_rehearsal_begun", "source_only_rehearsal_resumed"].includes(setup.state)
    || setup.version !== staged.version || setup.createsDatabase || setup.startsService || setup.startsWorker
    || setup.launcherComplete || setup.productionAcceptanceComplete) refused(codes);

  const releaseManifestPath = join(versionRoot, "RELEASE_MANIFEST.json");
  await regularFile(releaseManifestPath, versionRoot, MAX_RELEASE_MANIFEST_BYTES, codes);
  const releaseDigest = `sha256:${sha256(await readFile(releaseManifestPath))}`;
  if (releaseDigest !== input.verifiedBundle.releaseManifestDigest) refused(codes);
  const bootstrap = await runJson(dependencies.runner, { ...common, timeoutMs: 60_000,
    args: [join(versionRoot, "scripts", "initialize-local-installation-plan.mjs"), "--owner-attended",
      "--journal-root", input.journalRoot, "--installation-id", input.installationId,
      "--release-digest", releaseDigest, "--controller-only"] }, codes, "bootstrap");
  if (bootstrap.schema !== "control-room.local-installation-plan-bootstrap/v1"
    || bootstrap.installationId !== input.installationId || bootstrap.revision !== 0
    || typeof bootstrap.planDigest !== "string" || !digestPattern.test(bootstrap.planDigest)
    || typeof bootstrap.replayed !== "boolean" || bootstrap.createsDatabase || bootstrap.writesCredentials
    || bootstrap.startsService || bootstrap.startsWorker || bootstrap.enablesAuthority
    || bootstrap.enablesWorkers || bootstrap.grantsExecutionAuthority) refused(codes);

  const supervised = await supervisor({ executable: input.executable, cwd: versionRoot,
    environment: input.environment, args: [join(versionRoot, "scripts", "run-local-setup-host.mjs"),
      "--release-root", versionRoot, "--journal-root", input.journalRoot,
      "--installation-id", input.installationId, "--port", "3210"] }, {
    runOpener: dependencies.openerRunner,
    openerExecutable: dependencies.openerExecutable,
    ...(dependencies.spawnProcess ? { spawnProcess: dependencies.spawnProcess } : {}),
    ...(dependencies.signals ? { signals: dependencies.signals } : {}),
    ...(dependencies.killGroup ? { killGroup: dependencies.killGroup } : {}),
    ...(dependencies.setTimer ? { setTimer: dependencies.setTimer } : {}),
    ...(dependencies.clearTimer ? { clearTimer: dependencies.clearTimer } : {}),
  });
  if (supervised?.state !== "setup_host_closed" || supervised.ready !== true
    || supervised.opened !== true || supervised.reaped !== true) refused(codes, "setupHost");
  return Object.freeze({ schema: input.schema, state: "source_only_setup_prepared", version: staged.version,
    releaseVerified: true, preflightPassed: true, setupEntrypointCompleted: true, installationPlanInitialized: true,
    alreadyStaged: staged.alreadyStaged, createsDatabase: false, startsService: false, startsWorker: false,
    setupHostOpened: true, setupHostClosed: true, launcherComplete: false, productionAcceptanceComplete: false });
}
