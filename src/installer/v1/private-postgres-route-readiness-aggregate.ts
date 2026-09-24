import { types } from "node:util";
import { sha256Digest } from "../../security/canonical-digest";

/**
 * Honest source-only contract for the still-missing private PostgreSQL route
 * proof. This module intentionally contains no generic recorder or issuer.
 * Arbitrary objects, digests, or structurally matching values cannot become
 * activation evidence.
 *
 * A later protected owner-runner must be added here (or behind an equally
 * private module boundary) to verify and register all three process-local
 * capabilities: current private-route authorization, the actually observed
 * TLS peer identity, and the exact restricted-role database preflight. Until
 * then every attempt to consume route readiness fails closed.
 */
export const PRIVATE_POSTGRES_ROUTE_READINESS_AGGREGATE_V1 =
  "control-room.private-postgres-route-readiness-aggregate/v1" as const;
export const PRIVATE_POSTGRES_ROUTE_READINESS_SOURCE_ASSESSMENT_V1 =
  "control-room.private-postgres-route-readiness-source-assessment/v1" as const;
export const PRIVATE_POSTGRES_ROUTE_READINESS_CAPABILITY_V1 =
  "control-room.private-postgres-route-readiness-capability/v1" as const;

type Binding = Readonly<{
  installationId: string;
  releaseDigest: string;
  topologyPlanDigest: string;
  databaseAuthorityDigest: string;
  endpointFingerprint: string;
  privateRouteEvidenceDigest: string;
  certificateSha256: string;
  restrictedRoleEvidenceDigest: string;
}>;

export type PrivatePostgresRouteReadinessSourceAssessmentV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_ROUTE_READINESS_SOURCE_ASSESSMENT_V1;
  installationId: string;
  releaseDigest: string;
  topologyPlanDigest: string;
  status: "blocked";
  blocker: "protected_owner_route_source_missing";
  requiredProofs: readonly [
    "current_private_route_authorization",
    "observed_tls_peer_identity",
    "restricted_role_database_preflight",
  ];
  assessmentDigest: string;
  createsSourceEvidence: false;
  containsCredentialValue: false;
  containsPrivatePath: false;
  containsEndpoint: false;
  containsCertificate: false;
  performsEffect: false;
  readsProtectedFiles: false;
  opensDatabase: false;
  usesNetwork: false;
  changesRoute: false;
  changesCertificate: false;
  startsService: false;
}>;

const aggregates = new WeakMap<object, Binding>();
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/u;

function refused(): never {
  const error = new Error("private_postgres_route_readiness_aggregate_refused");
  error.stack = undefined;
  throw error;
}

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) refused();
  const record = value as Readonly<Record<string, unknown>>, actual = Object.getOwnPropertyNames(record);
  if (actual.length !== names.length || names.some(name => !Object.prototype.hasOwnProperty.call(record, name))
    || actual.some(name => !names.includes(name))) refused();
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (!descriptor || descriptor.enumerable !== true || !("value" in descriptor)) refused();
  }
  return record;
}

function digest(value: unknown): string {
  if (typeof value !== "string" || !digestPattern.test(value)) refused();
  return value;
}

function binding(value: unknown): Binding {
  const item = exact(value, ["installationId", "releaseDigest", "topologyPlanDigest", "databaseAuthorityDigest",
    "endpointFingerprint", "privateRouteEvidenceDigest", "certificateSha256", "restrictedRoleEvidenceDigest"]);
  if (typeof item.installationId !== "string" || !installationIdPattern.test(item.installationId)) refused();
  return Object.freeze({ installationId: item.installationId, releaseDigest: digest(item.releaseDigest),
    topologyPlanDigest: digest(item.topologyPlanDigest), databaseAuthorityDigest: digest(item.databaseAuthorityDigest),
    endpointFingerprint: digest(item.endpointFingerprint), privateRouteEvidenceDigest: digest(item.privateRouteEvidenceDigest),
    certificateSha256: digest(item.certificateSha256), restrictedRoleEvidenceDigest: digest(item.restrictedRoleEvidenceDigest) });
}

function selected(value: unknown): Binding {
  if (!value || typeof value !== "object") refused();
  return aggregates.get(value as object) ?? refused();
}

