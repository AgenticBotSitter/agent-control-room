import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";
import { verifyHermes021MacosProtectedWorkerReadinessV1 } from
  "../../harness/hermes-021-v1/protected-worker-readiness";
import { verifyPrivateInstalledConfigurationPreparationV1 } from
  "./private-installed-configuration-preparation";
import { consumePrivateInstalledConfigurationV3PostWriteActivationEvidenceV1 } from
  "./private-installed-configuration-v3-owner-writer";
import { verifyProtectedReleaseReviewPreparationV1 } from "./protected-release-review-preparation";
import { assessSchedulerResultStorageActivationSourceV1 } from
  "./scheduler-result-storage-activation-source";

/**
 * Redacted, source-only view of one bounded activation window. A component can
 * leave `source_proof_missing` only through a source-specific proof adapter
 * that verifies the real producer output. There is deliberately no generic
 * evidence or rollback recorder.
 */
export const THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1 =
  "control-room.three-worker-activation-bundle-preflight/v1" as const;
export const THREE_WORKER_ACTIVATION_BUNDLE_CUSTODY_V1 =
  "control-room.three-worker-activation-bundle-custody/v1" as const;
export const THREE_WORKER_ACTIVATION_SOURCE_PROOF_V1 =
  "control-room.three-worker-activation-source-proof/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
const bindingSchema = z.object({ installationId, releaseDigest: digest, topologyPlanDigest: digest }).strict();
type Binding = Readonly<z.infer<typeof bindingSchema>>;
const definitions = Object.freeze({
  verified_release: Object.freeze({ sourceSchema: "control-room.local-installation-package-preparation/v1" }),
  protected_configuration: Object.freeze({ sourceSchema: "control-room.private-installed-configuration-preparation/v1" }),
  database_route: Object.freeze({ sourceSchema: "control-room.private-postgres-endpoint/v1" }),
  scheduler_result_storage: Object.freeze({ sourceSchema: "control-room.agent-task-operator-settings/v1" }),
  hermes_route: Object.freeze({ sourceSchema: "control-room.hermes-021-macos-protected-worker-readiness/v1" }),
  claude_owner_write: Object.freeze({
    sourceSchema: "control-room.private-installed-configuration-v3-owner-writer/v1" }),
});
const rollbackKinds = Object.freeze(["release_rollback", "database_snapshot", "private_route_snapshot",
  "website_route_snapshot", "protected_configuration_prior_state"] as const);
const component = z.enum(Object.keys(definitions) as [keyof typeof definitions, ...(keyof typeof definitions)[]]);
const rollbackKind = z.enum(rollbackKinds);
export type ThreeWorkerActivationBundleComponentV1 = z.infer<typeof component>;
type AggregateState = Binding & { generation: number; currentPlanDigest?: string };
type SourceProof = Binding & Readonly<{ aggregate: object; component: ThreeWorkerActivationBundleComponentV1;
  sourceSchema: string; state: "blocked" | "ready" | "owner_attended_action"; evidenceDigest: string;
  blocker?: "reviewed_release_identity_missing" | "owner_materialization_verification_missing"
    | "opaque_scheduler_and_restore_proof_missing" }>;
const aggregates = new WeakMap<object, AggregateState>();
const proofs = new WeakMap<object, SourceProof>();

const componentOutput = z.object({ component, sourceSchema: z.string().min(1).max(160),
  state: z.enum(["blocked", "ready", "owner_attended_action"]), blocker: z.enum(["source_proof_missing",
    "reviewed_release_identity_missing", "owner_materialization_verification_missing",
    "opaque_scheduler_and_restore_proof_missing"]).optional(),
  evidenceDigest: digest.optional() }).strict();
const materialSchema = z.object({ schema: z.literal(THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1),
  installationId, releaseDigest: digest, topologyPlanDigest: digest, generation: z.number().int().positive(),
  status: z.literal("blocked"), components: z.array(componentOutput).length(Object.keys(definitions).length),
  ownerActions: z.array(z.literal("approve_hermes_first_task")).max(1),
  rollback: z.object({ status: z.literal("missing_source_proof"),
    missing: z.array(rollbackKind).length(rollbackKinds.length) }).strict(),
  containsCredentialValue: z.literal(false), containsPrivatePath: z.literal(false), containsEndpoint: z.literal(false),
  accessesCredentialStore: z.literal(false), accessesKeychain: z.literal(false), performsEffect: z.literal(false),
  readsProtectedFiles: z.literal(false), writesProtectedFiles: z.literal(false), opensDatabase: z.literal(false),
  usesNetwork: z.literal(false), changesRoute: z.literal(false), changesDns: z.literal(false),
  changesCertificate: z.literal(false), startsService: z.literal(false), startsWorker: z.literal(false),
  invokesAgent: z.literal(false) }).strict();
