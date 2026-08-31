import { z } from "zod";
import {
  projectWorkspaceDigestSchemaV1 as digest,
  projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time,
} from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";

export const OPERATIONS_TOPOLOGY_CONTRACT_V1 = "control-room-operations-topology/v1" as const;
export const OPERATIONS_SERVICE_ROLES_V1 = [
  "edge_connector",
  "control_room_application",
  "migration_runner",
  "postgres_primary",
  "backup_controller",
  "audit_anchor",
  "operations_observer",
] as const;
export type OperationsServiceRoleV1 = (typeof OPERATIONS_SERVICE_ROLES_V1)[number];
export const OPERATIONS_SERVICE_IDS_V1 = [
  "service:operations:edge",
  "service:operations:application",
  "service:operations:migration",
  "service:operations:postgres",
  "service:operations:backup",
  "service:operations:audit-anchor",
  "service:operations:observer",
] as const;
export type OperationsServiceIdV1 = (typeof OPERATIONS_SERVICE_IDS_V1)[number];

export interface OperationsServiceDefinitionV1 {
  serviceId: OperationsServiceIdV1;
  role: OperationsServiceRoleV1;
  lifecycle: "steady_state" | "one_shot_owner_window";
  trustZone: "edge" | "application" | "data" | "operations";
  artifactIdentityDigest: string;
  configurationSchemaDigest: string;
  principalIdentityDigest: string;
  credentialReferenceDigests: string[];
  runsAsRoot: false;
  hostAdministrationAllowed: false;
  publicListenerAllowed: false;
  directNodeListenerAllowed: false;
  schemaMutationAllowed: boolean;
  productionDataMutationAllowed: boolean;
  resolvesDeclaredCredentialReferences: boolean;
  credentialMaterialPersisted: false;
  credentialMaterialLogged: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  serviceDigest: string;
}

export interface OperationsNetworkFlowV1 {
  flowId: string;
  source: string;
  destination: string;
  purpose: "owner_ingress" | "node_protocol" | "application_database" | "application_artifact"
    | "migration_database" | "backup_read" | "backup_archive" | "audit_read" | "audit_anchor_write" | "health_observation";
  direction: "inbound_via_protected_edge" | "outbound_only" | "host_local";
  authentication: "edge_access_identity" | "node_asymmetric_identity" | "local_service_identity"
    | "database_role_tls" | "scoped_object_credential" | "owner_strong_one_use" | "read_only_observer_identity";
  exactPeerIdentityRequired: true;
  redirectsAllowed: false;
  wildcardDestinationAllowed: false;
  rawAddressStored: false;
  grantsNetworkAuthority: false;
  flowDigest: string;
}

export interface OperationsProductionTopologyV1 {
  contractVersion: typeof OPERATIONS_TOPOLOGY_CONTRACT_V1;
  topologyId: string;
  deploymentId: string;
  environment: "production_candidate";
  architecture: "single_host_modular_monolith";
  availabilityModel: "recovery_based_single_primary";
  globalWriteAuthority: "postgres_primary_only";
  edgeModel: "protected_tunnel_no_public_origin";
  nodeConnectivity: "outbound_authenticated_only";
  artifactModel: "approved_object_storage_not_coordination";
  services: OperationsServiceDefinitionV1[];
  networkFlows: OperationsNetworkFlowV1[];
  externalDependencyClasses: ["protected_edge", "approved_object_storage"];
  unknownNetworkFlowsDenied: true;
  sharedOperatingSystemPrincipalAllowed: false;
  productionValuesPresent: false;
  hostnamesPresent: false;
  addressesPresent: false;
  portsPresent: false;
  credentialValuesPresent: false;
  deployableConfigurationPresent: false;
  grantsApproval: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  createdAt: string;
  topologyDigest: string;
}

