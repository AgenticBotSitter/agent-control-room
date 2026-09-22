import { types } from "node:util";
import { createPrivateLocalInstallationOperatorV1,
  PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1 } from "./private-local-installation-operator";
import { startPrivateHostLifecycle } from "../../web/v1/private-host-lifecycle";

/**
 * Narrow, source-only command facade for an already-installed private setup.
 * It deliberately has no configuration path, environment selector, shell
 * command, browser action, retry loop, or background polling mode.  A later
 * owner-attended custody boundary supplies one exact loaded configuration and
 * the existing canonical installation journal.
 */
export const PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1 =
  "control-room.private-local-installation-operator-cli/v1" as const;

export type PrivateLocalInstallationOperatorCommandV1 = "status" | "setup-next" | "start";

type Operator = Readonly<{
  status(signal?: AbortSignal): Promise<unknown>;
  setupNext(signal?: AbortSignal): Promise<unknown>;
  start(signal?: AbortSignal): Promise<unknown>;
}> | Readonly<{ status: "blocked" }>;

type InstalledConfiguration = Readonly<{ custody: unknown; journal: unknown }>;
type SignalSource = Readonly<{ on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown }>;
type Lifecycle = Readonly<{ ready: Promise<Readonly<{ close(): Promise<void> }>>;
  completed: Promise<Readonly<{ status: "closed" | "cleanup_uncertain" }>> }>;
export type PrivateLocalInstallationOperatorCliRuntimeV1 = Readonly<{
  loadInstalledConfiguration(): Promise<unknown>;
  report(message: string): void;
  reportError(message: string): void;
  signals: SignalSource;
  /** Fixed in-process test seam. It is never selected by CLI input. */
  createOperator?(custody: unknown, runtime: Readonly<{ journal: unknown }>): Operator;
  startLifecycle?(input: Readonly<{ start(signal: AbortSignal): Promise<Readonly<{ close(): Promise<void> }>>;
    signals: SignalSource }>): Lifecycle;
}>;

const stages = new Set(["database_authority", "protected_data", "first_owner", "recovery",
  "platform_service", "agent_readiness", "final_review", "complete"]);
const blockers = new Set(["private_configuration_custody_missing", "native_service_custody_missing"]);

const refusal = (): never => {
  const error = new Error("private_local_installation_operator_cli_refused");
  error.stack = undefined;
  throw error;
};

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return refusal();
  const keys = Object.getOwnPropertyNames(value);
  if (keys.length !== names.length || keys.some(key => !names.includes(key))
    || names.some(key => !Object.prototype.hasOwnProperty.call(value, key)) || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor || descriptor.enumerable !== true || !("value" in descriptor);
    })) return refusal();
  return value as Readonly<Record<string, unknown>>;
}

export function parsePrivateLocalInstallationOperatorArgumentsV1(args: unknown):
  | Readonly<{ help: true }>
  | Readonly<{ command: PrivateLocalInstallationOperatorCommandV1 }> {
  if (!Array.isArray(args) || Object.getPrototypeOf(args) !== Array.prototype || Object.getOwnPropertySymbols(args).length !== 0)
    return refusal();
  const names = Object.getOwnPropertyNames(args);
  if (names.length !== args.length + 1 || names[args.length] !== "length" || args.some(value => typeof value !== "string")) return refusal();
  if (args.length === 1 && args[0] === "--help") return Object.freeze({ help: true });
  if (args.length === 1 && (args[0] === "status" || args[0] === "setup-next" || args[0] === "start"))
    return Object.freeze({ command: args[0] });
  return refusal();
}

function captureRuntime(value: unknown): PrivateLocalInstallationOperatorCliRuntimeV1 {
  const runtime = exact(value, ["loadInstalledConfiguration", "report", "reportError", "signals", "createOperator", "startLifecycle"]);
  if (typeof runtime.loadInstalledConfiguration !== "function" || typeof runtime.report !== "function"
    || typeof runtime.reportError !== "function") return refusal();
  const signals = captureSignals(runtime.signals);
  if (runtime.createOperator !== undefined && typeof runtime.createOperator !== "function") return refusal();
  if (runtime.startLifecycle !== undefined && typeof runtime.startLifecycle !== "function") return refusal();
  return Object.freeze({
    loadInstalledConfiguration: (runtime.loadInstalledConfiguration as () => Promise<unknown>).bind(value),
    report: (runtime.report as (message: string) => void).bind(value),
    reportError: (runtime.reportError as (message: string) => void).bind(value),
    signals,
    ...(runtime.createOperator === undefined ? {} : { createOperator: runtime.createOperator as PrivateLocalInstallationOperatorCliRuntimeV1["createOperator"] }),
    ...(runtime.startLifecycle === undefined ? {} : { startLifecycle: runtime.startLifecycle as PrivateLocalInstallationOperatorCliRuntimeV1["startLifecycle"] }),
  });
}

function captureInstalled(value: unknown): InstalledConfiguration {
  const installed = exact(value, ["custody", "journal"]);
  return Object.freeze({ custody: installed.custody, journal: installed.journal });
}

