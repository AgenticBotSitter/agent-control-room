import { z } from "zod";
import { createMacosLocalServicePackageV1,
  type MacosLocalServicePackageV1 } from "../../harness/v1/macos-local-service-package";
import { sha256Digest } from "../../security/canonical-digest";
import { verifyPlatformServiceLifecycleV1,
  type PlatformServiceLifecycleV1 } from "./platform-service-lifecycle";

export const MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1 = "control-room.macos-service-owner-action-simulation/v1" as const;

type LifecycleInput = Parameters<typeof verifyPlatformServiceLifecycleV1>[1];
type LifecycleStep = PlatformServiceLifecycleV1["steps"][number];
type ServicePackageInput = Parameters<typeof createMacosLocalServicePackageV1>[0];

export type MacosServiceRunnerRequestV1 = Readonly<{
  schema: typeof MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1;
  lifecycleDigest: string;
  action: PlatformServiceLifecycleV1["action"];
  phase: "primary" | "rollback";
  operation: LifecycleStep["operation"];
  kind: LifecycleStep["kind"];
  timeoutSeconds: number;
  label: string;
  releaseDigest?: string;
  serviceDefinition?: MacosLocalServicePackageV1;
}>;

export type MacosServiceRunnerResultV1 = Readonly<{
  outcome: "succeeded" | "failed" | "uncertain";
}>;

export type MacosServiceOwnerActionRunnerV1 =
  (request: MacosServiceRunnerRequestV1) => Promise<MacosServiceRunnerResultV1>;

export type MacosServiceOwnerActionReportV1 = Readonly<{
  schema: typeof MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1;
  lifecycleDigest: string;
  action: PlatformServiceLifecycleV1["action"];
  outcome: "completed" | "failed" | "rolled_back" | "uncertain";
  primaryStepsCompleted: number;
  rollbackStepsCompleted: number;
  usedInjectedRunner: true;
  simulationOnly: true;
  ownerApprovalRecordBound: false;
  durableReplayProtected: false;
  persistedState: false;
  grantsAgentReadiness: false;
}>;

const runnerResult = z.object({ outcome: z.enum(["succeeded", "failed", "uncertain"]) }).strict();
const refuse = (): never => { throw new Error("macos_service_owner_action_refused"); };

function packageDigest(package_: MacosLocalServicePackageV1) {
  return sha256Digest(package_.plist);
}

/** Binds the planner's opaque service identity to this owner's launchd label. */
export function macosServiceIdentityDigestV1(servicePackageInput: ServicePackageInput) {
  const package_ = createMacosLocalServicePackageV1(servicePackageInput);
  return sha256Digest({ purpose: "macos-service-identity/v1", label: package_.label });
}

function assertPackageBindings(lifecycle: PlatformServiceLifecycleV1, current: MacosLocalServicePackageV1,
  previous: MacosLocalServicePackageV1 | undefined) {
  const currentDigest = packageDigest(current);
  if ((lifecycle.action === "install" || lifecycle.action === "update")
    && lifecycle.targetServiceDefinitionDigest !== currentDigest) refuse();
  if (lifecycle.action !== "install" && lifecycle.action !== "update"
    && lifecycle.observation.installedServiceDefinitionDigest !== undefined
    && lifecycle.observation.installedServiceDefinitionDigest !== currentDigest) refuse();
  if (lifecycle.action === "update") {
    if (!previous || lifecycle.previousServiceDefinitionDigest !== packageDigest(previous)
      || previous.label !== current.label) refuse();
  } else if (previous !== undefined) refuse();
}

function requestForStep(lifecycle: PlatformServiceLifecycleV1, step: LifecycleStep,
  phase: "primary" | "rollback", current: MacosLocalServicePackageV1,
  previous: MacosLocalServicePackageV1 | undefined): MacosServiceRunnerRequestV1 {
  const serviceDefinition = step.operation === "install_service_definition" ? current
    : step.operation === "restore_verified_service_definition" ? previous : undefined;
  const releaseDigest = step.operation === "switch_release_pointer" ? lifecycle.targetReleaseDigest
    : step.operation === "restore_verified_release_pointer" ? lifecycle.previousVerifiedReleaseDigest : undefined;
  if ((step.operation === "restore_verified_service_definition" && !serviceDefinition)
    || ((step.operation === "switch_release_pointer" || step.operation === "restore_verified_release_pointer") && !releaseDigest)) refuse();
  return Object.freeze({ schema: MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1, lifecycleDigest: lifecycle.lifecycleDigest,
    action: lifecycle.action, phase, operation: step.operation, kind: step.kind,
    timeoutSeconds: step.timeoutSeconds ?? 30, label: current.label,
    ...(releaseDigest === undefined ? {} : { releaseDigest }),
    ...(serviceDefinition === undefined ? {} : { serviceDefinition }) });
}

