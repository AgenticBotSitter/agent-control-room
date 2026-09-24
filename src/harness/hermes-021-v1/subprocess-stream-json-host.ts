import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { types } from "node:util";
import { z } from "zod";
import { sha256Digest } from "../../security/canonical-digest";
import { createHermes021MacosStreamJsonPrivatePortV1, type Hermes021MacosStreamJsonHostV1 } from "./stream-json-private-port";
import { hermes021MacosLocalBindingSchemaV1, hermes021MacosTaskSchemaV1,
  type Hermes021MacosTaskV1 } from "./macos-local-worker";
import { attestHermes021MacosReviewedExecutableFileV1,
  assertHermes021MacosReviewedExecutableIdentityPathV1,
  captureHermes021MacosReviewedExecutableIdentityV1,
  consumeHermes021MacosExecutableReviewCapabilityV1,
  hermes021MacosReviewedExecutableIdentityDigestV1,
  reattestHermes021MacosReviewedExecutableIdentityV1,
  type Hermes021MacosReviewedExecutableIdentityV1 } from "./reviewed-executable-identity";
import type { Hermes021MacosLocalPrivatePortV1 } from "./macos-local-worker";
import { HERMES_021_SOURCE_REVISION_V1, HERMES_021_VERSION_V1 } from "./connector-profile";

const unavailable = (): never => { throw new Error("hermes_021_macos_subprocess_host_unavailable"); };
const unavailableError = (): Error => new Error("hermes_021_macos_subprocess_host_unavailable");
const safeIdentifier = z.string().min(1).max(120).regex(/^[A-Za-z0-9._:/-]+$/);
const safeProfile = z.string().min(1).max(120).regex(/^[A-Za-z0-9._-]+$/);
const safePath = z.string().min(1).max(4096).refine(value => isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));

const configurationSchema = z.object({
  /** Owner-pinned absolute Hermes executable; tasks cannot replace it. */
  executablePath: safePath,
  profile: safeProfile,
  model: safeIdentifier,
  provider: safeIdentifier,
  /** Installation-owned folder in which Hermes may perform this approved turn. */
  workingDirectory: safePath,
  /** This adapter revision is deliberately useful before project-writing exists. */
  taskClass: z.literal("text_review").default("text_review"),
  /** More turns or time belong to a separately qualified adapter revision. */
  maximumTurns: z.literal(1).default(1),
  maximumRunBudgetSeconds: z.number().int().min(15).max(120).default(120),
}).strict();
export type Hermes021MacosSubprocessHostConfigurationV1 = z.input<typeof configurationSchema>;

type CapturedConfiguration = ReturnType<typeof captureHermes021MacosSubprocessHostConfigurationV1>;
type OwnerQualificationHost = Readonly<{
  configuration: CapturedConfiguration;
  reviewedExecutableIdentity: Hermes021MacosReviewedExecutableIdentityV1;
  qualify(expectedText: string): Promise<readonly unknown[]>;
}>;
const ownerQualificationHosts = new WeakMap<object, OwnerQualificationHost>();

export const HERMES_021_MACOS_OWNER_AUTHORIZED_LOCAL_ONLY_RUNNER_V1 =
  "control-room.hermes-021-macos-owner-authorized-local-only-runner/v1" as const;
const ownerAuthorizedLocalOnlyRunners = new WeakMap<object, Readonly<{
  configuration: CapturedConfiguration;
  workerBinding: ReturnType<typeof hermes021MacosLocalBindingSchemaV1.parse>;
  reviewedExecutableIdentity: Hermes021MacosReviewedExecutableIdentityV1;
}>>();
const ownerAuthorizedLocalOnlyAdmissions = new WeakMap<object, Readonly<{
  contractDigest: string;
  taskDigest: string;
  task: Hermes021MacosTaskV1;
}>>();
const ownerAuthorizedLocalOnlyAttempts = new WeakMap<object, {
  activeTaskDigest: string | undefined;
  attemptedTaskDigests: Set<string>;
}>();
/**
 * A process-local holder lets the installed graph exist before the attended
 * setup step, without making its delivery path runnable.  It is deliberately
 * not persistence: a restart requires a fresh attended qualification.
 */
const ownerAuthorizedLocalOnlyRunnerProviders = new WeakMap<object, Readonly<{
  binding: Readonly<Record<string, unknown>>;
  runner?: object;
}>>();
const runnerDigest = /^sha256:[a-f0-9]{64}$/u;
const localInstallationId = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;

