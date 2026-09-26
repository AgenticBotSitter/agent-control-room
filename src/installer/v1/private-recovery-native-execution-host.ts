import { isAbsolute, normalize } from "node:path";
import { dataMethodV1, exactHostDataSnapshotV1, isHostProxyV1 } from "../../security/host-value";
import { sha256Digest } from "../../security/canonical-digest";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import type { PrivateRecoveryRehearsalPortsV1, PrivateRecoveryRehearsalSessionV1 } from
  "./private-recovery-rehearsal-adapter";
import type { PrivateRecoveryRunnerContextV1 } from "./private-recovery-owner-runner";
import { privateRecoveryReviewedToolPathsV1 } from "./private-recovery-tool-preflight";

export const PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1 =
  "control-room.private-recovery-native-execution-host/v1" as const;
export const PRIVATE_RECOVERY_NATIVE_PROCESS_GROUP_RECEIPT_V1 =
  "control-room.private-recovery-native-process-group-receipt/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const readAborted = Reflect.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const addEventListener = EventTarget.prototype.addEventListener;
const removeEventListener = EventTarget.prototype.removeEventListener;
const reviewedPaths = privateRecoveryReviewedToolPathsV1;
const executableNames = ["node", "pg_dump", "pg_restore"] as const;

/** The only argv this host permits. Private targets and credentials can never
 * be appended to it; they remain inside the injected owner-held native port. */
export const privateRecoveryNativeFixedArgvV1 = Object.freeze([
  "--protocol", PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
  "--session", "isolated-disposable-recovery",
  "--require-fresh-process-group",
] as const);

type Pin = Readonly<{ path: string; sha256: string }>;
type ReviewedFiles = Readonly<Record<typeof reviewedPaths[number], string>>;
type Executables = Readonly<Record<typeof executableNames[number], Pin>>;

export type PrivateRecoveryNativeExecutionHostConfigurationV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1;
  releaseRoot: string;
  releaseDigest: string;
  requestDigest: string;
  nativeHost: Pin;
  reviewedFiles: ReviewedFiles;
  executables: Executables;
  operationDeadlineMs: number;
  retirementDeadlineMs: number;
  terminationGraceMs: number;
  isolatedDisposableClusterRequired: true;
}>;

export type PrivateRecoveryNativeExecutionVerificationRequestV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1;
  releaseRoot: string;
  releaseDigest: string;
  requestDigest: string;
  nativeHost: Pin;
  reviewedFiles: ReviewedFiles;
  executables: Executables;
  toolchainDigest: string;
  signal: AbortSignal;
}>;

export type PrivateRecoveryNativeExecutionVerificationReceiptV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1;
  outcome: "verified";
  releaseDigest: string;
  requestDigest: string;
  nativeHostSha256: string;
  toolchainDigest: string;
  pinProvenanceVerified: true;
  dependencyContentsVerified: true;
  extendedAclVerified: true;
  freshProcessGroupSupported: true;
}>;

export type PrivateRecoveryNativeExecutionLaunchRequestV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1;
  executablePath: string;
  argv: typeof privateRecoveryNativeFixedArgvV1;
  cwd: string;
  shell: false;
  environmentMode: "replace";
  environment: Readonly<{ NODE_ENV: "production"; LANG: "C"; LC_ALL: "C" }>;
  freshProcessGroup: true;
  credentialsOnArgv: false;
  sourceTargetReadOnlyRequired: true;
  isolatedDisposableClusterRequired: true;
  releaseDigest: string;
  requestDigest: string;
  nativeHostSha256: string;
  toolchainDigest: string;
  reviewedToolPaths: typeof privateRecoveryReviewedToolPathsV1;
  reviewedFiles: ReviewedFiles;
  executables: Executables;
  context: Omit<PrivateRecoveryRunnerContextV1, "signal">;
}>;

export type PrivateRecoveryNativeProcessGroupReceiptV1 = Readonly<{
  schema: typeof PRIVATE_RECOVERY_NATIVE_PROCESS_GROUP_RECEIPT_V1;
  processGroupRetired: true;
  leaderReaped: true;
  descendantsReaped: true;
}>;

