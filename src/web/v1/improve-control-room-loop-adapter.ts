import { captureLoopFinalizationCapabilityV1, type LoopFinalizationCapabilityV1 } from "./improve-control-room-loop-finalization";
import { createImproveControlRoomLoopMonitorV1, loopMonitoringStatusSchemaV1, unavailableLoopMonitoringV1,
  loopMonitoringClockV1, type LoopMonitoringStatusV1, type LoopMonitoringClockV1 } from "./improve-control-room-loop-monitoring";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { loopBridgeBindingSchemaV1, loopImprovementConfirmationSchemaV1, loopImprovementRunIdentitySchemaV1,
  type LoopBridgeBindingV1, type LoopBridgeOperationV1, type LoopImprovementContractV1 } from "../../improve-control-room/v1/schemas";
import { parseStrictJsonV1 } from "../../installer/shared/strict-json.mjs";
import { loopApprovalDescriptorSchemaV1, loopImprovementDecisionsSchemaV1, loopProgressSchemaV1, unavailableLoopGate,
  type LoopImprovementDecisionsV1 } from "./improve-control-room-loop-attention-wire";
import { canonicalJson, sha256Digest } from "../../security";

export const loopByteHashV1 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const scalar = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(180)]);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelopeSchema = z.object({ schema_version: z.literal(1), run: z.unknown(), state: z.string().min(1).max(64), revision,
  next: z.unknown(), attention: z.unknown(), steps: z.array(z.unknown()).max(1000),
  counters: z.record(z.string(), z.unknown()), error: z.unknown(), request: z.unknown().optional(),
  clock: z.enum(["ok", "uncertain"]).optional(),
  deadline: z.object({ attempt: z.string().min(1).max(180), started_at: z.string().min(1).max(180),
    due_at: z.string().min(1).max(180), state: z.enum(["pending", "exceeded"]),
    worker: z.enum(["live", "ended", "uncertain"]) }).strict().nullable().optional() }).strict()
  .refine(value => ["run", "next", "error"].every(key => Object.hasOwn(value, key)));
const seal = loopApprovalDescriptorSchemaV1;
const question = z.object({ questionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/), inputVersion: scalar,
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/), owner: z.boolean(), changesInput: z.boolean() }).strict();
/** Normalized by a reviewed decoder; no raw engine output crosses HTTP. */
export const loopEngineStatusSchemaV1 = z.object({
  run: loopImprovementRunIdentitySchemaV1, revision, inputVersion: scalar,
  state: z.enum(["draft", "ready", "running", "waiting", "stopped", "finished", "refused"]),
  description: z.string().min(1).max(8000), settingsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  settingsDigest: z.string().min(1).max(180), confirmation: loopImprovementConfirmationSchemaV1.nullable(),
  approval: seal.nullable(), question: question.nullable(),
  progress: loopProgressSchemaV1,
  // Positive command-specific evidence, decoded from A2's saved receipts/ledger.
  receipts: z.array(z.object({ commandId: z.string().regex(/^loop-command:[a-f0-9]{32}$/),
    bindingDigest: digest, state: z.enum(["accepted", "waiting", "refused"]), evidenceDigest: digest,
    error: z.enum(["REFUSED", "INELIGIBLE"]).nullable() }).strict()).max(100),
}).strict();
export type LoopEngineStatusV1 = z.infer<typeof loopEngineStatusSchemaV1> & { decisions?: LoopImprovementDecisionsV1; monitoring?: LoopMonitoringStatusV1 };
const recoveryId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/);
const commandIdentity = z.object({ commandId: z.string().regex(/^loop-command:[a-f0-9]{32}$/), bindingDigest: digest }).strict();
export const loopRecoveryBindingSchemaV1 = z.object({ schemaVersion: z.literal(1), tenantId: recoveryId, workspaceId: recoveryId,
  projectId: recoveryId, ownerIdentityId: recoveryId, requestId: recoveryId, runLinkId: recoveryId,
  localVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), authorizationId: recoveryId,
  startCommandId: commandIdentity.shape.commandId, startBindingDigest: digest, run: loopImprovementRunIdentitySchemaV1,
  inputVersion: scalar, requestSha256: z.string().regex(/^[a-f0-9]{64}$/), settingsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  settingsDigest: z.string().min(1).max(180), expectedRevision: revision, schemaDigest: digest, action: z.enum(["advance", "wait"]),
}).strict();
export type LoopRecoveryBindingV1 = z.infer<typeof loopRecoveryBindingSchemaV1>;
export const loopRecoveryObservationSchemaV1 = z.object({ schemaVersion: z.literal(1), run: loopImprovementRunIdentitySchemaV1,
  revision, mode: z.enum(["runnable", "waiting", "stopped", "terminal", "uncertain", "input_changed", "unavailable"]),
  action: z.enum(["advance", "wait"]).nullable(), driver: z.object({ state: z.enum(["none", "live", "ended", "uncertain"]),
    generation: z.string().regex(/^[a-f0-9]{32}$/).nullable(), evidenceDigest: digest }).strict(),
  receipt: loopEngineStatusSchemaV1.shape.receipts.element.nullable(), evidenceDigest: digest,
}).strict().refine(value => value.action === null || value.mode === "runnable" && ["none", "ended"].includes(value.driver.state));
export type LoopRecoveryObservationV1 = z.infer<typeof loopRecoveryObservationSchemaV1>;
export type LoopRecoveryChildV1 = { readonly pid: number;
  readonly done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; close(): Promise<void> };
export type LoopRecoveryClaimV1 = { kind: "started"; generation: string; child: LoopRecoveryChildV1 }
  | { kind: "busy" | "uncertain"; evidenceDigest: string };
export type LoopRecoveryCapabilityV1 = {
  enabled(): boolean;
  inspect(run: string, command?: { commandId: string; bindingDigest: string }): Promise<LoopRecoveryObservationV1>;
  /** Reviewed installation capability owns the cross-process fence and atomic A2
   * Stop/input/authority admission. The product never replaces that fence. */
  claimDriver(binding: Readonly<LoopRecoveryBindingV1>, spawn: () => Promise<LoopRecoveryChildV1>): Promise<LoopRecoveryClaimV1>;
};
export function captureLoopRecoveryCapabilityV1(value: LoopRecoveryCapabilityV1 | undefined) {
  if (!value) return undefined;
  if (typeof value.enabled !== "function" || typeof value.inspect !== "function" || typeof value.claimDriver !== "function"
    || Object.keys(value).some(key => !["enabled", "inspect", "claimDriver"].includes(key))) throw unavailable();
  return Object.freeze({ enabled: value.enabled.bind(value), inspect: value.inspect.bind(value), claimDriver: value.claimDriver.bind(value) });
}
// New intake claims seal the custody required by the report-only driver.
// Legacy command bindings remain readable, but cannot authorize this capability.
export const loopIntakeCustodySchemaV1 = z.object({ tenantId: recoveryId, workspaceId: recoveryId,
  projectId: recoveryId, requestId: recoveryId, ownerIdentityId: recoveryId,
  localVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), settingsDigest: z.string().min(1).max(180) }).strict();