function report(lifecycle: PlatformServiceLifecycleV1, outcome: MacosServiceOwnerActionReportV1["outcome"],
  primaryStepsCompleted: number, rollbackStepsCompleted: number): MacosServiceOwnerActionReportV1 {
  return Object.freeze({ schema: MACOS_SERVICE_OWNER_ACTION_SIMULATION_V1, lifecycleDigest: lifecycle.lifecycleDigest,
    action: lifecycle.action, outcome, primaryStepsCompleted, rollbackStepsCompleted,
    usedInjectedRunner: true, simulationOnly: true, ownerApprovalRecordBound: false,
    durableReplayProtected: false, persistedState: false, grantsAgentReadiness: false });
}

async function invoke(runner: MacosServiceOwnerActionRunnerV1, request: MacosServiceRunnerRequestV1) {
  try { return runnerResult.parse(await runner(request)); }
  catch { return { outcome: "uncertain" as const }; }
}

/**
 * Simulates one already-planned macOS lifecycle action with an injected test
 * runner. This module imports no filesystem, process or launchd API. It owns no
 * approval record, journal, replay receipt or service state, so it is not a
 * production owner-action boundary.
 *
 * A runner may report `failed` only when it knows the named step did not take
 * effect. Throws and malformed results are uncertainty and are never retried.
 */
export async function simulateMacosServiceOwnerActionV1(input: Readonly<{
  ownerAuthorized: true;
  lifecycle: unknown;
  lifecycleInput: LifecycleInput;
  servicePackageInput: ServicePackageInput;
  previousServicePackageInput?: ServicePackageInput;
}>, dependencies: Readonly<{ runner: MacosServiceOwnerActionRunnerV1 }>): Promise<MacosServiceOwnerActionReportV1> {
  let lifecycle: PlatformServiceLifecycleV1, current: MacosLocalServicePackageV1,
    previous: MacosLocalServicePackageV1 | undefined;
  try {
    if (!input || input.ownerAuthorized !== true || typeof dependencies?.runner !== "function") return refuse();
    lifecycle = verifyPlatformServiceLifecycleV1(input.lifecycle, input.lifecycleInput);
    if (lifecycle.platform !== "macos_launchd") return refuse();
    current = createMacosLocalServicePackageV1(input.servicePackageInput);
    previous = input.previousServicePackageInput === undefined ? undefined
      : createMacosLocalServicePackageV1(input.previousServicePackageInput);
    if (lifecycle.serviceIdentityDigest !== macosServiceIdentityDigestV1(input.servicePackageInput)) refuse();
    assertPackageBindings(lifecycle, current, previous);
  } catch { return refuse(); }

  let primaryStepsCompleted = 0;
  let oldServiceStopped = false;
  for (const step of lifecycle.steps) {
    const result = await invoke(dependencies.runner, requestForStep(lifecycle, step, "primary", current, previous));
    if (result.outcome === "uncertain") return report(lifecycle, "uncertain", primaryStepsCompleted, 0);
    if (result.outcome === "failed") {
      if (lifecycle.action !== "update" || !oldServiceStopped) return report(lifecycle, "failed", primaryStepsCompleted, 0);
      let rollbackStepsCompleted = 0;
      for (const rollbackStep of lifecycle.rollbackSteps) {
        const rollback = await invoke(dependencies.runner,
          requestForStep(lifecycle, rollbackStep, "rollback", current, previous));
        if (rollback.outcome !== "succeeded") return report(lifecycle, "uncertain", primaryStepsCompleted, rollbackStepsCompleted);
        rollbackStepsCompleted += 1;
      }
      return report(lifecycle, "rolled_back", primaryStepsCompleted, rollbackStepsCompleted);
    }
    primaryStepsCompleted += 1;
    if (step.operation === "stop_service" && lifecycle.action === "update") oldServiceStopped = true;
  }
  return report(lifecycle, "completed", primaryStepsCompleted, 0);
}
