import { z } from "zod";
import { projectWorkspaceDigestSchemaV1 as digest } from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1, parseOperationsReleaseCandidateV1 } from "./deployment";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { OPERATIONS_SERVICE_IDS_V1, OPERATIONS_SERVICE_ROLES_V1, parseOperationsProductionTopologyV1,
  type OperationsProductionTopologyV1, type OperationsServiceIdV1, type OperationsServiceRoleV1 } from "./topology";

export const OPERATIONS_COMPOSE_REFERENCE_V1 = "control-room-operations-compose-reference/v1" as const;
export const OPERATIONS_COMPOSE_KEYS_V1 = [
  "edge", "application", "migration", "postgres", "backup", "audit_anchor", "observer",
] as const;
export type OperationsComposeKeyV1 = (typeof OPERATIONS_COMPOSE_KEYS_V1)[number];

export const OPERATIONS_COMPOSE_NETWORKS_V1 = [
  "flow_edge_application", "flow_application_postgres", "flow_migration_postgres", "flow_backup_postgres",
  "flow_audit_postgres", "flow_observer_edge", "flow_observer_application", "flow_observer_migration",
  "flow_observer_postgres", "flow_observer_backup",
] as const;
type OperationsComposeNetworkV1 = (typeof OPERATIONS_COMPOSE_NETWORKS_V1)[number];

export interface OperationsComposeServiceReferenceV1 {
  composeKey: OperationsComposeKeyV1;
  serviceId: OperationsServiceIdV1;
  role: OperationsServiceRoleV1;
  artifactIdentityDigest: string;
  configurationSchemaDigest: string;
  principalIdentityDigest: string;
  credentialReferenceDigests: string[];
  imageReferencePlaceholder: string;
  userReferencePlaceholder: string;
  networks: OperationsComposeNetworkV1[];
  dependsOn: OperationsComposeKeyV1[];
  lifecycle: "steady_state" | "one_shot_owner_window";
  readOnlyRootFilesystem: true;
  capabilityDrop: ["ALL"];
  noNewPrivileges: true;
  privileged: false;
  hostNetwork: false;
  hostPid: false;
  hostIpc: false;
  dockerSocketMounted: false;
  publishedPorts: false;
  commandPresent: false;
  entrypointPresent: false;
  boundedRestart: "on_failure_max_3" | "never";
  writableVolumeClasses: [] | ["postgres_state"];
  memoryLimitMib: number;
  cpuLimitMillis: number;
  healthContractDigest: string;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  serviceReferenceDigest: string;
}

export interface OperationsComposeNetworkReferenceV1 {
  networkId: OperationsComposeNetworkV1;
  internal: true;
  exactPeerPair: [OperationsComposeKeyV1, OperationsComposeKeyV1];
  grantsNetworkAuthority: false;
  networkReferenceDigest: string;
}

export interface OperationsComposeReferenceV1 {
  contractVersion: typeof OPERATIONS_COMPOSE_REFERENCE_V1;
  topologyDigest: string;
  releaseDigest: string;
  composeSpecification: "3.9-reference-only";
  services: OperationsComposeServiceReferenceV1[];
  networks: OperationsComposeNetworkReferenceV1[];
  declaredExternalFlowDigests: string[];
  renderedYaml: string;
  productionValuesPresent: false;
  deployable: false;
  runtimeInvoked: false;
  providerContacted: false;
  hostInspected: false;
  grantsDeploymentAuthority: false;
  grantsExecutionAuthority: false;
  composeReferenceDigest: string;
}

