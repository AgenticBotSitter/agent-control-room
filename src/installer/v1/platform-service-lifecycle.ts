import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { summarizeLocalSupervisorReadinessV1, verifyLocalSupervisorReadinessV1 } from "../../harness/v1/local-supervisor-readiness";
import { verifyInstallationPlanV1 } from "./installation-plan";

/**
 * Pure, redacted preparation for the platform service lifecycle.  This module
 * describes an ordered operation but cannot inspect files, invoke a service
 * manager, move a release pointer, or start a process.
 */
export const PLATFORM_SERVICE_LIFECYCLE_V1 = "control-room.platform-service-lifecycle/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const action = z.enum(["status", "install", "stop", "start", "update", "uninstall"]);
const platform = z.enum(["macos_launchd", "linux_systemd"]);
const observedState = z.enum(["not_installed", "stopped", "running", "unknown"]);
const stepOperation = z.enum([
  "inspect_service_status", "verify_supervisor_readiness", "verify_release", "verify_service_definition",
  "pause_admission", "bounded_drain", "stop_service", "install_service_definition", "switch_release_pointer",
  "start_service", "verify_service_health", "remove_service_definition", "retain_authority_database",
  "retain_protected_data", "restore_verified_release_pointer", "restore_verified_service_definition",
]);
const stepKind = z.enum(["read", "administrative_write", "service_transition"]);
const step = z.object({ operation: stepOperation, kind: stepKind, timeoutSeconds: z.number().int().min(1).max(300).optional() }).strict();
const observation = z.object({ state: observedState, activeReleaseDigest: digest.optional(),
  installedServiceDefinitionDigest: digest.optional(), observationDigest: digest }).strict();
const schema = z.object({ schema: z.literal(PLATFORM_SERVICE_LIFECYCLE_V1), action, platform,
  installationPlanDigest: digest, installationPlanRevision: z.number().int().min(0), stage: z.literal("platform_service"),
  stageInputDigest: digest, supervisorReadinessDigest: digest, serviceIdentityDigest: digest,
  authorityDatabaseDigest: digest, protectedDataDigest: digest, observation,
  targetReleaseDigest: digest.optional(), targetServiceDefinitionDigest: digest.optional(),
  previousVerifiedReleaseDigest: digest.optional(), previousServiceDefinitionDigest: digest.optional(),
  steps: z.array(step).min(1), rollbackSteps: z.array(step), lifecycleDigest: digest,
  performsEffect: z.literal(false), startsService: z.literal(false), grantsAgentReadiness: z.literal(false),
  preservesAuthorityDatabase: z.literal(true), preservesProtectedData: z.literal(true) }).strict();

type ParsedLifecycle = z.infer<typeof schema>;
export type PlatformServiceLifecycleV1 = Readonly<Omit<ParsedLifecycle, "observation" | "steps" | "rollbackSteps"> & {
  observation: Readonly<z.infer<typeof observation>>;
  steps: readonly Readonly<z.infer<typeof step>>[];
  rollbackSteps: readonly Readonly<z.infer<typeof step>>[];
}>;
type Input = Readonly<{
  action: unknown;
  platform: unknown;
  installationPlan: unknown;
  supervisorReadiness: unknown;
  serviceIdentityDigest: unknown;
  authorityDatabaseDigest: unknown;
  protectedDataDigest: unknown;
  observation: unknown;
  targetReleaseDigest?: unknown;
  targetServiceDefinitionDigest?: unknown;
  previousVerifiedReleaseDigest?: unknown;
  previousServiceDefinitionDigest?: unknown;
}>;

const refuse = (): never => { throw new Error("platform_service_lifecycle_refused"); };
const read = (operation: z.infer<typeof stepOperation>) => Object.freeze({ operation, kind: "read" as const });
const write = (operation: z.infer<typeof stepOperation>) => Object.freeze({ operation, kind: "administrative_write" as const });
const transition = (operation: z.infer<typeof stepOperation>, timeoutSeconds?: number) => Object.freeze({ operation,
  kind: "service_transition" as const, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) });
const drain = () => transition("bounded_drain", 120);

function validateObservation(value: z.infer<typeof observation>) {
  const needsInstalled = value.state === "running" || value.state === "stopped";
  if (needsInstalled !== (value.activeReleaseDigest !== undefined)
    || needsInstalled !== (value.installedServiceDefinitionDigest !== undefined)) refuse();
  if ((value.state === "not_installed" || value.state === "unknown")
    && (value.activeReleaseDigest !== undefined || value.installedServiceDefinitionDigest !== undefined)) refuse();
}

