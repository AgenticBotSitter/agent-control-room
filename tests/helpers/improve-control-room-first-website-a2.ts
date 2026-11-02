// F03-0 only: inert loader and read-only proof projection. No intake or jobs.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { parseStrictJsonV1 } from "../../src/installer/shared/strict-json.mjs";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1, loopImprovementRunLinkSchemaV1,
  type LoopImprovementContractV1 } from "../../src/improve-control-room/v1/schemas";
import { createImproveControlRoomLoopAdapterV1, type LoopAdapterConfigurationV1,
  type LoopAdapterV1 } from "../../src/web/v1/improve-control-room-loop-adapter";

import { B5RefusalV1 } from "./improve-control-room-first-website";

const exec = promisify(execFile);
export const b5RawHash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const refuse = (code: string): never => { throw new B5RefusalV1(code); };
const need: (condition: unknown, code: string) => asserts condition = (condition, code) => { if (!condition) refuse(code); };
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const revision = z.string().regex(/^[a-f0-9]{40}$/u);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const runName = /^[a-z0-9][a-z0-9-]{0,40}$/u;
const credential = /(?:^|[/\\])(?:\.env(?:\.[^/\\]*)?|\.codex|\.hermes|\.aws|\.ssh|auth\.json|tokens?|credentials?)(?:[/\\]|$)/iu;
const inside = (root: string, file: string) => { const r = relative(root, file); return r !== "" && r !== ".." && !r.startsWith(`..${sep}`) && !isAbsolute(r); };

async function canonical(path: string, root?: string, directory = false) {
  need(isAbsolute(path) && resolve(path) === path && !credential.test(path) && !/[\0\r\n]/u.test(path), "B5_A2_PATH");
  if (root) need(inside(root, path), "B5_A2_CONFINEMENT");
  for (let p = path; ; p = dirname(p)) {
    const s = await lstat(p);
    need(!s.isSymbolicLink(), "B5_A2_SYMLINK");
    if (dirname(p) === p) break;
  }
  const s = await lstat(path);
  need(await realpath(path) === path && (directory ? s.isDirectory() : s.isFile()), "B5_A2_REGULAR");
  need(!(s.mode & 0o022) && (!(root || directory) || s.uid === process.getuid?.()), "B5_A2_CUSTODY");
  return s;
}
async function bytes(file: string, root?: string, cap = 1 << 20) {
  const before = await canonical(file, root);
  need(before.size <= cap, "B5_A2_BYTE_CAP");
  const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = await fd.stat();
    need(s.isFile() && s.dev === before.dev && s.ino === before.ino, "B5_A2_CHANGED");
    // Bounded even if the file grows after stat.
    const buffer = Buffer.alloc(Math.min(cap, before.size) + 1);
    let length = 0;
    while (length < buffer.length) {
      const r = await fd.read(buffer, length, buffer.length - length, null);
      if (!r.bytesRead) break;
      length += r.bytesRead;
    }
    need(length <= cap && length === before.size, "B5_A2_BYTE_CAP");
    const after = await fd.stat(), named = await canonical(file, root);
    need(after.size === s.size && after.mtimeMs === s.mtimeMs && after.ctimeMs === s.ctimeMs
      && named.ino === s.ino && named.dev === s.dev, "B5_A2_CHANGED");
    return buffer.subarray(0, length);
  } finally { await fd.close(); }
}
async function json(file: string, root: string, cap = 65536): Promise<unknown> {
  const data = await bytes(file, root, cap);
  return parseStrictJsonV1(new TextDecoder("utf-8", { fatal: true }).decode(data), { maxBytes: cap });
}

export function b5LineageV1(toolingRevision: string): LoopImprovementContractV1 {
  digest.parse(toolingRevision);
  return {
    toolingRevision,
    decodeRunIdentity: value => loopImprovementRunIdentitySchemaV1.parse(value),
    decodeObservation: value => loopImprovementObservationSchemaV1.parse(value),
    matchesSavedInput: (run, observation, input) =>
      run.toolingRevision === toolingRevision && observation.confirmation.path === "docs/request-source.md"
      && observation.confirmation.sha256 === b5RawHash(input.description) && input.requestSha256 === b5RawHash(input.description)
      && observation.settingsDigest === b5RawHash(input.settingsText) && input.settingsSha256 === b5RawHash(input.settingsText),
  };
}

