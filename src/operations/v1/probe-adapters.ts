import { z } from "zod";
import { projectWorkspaceDigestSchemaV1 as digest, projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time } from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { buildOperationsHealthProbeV1, buildOperationsHealthSnapshotV1, buildOperationsServiceHealthV1,
  OPERATIONS_HEALTH_PROBE_IDS_V1, operationsRequiredHealthProbesForRoleV1, parseOperationsHealthSnapshotV1,
  type OperationsHealthProbeIdV1, type OperationsHealthSnapshotV1 } from "./health";
import { OPERATIONS_SERVICE_IDS_V1, OPERATIONS_SERVICE_ROLES_V1, parseOperationsProductionTopologyV1,
  type OperationsServiceIdV1, type OperationsServiceRoleV1 } from "./topology";

export const OPERATIONS_PROBE_ADAPTER_CONTRACT_V1 = "control-room-operations-probe-adapter/v1" as const;

export interface OperationsResourcePolicyV1 {
  contractVersion: typeof OPERATIONS_PROBE_ADAPTER_CONTRACT_V1;
  policyId: string;
  topologyDigest: string;
  maximumMemoryUtilizationPermille: number;
  maximumCpuUtilizationPermille: number;
  maximumStorageUtilizationPermille: number;
  maximumSampleAgeSeconds: number;
  missingMetricDisposition: "unknown";
  thresholdBreachDisposition: "fail";
  advisoryOnly: true;
  grantsServiceControl: false;
  grantsDeploymentAuthority: false;
  policyDigest: string;
}

export interface OperationsResourceEvidenceV1 {
  contractVersion: typeof OPERATIONS_PROBE_ADAPTER_CONTRACT_V1;
  serviceId: OperationsServiceIdV1;
  policyDigest: string;
  observerIdentityDigest: string;
  memoryUtilizationPermille: number;
  cpuUtilizationPermille: number;
  storageUtilizationPermille: number;
  state: "pass" | "fail";
  safeStatusCode: "resource_headroom_current" | "resource_threshold_exceeded";
  observedAt: string;
  validUntil: string;
  containsRawMetrics: false;
  hostInspectedByCoordinator: false;
  grantsServiceControl: false;
  grantsDeploymentAuthority: false;
  evidenceDigest: string;
}

export interface OperationsProbeCollectionV1 {
  contractVersion: typeof OPERATIONS_PROBE_ADAPTER_CONTRACT_V1;
  collectionId: string;
  topologyDigest: string;
  adapterId: string;
  adapterKind: "in_memory_fake_no_io";
  observerIdentityDigest: string;
  resourcePolicy: OperationsResourcePolicyV1;
  resourceEvidence: OperationsResourceEvidenceV1[];
  healthSnapshot: OperationsHealthSnapshotV1;
  requiredProbeCount: number;
  notApplicableProbeCount: number;
  adapterCallCount: number;
  processInspectionAttempted: false;
  filesystemInspectionAttempted: false;
  networkAttempted: false;
  databaseConnectionAttempted: false;
  serviceControlAttempted: false;
  containsRawOutput: false;
  grantsApproval: false;
  grantsServiceControl: false;
  grantsDeploymentAuthority: false;
  collectedAt: string;
  validUntil: string;
  collectionDigest: string;
}

export interface OperationsHealthReadinessProjectionV1 {
  contractVersion: typeof OPERATIONS_PROBE_ADAPTER_CONTRACT_V1;
  collectionDigest: string;
  overallReadiness: "ready_candidate" | "not_ready" | "unknown";
  services: Array<{ serviceId: OperationsServiceIdV1; role: OperationsServiceRoleV1;
    liveness: "live" | "not_live" | "unknown" | "not_applicable";
    readiness: "ready" | "dormant_ready" | "not_ready" | "unknown"; safeStatusCode: string;
    resourceStatusCode: string; serviceProjectionDigest: string }>;
  blockingServiceIds: OperationsServiceIdV1[];
  evidenceValidUntil: string;
  actionControlsPresent: false;
  grantsApproval: false;
  grantsServiceControl: false;
  grantsDeploymentAuthority: false;
  projectionDigest: string;
}