const serviceRole = z.enum(OPERATIONS_SERVICE_ROLES_V1);
const serviceId = z.enum(OPERATIONS_SERVICE_IDS_V1);
const serviceSchema = z.object({ serviceId, role: serviceRole, lifecycle: z.enum(["steady_state", "one_shot_owner_window"]),
  trustZone: z.enum(["edge", "application", "data", "operations"]), artifactIdentityDigest: digest,
  configurationSchemaDigest: digest, principalIdentityDigest: digest, credentialReferenceDigests: z.array(digest).max(4),
  runsAsRoot: z.literal(false), hostAdministrationAllowed: z.literal(false), publicListenerAllowed: z.literal(false),
  directNodeListenerAllowed: z.literal(false), schemaMutationAllowed: z.boolean(), productionDataMutationAllowed: z.boolean(),
  resolvesDeclaredCredentialReferences: z.boolean(), credentialMaterialPersisted: z.literal(false),
  credentialMaterialLogged: z.literal(false), grantsDeploymentAuthority: z.literal(false),
  grantsExecutionAuthority: z.literal(false), serviceDigest: digest }).strict();
const flowSchema = z.object({ flowId: id, source: id, destination: id,
  purpose: z.enum(["owner_ingress", "node_protocol", "application_database", "application_artifact", "migration_database",
    "backup_read", "backup_archive", "audit_read", "audit_anchor_write", "health_observation"]),
  direction: z.enum(["inbound_via_protected_edge", "outbound_only", "host_local"]),
  authentication: z.enum(["edge_access_identity", "node_asymmetric_identity", "local_service_identity", "database_role_tls",
    "scoped_object_credential", "owner_strong_one_use", "read_only_observer_identity"]),
  exactPeerIdentityRequired: z.literal(true), redirectsAllowed: z.literal(false), wildcardDestinationAllowed: z.literal(false),
  rawAddressStored: z.literal(false), grantsNetworkAuthority: z.literal(false), flowDigest: digest }).strict();
const topologyInputSchema = z.object({ topologyId: id, deploymentId: id, serviceArtifactDigests: z.tuple([
  digest, digest, digest, digest, digest, digest, digest]), configurationSchemaDigest: digest,
  credentialReferenceDigests: z.object({ edge: z.array(digest).max(2), application: z.array(digest).max(3),
    migration: z.array(digest).max(2), postgres: z.array(digest).max(2), backup: z.array(digest).max(4),
    auditAnchor: z.array(digest).max(3), observer: z.array(digest).max(2) }).strict(), createdAt: time }).strict();
const topologySchema = z.object({ contractVersion: z.literal(OPERATIONS_TOPOLOGY_CONTRACT_V1), topologyId: id, deploymentId: id,
  environment: z.literal("production_candidate"), architecture: z.literal("single_host_modular_monolith"),
  availabilityModel: z.literal("recovery_based_single_primary"), globalWriteAuthority: z.literal("postgres_primary_only"),
  edgeModel: z.literal("protected_tunnel_no_public_origin"), nodeConnectivity: z.literal("outbound_authenticated_only"),
  artifactModel: z.literal("approved_object_storage_not_coordination"), services: z.array(serviceSchema).length(7),
  networkFlows: z.array(flowSchema).length(15), externalDependencyClasses: z.tuple([z.literal("protected_edge"),
    z.literal("approved_object_storage")]), unknownNetworkFlowsDenied: z.literal(true),
  sharedOperatingSystemPrincipalAllowed: z.literal(false), productionValuesPresent: z.literal(false),
  hostnamesPresent: z.literal(false), addressesPresent: z.literal(false), portsPresent: z.literal(false),
  credentialValuesPresent: z.literal(false), deployableConfigurationPresent: z.literal(false), grantsApproval: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), createdAt: time,
  topologyDigest: digest }).strict();

