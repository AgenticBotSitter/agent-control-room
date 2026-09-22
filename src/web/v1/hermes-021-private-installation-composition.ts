import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  captureHermes021MacosSubprocessHostConfigurationV1,
  hermes021MacosLocalBindingSchemaV1,
  type Hermes021MacosAssignedTaskExecutionV1,
  type Hermes021MacosSubprocessHostConfigurationV1,
} from "../../harness/hermes-021-v1";
import type { DurableResultPublicationConfigurationV1 } from "../../artifacts/v1/durable-result-publication";
import type { ControllerWorkerDeliveryV1 } from "../../harness/v1/controller-worker-delivery";
import { hermes021LocalQueueTargetToDispatchReferenceV1 } from "./hermes-021-local-executor";
import { createHermes021LocalSubprocessQueueExecutorV1 } from "./hermes-021-local-subprocess-executor";
import type { Hermes021LocalQueueDeliveryTarget } from "./task-assignment-coordinator";
import { sha256Digest } from "../../security/canonical-digest";
import { validatePrivatePostgresConfiguration } from "./private-postgres";

const unavailable = (): never => { throw new Error("hermes_021_private_installation_composition_unavailable"); };
const identifier = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);

export const PRIVATE_HERMES_021_LOCAL_INSTALLATION_DELIVERY_V1 =
  "control-room.private-hermes-021-local-installation-delivery/v1" as const;
export const PRIVATE_HERMES_021_LOCAL_STARTUP_ADMISSION_BINDING_V1 =
  "control-room.private-hermes-021-local-startup-admission-binding/v1" as const;

type CompositionMetadata = Readonly<{
  compositionInstanceDigest: string;
  compositionContractDigest: string;
  workerBindingDigest: string;
  runnerConfigurationDigest: string;
}>;
const compositions = new WeakMap<object, CompositionMetadata>();

const startupBindingSchema = z.object({
  schema: z.literal(PRIVATE_HERMES_021_LOCAL_STARTUP_ADMISSION_BINDING_V1),
  compositionContract: z.literal(PRIVATE_HERMES_021_LOCAL_INSTALLATION_DELIVERY_V1),
  installationBindingDigest: digest,
  topologyPlanDigest: digest,
  releaseDigest: digest,
  admissionRequestDigest: digest,
  workerBindingDigest: digest,
  runnerConfigurationDigest: digest,
  queueDatabaseBindingDigest: digest,
  compositionInstanceDigest: digest,
  compositionContractDigest: digest,
  bindingDigest: digest,
  invokesCallback: z.literal(false),
  startsWork: z.literal(false),
  grantsExecutionAuthority: z.literal(false),
}).strict();
export type PrivateHermes021LocalStartupAdmissionBindingV1 = Readonly<z.infer<typeof startupBindingSchema>>;

const installationBindingSchema = z.object({
  preparationDigest: digest, topologyPlanDigest: digest, releaseDigest: digest,
  workerBindingDigest: digest, runnerConfigurationDigest: digest,
}).passthrough();

function runnerConfigurationDigest(value: Hermes021MacosSubprocessHostConfigurationV1) {
  return sha256Digest({ purpose: "local-hermes-runner-configuration/v1", configuration: value });
}

function queueDatabaseBindingDigest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const queue = value as { database?: unknown; concurrency?: unknown };
  const database = validatePrivatePostgresConfiguration(queue.database as never);
  const concurrency = queue.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || (concurrency as number) < 1 || (concurrency as number) > 8) unavailable();
  // Password is deliberately validated above but excluded. This is an opaque
  // database identity, role and concurrency binding, never a credential hash.
  return sha256Digest({ purpose: "local-hermes-queue-database-binding/v1",
    database: { host: database.host, port: database.port, database: database.database,
      majorVersion: database.majorVersion }, role: database.username, concurrency });
}

const withoutBindingDigest = <T extends { bindingDigest: string }>(value: T) => {
  const { bindingDigest: _digest, ...body } = value; void _digest; return body;
};

/**
 * The installation-only seam for a local Hermes delivery callback. It binds
 * already-verified private runner settings to the existing queue executor and
 * exposes only `deliver` to protected operator assembly. It has no browser,
 * database-opening, worker-starting, or Hermes-invocation behavior of its own.
 */