const planSchema = materialSchema.extend({ planDigest: digest }).strict();
export type ThreeWorkerActivationBundlePreflightV1 = Readonly<z.infer<typeof planSchema>>;

function refused(): never { const error = new Error("three_worker_activation_bundle_preflight_refused"); error.stack = undefined; throw error; }
function freezePlan(value: z.infer<typeof planSchema>): ThreeWorkerActivationBundlePreflightV1 {
  return Object.freeze({ ...value, components: Object.freeze(value.components.map(item => Object.freeze({ ...item }))),
    ownerActions: Object.freeze([...value.ownerActions]),
    rollback: Object.freeze({ ...value.rollback, missing: Object.freeze([...value.rollback.missing]) }) });
}
function aggregate(value: unknown) {
  if (!value || typeof value !== "object") return refused();
  return aggregates.get(value as object) ?? refused();
}

/** Read-only binding projection for source-specific protected compositions. */
export function captureThreeWorkerActivationAggregateBindingV1(value: unknown): Binding {
  const selected = aggregate(value);
  return Object.freeze(bindingSchema.parse({ installationId: selected.installationId,
    releaseDigest: selected.releaseDigest, topologyPlanDigest: selected.topologyPlanDigest }));
}

/** Returns no producer issuers. Holding this custody cannot fabricate readiness. */
export function createThreeWorkerActivationBundleCustodyV1(bindingValue: unknown) {
  const binding = bindingSchema.parse(bindingValue), token = Object.freeze({ schema: THREE_WORKER_ACTIVATION_BUNDLE_CUSTODY_V1 });
  aggregates.set(token, { ...binding, generation: 0 });
  return Object.freeze({ schema: THREE_WORKER_ACTIVATION_BUNDLE_CUSTODY_V1, aggregate: token,
    providesGenericEvidenceIssuer: false as const, providesRollbackRecorder: false as const });
}

/**
 * The first actual producer adapter. It can mint only after the Hermes module
 * re-verifies its process-local qualification provenance and current protected
 * installation inputs. A structural readiness object is insufficient.
 */
export function recordHermesThreeWorkerActivationSourceProofV1(input: Readonly<{
  aggregate: unknown; readiness: unknown; currentInput: unknown;
}>): object {
  const selected = aggregate(input?.aggregate);
  const readiness = verifyHermes021MacosProtectedWorkerReadinessV1(input.readiness, input.currentInput);
  if (readiness.installationId !== selected.installationId || readiness.releaseDigest !== selected.releaseDigest
    || readiness.topologyPlanDigest !== selected.topologyPlanDigest) return refused();
  const evidenceDigest = sha256Digest({ purpose: "three-worker-hermes-source-proof/v1",
    readinessDigest: readiness.readinessDigest, installationId: selected.installationId,
    releaseDigest: selected.releaseDigest, topologyPlanDigest: selected.topologyPlanDigest });
  const token = Object.freeze({ schema: THREE_WORKER_ACTIVATION_SOURCE_PROOF_V1 });
  proofs.set(token, Object.freeze({ ...selected, aggregate: input.aggregate as object, component: "hermes_route" as const,
    sourceSchema: definitions.hermes_route.sourceSchema, state: "owner_attended_action" as const, evidenceDigest }));
  return token;
}

/**
 * Records an exact aggregate-bound release-review preparation. It carries the
 * real filesystem inventory digest but deliberately remains blocked until the
 * future owner-attestation host consumes its separate one-use input.
 */
export function recordVerifiedReleaseThreeWorkerActivationSourceProofV1(input: Readonly<{
  aggregate: unknown; releaseReviewPreparation: unknown;
}>): object {
  const selected = aggregate(input?.aggregate);
  const review = verifyProtectedReleaseReviewPreparationV1(input.releaseReviewPreparation);
  if (review.installationId !== selected.installationId || review.releaseDigest !== selected.releaseDigest
    || review.topologyPlanDigest !== selected.topologyPlanDigest) return refused();
  const evidenceDigest = sha256Digest({ purpose: "three-worker-verified-release-source-proof/v1",
    installationId: selected.installationId, releaseDigest: selected.releaseDigest,
    topologyPlanDigest: selected.topologyPlanDigest, bundleDigest: review.bundleDigest,
    preparationEvidenceDigest: review.preparationEvidenceDigest });
  const token = Object.freeze({ schema: THREE_WORKER_ACTIVATION_SOURCE_PROOF_V1 });
  proofs.set(token, Object.freeze({ ...selected, aggregate: input.aggregate as object,
    component: "verified_release" as const, sourceSchema: definitions.verified_release.sourceSchema,
    state: "blocked" as const, blocker: "reviewed_release_identity_missing" as const, evidenceDigest }));
  return token;
}