const roleDetails: Record<OperationsServiceRoleV1, Pick<OperationsServiceDefinitionV1, "lifecycle" | "trustZone"
  | "schemaMutationAllowed" | "productionDataMutationAllowed" | "resolvesDeclaredCredentialReferences">> = {
  edge_connector: { lifecycle: "steady_state", trustZone: "edge", schemaMutationAllowed: false,
    productionDataMutationAllowed: false, resolvesDeclaredCredentialReferences: true },
  control_room_application: { lifecycle: "steady_state", trustZone: "application", schemaMutationAllowed: false,
    productionDataMutationAllowed: true, resolvesDeclaredCredentialReferences: true },
  migration_runner: { lifecycle: "one_shot_owner_window", trustZone: "operations", schemaMutationAllowed: true,
    productionDataMutationAllowed: true, resolvesDeclaredCredentialReferences: true },
  postgres_primary: { lifecycle: "steady_state", trustZone: "data", schemaMutationAllowed: false,
    productionDataMutationAllowed: true, resolvesDeclaredCredentialReferences: true },
  backup_controller: { lifecycle: "steady_state", trustZone: "operations", schemaMutationAllowed: false,
    productionDataMutationAllowed: false, resolvesDeclaredCredentialReferences: true },
  audit_anchor: { lifecycle: "steady_state", trustZone: "operations", schemaMutationAllowed: false,
    productionDataMutationAllowed: false, resolvesDeclaredCredentialReferences: true },
  operations_observer: { lifecycle: "steady_state", trustZone: "operations", schemaMutationAllowed: false,
    productionDataMutationAllowed: false, resolvesDeclaredCredentialReferences: true },
};

function makeService(input: { deploymentId: string; role: OperationsServiceRoleV1; serviceId: OperationsServiceIdV1;
  artifactIdentityDigest: string; configurationSchemaDigest: string; credentialReferenceDigests: string[] }): OperationsServiceDefinitionV1 {
  const details = roleDetails[input.role], material: Omit<OperationsServiceDefinitionV1, "serviceDigest"> = {
    serviceId: input.serviceId, role: input.role, lifecycle: details.lifecycle, trustZone: details.trustZone,
    artifactIdentityDigest: input.artifactIdentityDigest, configurationSchemaDigest: input.configurationSchemaDigest,
    principalIdentityDigest: sha256Digest({ deploymentId: input.deploymentId, role: input.role, principal: "distinct" }),
    credentialReferenceDigests: input.credentialReferenceDigests, runsAsRoot: false, hostAdministrationAllowed: false,
    publicListenerAllowed: false, directNodeListenerAllowed: false, schemaMutationAllowed: details.schemaMutationAllowed,
    productionDataMutationAllowed: details.productionDataMutationAllowed,
    resolvesDeclaredCredentialReferences: details.resolvesDeclaredCredentialReferences, credentialMaterialPersisted: false,
    credentialMaterialLogged: false, grantsDeploymentAuthority: false, grantsExecutionAuthority: false };
  return { ...material, serviceDigest: sha256Digest(material) };
}

type FlowMaterial = Omit<OperationsNetworkFlowV1, "flowDigest" | "exactPeerIdentityRequired" | "redirectsAllowed"
  | "wildcardDestinationAllowed" | "rawAddressStored" | "grantsNetworkAuthority">;
function makeFlow(input: FlowMaterial): OperationsNetworkFlowV1 {
  const material: Omit<OperationsNetworkFlowV1, "flowDigest"> = { ...input, exactPeerIdentityRequired: true,
    redirectsAllowed: false, wildcardDestinationAllowed: false, rawAddressStored: false, grantsNetworkAuthority: false };
  return { ...material, flowDigest: sha256Digest(material) };
}

