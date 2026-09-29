import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { prepareLocalProductionDependenciesV1 } from "./local-production-dependencies.mjs";
import { stageLocalReleaseV1 } from "./local-release-stager.mjs";

/**
 * Runtime for the shipped, source-only clean-install rehearsal. It uses the
 * release stager and dependency-preparation entry points in this same release,
 * then records only simulated setup stages in a private disposable journal.
 * It cannot create a database, service, worker, current-release pointer or
 * credentials. The journal is deliberately not the product installation
 * journal; real setup remains the existing separately-reviewed path.
 */
export const LOCAL_CLEAN_INSTALL_ACCEPTANCE_V1 =
  "control-room.local-clean-install-acceptance/v1";

const JOURNAL_SCHEMA = "control-room.local-clean-install-rehearsal-journal/v1";
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const versionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const idPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;
const stages = Object.freeze(["release_preflight", "private_placement", "database_authority", "protected_data",
  "first_owner", "recovery", "platform_service"]);
const refuse = (reason = "local_clean_install_acceptance_refused") => {
  const error = new Error(reason); error.code = reason; throw error;
};
const canonicalJson = value => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => {
    const child = value[key];
    if (child === undefined || typeof child === "function" || typeof child === "symbol" || typeof child === "bigint") refuse();
    return `${JSON.stringify(key)}:${canonicalJson(child)}`;
  }).join(",")}}`;
  refuse();
};
const digest = value => `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) refuse();
  return value;
}

async function privateDirectory(value) {
  const path = absolute(value);
  const [entry, canonical] = await Promise.all([lstat(path), realpath(path)]).catch(() => refuse());
  if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== path || (entry.mode & 0o077) !== 0) refuse();
  return path;
}

async function durableCreate(path, bytes) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600).catch(error => {
    if (error?.code === "EEXIST") refuse("local_clean_install_acceptance_in_progress_or_replayed");
    throw error;
  });
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
  const directory = await open(join(path, ".."), constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

function journalName(installationId) { return `${installationId}.clean-install-rehearsal.json`; }

function journalMaterial(value) {
  if (!exactKeys(value, ["installationId", "manifestDigest", "planDigest", "schema", "simulatedStages", "topologyPlanDigest", "version"])
    || value.schema !== JOURNAL_SCHEMA || typeof value.installationId !== "string" || !idPattern.test(value.installationId)
    || typeof value.version !== "string" || !versionPattern.test(value.version)
    || typeof value.manifestDigest !== "string" || !digestPattern.test(value.manifestDigest)
    || typeof value.topologyPlanDigest !== "string" || !digestPattern.test(value.topologyPlanDigest)
    || !Array.isArray(value.simulatedStages) || canonicalJson(value.simulatedStages) !== canonicalJson(stages)
    || typeof value.planDigest !== "string" || !digestPattern.test(value.planDigest)) refuse();
  const unsigned = { schema: value.schema, installationId: value.installationId, version: value.version,
    manifestDigest: value.manifestDigest, topologyPlanDigest: value.topologyPlanDigest, simulatedStages: value.simulatedStages };
  if (value.planDigest !== digest(unsigned)) refuse();
  return Object.freeze({ ...unsigned, planDigest: value.planDigest });
}

async function readJournal(root, installationId) {
  const path = join(root, journalName(installationId));
  const entry = await lstat(path).catch(error => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || (entry.mode & 0o077) !== 0 || entry.size < 1 || entry.size > 16 * 1024
    || await realpath(path).catch(() => "") !== path) refuse("local_clean_install_acceptance_journal_unavailable");
  const bytes = await readFile(path);
  if (bytes.byteLength !== entry.size) refuse("local_clean_install_acceptance_journal_unavailable");
  return journalMaterial(JSON.parse(bytes.toString("utf8")));
}

function createJournal({ installationId, version, manifestDigest, topologyPlanDigest }) {
  const unsigned = { schema: JOURNAL_SCHEMA, installationId, version, manifestDigest, topologyPlanDigest,
    simulatedStages: [...stages] };
  return Object.freeze({ ...unsigned, planDigest: digest(unsigned) });
}

function simulatedServicePlan() {
  return Object.freeze({ action: "install", simulated: true, steps: Object.freeze([
    "verify_supervisor_readiness", "verify_release", "verify_service_definition", "install_service_definition",
    "start_service", "verify_service_health",
  ]), startsService: false, performsEffect: false, grantsAgentReadiness: false });
}

function parse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse();
  const raw = value;
  if (raw.ownerAttended !== true || (raw.mode !== "begin" && raw.mode !== "resume")
    || !exactKeys(raw, raw.mode === "begin"
      ? ["installRoot", "installationId", "journalRoot", "mode", "ownerAttended", "releaseDirectory", "topologyPlanDigest"]
      : ["expectedReleaseManifestDigest", "expectedReleaseVersion", "installRoot", "installationId", "journalRoot", "mode",
        "ownerAttended", "topologyPlanDigest"])
    || typeof raw.installationId !== "string" || !idPattern.test(raw.installationId)
    || typeof raw.topologyPlanDigest !== "string" || !digestPattern.test(raw.topologyPlanDigest)
    || (raw.mode === "resume" && (typeof raw.expectedReleaseVersion !== "string"
      || !versionPattern.test(raw.expectedReleaseVersion)
      || typeof raw.expectedReleaseManifestDigest !== "string"
      || !digestPattern.test(raw.expectedReleaseManifestDigest)))) refuse();
  const parsed = { ...raw, installRoot: absolute(raw.installRoot), journalRoot: absolute(raw.journalRoot),
    releaseDirectory: raw.releaseDirectory === undefined ? undefined : absolute(raw.releaseDirectory) };
  if ((parsed.mode === "begin") !== (parsed.releaseDirectory !== undefined)) refuse();
  return Object.freeze(parsed);
}