export interface PrivateRecoveryNativeExecutionChildV1 {
  /** The handle is fully captured while dormant. Starting is synchronous; a
   * throw or non-void return is uncertainty and the captured retirement
   * methods remain authoritative. */
  start(request: PrivateRecoveryNativeExecutionLaunchRequestV1): void;
  ready(signal: AbortSignal): Promise<Readonly<{
    schema: typeof PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1;
    ready: true;
    freshProcessGroup: true;
    credentialsPrivate: true;
    protectedBackupDestinationHeld: true;
    operationEntered: false;
  }>>;
  inspectDisposableTargets(signal: AbortSignal): Promise<unknown>;
  backupDatabaseAndProtectedArtifacts(signal: AbortSignal): Promise<unknown>;
  restoreExactBackup(input: Readonly<{ databaseDumpDigest: string; artifactInventoryDigest: string }>,
    signal: AbortSignal): Promise<unknown>;
  verifyRestrictedLogins(signal: AbortSignal): Promise<unknown>;
  requestClose(signal: AbortSignal): Promise<unknown>;
  /** These methods target the fresh process group, never an arbitrary pid. */
  signalProcessGroupTerminate(): void;
  signalProcessGroupKill(): void;
  waitForProcessGroupRetirement(signal: AbortSignal): Promise<PrivateRecoveryNativeProcessGroupReceiptV1>;
}

export type PrivateRecoveryNativeExecutionHostPortsV1 = Readonly<{
  verifyExecution(request: PrivateRecoveryNativeExecutionVerificationRequestV1):
    Promise<PrivateRecoveryNativeExecutionVerificationReceiptV1>;
  /** Must synchronously return a dormant handle. It may not start a process;
   * the host validates the complete lifecycle surface before calling start.
   * A throw must occur before acquiring any private resource. */
  prepareLaunch(): PrivateRecoveryNativeExecutionChildV1;
  /** Synchronous final authority fence. A promise is never launch permission. */
  assertCurrent(context: Omit<PrivateRecoveryRunnerContextV1, "signal">): void;
}>;

type Captured = Readonly<{
  releaseRoot: string;
  releaseDigest: string;
  requestDigest: string;
  nativeHost: Pin;
  reviewedFiles: ReviewedFiles;
  executables: Executables;
  toolchainDigest: string;
  operationDeadlineMs: number;
  retirementDeadlineMs: number;
  terminationGraceMs: number;
}>;

function sanitized(kind: "refused" | "uncertain"): Error {
  const error = new Error(`private_recovery_native_execution_host_${kind}`);
  error.stack = undefined;
  return error;
}
const refuse = (): never => { throw sanitized("refused"); };
const uncertain = (): never => { throw sanitized("uncertain"); };

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) return refuse();
  return value;
}
function text(value: unknown, maximum = 4096): string {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value, "utf8") > maximum
    || /[\u0000-\u001f\u007f]/u.test(value)) return refuse();
  return value;
}
function absolutePath(value: unknown): string {
  const captured = text(value);
  if (!isAbsolute(captured) || normalize(captured) !== captured || captured === "/" || captured.endsWith("/")) return refuse();
  return captured;
}
function aborted(signal: AbortSignal): boolean {
  try { return Reflect.apply(readAborted, signal, []) as boolean; } catch { return refuse(); }
}
function onAbort(signal: AbortSignal, listener: () => void): void {
  try { Reflect.apply(addEventListener, signal, ["abort", listener, { once: true }]); } catch { return refuse(); }
}
function offAbort(signal: AbortSignal, listener: () => void): void {
  try { Reflect.apply(removeEventListener, signal, ["abort", listener]); } catch { /* already terminal */ }
}
function exactSignal(value: unknown): AbortSignal {
  if (!value || typeof value !== "object" || isHostProxyV1(value)) return refuse();
  aborted(value as AbortSignal);
  return value as AbortSignal;
}
function pin(value: unknown): Pin {
  const input = exactHostDataSnapshotV1(value, ["path", "sha256"]);
  if (!input) return refuse();
  return Object.freeze({ path: absolutePath(input.path), sha256: digest(input.sha256) });
}
function milliseconds(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) return refuse();
  return value as number;
}
function captureConfiguration(value: unknown): Captured {
  const input = exactHostDataSnapshotV1(value, ["schema", "releaseRoot", "releaseDigest", "requestDigest", "nativeHost",
    "reviewedFiles", "executables", "operationDeadlineMs", "retirementDeadlineMs", "terminationGraceMs",
    "isolatedDisposableClusterRequired"]);
  const files = exactHostDataSnapshotV1(input?.reviewedFiles, reviewedPaths);
  const executables = exactHostDataSnapshotV1(input?.executables, executableNames);
  if (!input || !files || !executables || input.schema !== PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1
    || input.isolatedDisposableClusterRequired !== true) return refuse();
  const operationDeadlineMs = milliseconds(input.operationDeadlineMs, 300_000);
  const retirementDeadlineMs = milliseconds(input.retirementDeadlineMs, 30_000);
  const terminationGraceMs = milliseconds(input.terminationGraceMs, 5_000);
  if (terminationGraceMs * 2 >= retirementDeadlineMs) return refuse();
  const releaseRoot = absolutePath(input.releaseRoot);
  const nativeHost = pin(input.nativeHost);
  const reviewedFiles = Object.freeze(Object.fromEntries(reviewedPaths.map(name =>
    [name, digest(files[name])])) as unknown as ReviewedFiles);
  const capturedExecutables = Object.freeze(Object.fromEntries(executableNames.map(name =>
    [name, pin(executables[name])])) as Executables);
  if (new Set([nativeHost.path, ...executableNames.map(name => capturedExecutables[name].path)]).size !== 4) return refuse();
  const releaseDigest = digest(input.releaseDigest), requestDigest = digest(input.requestDigest);
  const toolchainDigest = sha256Digest({ purpose: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
    releaseRoot, releaseDigest, requestDigest, nativeHost, reviewedPaths, reviewedFiles,
    executables: capturedExecutables });
  return Object.freeze({ releaseRoot, releaseDigest: digest(input.releaseDigest),
    requestDigest, nativeHost, reviewedFiles, executables: capturedExecutables, toolchainDigest,
    operationDeadlineMs, retirementDeadlineMs, terminationGraceMs });
}