const composeKey = z.enum(OPERATIONS_COMPOSE_KEYS_V1), networkId = z.enum(OPERATIONS_COMPOSE_NETWORKS_V1);
const placeholder = z.string().regex(/^\{\{[A-Z0-9_]+\}\}$/);
const serviceSchema = z.object({ composeKey, serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1),
  role: z.enum(OPERATIONS_SERVICE_ROLES_V1), artifactIdentityDigest: digest, configurationSchemaDigest: digest,
  principalIdentityDigest: digest, credentialReferenceDigests: z.array(digest).max(4), imageReferencePlaceholder: placeholder,
  userReferencePlaceholder: placeholder, networks: z.array(networkId).min(1).max(6), dependsOn: z.array(composeKey).max(2),
  lifecycle: z.enum(["steady_state", "one_shot_owner_window"]), readOnlyRootFilesystem: z.literal(true),
  capabilityDrop: z.tuple([z.literal("ALL")]), noNewPrivileges: z.literal(true), privileged: z.literal(false),
  hostNetwork: z.literal(false), hostPid: z.literal(false), hostIpc: z.literal(false), dockerSocketMounted: z.literal(false),
  publishedPorts: z.literal(false), commandPresent: z.literal(false), entrypointPresent: z.literal(false),
  boundedRestart: z.enum(["on_failure_max_3", "never"]),
  writableVolumeClasses: z.union([z.tuple([]), z.tuple([z.literal("postgres_state")])]),
  memoryLimitMib: z.number().int().min(128).max(4096), cpuLimitMillis: z.number().int().min(100).max(4000),
  healthContractDigest: digest, grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false),
  serviceReferenceDigest: digest }).strict();
const networkSchema = z.object({ networkId, internal: z.literal(true), exactPeerPair: z.tuple([composeKey, composeKey]),
  grantsNetworkAuthority: z.literal(false), networkReferenceDigest: digest }).strict();
const inputSchema = z.object({ topology: z.unknown(), release: z.unknown(), healthContractDigest: digest }).strict();
const referenceSchema = z.object({ contractVersion: z.literal(OPERATIONS_COMPOSE_REFERENCE_V1), topologyDigest: digest,
  releaseDigest: digest, composeSpecification: z.literal("3.9-reference-only"), services: z.array(serviceSchema).length(7),
  networks: z.array(networkSchema).length(10), declaredExternalFlowDigests: z.array(digest).length(5),
  renderedYaml: z.string().min(1).max(80_000), productionValuesPresent: z.literal(false), deployable: z.literal(false),
  runtimeInvoked: z.literal(false), providerContacted: z.literal(false), hostInspected: z.literal(false),
  grantsDeploymentAuthority: z.literal(false), grantsExecutionAuthority: z.literal(false), composeReferenceDigest: digest }).strict();

const networkPairs: ReadonlyArray<readonly [OperationsComposeNetworkV1, OperationsComposeKeyV1, OperationsComposeKeyV1]> = [
  ["flow_edge_application", "edge", "application"],
  ["flow_application_postgres", "application", "postgres"],
  ["flow_migration_postgres", "migration", "postgres"],
  ["flow_backup_postgres", "backup", "postgres"],
  ["flow_audit_postgres", "audit_anchor", "postgres"],
  ["flow_observer_edge", "observer", "edge"],
  ["flow_observer_application", "observer", "application"],
  ["flow_observer_migration", "observer", "migration"],
  ["flow_observer_postgres", "observer", "postgres"],
  ["flow_observer_backup", "observer", "backup"],
];

const dependencies: Record<OperationsComposeKeyV1, OperationsComposeKeyV1[]> = {
  edge: ["application"], application: ["postgres"], migration: ["postgres"], postgres: [], backup: ["postgres"],
  audit_anchor: ["postgres"], observer: [],
};
const limits: Record<OperationsServiceRoleV1, readonly [number, number]> = {
  edge_connector: [256, 500], control_room_application: [1024, 2000], migration_runner: [1024, 2000],
  postgres_primary: [2048, 2000], backup_controller: [512, 1000], audit_anchor: [256, 500], operations_observer: [256, 500],
};

function makeNetworks(): OperationsComposeNetworkReferenceV1[] {
  return networkPairs.map(([currentNetworkId, source, destination]) => {
    const material: Omit<OperationsComposeNetworkReferenceV1, "networkReferenceDigest"> = {
      networkId: currentNetworkId, internal: true, exactPeerPair: [source, destination], grantsNetworkAuthority: false,
    };
    return { ...material, networkReferenceDigest: sha256Digest(material) };
  });
}

function expectedNetworks(key: OperationsComposeKeyV1): OperationsComposeNetworkV1[] {
  return networkPairs.filter(([, source, destination]) => source === key || destination === key).map(([value]) => value);
}

