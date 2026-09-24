import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

/**
 * Redacted, source-only assembly of the evidence needed for one bounded
 * three-worker activation window.  This contract never loads the underlying
 * private values.  It binds only the digests emitted by the already-reviewed
 * release, installation, database-route, operator, Hermes, and Claude
 * preparation boundaries.
 */
export const THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1 =
  "control-room.three-worker-activation-bundle-preflight/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);

const componentDefinitions = Object.freeze({
  verified_release: Object.freeze({
    sourceSchema: "control-room.local-installation-package-preparation/v1",
    ownerAction: undefined,
  }),
  protected_configuration: Object.freeze({
    sourceSchema: "control-room.private-installed-configuration-preparation/v1",
    ownerAction: "materialize_protected_configuration" as const,
  }),
  database_route: Object.freeze({
    sourceSchema: "control-room.private-postgres-endpoint/v1",
    ownerAction: "approve_private_database_route" as const,
  }),
  scheduler_result_storage: Object.freeze({
    sourceSchema: "control-room.agent-task-operator-settings/v1",
    ownerAction: "activate_scheduler_and_result_storage" as const,
  }),
  hermes_route: Object.freeze({
    sourceSchema: "control-room.local-hermes-admission-preparation/v1",
    ownerAction: "approve_hermes_first_task" as const,
  }),
  claude_owner_write: Object.freeze({
    sourceSchema: "control-room.private-installed-configuration-v3-materialization-preparation/v1",
    ownerAction: "materialize_claude_manifest" as const,
  }),
});

const component = z.enum(Object.keys(componentDefinitions) as [keyof typeof componentDefinitions,
  ...(keyof typeof componentDefinitions)[]]);
const state = z.enum(["ready", "blocked", "owner_attended_action"]);

const bindingSchema = z.object({ installationId, releaseDigest: digest, topologyPlanDigest: digest }).strict();
const evidenceSchema = z.object({
  component,
  sourceSchema: z.string().min(1).max(160),
  state,
  binding: bindingSchema,
  evidenceDigest: digest,
}).strict();

const rollbackSchema = z.object({
  releaseRollbackDigest: digest,
  databaseSnapshotDigest: digest,
  privateRouteSnapshotDigest: digest,
  websiteRouteSnapshotDigest: digest,
  protectedConfigurationPriorStateDigest: digest,
}).strict();

const inputSchema = z.object({
  installationId,
  releaseDigest: digest,
  topologyPlanDigest: digest,
  evidence: z.array(evidenceSchema).length(Object.keys(componentDefinitions).length),
  rollback: rollbackSchema,
}).strict();

const action = z.enum(["activate_scheduler_and_result_storage", "approve_hermes_first_task",
  "approve_private_database_route", "materialize_claude_manifest", "materialize_protected_configuration"]);
const outputEvidenceSchema = evidenceSchema.omit({ binding: true });
const materialSchema = z.object({
  schema: z.literal(THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1),
  installationId,
  releaseDigest: digest,
  topologyPlanDigest: digest,
  status: z.enum(["ready", "blocked", "owner_attended_action_required"]),
  evidence: z.array(outputEvidenceSchema).length(Object.keys(componentDefinitions).length),
  ownerActions: z.array(action).max(2),
  rollback: z.object({
    status: z.literal("prerequisites_captured"),
    releaseRollbackDigest: digest,
    databaseSnapshotDigest: digest,
    privateRouteSnapshotDigest: digest,
    websiteRouteSnapshotDigest: digest,
    protectedConfigurationPriorStateDigest: digest,
  }).strict(),
  containsCredentialValue: z.literal(false),
  containsPrivatePath: z.literal(false),
  containsEndpoint: z.literal(false),
  accessesCredentialStore: z.literal(false),
  accessesKeychain: z.literal(false),
  performsEffect: z.literal(false),
  readsProtectedFiles: z.literal(false),
  writesProtectedFiles: z.literal(false),
  opensDatabase: z.literal(false),
  usesNetwork: z.literal(false),
  changesRoute: z.literal(false),
  changesDns: z.literal(false),
  changesCertificate: z.literal(false),
  startsService: z.literal(false),
  startsWorker: z.literal(false),
  invokesAgent: z.literal(false),
}).strict();

const planSchema = materialSchema.extend({ planDigest: digest }).strict();

export type ThreeWorkerActivationBundleComponentV1 = z.infer<typeof component>;
export type ThreeWorkerActivationBundlePreflightV1 = Readonly<z.infer<typeof planSchema>>;

function refused(): never {
  const error = new Error("three_worker_activation_bundle_preflight_refused");
  error.stack = undefined;
  throw error;
}

function freezePlan(value: z.infer<typeof planSchema>): ThreeWorkerActivationBundlePreflightV1 {
  return Object.freeze({ ...value,
    evidence: Object.freeze(value.evidence.map(item => Object.freeze({ ...item }))),
    ownerActions: Object.freeze([...value.ownerActions]),
    rollback: Object.freeze({ ...value.rollback }),
  });
}