function method(value: unknown, name: string): (...args: never[]) => unknown {
  const result = dataMethodV1(value, name);
  if (!result || isHostProxyV1(result)) return refuse();
  return result;
}
function capturePorts(value: unknown) {
  const input = exactHostDataSnapshotV1(value, ["verifyExecution", "prepareLaunch", "assertCurrent"]);
  if (!input) return refuse();
  const verifyExecution = method(input, "verifyExecution"), prepareLaunch = method(input, "prepareLaunch"),
    assertCurrent = method(input, "assertCurrent");
  return Object.freeze({
    verifyExecution: (request: PrivateRecoveryNativeExecutionVerificationRequestV1) =>
      Reflect.apply(verifyExecution, value, [request]) as Promise<PrivateRecoveryNativeExecutionVerificationReceiptV1>,
    prepareLaunch: () => Reflect.apply(prepareLaunch, value, []) as PrivateRecoveryNativeExecutionChildV1,
    assertCurrent: (context: Omit<PrivateRecoveryRunnerContextV1, "signal">) =>
      Reflect.apply(assertCurrent, value, [context]),
  });
}

function captureChild(value: unknown) {
  const names = ["start", "ready", "inspectDisposableTargets", "backupDatabaseAndProtectedArtifacts", "restoreExactBackup",
    "verifyRestrictedLogins", "requestClose", "signalProcessGroupTerminate", "signalProcessGroupKill",
    "waitForProcessGroupRetirement"] as const;
  const input = exactHostDataSnapshotV1(value, names);
  if (!input) return uncertain();
  const methods = Object.fromEntries(names.map(name => [name, method(input, name)])) as Record<typeof names[number],
    (...args: never[]) => unknown>;
  const call = <T>(name: typeof names[number], args: unknown[]) => Reflect.apply(methods[name], value, args) as T;
  return Object.freeze({
    start: (request: PrivateRecoveryNativeExecutionLaunchRequestV1) => call<unknown>("start", [request]),
    ready: (signal: AbortSignal) => call<ReturnType<PrivateRecoveryNativeExecutionChildV1["ready"]>>("ready", [signal]),
    inspectDisposableTargets: (signal: AbortSignal) => call<Promise<unknown>>("inspectDisposableTargets", [signal]),
    backupDatabaseAndProtectedArtifacts: (signal: AbortSignal) =>
      call<Promise<unknown>>("backupDatabaseAndProtectedArtifacts", [signal]),
    restoreExactBackup: (inputValue: Readonly<{ databaseDumpDigest: string; artifactInventoryDigest: string }>, signal: AbortSignal) =>
      call<Promise<unknown>>("restoreExactBackup", [inputValue, signal]),
    verifyRestrictedLogins: (signal: AbortSignal) => call<Promise<unknown>>("verifyRestrictedLogins", [signal]),
    requestClose: (signal: AbortSignal) => call<Promise<unknown>>("requestClose", [signal]),
    signalProcessGroupTerminate: () => call<unknown>("signalProcessGroupTerminate", []),
    signalProcessGroupKill: () => call<unknown>("signalProcessGroupKill", []),
    waitForProcessGroupRetirement: (signal: AbortSignal) =>
      call<Promise<PrivateRecoveryNativeProcessGroupReceiptV1>>("waitForProcessGroupRetirement", [signal]),
  });
}