type FakeOverride = { serviceId: OperationsServiceIdV1; probeId: OperationsHealthProbeIdV1;
  state: "pass" | "fail" | "unknown"; safeStatusCode: string };
type FakeResource = { serviceId: OperationsServiceIdV1; memoryUtilizationPermille: number;
  cpuUtilizationPermille: number; storageUtilizationPermille: number };
type FakeAdapterFixture = { adapterId: string; topologyDigest: string; observerIdentityDigest: string;
  observedAt: string; validUntil: string; overrides: FakeOverride[]; resources: FakeResource[] };
type ProbeSample = { probeId: OperationsHealthProbeIdV1; kind: "status"; state: "pass" | "fail" | "unknown";
  safeStatusCode: string; evidenceDigest: string } | { probeId: "resource_headroom"; kind: "resource";
  memoryUtilizationPermille: number; cpuUtilizationPermille: number; storageUtilizationPermille: number };

export interface OperationsFakeProbeAdapterV1 {
  readonly kind: "in_memory_fake_no_io";
  sample(request: { serviceId: OperationsServiceIdV1; role: OperationsServiceRoleV1;
    probeId: OperationsHealthProbeIdV1 }): ProbeSample;
}

const resourcePolicyInputSchema = z.object({ policyId: id, topology: z.unknown(),
  maximumMemoryUtilizationPermille: z.number().int().min(500).max(950),
  maximumCpuUtilizationPermille: z.number().int().min(500).max(950),
  maximumStorageUtilizationPermille: z.number().int().min(500).max(950),
  maximumSampleAgeSeconds: z.number().int().min(15).max(300) }).strict();
const resourcePolicySchema = z.object({ contractVersion: z.literal(OPERATIONS_PROBE_ADAPTER_CONTRACT_V1), policyId: id,
  topologyDigest: digest, maximumMemoryUtilizationPermille: z.number().int().min(500).max(950),
  maximumCpuUtilizationPermille: z.number().int().min(500).max(950),
  maximumStorageUtilizationPermille: z.number().int().min(500).max(950), maximumSampleAgeSeconds: z.number().int().min(15).max(300),
  missingMetricDisposition: z.literal("unknown"), thresholdBreachDisposition: z.literal("fail"), advisoryOnly: z.literal(true),
  grantsServiceControl: z.literal(false), grantsDeploymentAuthority: z.literal(false), policyDigest: digest }).strict();
const resourceEvidenceSchema = z.object({ contractVersion: z.literal(OPERATIONS_PROBE_ADAPTER_CONTRACT_V1),
  serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1), policyDigest: digest, observerIdentityDigest: digest,
  memoryUtilizationPermille: z.number().int().min(0).max(1000), cpuUtilizationPermille: z.number().int().min(0).max(1000),
  storageUtilizationPermille: z.number().int().min(0).max(1000), state: z.enum(["pass", "fail"]),
  safeStatusCode: z.enum(["resource_headroom_current", "resource_threshold_exceeded"]), observedAt: time, validUntil: time,
  containsRawMetrics: z.literal(false), hostInspectedByCoordinator: z.literal(false), grantsServiceControl: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), evidenceDigest: digest }).strict();
const overrideSchema = z.object({ serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1), probeId: z.enum(OPERATIONS_HEALTH_PROBE_IDS_V1),
  state: z.enum(["pass", "fail", "unknown"]), safeStatusCode: id }).strict();
const fakeResourceSchema = z.object({ serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1),
  memoryUtilizationPermille: z.number().int().min(0).max(1000), cpuUtilizationPermille: z.number().int().min(0).max(1000),
  storageUtilizationPermille: z.number().int().min(0).max(1000) }).strict();