export function createPrivateHermes021LocalInstallationDeliveryV1(input: unknown): Readonly<{
  deliver: (target: unknown, signal: AbortSignal) => Promise<void>;
}> {
  const parsed = z.object({
    tenantId: identifier,
    execution: z.unknown(),
    results: z.unknown(),
    assertAuthority: z.function(),
    subprocess: z.unknown(),
  }).strict().safeParse(input);
  const data = parsed.data;
  if (!parsed.success || data === undefined) unavailable();
  const configuration = data as Readonly<{ tenantId: string; execution: unknown; results: unknown;
    assertAuthority: unknown; subprocess: unknown }>;
  if (!configuration.execution || typeof configuration.execution !== "object"
    || !configuration.results || typeof configuration.results !== "object") unavailable();

  const execution = configuration.execution as Hermes021MacosAssignedTaskExecutionV1;
  // The outer factory must never accept an injected test host or a completed
  // private port. A production installation supplies only owner-owned fixed
  // subprocess settings; the executor creates the port internally.
  if (!execution.delivery || typeof execution.delivery !== "object" || "privatePort" in execution.delivery) unavailable();
  if (!hermes021MacosLocalBindingSchemaV1.safeParse(execution.delivery.binding).success) unavailable();
  const subprocess = (() => {
    try { return captureHermes021MacosSubprocessHostConfigurationV1(configuration.subprocess); }
    catch { return unavailable(); }
  })();
  const queueExecutor = createHermes021LocalSubprocessQueueExecutorV1({
    tenantId: configuration.tenantId,
    execution: execution as Omit<Hermes021MacosAssignedTaskExecutionV1, "delivery"> & Readonly<{
      delivery: Omit<Hermes021MacosAssignedTaskExecutionV1["delivery"], "privatePort">;
    }>,
    results: configuration.results as DurableResultPublicationConfigurationV1,
    assertAuthority: configuration.assertAuthority as (delivery: ControllerWorkerDeliveryV1) => void,
    subprocess: subprocess as Hermes021MacosSubprocessHostConfigurationV1,
  });
  const delivery = Object.freeze({ async deliver(target: unknown, signal: AbortSignal): Promise<void> {
    // Validate this public boundary before the narrower queue executor receives
    // the target. The installed runner still sees only its fixed private setup.
    hermes021LocalQueueTargetToDispatchReferenceV1(configuration.tenantId, target);
    await queueExecutor.deliver(target as Hermes021LocalQueueDeliveryTarget, signal);
  } });
  const workerBindingDigest = sha256Digest(execution.delivery.binding);
  const configurationDigest = runnerConfigurationDigest(subprocess);
  const compositionContractDigest = sha256Digest({ schema: PRIVATE_HERMES_021_LOCAL_INSTALLATION_DELIVERY_V1,
    targetContract: "control-room.hermes-021-local-queue-delivery-target/v1",
    deliveryContract: "control-room.controller-worker-delivery/v1",
    terminalPublication: "control-room.durable-result-write-reservation/v1" });
  compositions.set(delivery, Object.freeze({
    compositionInstanceDigest: sha256Digest({ purpose: "private-hermes-installation-composition-instance/v1",
      nonce: randomUUID() }), compositionContractDigest, workerBindingDigest,
    runnerConfigurationDigest: configurationDigest }));
  return delivery;
}