/**
 * Records an exact configuration plan as preparation evidence only. The
 * plan performs no write and reads no protected file, so readiness requires a
 * later owner materialization plus native on-disk verification proof.
 */
export function recordProtectedConfigurationThreeWorkerActivationSourceProofV1(input: Readonly<{
  aggregate: unknown; configurationPlan: unknown;
}>): object {
  const selected = aggregate(input?.aggregate);
  const verified = verifyPrivateInstalledConfigurationPreparationV1(input.configurationPlan);
  if (verified.installationId !== selected.installationId || verified.releaseDigest !== selected.releaseDigest
    || verified.topologyPlanDigest !== selected.topologyPlanDigest) return refused();
  const evidenceDigest = sha256Digest({ purpose: "three-worker-protected-configuration-source-proof/v1",
    installationId: selected.installationId, releaseDigest: selected.releaseDigest,
    topologyPlanDigest: selected.topologyPlanDigest, sourcePlanDigest: verified.planDigest });
  const token = Object.freeze({ schema: THREE_WORKER_ACTIVATION_SOURCE_PROOF_V1 });
  proofs.set(token, Object.freeze({ ...selected, aggregate: input.aggregate as object,
    component: "protected_configuration" as const,
    sourceSchema: definitions.protected_configuration.sourceSchema, state: "blocked" as const,
    blocker: "owner_materialization_verification_missing" as const, evidenceDigest }));
  return token;
}

/**
 * Performs the current source-specific scheduler/storage assessment. There is
 * deliberately no ready branch: existing settings and restore records are
 * structural and cannot become activation evidence through this aggregate.
 */
export function recordSchedulerResultStorageThreeWorkerActivationSourceProofV1(input: Readonly<{
  aggregate: unknown; schedulerReadinessEvidence?: unknown; protectedStorageRestoreEvidence?: unknown;
}>): object {
  const selected = aggregate(input?.aggregate);
  const assessment = assessSchedulerResultStorageActivationSourceV1({ installationId: selected.installationId,
    releaseDigest: selected.releaseDigest, topologyPlanDigest: selected.topologyPlanDigest,
    schedulerReadinessEvidence: input.schedulerReadinessEvidence,
    protectedStorageRestoreEvidence: input.protectedStorageRestoreEvidence });
  const token = Object.freeze({ schema: THREE_WORKER_ACTIVATION_SOURCE_PROOF_V1 });
  proofs.set(token, Object.freeze({ ...selected, aggregate: input.aggregate as object,
    component: "scheduler_result_storage" as const,
    sourceSchema: definitions.scheduler_result_storage.sourceSchema, state: "blocked" as const,
    blocker: assessment.blocker, evidenceDigest: assessment.evidenceDigest }));
  return token;
}

/**
 * Consumes the activation-only view of the writer's opaque post-write
 * capability. That view exists only after the native publisher returned its
 * exact atomic publication receipt and both cleanup boundaries succeeded.
 */
export function recordClaudeOwnerWriteThreeWorkerActivationSourceProofV1(input: Readonly<{
  aggregate: unknown; postWriteVerificationCapability: unknown;
}>): object {
  const selected = aggregate(input?.aggregate);
  const verified = consumePrivateInstalledConfigurationV3PostWriteActivationEvidenceV1(
    input.postWriteVerificationCapability);
  if (verified.installationId !== selected.installationId || verified.releaseDigest !== selected.releaseDigest
    || verified.topologyPlanDigest !== selected.topologyPlanDigest) return refused();
  const evidenceDigest = sha256Digest({ purpose: "three-worker-claude-owner-write-source-proof/v1",
    installationId: selected.installationId, releaseDigest: selected.releaseDigest,
    topologyPlanDigest: selected.topologyPlanDigest, sourcePlanDigest: verified.planDigest,
    publicationEvidenceDigest: verified.publicationEvidenceDigest,
    configurationSha256: verified.configurationSha256, manifestSha256: verified.manifestSha256 });
  const token = Object.freeze({ schema: THREE_WORKER_ACTIVATION_SOURCE_PROOF_V1 });
  proofs.set(token, Object.freeze({ ...selected, aggregate: input.aggregate as object,
    component: "claude_owner_write" as const, sourceSchema: definitions.claude_owner_write.sourceSchema,
    state: "ready" as const, evidenceDigest }));
  return token;
}

