import { z } from "zod";
import { canonicalJson, sha256Digest } from "../../security/canonical-digest";

/** Process-local, redacted composition for one bounded three-worker activation window. */
export const THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1 =
  "control-room.three-worker-activation-bundle-preflight/v1" as const;
export const THREE_WORKER_ACTIVATION_BUNDLE_CUSTODY_V1 =
  "control-room.three-worker-activation-bundle-custody/v1" as const;
export const THREE_WORKER_ACTIVATION_EVIDENCE_ISSUER_V1 =
  "control-room.three-worker-activation-evidence-issuer/v1" as const;
export const THREE_WORKER_ACTIVATION_EVIDENCE_V1 =
  "control-room.three-worker-activation-evidence/v1" as const;
export const THREE_WORKER_ACTIVATION_ROLLBACK_ISSUER_V1 =
  "control-room.three-worker-activation-rollback-issuer/v1" as const;
export const THREE_WORKER_ACTIVATION_ROLLBACK_EVIDENCE_V1 =
  "control-room.three-worker-activation-rollback-evidence/v1" as const;

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const installationId = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u);
const bindingSchema = z.object({ installationId, releaseDigest: digest, topologyPlanDigest: digest }).strict();
type Binding = Readonly<z.infer<typeof bindingSchema>>;
const definitions = Object.freeze({
  verified_release: Object.freeze({ sourceSchema: "control-room.local-installation-package-preparation/v1", ownerAction: undefined }),
  protected_configuration: Object.freeze({ sourceSchema: "control-room.private-installed-configuration-preparation/v1",
    ownerAction: "materialize_protected_configuration" as const }),
  database_route: Object.freeze({ sourceSchema: "control-room.private-postgres-endpoint/v1",
    ownerAction: "approve_private_database_route" as const }),
  scheduler_result_storage: Object.freeze({ sourceSchema: "control-room.agent-task-operator-settings/v1",
    ownerAction: "activate_scheduler_and_result_storage" as const }),
  hermes_route: Object.freeze({ sourceSchema: "control-room.local-hermes-admission-preparation/v1",
    ownerAction: "approve_hermes_first_task" as const }),
  claude_owner_write: Object.freeze({ sourceSchema: "control-room.private-installed-configuration-v3-materialization-preparation/v1",
    ownerAction: "materialize_claude_manifest" as const }),
});
const rollbackKinds = Object.freeze(["release_rollback", "database_snapshot", "private_route_snapshot",
  "website_route_snapshot", "protected_configuration_prior_state"] as const);
const component = z.enum(Object.keys(definitions) as [keyof typeof definitions, ...(keyof typeof definitions)[]]);
const rollbackKind = z.enum(rollbackKinds);
const state = z.enum(["ready", "blocked", "owner_attended_action"]);
const action = z.enum(["activate_scheduler_and_result_storage", "approve_hermes_first_task",
  "approve_private_database_route", "materialize_claude_manifest", "materialize_protected_configuration"]);
export type ThreeWorkerActivationBundleComponentV1 = z.infer<typeof component>;
export type ThreeWorkerActivationBundleCustodyV1 = Readonly<{
  schema: typeof THREE_WORKER_ACTIVATION_BUNDLE_CUSTODY_V1; aggregate: object;
  evidenceIssuers: Readonly<Record<ThreeWorkerActivationBundleComponentV1, object>>;
  rollbackIssuers: Readonly<Record<z.infer<typeof rollbackKind>, object>>;
}>;
type AggregateState = Binding & { generation: number; currentPlanDigest?: string };
type EvidenceRecord = Binding & Readonly<{ aggregate: object; component: ThreeWorkerActivationBundleComponentV1;
  sourceSchema: string; state: z.infer<typeof state>; evidenceDigest: string }>;
type RollbackRecord = Binding & Readonly<{ aggregate: object; kind: z.infer<typeof rollbackKind>; evidenceDigest: string }>;
const aggregates = new WeakMap<object, AggregateState>();
const evidenceIssuers = new WeakMap<object, Binding & { aggregate: object; component: ThreeWorkerActivationBundleComponentV1 }>();
const rollbackIssuers = new WeakMap<object, Binding & { aggregate: object; kind: z.infer<typeof rollbackKind> }>();
const evidenceRecords = new WeakMap<object, EvidenceRecord>();
const rollbackRecords = new WeakMap<object, RollbackRecord>();