function bindingMaterial(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) unavailable();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== ["admissionRequestDigest", "delivery", "installationBinding",
    "queueWorker", "releaseDigest", "topologyPlanDigest"].sort().join(",")) unavailable();
  const metadata = value.delivery && typeof value.delivery === "object"
    ? compositions.get(value.delivery as object) : undefined;
  if (!metadata) return unavailable();
  const installation = installationBindingSchema.parse(value.installationBinding);
  const topologyPlanDigest = digest.parse(value.topologyPlanDigest);
  const releaseDigest = digest.parse(value.releaseDigest);
  const admissionRequestDigest = digest.parse(value.admissionRequestDigest);
  if (installation.topologyPlanDigest !== topologyPlanDigest || installation.releaseDigest !== releaseDigest
    || installation.workerBindingDigest !== metadata.workerBindingDigest
    || installation.runnerConfigurationDigest !== metadata.runnerConfigurationDigest) unavailable();
  return Object.freeze({ compositionContract: PRIVATE_HERMES_021_LOCAL_INSTALLATION_DELIVERY_V1,
    installationBindingDigest: installation.preparationDigest,
    topologyPlanDigest, releaseDigest, admissionRequestDigest,
    workerBindingDigest: metadata.workerBindingDigest,
    runnerConfigurationDigest: metadata.runnerConfigurationDigest,
    queueDatabaseBindingDigest: queueDatabaseBindingDigest(value.queueWorker),
    compositionInstanceDigest: metadata.compositionInstanceDigest,
    compositionContractDigest: metadata.compositionContractDigest });
}

/** Produces the opaque record at the boundary that owns both the exact local
 * delivery composition and queue-worker configuration. It hashes no password,
 * integrity key or function. */
export function createPrivateHermes021LocalStartupAdmissionBindingV1(input: unknown):
PrivateHermes021LocalStartupAdmissionBindingV1 {
  const material = bindingMaterial(input);
  const body = { schema: PRIVATE_HERMES_021_LOCAL_STARTUP_ADMISSION_BINDING_V1, ...material,
    invokesCallback: false as const, startsWork: false as const, grantsExecutionAuthority: false as const };
  return Object.freeze(startupBindingSchema.parse({ ...body,
    bindingDigest: sha256Digest({ purpose: "private-hermes-startup-admission-binding/v1", binding: body }) }));
}

/** Rechecks a saved opaque record against the exact in-memory composition and
 * current queue configuration. A substituted callback has no matching private
 * composition instance and is refused. */
export function verifyPrivateHermes021LocalStartupAdmissionBindingV1(value: unknown, input: unknown):
PrivateHermes021LocalStartupAdmissionBindingV1 {
  const parsed = startupBindingSchema.parse(value);
  if (parsed.bindingDigest !== sha256Digest({ purpose: "private-hermes-startup-admission-binding/v1",
    binding: withoutBindingDigest(parsed) })) unavailable();
  const expected = createPrivateHermes021LocalStartupAdmissionBindingV1(input);
  if (parsed.bindingDigest !== expected.bindingDigest) unavailable();
  return expected;
}

/** Rechecks the non-secret saved binding against the exact current delivery
 * instance and queue settings after installation review. The installation
 * binding was already checked when this record was created; this narrower
 * matcher exists so normal startup can detect callback, runner, worker, queue
 * role or concurrency substitution without retaining private installation
 * inputs in the application configuration. */
export function verifyPrivateHermes021LocalCurrentStartupBindingV1(value: unknown, input: unknown):
PrivateHermes021LocalStartupAdmissionBindingV1 {
  const parsed = startupBindingSchema.parse(value);
  if (parsed.bindingDigest !== sha256Digest({ purpose: "private-hermes-startup-admission-binding/v1",
    binding: withoutBindingDigest(parsed) })) unavailable();
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.getPrototypeOf(input) !== Object.prototype) unavailable();
  const current = input as Record<string, unknown>;
  if (Object.keys(current).sort().join(",") !== ["delivery", "queueWorker", "releaseDigest",
    "topologyPlanDigest"].sort().join(",")) unavailable();
  const metadata = current.delivery && typeof current.delivery === "object"
    ? compositions.get(current.delivery as object) : undefined;
  if (!metadata) return unavailable();
  if (parsed.topologyPlanDigest !== digest.parse(current.topologyPlanDigest)
    || parsed.releaseDigest !== digest.parse(current.releaseDigest)
    || parsed.workerBindingDigest !== metadata.workerBindingDigest
    || parsed.runnerConfigurationDigest !== metadata.runnerConfigurationDigest
    || parsed.compositionInstanceDigest !== metadata.compositionInstanceDigest
    || parsed.compositionContractDigest !== metadata.compositionContractDigest
    || parsed.queueDatabaseBindingDigest !== queueDatabaseBindingDigest(current.queueWorker)) unavailable();
  return Object.freeze(parsed);
}