function runnerRefused(): never {
  const error = new Error("hermes_021_macos_owner_authorized_local_only_runner_refused");
  error.stack = undefined; throw error;
}

function exactRunnerInput(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return runnerRefused();
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name))
    || names.some(name => !actual.includes(name))) return runnerRefused();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) return runnerRefused();
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

/** Copies recursive own data before any schema traversal can invoke a getter. */
function denseData(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return runnerRefused();
  const copied: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return runnerRefused();
    copied[name] = denseData(descriptor.value);
  }
  return Object.freeze(copied);
}

function localRunnerConfigurationDigest(configuration: CapturedConfiguration) {
  return sha256Digest({ purpose: "local-hermes-runner-configuration/v1", configuration });
}

/**
 * Parses only the installation-owned runner settings. This does not touch the
 * executable, working directory, credentials, or network. The no-run
 * preflight and the real subprocess host share this parser so a preflight
 * cannot approve a shape the runner would later reject.
 */
export function captureHermes021MacosSubprocessHostConfigurationV1(value: unknown) {
  return Object.freeze(configurationSchema.parse(value));
}

/**
 * Creates a deliberately unsealed owner-authorized local runner contract. It
 * is expressly not resistant to same-user mutation. It binds one fixed
 * text-only/no-tools/concurrency-one policy to exact installation, release,
 * topology, worker, runner configuration, and reviewed executable identity.
 * No configuration is read and no process, queue, database, or scheduler is
 * started here.
 */
export function createHermes021MacosOwnerAuthorizedLocalOnlyRunnerV1(value: unknown) {
  const names = ["installationId", "installationPlanDigest", "installationPlanRevision", "topologyPlanDigest",
    "releaseDigest", "workerBinding", "runnerConfiguration", "reviewedExecutableIdentity"] as const;
  try {
    const input = exactRunnerInput(value, names);
    if (typeof input.installationId !== "string" || !localInstallationId.test(input.installationId)
      || typeof input.installationPlanRevision !== "number" || !Number.isSafeInteger(input.installationPlanRevision)
      || input.installationPlanRevision < 0 || [input.installationPlanDigest, input.topologyPlanDigest, input.releaseDigest]
        .some(item => typeof item !== "string" || !runnerDigest.test(item))) return runnerRefused();
    const worker = hermes021MacosLocalBindingSchemaV1.parse(denseData(input.workerBinding));
    if (worker.expectedVersion !== HERMES_021_VERSION_V1 || worker.sourceRevision !== HERMES_021_SOURCE_REVISION_V1) return runnerRefused();
    const configuration = captureHermes021MacosSubprocessHostConfigurationV1(denseData(input.runnerConfiguration));
    if (configuration.taskClass !== "text_review" || configuration.maximumTurns !== 1) return runnerRefused();
    const reviewedExecutableIdentity = captureHermes021MacosReviewedExecutableIdentityV1(input.reviewedExecutableIdentity);
    assertHermes021MacosReviewedExecutableIdentityPathV1(input.reviewedExecutableIdentity, configuration.executablePath);
    const material = Object.freeze({ schema: HERMES_021_MACOS_OWNER_AUTHORIZED_LOCAL_ONLY_RUNNER_V1,
      mode: "owner_authorized_local_only" as const, installationId: input.installationId,
      installationPlanDigest: input.installationPlanDigest, installationPlanRevision: input.installationPlanRevision,
      topologyPlanDigest: input.topologyPlanDigest, releaseDigest: input.releaseDigest,
      workerBindingDigest: sha256Digest(worker), runnerConfigurationDigest: localRunnerConfigurationDigest(configuration),
      reviewedExecutableIdentityDigest: hermes021MacosReviewedExecutableIdentityDigestV1(input.reviewedExecutableIdentity),
      taskClass: "text_review" as const, tools: "none" as const, concurrency: 1 as const,
      retriesOnUncertainty: false as const, sealedRuntime: false as const,
      resistsSameUserMutation: false as const });
    const contract = Object.freeze({ ...material, contractDigest: sha256Digest({
      purpose: "hermes-021-owner-authorized-local-only-runner/v1", contract: material }) });
    ownerAuthorizedLocalOnlyRunners.set(contract, Object.freeze({ configuration, workerBinding: worker, reviewedExecutableIdentity }));
    ownerAuthorizedLocalOnlyAttempts.set(contract, { activeTaskDigest: undefined, attemptedTaskDigests: new Set<string>() });
    return contract;
  } catch { return runnerRefused(); }
}