const evidenceOutputSchema = z.object({ component, sourceSchema: z.string().min(1).max(160), state,
  evidenceDigest: digest }).strict();
const rollbackOutputSchema = z.object({ status: z.literal("prerequisites_captured"), releaseRollbackDigest: digest,
  databaseSnapshotDigest: digest, privateRouteSnapshotDigest: digest, websiteRouteSnapshotDigest: digest,
  protectedConfigurationPriorStateDigest: digest }).strict();
const materialSchema = z.object({ schema: z.literal(THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1),
  installationId, releaseDigest: digest, topologyPlanDigest: digest, generation: z.number().int().positive(),
  status: z.enum(["ready", "blocked", "owner_attended_action_required"]),
  evidence: z.array(evidenceOutputSchema).length(Object.keys(definitions).length), ownerActions: z.array(action).max(5),
  rollback: rollbackOutputSchema, containsCredentialValue: z.literal(false), containsPrivatePath: z.literal(false),
  containsEndpoint: z.literal(false), accessesCredentialStore: z.literal(false), accessesKeychain: z.literal(false),
  performsEffect: z.literal(false), readsProtectedFiles: z.literal(false), writesProtectedFiles: z.literal(false),
  opensDatabase: z.literal(false), usesNetwork: z.literal(false), changesRoute: z.literal(false),
  changesDns: z.literal(false), changesCertificate: z.literal(false), startsService: z.literal(false),
  startsWorker: z.literal(false), invokesAgent: z.literal(false) }).strict();
const planSchema = materialSchema.extend({ planDigest: digest }).strict();
export type ThreeWorkerActivationBundlePreflightV1 = Readonly<z.infer<typeof planSchema>>;

function refused(): never { const error = new Error("three_worker_activation_bundle_preflight_refused"); error.stack = undefined; throw error; }
function sameBinding(left: Binding, right: Binding) { return left.installationId === right.installationId
  && left.releaseDigest === right.releaseDigest && left.topologyPlanDigest === right.topologyPlanDigest; }
function freezePlan(value: z.infer<typeof planSchema>): ThreeWorkerActivationBundlePreflightV1 {
  return Object.freeze({ ...value, evidence: Object.freeze(value.evidence.map(item => Object.freeze({ ...item }))),
    ownerActions: Object.freeze([...value.ownerActions]), rollback: Object.freeze({ ...value.rollback }) });
}

/** Outer protected composition hands each schema-only issuer to exactly one producer. */
export function createThreeWorkerActivationBundleCustodyV1(bindingValue: unknown): ThreeWorkerActivationBundleCustodyV1 {
  const binding = Object.freeze(bindingSchema.parse(bindingValue));
  const aggregate = Object.freeze({ schema: THREE_WORKER_ACTIVATION_BUNDLE_CUSTODY_V1 });
  aggregates.set(aggregate, { ...binding, generation: 0 });
  const issuedEvidence: Partial<Record<ThreeWorkerActivationBundleComponentV1, object>> = {};
  for (const name of component.options) { const issuer = Object.freeze({ schema: THREE_WORKER_ACTIVATION_EVIDENCE_ISSUER_V1 });
    evidenceIssuers.set(issuer, { ...binding, aggregate, component: name }); issuedEvidence[name] = issuer; }
  const issuedRollback: Partial<Record<z.infer<typeof rollbackKind>, object>> = {};
  for (const kind of rollbackKinds) { const issuer = Object.freeze({ schema: THREE_WORKER_ACTIVATION_ROLLBACK_ISSUER_V1 });
    rollbackIssuers.set(issuer, { ...binding, aggregate, kind }); issuedRollback[kind] = issuer; }
  return Object.freeze({ schema: THREE_WORKER_ACTIVATION_BUNDLE_CUSTODY_V1, aggregate,
    evidenceIssuers: Object.freeze(issuedEvidence) as Readonly<Record<ThreeWorkerActivationBundleComponentV1, object>>,
    rollbackIssuers: Object.freeze(issuedRollback) as Readonly<Record<z.infer<typeof rollbackKind>, object>> });
}