export const loopOwnedIntakeBindingSchemaV1 = loopBridgeBindingSchemaV1.safeExtend(loopIntakeCustodySchemaV1.shape);
const intakeResultSchema = z.object({ launch_key: z.string().regex(/^[a-f0-9]{32}$/), step: z.number().int().positive(),
  job_id: z.string().min(1).max(240), ended: z.string().min(1).max(80).refine(v => Number.isFinite(Date.parse(v))),
  report_sha256: loopEngineStatusSchemaV1.shape.settingsSha256, proposal_sha256: loopEngineStatusSchemaV1.shape.settingsSha256,
  task_sha256: loopEngineStatusSchemaV1.shape.settingsSha256 }).strict();
export const loopIntakeDriverBindingSchemaV1 = loopIntakeCustodySchemaV1.extend({ schemaVersion: z.literal(1),
  runLinkId: recoveryId, run: loopImprovementRunIdentitySchemaV1, expectedRevision: revision, inputVersion: z.number().int().positive(),
  requestSha256: loopEngineStatusSchemaV1.shape.settingsSha256, settingsSha256: loopEngineStatusSchemaV1.shape.settingsSha256,
  intakeCommandId: commandIdentity.shape.commandId, intakeBinding: loopOwnedIntakeBindingSchemaV1,
  intakeBindingDigest: digest, completedResult: intakeResultSchema }).strict();
export type LoopIntakeDriverBindingV1 = z.infer<typeof loopIntakeDriverBindingSchemaV1>;
export const loopIntakeDriverReceiptSchemaV1 = z.object({ command_id: commandIdentity.shape.commandId, binding_digest: digest,
  completed_result: intakeResultSchema, intake_command_id: commandIdentity.shape.commandId, intake_binding: loopOwnedIntakeBindingSchemaV1,
  custody: loopIntakeCustodySchemaV1.extend({runLinkId:recoveryId}),
  request_sha256: loopEngineStatusSchemaV1.shape.settingsSha256, settings_sha256: loopEngineStatusSchemaV1.shape.settingsSha256,
  input_version: z.number().int().positive(), expected_revision: revision, revision,
  at: z.string().min(1).max(80).refine(v => Number.isFinite(Date.parse(v))),
  state: z.literal("waiting_owner"), attention: z.literal("REQUEST_UNCONFIRMED") }).strict();
export const loopIntakeDriverObservationSchemaV1 = z.object({ schemaVersion:z.literal(1),run:loopImprovementRunIdentitySchemaV1,
  revision,inputVersion:z.number().int().positive(),requestSha256:loopEngineStatusSchemaV1.shape.settingsSha256,
  settingsSha256:loopEngineStatusSchemaV1.shape.settingsSha256,mode:z.enum(["unavailable","completed","advanced"]),
  completedResult:intakeResultSchema.nullable(),receipt:loopIntakeDriverReceiptSchemaV1.nullable(),evidenceDigest:digest }).strict()
  .refine(v => v.mode === "completed" ? v.completedResult !== null && v.receipt === null
    : v.completedResult === null && (v.mode === "advanced" ? v.receipt !== null : v.receipt === null));
