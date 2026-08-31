import { z } from "zod";
import { projectWorkspaceDigestSchemaV1 as digest, projectWorkspaceSafeIdSchemaV1 as id,
  projectWorkspaceTimeSchemaV1 as time } from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { parseOperationsReleaseCandidateV1 } from "./deployment";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { parseOperationsProductionTopologyV1 } from "./topology";

export const OPERATIONS_PROTECTED_EDGE_REFERENCE_V1 = "control-room-operations-protected-edge-reference/v1" as const;
export const OPERATIONS_EDGE_ROUTE_IDS_V1 = ["route:operations:owner-ui", "route:operations:node-protocol"] as const;
type OperationsEdgeRouteIdV1 = (typeof OPERATIONS_EDGE_ROUTE_IDS_V1)[number];

export interface OperationsEdgeRouteReferenceV1 {
  routeId: OperationsEdgeRouteIdV1;
  trafficClass: "owner_ingress" | "node_protocol";
  sourceClass: "owner_browser" | "node_bridge";
  destinationServiceId: "service:operations:edge";
  topologyFlowDigest: string;
  connectorDirection: "outbound_only";
  originExposure: "none";
  authentication: "phishing_resistant_owner_identity" | "node_asymmetric_application_identity";
  audienceDigest: string;
  maximumAssertionAgeSeconds: number;
  replayWindowSeconds: number;
  ownerStrongFactorRequired: boolean;
  exactNodeAttestationRequired: boolean;
  exactAudienceRequired: true;
  wildcardRouteAllowed: false;
  redirectAllowed: false;
  bypassAllowed: false;
  publicOriginAllowed: false;
  inboundNodeListenerAllowed: false;
  routeOrHostnamePresent: false;
  accessDecisionCandidateOnly: true;
  grantsNetworkAuthority: false;
  grantsApproval: false;
  routeReferenceDigest: string;
}

export interface OperationsProtectedEdgeReferenceV1 {
  contractVersion: typeof OPERATIONS_PROTECTED_EDGE_REFERENCE_V1;
  topologyDigest: string;
  releaseDigest: string;
  edgeServiceDigest: string;
  edgePrincipalDigest: string;
  internalForwardFlowDigest: string;
  routes: OperationsEdgeRouteReferenceV1[];
  providerExampleKind: "cloudflare_tunnel_access_value_free_example";
  providerTemplate: string;
  accountIdentityPresent: false;
  zoneIdentityPresent: false;
  domainPresent: false;
  hostnamePresent: false;
  tunnelIdentityPresent: false;
  credentialValuesPresent: false;
  providerSdkPresent: false;
  networkClientPresent: false;
  dnsMutationAllowed: false;
  publicExposureAllowed: false;
  providerContacted: false;
  productionValuesPresent: false;
  deployable: false;
  grantsNetworkAuthority: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  edgeReferenceDigest: string;
}

export const OPERATIONS_EDGE_BLOCKER_CODES_V1 = [
  "provider_account_unbound", "zone_and_hostname_unbound", "tunnel_identity_unbound", "owner_access_policy_unbound",
  "credential_custody_unbound", "network_validation_missing", "fresh_owner_window_missing",
] as const;
type OperationsEdgeBlockerCodeV1 = (typeof OPERATIONS_EDGE_BLOCKER_CODES_V1)[number];

export interface OperationsProtectedEdgeDispositionV1 {
  contractVersion: typeof OPERATIONS_PROTECTED_EDGE_REFERENCE_V1;
  dispositionId: string;
  edgeReferenceDigest: string;
  state: "disabled_before_provider_contact";
  blockerCodes: OperationsEdgeBlockerCodeV1[];
  providerAttempts: 0;
  dnsMutations: 0;
  tunnelMutations: 0;
  accessPolicyMutations: 0;
  publicExposures: 0;
  credentialResolutions: 0;
  automaticRetryAllowed: false;
  ownerActionRequired: true;
  grantsNetworkAuthority: false;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  recordedAt: string;
  dispositionDigest: string;
}