/**
 * Confirms that an opaque runner belongs to the exact installed local worker.
 * It returns no runnable port or private configuration; the installer uses it
 * only before selecting the owner-authorized delivery path.
 */
export function assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1(contractValue: unknown, value: unknown): void {
  if (!contractValue || typeof contractValue !== "object" || types.isProxy(contractValue)) return runnerRefused();
  const captured = ownerAuthorizedLocalOnlyRunners.get(contractValue);
  if (!captured) return runnerRefused();
  const input = exactRunnerInput(value, ["installationId", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "workerBinding", "runnerConfiguration"]);
  const contract = exactRunnerInput(contractValue, ["schema", "mode", "installationId", "installationPlanDigest",
    "installationPlanRevision", "topologyPlanDigest", "releaseDigest", "workerBindingDigest", "runnerConfigurationDigest",
    "reviewedExecutableIdentityDigest", "taskClass", "tools", "concurrency", "retriesOnUncertainty", "sealedRuntime",
    "resistsSameUserMutation", "contractDigest"]);
  const worker = hermes021MacosLocalBindingSchemaV1.parse(denseData(input.workerBinding));
  const configuration = captureHermes021MacosSubprocessHostConfigurationV1(denseData(input.runnerConfiguration));
  if (input.installationId !== contract.installationId || input.installationPlanDigest !== contract.installationPlanDigest
    || input.installationPlanRevision !== contract.installationPlanRevision || input.topologyPlanDigest !== contract.topologyPlanDigest
    || input.releaseDigest !== contract.releaseDigest || sha256Digest(worker) !== contract.workerBindingDigest
    || sha256Digest(worker) !== sha256Digest(captured.workerBinding)
    || localRunnerConfigurationDigest(configuration) !== contract.runnerConfigurationDigest
    || localRunnerConfigurationDigest(configuration) !== localRunnerConfigurationDigest(captured.configuration)) return runnerRefused();
}

/** Creates an inert, installation-bound runner holder.  Constructing it does
 * not qualify Hermes, enable a worker, or make a private port. */
export function createHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1(value: unknown): object {
  const binding = exactRunnerInput(value, ["installationId", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "workerBinding", "runnerConfiguration"]);
  // Validate the exact shape once now.  No runner can be supplied at creation.
  const installationId = binding.installationId;
  if (typeof installationId !== "string" || !localInstallationId.test(installationId)) return runnerRefused();
  if (!Number.isSafeInteger(binding.installationPlanRevision) || (binding.installationPlanRevision as number) < 0) return runnerRefused();
  if ([binding.installationPlanDigest, binding.topologyPlanDigest, binding.releaseDigest]
    .some(item => typeof item !== "string" || !runnerDigest.test(item))) return runnerRefused();
  hermes021MacosLocalBindingSchemaV1.parse(denseData(binding.workerBinding));
  captureHermes021MacosSubprocessHostConfigurationV1(denseData(binding.runnerConfiguration));
  const provider = Object.freeze({ schema: "control-room.hermes-021-macos-owner-authorized-local-only-runner-provider/v1" as const });
  ownerAuthorizedLocalOnlyRunnerProviders.set(provider, Object.freeze({ binding }));
  return provider;
}

/** Verifies that a provider was created for this exact local installation. */
export function assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderBindingV1(provider: unknown, value: unknown): void {
  if (!provider || typeof provider !== "object" || types.isProxy(provider)) return runnerRefused();
  const entry = ownerAuthorizedLocalOnlyRunnerProviders.get(provider);
  if (!entry) return runnerRefused();
  const expected = exactRunnerInput(value, ["installationId", "installationPlanDigest", "installationPlanRevision",
    "topologyPlanDigest", "releaseDigest", "workerBinding", "runnerConfiguration"]);
  if (sha256Digest(entry.binding) !== sha256Digest(expected)) return runnerRefused();
}

/** Fills an inert provider exactly once after the separate attended
 * qualification has minted a genuine runner. */
export function activateHermes021MacosOwnerAuthorizedLocalOnlyRunnerProviderV1(provider: unknown, runner: unknown): void {
  if (!provider || typeof provider !== "object" || !runner || typeof runner !== "object" || types.isProxy(provider)
    || types.isProxy(runner)) return runnerRefused();
  const entry = ownerAuthorizedLocalOnlyRunnerProviders.get(provider);
  if (!entry || entry.runner) return runnerRefused();
  assertHermes021MacosOwnerAuthorizedLocalOnlyRunnerBindingV1(runner, entry.binding);
  ownerAuthorizedLocalOnlyRunnerProviders.set(provider, Object.freeze({ ...entry, runner: runner as object }));
}

