import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 } from "./deployment";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { OPERATIONS_SERVICE_IDS_V1, parseOperationsProductionTopologyV1,
  type OperationsProductionTopologyV1, type OperationsServiceIdV1, type OperationsServiceRoleV1 } from "./topology";

export const OPERATIONS_HEALTH_CONTRACT_V1 = "control-room-operations-health/v1" as const;
export const OPERATIONS_HEALTH_PROBE_IDS_V1 = [
  "process_identity",
  "release_identity",
  "configuration_identity",
  "dependency_connectivity",
  "database_transaction",
  "audit_append",
  "queue_progress",
  "backup_freshness",
  "wal_archiving",
  "resource_headroom",
  "clock_monotonicity",
] as const;
export type OperationsHealthProbeIdV1 = (typeof OPERATIONS_HEALTH_PROBE_IDS_V1)[number];

export interface OperationsHealthProbeV1 {
  contractVersion: typeof OPERATIONS_HEALTH_CONTRACT_V1;
  probeId: OperationsHealthProbeIdV1;
  applicability: "required" | "not_applicable";
  state: "pass" | "fail" | "unknown" | "stale" | "not_applicable";
  safeStatusCode: string;
  evidenceDigest?: string;
  observedAt: string;
  validUntil?: string;
  observerIdentityDigest?: string;
  containsRawOutput: false;
  grantsServiceControl: false;
  grantsDeploymentAuthority: false;
  probeDigest: string;
}

export interface OperationsServiceHealthV1 {
  contractVersion: typeof OPERATIONS_HEALTH_CONTRACT_V1;
  observationId: string;
  topologyDigest: string;
  deploymentId: string;
  serviceId: OperationsServiceIdV1;
  serviceRole: OperationsServiceRoleV1;
  serviceDigest: string;
  servicePrincipalDigest: string;
  observerPrincipalDigest: string;
  desiredPresence: "running" | "dormant_until_owner_window";
  probes: OperationsHealthProbeV1[];
  liveness: "live" | "not_live" | "unknown" | "not_applicable";
  readiness: "ready" | "dormant_ready" | "not_ready" | "unknown";
  safeStatusCode: string;
  observedAt: string;
  validUntil: string;
  selfReportSufficient: false;
  serviceControlAttempted: false;
  networkProbeAttemptedByContract: false;
  grantsApproval: false;
  grantsServiceControl: false;
  grantsDeploymentAuthority: false;
  observationDigest: string;
}

export interface OperationsHealthSnapshotV1 {
  contractVersion: typeof OPERATIONS_HEALTH_CONTRACT_V1;
  snapshotId: string;
  topologyDigest: string;
  deploymentId: string;
  observations: OperationsServiceHealthV1[];
  overallReadiness: "ready_candidate" | "not_ready" | "unknown";
  blockingServiceIds: OperationsServiceIdV1[];
  observedAt: string;
  validUntil: string;
  independentEvidenceRequired: true;
  deployableHealthAuthority: false;
  grantsApproval: false;
  grantsServiceControl: false;
  grantsDeploymentAuthority: false;
  snapshotDigest: string;
}

const probeId = z.enum(OPERATIONS_HEALTH_PROBE_IDS_V1);
const probeInputSchema = z.object({ probeId, applicability: z.enum(["required", "not_applicable"]),
  state: z.enum(["pass", "fail", "unknown", "stale", "not_applicable"]), safeStatusCode: id,
  evidenceDigest: digest.optional(), observedAt: time, validUntil: time.optional(), observerIdentityDigest: digest.optional() }).strict();
const probeSchema = z.object({ contractVersion: z.literal(OPERATIONS_HEALTH_CONTRACT_V1), probeId,
  applicability: z.enum(["required", "not_applicable"]), state: z.enum(["pass", "fail", "unknown", "stale", "not_applicable"]),
  safeStatusCode: id, evidenceDigest: digest.optional(), observedAt: time, validUntil: time.optional(),
  observerIdentityDigest: digest.optional(), containsRawOutput: z.literal(false), grantsServiceControl: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), probeDigest: digest }).strict();
const observationInputSchema = z.object({ observationId: id, topology: z.unknown(), serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1),
  observerPrincipalDigest: digest, probes: z.array(z.unknown()).length(11), observedAt: time, validUntil: time }).strict();
