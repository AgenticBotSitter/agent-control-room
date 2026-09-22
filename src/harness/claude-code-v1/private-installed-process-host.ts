import { z } from "zod";
import { isHostProxyV1, dataMethodV1 } from "../../security/host-value";
import { assertSynchronousFence } from "../../security/synchronous-fence";
import { digestSchema } from "../v1/native-run-identifiers";
import type { ClaudeCodeProcessBindingV1, ClaudeCodeProcessBytePortV1,
  OwnedClaudeCodeProcessV1 } from "./owned-process-session";
import { capturePrivateClaudeCodeInstalledProcessHostConfigurationV1,
  type PrivateClaudeCodeInstalledProcessHostConfigurationV1 } from "./private-process-acquisition";

export const CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1 =
  "control-room.claude-code-private-installed-process-host/v1" as const;

type CapturedConfiguration = ReturnType<typeof capturePrivateClaudeCodeInstalledProcessHostConfigurationV1>;

export type PrivateClaudeCodeInstalledProcessVerificationRequestV1 = Readonly<{
  schema: typeof CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1;
  executablePath: string;
  executableSha256: string;
  workingDirectory: string;
  workingDirectoryBindingDigest: string;
  qualificationDigest: string;
  signal: AbortSignal;
}>;

export type PrivateClaudeCodeInstalledProcessLaunchRequestV1 = Readonly<{
  schema: typeof CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1;
  executablePath: string;
  args: readonly string[];
  workingDirectory: string;
  executableSha256: string;
  workingDirectoryBindingDigest: string;
  qualificationDigest: string;
  binding: ClaudeCodeProcessBindingV1;
}>;

export interface PrivateClaudeCodeNativeChildV1 {
  writeStdin(bytes: Uint8Array, signal: AbortSignal): Promise<void>;
  readStdout(signal: AbortSignal): Promise<Uint8Array | undefined>;
  readStderr(signal: AbortSignal): Promise<Uint8Array | undefined>;
  closeStdin(signal: AbortSignal): Promise<void>;
  signalTerminate(signal: AbortSignal): Promise<void>;
  signalKill(signal: AbortSignal): Promise<void>;
  close(signal: AbortSignal): Promise<void>;
  exited: Promise<Readonly<{ code: number | null; signal: string | null }>>;
}

export interface PrivateClaudeCodeInstalledProcessHostPortsV1 {
  verifyInstallation(request: PrivateClaudeCodeInstalledProcessVerificationRequestV1): Promise<Readonly<{
    schema: typeof CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1;
    outcome: "verified";
    executableSha256: string;
    workingDirectoryBindingDigest: string;
    qualificationDigest: string;
  }>>;
  /** Must synchronously return ownership or throw before a child exists. */
  launch(request: PrivateClaudeCodeInstalledProcessLaunchRequestV1): PrivateClaudeCodeNativeChildV1;
}

export interface PrivateClaudeCodeInstalledProcessLaunchAuthorityV1 {
  /** Synchronous retained-authority fence. A promise is never permission to launch. */
  assertCurrent(binding: ClaudeCodeProcessBindingV1): void;
}

const refused = () => new Error("claude_code_private_installed_process_host_refused");
const uncertain = () => new Error("claude_code_private_installed_process_host_uncertain");