/** Producer-held issuer supplies state; the evidence digest is created here, never accepted from a caller. */
export function recordThreeWorkerActivationEvidenceV1(issuer: unknown, observedState: unknown): object {
  if (!issuer || typeof issuer !== "object") return refused();
  const captured = evidenceIssuers.get(issuer as object), parsedState = state.parse(observedState);
  if (!captured || parsedState === "owner_attended_action" && definitions[captured.component].ownerAction === undefined) return refused();
  const sourceSchema = definitions[captured.component].sourceSchema;
  const record = Object.freeze({ ...captured, sourceSchema, state: parsedState,
    evidenceDigest: sha256Digest({ purpose: "three-worker-activation-source-evidence/v1",
      installationId: captured.installationId, releaseDigest: captured.releaseDigest,
      topologyPlanDigest: captured.topologyPlanDigest, component: captured.component, sourceSchema, state: parsedState }) });
  const capability = Object.freeze({ schema: THREE_WORKER_ACTIVATION_EVIDENCE_V1 }); evidenceRecords.set(capability, record); return capability;
}

/** Rollback producer-held issuer creates the binding digest; no caller digest is accepted. */
export function recordThreeWorkerActivationRollbackEvidenceV1(issuer: unknown): object {
  if (!issuer || typeof issuer !== "object") return refused();
  const captured = rollbackIssuers.get(issuer as object); if (!captured) return refused();
  const record = Object.freeze({ ...captured,
    evidenceDigest: sha256Digest({ purpose: "three-worker-activation-rollback-evidence/v1",
      installationId: captured.installationId, releaseDigest: captured.releaseDigest,
      topologyPlanDigest: captured.topologyPlanDigest, kind: captured.kind }) });
  const capability = Object.freeze({ schema: THREE_WORKER_ACTIVATION_ROLLBACK_EVIDENCE_V1 }); rollbackRecords.set(capability, record); return capability;
}

function collect(aggregateValue: unknown, evidenceValues: readonly unknown[], rollbackValues: readonly unknown[]) {
  if (!aggregateValue || typeof aggregateValue !== "object") return refused();
  const aggregate = aggregates.get(aggregateValue as object);
  if (!aggregate || evidenceValues.length !== component.options.length || rollbackValues.length !== rollbackKinds.length) return refused();
  const evidence = evidenceValues.map(value => value && typeof value === "object" ? evidenceRecords.get(value as object) : undefined);
  const rollback = rollbackValues.map(value => value && typeof value === "object" ? rollbackRecords.get(value as object) : undefined);
  if (evidence.some(item => !item || item.aggregate !== aggregateValue || !sameBinding(item, aggregate))
    || rollback.some(item => !item || item.aggregate !== aggregateValue || !sameBinding(item, aggregate))) return refused();
  const evidenceByName = new Map(evidence.map(item => [item!.component, item!]));
  const rollbackByKind = new Map(rollback.map(item => [item!.kind, item!]));
  if (evidenceByName.size !== component.options.length || rollbackByKind.size !== rollbackKinds.length) return refused();
  return { aggregate, evidence: component.options.map(name => evidenceByName.get(name)!).sort((a, b) => a.component.localeCompare(b.component)),
    rollback: rollbackByKind };
}