function renderComposeYaml(reference: Pick<OperationsComposeReferenceV1, "services" | "networks" | "declaredExternalFlowDigests">): string {
  const lines = ["version: '3.9'", "x-control-room-reference-only: true", "x-control-room-deployable: false", "services:"];
  for (const service of reference.services) {
    lines.push(`  ${service.composeKey}:`, `    image: '${service.imageReferencePlaceholder}'`,
      `    user: '${service.userReferencePlaceholder}'`, "    read_only: true", "    cap_drop: ['ALL']",
      "    security_opt: ['no-new-privileges:true']", `    restart: '${service.boundedRestart === "never" ? "no" : "on-failure:3"}'`,
      `    x-control-room-service-id: '${service.serviceId}'`,
      `    x-control-room-artifact-identity-digest: '${service.artifactIdentityDigest}'`,
      `    x-control-room-principal-identity-digest: '${service.principalIdentityDigest}'`,
      `    x-control-room-health-contract-digest: '${service.healthContractDigest}'`, "    networks:",
      ...service.networks.map((value) => `      - ${value}`));
    if (service.dependsOn.length > 0) lines.push("    depends_on:", ...service.dependsOn.map((value) => `      - ${value}`));
    lines.push("    deploy:", "      resources:", "        limits:", `          cpus: '${(service.cpuLimitMillis / 1000).toFixed(3)}'`,
      `          memory: '${service.memoryLimitMib}M'`);
    if (service.writableVolumeClasses.length > 0) lines.push("    x-control-room-writable-volume-classes: ['postgres_state']");
  }
  lines.push("networks:");
  for (const network of reference.networks) lines.push(`  ${network.networkId}:`, "    internal: true",
    `    x-control-room-exact-peer-pair: '${network.exactPeerPair.join("->")}'`);
  lines.push("x-control-room-declared-external-flow-digests:",
    ...reference.declaredExternalFlowDigests.map((value) => `  - '${value}'`), "");
  return lines.join("\n");
}

function makeServices(topology: OperationsProductionTopologyV1, healthContractDigest: string): OperationsComposeServiceReferenceV1[] {
  return topology.services.map((service, position) => {
    const composeKeyValue = OPERATIONS_COMPOSE_KEYS_V1[position]!, [memoryLimitMib, cpuLimitMillis] = limits[service.role];
    const material: Omit<OperationsComposeServiceReferenceV1, "serviceReferenceDigest"> = {
      composeKey: composeKeyValue, serviceId: service.serviceId, role: service.role,
      artifactIdentityDigest: service.artifactIdentityDigest, configurationSchemaDigest: service.configurationSchemaDigest,
      principalIdentityDigest: service.principalIdentityDigest, credentialReferenceDigests: service.credentialReferenceDigests,
      imageReferencePlaceholder: `{{${composeKeyValue.toUpperCase()}_IMMUTABLE_IMAGE_REFERENCE}}`,
      userReferencePlaceholder: `{{${composeKeyValue.toUpperCase()}_DISTINCT_USER_REFERENCE}}`,
      networks: expectedNetworks(composeKeyValue), dependsOn: dependencies[composeKeyValue], lifecycle: service.lifecycle,
      readOnlyRootFilesystem: true, capabilityDrop: ["ALL"], noNewPrivileges: true, privileged: false, hostNetwork: false,
      hostPid: false, hostIpc: false, dockerSocketMounted: false, publishedPorts: false, commandPresent: false,
      entrypointPresent: false, boundedRestart: service.role === "migration_runner" ? "never" : "on_failure_max_3",
      writableVolumeClasses: service.role === "postgres_primary" ? ["postgres_state"] : [], memoryLimitMib, cpuLimitMillis,
      healthContractDigest, grantsDeploymentAuthority: false, grantsExecutionAuthority: false,
    };
    return { ...material, serviceReferenceDigest: sha256Digest(material) };
  });
}