export interface OperationsFakeEdgeAssessmentV1 {
  contractVersion: typeof OPERATIONS_PROTECTED_EDGE_REFERENCE_V1;
  assessmentId: string;
  edgeReferenceDigest: string;
  adapterKind: "in_memory_fake_no_network";
  mode: "disabled" | "synthetic_policy_match";
  routeResults: Array<{ routeId: OperationsEdgeRouteIdV1; state: "blocked" | "synthetic_match";
    safeStatusCode: string; evidenceDigest: string; resultDigest: string }>;
  state: "disabled" | "candidate_for_owner_review";
  providerContacted: false;
  networkAttempted: false;
  dnsMutationAttempted: false;
  credentialResolutionAttempted: false;
  grantsNetworkAuthority: false;
  grantsApproval: false;
  assessedAt: string;
  assessmentDigest: string;
}

const routeId = z.enum(OPERATIONS_EDGE_ROUTE_IDS_V1);
const routeSchema = z.object({ routeId, trafficClass: z.enum(["owner_ingress", "node_protocol"]),
  sourceClass: z.enum(["owner_browser", "node_bridge"]), destinationServiceId: z.literal("service:operations:edge"),
  topologyFlowDigest: digest, connectorDirection: z.literal("outbound_only"), originExposure: z.literal("none"),
  authentication: z.enum(["phishing_resistant_owner_identity", "node_asymmetric_application_identity"]), audienceDigest: digest,
  maximumAssertionAgeSeconds: z.number().int().min(30).max(900), replayWindowSeconds: z.number().int().min(0).max(60),
  ownerStrongFactorRequired: z.boolean(), exactNodeAttestationRequired: z.boolean(), exactAudienceRequired: z.literal(true),
  wildcardRouteAllowed: z.literal(false), redirectAllowed: z.literal(false), bypassAllowed: z.literal(false),
  publicOriginAllowed: z.literal(false), inboundNodeListenerAllowed: z.literal(false), routeOrHostnamePresent: z.literal(false),
  accessDecisionCandidateOnly: z.literal(true), grantsNetworkAuthority: z.literal(false), grantsApproval: z.literal(false),
  routeReferenceDigest: digest }).strict();
const inputSchema = z.object({ topology: z.unknown(), release: z.unknown() }).strict();
const referenceSchema = z.object({ contractVersion: z.literal(OPERATIONS_PROTECTED_EDGE_REFERENCE_V1), topologyDigest: digest,
  releaseDigest: digest, edgeServiceDigest: digest, edgePrincipalDigest: digest, internalForwardFlowDigest: digest,
  routes: z.array(routeSchema).length(2), providerExampleKind: z.literal("cloudflare_tunnel_access_value_free_example"),
  providerTemplate: z.string().min(1).max(30_000), accountIdentityPresent: z.literal(false), zoneIdentityPresent: z.literal(false),
  domainPresent: z.literal(false), hostnamePresent: z.literal(false), tunnelIdentityPresent: z.literal(false),
  credentialValuesPresent: z.literal(false), providerSdkPresent: z.literal(false), networkClientPresent: z.literal(false),
  dnsMutationAllowed: z.literal(false), publicExposureAllowed: z.literal(false), providerContacted: z.literal(false),
  productionValuesPresent: z.literal(false), deployable: z.literal(false), grantsNetworkAuthority: z.literal(false),
  grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false), edgeReferenceDigest: digest }).strict();
const dispositionInputSchema = z.object({ dispositionId: id, edgeReference: z.unknown(), recordedAt: time }).strict();
const dispositionSchema = z.object({ contractVersion: z.literal(OPERATIONS_PROTECTED_EDGE_REFERENCE_V1), dispositionId: id,
  edgeReferenceDigest: digest, state: z.literal("disabled_before_provider_contact"),
  blockerCodes: z.array(z.enum(OPERATIONS_EDGE_BLOCKER_CODES_V1)).length(7), providerAttempts: z.literal(0),
  dnsMutations: z.literal(0), tunnelMutations: z.literal(0), accessPolicyMutations: z.literal(0), publicExposures: z.literal(0),
  credentialResolutions: z.literal(0), automaticRetryAllowed: z.literal(false), ownerActionRequired: z.literal(true),
  grantsNetworkAuthority: z.literal(false), grantsApproval: z.literal(false), grantsExecutionAuthority: z.literal(false),
  recordedAt: time, dispositionDigest: digest }).strict();