function build(aggregate: AggregateState, generation: number, evidence: readonly EvidenceRecord[],
  rollback: ReadonlyMap<z.infer<typeof rollbackKind>, RollbackRecord>) {
  const blocked = evidence.some(item => item.state === "blocked");
  const pending = evidence.flatMap(item => item.state === "owner_attended_action" ? [definitions[item.component].ownerAction] : [])
    .filter((item): item is z.infer<typeof action> => item !== undefined).sort();
  const ownerActions = blocked ? [] : pending;
  const status = blocked ? "blocked" as const : ownerActions.length ? "owner_attended_action_required" as const : "ready" as const;
  const get = (kind: z.infer<typeof rollbackKind>) => rollback.get(kind)?.evidenceDigest ?? refused();
  const material = materialSchema.parse({ schema: THREE_WORKER_ACTIVATION_BUNDLE_PREFLIGHT_V1,
    installationId: aggregate.installationId, releaseDigest: aggregate.releaseDigest,
    topologyPlanDigest: aggregate.topologyPlanDigest, generation, status,
    evidence: evidence.map(({ component: name, sourceSchema, state: statusValue, evidenceDigest }) =>
      ({ component: name, sourceSchema, state: statusValue, evidenceDigest })), ownerActions,
    rollback: { status: "prerequisites_captured", releaseRollbackDigest: get("release_rollback"),
      databaseSnapshotDigest: get("database_snapshot"), privateRouteSnapshotDigest: get("private_route_snapshot"),
      websiteRouteSnapshotDigest: get("website_route_snapshot"),
      protectedConfigurationPriorStateDigest: get("protected_configuration_prior_state") },
    containsCredentialValue: false, containsPrivatePath: false, containsEndpoint: false, accessesCredentialStore: false,
    accessesKeychain: false, performsEffect: false, readsProtectedFiles: false, writesProtectedFiles: false,
    opensDatabase: false, usesNetwork: false, changesRoute: false, changesDns: false, changesCertificate: false,
    startsService: false, startsWorker: false, invokesAgent: false });
  return freezePlan(planSchema.parse({ ...material, planDigest: sha256Digest(material) }));
}
function establishCurrent(aggregate: AggregateState, plan: ThreeWorkerActivationBundlePreflightV1) {
  aggregate.generation = plan.generation; aggregate.currentPlanDigest = plan.planDigest; return plan;
}

export function composeThreeWorkerActivationBundlePreflightV1(input: Readonly<{
  aggregate: unknown; evidence: readonly unknown[]; rollback: readonly unknown[] }>): ThreeWorkerActivationBundlePreflightV1 {
  const captured = collect(input?.aggregate, input?.evidence ?? [], input?.rollback ?? []);
  if (captured.aggregate.currentPlanDigest !== undefined || captured.aggregate.generation !== 0) return refused();
  return establishCurrent(captured.aggregate, build(captured.aggregate, 1, captured.evidence, captured.rollback));
}
export function verifyThreeWorkerActivationBundlePreflightV1(aggregateValue: unknown, value: unknown): ThreeWorkerActivationBundlePreflightV1 {
  try {
    if (!aggregateValue || typeof aggregateValue !== "object") return refused();
    const aggregate = aggregates.get(aggregateValue as object), parsed = planSchema.parse(value);
    if (!aggregate || parsed.installationId !== aggregate.installationId || parsed.releaseDigest !== aggregate.releaseDigest
      || parsed.topologyPlanDigest !== aggregate.topologyPlanDigest || parsed.generation !== aggregate.generation
      || parsed.planDigest !== aggregate.currentPlanDigest) return refused();
    const { planDigest, ...material } = parsed; if (planDigest !== sha256Digest(material)) return refused();
    return freezePlan(parsed);
  } catch { return refused(); }
}
export function refreshThreeWorkerActivationBundlePreflightV1(input: Readonly<{
  aggregate: unknown; current: unknown; evidence: readonly unknown[]; rollback: readonly unknown[] }>) {
  const previous = verifyThreeWorkerActivationBundlePreflightV1(input?.aggregate, input?.current);
  const captured = collect(input.aggregate, input.evidence, input.rollback);
  const candidate = build(captured.aggregate, captured.aggregate.generation, captured.evidence, captured.rollback);
  if (canonicalJson(previous) === canonicalJson(candidate)) return Object.freeze({ kind: "replay" as const,
    plan: previous, performsEffect: false as const });
  const next = build(captured.aggregate, captured.aggregate.generation + 1, captured.evidence, captured.rollback);
  establishCurrent(captured.aggregate, next);
  return Object.freeze({ kind: "invalidated" as const, plan: next, performsEffect: false as const });
}