/** A stable factory wrapper resolves the runner only when an already-approved
 * task is about to execute.  Before attended setup it refuses truthfully. */
export function createHermes021MacosOwnerAuthorizedLocalOnlyProviderTaskPortFactoryV1(provider: unknown): Readonly<{
  create(taskValue: unknown, beforeSpawn?: () => Promise<void>): Hermes021MacosLocalPrivatePortV1;
}> {
  if (!provider || typeof provider !== "object" || types.isProxy(provider)
    || !ownerAuthorizedLocalOnlyRunnerProviders.has(provider)) return runnerRefused();
  return Object.freeze({ create(taskValue: unknown, beforeSpawn?: () => Promise<void>) {
    const runner = ownerAuthorizedLocalOnlyRunnerProviders.get(provider)?.runner;
    if (!runner) return runnerRefused();
    return createHermes021MacosOwnerAuthorizedLocalOnlyTaskPortFactoryV1(runner).create(taskValue, beforeSpawn);
  } });
}

type LaunchOptions = SpawnOptions & Readonly<{ stdio: ["pipe", "pipe", "pipe"] }>;
type Launch = (file: string, args: readonly string[], options: LaunchOptions) => ChildProcessWithoutNullStreams;
type MakeDirectory = (prefix: string) => Promise<string>;
type RemoveDirectory = (path: string, options: Readonly<{ recursive: true; force: true }>) => Promise<void>;
type SaveFile = (path: string, contents: string, options: Readonly<{ encoding: "utf8"; mode: number; flag: "wx" }>) => Promise<void>;

function taskText(input: Parameters<Hermes021MacosStreamJsonHostV1["execute"]>[0]["task"]): string {
  // The task is passed as file content rather than as command-line text. A task
  // cannot change the executable or arguments selected below.
  return ["You are completing one approved Control Room text-review task.",
    "Return a plain-text review, test outline, or proposed patch only.",
    "Do not call tools, write files, access accounts, or make network requests.", "", "Instructions:", input.instructions,
    "", "Task:", input.prompt, ""].join("\n");
}

/**
 * The installer's narrowly configured local Hermes host. It uses the existing
 * Hermes CLI only through fixed argv entries and a 0600 temporary query file.
 * It is intentionally not wired into application startup: creating this host
 * does not start Hermes, retain credentials, or enable a worker. The caller
 * must still supply the existing Control Room policy and queue composition.
 */