const assessmentInputSchema = z.object({ assessmentId: id, edgeReference: z.unknown(),
  mode: z.enum(["disabled", "synthetic_policy_match"]), assessedAt: time }).strict();
const resultSchema = z.object({ routeId, state: z.enum(["blocked", "synthetic_match"]), safeStatusCode: id,
  evidenceDigest: digest, resultDigest: digest }).strict();
const assessmentSchema = z.object({ contractVersion: z.literal(OPERATIONS_PROTECTED_EDGE_REFERENCE_V1), assessmentId: id,
  edgeReferenceDigest: digest, adapterKind: z.literal("in_memory_fake_no_network"),
  mode: z.enum(["disabled", "synthetic_policy_match"]), routeResults: z.array(resultSchema).length(2),
  state: z.enum(["disabled", "candidate_for_owner_review"]), providerContacted: z.literal(false),
  networkAttempted: z.literal(false), dnsMutationAttempted: z.literal(false), credentialResolutionAttempted: z.literal(false),
  grantsNetworkAuthority: z.literal(false), grantsApproval: z.literal(false), assessedAt: time, assessmentDigest: digest }).strict();

function makeRoutes(topology: ReturnType<typeof parseOperationsProductionTopologyV1>): OperationsEdgeRouteReferenceV1[] {
  return OPERATIONS_EDGE_ROUTE_IDS_V1.map((currentRouteId, position) => {
    const owner = position === 0, material: Omit<OperationsEdgeRouteReferenceV1, "routeReferenceDigest"> = {
      routeId: currentRouteId, trafficClass: owner ? "owner_ingress" : "node_protocol",
      sourceClass: owner ? "owner_browser" : "node_bridge", destinationServiceId: "service:operations:edge",
      topologyFlowDigest: topology.networkFlows[position]!.flowDigest, connectorDirection: "outbound_only", originExposure: "none",
      authentication: owner ? "phishing_resistant_owner_identity" : "node_asymmetric_application_identity",
      audienceDigest: sha256Digest({ topologyDigest: topology.topologyDigest, routeId: currentRouteId, audience: "exact" }),
      maximumAssertionAgeSeconds: owner ? 900 : 60, replayWindowSeconds: owner ? 0 : 60,
      ownerStrongFactorRequired: owner, exactNodeAttestationRequired: !owner, exactAudienceRequired: true,
      wildcardRouteAllowed: false, redirectAllowed: false, bypassAllowed: false, publicOriginAllowed: false,
      inboundNodeListenerAllowed: false, routeOrHostnamePresent: false, accessDecisionCandidateOnly: true,
      grantsNetworkAuthority: false, grantsApproval: false,
    };
    return { ...material, routeReferenceDigest: sha256Digest(material) };
  });
}

function renderProviderTemplate(reference: Pick<OperationsProtectedEdgeReferenceV1, "edgeServiceDigest" | "routes" | "internalForwardFlowDigest">): string {
  return JSON.stringify({ schema: "control-room.protected-edge-value-free-example/v1", providerShape: "cloudflare_tunnel_access",
    enabled: false, providerContactAllowed: false, accountIdentityReference: "{{PROVIDER_ACCOUNT_IDENTITY_REFERENCE}}",
    zoneIdentityReference: "{{PROVIDER_ZONE_IDENTITY_REFERENCE}}", hostnameReference: "{{PROTECTED_HOSTNAME_REFERENCE}}",
    tunnelIdentityReference: "{{OUTBOUND_TUNNEL_IDENTITY_REFERENCE}}", edgeServiceDigest: reference.edgeServiceDigest,
    internalForwardFlowDigest: reference.internalForwardFlowDigest, routes: reference.routes.map((route) => ({ routeId: route.routeId,
      audienceDigest: route.audienceDigest, authentication: route.authentication, originExposure: route.originExposure,
      publicOriginAllowed: route.publicOriginAllowed, wildcardRouteAllowed: route.wildcardRouteAllowed,
      redirectAllowed: route.redirectAllowed })) }, null, 2);
}