const fakeAdapterInputSchema = z.object({ adapterId: id, topology: z.unknown(), observerIdentityDigest: digest,
  observedAt: time, validUntil: time, overrides: z.array(overrideSchema).max(20), resources: z.array(fakeResourceSchema).length(7) }).strict();
const collectionInputSchema = z.object({ collectionId: id, snapshotId: id, topology: z.unknown(), resourcePolicy: z.unknown() }).strict();
const collectionSchema = z.object({ contractVersion: z.literal(OPERATIONS_PROBE_ADAPTER_CONTRACT_V1), collectionId: id,
  topologyDigest: digest, adapterId: id, adapterKind: z.literal("in_memory_fake_no_io"), observerIdentityDigest: digest,
  resourcePolicy: resourcePolicySchema, resourceEvidence: z.array(resourceEvidenceSchema).length(7), healthSnapshot: z.unknown(),
  requiredProbeCount: z.number().int().positive().max(77), notApplicableProbeCount: z.number().int().min(0).max(77),
  adapterCallCount: z.number().int().positive().max(77), processInspectionAttempted: z.literal(false),
  filesystemInspectionAttempted: z.literal(false), networkAttempted: z.literal(false),
  databaseConnectionAttempted: z.literal(false), serviceControlAttempted: z.literal(false), containsRawOutput: z.literal(false),
  grantsApproval: z.literal(false), grantsServiceControl: z.literal(false), grantsDeploymentAuthority: z.literal(false),
  collectedAt: time, validUntil: time, collectionDigest: digest }).strict();
const serviceProjectionSchema = z.object({ serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1), role: z.enum(OPERATIONS_SERVICE_ROLES_V1),
  liveness: z.enum(["live", "not_live", "unknown", "not_applicable"]),
  readiness: z.enum(["ready", "dormant_ready", "not_ready", "unknown"]),
  safeStatusCode: z.enum(["required_probe_failed", "required_probe_unresolved", "one_shot_runner_dormant", "independent_probes_current"]),
  resourceStatusCode: z.enum(["resource_headroom_current", "resource_threshold_exceeded"]), serviceProjectionDigest: digest }).strict();
const projectionSchema = z.object({ contractVersion: z.literal(OPERATIONS_PROBE_ADAPTER_CONTRACT_V1), collectionDigest: digest,
  overallReadiness: z.enum(["ready_candidate", "not_ready", "unknown"]), services: z.array(serviceProjectionSchema).length(7),
  blockingServiceIds: z.array(z.enum(OPERATIONS_SERVICE_IDS_V1)).max(7), evidenceValidUntil: time,
  actionControlsPresent: z.literal(false), grantsApproval: z.literal(false), grantsServiceControl: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), projectionDigest: digest }).strict();
const sampleSchema = z.discriminatedUnion("kind", [
  z.object({ probeId: z.enum(OPERATIONS_HEALTH_PROBE_IDS_V1), kind: z.literal("status"),
    state: z.enum(["pass", "fail", "unknown"]), safeStatusCode: id, evidenceDigest: digest }).strict(),
  z.object({ probeId: z.literal("resource_headroom"), kind: z.literal("resource"),
    memoryUtilizationPermille: z.number().int().min(0).max(1000), cpuUtilizationPermille: z.number().int().min(0).max(1000),
    storageUtilizationPermille: z.number().int().min(0).max(1000) }).strict(),
]);

const trustedAdapters = new WeakMap<object, FakeAdapterFixture>();