function createHost(configurationValue: unknown, launch: Launch, makeDirectory: MakeDirectory,
  removeDirectory: RemoveDirectory, saveFile: SaveFile, now: () => number,
  beforeLaunch?: () => Promise<void>): Hermes021MacosStreamJsonHostV1 {
  const configuration = captureHermes021MacosSubprocessHostConfigurationV1(configurationValue);
  if (typeof launch !== "function" || typeof makeDirectory !== "function" || typeof removeDirectory !== "function"
    || typeof saveFile !== "function" || typeof now !== "function") unavailable();
  const host = Object.freeze({ async execute(input: Readonly<{
    task: Hermes021MacosTaskV1;
    signal?: AbortSignal;
    onLine(line: string): Promise<void>;
  }>) {
    if (!input || input.signal?.aborted || !Number.isSafeInteger(input.task.deadline)) unavailable();
    const configuredMilliseconds = configuration.maximumRunBudgetSeconds * 1000;
    const remaining = () => {
      if (input.signal?.aborted) unavailable();
      const milliseconds = input.task.deadline - now();
      if (!Number.isSafeInteger(milliseconds) || milliseconds < 1_000) unavailable();
      return milliseconds;
    };
    remaining();
    const directory = await makeDirectory(join(tmpdir(), "control-room-hermes-task-"));
    const queryFile = join(directory, "task.txt");
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      remaining();
      await saveFile(queryFile, taskText(input.task), { encoding: "utf8", mode: 0o600, flag: "wx" });
      remaining();
      await beforeLaunch?.();
      // Attestation itself awaits I/O. Recheck expiry/abort after it and use
      // the remaining controller window rather than a stale setup timestamp.
      const timeoutMilliseconds = Math.min(configuredMilliseconds, remaining());
      const args = Object.freeze(["-p", configuration.profile, "chat", "--query-file", queryFile,
        "--format", "stream-json", "--toolsets", "bot_room", "--ignore-rules", "--max-turns",
        String(configuration.maximumTurns), "--run-budget", String(configuration.maximumRunBudgetSeconds),
        "--source", "control-room-local-worker", "--in", configuration.workingDirectory,
        "--model", configuration.model, "--provider", configuration.provider]);
      await new Promise<void>((resolve, reject) => {
        let settled = false, closed = false, bytes = 0, pending = Promise.resolve();
        let forceTimer: ReturnType<typeof setTimeout> | undefined;
        let remainder = "";
        const decoder = new StringDecoder("utf8");
        const fail = () => {
          if (settled) return;
          settled = true;
          try { child?.kill("SIGTERM"); } catch { /* close is still awaited below */ }
          // A process that ignores its normal termination signal is not allowed
          // to keep the approved window open indefinitely. We still wait for
          // its close event before reporting failure or cleaning task material.
          forceTimer = setTimeout(() => { try { child?.kill("SIGKILL"); } catch { /* close remains authoritative */ } }, 5_000);
        };
        const complete = (error?: Error) => {
          if (closed) return;
          closed = true; clearTimeout(timer); if (forceTimer) clearTimeout(forceTimer); input.signal?.removeEventListener("abort", fail);
          void pending.then(() => error || settled || input.signal?.aborted ? reject(unavailableError()) : resolve(), () => reject(unavailableError()));
        };
        const receive = (chunk: Buffer) => {
          if (settled) return;
          bytes += chunk.byteLength;
          if (bytes > 262_144) { fail(); return; }
          remainder += decoder.write(chunk);
          const lines = remainder.split("\n"); remainder = lines.pop() ?? "";
          for (const line of lines) {
            const clean = line.endsWith("\r") ? line.slice(0, -1) : line;
            if (clean === "") continue;
            pending = pending.then(() => input.onLine(clean));
            void pending.catch(fail);
          }
        };
        try {
          remaining();
          child = launch(configuration.executablePath, args, { shell: false, windowsHide: true, cwd: configuration.workingDirectory,
            env: { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
        } catch { reject(unavailableError()); return; }
        const timer = setTimeout(fail, timeoutMilliseconds);
        input.signal?.addEventListener("abort", fail, { once: true });
        child.on("error", fail); child.stdin.on("error", fail); child.stdout.on("error", fail); child.stderr.on("error", fail);
        child.stdout.on("data", receive);
        child.stderr.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > 262_144) fail(); });
        child.once("close", (code, signal) => {
          const tail = decoder.end();
          if (tail) {
            remainder += tail;
            if (remainder && !settled) { pending = pending.then(() => input.onLine(remainder)); void pending.catch(fail); }
          }
          if (code !== 0 || signal !== null || remainder.includes("\r") || settled || input.signal?.aborted) complete(new Error("child_failed"));
          else complete();
        });
        try { child.stdin.end(); } catch { fail(); }
      });
    } finally {
      // The task prompt is private operational content. It must not remain as a
      // local workboard artifact after the owned child has closed.
      await removeDirectory(directory, { recursive: true, force: true });
    }
  } });
  return host;
}

/**
 * The only host factory for the owner-authorized local-only contract. It uses
 * the existing fixed-argv host and re-attests the exact executable immediately
 * before every spawn. Attestation failure is a refusal; it never retries an
 * uncertain launch. This remains intentionally unmounted from application
 * composition so it cannot create a second lifecycle.
 */