const carrierSchema = z.object({ modulePath: z.string(), moduleSha256: hash,
  configuration: z.object({ toolingRevision: digest, interpreter: z.string(), interpreterSha256: hash,
    toolingManifest: z.string(), settingsFile: z.string(), settingsSha256: hash,
    availabilityFile: z.string(), availabilitySha256: hash }).passthrough(), finalization: z.literal("cleanup"),
  recovery: z.literal(true), monitoring: z.literal(true), intakeDriver: z.literal(true), qualifiedOperations: z.array(z.string()),
}).strict();

/** Hash before import, then use the real tools loader and product adapter constructor.
 * Approved interpreter digest is independent input, never derived from the carrier.
 */
export async function loadB5A2V1(root: string, approvedPythonSha256: string) {
  await canonical(root, undefined, true);
  need(/^acr-b5-[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(root.slice(dirname(root).length + 1)), "B5_A2_ROOT");
  const carrierFile = join(root, "config/contract-cleanup.json");
  const carrier = carrierSchema.parse(await json(carrierFile, root));
  need(carrier.modulePath === join(root, "tools/loop/bridge/a2-contract.mjs"), "B5_A2_MODULE_PATH");
  need(b5RawHash(await bytes(carrier.modulePath, root)) === carrier.moduleSha256, "B5_A2_MODULE_PIN");
  const c = carrier.configuration;
  hash.parse(approvedPythonSha256);
  need(c.interpreterSha256 === approvedPythonSha256 && b5RawHash(await bytes(c.interpreter, undefined, 256 << 20)) === approvedPythonSha256, "B5_A2_INTERPRETER_PIN");
  for (const [file, expected] of [[c.settingsFile, c.settingsSha256], [c.availabilityFile, c.availabilitySha256],
    [c.toolingManifest, c.toolingRevision.slice(7)]] as const) {
    need(b5RawHash(await bytes(file, root)) === expected, "B5_A2_CONFIGURATION_PIN");
  }
  // The manifest is a binding to source bytes, not just a hash of an unchecked file.
  const manifest = new TextDecoder("utf-8", { fatal: true }).decode(await bytes(c.toolingManifest, root));
  const seen = new Set<string>();
  for (const line of manifest.trimEnd().split("\n")) {
    const match = /^([a-f0-9]{64})  ([^\r\n]+)$/u.exec(line);
    need(match && !seen.has(match[2]), "B5_A2_MANIFEST");
    seen.add(match[2]);
    need(!isAbsolute(match[2]) && match[2].split("/").every(part => part !== "" && part !== "." && part !== ".."), "B5_A2_MANIFEST");
    need(b5RawHash(await bytes(join(root, match[2]), root, 64 << 20)) === match[1], "B5_A2_MANIFEST_PIN");
  }
  const module = await import(pathToFileURL(carrier.modulePath).href);
  const lineage = b5LineageV1(c.toolingRevision);
  const loaded = await module.loadA2Carrier(carrierFile, { root, lineage });
  // This cast follows runtime shape checks and the real carrier validator.
  const configuration = loaded.configuration as LoopAdapterConfigurationV1;
  const contract = configuration.contract;
  need(contract.lineage === lineage && contract.lineage.toolingRevision === c.toolingRevision, "B5_A2_LINEAGE");
  need(contract.schemaDigest === module.A2_SCHEMA_DIGEST && digest.safeParse(contract.schemaDigest).success, "B5_A2_SCHEMA");
  for (const callable of [contract.generateRunId, contract.decodeStatus, contract.admissionExpectation,
    contract.locateApprovalDocument, contract.decodeApprovalSidecar, contract.decisionProjection?.decodeGate,
    contract.recovery?.enabled, contract.recovery?.inspect, contract.recovery?.claimDriver,
    contract.monitoring?.enabled, contract.monitoring?.decodeStatus,
    contract.intakeDriver?.enabled, contract.intakeDriver?.inspect, contract.intakeDriver?.advance,
    contract.finalization?.enabled, contract.finalization?.inspect, contract.finalization?.retain,
    contract.finalization?.cleanup, contract.finalization?.source.readVerifiedCompletion,
    contract.finalization?.repository.observe]) need(typeof callable === "function", "B5_A2_CALLABLE");
  need(contract.intakeDriver?.enabled() === true, "B5_A2_INTAKE_DRIVER");
  need(["intake", "confirm", "start", "stop", "approve", "answer"].every(op => carrier.qualifiedOperations.includes(op)), "B5_A2_OPERATIONS");
  const adapter = createImproveControlRoomLoopAdapterV1(configuration);
  need(adapter.intakeDriver?.enabled() === true, "B5_A2_INTAKE_DRIVER");
  // The adapter captures lineage into an immutable copy; it is not the outer contract.
  need(adapter.contract.toolingRevision === lineage.toolingRevision && adapter.schemaDigest === contract.schemaDigest, "B5_A2_ADAPTER");
  return { configuration, adapter, carrier, lineage };
}

const version = z.union([z.number().int().positive(), z.string().min(1).max(180)]);
const seal = z.object({ path: z.string(), sha256: hash }).passthrough();
const stepSchema = z.object({ n: z.number().int().positive(), role: z.string().min(1), model: z.string(),
  brief: z.string(), log: z.string(), input_version: version, head_at_start: z.string(),
  started_epoch: z.number().nonnegative(), model_identity: z.unknown().optional(),
  report_snapshot: seal.optional(), sidecar_seals: z.array(seal).max(32).optional(),
}).passthrough();
const rawRunSchema = z.object({ run: z.string(), work: z.string(), clone: z.string(), base_sha: z.string(),
  input_version: version, steps: z.array(stepSchema).max(1000),
  chain: z.object({ revision: z.number().int().nonnegative(), settings_source_sha256: hash,
    consumed_results: z.array(z.object({ step: z.number().int(), job_id: z.string(), sha256: hash, verdict: z.string() }).passthrough()).max(1000).optional(),
    rejections: z.array(z.number().int()).max(1000).optional(),
    inputs: z.object({ entries: z.object({ candidate: z.object({ head: revision }).passthrough().optional() }).passthrough() }).passthrough().optional(),
  }).passthrough(), close: z.unknown().optional(),
}).passthrough();
const emittedSchema = z.object({ run: z.string(), revision: z.number().int().nonnegative(),
  steps: z.array(z.object({ n: z.number().int(), role: z.string(), stale: z.unknown(), state: z.string() }).passthrough()).max(1000),
}).passthrough();
const utc = (value: unknown) => {
  if (typeof value === "number") { need(Number.isFinite(value), "B5_A2_TIME"); return new Date(value * 1000).toISOString(); }
  need(typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/u.test(value) && Number.isFinite(Date.parse(value)), "B5_A2_TIME");
  return new Date(value).toISOString();
};

/** Fixture evidence until independently qualified against isolated real intake.
 * Reads authoritative `work`, never guessed workDir/rejectedHead fields. Later
 * phase facts remain absent unless their joins have been produced and verified.
 */
export async function projectB5RunV1(input: {
  root: string; runId: string; toolingRevision: string; baseline: string;
  adapter: Pick<LoopAdapterV1, "status" | "contract">;
  runLink: z.infer<typeof loopImprovementRunLinkSchemaV1>;
  saved: { requestId: string; runLinkId: string; localVersion: number; inputVersion: string | number;
    description: string; settingsText: string; requestSha256: string; settingsSha256: string };
  readChainStatus(): Promise<unknown>;
}) {
  need(runName.test(input.runId), "B5_A2_RUN_ID");
  revision.parse(input.baseline);
  digest.parse(input.toolingRevision);
  need(input.adapter.contract.toolingRevision === input.toolingRevision, "B5_A2_LINEAGE");
  need(input.saved.requestId && input.saved.runLinkId && Number.isSafeInteger(input.saved.localVersion) && input.saved.localVersion > 0, "B5_A2_SAVED_LINK");
  const link = loopImprovementRunLinkSchemaV1.parse(input.runLink);
  need(link.requestId === input.saved.requestId && link.run.loopRunId === input.runId
    && link.run.toolingRevision === input.toolingRevision && link.initialInputVersion <= input.saved.localVersion, "B5_A2_SAVED_LINK");
  const file = join(input.root, "runs", input.runId, "run.json");
  const before = await bytes(file, input.root);
  const raw = rawRunSchema.parse(parseStrictJsonV1(new TextDecoder("utf-8", { fatal: true }).decode(before)));
  const status = await input.adapter.status(input.runId);
  const emitted = emittedSchema.parse(await input.readChainStatus());
  for (const step of raw.steps) need(inside(raw.work, step.brief), "B5_A2_BRIEF_PATH");
  need(emitted.steps.length === raw.steps.length, "B5_A2_STEP_JOIN");
  need(raw.run === input.runId && emitted.run === raw.run && status.run.loopRunId === raw.run
    && status.run.toolingRevision === input.toolingRevision && status.run.adapterId === "adapter:a2-local"
    && status.run.a2SchemaVersion === 1 && link.run.adapterId === status.run.adapterId && link.run.a2SchemaVersion === status.run.a2SchemaVersion, "B5_A2_RUN_JOIN");
  need(raw.chain.revision === status.revision && emitted.revision === status.revision, "B5_A2_REVISION");
  need(raw.input_version === status.inputVersion && raw.input_version === input.saved.inputVersion
    && raw.chain.settings_source_sha256 === input.saved.settingsSha256 && status.settingsSha256 === input.saved.settingsSha256
    && status.description === input.saved.description, "B5_A2_INPUT_VERSION");
  need(raw.work === join(input.root, "lead/reports/loop", input.runId), "B5_A2_WORK_PATH");
  const descriptionFile = join(raw.work, "docs/request-source.md");
  const request = await bytes(descriptionFile, input.root);
  need(b5RawHash(request) === input.saved.requestSha256 && b5RawHash(input.saved.description) === input.saved.requestSha256
    && b5RawHash(input.saved.settingsText) === input.saved.settingsSha256, "B5_A2_INPUT_HASH");
  // Draft has no owner confirmation; do not invent it for the lineage predicate.
  if (status.confirmation) need(input.adapter.contract.matchesSavedInput(status.run, {
    inputVersion: status.inputVersion, revision: status.revision, settingsDigest: status.settingsDigest,
    confirmation: status.confirmation }, input.saved) === true, "B5_A2_SAVED_INPUT");
  need(raw.work === join(input.root, "lead/reports/loop", input.runId), "B5_A2_WORK_PATH");
  await canonical(raw.work, input.root, true);
  need(raw.clone === raw.work || raw.clone === join(input.root, "work/repo"), "B5_A2_REPOSITORY_PATH");
  await canonical(raw.clone, input.root, true);
  if (raw.base_sha) need(raw.base_sha === input.baseline, "B5_A2_BASE");
  const consumed = raw.chain.consumed_results ?? [];
  need(raw.steps.every((step, index) => index === 0 || step.n > raw.steps[index - 1].n)
    && new Set(raw.steps.map(s => s.n)).size === raw.steps.length
    && new Set(consumed.map(s => s.step)).size === consumed.length, "B5_A2_STEP_JOIN");
  const steps = [];
  const ledgerFile = join(input.root, "lead/state/jobs.tsv");
  // No ledger is needed for the initial, zero-step draft.
  const ledgerText = raw.steps.length ? new TextDecoder("utf-8", { fatal: true }).decode(await bytes(ledgerFile, input.root)) : "";
  const [header, ...lines] = ledgerText.trimEnd().split("\n");
  const keys = header.split("\t");
  for (const step of raw.steps) {
    need(inside(raw.work, step.brief), "B5_A2_BRIEF_PATH");
    const brief = new TextDecoder("utf-8", { fatal: true }).decode(await bytes(step.brief, raw.work));
    const shown = emitted.steps.filter(s => s.n === step.n);
    need(shown.length === 1 && shown[0].role === step.role, "B5_A2_STEP_JOIN");
    const result = consumed.find(r => r.step === step.n);
    const ledger = lines.map(line => Object.fromEntries(line.split("\t").map((v, i) => [keys[i], v])))
      .filter(row => row.log === step.log);
    // The append-only ledger repeats launch identity at Start/End. Validate
    // every event for this log before selecting the latest lifecycle state;
    // filtering by consumed job ID first would hide conflicting launches.
    const launchKeys = keys.filter(key => !["state", "ended", "exit_code", "exit", "rc"].includes(key));
    need(ledger.every(event => event.id && launchKeys.every(key => event[key] === ledger[0][key]))
      && (!result || ledger.length > 0 && ledger[0].id === result.job_id), "B5_A2_LEDGER_JOIN");
    const row = ledger.at(-1);
    let verdict: string | null = null;
    const sidecarHashes: string[] = [];
    let findings: unknown[] | null = null;
    if (result && step.report_snapshot && step.sidecar_seals?.length) {
      need(row && row.state === "ENDED" && step.report_snapshot.job_id === result.job_id
        && step.report_snapshot.ended === row.ended, "B5_A2_LEDGER_JOIN");
      need(result.sha256 === step.report_snapshot.sha256 && inside(raw.work, step.report_snapshot.path)
        && b5RawHash(await bytes(step.report_snapshot.path, raw.work)) === result.sha256, "B5_A2_REPORT_PIN");
      for (const sidecar of step.sidecar_seals) {
        need(inside(raw.work, sidecar.path) && b5RawHash(await bytes(sidecar.path, raw.work)) === sidecar.sha256, "B5_A2_SIDECAR_PIN");
        sidecarHashes.push(sidecar.sha256);
      }
      // This is the engine's consumed verdict, backed by its sealed evidence.
      verdict = result.verdict;
      if (step.findings !== undefined) findings = z.array(z.object({ id: z.string(), severity: z.enum(["HIGH", "MEDIUM", "LOW"]),
        disposition: z.string() }).passthrough()).max(100).parse(step.findings);
    }
    const startedAt = utc(step.started_epoch), endedAt = row?.ended ? utc(row.ended) : null;
    if (endedAt) need(Date.parse(endedAt) >= Date.parse(startedAt), "B5_A2_TIME");
    steps.push({ n: step.n, role: step.role, inputVersion: step.input_version, headAtStart: step.head_at_start,
      requestedModel: step.model, modelIdentity: step.model_identity ?? null, providerIdentityVerified: false as const,
      brief, stale: shown[0].stale, state: shown[0].state, verdict, findings, sidecarHashes, startedAt, endedAt });
  }
  const rejectedHeads: string[] = [];
  for (const n of raw.chain.rejections ?? []) {
    const index = raw.steps.findIndex(s => s.n === n), review = raw.steps[index];
    need(review && review.role === "code-review" && steps[index].verdict === "NEEDS-FIX", "B5_A2_REJECTION_JOIN");
    const build = raw.steps.slice(0, index).reverse().find(s => s.role === "build");
    need(build && build.input_version === review.input_version && review.input_version === raw.input_version, "B5_A2_REJECTION_JOIN");
    rejectedHeads.push(revision.parse(review.head_at_start));
  }
  // Final head and cleanup need typed finalization/cold-card/actual-Git joins in
  // later slices. Raw candidate/close fields alone are never certified here.
  const afterStatus = await input.adapter.status(input.runId);
  need(JSON.stringify(afterStatus.run) === JSON.stringify(status.run) && afterStatus.revision === status.revision && afterStatus.inputVersion === status.inputVersion
    && b5RawHash(await bytes(file, input.root)) === b5RawHash(before), "B5_A2_CHANGED");
  return { evidence: "fixture-until-intake-qualified" as const, requestId: input.saved.requestId, runLinkId: input.saved.runLinkId,
    localVersion: input.saved.localVersion, inputVersion: raw.input_version, engineRevision: status.revision,
    workDir: raw.work, repository: raw.clone, base: raw.base_sha || null, steps, rejectedHeads,
    candidateHeadUnverified: raw.chain.inputs?.entries.candidate?.head ?? null,
    finalHead: null, cleanup: null, requiresLaterPhaseEvidence: true as const };
}

/** Resolve the existing configured interpreter before each carrier child use. */
async function checkedEntry(root: string, approved: string, configuration: LoopAdapterConfigurationV1, args: string[]) {
  const resolver = await exec("/bin/sh", ["-c", '. "$1" || exit; "$CR_PYTHON" -I -B -c \'import os,sys; print(os.path.realpath(sys.executable))\'',
    "b5-python", join(root, "tools/bin/lib/python.sh")], { env: { NODE_ENV: "test", PATH: "/usr/bin:/bin" }, timeout: 30_000, maxBuffer: 65536 });
  need(resolver.stdout.trim() === configuration.interpreter && b5RawHash(await bytes(configuration.interpreter, undefined, 256 << 20)) === approved, "B5_A2_INTERPRETER_PIN");
  need(b5RawHash(await bytes(configuration.entrypoint, root)) === configuration.entrypointSha256
    && `sha256:${b5RawHash(await bytes(configuration.toolingManifest, root))}` === configuration.toolingRevision, "B5_A2_CONFIGURATION_PIN");
  return exec(configuration.interpreter, ["-I", "-B", configuration.entrypoint, ...args], {
    cwd: configuration.cwd, env: { NODE_ENV: "test", PATH: "/usr/bin:/bin", HOME: join(root, "home-work"), TMPDIR: join(root, "tmp"), TZ: "UTC" },
    timeout: 60_000, maxBuffer: 1 << 20 });
}

/** Actual chain_emit reader for a separately qualified run; status only. No
 * intake, Start or launcher dispatch. The loader rechecks all fixed pins first.
 */
export async function readB5ChainStatusV1(root: string, approved: string, runId: string) {
  need(runName.test(runId), "B5_A2_RUN_ID");
  const { adapter, configuration } = await loadB5A2V1(root, approved);
  try {
    const result = await checkedEntry(root, approved, configuration, ["status", runId, "--json"]);
    return emittedSchema.parse(parseStrictJsonV1(result.stdout, { maxBytes: 1 << 20 }));
  } finally { await adapter.close(); }
}

/** Only explicit calls spawn; imports are inert. */
async function qualify(root: string, approved: string) {
  const { adapter, configuration } = await loadB5A2V1(root, approved);
  try {
    const result = await checkedEntry(root, approved, configuration, ["bind-input", "--help"]);
    need(/bind-input/u.test(result.stdout), "B5_A2_BIND_HELP");
    console.log("RESULT: PASS B5 real carrier loader, schemas, callables and bind-input help (assembly only)");
  } finally { await adapter.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== "--qualify" || process.argv.length !== 5) throw new Error("B5_A2_QUALIFICATION_ARGUMENTS");
  await qualify(process.argv[3], process.argv[4]);
}


import { loopCandidateCardSchemaV1, loopCandidateEvidenceSchemaV1 } from "../../src/improve-control-room/v1/loop-candidate-wire";
import { verifyFinalizationRecordV1, type LoopFinalizationCapabilityV1,
  type LoopFinalizationTargetV1 } from "../../src/web/v1/improve-control-room-loop-finalization";
import { canonicalJson, sha256Digest } from "../../src/security";

/** Optional later-state read-only join. This never calls retain/cleanup or starts
 * a service: its ports must be the loaded capability and an actual cold service
 * read. Merely parsing a saved manifest/card does not qualify those ports.
 */
export async function joinB5FinalProjectionV1(input: Parameters<typeof projectB5RunV1>[0] & {
  finalization?: Pick<LoopFinalizationCapabilityV1, "readRecord" | "source" | "repository">;
  target?: LoopFinalizationTargetV1;
  readColdCard?: () => Promise<unknown>;
}) {
  need(input.finalization && input.target && input.readColdCard, "B5_A2_LATER_PHASE_EVIDENCE_REQUIRED");
  const { finalization, target, readColdCard } = input;
  need(finalization.source.toolingRevision === input.toolingRevision && finalization.source.schemaDigest === target.schemaDigest, "B5_A2_LINEAGE");
  const projection = await projectB5RunV1(input);
  const file = join(input.root, "runs", input.runId, "run.json"), before = await bytes(file, input.root);
  const raw = rawRunSchema.parse(parseStrictJsonV1(new TextDecoder("utf-8", { fatal: true }).decode(before)));
  const b = target;
  need(b.run.loopRunId === input.runId && b.run.toolingRevision === input.toolingRevision
    && b.requestId === input.saved.requestId && b.runLinkId === input.saved.runLinkId && b.localVersion === input.saved.localVersion
    && b.inputVersion === projection.inputVersion && b.expectedRevision === projection.engineRevision
    && b.requestSha256 === input.saved.requestSha256 && b.settingsSha256 === input.saved.settingsSha256, "B5_A2_COMPLETION_JOIN");
  const record = verifyFinalizationRecordV1(await finalization.readRecord(target), target);
  need(record.phase === "cleanup" && record.cleanup?.state === "complete" && record.custody
    && record.publication && record.observation.outcome === "candidate_ready", "B5_A2_CLEANUP_REQUIRED");
  const evidence = loopCandidateEvidenceSchemaV1.parse(await finalization.source.readVerifiedCompletion(input.saved.runLinkId));
  const binding = evidence.binding;
  need(binding.projectId === input.runLink.projectId && binding.requestId === b.requestId && binding.runLinkId === b.runLinkId
    && binding.localVersion === b.localVersion && binding.a2InputVersion === b.inputVersion && binding.engineRevision === b.expectedRevision
    && binding.adapterId === b.run.adapterId && binding.loopRunId === b.run.loopRunId && binding.toolingRevision === b.run.toolingRevision
    && binding.requestSha256 === b.requestSha256 && binding.settingsSha256 === b.settingsSha256
    && binding.baseRevision === input.baseline && binding.candidateRevision === raw.chain.inputs?.entries.candidate?.head
    && evidence.completionDigest === record.observation.completionDigest && evidence.retentionDigest === record.custody.retentionDigest,
  "B5_A2_COMPLETION_JOIN");
  const card = loopCandidateCardSchemaV1.parse(await readColdCard());
  need(canonicalJson(card.evidence) === canonicalJson(evidence) && card.freshness === "current"
    && card.candidateId === record.publication.candidate.candidateId && card.recordDigest === record.publication.candidate.recordDigest,
  "B5_A2_COLD_CARD_JOIN");
  const repository = await finalization.repository.observe({ runLinkId: b.runLinkId });
  need(repository.baseRevision === input.baseline && repository.candidateRevision === binding.candidateRevision, "B5_A2_GIT_HEAD_JOIN");
  const retained = join(input.root, "runs", input.runId, "finalization/retained", record.observation.inventoryDigest.slice(7));
  await canonical(retained, input.root, true);
  need(`sha256:${b5RawHash(await bytes(join(retained, "SEALED.json"), input.root))}` === record.custody.retentionDigest, "B5_A2_RETENTION_PIN");
  const close = z.object({ state: z.literal("closed"), local: z.literal(true), clone_kept: z.string(), head: revision,
    moves: z.array(z.object({ source: z.string(), destination: z.string(), sha256: hash.nullable().optional(), state: z.literal("done") }).passthrough()).max(1000),
  }).passthrough().parse(raw.close);
  need(close.clone_kept === projection.repository && close.head === binding.candidateRevision, "B5_A2_CLOSE_JOIN");
  const targets = close.moves.map(m => ({ source: m.source, destination: m.destination, sha256: m.sha256 ?? null, state: m.state }));
  need(sha256Digest(targets) === record.cleanup.removedDigest, "B5_A2_CLEANUP_DIGEST");
  for (const move of targets) {
    need(inside(input.root, move.source) && move.source !== projection.repository && resolve(move.source) === move.source,
      "B5_A2_CLEANUP_TARGET");
    need([join(input.root, ".cr-trash"), join(input.root, "home-work/.cr-trash")].some(trash => inside(trash, move.destination)),
      "B5_A2_CLEANUP_TARGET");
    for (let p = dirname(move.source); ; p = dirname(p)) {
      need(!(await lstat(p)).isSymbolicLink(), "B5_A2_CLEANUP_TARGET");
      if (p === dirname(p)) break;
    }
    const source = await lstat(move.source).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    need(source === null, "B5_A2_CLEANUP_SOURCE_PRESENT");
    const destination = await lstat(move.destination);
    await canonical(move.destination, input.root, destination.isDirectory());
  }
  await canonical(projection.repository, input.root, true); // local close keeps adopted repo
  const finalRepository = await finalization.repository.observe({ runLinkId: b.runLinkId });
  need(finalRepository.candidateRevision === binding.candidateRevision && b5RawHash(await bytes(file, input.root)) === b5RawHash(before), "B5_A2_CHANGED");
  return { ...projection, finalHead: binding.candidateRevision,
    cleanup: { state: record.cleanup.state, removedDigest: record.cleanup.removedDigest, targets, retained },
    requiresLaterPhaseEvidence: false as const, evidence: "read-only-completion-joins" as const };
}

export function requireB5FinalProjectionV1(value: Awaited<ReturnType<typeof projectB5RunV1>> | Awaited<ReturnType<typeof joinB5FinalProjectionV1>>) {
  need(!value.requiresLaterPhaseEvidence && value.finalHead && value.cleanup?.state === "complete", "B5_A2_LATER_PHASE_EVIDENCE_REQUIRED");
  return value;
}