function completeReadiness(planDigest: string, readinessValue: unknown, requestedAction: z.infer<typeof action>) {
  const readiness = verifyLocalSupervisorReadinessV1(readinessValue);
  if (readiness.planDigest !== planDigest) refuse();
  const summary = summarizeLocalSupervisorReadinessV1(planDigest, readiness);
  if (requestedAction !== "status" && summary.state !== "readiness_recorded") refuse();
  return readiness;
}

function operations(requestedAction: z.infer<typeof action>, state: z.infer<typeof observedState>) {
  if (requestedAction === "status") return { steps: [read("inspect_service_status")], rollbackSteps: [] };
  if (state === "unknown") refuse();
  if (requestedAction === "install") {
    if (state !== "not_installed") refuse();
    return { steps: [read("verify_supervisor_readiness"), read("verify_release"), read("verify_service_definition"),
      write("install_service_definition"), transition("start_service", 120), read("verify_service_health")], rollbackSteps: [] };
  }
  if (requestedAction === "stop") {
    if (state !== "running") refuse();
    return { steps: [read("verify_supervisor_readiness"), write("pause_admission"), drain(), transition("stop_service", 120)], rollbackSteps: [] };
  }
  if (requestedAction === "start") {
    if (state !== "stopped") refuse();
    return { steps: [read("verify_supervisor_readiness"), read("verify_release"), read("verify_service_definition"),
      transition("start_service", 120), read("verify_service_health")], rollbackSteps: [] };
  }
  if (requestedAction === "update") {
    if (state !== "running" && state !== "stopped") refuse();
    return { steps: [read("verify_supervisor_readiness"), read("verify_release"), read("verify_service_definition"),
      write("pause_admission"), drain(), transition("stop_service", 120), write("install_service_definition"),
      write("switch_release_pointer"), transition("start_service", 120), read("verify_service_health")],
    rollbackSteps: [transition("stop_service", 120), write("restore_verified_service_definition"),
      write("restore_verified_release_pointer"), transition("start_service", 120), read("verify_service_health")] };
  }
  if (state !== "running" && state !== "stopped") refuse();
  return { steps: [read("verify_supervisor_readiness"), write("pause_admission"), drain(),
    ...(state === "running" ? [transition("stop_service", 120)] : []), write("remove_service_definition"),
    read("retain_authority_database"), read("retain_protected_data")], rollbackSteps: [] };
}

function parseOptionalDigest(value: unknown) {
  return value === undefined ? undefined : digest.parse(value);
}

export function platformServiceStageInputDigestV1(input: Readonly<{
  action: unknown; platform: unknown; releaseDigest: unknown; serviceIdentityDigest: unknown;
  authorityDatabaseDigest: unknown; protectedDataDigest: unknown; observation: unknown;
  targetReleaseDigest?: unknown; targetServiceDefinitionDigest?: unknown;
  previousVerifiedReleaseDigest?: unknown; previousServiceDefinitionDigest?: unknown;
}>): string {
  const observed = observation.parse(input.observation); validateObservation(observed);
  return sha256Digest({ purpose: "platform-service-stage-input/v1", action: action.parse(input.action),
    platform: platform.parse(input.platform), releaseDigest: digest.parse(input.releaseDigest),
    serviceIdentityDigest: digest.parse(input.serviceIdentityDigest), authorityDatabaseDigest: digest.parse(input.authorityDatabaseDigest),
    protectedDataDigest: digest.parse(input.protectedDataDigest), observation: observed,
    ...(input.targetReleaseDigest === undefined ? {} : { targetReleaseDigest: digest.parse(input.targetReleaseDigest) }),
    ...(input.targetServiceDefinitionDigest === undefined ? {} : { targetServiceDefinitionDigest: digest.parse(input.targetServiceDefinitionDigest) }),
    ...(input.previousVerifiedReleaseDigest === undefined ? {} : { previousVerifiedReleaseDigest: digest.parse(input.previousVerifiedReleaseDigest) }),
    ...(input.previousServiceDefinitionDigest === undefined ? {} : { previousServiceDefinitionDigest: digest.parse(input.previousServiceDefinitionDigest) }) });
}