/**
 * Runs one source-only rehearsal phase. A caller must provide a bounded runner
 * (the shipped CLI uses `pnpm` from PATH). `begin` stages a release and writes
 * its durable simulated journal. `resume` is a separate-process-safe read of
 * that journal followed by an exact dependency receipt recheck.
 */
export async function runLocalCleanInstallRehearsalV1(value, { runner }) {
  const input = parse(value);
  if (typeof runner !== "function") refuse();
  const journalRoot = await privateDirectory(input.journalRoot);
  const installRoot = await privateDirectory(input.installRoot);
  let journal = await readJournal(journalRoot, input.installationId);
  if (input.mode === "begin") {
    if (journal) refuse("local_clean_install_acceptance_in_progress_or_replayed");
    const staged = await stageLocalReleaseV1({ ownerAttended: true, releaseDirectory: input.releaseDirectory, installRoot });
    if (staged.state !== "verified_release_staged" || staged.installsOrStartsService || staged.createsDatabase || staged.usesNetwork) refuse();
    const versionRoot = join(installRoot, "versions", staged.version);
    const manifestDigest = sha256(await readFile(join(versionRoot, "RELEASE_MANIFEST.json")));
    const prepared = await prepareLocalProductionDependenciesV1({ ownerAttended: true, installRoot, version: staged.version,
      expectedManifestDigest: manifestDigest }, { runner });
    if (prepared.state !== "production_dependencies_prepared" || prepared.installsOrStartsService || prepared.createsOrMigratesDatabase
      || prepared.startsWorkers || prepared.runsPackageScripts) refuse();
    journal = createJournal({ installationId: input.installationId, version: staged.version, manifestDigest,
      topologyPlanDigest: input.topologyPlanDigest });
    await durableCreate(join(journalRoot, journalName(input.installationId)), Buffer.from(`${JSON.stringify(journal)}\n`, "utf8"));
  } else {
    // Bind a reopen to the release the outer launcher has just verified. This
    // comparison must precede dependency preparation: otherwise an old
    // journal could make the package runner act on an older release before the
    // launcher notices the version mismatch in the returned report.
    if (!journal || journal.topologyPlanDigest !== input.topologyPlanDigest
      || journal.version !== input.expectedReleaseVersion
      || journal.manifestDigest !== input.expectedReleaseManifestDigest) {
      refuse("local_clean_install_acceptance_journal_unavailable");
    }
    const prepared = await prepareLocalProductionDependenciesV1({ ownerAttended: true, installRoot, version: journal.version,
      expectedManifestDigest: journal.manifestDigest }, { runner });
    if (!prepared.alreadyPrepared || prepared.installsOrStartsService || prepared.createsOrMigratesDatabase || prepared.startsWorkers) refuse();
  }
  const servicePlan = simulatedServicePlan();
  return Object.freeze({ schema: LOCAL_CLEAN_INSTALL_ACCEPTANCE_V1, state: input.mode === "begin"
    ? "source_only_rehearsal_begun" : "source_only_rehearsal_resumed", version: journal.version,
    releaseManifestDigest: journal.manifestDigest, simulatedStageCount: journal.simulatedStages.length,
    extractedReleaseVerified: true, dependenciesPrepared: true, journalResumed: input.mode === "resume",
    changedReleaseRefused: false, servicePlan, createsDatabase: false, startsService: false, startsWorker: false,
    mayUseNetworkForDependencies: true, networkUseControlledByPackageManager: true,
    launcherComplete: false, productionAcceptanceComplete: false });
}
