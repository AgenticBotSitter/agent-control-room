import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { loopImprovementConfirmationSchemaV1, loopImprovementRunIdentitySchemaV1,
  type LoopBridgeBindingV1, type LoopBridgeOperationV1, type LoopImprovementContractV1 } from "../../improve-control-room/v1/schemas";
import { parseStrictJsonV1 } from "../../installer/shared/strict-json.mjs";

export const loopByteHashV1 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const scalar = z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.string().min(1).max(180)]);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const envelopeSchema = z.object({ schema_version: z.literal(1), run: z.unknown(), state: z.string().min(1).max(64), revision,
  next: z.unknown(), attention: z.array(z.unknown()).max(100), steps: z.array(z.unknown()).max(1000),
  counters: z.record(z.string(), z.unknown()), error: z.unknown() }).strict()
  .refine(value => ["run", "next", "error"].every(key => Object.hasOwn(value, key)));
const seal = z.object({ step: z.enum(["plan", "spec"]), inputVersion: scalar,
  head: z.string().regex(/^[a-f0-9]{40}$/), reportSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const question = z.object({ questionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/), inputVersion: scalar,
  reportSha256: z.string().regex(/^[a-f0-9]{64}$/), owner: z.boolean(), changesInput: z.boolean() }).strict();
/** Normalized by a reviewed decoder; no raw engine output crosses HTTP. */
export const loopEngineStatusSchemaV1 = z.object({
  run: loopImprovementRunIdentitySchemaV1, revision, inputVersion: scalar,
  state: z.enum(["draft", "ready", "running", "waiting", "stopped", "finished", "refused"]),
  description: z.string().min(1).max(8000), settingsSha256: z.string().regex(/^[a-f0-9]{64}$/),
  settingsDigest: z.string().min(1).max(180), confirmation: loopImprovementConfirmationSchemaV1.nullable(),
  approval: seal.nullable(), question: question.nullable(),
  progress: z.object({ step: z.enum(["intake", "plan", "spec", "build", "review", "final"]).nullable(),
    completed: z.number().int().nonnegative().max(100000), attention: z.enum(["none", "owner", "blocked"]) }).strict(),
  // Positive command-specific evidence, decoded from A2's saved receipts/ledger.
  receipts: z.array(z.object({ commandId: z.string().regex(/^loop-command:[a-f0-9]{32}$/),
    bindingDigest: digest, state: z.enum(["accepted", "waiting", "refused"]), evidenceDigest: digest,
    error: z.enum(["REFUSED", "INELIGIBLE"]).nullable() }).strict()).max(100),
}).strict();
export type LoopEngineStatusV1 = z.infer<typeof loopEngineStatusSchemaV1>;
export type LoopAdapterContractV1 = {
  lineage: LoopImprovementContractV1; schemaDigest: string;
  generateRunId(): string;
  decodeStatus(output: unknown): LoopEngineStatusV1;
  /** I2: supplied only by the reviewed A2 integration. It holds A2's mutation
   * lock, checks this exact binding, then invokes the fixed command under it. */
  atomicAdmission?: (binding: Readonly<LoopBridgeBindingV1>, invoke: () => Promise<LoopEngineStatusV1>) => Promise<LoopEngineStatusV1>;
  qualifiedOperations: readonly LoopBridgeOperationV1[];
};
export type LoopAdapterConfigurationV1 = {
  adapterId: string; interpreter: string; entrypoint: string; toolingManifest: string;
  interpreterSha256: string; entrypointSha256: string;
  runRoot: string; workRoot: string; configRoot: string; cwd: string;
  settingsFile: string; availabilityFile: string; toolingRevision: string;
  settingsSha256: string; availabilitySha256: string;
  executionIdentity: { uid: number; isolationEvidenceDigest: string };
  contract: LoopAdapterContractV1; timeoutMs?: number;
};
export interface LoopAdapterV1 {
  readonly adapterId: string; readonly toolingRevision: string; readonly schemaDigest: string;
  readonly settingsText: string; readonly contract: LoopImprovementContractV1;
  reserveRun(): string; available(operation: LoopBridgeOperationV1): boolean;
  intake(commandId: string, binding: LoopBridgeBindingV1, text: string, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  confirmRequest(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  start(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  status(run: string): Promise<LoopEngineStatusV1>;
  stop(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  approve(commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  answer(commandId: string, binding: LoopBridgeBindingV1, text: string, beforeSpawn: () => void): Promise<LoopEngineStatusV1>;
  close(): Promise<void>;
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
  const timeoutMs = c.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000
    || !digest.safeParse(c.toolingRevision).success || !digest.safeParse(c.contract.schemaDigest).success
    || c.contract.lineage.toolingRevision !== c.toolingRevision
    || !digest.safeParse(c.executionIdentity.isolationEvidenceDigest).success
    || !Number.isSafeInteger(c.executionIdentity.uid) || c.executionIdentity.uid !== process.getuid?.()) throw unavailable();
  loopImprovementRunIdentitySchemaV1.parse({ adapterId: c.adapterId, loopRunId: "run:configuration",
    toolingRevision: c.toolingRevision, a2SchemaVersion: 1 });
  const validate = () => {
    if (process.getuid?.() !== c.executionIdentity.uid) throw unavailable();
    for (const path of [c.runRoot, c.workRoot, c.configRoot, c.cwd]) checkedPath(path, undefined, true);
    checkedPath(c.interpreter); checkedPath(c.entrypoint, c.configRoot); checkedPath(c.toolingManifest, c.configRoot);
    checkedPath(c.settingsFile, c.configRoot); checkedPath(c.availabilityFile, c.configRoot);
    if (loopByteHashV1(readFileSync(c.interpreter)) !== c.interpreterSha256
      || loopByteHashV1(readFileSync(c.entrypoint)) !== c.entrypointSha256
      || `sha256:${loopByteHashV1(readFileSync(c.toolingManifest))}` !== c.toolingRevision
      || loopByteHashV1(readFileSync(c.settingsFile)) !== c.settingsSha256
      || loopByteHashV1(readFileSync(c.availabilityFile)) !== c.availabilitySha256) throw unavailable();
  };
  validate();
  const settingsText = readFileSync(c.settingsFile, "utf8");
  const settings = parseStrictJsonV1(settingsText, { maxBytes: 65536 }) as { project?: { host_adapter?: unknown } };
  if (settings?.project?.host_adapter !== "local-loop") throw unavailable();
  let closing = false;
  const children = new Set<ChildProcess>(), pending = new Set<Promise<unknown>>();
  const runId = (run: string) => {
    const identity = loopImprovementRunIdentitySchemaV1.parse(c.contract.lineage.decodeRunIdentity({ adapterId: c.adapterId, loopRunId: run,
      toolingRevision: c.toolingRevision, a2SchemaVersion: 1 }));
    if (identity.loopRunId !== run || identity.adapterId !== c.adapterId || identity.toolingRevision !== c.toolingRevision
      || identity.a2SchemaVersion !== 1) throw unavailable();
    return run;
  };
  const decode = (output: string, run: string) => {
    const status = loopEngineStatusSchemaV1.parse(c.contract.decodeStatus(envelopeSchema.parse(parseStrictJsonV1(output, { maxBytes: 65536 }))));
    if (status.run.loopRunId !== run || status.run.adapterId !== c.adapterId || status.run.toolingRevision !== c.toolingRevision)
      throw unavailable();
    return status;
  };
  function execute(args: string[], run: string, json = true, beforeSpawn?: () => void): Promise<LoopEngineStatusV1 | undefined> {
    if (closing) return Promise.reject(unavailable());
    validate(); runId(run);
    beforeSpawn?.();
    const operation = new Promise<LoopEngineStatusV1 | undefined>((fulfill, reject) => {
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
      child.on("close", code => {
        clearTimeout(timer); clearTimeout(killTimer); children.delete(child);
        if (failed || ![0, 2, 3].includes(code ?? -1)) { reject(unavailable()); return; }
        try {
          if (!json) { if (code !== 0) throw unavailable(); fulfill(undefined); return; }
          const status = decode(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output)), run);
          if ((code === 2 || code === 3) && status.state !== "refused") throw unavailable();
          fulfill(status);
        } catch { reject(unavailable()); }
      });
    });
    pending.add(operation); void operation.finally(() => pending.delete(operation)).catch(() => {});
    return operation;
  }
  const status = async (run: string) => (await execute(["status", runId(run), "--json"], run))!;
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
    validate();
    return !closing && c.contract.qualifiedOperations.includes(operation)
      && (!["start", "approve", "answer"].includes(operation) || !!c.contract.atomicAdmission);
  };
  async function invoke(operation: LoopBridgeOperationV1, commandId: string, binding: LoopBridgeBindingV1, beforeSpawn: () => void, text?: string) {
    if (!available(operation) || binding.adapterId !== c.adapterId || binding.toolingRevision !== c.toolingRevision
      || binding.schemaDigest !== c.contract.schemaDigest || operation !== "stop" && binding.settingsSha256 !== c.settingsSha256) throw unavailable();
    validate(); beforeSpawn();
    const run = runId(binding.loopRunId);
    const apply = async () => {
      beforeSpawn();
      let args: string[];
      switch (operation) {
        case "intake": args = ["intake", run, "--source", await commandFile(commandId, "source.txt", text!), "--settings", c.settingsFile, "--json"]; break;
        case "confirm": args = ["confirm-request", run, "--sha256", binding.requestSha256, "--json"]; break;
        case "start": args = ["start", run, "--settings", c.settingsFile, "--availability", c.availabilityFile, "--json"]; break;
        case "stop": args = ["stop", run, "--json"]; break;
        case "approve":
          await execute(["approve", run, binding.body.step as string], run, false, beforeSpawn); return status(run);
        case "answer": args = ["answer", run, binding.body.questionId as string, "--input-version",
          String(binding.inputVersion), "--file", await commandFile(commandId, "answer.txt", text!), "--by", "owner", "--json"]; break;
      }
      return (await execute(args, run, true, beforeSpawn))!;
    };
    // No invented CLI flags: only the reviewed A2 lock seam can enable these calls.
    return ["start", "approve", "answer"].includes(operation) ? c.contract.atomicAdmission!(Object.freeze({ ...binding, body: Object.freeze({ ...binding.body }) }), apply) : apply();
  }
  return Object.freeze({ adapterId: c.adapterId, toolingRevision: c.toolingRevision, schemaDigest: c.contract.schemaDigest,
    settingsText, contract: c.contract.lineage,
    reserveRun: () => runId(c.contract.generateRunId()), available,
    intake: (id: string, b: LoopBridgeBindingV1, text: string, fence: () => void) => invoke("intake", id, b, fence, text),
    confirmRequest: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("confirm", id, b, fence),
    start: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("start", id, b, fence), status,
    stop: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("stop", id, b, fence),
    approve: (id: string, b: LoopBridgeBindingV1, fence: () => void) => invoke("approve", id, b, fence),
    answer: (id: string, b: LoopBridgeBindingV1, text: string, fence: () => void) => invoke("answer", id, b, fence, text),
    close: async () => {
      closing = true;
      for (const child of children) child.kill("SIGTERM");
      const timer = setTimeout(() => { for (const child of children) child.kill("SIGKILL"); }, 1000);
      try { await Promise.allSettled([...pending]); } finally { clearTimeout(timer); }
    },
  });
}