function build(selected: AggregateState, aggregateToken: object, generation: number, supplied: readonly unknown[]) {
  const byComponent = new Map<ThreeWorkerActivationBundleComponentV1, SourceProof>();
  for (const value of supplied) {
    if (!value || typeof value !== "object") return refused();
    const proof = proofs.get(value as object);
    if (!proof || proof.aggregate !== aggregateToken || proof.installationId !== selected.installationId
      || proof.releaseDigest !== selected.releaseDigest || proof.topologyPlanDigest !== selected.topologyPlanDigest
      || byComponent.has(proof.component)) return refused();
    byComponent.set(proof.component, proof);
  }
  const components = component.options.map(name => {
    const proof = byComponent.get(name);
    return proof ? Object.freeze({ component: name, sourceSchema: proof.sourceSchema,
      state: proof.state, ...(proof.blocker ? { blocker: proof.blocker } : {}), evidenceDigest: proof.evidenceDigest })
      : Object.freeze({ component: name, sourceSchema: definitions[name].sourceSchema,
        state: "blocked" as const, blocker: "source_proof_missing" as const });
  }).sort((left, right) => left.component.localeCompare(right.component));
  const ownerActions = byComponent.has("hermes_route") ? ["approve_hermes_first_task" as const] : [];
  const material = materialSchema.parse({ schema: THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1,
    installationId: selected.installationId, releaseDigest: selected.releaseDigest,
    topologyPlanDigest: selected.topologyPlanDigest, generation, status: "blocked", components, ownerActions,
    rollback: { status: "missing_source_proof", missing: [...rollbackKinds] },
    containsCredentialValue: false, containsPrivatePath: false, containsEndpoint: false,
    accessesCredentialStore: false, accessesKeychain: false, performsEffect: false, readsProtectedFiles: false,
    writesProtectedFiles: false, opensDatabase: false, usesNetwork: false, changesRoute: false, changesDns: false,
    changesCertificate: false, startsService: false, startsWorker: false, invokesAgent: false });
  return freezePlan(planSchema.parse({ ...material, planDigest: sha256Digest(material) }));
}
function establish(selected: AggregateState, plan: ThreeWorkerActivationBundlePreflightV1) {
  selected.generation = plan.generation; selected.currentPlanDigest = plan.planDigest; return plan;
}

export function composeThreeWorkerActivationBundlePreflightV1(input: Readonly<{
  aggregate: unknown; sourceProofs?: readonly unknown[] }>): ThreeWorkerActivationBundlePreflightV1 {
  const selected = aggregate(input?.aggregate);
  if (selected.generation !== 0 || selected.currentPlanDigest !== undefined) return refused();
  return establish(selected, build(selected, input.aggregate as object, 1, input.sourceProofs ?? []));
}
export function verifyThreeWorkerActivationBundlePreflightV1(aggregateValue: unknown, value: unknown) {
  try {
    const selected = aggregate(aggregateValue), parsed = planSchema.parse(value), { planDigest, ...material } = parsed;
    if (parsed.installationId !== selected.installationId || parsed.releaseDigest !== selected.releaseDigest
      || parsed.topologyPlanDigest !== selected.topologyPlanDigest || parsed.generation !== selected.generation
      || planDigest !== selected.currentPlanDigest || planDigest !== sha256Digest(material)) return refused();
    return freezePlan(parsed);
  } catch { return refused(); }
}
export function refreshThreeWorkerActivationBundlePreflightV1(input: Readonly<{
  aggregate: unknown; current: unknown; sourceProofs?: readonly unknown[] }>) {
  const previous = verifyThreeWorkerActivationBundlePreflightV1(input.aggregate, input.current);
  const selected = aggregate(input.aggregate);
  const candidate = build(selected, input.aggregate as object, selected.generation, input.sourceProofs ?? []);
  if (canonicalJson(previous) === canonicalJson(candidate)) return Object.freeze({ kind: "replay" as const,
    plan: previous, performsEffect: false as const });
  const next = build(selected, input.aggregate as object, selected.generation + 1, input.sourceProofs ?? []);
  establish(selected, next); return Object.freeze({ kind: "invalidated" as const, plan: next, performsEffect: false as const });
}