const observationSchema = z.object({ contractVersion: z.literal(OPERATIONS_HEALTH_CONTRACT_V1), observationId: id,
  topologyDigest: digest, deploymentId: id, serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1),
  serviceRole: z.enum(["edge_connector", "control_room_application", "migration_runner", "postgres_primary",
    "backup_controller", "audit_anchor", "operations_observer"]), serviceDigest: digest, servicePrincipalDigest: digest,
  observerPrincipalDigest: digest,
  desiredPresence: z.enum(["running", "dormant_until_owner_window"]), probes: z.array(probeSchema).length(11),
  liveness: z.enum(["live", "not_live", "unknown", "not_applicable"]),
  readiness: z.enum(["ready", "dormant_ready", "not_ready", "unknown"]), safeStatusCode: id,
  observedAt: time, validUntil: time, selfReportSufficient: z.literal(false), serviceControlAttempted: z.literal(false),
  networkProbeAttemptedByContract: z.literal(false), grantsApproval: z.literal(false), grantsServiceControl: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), observationDigest: digest }).strict();
const snapshotInputSchema = z.object({ snapshotId: id, topology: z.unknown(), observations: z.array(z.unknown()).length(7),
  observedAt: time, validUntil: time }).strict();
const snapshotSchema = z.object({ contractVersion: z.literal(OPERATIONS_HEALTH_CONTRACT_V1), snapshotId: id,
  topologyDigest: digest, deploymentId: id, observations: z.array(observationSchema).length(7),
  overallReadiness: z.enum(["ready_candidate", "not_ready", "unknown"]),
  blockingServiceIds: z.array(z.enum(OPERATIONS_SERVICE_IDS_V1)).max(7), observedAt: time, validUntil: time,
  independentEvidenceRequired: z.literal(true), deployableHealthAuthority: z.literal(false), grantsApproval: z.literal(false),
  grantsServiceControl: z.literal(false), grantsDeploymentAuthority: z.literal(false), snapshotDigest: digest }).strict();

const requiredByRole: Record<OperationsServiceRoleV1, OperationsHealthProbeIdV1[]> = {
  edge_connector: ["process_identity", "release_identity", "configuration_identity", "dependency_connectivity",
    "resource_headroom", "clock_monotonicity"],
  control_room_application: ["process_identity", "release_identity", "configuration_identity", "dependency_connectivity",
    "database_transaction", "audit_append", "queue_progress", "resource_headroom", "clock_monotonicity"],
  migration_runner: ["release_identity", "configuration_identity", "database_transaction", "resource_headroom", "clock_monotonicity"],
  postgres_primary: ["process_identity", "release_identity", "configuration_identity", "database_transaction", "wal_archiving",
    "resource_headroom", "clock_monotonicity"],
  backup_controller: ["process_identity", "release_identity", "configuration_identity", "dependency_connectivity",
    "backup_freshness", "wal_archiving", "resource_headroom", "clock_monotonicity"],
  audit_anchor: ["process_identity", "release_identity", "configuration_identity", "dependency_connectivity", "audit_append",
    "resource_headroom", "clock_monotonicity"],
  operations_observer: ["process_identity", "release_identity", "configuration_identity", "dependency_connectivity",
    "resource_headroom", "clock_monotonicity"],
};

export function operationsRequiredHealthProbesForRoleV1(role: OperationsServiceRoleV1): OperationsHealthProbeIdV1[] {
  return [...requiredByRole[role]];
}

export function buildOperationsHealthProbeV1(inputValue: unknown): OperationsHealthProbeV1 {
  const input = parseExactOperationsV1(probeInputSchema, inputValue, "operations health probe input");
  if ((input.applicability === "not_applicable") !== (input.state === "not_applicable")
    || (input.state === "not_applicable" && (input.evidenceDigest || input.validUntil || input.observerIdentityDigest))
    || (input.state !== "not_applicable" && (!input.evidenceDigest || !input.validUntil || !input.observerIdentityDigest))
    || (input.state === "pass" && Date.parse(input.validUntil!) <= Date.parse(input.observedAt))
    || (input.state === "stale" && Date.parse(input.validUntil!) > Date.parse(input.observedAt))) {
    throw new OperationsContractErrorV1("invalid_input");
  }
  const material: Omit<OperationsHealthProbeV1, "probeDigest"> = { contractVersion: OPERATIONS_HEALTH_CONTRACT_V1,
    probeId: input.probeId, applicability: input.applicability, state: input.state, safeStatusCode: input.safeStatusCode,
    ...(input.evidenceDigest ? { evidenceDigest: input.evidenceDigest } : {}), observedAt: input.observedAt,
    ...(input.validUntil ? { validUntil: input.validUntil } : {}),
    ...(input.observerIdentityDigest ? { observerIdentityDigest: input.observerIdentityDigest } : {}),
    containsRawOutput: false, grantsServiceControl: false, grantsDeploymentAuthority: false };
  return parseOperationsHealthProbeV1({ ...material, probeDigest: sha256Digest(material) });
}