export function buildOperationsProtectedEdgeReferenceV1(inputValue: unknown): OperationsProtectedEdgeReferenceV1 {
  const input = parseExactOperationsV1(inputSchema, inputValue, "operations protected edge input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release),
    edge = topology.services[0]!, routes = makeRoutes(topology);
  if (release.publicAssetsDigest !== edge.artifactIdentityDigest) throw new OperationsContractErrorV1("scope_mismatch");
  const partial = { edgeServiceDigest: edge.serviceDigest, routes, internalForwardFlowDigest: topology.networkFlows[2]!.flowDigest };
  const material: Omit<OperationsProtectedEdgeReferenceV1, "edgeReferenceDigest"> = {
    contractVersion: OPERATIONS_PROTECTED_EDGE_REFERENCE_V1, topologyDigest: topology.topologyDigest,
    releaseDigest: release.releaseDigest, edgePrincipalDigest: edge.principalIdentityDigest, ...partial,
    providerExampleKind: "cloudflare_tunnel_access_value_free_example", providerTemplate: renderProviderTemplate(partial),
    accountIdentityPresent: false, zoneIdentityPresent: false, domainPresent: false, hostnamePresent: false,
    tunnelIdentityPresent: false, credentialValuesPresent: false, providerSdkPresent: false, networkClientPresent: false,
    dnsMutationAllowed: false, publicExposureAllowed: false, providerContacted: false, productionValuesPresent: false,
    deployable: false, grantsNetworkAuthority: false, grantsApproval: false, grantsExecutionAuthority: false,
  };
  return parseOperationsProtectedEdgeReferenceV1({ ...material, edgeReferenceDigest: sha256Digest(material) });
}

export function parseOperationsProtectedEdgeReferenceV1(value: unknown): OperationsProtectedEdgeReferenceV1 {
  const parsed = parseExactOperationsV1(referenceSchema, value, "operations protected edge reference");
  if (parsed.routes.map((route) => route.routeId).join("|") !== OPERATIONS_EDGE_ROUTE_IDS_V1.join("|")
    || new Set(parsed.routes.map((route) => route.topologyFlowDigest)).size !== parsed.routes.length
    || parsed.routes.some((route, position) => {
      const owner = position === 0;
      return route.trafficClass !== (owner ? "owner_ingress" : "node_protocol")
        || route.sourceClass !== (owner ? "owner_browser" : "node_bridge")
        || route.authentication !== (owner ? "phishing_resistant_owner_identity" : "node_asymmetric_application_identity")
        || route.audienceDigest !== sha256Digest({ topologyDigest: parsed.topologyDigest, routeId: route.routeId, audience: "exact" })
        || route.maximumAssertionAgeSeconds !== (owner ? 900 : 60) || route.replayWindowSeconds !== (owner ? 0 : 60)
        || route.ownerStrongFactorRequired !== owner || route.exactNodeAttestationRequired !== !owner;
    })
    || parsed.providerTemplate !== renderProviderTemplate(parsed)
    || /(?:https?:\/\/|\*\.|0\.0\.0\.0|X-Amz-|Bearer\s|BEGIN PRIVATE KEY|"enabled":\s*true)/i.test(parsed.providerTemplate)) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  for (const route of parsed.routes) verifyOperationsDigestV1(route as unknown as Record<string, unknown>,
    "routeReferenceDigest", route.routeReferenceDigest);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "edgeReferenceDigest", parsed.edgeReferenceDigest);
  return parsed;
}