export function buildOperationsComposeReferenceV1(inputValue: unknown): OperationsComposeReferenceV1 {
  const input = parseExactOperationsV1(inputSchema, inputValue, "operations compose reference input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release);
  if (input.healthContractDigest !== OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1
    || release.applicationArtifactDigest !== topology.services[1]!.artifactIdentityDigest
    || release.migrationBundleDigest !== topology.services[2]!.artifactIdentityDigest
    || release.publicAssetsDigest !== topology.services[0]!.artifactIdentityDigest
    || release.configurationSchemaDigest !== topology.services[0]!.configurationSchemaDigest) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  const services = makeServices(topology, input.healthContractDigest), networks = makeNetworks();
  const externalFlows = topology.networkFlows.filter((flow) => flow.direction !== "host_local").map((flow) => flow.flowDigest);
  const partial = { services, networks, declaredExternalFlowDigests: externalFlows };
  const material: Omit<OperationsComposeReferenceV1, "composeReferenceDigest"> = {
    contractVersion: OPERATIONS_COMPOSE_REFERENCE_V1, topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest,
    composeSpecification: "3.9-reference-only", ...partial, renderedYaml: renderComposeYaml(partial), productionValuesPresent: false,
    deployable: false, runtimeInvoked: false, providerContacted: false, hostInspected: false,
    grantsDeploymentAuthority: false, grantsExecutionAuthority: false,
  };
  return parseOperationsComposeReferenceV1({ ...material, composeReferenceDigest: sha256Digest(material) });
}

export function parseOperationsComposeReferenceV1(value: unknown): OperationsComposeReferenceV1 {
  const parsed = parseExactOperationsV1(referenceSchema, value, "operations compose reference"), networks = makeNetworks();
  if (parsed.services.map((service) => service.composeKey).join("|") !== OPERATIONS_COMPOSE_KEYS_V1.join("|")
    || parsed.services.map((service) => service.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || parsed.services.map((service) => service.role).join("|") !== OPERATIONS_SERVICE_ROLES_V1.join("|")
    || new Set(parsed.services.map((service) => service.principalIdentityDigest)).size !== parsed.services.length
    || new Set(parsed.services.map((service) => service.artifactIdentityDigest)).size !== parsed.services.length
    || new Set(parsed.declaredExternalFlowDigests).size !== parsed.declaredExternalFlowDigests.length
    || parsed.networks.map((network) => network.networkReferenceDigest).join("|") !== networks.map((network) => network.networkReferenceDigest).join("|")
    || parsed.services.some((service) => {
      const [memoryLimitMib, cpuLimitMillis] = limits[service.role], keyToken = service.composeKey.toUpperCase();
      return service.networks.join("|") !== expectedNetworks(service.composeKey).join("|")
        || service.dependsOn.join("|") !== dependencies[service.composeKey].join("|")
        || service.imageReferencePlaceholder !== `{{${keyToken}_IMMUTABLE_IMAGE_REFERENCE}}`
        || service.userReferencePlaceholder !== `{{${keyToken}_DISTINCT_USER_REFERENCE}}`
        || service.lifecycle !== (service.role === "migration_runner" ? "one_shot_owner_window" : "steady_state")
        || service.boundedRestart !== (service.role === "migration_runner" ? "never" : "on_failure_max_3")
        || (service.writableVolumeClasses.length === 1) !== (service.role === "postgres_primary")
        || service.memoryLimitMib !== memoryLimitMib || service.cpuLimitMillis !== cpuLimitMillis
        || service.healthContractDigest !== OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1;
    })
    || parsed.renderedYaml !== renderComposeYaml(parsed)
    || /(?:ports:|privileged:\s*true|network_mode:|pid:|ipc:|docker\.sock|command:|entrypoint:|0\.0\.0\.0|\/var\/run)/i.test(parsed.renderedYaml)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  for (const service of parsed.services) verifyOperationsDigestV1(service as unknown as Record<string, unknown>,
    "serviceReferenceDigest", service.serviceReferenceDigest);
  for (const network of parsed.networks) verifyOperationsDigestV1(network as unknown as Record<string, unknown>,
    "networkReferenceDigest", network.networkReferenceDigest);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "composeReferenceDigest", parsed.composeReferenceDigest);
  return parsed;
}