function standardFlows(): OperationsNetworkFlowV1[] {
  const values: FlowMaterial[] = [
    { flowId: "flow:owner:edge", source: "external:owner-browser", destination: OPERATIONS_SERVICE_IDS_V1[0],
      purpose: "owner_ingress", direction: "inbound_via_protected_edge", authentication: "edge_access_identity" },
    { flowId: "flow:node:edge", source: "external:node-bridge", destination: OPERATIONS_SERVICE_IDS_V1[0],
      purpose: "node_protocol", direction: "outbound_only", authentication: "node_asymmetric_identity" },
    { flowId: "flow:edge:app", source: OPERATIONS_SERVICE_IDS_V1[0], destination: OPERATIONS_SERVICE_IDS_V1[1],
      purpose: "owner_ingress", direction: "host_local", authentication: "local_service_identity" },
    { flowId: "flow:app:postgres", source: OPERATIONS_SERVICE_IDS_V1[1], destination: OPERATIONS_SERVICE_IDS_V1[3],
      purpose: "application_database", direction: "host_local", authentication: "database_role_tls" },
    { flowId: "flow:app:objects", source: OPERATIONS_SERVICE_IDS_V1[1], destination: "external:approved-object-storage",
      purpose: "application_artifact", direction: "outbound_only", authentication: "scoped_object_credential" },
    { flowId: "flow:migration:postgres", source: OPERATIONS_SERVICE_IDS_V1[2], destination: OPERATIONS_SERVICE_IDS_V1[3],
      purpose: "migration_database", direction: "host_local", authentication: "owner_strong_one_use" },
    { flowId: "flow:backup:postgres", source: OPERATIONS_SERVICE_IDS_V1[4], destination: OPERATIONS_SERVICE_IDS_V1[3],
      purpose: "backup_read", direction: "host_local", authentication: "database_role_tls" },
    { flowId: "flow:backup:objects", source: OPERATIONS_SERVICE_IDS_V1[4], destination: "external:approved-object-storage",
      purpose: "backup_archive", direction: "outbound_only", authentication: "scoped_object_credential" },
    { flowId: "flow:audit:postgres", source: OPERATIONS_SERVICE_IDS_V1[5], destination: OPERATIONS_SERVICE_IDS_V1[3],
      purpose: "audit_read", direction: "host_local", authentication: "database_role_tls" },
    { flowId: "flow:audit:objects", source: OPERATIONS_SERVICE_IDS_V1[5], destination: "external:approved-object-storage",
      purpose: "audit_anchor_write", direction: "outbound_only", authentication: "scoped_object_credential" },
    ...OPERATIONS_SERVICE_IDS_V1.slice(0, 5).map((destination, index) => ({ flowId: `flow:observer:${index}`,
      source: OPERATIONS_SERVICE_IDS_V1[6], destination, purpose: "health_observation" as const, direction: "host_local" as const,
      authentication: "read_only_observer_identity" as const })),
  ];
  return values.map(makeFlow);
}

export function buildOperationsProductionTopologyV1(inputValue: unknown): OperationsProductionTopologyV1 {
  const input = parseExactOperationsV1(topologyInputSchema, inputValue, "operations topology input");
  const references = input.credentialReferenceDigests;
  const referenceSets = [references.edge, references.application, references.migration, references.postgres, references.backup,
    references.auditAnchor, references.observer];
  const services = OPERATIONS_SERVICE_ROLES_V1.map((role, position) => makeService({ deploymentId: input.deploymentId, role,
    serviceId: OPERATIONS_SERVICE_IDS_V1[position]!, artifactIdentityDigest: input.serviceArtifactDigests[position]!,
    configurationSchemaDigest: input.configurationSchemaDigest, credentialReferenceDigests: referenceSets[position]! }));
  const material: Omit<OperationsProductionTopologyV1, "topologyDigest"> = {
    contractVersion: OPERATIONS_TOPOLOGY_CONTRACT_V1, topologyId: input.topologyId, deploymentId: input.deploymentId,
    environment: "production_candidate", architecture: "single_host_modular_monolith",
    availabilityModel: "recovery_based_single_primary", globalWriteAuthority: "postgres_primary_only",
    edgeModel: "protected_tunnel_no_public_origin", nodeConnectivity: "outbound_authenticated_only",
    artifactModel: "approved_object_storage_not_coordination", services, networkFlows: standardFlows(),
    externalDependencyClasses: ["protected_edge", "approved_object_storage"], unknownNetworkFlowsDenied: true,
    sharedOperatingSystemPrincipalAllowed: false, productionValuesPresent: false, hostnamesPresent: false,
    addressesPresent: false, portsPresent: false, credentialValuesPresent: false, deployableConfigurationPresent: false,
    grantsApproval: false, grantsDeploymentAuthority: false, grantsExecutionAuthority: false, createdAt: input.createdAt };
  return parseOperationsProductionTopologyV1({ ...material, topologyDigest: sha256Digest(material) });
}