function createHermes021MacosOwnerAuthorizedLocalOnlyStreamJsonHostV1(contractValue: unknown,
  beforeSpawn?: () => Promise<void>): Hermes021MacosStreamJsonHostV1 {
  if (!contractValue || typeof contractValue !== "object" || types.isProxy(contractValue)) return runnerRefused();
  const captured = ownerAuthorizedLocalOnlyRunners.get(contractValue);
  if (!captured) return runnerRefused();
  const contract = exactRunnerInput(contractValue, ["schema", "mode", "installationId", "installationPlanDigest",
    "installationPlanRevision", "topologyPlanDigest", "releaseDigest", "workerBindingDigest", "runnerConfigurationDigest",
    "reviewedExecutableIdentityDigest", "taskClass", "tools", "concurrency", "retriesOnUncertainty", "sealedRuntime",
    "resistsSameUserMutation", "contractDigest"]);
  const { contractDigest, ...material } = contract;
  if (contract.schema !== HERMES_021_MACOS_OWNER_AUTHORIZED_LOCAL_ONLY_RUNNER_V1
    || contract.mode !== "owner_authorized_local_only" || contract.taskClass !== "text_review" || contract.tools !== "none"
    || contract.concurrency !== 1 || contract.retriesOnUncertainty !== false || contract.sealedRuntime !== false
    || contract.resistsSameUserMutation !== false || typeof contractDigest !== "string" || !runnerDigest.test(contractDigest)
    || contractDigest !== sha256Digest({ purpose: "hermes-021-owner-authorized-local-only-runner/v1", contract: material })
    || contract.runnerConfigurationDigest !== localRunnerConfigurationDigest(captured.configuration)
    || contract.reviewedExecutableIdentityDigest !== hermes021MacosReviewedExecutableIdentityDigestV1(captured.reviewedExecutableIdentity)) return runnerRefused();
  if (beforeSpawn !== undefined && typeof beforeSpawn !== "function") return runnerRefused();
  return createHost(captured.configuration, (file, args, options) => spawn(file, [...args], options) as ChildProcessWithoutNullStreams,
    mkdtemp, rm, writeFile, Date.now, async () => {
      await reattestHermes021MacosReviewedExecutableIdentityV1(captured.reviewedExecutableIdentity);
      // This runs after task-file preparation and executable attestation, at
      // the last async boundary before spawn. A revoked task never crosses
      // the process boundary just because preparation took time.
      await beforeSpawn?.();
    });
}

/** Mints one task-only gate after rechecking its current installation binding. */
export function admitHermes021MacosOwnerAuthorizedLocalOnlyTaskV1(contractValue: unknown, value: unknown): object {
  if (!contractValue || typeof contractValue !== "object" || types.isProxy(contractValue)) return runnerRefused();
  const captured = ownerAuthorizedLocalOnlyRunners.get(contractValue);
  if (!captured) return runnerRefused();
  const input = exactRunnerInput(value, ["installationId", "installationPlanDigest", "topologyPlanDigest", "releaseDigest", "workerBinding", "task"]);
  const contract = exactRunnerInput(contractValue, ["schema", "mode", "installationId", "installationPlanDigest",
    "installationPlanRevision", "topologyPlanDigest", "releaseDigest", "workerBindingDigest", "runnerConfigurationDigest",
    "reviewedExecutableIdentityDigest", "taskClass", "tools", "concurrency", "retriesOnUncertainty", "sealedRuntime",
    "resistsSameUserMutation", "contractDigest"]);
  const worker = hermes021MacosLocalBindingSchemaV1.parse(denseData(input.workerBinding));
  if (input.installationId !== contract.installationId || input.installationPlanDigest !== contract.installationPlanDigest
    || input.topologyPlanDigest !== contract.topologyPlanDigest || input.releaseDigest !== contract.releaseDigest
    || sha256Digest(worker) !== contract.workerBindingDigest || sha256Digest(worker) !== sha256Digest(captured.workerBinding)) return runnerRefused();
  const task = Object.freeze(hermes021MacosTaskSchemaV1.parse(denseData(input.task)));
  const taskDigest = sha256Digest(task);
  const gate = Object.freeze({ schema: "control-room.hermes-021-macos-owner-authorized-local-only-task-gate/v1" });
  ownerAuthorizedLocalOnlyAdmissions.set(gate, Object.freeze({ contractDigest: contract.contractDigest as string, taskDigest, task }));
  return gate;
}

/**
 * The matching private-port factory is the runnable entry point. It binds
 * every task's service identity to the contract before it can reach the host;
 * a caller cannot substitute another local worker merely by reusing a host.
 */