export type LoopIntakeDriverCapabilityV1 = {
  enabled():boolean;
  inspect(run:string):Promise<z.infer<typeof loopIntakeDriverObservationSchemaV1>>;
  /** Reviewed tools capability owns its bounded command, atomic consumption and saved replay receipt. */
  advance(binding:Readonly<LoopIntakeDriverBindingV1>):Promise<
    {kind:"advanced";receipt:z.infer<typeof loopIntakeDriverReceiptSchemaV1>;observation:z.infer<typeof loopIntakeDriverObservationSchemaV1>}
    | {kind:"refused"|"uncertain";evidenceDigest:string}>;
};
export function equalIntakeReceipt(b:LoopIntakeDriverBindingV1,r:z.infer<typeof loopIntakeDriverReceiptSchemaV1>) {
  const custody=loopIntakeCustodySchemaV1.parse({tenantId:b.tenantId,workspaceId:b.workspaceId,projectId:b.projectId,
    requestId:b.requestId,ownerIdentityId:b.ownerIdentityId,localVersion:b.localVersion,settingsDigest:b.settingsDigest});
  return r.revision===b.expectedRevision+1 && r.expected_revision===b.expectedRevision && r.input_version===b.inputVersion
    && r.request_sha256===b.requestSha256 && r.settings_sha256===b.settingsSha256 && r.intake_command_id===b.intakeCommandId
    && canonicalJson(r.intake_binding)===canonicalJson(b.intakeBinding) && canonicalJson(r.completed_result)===canonicalJson(b.completedResult)
    && canonicalJson(r.custody)===canonicalJson({...custody,runLinkId:b.runLinkId});
}
function captureIntakeDriver(value:LoopIntakeDriverCapabilityV1|undefined) {
  if (!value) return undefined;
  if (["enabled","inspect","advance"].some(k=>typeof value[k as keyof typeof value]!=="function")
    || Object.keys(value).some(k=>!["enabled","inspect","advance"].includes(k))) throw unavailable();
  return Object.freeze({enabled:value.enabled.bind(value),inspect:value.inspect.bind(value),advance:value.advance.bind(value)});
}
export type LoopAdapterContractV1 = {
  lineage: LoopImprovementContractV1; schemaDigest: string;
  recovery?: LoopRecoveryCapabilityV1;
  intakeDriver?: LoopIntakeDriverCapabilityV1;
  finalization?: LoopFinalizationCapabilityV1;
  /** Reviewed installation opt-in attests monitoring-safe, no-paid-work logins. */
  monitoring?: { enabled(): boolean; decodeStatus(raw: unknown, status: LoopEngineStatusV1): unknown };
  generateRunId(): string;
  decodeStatus(output: unknown): LoopEngineStatusV1;
  /** Server-only reviewed A2 pins. Omission makes owner decisions unavailable.
   * The engine decoder must accept null at this raw location and preserve other fields. */
  decisionProjection?: { questionTextPath: readonly string[];
    decodeGate(output: unknown, status: LoopEngineStatusV1): unknown };
  locateApprovalDocument?: (run: string, descriptor: NonNullable<LoopEngineStatusV1["approval"]>) => { report: string; sidecar: string };
  decodeApprovalSidecar?: (output: unknown) => NonNullable<LoopEngineStatusV1["approval"]>;
  /** Builds A2's lock-checked expectation from the exact cached observation.
   * No refresh or invocation belongs in this installation-owned callback. */
  admissionExpectation?: (binding: Readonly<LoopBridgeBindingV1>, context: Readonly<{
    operation: "intake" | "confirm" | "start" | "approve" | "answer"; commandId: string;
  }>) => unknown | Promise<unknown>;
  qualifiedOperations: readonly LoopBridgeOperationV1[];
};
export type LoopAdapterConfigurationV1 = {
  adapterId: string; interpreter: string; entrypoint: string; toolingManifest: string;
  interpreterSha256: string; entrypointSha256: string;
  runRoot: string; workRoot: string; configRoot: string; cwd: string;
  settingsFile: string; availabilityFile: string; toolingRevision: string;
  settingsSha256: string; availabilitySha256: string;
  executionIdentity: { uid: number; isolationEvidenceDigest: string };
  contract: LoopAdapterContractV1; timeoutMs?: number; monitoringClock?: LoopMonitoringClockV1;
};
export interface LoopAdapterV1 {
  readonly adapterId: string; readonly toolingRevision: string; readonly schemaDigest: string;
  readonly settingsText: string; readonly contract: LoopImprovementContractV1;
  readonly finalization?: LoopFinalizationCapabilityV1;
  readonly intakeDriver?: LoopIntakeDriverCapabilityV1;
  inspectRecovery?(run: string, command?: { commandId: string; bindingDigest: string }): Promise<LoopRecoveryObservationV1>;
  recover?(binding: LoopRecoveryBindingV1): Promise<LoopRecoveryClaimV1>;
  monitoringTick?(): void;
  reserveRun(): string; available(operation: LoopBridgeOperationV1): boolean;
  intake(commandId: string, binding: LoopBridgeBindingV1, text: string, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  confirmRequest(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  start(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  status(run: string): Promise<LoopEngineStatusV1>;
  readApprovalDocument?(run: string, descriptor: NonNullable<LoopEngineStatusV1["approval"]>): Promise<string>;
  stop(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  approve(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  answer(commandId: string, binding: LoopBridgeBindingV1, text: string, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  /** Called only after the command's durable result commits. */
  releaseCommandFiles?(commandId: string): Promise<void>;
  close(): Promise<void>;
}
export class LoopIntakeRefusalV1 extends Error {
  constructor(readonly commandId: string, readonly bindingDigest: string, readonly code: string,
    readonly evidenceDigest: string) { super("loop_intake_refused"); }
}
// A bounded reason commitment fits the existing signed outcome's evidence
// digest. It binds the reason to this exact command; raw A2 messages are neither
// persisted nor exposed. Unknown valid codes use the generic refusal reason.
export const loopIntakeRefusalReasonsV1 = Object.freeze({
  REPOSITORY_DIRTY: "The request could not be prepared because the repository has uncommitted changes. Commit or remove those changes before trying again.",
  REPOSITORY_DETACHED: "The request could not be prepared because the repository has a detached HEAD. Select a branch before trying again.",
  REPOSITORY_OPERATION: "The request could not be prepared because a merge, rebase or another Git operation is in progress. Finish or abort that operation before trying again.",
  REPOSITORY_BRANCH_CONFLICT: "The request could not be prepared because its working branch already exists with different history. Resolve that branch conflict before trying again.",
  REPOSITORY_PREPARATION: "The request could not be prepared because its repository working branch could not be set up. Check the project repository before trying again.",
  SETTINGS_REPOSITORY: "The request could not be prepared because the repository settings were refused. Check that the repository uses a working branch rather than main or detached HEAD.",
  SETTINGS: "The request could not be prepared because its settings were refused. Check the project settings.",
  REFUSED: "The request could not be prepared because the loop engine refused it. Check the repository and project settings.",
});
export function loopIntakeRefusalEvidenceV1(commandId: string, binding: LoopBridgeBindingV1, code: string) {
  const reason = Object.hasOwn(loopIntakeRefusalReasonsV1, code) ? code : "REFUSED";
  return sha256Digest({ kind: "loop-intake-refusal/v1", commandId, bindingDigest: sha256Digest(binding), reason });
}
const intakeRefusalEnvelopeSchema = z.object({ schema_version: z.literal(1), run: z.string().nullable(),
  state: z.null(), revision, next: z.null(), attention: z.unknown(), steps: z.array(z.unknown()).max(1000),
  counters: z.record(z.string(), z.unknown()), error: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,79}$/) }).passthrough(),
  request: z.null().optional(), clock: z.enum(["ok", "uncertain"]).optional(), deadline: z.null().optional() }).strict();
// A2 tests stale with Python truthiness; empty JSON lists and dictionaries
// are false there, even though JavaScript treats both as true.
function pythonJsonTruthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value !== null && typeof value === "object") return Object.keys(value).length > 0;
  return !!value;
}
const unavailable = () => new Error("loop_adapter_unavailable");
const credentialPath = /(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.aws|\.codex|\.hermes|auth\.json|credentials|tokens?)(?:[/\\]|$)/i;
function checkedPath(path: string, root?: string, directory = false) {
  if (!isAbsolute(path) || path !== resolve(path) || credentialPath.test(path)) throw unavailable();
  if (root && (path === root || relative(root, path).startsWith(`..${sep}`) || relative(root, path) === ".." || isAbsolute(relative(root, path))))
    throw unavailable();
  // Check every ancestor, including configured roots. realpath equality rejects aliases too.
  for (let part = path;; part = dirname(part)) {
    if (lstatSync(part).isSymbolicLink()) throw unavailable();
    if (part === dirname(part)) break;
  }
  const stat = lstatSync(path);
  if (realpathSync(path) !== path || (directory ? !stat.isDirectory() : !stat.isFile())) throw unavailable();
  return path;
}

/** Construction validates pins but never creates a file or process. All configuration
 * is installation-owned. There is no JSON/env fixture or executable override. */