function material(input: Input): Omit<PlatformServiceLifecycleV1, "lifecycleDigest"> {
  const requestedAction = action.parse(input.action), plan = verifyInstallationPlanV1(input.installationPlan);
  const readiness = completeReadiness(plan.planDigest, input.supervisorReadiness, requestedAction);
  const observed = observation.parse(input.observation); validateObservation(observed);
  const targetReleaseDigest = parseOptionalDigest(input.targetReleaseDigest);
  const targetServiceDefinitionDigest = parseOptionalDigest(input.targetServiceDefinitionDigest);
  const previousVerifiedReleaseDigest = parseOptionalDigest(input.previousVerifiedReleaseDigest);
  const previousServiceDefinitionDigest = parseOptionalDigest(input.previousServiceDefinitionDigest);
  const requiresTarget = requestedAction === "install" || requestedAction === "update";
  const requiresPrevious = requestedAction === "update";
  if (requiresTarget !== (targetReleaseDigest !== undefined) || requiresTarget !== (targetServiceDefinitionDigest !== undefined)
    || requiresPrevious !== (previousVerifiedReleaseDigest !== undefined) || requiresPrevious !== (previousServiceDefinitionDigest !== undefined)) refuse();
  if (requestedAction === "update" && (observed.activeReleaseDigest !== previousVerifiedReleaseDigest
    || observed.installedServiceDefinitionDigest !== previousServiceDefinitionDigest
    || targetReleaseDigest === previousVerifiedReleaseDigest)) refuse();
  const releaseForAction = targetReleaseDigest ?? observed.activeReleaseDigest ?? plan.releaseDigest;
  if (releaseForAction !== plan.releaseDigest) refuse();
  const platformServiceStage = plan.stages.find(item => item.stage === "platform_service");
  const stageInputDigest = platformServiceStageInputDigestV1({ ...input, releaseDigest: plan.releaseDigest, observation: observed });
  if (!platformServiceStage || platformServiceStage.state !== "running" || platformServiceStage.inputDigest !== stageInputDigest) refuse();
  const planned = operations(requestedAction, observed.state);
  return { schema: PLATFORM_SERVICE_LIFECYCLE_V1, action: requestedAction, platform: platform.parse(input.platform),
    installationPlanDigest: plan.planDigest, installationPlanRevision: plan.revision, stage: "platform_service", stageInputDigest,
    supervisorReadinessDigest: readiness.readinessDigest,
    serviceIdentityDigest: digest.parse(input.serviceIdentityDigest), authorityDatabaseDigest: digest.parse(input.authorityDatabaseDigest),
    protectedDataDigest: digest.parse(input.protectedDataDigest), observation: observed,
    ...(targetReleaseDigest ? { targetReleaseDigest } : {}),
    ...(targetServiceDefinitionDigest ? { targetServiceDefinitionDigest } : {}),
    ...(previousVerifiedReleaseDigest ? { previousVerifiedReleaseDigest } : {}),
    ...(previousServiceDefinitionDigest ? { previousServiceDefinitionDigest } : {}),
    steps: planned.steps, rollbackSteps: planned.rollbackSteps, performsEffect: false, startsService: false,
    grantsAgentReadiness: false, preservesAuthorityDatabase: true, preservesProtectedData: true };
}

function freeze(value: Omit<PlatformServiceLifecycleV1, "lifecycleDigest">): PlatformServiceLifecycleV1 {
  const frozenSteps = Object.freeze(value.steps.map(item => Object.freeze({ ...item })));
  const frozenRollback = Object.freeze(value.rollbackSteps.map(item => Object.freeze({ ...item })));
  const frozenObservation = Object.freeze({ ...value.observation });
  const unsigned = { ...value, observation: frozenObservation, steps: frozenSteps, rollbackSteps: frozenRollback };
  return Object.freeze({ ...unsigned, lifecycleDigest: sha256Digest(unsigned) });
}

export function preparePlatformServiceLifecycleV1(input: Input): PlatformServiceLifecycleV1 {
  return freeze(material(input));
}

/** Verification requires the separately trusted readiness and observation; a
 * caller cannot retag a stopped/running service and recompute the digest. */
export function verifyPlatformServiceLifecycleV1(value: unknown, input: Input): PlatformServiceLifecycleV1 {
  const parsed = schema.parse(value), expected = preparePlatformServiceLifecycleV1(input);
  if (canonicalJson(parsed) !== canonicalJson(expected)) refuse();
  return expected;
}

/** Returns abstract operations only. It never returns paths, commands, labels,
 * credentials, process arguments, or a service-manager handle. */
export function platformServiceLifecycleOperationsV1(value: unknown, input: Input) {
  const prepared = verifyPlatformServiceLifecycleV1(value, input);
  return Object.freeze({ action: prepared.action, steps: prepared.steps, rollbackSteps: prepared.rollbackSteps,
    performsEffect: false as const, startsService: false as const, grantsAgentReadiness: false as const });
}