export function parseOperationsProductionTopologyV1(value: unknown): OperationsProductionTopologyV1 {
  const parsed = parseExactOperationsV1(topologySchema, value, "operations production topology");
  if (parsed.services.map((service) => service.role).join("|") !== OPERATIONS_SERVICE_ROLES_V1.join("|")
    || parsed.services.map((service) => service.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || new Set(parsed.services.map((service) => service.principalIdentityDigest)).size !== parsed.services.length
    || parsed.services.filter((service) => service.schemaMutationAllowed).map((service) => service.role).join("|") !== "migration_runner"
    || parsed.services.some((service) => {
      const expected = roleDetails[service.role];
      return service.lifecycle !== expected.lifecycle || service.trustZone !== expected.trustZone
        || service.schemaMutationAllowed !== expected.schemaMutationAllowed
        || service.productionDataMutationAllowed !== expected.productionDataMutationAllowed
        || service.resolvesDeclaredCredentialReferences !== expected.resolvesDeclaredCredentialReferences
        || service.principalIdentityDigest !== sha256Digest({ deploymentId: parsed.deploymentId, role: service.role, principal: "distinct" });
    })
    || parsed.networkFlows.map((flow) => flow.flowDigest).join("|") !== standardFlows().map((flow) => flow.flowDigest).join("|")) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  for (const service of parsed.services) verifyOperationsDigestV1(service as unknown as Record<string, unknown>, "serviceDigest", service.serviceDigest);
  for (const flow of parsed.networkFlows) verifyOperationsDigestV1(flow as unknown as Record<string, unknown>, "flowDigest", flow.flowDigest);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "topologyDigest", parsed.topologyDigest);
  return parsed;
}

export function buildOperationsSyntheticTopologyFixtureV1(): OperationsProductionTopologyV1 {
  const roles = OPERATIONS_SERVICE_ROLES_V1;
  return buildOperationsProductionTopologyV1({ topologyId: "topology:operations:production-candidate:1",
    deploymentId: "deployment:operations:production-candidate", serviceArtifactDigests: roles.map((role) => sha256Digest({ role, artifact: "candidate" })),
    configurationSchemaDigest: sha256Digest({ configuration: "operations-production-v1" }),
    credentialReferenceDigests: {
      edge: [sha256Digest({ reference: "edge-identity" })],
      application: [sha256Digest({ reference: "application-database-role" }), sha256Digest({ reference: "application-object-role" })],
      migration: [sha256Digest({ reference: "migration-database-role" })],
      postgres: [sha256Digest({ reference: "database-server-identity" })],
      backup: [sha256Digest({ reference: "backup-database-role" }), sha256Digest({ reference: "backup-object-role" }),
        sha256Digest({ reference: "backup-encryption-key-custody" })],
      auditAnchor: [sha256Digest({ reference: "audit-database-role" }), sha256Digest({ reference: "audit-object-role" })],
      observer: [sha256Digest({ reference: "read-only-health-observer" })],
    }, createdAt: "2026-08-29T23:55:00.000Z" });
}

export const operationsTopologySchemasV1 = { service: serviceSchema, flow: flowSchema, topology: topologySchema } as const;