function captureSignals(value: unknown): SignalSource {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refusal();
  const on = (value as { on?: unknown }).on, off = (value as { off?: unknown }).off;
  if (typeof on !== "function" || typeof off !== "function") return refusal();
  return Object.freeze({ on: on.bind(value) as SignalSource["on"], off: off.bind(value) as SignalSource["off"] });
}

function output(command: PrivateLocalInstallationOperatorCommandV1, result: unknown) {
  if (!result || typeof result !== "object" || Array.isArray(result) || types.isProxy(result)) return refusal();
  const value = result as Record<string, unknown>;
  if (value.status === "blocked" && typeof value.blocker === "string" && blockers.has(value.blocker)) {
    return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1, command, status: "blocked" as const,
      blocker: value.blocker, startsService: false as const, startsWorker: false as const, opensBrowser: false as const });
  }
  if (command === "status" && value.status === "ready" && typeof value.nextStage === "string" && stages.has(value.nextStage)) {
    return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1, command, status: "ready" as const,
      nextStage: value.nextStage, startsService: false as const, startsWorker: false as const, opensBrowser: false as const });
  }
  if (command === "setup-next" && value.status === "complete") {
    return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1, command, status: "complete" as const,
      startsService: false as const, startsWorker: false as const, opensBrowser: false as const });
  }
  if (command === "setup-next" && value.status === "completed" && typeof value.requestedStage === "string" && stages.has(value.requestedStage)) {
    return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1, command, status: "completed" as const,
      completedStage: value.requestedStage, startsService: value.requestedStage === "platform_service",
      startsWorker: false as const, opensBrowser: false as const });
  }
  if (command === "start") {
    // Do not serialize the private bootstrap/service object. A resolved start
    // is the only safe public fact the connector exposes.
    return Object.freeze({ schema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_V1, command, status: "started" as const,
      opensBrowser: false as const });
  }
  return refusal();
}

/** Runs exactly one named operation. No outcome is retried by this facade. */
export async function runPrivateLocalInstallationOperatorCliV1(args: unknown, runtimeValue: unknown): Promise<number> {
  let runtime: PrivateLocalInstallationOperatorCliRuntimeV1;
  try { runtime = captureRuntime(runtimeValue); }
  catch { return 2; }
  let parsed: ReturnType<typeof parsePrivateLocalInstallationOperatorArgumentsV1>;
  try { parsed = parsePrivateLocalInstallationOperatorArgumentsV1(args); }
  catch {
    runtime.reportError("Control Room operator command refused its arguments.");
    return 2;
  }
  if ("help" in parsed) {
    runtime.report("Usage: node scripts/run-private-local-installation-operator.mjs (status | setup-next | start)\n");
    runtime.report("Reads one installed private configuration. It does not accept paths, commands, environment factories, or browser actions.\n");
    return 0;
  }
  try {
    const installed = captureInstalled(await runtime.loadInstalledConfiguration());
    const operator = runtime.createOperator?.(installed.custody, Object.freeze({ journal: installed.journal }))
      ?? createPrivateLocalInstallationOperatorV1(installed.custody, Object.freeze({ journal: installed.journal }));
    let result: unknown;
    if (operator.status === "blocked") result = operator;
    else if (parsed.command === "start") {
      // The existing lifecycle owns the exact bootstrap result and calls its
      // close method once on termination. It registers its handlers before
      // start, including the race where SIGTERM arrives as start resolves.
      let blockedStart: unknown;
      const lifecycle = (runtime.startLifecycle ?? startPrivateHostLifecycle)({ signals: runtime.signals,
        start: async signal => {
          const started = await operator.start(signal);
          if (started && typeof started === "object" && !Array.isArray(started)
            && (started as { status?: unknown }).status === "blocked") {
            // This is an admission result, not a host. Preserve it for the
            // caller and force the lifecycle down its no-host cleanup path.
            blockedStart = started;
            throw new Error("private_local_installation_operator_start_blocked");
          }
          if (!started || typeof started !== "object" || Array.isArray(started)
            || typeof (started as { close?: unknown }).close !== "function") throw new Error();
          return started as Readonly<{ close(): Promise<void> }>;
        } });
      try { await lifecycle.ready; }
      catch {
        // The lifecycle has already claimed ownership of a late start result;
        // wait for its one cleanup/detach path before reporting failure.
        await lifecycle.completed;
        if (blockedStart !== undefined) {
          runtime.report(`${JSON.stringify(output(parsed.command, blockedStart))}\n`);
          return 0;
        }
        throw new Error();
      }
      const completed = await lifecycle.completed;
      if (completed.status !== "closed") throw new Error();
      result = Object.freeze({ status: "started" });
    } else result = await operator[parsed.command === "status" ? "status" : "setupNext"]();
    runtime.report(`${JSON.stringify(output(parsed.command, result))}\n`);
    return 0;
  } catch {
    runtime.reportError("Control Room operator command did not complete; private configuration and saved setup state remain protected.");
    return 1;
  }
}

export const PRIVATE_LOCAL_INSTALLATION_OPERATOR_CLI_DEPENDENCY_V1 = Object.freeze({
  operatorSchema: PRIVATE_LOCAL_INSTALLATION_OPERATOR_V1,
});