function dataMethod(value: unknown, key: PropertyKey): ((...args: never[]) => unknown) | undefined {
  if (!value || typeof value !== "object" || isHostProxyV1(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor && typeof descriptor.value === "function"
    && !isHostProxyV1(descriptor.value) ? descriptor.value : undefined;
}

function dataValue(value: unknown, key: PropertyKey): unknown {
  if (!value || typeof value !== "object" || isHostProxyV1(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function exactKeys(value: unknown, expected: readonly string[]): boolean {
  if (!value || typeof value !== "object" || isHostProxyV1(value)
    || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every(key => keys.includes(key));
}

function captureLaunchAuthority(value: unknown) {
  if (!exactKeys(value, ["assertCurrent"])) throw refused();
  const assertCurrent = dataMethod(value, "assertCurrent");
  if (!assertCurrent) throw refused();
  return Object.freeze({
    assertCurrent: (binding: ClaudeCodeProcessBindingV1) =>
      Reflect.apply(assertCurrent, value, [binding]) as ReturnType<PrivateClaudeCodeInstalledProcessLaunchAuthorityV1["assertCurrent"]>,
  });
}

function capturePorts(value: unknown) {
  if (!exactKeys(value, ["verifyInstallation", "launch"])) throw refused();
  const verify = dataMethod(value, "verifyInstallation"), launch = dataMethod(value, "launch");
  if (!verify || !launch) throw refused();
  return Object.freeze({
    verifyInstallation: (request: PrivateClaudeCodeInstalledProcessVerificationRequestV1) =>
      Reflect.apply(verify, value, [request]) as ReturnType<PrivateClaudeCodeInstalledProcessHostPortsV1["verifyInstallation"]>,
    launch: (request: PrivateClaudeCodeInstalledProcessLaunchRequestV1) =>
      Reflect.apply(launch, value, [request]) as PrivateClaudeCodeNativeChildV1,
  });
}

function captureChild(value: unknown): PrivateClaudeCodeNativeChildV1 {
  const keys = ["writeStdin", "readStdout", "readStderr", "closeStdin", "signalTerminate", "signalKill", "close", "exited"];
  if (!exactKeys(value, keys)) throw uncertain();
  const methods = Object.fromEntries(keys.slice(0, -1).map(key => [key, dataMethod(value, key)]));
  const exited = dataValue(value, "exited");
  if (Object.values(methods).some(method => !method) || !exited || isHostProxyV1(exited)
    || !dataMethodV1(exited, "then"))
    throw uncertain();
  const call = (key: string, args: unknown[]) => Reflect.apply(methods[key]!, value, args as never[]);
  return Object.freeze({
    writeStdin: (bytes: Uint8Array, signal: AbortSignal) => call("writeStdin", [bytes, signal]) as Promise<void>,
    readStdout: (signal: AbortSignal) => call("readStdout", [signal]) as Promise<Uint8Array | undefined>,
    readStderr: (signal: AbortSignal) => call("readStderr", [signal]) as Promise<Uint8Array | undefined>,
    closeStdin: (signal: AbortSignal) => call("closeStdin", [signal]) as Promise<void>,
    signalTerminate: (signal: AbortSignal) => call("signalTerminate", [signal]) as Promise<void>,
    signalKill: (signal: AbortSignal) => call("signalKill", [signal]) as Promise<void>,
    close: (signal: AbortSignal) => call("close", [signal]) as Promise<void>,
    exited: Promise.resolve(exited as Promise<Readonly<{ code: number | null; signal: string | null }>>),
  });
}

function linkAbort(outer: AbortSignal | undefined, controller: AbortController): () => void {
  if (!outer) return () => {};
  const abort = () => controller.abort();
  if (outer.aborted) abort(); else outer.addEventListener("abort", abort, { once: true });
  return () => outer.removeEventListener("abort", abort);
}

async function bounded<T>(start: (signal: AbortSignal) => Promise<T>, deadlineMs: number,
  outer?: AbortSignal, afterLaunch = false): Promise<T> {
  const controller = new AbortController(), unlink = linkAbort(outer, controller);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(afterLaunch ? uncertain() : refused()); }, deadlineMs);
  });
  try {
    if (controller.signal.aborted) throw afterLaunch ? uncertain() : refused();
    const work = Promise.resolve().then(() => start(controller.signal));
    void work.catch(() => {});
    return await Promise.race([work, timeout]);
  } catch { throw afterLaunch ? uncertain() : refused(); }
  finally { clearTimeout(timer); unlink(); controller.abort(); }
}

function validExit(value: unknown): value is Readonly<{ code: number | null; signal: string | null }> {
  if (!exactKeys(value, ["code", "signal"])) return false;
  const code = dataValue(value, "code"), signal = dataValue(value, "signal");
  return Number.isSafeInteger(code) && signal === null
    || code === null && typeof signal === "string" && signal.length > 0 && signal.length <= 64;
}

/**
 * Composes already-reviewed, data-only installation settings with injected
 * native verification and launch ports. There is deliberately no default
 * child-process implementation: tests use fakes and live installation remains
 * unsupported until an owner-attended qualification approves that separate port.
 */
export function createPrivateClaudeCodeInstalledProcessHostV1(configurationValue: unknown,
  portsValue: unknown, launchAuthorityValue: unknown) {
  const configuration = capturePrivateClaudeCodeInstalledProcessHostConfigurationV1(configurationValue);
  const ports = capturePorts(portsValue);
  const launchAuthority = captureLaunchAuthority(launchAuthorityValue);

  const acquire = (bindingValue: ClaudeCodeProcessBindingV1, outer: AbortSignal): OwnedClaudeCodeProcessV1 => {
    const binding = Object.freeze(z.object({ processAttemptId: z.string().min(1), runId: z.string().min(1),
      attemptId: z.string().min(1), invocationDigest: digestSchema }).strict().parse(bindingValue));
    if (!(outer instanceof AbortSignal) || outer.aborted) throw refused();
    const lifecycle = new AbortController();
    let unlink = () => {};
    let closed = false, child: PrivateClaudeCodeNativeChildV1 | undefined, retirement: Promise<void> | undefined;

    const retire = async (): Promise<void> => {
      if (retirement) return retirement;
      closed = true; lifecycle.abort(); unlink();
      // Cancellation may run synchronously inside launch before its returned child
      // can be captured. Do not memoize a no-op: the post-launch fence must still
      // be able to retire that eventual child.
      if (!child) return Promise.resolve();
      const selected = child;
      retirement = (async () => {
        let exitValue: unknown, exited = false;
        const observe = selected.exited.then(value => { exitValue = value; exited = true; return value; });
        void observe.catch(() => {});
        try { await bounded(signal => selected.signalTerminate(signal), configuration.terminateDeadlineMs, undefined, true); }
        catch { /* TERM failure still escalates to KILL. */ }
        if (!exited) {
          try { await bounded(() => observe, configuration.terminateDeadlineMs, undefined, true); }
          catch {
            try { await bounded(signal => selected.signalKill(signal), configuration.killDeadlineMs, undefined, true); }
            catch { /* The reap check below remains authoritative. */ }
            try { await bounded(() => observe, configuration.killDeadlineMs, undefined, true); }
            catch { throw uncertain(); }
          }
        }
        if (!exited || !validExit(exitValue)) throw uncertain();
        await bounded(signal => selected.close(signal), configuration.killDeadlineMs, undefined, true);
      })();
      return retirement;
    };
    const abortOwner = () => { lifecycle.abort(); void retire().catch(() => {}); };
    outer.addEventListener("abort", abortOwner, { once: true });
    unlink = () => outer.removeEventListener("abort", abortOwner);

    const ready = (async (): Promise<ClaudeCodeProcessBytePortV1> => {
      let verified: Awaited<ReturnType<typeof ports.verifyInstallation>>;
      try {
        verified = await bounded(signal => ports.verifyInstallation(Object.freeze({
          schema: CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
          executablePath: configuration.process.executablePath, executableSha256: configuration.executableSha256,
          workingDirectory: configuration.process.workingDirectory,
          workingDirectoryBindingDigest: configuration.workingDirectoryBindingDigest,
          qualificationDigest: configuration.qualificationDigest, signal,
        })),
          configuration.startupDeadlineMs, lifecycle.signal);
      } catch { throw refused(); }
      if (closed || lifecycle.signal.aborted || !exactKeys(verified,
        ["schema", "outcome", "executableSha256", "workingDirectoryBindingDigest", "qualificationDigest"])
        || dataValue(verified, "schema") !== CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1
        || dataValue(verified, "outcome") !== "verified"
        || dataValue(verified, "executableSha256") !== configuration.executableSha256
        || dataValue(verified, "workingDirectoryBindingDigest") !== configuration.workingDirectoryBindingDigest
        || dataValue(verified, "qualificationDigest") !== configuration.qualificationDigest) throw refused();
      const launchRequest = Object.freeze({ schema: CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
        executablePath: configuration.process.executablePath, args: Object.freeze([...configuration.process.args]),
        workingDirectory: configuration.process.workingDirectory, executableSha256: configuration.executableSha256,
        workingDirectoryBindingDigest: configuration.workingDirectoryBindingDigest,
        qualificationDigest: configuration.qualificationDigest, binding });
      try {
        assertSynchronousFence(() => launchAuthority.assertCurrent(binding), () => { throw refused(); });
      } catch { throw refused(); }
      if (closed || lifecycle.signal.aborted) throw refused();
      let launched: unknown;
      try { launched = ports.launch(launchRequest); } catch { throw refused(); }
      try { child = captureChild(launched); } catch { throw uncertain(); }
      if (closed || lifecycle.signal.aborted) { await retire(); throw uncertain(); }
      return Object.freeze({
        writeStdin: (bytes: Uint8Array, signal: AbortSignal) => child!.writeStdin(bytes, signal),
        readStdout: (signal: AbortSignal) => child!.readStdout(signal),
        readStderr: (signal: AbortSignal) => child!.readStderr(signal),
        closeStdin: (signal: AbortSignal) => child!.closeStdin(signal),
        terminate: async () => retire(),
        exited: child.exited,
      });
    })();
    void ready.catch(() => {});
    return Object.freeze({ ready, close: retire });
  };

  return Object.freeze({
    schema: CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
    configuration: Object.freeze({ schema: configuration.schema, qualificationDigest: configuration.qualificationDigest }),
    startsWork: false as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const,
    acquire,
  });
}

export type { PrivateClaudeCodeInstalledProcessHostConfigurationV1 };