export function parseOperationsHealthProbeV1(value: unknown): OperationsHealthProbeV1 {
  const parsed = parseExactOperationsV1(probeSchema, value, "operations health probe");
  if ((parsed.applicability === "not_applicable") !== (parsed.state === "not_applicable")
    || (parsed.state === "not_applicable" && (parsed.evidenceDigest || parsed.validUntil || parsed.observerIdentityDigest))
    || (parsed.state !== "not_applicable" && (!parsed.evidenceDigest || !parsed.validUntil || !parsed.observerIdentityDigest))
    || (parsed.state === "pass" && Date.parse(parsed.validUntil!) <= Date.parse(parsed.observedAt))
    || (parsed.state === "stale" && Date.parse(parsed.validUntil!) > Date.parse(parsed.observedAt))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "probeDigest", parsed.probeDigest);
  return parsed;
}

function deriveHealth(role: OperationsServiceRoleV1, probes: OperationsHealthProbeV1[]) {
  const required = new Set(requiredByRole[role]);
  if (probes.some((probe) => required.has(probe.probeId) !== (probe.applicability === "required"))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const relevant = probes.filter((probe) => required.has(probe.probeId));
  const process = probes.find((probe) => probe.probeId === "process_identity")!;
  const liveness = role === "migration_runner" ? "not_applicable" as const : process.state === "pass" ? "live" as const
    : process.state === "fail" ? "not_live" as const : "unknown" as const;
  if (relevant.some((probe) => probe.state === "fail")) return { liveness, readiness: "not_ready" as const, safeStatusCode: "required_probe_failed" };
  if (relevant.some((probe) => probe.state !== "pass")) return { liveness, readiness: "unknown" as const, safeStatusCode: "required_probe_unresolved" };
  return role === "migration_runner" ? { liveness, readiness: "dormant_ready" as const, safeStatusCode: "one_shot_runner_dormant" }
    : { liveness, readiness: "ready" as const, safeStatusCode: "independent_probes_current" };
}

export function buildOperationsServiceHealthV1(inputValue: unknown): OperationsServiceHealthV1 {
  const input = parseExactOperationsV1(observationInputSchema, inputValue, "operations service health input"),
    topology = parseOperationsProductionTopologyV1(input.topology), service = topology.services.find((item) => item.serviceId === input.serviceId);
  if (!service || input.observerPrincipalDigest === service.principalIdentityDigest
    || Date.parse(input.validUntil) <= Date.parse(input.observedAt)) throw new OperationsContractErrorV1("scope_mismatch");
  const probes = input.probes.map(parseOperationsHealthProbeV1);
  if (probes.map((probe) => probe.probeId).join("|") !== OPERATIONS_HEALTH_PROBE_IDS_V1.join("|")
    || probes.some((probe) => probe.observerIdentityDigest && probe.observerIdentityDigest !== input.observerPrincipalDigest)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const derived = deriveHealth(service.role, probes);
  const material: Omit<OperationsServiceHealthV1, "observationDigest"> = {
    contractVersion: OPERATIONS_HEALTH_CONTRACT_V1, observationId: input.observationId, topologyDigest: topology.topologyDigest,
    deploymentId: topology.deploymentId, serviceId: service.serviceId, serviceRole: service.role,
    serviceDigest: service.serviceDigest, servicePrincipalDigest: service.principalIdentityDigest,
    observerPrincipalDigest: input.observerPrincipalDigest,
    desiredPresence: service.role === "migration_runner" ? "dormant_until_owner_window" : "running", probes,
    liveness: derived.liveness, readiness: derived.readiness, safeStatusCode: derived.safeStatusCode,
    observedAt: input.observedAt, validUntil: input.validUntil, selfReportSufficient: false,
    serviceControlAttempted: false, networkProbeAttemptedByContract: false, grantsApproval: false,
    grantsServiceControl: false, grantsDeploymentAuthority: false };
  return parseOperationsServiceHealthV1({ ...material, observationDigest: sha256Digest(material) });
}

export function parseOperationsServiceHealthV1(value: unknown): OperationsServiceHealthV1 {
  const parsed = parseExactOperationsV1(observationSchema, value, "operations service health"),
    probes = parsed.probes.map(parseOperationsHealthProbeV1), derived = deriveHealth(parsed.serviceRole, probes);
  if (probes.map((probe) => probe.probeId).join("|") !== OPERATIONS_HEALTH_PROBE_IDS_V1.join("|")
    || parsed.liveness !== derived.liveness || parsed.readiness !== derived.readiness || parsed.safeStatusCode !== derived.safeStatusCode
    || parsed.observerPrincipalDigest === parsed.servicePrincipalDigest
    || probes.some((probe) => probe.observerIdentityDigest && probe.observerIdentityDigest !== parsed.observerPrincipalDigest)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "observationDigest", parsed.observationDigest);
  return parsed;
}

export function buildOperationsHealthSnapshotV1(inputValue: unknown): OperationsHealthSnapshotV1 {
  const input = parseExactOperationsV1(snapshotInputSchema, inputValue, "operations health snapshot input"),
    topology = parseOperationsProductionTopologyV1(input.topology), observations = input.observations.map(parseOperationsServiceHealthV1);
  if (Date.parse(input.validUntil) <= Date.parse(input.observedAt)
    || observations.map((item) => item.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || observations.some((item, position) => item.topologyDigest !== topology.topologyDigest
      || item.serviceDigest !== topology.services[position]!.serviceDigest
      || item.servicePrincipalDigest !== topology.services[position]!.principalIdentityDigest
      || Date.parse(item.validUntil) < Date.parse(input.validUntil))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const blockingServiceIds = observations.filter((item) => item.readiness !== "ready" && item.readiness !== "dormant_ready")
    .map((item) => item.serviceId);
  const overallReadiness = blockingServiceIds.length === 0 ? "ready_candidate" as const
    : observations.some((item) => item.readiness === "not_ready") ? "not_ready" as const : "unknown" as const;
  const material: Omit<OperationsHealthSnapshotV1, "snapshotDigest"> = { contractVersion: OPERATIONS_HEALTH_CONTRACT_V1,
    snapshotId: input.snapshotId, topologyDigest: topology.topologyDigest, deploymentId: topology.deploymentId,
    observations, overallReadiness, blockingServiceIds, observedAt: input.observedAt, validUntil: input.validUntil,
    independentEvidenceRequired: true, deployableHealthAuthority: false, grantsApproval: false,
    grantsServiceControl: false, grantsDeploymentAuthority: false };
  return parseOperationsHealthSnapshotV1({ ...material, snapshotDigest: sha256Digest(material) });
}

export function parseOperationsHealthSnapshotV1(value: unknown): OperationsHealthSnapshotV1 {
  const parsed = parseExactOperationsV1(snapshotSchema, value, "operations health snapshot"),
    observations = parsed.observations.map(parseOperationsServiceHealthV1), blockers = observations
      .filter((item) => item.readiness !== "ready" && item.readiness !== "dormant_ready").map((item) => item.serviceId),
    overall = blockers.length === 0 ? "ready_candidate" : observations.some((item) => item.readiness === "not_ready") ? "not_ready" : "unknown";
  if (observations.map((item) => item.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || blockers.join("|") !== parsed.blockingServiceIds.join("|") || parsed.overallReadiness !== overall) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "snapshotDigest", parsed.snapshotDigest);
  return parsed;
}

export function buildOperationsSyntheticHealthSnapshotV1(topology: OperationsProductionTopologyV1,
  mode: "passing" | "application_failed" = "passing"): OperationsHealthSnapshotV1 {
  const observer = sha256Digest({ observer: "synthetic-independent-operations-observer" }),
    observedAt = "2026-08-30T00:01:00.000Z", validUntil = "2026-08-30T00:02:00.000Z";
  const observations = topology.services.map((service, servicePosition) => {
    const required = new Set(requiredByRole[service.role]);
    const probes = OPERATIONS_HEALTH_PROBE_IDS_V1.map((currentProbe) => {
      const applicable = required.has(currentProbe);
      if (!applicable) return buildOperationsHealthProbeV1({ probeId: currentProbe, applicability: "not_applicable",
        state: "not_applicable", safeStatusCode: "not_required_for_role", observedAt });
      const failed = mode === "application_failed" && service.role === "control_room_application" && currentProbe === "database_transaction";
      return buildOperationsHealthProbeV1({ probeId: currentProbe, applicability: "required", state: failed ? "fail" : "pass",
        safeStatusCode: failed ? "database_transaction_failed" : "synthetic_probe_current",
        evidenceDigest: sha256Digest({ service: service.role, probe: currentProbe, mode }), observedAt, validUntil,
        observerIdentityDigest: observer });
    });
    return buildOperationsServiceHealthV1({ observationId: `observation:operations:service:${servicePosition}`,
      topology, serviceId: service.serviceId, observerPrincipalDigest: observer, probes, observedAt, validUntil });
  });
  return buildOperationsHealthSnapshotV1({ snapshotId: `snapshot:operations:health:${mode}`, topology, observations,
    observedAt, validUntil });
}

if (OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 !== sha256Digest({ contractVersion: OPERATIONS_HEALTH_CONTRACT_V1,
  evidence: "exact-health-readiness-contract" })) throw new OperationsContractErrorV1("digest_mismatch");

export const operationsHealthSchemasV1 = { probe: probeSchema, serviceHealth: observationSchema, snapshot: snapshotSchema } as const;