export function createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(contractValue: unknown,
  admissionValue: unknown, beforeSpawn?: () => Promise<void>): Hermes021MacosLocalPrivatePortV1 {
  if (!contractValue || typeof contractValue !== "object" || types.isProxy(contractValue)) return runnerRefused();
  const captured = ownerAuthorizedLocalOnlyRunners.get(contractValue);
  const admission = admissionValue && typeof admissionValue === "object" && !types.isProxy(admissionValue)
    ? ownerAuthorizedLocalOnlyAdmissions.get(admissionValue) : undefined;
  const attempts = ownerAuthorizedLocalOnlyAttempts.get(contractValue);
  if (!captured || !admission || !attempts) return runnerRefused();
  const contract = exactRunnerInput(contractValue, ["schema", "mode", "installationId", "installationPlanDigest",
    "installationPlanRevision", "topologyPlanDigest", "releaseDigest", "workerBindingDigest", "runnerConfigurationDigest",
    "reviewedExecutableIdentityDigest", "taskClass", "tools", "concurrency", "retriesOnUncertainty", "sealedRuntime",
    "resistsSameUserMutation", "contractDigest"]);
  // A foreign runner must not be able to consume another runner's one-use
  // gate merely by presenting it to this factory.
  if (admission.contractDigest !== contract.contractDigest
    || !ownerAuthorizedLocalOnlyAdmissions.delete(admissionValue as object)) return runnerRefused();
  const host = createHermes021MacosOwnerAuthorizedLocalOnlyStreamJsonHostV1(contractValue, beforeSpawn);
  const port = createHermes021MacosStreamJsonPrivatePortV1(captured.workerBinding, host);
  let used = false;
  return Object.freeze({ async run(input: Parameters<Hermes021MacosLocalPrivatePortV1["run"]>[0]) {
    if (used || !input || input.localServiceId !== captured.workerBinding.localServiceId
      || sha256Digest(denseData(input.task)) !== admission.taskDigest
      || attempts.activeTaskDigest !== undefined || attempts.attemptedTaskDigests.has(admission.taskDigest)) return runnerRefused();
    // Burn before awaiting: lost output is uncertainty, never a second spawn.
    used = true; attempts.activeTaskDigest = admission.taskDigest; attempts.attemptedTaskDigests.add(admission.taskDigest);
    try {
      // The caller's task is used only for a defensive exact-digest comparison
      // above.  Forward the immutable admission snapshot so mutation during an
      // awaited temp-file/attestation step cannot alter the executed text.
      return await port.run(Object.freeze({ ...input, task: admission.task }));
    } finally {
      attempts.activeTaskDigest = undefined;
    }
  } });
}

/**
 * Produces ports only for the exact task held by an owner-authorized runner.
 * The factory deliberately owns admission reconstruction: callers receive no
 * installation, release, topology, worker, or executable material with which
 * to mint a different task gate.  A returned port is still one-use.
 */
export function createHermes021MacosOwnerAuthorizedLocalOnlyTaskPortFactoryV1(contractValue: unknown): Readonly<{
  create(taskValue: unknown, beforeSpawn?: () => Promise<void>): Hermes021MacosLocalPrivatePortV1;
}> {
  if (!contractValue || typeof contractValue !== "object" || types.isProxy(contractValue)) return runnerRefused();
  const captured = ownerAuthorizedLocalOnlyRunners.get(contractValue);
  if (!captured) return runnerRefused();
  const contract = exactRunnerInput(contractValue, ["schema", "mode", "installationId", "installationPlanDigest",
    "installationPlanRevision", "topologyPlanDigest", "releaseDigest", "workerBindingDigest", "runnerConfigurationDigest",
    "reviewedExecutableIdentityDigest", "taskClass", "tools", "concurrency", "retriesOnUncertainty", "sealedRuntime",
    "resistsSameUserMutation", "contractDigest"]);
  const task = (taskValue: unknown) => Object.freeze(hermes021MacosTaskSchemaV1.parse(denseData(taskValue)));
  return Object.freeze({ create(taskValue: unknown, beforeSpawn?: () => Promise<void>) {
    const admittedTask = task(taskValue);
    const admission = admitHermes021MacosOwnerAuthorizedLocalOnlyTaskV1(contractValue, {
      installationId: contract.installationId,
      installationPlanDigest: contract.installationPlanDigest,
      topologyPlanDigest: contract.topologyPlanDigest,
      releaseDigest: contract.releaseDigest,
      workerBinding: captured.workerBinding,
      task: admittedTask,
    });
    return createHermes021MacosOwnerAuthorizedLocalOnlyPrivatePortV1(contractValue, admission, beforeSpawn);
  } });
}

/** General process host with explicit test seams. It never mints owner
 * qualification authority, including when every injected primitive is real. */
export function createHermes021MacosSubprocessStreamJsonHostV1(configurationValue: unknown,
  launch: Launch = (file, args, options) => spawn(file, [...args], options) as ChildProcessWithoutNullStreams,
  makeDirectory: MakeDirectory = mkdtemp,
  removeDirectory: RemoveDirectory = rm,
  saveFile: SaveFile = writeFile,
  now: () => number = Date.now): Hermes021MacosStreamJsonHostV1 {
  return createHost(configurationValue, launch, makeDirectory, removeDirectory, saveFile, now);
}