export function buildOperationsResourcePolicyV1(inputValue: unknown): OperationsResourcePolicyV1 {
  const input = parseExactOperationsV1(resourcePolicyInputSchema, inputValue, "operations resource policy input"),
    topology = parseOperationsProductionTopologyV1(input.topology);
  const material: Omit<OperationsResourcePolicyV1, "policyDigest"> = {
    contractVersion: OPERATIONS_PROBE_ADAPTER_CONTRACT_V1, policyId: input.policyId, topologyDigest: topology.topologyDigest,
    maximumMemoryUtilizationPermille: input.maximumMemoryUtilizationPermille,
    maximumCpuUtilizationPermille: input.maximumCpuUtilizationPermille,
    maximumStorageUtilizationPermille: input.maximumStorageUtilizationPermille,
    maximumSampleAgeSeconds: input.maximumSampleAgeSeconds, missingMetricDisposition: "unknown",
    thresholdBreachDisposition: "fail", advisoryOnly: true, grantsServiceControl: false, grantsDeploymentAuthority: false,
  };
  return parseOperationsResourcePolicyV1({ ...material, policyDigest: sha256Digest(material) });
}

export function parseOperationsResourcePolicyV1(value: unknown): OperationsResourcePolicyV1 {
  const parsed = parseExactOperationsV1(resourcePolicySchema, value, "operations resource policy");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "policyDigest", parsed.policyDigest);
  return parsed;
}

export function createOperationsFakeProbeAdapterV1(inputValue: unknown): OperationsFakeProbeAdapterV1 {
  const input = parseExactOperationsV1(fakeAdapterInputSchema, inputValue, "operations fake probe adapter input"),
    topology = parseOperationsProductionTopologyV1(input.topology);
  if (Date.parse(input.validUntil) <= Date.parse(input.observedAt)
    || topology.services.some((service) => service.principalIdentityDigest === input.observerIdentityDigest)
    || input.resources.map((resource) => resource.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || new Set(input.overrides.map((override) => `${override.serviceId}|${override.probeId}`)).size !== input.overrides.length
    || input.overrides.some((override) => {
      const service = topology.services.find((item) => item.serviceId === override.serviceId);
      return !service || !operationsRequiredHealthProbesForRoleV1(service.role).includes(override.probeId);
    })) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const fixture: FakeAdapterFixture = { adapterId: input.adapterId, topologyDigest: topology.topologyDigest,
    observerIdentityDigest: input.observerIdentityDigest, observedAt: input.observedAt, validUntil: input.validUntil,
    overrides: input.overrides, resources: input.resources };
  const adapter: OperationsFakeProbeAdapterV1 = Object.freeze({ kind: "in_memory_fake_no_io" as const,
    sample(request: { serviceId: OperationsServiceIdV1; role: OperationsServiceRoleV1; probeId: OperationsHealthProbeIdV1 }): ProbeSample {
      const required = operationsRequiredHealthProbesForRoleV1(request.role);
      if (!required.includes(request.probeId)) throw new OperationsContractErrorV1("unsupported_action");
      if (request.probeId === "resource_headroom") {
        const resource = fixture.resources.find((item) => item.serviceId === request.serviceId)!;
        return { probeId: "resource_headroom", kind: "resource", memoryUtilizationPermille: resource.memoryUtilizationPermille,
          cpuUtilizationPermille: resource.cpuUtilizationPermille, storageUtilizationPermille: resource.storageUtilizationPermille };
      }
      const override = fixture.overrides.find((item) => item.serviceId === request.serviceId && item.probeId === request.probeId);
      const state = override?.state ?? "pass", safeStatusCode = override?.safeStatusCode ?? "fake_probe_current";
      return { probeId: request.probeId, kind: "status", state, safeStatusCode,
        evidenceDigest: sha256Digest({ adapterId: fixture.adapterId, topologyDigest: fixture.topologyDigest,
          serviceId: request.serviceId, role: request.role, probeId: request.probeId, state, safeStatusCode,
          observedAt: fixture.observedAt, evidence: "fake-no-io" }) };
    } });
  trustedAdapters.set(adapter as object, fixture);
  return adapter;
}

function buildResourceEvidence(serviceId: OperationsServiceIdV1, sample: Extract<ProbeSample, { kind: "resource" }>,
  policy: OperationsResourcePolicyV1, fixture: FakeAdapterFixture): OperationsResourceEvidenceV1 {
  const failed = sample.memoryUtilizationPermille > policy.maximumMemoryUtilizationPermille
    || sample.cpuUtilizationPermille > policy.maximumCpuUtilizationPermille
    || sample.storageUtilizationPermille > policy.maximumStorageUtilizationPermille;
  const material: Omit<OperationsResourceEvidenceV1, "evidenceDigest"> = {
    contractVersion: OPERATIONS_PROBE_ADAPTER_CONTRACT_V1, serviceId, policyDigest: policy.policyDigest,
    observerIdentityDigest: fixture.observerIdentityDigest, memoryUtilizationPermille: sample.memoryUtilizationPermille,
    cpuUtilizationPermille: sample.cpuUtilizationPermille, storageUtilizationPermille: sample.storageUtilizationPermille,
    state: failed ? "fail" : "pass", safeStatusCode: failed ? "resource_threshold_exceeded" : "resource_headroom_current",
    observedAt: fixture.observedAt, validUntil: fixture.validUntil, containsRawMetrics: false,
    hostInspectedByCoordinator: false, grantsServiceControl: false, grantsDeploymentAuthority: false,
  };
  const parsed = parseExactOperationsV1(resourceEvidenceSchema, { ...material, evidenceDigest: sha256Digest(material) },
    "operations resource evidence");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "evidenceDigest", parsed.evidenceDigest);
  return parsed;
}