function captureContext(value: unknown) {
  const input = exactHostDataSnapshotV1(value, ["schema", "installationId", "requestDigest", "installationPlanDigest",
    "installationPlanRevision", "topologyPlanDigest", "releaseDigest", "protectedDataBindingDigest",
    "databaseAuthorityOutcomeDigest", "signal"]);
  if (!input || input.schema !== "control-room.private-recovery-installation-binding/v1"
    || typeof input.installationId !== "string" || input.installationId.length < 1 || input.installationId.length > 200
    || !Number.isSafeInteger(input.installationPlanRevision) || (input.installationPlanRevision as number) < 0) return refuse();
  for (const name of ["requestDigest", "installationPlanDigest", "topologyPlanDigest", "releaseDigest",
    "protectedDataBindingDigest", "databaseAuthorityOutcomeDigest"] as const) digest(input[name]);
  const signal = exactSignal(input.signal);
  const { signal: _ignored, ...fields } = input;
  return Object.freeze({ context: Object.freeze(fields) as Omit<PrivateRecoveryRunnerContextV1, "signal">, signal });
}

async function bounded<T>(invoke: (signal: AbortSignal) => T | Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  if (aborted(signal)) return uncertain();
  const local = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancel: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      let finished = false;
      const fail = () => { if (!finished) { finished = true; local.abort(); reject(sanitized("uncertain")); } };
      cancel = fail;
      onAbort(signal, fail);
      if (aborted(signal)) { fail(); return; }
      timer = setTimeout(fail, timeoutMs);
      Promise.resolve().then(() => {
        // Cancellation can arrive after this promise is created but before
        // its microtask runs. Recheck here so a cancelled call never enters
        // the native method merely because it was already queued.
        if (finished || aborted(signal) || local.signal.aborted) throw sanitized("uncertain");
        return invoke(local.signal);
      }).then(result => {
        if (!finished) { finished = true; clearTimeout(timer); aborted(signal) ? reject(sanitized("uncertain")) : resolve(result); }
      }, fail);
    });
  } finally { if (timer) clearTimeout(timer); if (cancel) offAbort(signal, cancel); }
}