/**
 * Captures one reviewed owner executable for qualification, but deliberately
 * refuses use: Node's path-based spawn cannot execute the already-opened file
 * descriptor, leaving an uncloseable final check-to-exec replacement race.
 */
export async function createHermes021MacosNativeOwnerQualificationHostV1(
  configurationValue: unknown, executableReviewCapability: unknown): Promise<object> {
  const configuration = captureHermes021MacosSubprocessHostConfigurationV1(configurationValue);
  const review = consumeHermes021MacosExecutableReviewCapabilityV1(executableReviewCapability);
  if (configuration.executablePath !== review.executablePath) unavailable();
  await attestHermes021MacosReviewedExecutableFileV1(review.executablePath,
    review.record.executableSha256, review.stat);
  const capability = Object.freeze({ schema: "control-room.hermes-021-macos-native-owner-qualification-host/v1",
    providesGeneralExecutionAuthority: false as const });
  ownerQualificationHosts.set(capability, Object.freeze({ configuration,
    reviewedExecutableIdentity: review.record,
    async qualify(_expectedText: string): Promise<readonly unknown[]> { return unavailable(); } }));
  return capability;
}

/**
 * Creates the deliberately bounded local alternative to the sealed native
 * qualification host.  macOS Node cannot launch the already-open file handle,
 * so this route is explicitly for an owner-approved, same-user local trust
 * model: it re-attests the reviewed executable immediately before one fixed,
 * text-only qualification turn, but does not claim to resist a malicious
 * same-user replacement between that check and spawn.
 *
 * The returned opaque capability exposes no general execution port.  It is
 * consumed exactly once by the installation-bound qualification procedure.
 */
export async function createHermes021MacosOwnerAuthorizedUnsealedQualificationHostV1(
  configurationValue: unknown, executableReviewCapability: unknown): Promise<object> {
  const configuration = captureHermes021MacosSubprocessHostConfigurationV1(configurationValue);
  const review = consumeHermes021MacosExecutableReviewCapabilityV1(executableReviewCapability);
  if (configuration.executablePath !== review.executablePath) unavailable();
  await attestHermes021MacosReviewedExecutableFileV1(review.executablePath,
    review.record.executableSha256, review.stat);
  const host = createHost(configuration, (file, args, options) => spawn(file, [...args], options) as ChildProcessWithoutNullStreams,
    mkdtemp, rm, writeFile, Date.now,
    async () => reattestHermes021MacosReviewedExecutableIdentityV1(review.record));
  let spent = false;
  const capability = Object.freeze({ schema: "control-room.hermes-021-macos-owner-authorized-unsealed-qualification-host/v1",
    providesGeneralExecutionAuthority: false as const, resistsSameUserMutation: false as const });
  ownerQualificationHosts.set(capability, Object.freeze({ configuration,
    reviewedExecutableIdentity: review.record,
    async qualify(expectedText: string): Promise<readonly unknown[]> {
      if (spent) unavailable();
      spent = true;
      const lines: unknown[] = [];
      await host.execute({ task: { tenantId: "tenant:qualification", projectId: "project:qualification",
        jobId: "job:qualification", attemptId: "attempt:qualification", runId: "run:qualification",
        nodeId: "node:qualification", prompt: `Reply with exactly this text and nothing else: ${expectedText}`,
        instructions: "Use no tools and do not write files.", deadline: Date.now() + 125_000 },
      async onLine(line) {
        try { lines.push(JSON.parse(line)); } catch { /* terminal parser rejects non-result lines */ }
      } });
      return Object.freeze(lines);
    } }));
  return capability;
}

/**
 * Burns the concrete subprocess host's one qualification route.  A structural
 * `{ execute }` value, copied host, Proxy, or replay has no entry in this
 * module's private custody and cannot reach the qualification procedure.
 *
 * The outer owner-terminal command is responsible for resolving the selected
 * executable and constructing this host after its attended checks.  This seam
 * deliberately accepts no caller-supplied `ownerAttended` assertion.
 */
export function consumeHermes021MacosOwnerQualificationHostV1(value: unknown): OwnerQualificationHost {
  if (!value || typeof value !== "object" || types.isProxy(value)) unavailable();
  const token = value as object;
  const captured = ownerQualificationHosts.get(token);
  if (!captured) return unavailable();
  if (!ownerQualificationHosts.delete(token)) return unavailable();
  return captured;
}