export function collectOperationsHealthWithFakeV1(inputValue: unknown, adapter: OperationsFakeProbeAdapterV1): OperationsProbeCollectionV1 {
  const input = parseExactOperationsV1(collectionInputSchema, inputValue, "operations probe collection input"),
    topology = parseOperationsProductionTopologyV1(input.topology), policy = parseOperationsResourcePolicyV1(input.resourcePolicy),
    fixture = adapter && typeof adapter === "object" ? trustedAdapters.get(adapter as object) : undefined;
  if (!fixture || fixture.topologyDigest !== topology.topologyDigest || policy.topologyDigest !== topology.topologyDigest
    || Date.parse(fixture.validUntil) - Date.parse(fixture.observedAt) > policy.maximumSampleAgeSeconds * 1000) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  let requiredProbeCount = 0, notApplicableProbeCount = 0, adapterCallCount = 0;
  const resourceEvidence: OperationsResourceEvidenceV1[] = [];
  const observations = topology.services.map((service, position) => {
    const required = new Set(operationsRequiredHealthProbesForRoleV1(service.role));
    const probes = OPERATIONS_HEALTH_PROBE_IDS_V1.map((probeId) => {
      if (!required.has(probeId)) {
        notApplicableProbeCount += 1;
        return buildOperationsHealthProbeV1({ probeId, applicability: "not_applicable", state: "not_applicable",
          safeStatusCode: "not_required_for_role", observedAt: fixture.observedAt });
      }
      requiredProbeCount += 1; adapterCallCount += 1;
      const sample = parseExactOperationsV1(sampleSchema, adapter.sample({ serviceId: service.serviceId, role: service.role, probeId }),
        "operations fake probe sample");
      if (sample.probeId !== probeId) throw new OperationsContractErrorV1("scope_mismatch");
      if (sample.kind === "resource") {
        const evidence = buildResourceEvidence(service.serviceId, sample, policy, fixture); resourceEvidence.push(evidence);
        return buildOperationsHealthProbeV1({ probeId, applicability: "required", state: evidence.state,
          safeStatusCode: evidence.safeStatusCode, evidenceDigest: evidence.evidenceDigest, observedAt: fixture.observedAt,
          validUntil: fixture.validUntil, observerIdentityDigest: fixture.observerIdentityDigest });
      }
      return buildOperationsHealthProbeV1({ probeId, applicability: "required", state: sample.state,
        safeStatusCode: sample.safeStatusCode, evidenceDigest: sample.evidenceDigest, observedAt: fixture.observedAt,
        validUntil: fixture.validUntil, observerIdentityDigest: fixture.observerIdentityDigest });
    });
    return buildOperationsServiceHealthV1({ observationId: `observation:operations:fake-adapter:${position}`, topology,
      serviceId: service.serviceId, observerPrincipalDigest: fixture.observerIdentityDigest, probes,
      observedAt: fixture.observedAt, validUntil: fixture.validUntil });
  });
  const healthSnapshot = buildOperationsHealthSnapshotV1({ snapshotId: input.snapshotId, topology, observations,
    observedAt: fixture.observedAt, validUntil: fixture.validUntil });
  const material: Omit<OperationsProbeCollectionV1, "collectionDigest"> = {
    contractVersion: OPERATIONS_PROBE_ADAPTER_CONTRACT_V1, collectionId: input.collectionId,
    topologyDigest: topology.topologyDigest, adapterId: fixture.adapterId, adapterKind: "in_memory_fake_no_io",
    observerIdentityDigest: fixture.observerIdentityDigest, resourcePolicy: policy, resourceEvidence, healthSnapshot,
    requiredProbeCount, notApplicableProbeCount, adapterCallCount, processInspectionAttempted: false,
    filesystemInspectionAttempted: false, networkAttempted: false, databaseConnectionAttempted: false,
    serviceControlAttempted: false, containsRawOutput: false, grantsApproval: false, grantsServiceControl: false,
    grantsDeploymentAuthority: false, collectedAt: fixture.observedAt, validUntil: fixture.validUntil,
  };
  return parseOperationsProbeCollectionV1({ ...material, collectionDigest: sha256Digest(material) });
}