function verification(value: unknown, configuration: Captured) {
  const receipt = exactHostDataSnapshotV1(value, ["schema", "outcome", "releaseDigest", "requestDigest",
    "nativeHostSha256", "toolchainDigest", "pinProvenanceVerified", "dependencyContentsVerified", "extendedAclVerified",
    "freshProcessGroupSupported"]);
  if (!receipt || receipt.schema !== PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1 || receipt.outcome !== "verified"
    || receipt.releaseDigest !== configuration.releaseDigest || receipt.requestDigest !== configuration.requestDigest
    || receipt.nativeHostSha256 !== configuration.nativeHost.sha256
    || receipt.toolchainDigest !== configuration.toolchainDigest || receipt.pinProvenanceVerified !== true
    || receipt.dependencyContentsVerified !== true || receipt.extendedAclVerified !== true
    || receipt.freshProcessGroupSupported !== true) return refuse();
}
function ready(value: unknown) {
  const receipt = exactHostDataSnapshotV1(value, ["schema", "ready", "freshProcessGroup", "credentialsPrivate",
    "protectedBackupDestinationHeld", "operationEntered"]);
  if (!receipt || receipt.schema !== PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1 || receipt.ready !== true
    || receipt.freshProcessGroup !== true || receipt.credentialsPrivate !== true
    || receipt.protectedBackupDestinationHeld !== true || receipt.operationEntered !== false) return uncertain();
}
function isolatedTarget(value: unknown): unknown {
  const target = exactHostDataSnapshotV1(value, ["sourceTargetDigest", "disposableTargetDigest", "sourceReadOnly",
    "disposableTargetEmpty", "disposableTargetOwned", "protectedRestoreTargetEmpty", "clusterRolesIsolated",
    "sourceQuiesced"]);
  if (!target || digest(target.sourceTargetDigest) === digest(target.disposableTargetDigest)
    || target.sourceReadOnly !== true || target.disposableTargetEmpty !== true || target.disposableTargetOwned !== true
    || target.protectedRestoreTargetEmpty !== true || target.clusterRolesIsolated !== true
    || target.sourceQuiesced !== true) return refuse();
  return Object.freeze(target);
}
function cleanupReceipt(value: unknown) {
  const receipt = exactHostDataSnapshotV1(value, ["retired", "backupRetained", "sourceUnchanged",
    "disposableTargetAccountedFor"]);
  if (!receipt || receipt.retired !== true || receipt.backupRetained !== true || receipt.sourceUnchanged !== true
    || receipt.disposableTargetAccountedFor !== true) return uncertain();
  return Object.freeze({ retired: true as const, backupRetained: true as const, sourceUnchanged: true as const,
    disposableTargetAccountedFor: true as const });
}
function retirementReceipt(value: unknown) {
  const receipt = exactHostDataSnapshotV1(value, ["schema", "processGroupRetired", "leaderReaped", "descendantsReaped"]);
  if (!receipt || receipt.schema !== PRIVATE_RECOVERY_NATIVE_PROCESS_GROUP_RECEIPT_V1
    || receipt.processGroupRetired !== true || receipt.leaderReaped !== true || receipt.descendantsReaped !== true) return uncertain();
}

/**
 * Creates the one narrow process/session port consumed by the existing
 * recovery rehearsal adapter. Construction is inert and there is deliberately
 * no default launcher. The injected native implementation owns all private
 * targets and credentials and must implement the fixed protocol; this host
 * owns one fixed argv, one fresh process group and bounded retirement.
 */