export function buildOperationsProtectedEdgeDisabledDispositionV1(inputValue: unknown): OperationsProtectedEdgeDispositionV1 {
  const input = parseExactOperationsV1(dispositionInputSchema, inputValue, "operations protected edge disposition input"),
    reference = parseOperationsProtectedEdgeReferenceV1(input.edgeReference);
  const material: Omit<OperationsProtectedEdgeDispositionV1, "dispositionDigest"> = {
    contractVersion: OPERATIONS_PROTECTED_EDGE_REFERENCE_V1, dispositionId: input.dispositionId,
    edgeReferenceDigest: reference.edgeReferenceDigest, state: "disabled_before_provider_contact",
    blockerCodes: [...OPERATIONS_EDGE_BLOCKER_CODES_V1], providerAttempts: 0, dnsMutations: 0, tunnelMutations: 0,
    accessPolicyMutations: 0, publicExposures: 0, credentialResolutions: 0, automaticRetryAllowed: false,
    ownerActionRequired: true, grantsNetworkAuthority: false, grantsApproval: false, grantsExecutionAuthority: false,
    recordedAt: input.recordedAt,
  };
  return parseOperationsProtectedEdgeDispositionV1({ ...material, dispositionDigest: sha256Digest(material) });
}

export function parseOperationsProtectedEdgeDispositionV1(value: unknown): OperationsProtectedEdgeDispositionV1 {
  const parsed = parseExactOperationsV1(dispositionSchema, value, "operations protected edge disposition");
  if (parsed.blockerCodes.join("|") !== OPERATIONS_EDGE_BLOCKER_CODES_V1.join("|")) throw new OperationsContractErrorV1("scope_mismatch");
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "dispositionDigest", parsed.dispositionDigest);
  return parsed;
}

export function assessOperationsProtectedEdgeWithFakeV1(inputValue: unknown): OperationsFakeEdgeAssessmentV1 {
  const input = parseExactOperationsV1(assessmentInputSchema, inputValue, "operations fake edge assessment input"),
    reference = parseOperationsProtectedEdgeReferenceV1(input.edgeReference);
  const routeResults = reference.routes.map((route) => {
    const material = { routeId: route.routeId, state: input.mode === "disabled" ? "blocked" as const : "synthetic_match" as const,
      safeStatusCode: input.mode === "disabled" ? "provider_disabled" : "fake_policy_shape_matches",
      evidenceDigest: sha256Digest({ edgeReferenceDigest: reference.edgeReferenceDigest, routeId: route.routeId,
        mode: input.mode, evidence: "synthetic-no-provider" }) };
    return { ...material, resultDigest: sha256Digest(material) };
  });
  const material: Omit<OperationsFakeEdgeAssessmentV1, "assessmentDigest"> = {
    contractVersion: OPERATIONS_PROTECTED_EDGE_REFERENCE_V1, assessmentId: input.assessmentId,
    edgeReferenceDigest: reference.edgeReferenceDigest, adapterKind: "in_memory_fake_no_network", mode: input.mode,
    routeResults, state: input.mode === "disabled" ? "disabled" : "candidate_for_owner_review", providerContacted: false,
    networkAttempted: false, dnsMutationAttempted: false, credentialResolutionAttempted: false,
    grantsNetworkAuthority: false, grantsApproval: false, assessedAt: input.assessedAt,
  };
  return parseOperationsFakeEdgeAssessmentV1({ ...material, assessmentDigest: sha256Digest(material) });
}

export function parseOperationsFakeEdgeAssessmentV1(value: unknown): OperationsFakeEdgeAssessmentV1 {
  const parsed = parseExactOperationsV1(assessmentSchema, value, "operations fake edge assessment");
  if (parsed.routeResults.map((result) => result.routeId).join("|") !== OPERATIONS_EDGE_ROUTE_IDS_V1.join("|")
    || parsed.state !== (parsed.mode === "disabled" ? "disabled" : "candidate_for_owner_review")
    || parsed.routeResults.some((result) => result.state !== (parsed.mode === "disabled" ? "blocked" : "synthetic_match")
      || result.safeStatusCode !== (parsed.mode === "disabled" ? "provider_disabled" : "fake_policy_shape_matches")
      || result.evidenceDigest !== sha256Digest({ edgeReferenceDigest: parsed.edgeReferenceDigest, routeId: result.routeId,
        mode: parsed.mode, evidence: "synthetic-no-provider" }))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  for (const result of parsed.routeResults) verifyOperationsDigestV1(result as unknown as Record<string, unknown>, "resultDigest", result.resultDigest);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "assessmentDigest", parsed.assessmentDigest);
  return parsed;
}