export function parseOperationsProbeCollectionV1(value: unknown): OperationsProbeCollectionV1 {
  const parsedBase = parseExactOperationsV1(collectionSchema, value, "operations probe collection"),
    healthSnapshot = parseOperationsHealthSnapshotV1(parsedBase.healthSnapshot),
    policy = parseOperationsResourcePolicyV1(parsedBase.resourcePolicy),
    resources = parsedBase.resourceEvidence.map((resource) => {
      verifyOperationsDigestV1(resource as unknown as Record<string, unknown>, "evidenceDigest", resource.evidenceDigest); return resource;
    });
  const parsed: OperationsProbeCollectionV1 = { ...parsedBase, resourcePolicy: policy, resourceEvidence: resources, healthSnapshot };
  const expectedRequired = healthSnapshot.observations.reduce((sum, observation) => sum
    + observation.probes.filter((probe) => probe.applicability === "required").length, 0);
  if (parsed.topologyDigest !== healthSnapshot.topologyDigest || resources.map((resource) => resource.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || resources.some((resource) => resource.policyDigest !== policy.policyDigest
      || resource.observerIdentityDigest !== parsed.observerIdentityDigest
      || resource.state !== (resource.memoryUtilizationPermille > policy.maximumMemoryUtilizationPermille
        || resource.cpuUtilizationPermille > policy.maximumCpuUtilizationPermille
        || resource.storageUtilizationPermille > policy.maximumStorageUtilizationPermille ? "fail" : "pass")
      || resource.safeStatusCode !== (resource.state === "fail" ? "resource_threshold_exceeded" : "resource_headroom_current"))
    || healthSnapshot.observations.some((observation, position) => {
      const probe = observation.probes.find((item) => item.probeId === "resource_headroom")!, resource = resources[position]!;
      return probe.evidenceDigest !== resource.evidenceDigest || probe.state !== resource.state
        || probe.safeStatusCode !== resource.safeStatusCode;
    })
    || parsed.requiredProbeCount !== expectedRequired || parsed.notApplicableProbeCount !== 77 - expectedRequired
    || parsed.adapterCallCount !== expectedRequired || parsed.collectedAt !== healthSnapshot.observedAt
    || parsed.validUntil !== healthSnapshot.validUntil
    || Date.parse(parsed.validUntil) - Date.parse(parsed.collectedAt) > policy.maximumSampleAgeSeconds * 1000) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "collectionDigest", parsed.collectionDigest);
  return parsed;
}