export function createPrivateRecoveryNativeExecutionHostV1(configurationValue: unknown,
  portsValue: unknown): PrivateRecoveryRehearsalPortsV1 {
  const configuration = captureConfiguration(configurationValue), ports = capturePorts(portsValue);
  let opened = false;
  return Object.freeze({
    async open(contextValue: PrivateRecoveryRunnerContextV1): Promise<PrivateRecoveryRehearsalSessionV1> {
      if (opened) return refuse();
      const captured = captureContext(contextValue);
      if (captured.context.requestDigest !== configuration.requestDigest
        || captured.context.releaseDigest !== configuration.releaseDigest || aborted(captured.signal)) return refuse();
      opened = true;
      verification(await bounded(signal => ports.verifyExecution(Object.freeze({
        schema: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1, releaseRoot: configuration.releaseRoot,
        releaseDigest: configuration.releaseDigest, requestDigest: configuration.requestDigest,
        nativeHost: configuration.nativeHost, reviewedFiles: configuration.reviewedFiles,
        executables: configuration.executables, toolchainDigest: configuration.toolchainDigest, signal,
      })), captured.signal, configuration.operationDeadlineMs), configuration);
      if (aborted(captured.signal)) return refuse();
      const launchRequest = Object.freeze({ schema: PRIVATE_RECOVERY_NATIVE_EXECUTION_HOST_V1,
        executablePath: configuration.nativeHost.path, argv: privateRecoveryNativeFixedArgvV1,
        cwd: configuration.releaseRoot, shell: false as const, environmentMode: "replace" as const,
        environment: Object.freeze({ NODE_ENV: "production" as const, LANG: "C" as const, LC_ALL: "C" as const }),
        freshProcessGroup: true as const, credentialsOnArgv: false as const, sourceTargetReadOnlyRequired: true as const,
        isolatedDisposableClusterRequired: true as const, releaseDigest: configuration.releaseDigest,
        requestDigest: configuration.requestDigest, nativeHostSha256: configuration.nativeHost.sha256,
        toolchainDigest: configuration.toolchainDigest,
        reviewedToolPaths: reviewedPaths, reviewedFiles: configuration.reviewedFiles,
        executables: configuration.executables, context: captured.context });
      let child: ReturnType<typeof captureChild>;
      // The complete lifecycle surface is captured while dormant. A native
      // implementation may create a process only when start is called below.
      try { child = captureChild(ports.prepareLaunch()); }
      catch { return uncertain(); }

      const lifecycle = new AbortController();
      let stage: "initial" | "inspected" | "backed_up" | "reinspected" | "restored" | "verified" | "closed" = "initial";
      let busy = false, poisoned = false, retirement: Promise<ReturnType<typeof cleanupReceipt>> | undefined;
      const cancel = () => { lifecycle.abort(); void retire().catch(() => {}); };

      function joinedOperationSignal(operationSignal: AbortSignal) {
        const linked = new AbortController(), abort = () => linked.abort();
        onAbort(operationSignal, abort); onAbort(captured.signal, abort); onAbort(lifecycle.signal, abort);
        if (aborted(operationSignal) || aborted(captured.signal) || lifecycle.signal.aborted) linked.abort();
        return Object.freeze({ signal: linked.signal, release() {
          offAbort(operationSignal, abort); offAbort(captured.signal, abort); offAbort(lifecycle.signal, abort);
        } });
      }

      async function waitForRetirement(timeoutMs: number): Promise<boolean> {
        if (timeoutMs < 1) return false;
        const signal = new AbortController();
        try {
          const value = await bounded(boundedSignal => child.waitForProcessGroupRetirement(boundedSignal), signal.signal, timeoutMs);
          retirementReceipt(value); return true;
        } catch { signal.abort(); return false; }
      }
      async function retire(): Promise<ReturnType<typeof cleanupReceipt>> {
        if (retirement) return retirement;
        lifecycle.abort(); stage = "closed";
        retirement = (async () => {
          const retirementEndsAt = performance.now() + configuration.retirementDeadlineMs;
          const remaining = (cap?: number) => {
            const available = Math.floor(retirementEndsAt - performance.now());
            return Math.max(0, cap === undefined ? available : Math.min(cap, available));
          };
          // Divide the still-available budget among the remaining bounded
          // waits. This deliberately reserves a final slice for KILL + reap;
          // an earlier close or TERM wait may not consume the entire deadline.
          const phaseBudget = (remainingWaits: number) => {
            const available = remaining();
            return available < remainingWaits ? 0
              : Math.min(configuration.terminationGraceMs, Math.floor(available / remainingWaits));
          };
          let cleanup: ReturnType<typeof cleanupReceipt> | undefined;
          try {
            const closeSignal = new AbortController();
            const budget = phaseBudget(4);
            if (budget < 1) poisoned = true;
            else cleanup = cleanupReceipt(await bounded(signal => child.requestClose(signal), closeSignal.signal, budget));
          } catch { poisoned = true; }
          let retired = await waitForRetirement(phaseBudget(3));
          if (!retired) {
            poisoned = true;
            try { assertSynchronousFence(() => child.signalProcessGroupTerminate(), uncertain); } catch { /* continue to KILL */ }
            retired = await waitForRetirement(phaseBudget(2));
          }
          if (!retired) {
            // KILL is best-effort even if event-loop delay exhausted the
            // observation budget. Lack of time can withhold clean success,
            // but must never suppress the strongest retirement request.
            try { assertSynchronousFence(() => child.signalProcessGroupKill(), uncertain); } catch { /* reap remains authoritative */ }
            retired = await waitForRetirement(remaining());
          }
          offAbort(captured.signal, cancel);
          if (!retired || !cleanup || poisoned) return uncertain();
          return cleanup;
        })();
        return retirement;
      }
      async function invoke<T, R = T>(expected: typeof stage, next: typeof stage, operationSignalValue: unknown,
        call: (signal: AbortSignal) => Promise<T>, validate: (value: T) => R = value => value as unknown as R,
        validationFailure: "refused" | "uncertain" = "uncertain"): Promise<R> {
        const operationSignal = exactSignal(operationSignalValue);
        if (busy || poisoned || stage !== expected || aborted(captured.signal) || lifecycle.signal.aborted
          || aborted(operationSignal)) return refuse();
        const linked = joinedOperationSignal(operationSignal);
        if (linked.signal.aborted || aborted(operationSignal) || lifecycle.signal.aborted) {
          linked.release(); return refuse();
        }
        busy = true;
        try {
          let result: T;
          try {
            result = await bounded(signal => {
              // This is the final check at the native-call boundary.
              if (signal.aborted || linked.signal.aborted || aborted(operationSignal)
                || lifecycle.signal.aborted || aborted(captured.signal)) return uncertain();
              return call(signal);
            }, linked.signal, configuration.operationDeadlineMs);
          } catch {
            poisoned = true; await retire().catch(() => {}); return uncertain();
          }
          if (linked.signal.aborted || aborted(operationSignal) || lifecycle.signal.aborted || aborted(captured.signal)) {
            poisoned = true; await retire().catch(() => {}); return uncertain();
          }
          let checked: R;
          try { checked = validate(result); }
          catch {
            poisoned = true;
            await retire().catch(() => {});
            throw sanitized(validationFailure);
          }
          if (linked.signal.aborted || aborted(operationSignal) || lifecycle.signal.aborted || aborted(captured.signal)) {
            poisoned = true; await retire().catch(() => {}); return uncertain();
          }
          stage = next; return checked;
        } finally { linked.release(); busy = false; }
      }
      if (aborted(captured.signal)) {
        try { await retire(); } catch { return uncertain(); }
        return refuse();
      }
      try { assertSynchronousFence(() => ports.assertCurrent(captured.context), refuse); }
      catch {
        try { await retire(); } catch { return uncertain(); }
        return refuse();
      }
      if (aborted(captured.signal)) {
        try { await retire(); } catch { return uncertain(); }
        return refuse();
      }
      onAbort(captured.signal, cancel);
      if (aborted(captured.signal)) cancel();
      try {
        if (lifecycle.signal.aborted) { await retire().catch(() => {}); return refuse(); }
        assertSynchronousFence(() => child.start(launchRequest), uncertain);
        if (aborted(captured.signal) || lifecycle.signal.aborted) { await retire().catch(() => {}); return uncertain(); }
        await invoke("initial", "initial", lifecycle.signal, signal => child.ready(signal), value => { ready(value); return value; });
      } catch { await retire().catch(() => {}); throw uncertain(); }

      return Object.freeze({
        async inspectDisposableTargets(signalValue) {
          if (stage === "initial") return invoke("initial", "inspected", signalValue,
            signal => child.inspectDisposableTargets(signal), isolatedTarget, "refused");
          if (stage === "backed_up") return invoke("backed_up", "reinspected", signalValue,
            signal => child.inspectDisposableTargets(signal), isolatedTarget, "uncertain");
          return refuse();
        },
        async backupDatabaseAndProtectedArtifacts(signalValue) {
          return invoke("inspected", "backed_up", signalValue,
            signal => child.backupDatabaseAndProtectedArtifacts(signal));
        },
        async restoreExactBackup(inputValue, signalValue) {
          const input = exactHostDataSnapshotV1(inputValue, ["databaseDumpDigest", "artifactInventoryDigest"]);
          if (!input) return refuse();
          const selected = Object.freeze({ databaseDumpDigest: digest(input.databaseDumpDigest),
            artifactInventoryDigest: digest(input.artifactInventoryDigest) });
          return invoke("reinspected", "restored", signalValue, signal => child.restoreExactBackup(selected, signal));
        },
        async verifyRestrictedLogins(signalValue) {
          return invoke("restored", "verified", signalValue, signal => child.verifyRestrictedLogins(signal));
        },
        async close(signalValue) {
          let closeSignal: AbortSignal;
          try { closeSignal = exactSignal(signalValue); }
          catch { await retire().catch(() => {}); return uncertain(); }
          let cancelled = aborted(closeSignal);
          const markCancelled = () => { cancelled = true; };
          onAbort(closeSignal, markCancelled);
          try {
            const result = await retire();
            if (cancelled || aborted(closeSignal)) return uncertain();
            return result;
          } finally { offAbort(closeSignal, markCancelled); }
        },
      });
    },
  });
}