function prepareAssessmentBody(held: Binding, proofsValue: unknown) {
  if (!Array.isArray(proofsValue) || proofsValue.length !== 3
    || proofsValue[0] !== "current_private_route_authorization"
    || proofsValue[1] !== "observed_tls_peer_identity"
    || proofsValue[2] !== "restricted_role_database_preflight") refused();
  return Object.freeze({ schema: PRIVATE_POSTGRES_ROUTE_READINESS_SOURCE_ASSESSMENT_V1,
    installationId: held.installationId, releaseDigest: held.releaseDigest, topologyPlanDigest: held.topologyPlanDigest,
    status: "blocked" as const, blocker: "protected_owner_route_source_missing" as const,
    requiredProofs: Object.freeze([...proofsValue]) as PrivatePostgresRouteReadinessSourceAssessmentV1["requiredProofs"],
    createsSourceEvidence: false as const, containsCredentialValue: false as const, containsPrivatePath: false as const,
    containsEndpoint: false as const, containsCertificate: false as const, performsEffect: false as const,
    readsProtectedFiles: false as const, opensDatabase: false as const, usesNetwork: false as const,
    changesRoute: false as const, changesCertificate: false as const, startsService: false as const });
}

/**
 * Declares exactly what the future source must bind, without accepting any
 * evidence value. The returned assessment is blocked and cannot be promoted.
 */
export function preparePrivatePostgresRouteReadinessSourceAssessmentV1(bindingValue: unknown) {
  const held = binding(bindingValue);
  const aggregate = Object.freeze({ schema: PRIVATE_POSTGRES_ROUTE_READINESS_AGGREGATE_V1 });
  aggregates.set(aggregate, held);
  const requiredProofs = Object.freeze(["current_private_route_authorization", "observed_tls_peer_identity",
    "restricted_role_database_preflight"] as const);
  const body = prepareAssessmentBody(held, requiredProofs);
  const assessment: PrivatePostgresRouteReadinessSourceAssessmentV1 = Object.freeze({ ...body,
    assessmentDigest: sha256Digest({ purpose: "private-postgres-route-readiness-source-assessment/v1",
      binding: held, body }) });
  return Object.freeze({ schema: PRIVATE_POSTGRES_ROUTE_READINESS_AGGREGATE_V1, aggregate, assessment });
}

/** Re-verifies the exact process-local assessment custody and its digest. */
export function verifyPrivatePostgresRouteReadinessSourceAssessmentV1(aggregateValue: unknown, value: unknown) {
  const held = selected(aggregateValue), assessment = exact(value, ["schema", "installationId", "releaseDigest",
    "topologyPlanDigest", "status", "blocker", "requiredProofs", "createsSourceEvidence", "containsCredentialValue",
    "containsPrivatePath", "containsEndpoint", "containsCertificate", "performsEffect", "readsProtectedFiles",
    "opensDatabase", "usesNetwork", "changesRoute", "changesCertificate", "startsService", "assessmentDigest"]);
  const prepared = prepareAssessmentBody(held, assessment.requiredProofs);
  if (assessment.schema !== prepared.schema || assessment.installationId !== prepared.installationId
    || assessment.releaseDigest !== prepared.releaseDigest || assessment.topologyPlanDigest !== prepared.topologyPlanDigest
    || assessment.status !== "blocked" || assessment.blocker !== "protected_owner_route_source_missing"
    || assessment.createsSourceEvidence !== false || assessment.containsCredentialValue !== false
    || assessment.containsPrivatePath !== false || assessment.containsEndpoint !== false
    || assessment.containsCertificate !== false || assessment.performsEffect !== false
    || assessment.readsProtectedFiles !== false || assessment.opensDatabase !== false || assessment.usesNetwork !== false
    || assessment.changesRoute !== false || assessment.changesCertificate !== false || assessment.startsService !== false
    || assessment.assessmentDigest !== sha256Digest({ purpose: "private-postgres-route-readiness-source-assessment/v1",
      binding: held, body: prepared })) refused();
  return Object.freeze({ ...prepared, assessmentDigest: assessment.assessmentDigest }) as
    PrivatePostgresRouteReadinessSourceAssessmentV1;
}

/**
 * Reserved consumer shape. There is intentionally no source registration path
 * in this revision, so every object—including structural fakes—fails closed.
 */
export function consumePrivatePostgresRouteReadinessCapabilityV1(input: Readonly<{
  aggregate: unknown;
  capability: unknown;
}>): never {
  selected(input?.aggregate);
  return refused();
}