export function projectOperationsHealthReadinessV1(value: unknown): OperationsHealthReadinessProjectionV1 {
  const collection = parseOperationsProbeCollectionV1(value);
  const services = collection.healthSnapshot.observations.map((observation, position) => {
    const material = { serviceId: observation.serviceId, role: observation.serviceRole, liveness: observation.liveness,
      readiness: observation.readiness, safeStatusCode: observation.safeStatusCode,
      resourceStatusCode: collection.resourceEvidence[position]!.safeStatusCode };
    return { ...material, serviceProjectionDigest: sha256Digest(material) };
  });
  const material: Omit<OperationsHealthReadinessProjectionV1, "projectionDigest"> = {
    contractVersion: OPERATIONS_PROBE_ADAPTER_CONTRACT_V1, collectionDigest: collection.collectionDigest,
    overallReadiness: collection.healthSnapshot.overallReadiness, services,
    blockingServiceIds: collection.healthSnapshot.blockingServiceIds, evidenceValidUntil: collection.validUntil,
    actionControlsPresent: false, grantsApproval: false, grantsServiceControl: false, grantsDeploymentAuthority: false,
  };
  return parseOperationsHealthReadinessProjectionV1({ ...material, projectionDigest: sha256Digest(material) });
}

export function parseOperationsHealthReadinessProjectionV1(value: unknown): OperationsHealthReadinessProjectionV1 {
  const parsed = parseExactOperationsV1(projectionSchema, value, "operations health readiness projection");
  if (parsed.services.map((service) => service.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || parsed.services.map((service) => service.role).join("|") !== OPERATIONS_SERVICE_ROLES_V1.join("|")
    || parsed.services.some((service) => service.role === "migration_runner"
      ? service.liveness !== "not_applicable" || !["dormant_ready", "not_ready", "unknown"].includes(service.readiness)
      : service.liveness === "not_applicable" || service.readiness === "dormant_ready")
    || parsed.blockingServiceIds.join("|") !== parsed.services.filter((service) => service.readiness !== "ready"
      && service.readiness !== "dormant_ready").map((service) => service.serviceId).join("|")
    || parsed.overallReadiness !== (parsed.blockingServiceIds.length === 0 ? "ready_candidate"
      : parsed.services.some((service) => service.readiness === "not_ready") ? "not_ready" : "unknown")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  for (const service of parsed.services) verifyOperationsDigestV1(service as unknown as Record<string, unknown>,
    "serviceProjectionDigest", service.serviceProjectionDigest);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "projectionDigest", parsed.projectionDigest);
  return parsed;
}

export function buildOperationsSyntheticFakeProbeAdapterInputV1(topologyValue: unknown,
  mode: "passing" | "application_database_failure" | "edge_resource_pressure" = "passing") {
  const topology = parseOperationsProductionTopologyV1(topologyValue), observerIdentityDigest = sha256Digest({
    topologyDigest: topology.topologyDigest, identity: "synthetic-independent-fake-observer" });
  const overrides: FakeOverride[] = mode === "application_database_failure" ? [{
    serviceId: OPERATIONS_SERVICE_IDS_V1[1], probeId: "database_transaction", state: "fail",
    safeStatusCode: "database_transaction_failed",
  }] : [];
  const resources: FakeResource[] = OPERATIONS_SERVICE_IDS_V1.map((serviceId, position) => ({ serviceId,
    memoryUtilizationPermille: mode === "edge_resource_pressure" && position === 0 ? 901 : 400,
    cpuUtilizationPermille: 350, storageUtilizationPermille: 300 }));
  return { adapterId: `adapter:operations:fake:${mode}`, topology, observerIdentityDigest,
    observedAt: "2026-08-30T00:10:00.000Z", validUntil: "2026-08-30T00:11:00.000Z", overrides, resources };
}