export function createImproveControlRoomLoopAdapterV1(input: LoopAdapterConfigurationV1): LoopAdapterV1 {
  const c = { ...input, executionIdentity: { ...input.executionIdentity }, contract: Object.freeze({ ...input.contract,
    lineage: Object.freeze({ ...input.contract.lineage }), qualifiedOperations: Object.freeze([...input.contract.qualifiedOperations]) }) };
  const recovery = captureLoopRecoveryCapabilityV1(c.contract.recovery);
  const intakeCapability = captureIntakeDriver(c.contract.intakeDriver);
  const finalization = captureLoopFinalizationCapabilityV1(c.contract.finalization);
  const monitoring = c.contract.monitoring ? Object.freeze({ enabled: c.contract.monitoring.enabled.bind(c.contract.monitoring),
    decodeStatus: c.contract.monitoring.decodeStatus.bind(c.contract.monitoring) }) : undefined;
  if (monitoring) checkedPath(c.availabilityFile, c.configRoot);
  const monitoringEnabled = () => { try { return monitoring?.enabled() === true; } catch { return false; } };
  const clock = c.monitoringClock ?? loopMonitoringClockV1;
  let monitor: ReturnType<typeof createImproveControlRoomLoopMonitorV1> | undefined;
  const timeoutMs = c.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
    || !digest.safeParse(c.toolingRevision).success || !digest.safeParse(c.contract.schemaDigest).success
    || c.contract.lineage.toolingRevision !== c.toolingRevision
    || !digest.safeParse(c.executionIdentity.isolationEvidenceDigest).success
    || !Number.isSafeInteger(c.executionIdentity.uid) || c.executionIdentity.uid !== process.getuid?.()) throw unavailable();
  loopImprovementRunIdentitySchemaV1.parse({ adapterId: c.adapterId, loopRunId: "run:configuration",
    toolingRevision: c.toolingRevision, a2SchemaVersion: 1 });
  const validate = (health = true) => {
    const dynamicHealth = monitoringEnabled();
    const staticHealth = !monitoring || health && !dynamicHealth;
    if (process.getuid?.() !== c.executionIdentity.uid) throw unavailable();
    for (const path of [c.runRoot, c.workRoot, c.configRoot, c.cwd]) checkedPath(path, undefined, true);
    checkedPath(c.interpreter); checkedPath(c.entrypoint, c.configRoot); checkedPath(c.toolingManifest, c.configRoot);
    checkedPath(c.settingsFile, c.configRoot);
    if (staticHealth) checkedPath(c.availabilityFile, c.configRoot);
    if (loopByteHashV1(readFileSync(c.interpreter)) !== c.interpreterSha256
      || loopByteHashV1(readFileSync(c.entrypoint)) !== c.entrypointSha256
      || `sha256:${loopByteHashV1(readFileSync(c.toolingManifest))}` !== c.toolingRevision
      || loopByteHashV1(readFileSync(c.settingsFile)) !== c.settingsSha256
      || staticHealth && loopByteHashV1(readFileSync(c.availabilityFile)) !== c.availabilitySha256) throw unavailable();
    if (health && dynamicHealth) monitor?.assertAvailability();
  };
  validate();
  const settingsText = readFileSync(c.settingsFile, "utf8");
  const settings = parseStrictJsonV1(settingsText, { maxBytes: 65536 }) as { project?: { host_adapter?: unknown; repository?: unknown } };
  if (settings?.project?.host_adapter !== "local-loop") throw unavailable();
  let closing = false;
  const children = new Set<ChildProcess>(), pending = new Set<Promise<unknown>>();
  const activeCommands = new Set<string>();
  async function prepareRepository(run: string, commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void) {
    // Missing repository settings remain A2's validation responsibility. Only the
    // pinned local-loop repository is eligible for product branch preparation.
    if (settings.project?.repository === undefined) return;
    const refuse = (code: keyof typeof loopIntakeRefusalReasonsV1): never => {
      throw new LoopIntakeRefusalV1(commandId, sha256Digest(binding), code,
        loopIntakeRefusalEvidenceV1(commandId, binding, code));
    };
    const repository = settings.project.repository;
    if (typeof repository !== "string") return refuse("REPOSITORY_PREPARATION");
    try { checkedPath(repository, undefined, true); } catch { refuse("REPOSITORY_PREPARATION"); }
    const git = async (args: string[], allowed = [0]) => {
      if (closing) throw unavailable();
      beforeSpawn();
      const operation = new Promise<string>((fulfill, reject) => {
        const child = execFile("/usr/bin/git", ["-C", repository, "-c", "core.hooksPath=/dev/null",
          "-c", "core.fsmonitor=false", ...args], {
          env: { NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0" },
          timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 65536,
        }, (error, stdout) => {
          // Any porcelain entry proves dirtiness, including bounded output
          // returned when a large untracked tree exhausts maxBuffer.
          if (args[0] === "status" && stdout.length) fulfill("dirty");
          else if (error && (!allowed.includes(Number(error.code)) || error.killed || error.signal)) reject(unavailable());
          else fulfill(stdout.trim());
        });
        children.add(child); child.once("close", () => children.delete(child));
      });
      pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {});
      return operation;
    };
    try {
      if (await git(["rev-parse", "--show-toplevel"]) !== repository) refuse("REPOSITORY_PREPARATION");
      const branch = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]);
      if (!branch) refuse("REPOSITORY_DETACHED");
      const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
      for (const name of ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer", "BISECT_START"]) {
        try { lstatSync(join(gitDir, name)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        refuse("REPOSITORY_OPERATION");
      }
      if (await git(["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"])) refuse("REPOSITORY_DIRTY");
      if (!["main", "master", "trunk"].includes(branch)) return;
      // Match the tools' run-new convention (loop/cr.py, run_prepare): cook/loop-<run>.
      const workingBranch = `cook/loop-${run}`;
      await git(["check-ref-format", "--branch", workingBranch]);
      const existing = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${workingBranch}`], [0, 1]);
      if (existing && existing !== await git(["rev-parse", "--verify", "HEAD"])) refuse("REPOSITORY_BRANCH_CONFLICT");
      // Create from current HEAD so a commit during preflight stays checked out.
      // No reset, force or stash; Git refuses a branch held by another worktree.
      await git(["switch", "--quiet", "--no-guess", "--no-recurse-submodules",
        ...(existing ? [workingBranch] : ["-c", workingBranch])]);
      try {
        const head = await git(["rev-parse", "--verify", "HEAD"]);
        // Adoption must still match the compared commit on both branches. A
        // concurrent commit on the original branch must not leave it behind.
        const baseline = existing || head;
        if (head !== baseline
          || await git(["symbolic-ref", "--quiet", "--short", "HEAD"], [0, 1]) !== workingBranch
          || await git(["rev-parse", "--verify", `refs/heads/${workingBranch}`]) !== baseline
          || existing && await git(["rev-parse", "--verify", `refs/heads/${branch}`]) !== baseline) refuse("REPOSITORY_PREPARATION");
      } catch (error) {
        // Restore the original checkout without rewriting either branch's ref.
        if (existing) await git(["switch", "--quiet", "--no-guess", "--no-recurse-submodules", branch]);
        throw error;
      }
    } catch (error) {
      if (error instanceof LoopIntakeRefusalV1) throw error;
      refuse("REPOSITORY_PREPARATION");
    }
  }
  const runId = (run: string) => {
    const identity = loopImprovementRunIdentitySchemaV1.parse(c.contract.lineage.decodeRunIdentity({ adapterId: c.adapterId, loopRunId: run,
      toolingRevision: c.toolingRevision, a2SchemaVersion: 1 }));
    if (identity.loopRunId !== run || identity.adapterId !== c.adapterId || identity.toolingRevision !== c.toolingRevision
      || identity.a2SchemaVersion !== 1) throw unavailable();
    return run;
  };
  const decode = (output: string, run: string) => {
    const envelope = envelopeSchema.parse(parseStrictJsonV1(output, { maxBytes: 65536 }));
    const projection = c.contract.decisionProjection;
    if (projection) {
      const path = projection.questionTextPath;
      if (!path.length || path.some(part => !part || ["__proto__", "prototype", "constructor"].includes(part))) throw unavailable();
      let parent: unknown = envelope;
      for (const part of path.slice(0, -1)) parent = parent && typeof parent === "object" ? (parent as Record<string, unknown>)[part] : undefined;
      if (parent && typeof parent === "object") {
        const key = path.at(-1)!, text = (parent as Record<string, unknown>)[key];
        if (typeof text !== "string" || Buffer.byteLength(JSON.stringify(text), "utf8") > 12288)
          (parent as Record<string, unknown>)[key] = null;
      }
    }
    // The adapter closure owns this projection; decodeStatus still returns the unchanged engine schema.
    const status: LoopEngineStatusV1 = loopEngineStatusSchemaV1.parse(c.contract.decodeStatus(envelope));
    // A2 can retain state=running (and the reviewed decoder can report draft)
    // after a launch fails. Inspect only the latest non-stale step: an earlier
    // failed attempt must not turn a subsequent active attempt into a refusal.
    const step = envelope.steps.filter((value): value is Record<string, unknown> =>
      !!value && typeof value === "object" && !Array.isArray(value) && !pythonJsonTruthy((value as Record<string, unknown>).stale)).at(-1);
    const stepFailed = !["stopped", "finished"].includes(status.state) && step
      && typeof step.state === "string"
      && ["blocked", "failed", "error", "cancelled", "canceled", "timeout", "timed_out", "aborted"].includes(step.state);
    let failureMessage: string | undefined;
    if (stepFailed) {
      // Reuse the refusal path's allowlisted plain reasons. Raw detail may
      // contain paths, provider output or secrets; never interpolate it.
      const detail = typeof step.detail === "string" ? step.detail : "";
      const code = /^launch failed: ([A-Z][A-Z0-9_]{1,79})$/.exec(detail)?.[1];
      const firstPlanning = status.state === "draft" && status.progress.completed === 0;
      const prefix = firstPlanning ? "The first planning step could not start" : "The current improvement step could not complete";
      const reason = /^launch failed: (?:[A-Z][A-Z0-9_]* )?REFUSED:/.test(detail)
        ? "the launch checks rejected the request."
        : detail.startsWith("launch failed:") ? "the loop engine could not launch it."
          : "it stopped without a usable result. Ask the lead to check this step before retrying.";
      failureMessage = code && Object.hasOwn(loopIntakeRefusalReasonsV1, code)
        ? loopIntakeRefusalReasonsV1[code as keyof typeof loopIntakeRefusalReasonsV1].replace("The request could not be prepared", prefix)
        : `${prefix} because ${reason}`;
      status.state = "refused";
      status.progress = { ...status.progress, attention: "blocked" };
    }
    status.decisions = loopImprovementDecisionsSchemaV1.parse({ observedAt: new Date().toISOString(),
      gate: failureMessage ? { kind: "blocked", code: "UNAVAILABLE", message: failureMessage }
        : ["stopped", "finished"].includes(status.state) ? null : projection ? projection.decodeGate(envelope, status) : unavailableLoopGate() });
    if (status.run.loopRunId !== run || status.run.adapterId !== c.adapterId || status.run.toolingRevision !== c.toolingRevision)
      throw unavailable();
    if (monitoring) {
      try {
        status.monitoring = monitoringEnabled()
          ? loopMonitoringStatusSchemaV1.parse(monitoring.decodeStatus(envelope, structuredClone(status))) : undefined;
      } catch { status.monitoring = unavailableLoopMonitoringV1(); }
    }
    return status;
  };
  function execute(args: string[], run: string, beforeSpawn?: () => void,
    command?: { id: string; binding: LoopBridgeBindingV1 }): Promise<LoopEngineStatusV1> {
    if (closing) return Promise.reject(unavailable());
    validate(!["status", "stop"].includes(args[0]!)); runId(run);
    beforeSpawn?.();
    const operation = new Promise<LoopEngineStatusV1>((fulfill, reject) => {
      const child = spawn(c.interpreter, [c.entrypoint, ...args], { cwd: c.cwd, shell: false,
        // Positive allowlist: no inherited service or sibling credentials, no HOME/PATH.
        env: { NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child);
      const output: Buffer[] = [];
      let bytes = 0, failed = false, killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = () => { failed = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
      const timer = setTimeout(stop, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) stop(); else output.push(Buffer.from(chunk)); });
      child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) stop(); });
      child.on("error", () => { failed = true; });
      child.on("close", async code => {
        clearTimeout(timer); clearTimeout(killTimer); children.delete(child);
        if (failed || ![0, 2, 3].includes(code ?? -1)) { reject(unavailable()); return; }
        try {
          let text: string | undefined;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)); } catch { /* Status may recover a saved admission. */ }
          if (args[0] === "intake" && command && (code === 2 || code === 3) && text !== undefined) {
            let raw: unknown;
            try { raw = parseStrictJsonV1(text, { maxBytes: 65536 }); } catch { /* Leave malformed output to the existing status fallback. */ }
            const refusal = intakeRefusalEnvelopeSchema.safeParse(raw);
            if (refusal.success && (refusal.data.run === null || refusal.data.run === run)) {
              // Absence is positive evidence only after checking the owned root and
              // rejecting symlinks. Any other filesystem error stays uncertain.
              checkedPath(c.runRoot, undefined, true);
              let absent = false;
              try {
                checkedPath(join(c.runRoot, run), c.runRoot, true);
                lstatSync(join(c.runRoot, run, "run.json"));
              } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") absent = true; else throw error; }
              if (absent) throw new LoopIntakeRefusalV1(command.id, sha256Digest(command.binding), refusal.data.error.code,
                loopIntakeRefusalEvidenceV1(command.id, command.binding, refusal.data.error.code));
            }
          }
          let observed: LoopEngineStatusV1;
          try {
            if (text === undefined) throw unavailable();
            observed = decode(text, run);
          }
          catch {
            // A refusal may have no decodable state (for example a busy lock).
            // One independent status read can recover an already saved admission.
            if (!command || (code !== 2 && code !== 3)) throw unavailable();
            observed = await status(run);
          }
          if (code === 2 || code === 3) {
            if (!command) throw unavailable();
            // A saved matching admission survives a later engine refusal.
            if (!observed.receipts.some(saved => saved.commandId === command.id
              && saved.bindingDigest === sha256Digest(command.binding))) {
              const receipt: LoopEngineStatusV1["receipts"][number] = { commandId: command.id,
                bindingDigest: sha256Digest(command.binding), state: "refused",
                evidenceDigest: sha256Digest({ exitCode: code, status: observed }), error: code === 2 ? "REFUSED" : "INELIGIBLE" };
              observed.receipts = [receipt, ...observed.receipts.filter(saved => saved.commandId !== command.id)].slice(0, 100);
            }
          }
          fulfill(observed);
        } catch (error) { reject(error instanceof LoopIntakeRefusalV1 ? error : unavailable()); }
      });
    });
    pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  }
  const status = async (run: string) => (await execute(["status", runId(run), "--json"], run))!;
  async function readApprovalDocument(run: string, descriptor: NonNullable<LoopEngineStatusV1["approval"]>) {
    if (closing || !c.contract.locateApprovalDocument || !c.contract.decodeApprovalSidecar) throw unavailable();
    validate(false); runId(run);
    const expected = loopApprovalDescriptorSchemaV1.parse(descriptor);
    // A run is one directory, never a locator-supplied path or another run's name.
    if (run === "." || run === ".." || /[/\\]/u.test(run)) throw unavailable();
    const directory = checkedPath(join(c.runRoot, run), c.runRoot, true);
    const names = c.contract.locateApprovalDocument(run, expected);
    async function bounded(name: string, cap: number) {
      if (typeof name !== "string" || !name || isAbsolute(name) || name.split(/[/\\]/u).some(part => !part || part === "." || part === "..")
        || credentialPath.test(name)) throw unavailable();
      const path = checkedPath(resolve(directory, name), directory);
      const before = lstatSync(path);
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || before.dev !== opened.dev || before.ino !== opened.ino) throw unavailable();
        const bytes = Buffer.alloc(cap + 1); let count = 0;
        while (count < bytes.length) {
          const read = await handle.read(bytes, count, bytes.length - count, null);
          if (!read.bytesRead) break;
          count += read.bytesRead;
        }
        const after = await handle.stat();
        checkedPath(directory, c.runRoot, true); checkedPath(path, directory);
        const final = lstatSync(path);
        if (count > cap || opened.size !== count || after.dev !== final.dev || after.ino !== final.ino
          || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs || opened.ctimeMs !== after.ctimeMs) throw unavailable();
        return bytes.subarray(0, count);
      } finally { await handle.close(); }
    }
    const bytes = await bounded(names.report, 262144), sidecar = await bounded(names.sidecar, 65536);
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const decoded = loopApprovalDescriptorSchemaV1.parse(c.contract.decodeApprovalSidecar(parseStrictJsonV1(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(sidecar), { maxBytes: 65536 })));
    // B2b document binding: exact bytes and the complete current sealed descriptor.
    if (loopByteHashV1(bytes) !== expected.reportSha256 || JSON.stringify(decoded) !== JSON.stringify(expected)) throw unavailable();
    validate(false); checkedPath(directory, c.runRoot, true);
    return text;
  }
  async function commandFile(commandId: string, name: string, text: string) {
    validate();
    if (!/^loop-command:[a-f0-9]{32}$/.test(commandId)) throw unavailable();
    const directory = join(c.workRoot, commandId.replace(":", "-"));
    try { await mkdir(directory, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable(); }
    checkedPath(directory, c.workRoot, true);
    if ((lstatSync(directory).mode & 0o777) !== 0o700) throw unavailable();
    const path = join(directory, name);
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw unavailable();
      checkedPath(path, directory);
      if ((lstatSync(path).mode & 0o777) !== 0o600 || await readFile(path, "utf8") !== text) throw unavailable();
    }
    return path;
  }
  const available = (operation: LoopBridgeOperationV1) => {
    try { validate(operation !== "stop"); } catch { return false; }
    return !closing && c.contract.qualifiedOperations.includes(operation)
      && (operation === "stop" || typeof c.contract.admissionExpectation === "function");
  };
  async function invoke(operation: LoopBridgeOperationV1, commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void, text?: string) {
    if (!available(operation) || binding.adapterId !== c.adapterId || binding.toolingRevision !== c.toolingRevision
      || binding.schemaDigest !== c.contract.schemaDigest || operation !== "stop" && binding.settingsSha256 !== c.settingsSha256) throw unavailable();
    validate(operation !== "stop"); beforeSpawn();
    const run = runId(binding.loopRunId);
    const apply = async () => {
      let expectation: string | undefined;
      if (operation !== "stop") {
        const expected = await c.contract.admissionExpectation!(Object.freeze({ ...binding, body: Object.freeze({ ...binding.body }) }),
          Object.freeze({ operation, commandId }));
        beforeSpawn();
        expectation = await commandFile(commandId, "expect.json", canonicalJson(expected));
      }
      beforeSpawn();
      let args: string[];
      switch (operation) {
        case "intake": args = ["intake", run, "--source", await commandFile(commandId, "source.txt", text!), "--settings", c.settingsFile, "--availability", c.availabilityFile, "--json"]; break;
        case "confirm": args = ["confirm-request", run, "--sha256", binding.requestSha256, "--json"]; break;
        case "start": args = ["start", run, "--settings", c.settingsFile, "--availability", c.availabilityFile, "--json"]; break;
        case "stop": args = ["stop", run, "--json"]; break;
        case "approve": args = ["approve", run, binding.body.step as string, "--json"]; break;
        case "answer": args = ["answer", run, binding.body.questionId as string, "--input-version",
          String(binding.body.inputVersion), "--file", await commandFile(commandId, "answer.txt", text!), "--by", "owner", "--json"]; break;
      }
      if (expectation) args.push("--expect", expectation);
      if (operation === "intake") await prepareRepository(run, commandId, binding, beforeSpawn);
      return execute(args, run, beforeSpawn, { id: commandId, binding });
    };
    // A2 owns compare-and-admit under its mutation lock.
    if (activeCommands.has(commandId)) throw unavailable();
    activeCommands.add(commandId);
    try {
      return await apply();
    } finally { activeCommands.delete(commandId); }
  }
  const recoveryChildren = new Map<string, LoopRecoveryChildV1>();
  const acquisitions = new Set<string>();
  const recoveryEnabled = () => { try { return !closing && recovery?.enabled() === true; } catch { return false; } };
  async function inspectRecovery(run: string, command?: { commandId: string; bindingDigest: string }) {
    // Opt-in gates mutation; authorized status reads remain observational when disabled.
    if (closing || !recovery) throw unavailable();
    validate(); runId(run);
    const lookup = command === undefined ? undefined : commandIdentity.parse(command);
    const raw = await recovery!.inspect(run, lookup);
    if (Buffer.byteLength(JSON.stringify(raw), "utf8") > 65536) throw unavailable();
    const observation = loopRecoveryObservationSchemaV1.parse(raw);
    if (observation.run.loopRunId !== run || observation.run.adapterId !== c.adapterId || observation.run.toolingRevision !== c.toolingRevision
      || observation.receipt && (!lookup || observation.receipt.commandId !== lookup.commandId || observation.receipt.bindingDigest !== lookup.bindingDigest)) throw unavailable();
    return observation;
  }
  async function spawnRecovery(binding: LoopRecoveryBindingV1): Promise<LoopRecoveryChildV1> {
    if (!recoveryEnabled()) throw unavailable();
    validate(); runId(binding.run.loopRunId);
    const args = binding.action === "wait" ? ["wait", binding.run.loopRunId, "--chain", "--hours", "1"]
      : ["advance", binding.run.loopRunId, "--json"];
    const child = spawn(c.interpreter, [c.entrypoint, ...args], { cwd: c.cwd, shell: false,
      env: { NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let failed = false, bytes = 0, killTimer: ReturnType<typeof setTimeout> | undefined;
    const output: Buffer[] = [];
    const stop = () => { failed = true; child.kill("SIGTERM"); killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000); };
    const timer = setTimeout(stop, 3660000);
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) stop(); else if (binding.action === "advance") output.push(Buffer.from(chunk)); });
    child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) stop(); });
    child.on("error", () => { failed = true; });
    const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((fulfill, reject) => {
      child.once("close", (code, signal) => {
        clearTimeout(timer); clearTimeout(killTimer); children.delete(child);
        if (failed || signal || !(binding.action === "wait" ? [0, 4] : [0]).includes(code ?? -1)) { reject(unavailable()); return; }
        try {
          if (binding.action === "advance") decode(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)), binding.run.loopRunId);
        } catch { reject(unavailable()); return; }
        // Driver exit is never a receipt. Saved state is read independently.
        void status(binding.run.loopRunId).then(() => fulfill({ code, signal }), () => reject(unavailable()));
      });
    });
    // A closed driver is reaped even when its exit is uncertain. Never signal a model worker.
    const reaped = new Promise<void>(resolve => child.once("close", () => resolve()));
    let closePromise: Promise<void> | undefined;
    const tracked = Object.freeze({ pid: child.pid ?? 0, done,
      close: () => closePromise ??= (async () => { if (children.has(child)) stop(); await reaped; })() });
    pending.add(done); void done.finally(() => pending.delete(done)).catch(() => {});
    return tracked;
  }
  async function recover(raw: LoopRecoveryBindingV1): Promise<LoopRecoveryClaimV1> {
    if (!recoveryEnabled() || Buffer.byteLength(JSON.stringify(raw), "utf8") > 65536) throw unavailable();
    const binding = loopRecoveryBindingSchemaV1.parse(raw), run = binding.run.loopRunId;
    Object.freeze(binding.run); Object.freeze(binding);
    if (binding.run.adapterId !== c.adapterId || binding.run.toolingRevision !== c.toolingRevision
      || binding.schemaDigest !== c.contract.schemaDigest || binding.settingsSha256 !== c.settingsSha256) throw unavailable();
    if (acquisitions.has(run) || recoveryChildren.has(run)) return { kind: "busy", evidenceDigest: sha256Digest({ run, owned: true }) };
    acquisitions.add(run);
    let spawned: LoopRecoveryChildV1 | undefined, spawnPending: Promise<LoopRecoveryChildV1> | undefined, invoked = false, duplicate = false, claimOpen = true;
    const operation = (async () => {
      try {
        const observation = await inspectRecovery(run);
        if (observation.mode !== "runnable" || observation.action !== binding.action || observation.revision !== binding.expectedRevision
          || !["none", "ended"].includes(observation.driver.state)) return { kind: "uncertain" as const, evidenceDigest: observation.evidenceDigest };
        const outcome = await recovery!.claimDriver(Object.freeze(binding), async () => {
          if (invoked || !claimOpen) { duplicate = true; throw unavailable(); }
          invoked = true; spawnPending = spawnRecovery(binding); spawned = await spawnPending; return spawned;
        });
        claimOpen = false;
        if (spawnPending) spawned = await spawnPending;
        if (outcome.kind === "started") {
          if (duplicate || !spawned || outcome.child !== spawned || !Number.isSafeInteger(spawned.pid) || spawned.pid <= 0 || !/^[a-f0-9]{32}$/.test(outcome.generation)
            || Object.keys(outcome).some(key => !["kind", "generation", "child"].includes(key)) || !recoveryEnabled()) throw unavailable();
          recoveryChildren.set(run, spawned);
          void spawned.done.finally(() => { if (recoveryChildren.get(run) === spawned) recoveryChildren.delete(run); }).catch(() => {});
          return outcome;
        }
        if (spawned || !["busy", "uncertain"].includes(outcome.kind) || !digest.safeParse(outcome.evidenceDigest).success
          || Object.keys(outcome).some(key => !["kind", "evidenceDigest"].includes(key))) throw unavailable();
        return outcome;
      } catch {
        claimOpen = false;
        if (spawnPending) { try { spawned = await spawnPending; } catch { /* Spawn failed without an acquired handle. */ } }
        await spawned?.close(); throw unavailable();
      } finally { claimOpen = false; acquisitions.delete(run); }
    })();
    pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  }
  if (monitoring) monitor = createImproveControlRoomLoopMonitorV1({ availabilityFile: c.availabilityFile,
    bootstrapHash: c.availabilitySha256, binding: loopByteHashV1(JSON.stringify({adapterId:c.adapterId,toolingRevision:c.toolingRevision,
      interpreterSha256:c.interpreterSha256,entrypointSha256:c.entrypointSha256,availabilityFile:c.availabilityFile})), clock,
    enabled: () => recoveryEnabled() && monitoring.enabled() === true,
    collect: async (signal, onChild) => {
      if (closing || signal.aborted || !recoveryEnabled() || monitoring.enabled() !== true) throw unavailable();
      validate(false);
      const child = spawn(c.interpreter, [c.entrypoint, "logins", "--json"], { cwd: c.cwd, shell: false,
        env: { NODE_ENV: "production", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] });
      children.add(child);
      let bytes = 0, failed = false, exited = false, killTimer: ReturnType<typeof setTimeout> | undefined;
      const output: Buffer[] = [];
      const stop = () => { if (exited) return; failed = true; child.kill("SIGTERM");
        killTimer ??= clock.setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 1000); };
      const timer = clock.setTimeout(stop, 30000);
      signal.addEventListener("abort", stop, {once:true}); if (signal.aborted) stop();
      const custody = child.pid ? onChild(child.pid).catch(() => { stop(); }) : Promise.resolve().then(stop);
      return await new Promise<{bytes:Uint8Array;exitCode:number|null}>((fulfill,reject) => {
        child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if(bytes > 65536) stop(); else output.push(Buffer.from(chunk)); });
        child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.length; if(bytes > 65536) stop(); });
        child.once("error", () => { failed = true; });
        child.once("close", (code, killed) => {
          exited = true; children.delete(child); clock.clearTimeout(timer); clock.clearTimeout(killTimer);
          signal.removeEventListener("abort",stop);
          void custody.then(() => { if(failed || killed || signal.aborted) reject(unavailable());
            else fulfill({bytes:Buffer.concat(output),exitCode:code}); });
        });
      });
    } });
  const intakeEnabled = () => { try { return !closing && intakeCapability?.enabled() === true; } catch { return false; } };
  const intakeOperation = <T>(work:()=>Promise<T>) => {
    const operation=(async()=>{if(!intakeEnabled())throw unavailable();validate();return work();})();
    pending.add(operation);void operation.finally(()=>pending.delete(operation)).catch(()=>{});return operation;
  };
  const intakeDriver:LoopIntakeDriverCapabilityV1|undefined = intakeCapability ? Object.freeze({enabled:intakeEnabled,
    inspect:(run:string)=>intakeOperation(async()=>{
      runId(run);const raw=await intakeCapability.inspect(run);
      if(Buffer.byteLength(JSON.stringify(raw),"utf8")>65536)throw unavailable();
      const o=loopIntakeDriverObservationSchemaV1.parse(raw);
      if(o.run.loopRunId!==run||o.run.adapterId!==c.adapterId||o.run.toolingRevision!==c.toolingRevision)throw unavailable();
      return o;
    }),
    advance:(raw:Readonly<LoopIntakeDriverBindingV1>)=>intakeOperation(async()=>{
      const binding=loopIntakeDriverBindingSchemaV1.parse(raw);
      if(binding.run.adapterId!==c.adapterId||binding.run.toolingRevision!==c.toolingRevision
        ||binding.settingsSha256!==c.settingsSha256)throw unavailable();
      const result=await intakeCapability.advance(binding);
      if(Buffer.byteLength(JSON.stringify(result),"utf8")>65536)throw unavailable();
      if(result.kind!=="advanced"){
        if(!["refused","uncertain"].includes(result.kind)||!digest.safeParse(result.evidenceDigest).success)throw unavailable();
        return result;
      }
      const receipt=loopIntakeDriverReceiptSchemaV1.parse(result.receipt),observation=loopIntakeDriverObservationSchemaV1.parse(result.observation);
      if(receipt.binding_digest!==sha256Digest(binding)||receipt.command_id!==`loop-command:${sha256Digest(binding).slice(7,39)}`
        ||!equalIntakeReceipt(binding,receipt)||observation.mode!=="advanced"
        ||canonicalJson(observation.receipt)!==canonicalJson(receipt)||canonicalJson(observation.run)!==canonicalJson(binding.run))throw unavailable();
      return {kind:"advanced" as const,receipt,observation};
    })}) : undefined;
  let closePromise: Promise<void> | undefined;
  return Object.freeze({ adapterId: c.adapterId, toolingRevision: c.toolingRevision, schemaDigest: c.contract.schemaDigest,
    settingsText, contract: c.contract.lineage,
    reserveRun: () => runId(c.contract.generateRunId()), available,
    ...(recovery ? { inspectRecovery, recover } : {}),
    ...(finalization ? { finalization } : {}),
    ...(intakeDriver ? { intakeDriver } : {}),
    ...(monitor ? { monitoringTick: monitor.tick } : {}),
    intake: (id: string, b: LoopBridgeBindingV1, text: string, fence: () => void) => invoke("intake", id, b, fence, text),
    confirmRequest: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("confirm", id, b, fence),
    start: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("start", id, b, fence), status, readApprovalDocument,
    stop: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("stop", id, b, fence),
    approve: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("approve", id, b, fence),
    answer: (id: string, b: LoopBridgeBindingV1, text: string, fence: () => void) => invoke("answer", id, b, fence, text),
    releaseCommandFiles: async (commandId: string) => {
      validate();
      if (!/^loop-command:[a-f0-9]{32}$/.test(commandId) || activeCommands.has(commandId)) throw unavailable();
      activeCommands.add(commandId);
      try {
        const directory = join(c.workRoot, commandId.replace(":", "-"));
        try { checkedPath(directory, c.workRoot, true); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        await rm(directory, { recursive: true });
      } finally { activeCommands.delete(commandId); }
    },
    close: () => closePromise ??= (async () => {
      closing = true;
      await monitor?.close();
      for (const child of children) child.kill("SIGTERM");
      const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 1000);
      try { while (pending.size) await Promise.allSettled([...pending]); } finally { clearTimeout(timer); }
    })(),
  });
}