function orderedEvidence(value: z.infer<typeof inputSchema>) {
  const seen = new Set<ThreeWorkerActivationBundleComponentV1>();
  const captured = value.evidence.map(item => {
    const definition = componentDefinitions[item.component];
    if (seen.has(item.component) || item.sourceSchema !== definition.sourceSchema
      || item.binding.installationId !== value.installationId
      || item.binding.releaseDigest !== value.releaseDigest
      || item.binding.topologyPlanDigest !== value.topologyPlanDigest) return refused();
    if (item.state === "owner_attended_action" && definition.ownerAction === undefined) return refused();
    seen.add(item.component);
    return Object.freeze({ component: item.component, sourceSchema: item.sourceSchema,
      state: item.state, evidenceDigest: item.evidenceDigest });
  }).sort((left, right) => left.component.localeCompare(right.component));
  if (seen.size !== Object.keys(componentDefinitions).length) return refused();
  return Object.freeze(captured);
}

/**
 * Produces a deterministic owner-window plan from already-verified, digest-only
 * evidence.  A blocked component dominates owner actions; owner actions never
 * become readiness.  No source evidence is opened or replayed by this layer.
 */
export function composeThreeWorkerActivationBundlePreflightV1(input: unknown):
ThreeWorkerActivationBundlePreflightV1 {
  try {
    const parsed = inputSchema.parse(input), evidence = orderedEvidence(parsed);
    const blocked = evidence.some(item => item.state === "blocked");
    const pendingOwnerActions = evidence.flatMap(item => item.state === "owner_attended_action"
      ? [componentDefinitions[item.component].ownerAction] : [])
      .filter((item): item is z.infer<typeof action> => item !== undefined)
      .sort();
    const ownerActions = blocked ? [] : pendingOwnerActions;
    const status = blocked ? "blocked" as const : ownerActions.length > 0
      ? "owner_attended_action_required" as const : "ready" as const;
    const material = materialSchema.parse({
      schema: THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1,
      installationId: parsed.installationId,
      releaseDigest: parsed.releaseDigest,
      topologyPlanDigest: parsed.topologyPlanDigest,
      status,
      evidence,
      ownerActions,
      rollback: { status: "prerequisites_captured", ...parsed.rollback },
      containsCredentialValue: false,
      containsPrivatePath: false,
      containsEndpoint: false,
      accessesCredentialStore: false,
      accessesKeychain: false,
      performsEffect: false,
      readsProtectedFiles: false,
      writesProtectedFiles: false,
      opensDatabase: false,
      usesNetwork: false,
      changesRoute: false,
      changesDns: false,
      changesCertificate: false,
      startsService: false,
      startsWorker: false,
      invokesAgent: false,
    });
    return freezePlan(planSchema.parse({ ...material, planDigest: sha256Digest(material) }));
  } catch { return refused(); }
}

/** Re-verifies persisted output and its deterministic digest. */
export function verifyThreeWorkerActivationBundlePreflightV1(value: unknown):
ThreeWorkerActivationBundlePreflightV1 {
  try {
    const parsed = planSchema.parse(value), { planDigest, ...material } = parsed;
    if (planDigest !== sha256Digest(material)) return refused();
    const components = parsed.evidence.map(item => item.component);
    if (new Set(components).size !== Object.keys(componentDefinitions).length
      || components.some((name, index) => index > 0 && components[index - 1]!.localeCompare(name) >= 0)) return refused();
    for (const item of parsed.evidence) {
      const definition = componentDefinitions[item.component];
      if (item.sourceSchema !== definition.sourceSchema
        || (item.state === "owner_attended_action" && definition.ownerAction === undefined)) return refused();
    }
    const pendingActions = parsed.evidence.flatMap(item => item.state === "owner_attended_action"
      ? [componentDefinitions[item.component].ownerAction] : [])
      .filter((item): item is z.infer<typeof action> => item !== undefined).sort();
    const blocked = parsed.evidence.some(item => item.state === "blocked");
    const expectedActions = blocked ? [] : pendingActions;
    const expectedStatus = blocked ? "blocked" : expectedActions.length > 0 ? "owner_attended_action_required" : "ready";
    if (parsed.status !== expectedStatus || canonicalJson(parsed.ownerActions) !== canonicalJson(expectedActions)) return refused();
    return freezePlan(parsed);
  } catch { return refused(); }
}

/**
 * Exact input is a replay; any changed evidence yields a new inert plan and
 * explicitly invalidates the old one.  Neither result performs an effect.
 */
export function refreshThreeWorkerActivationBundlePreflightV1(current: unknown, nextInput: unknown) {
  const previous = verifyThreeWorkerActivationBundlePreflightV1(current);
  const next = composeThreeWorkerActivationBundlePreflightV1(nextInput);
  if (canonicalJson(previous) === canonicalJson(next)) return Object.freeze({ kind: "replay" as const,
    plan: previous, performsEffect: false as const });
  return Object.freeze({ kind: "invalidated" as const, plan: next, performsEffect: false as const });
}
