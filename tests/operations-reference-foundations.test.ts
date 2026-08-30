import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessOperationsProtectedEdgeWithFakeV1,
  buildOperationsComposeReferenceV1,
  buildOperationsProtectedEdgeDisabledDispositionV1,
  buildOperationsProtectedEdgeReferenceV1,
  buildOperationsResourcePolicyV1,
  buildOperationsSyntheticFakeProbeAdapterInputV1,
  buildOperationsSyntheticReleaseCandidateV1,
  buildOperationsSyntheticTopologyFixtureV1,
  buildOperationsSystemdReferenceV1,
  collectOperationsHealthWithFakeV1,
  createOperationsFakeProbeAdapterV1,
  OperationsContractErrorV1,
  OPERATIONS_COMPOSE_KEYS_V1,
  OPERATIONS_COMPOSE_NETWORKS_V1,
  OPERATIONS_EDGE_BLOCKER_CODES_V1,
  OPERATIONS_EDGE_ROUTE_IDS_V1,
  OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1,
  OPERATIONS_SERVICE_IDS_V1,
  OPERATIONS_SYSTEMD_UNIT_NAMES_V1,
  parseOperationsComposeReferenceV1,
  parseOperationsFakeEdgeAssessmentV1,
  parseOperationsHealthReadinessProjectionV1,
  parseOperationsProbeCollectionV1,
  parseOperationsProtectedEdgeDispositionV1,
  parseOperationsProtectedEdgeReferenceV1,
  parseOperationsSystemdReferenceV1,
  projectOperationsHealthReadinessV1,
  type OperationsProbeCollectionV1,
} from "../src/operations/v1";
import { sha256Digest } from "../src/security";
import { observedProxy } from "./proxy-test-helper";

function clone<T>(value: T): T { return structuredClone(value); }
function resign<T extends Record<string, unknown>>(value: T, key: string): T {
  const material = { ...value }; delete material[key]; return { ...value, [key]: sha256Digest(material) };
}
function rejected(error: unknown) { return error instanceof OperationsContractErrorV1; }
function foundations() {
  const topology = buildOperationsSyntheticTopologyFixtureV1();
  return { topology, release: buildOperationsSyntheticReleaseCandidateV1(topology) };
}
function resourcePolicy(topology: ReturnType<typeof buildOperationsSyntheticTopologyFixtureV1>) {
  return buildOperationsResourcePolicyV1({ policyId: "policy:operations:resource:synthetic", topology,
    maximumMemoryUtilizationPermille: 800, maximumCpuUtilizationPermille: 850,
    maximumStorageUtilizationPermille: 800, maximumSampleAgeSeconds: 120 });
}
function collect(mode: "passing" | "application_database_failure" | "edge_resource_pressure" = "passing") {
  const { topology } = foundations(), policy = resourcePolicy(topology);
  const adapter = createOperationsFakeProbeAdapterV1(buildOperationsSyntheticFakeProbeAdapterInputV1(topology, mode));
  const collection = collectOperationsHealthWithFakeV1({ collectionId: `collection:operations:${mode}`,
    snapshotId: `snapshot:operations:${mode}`, topology, resourcePolicy: policy }, adapter);
  return { topology, policy, adapter, collection };
}

test("CR10A-OPS-010 renders seven exact non-deployable Compose service references", () => {
  const { topology, release } = foundations();
  const reference = buildOperationsComposeReferenceV1({ topology, release,
    healthContractDigest: OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 });
  assert.deepEqual(reference.services.map((service) => service.composeKey), [...OPERATIONS_COMPOSE_KEYS_V1]);
  assert.deepEqual(reference.services.map((service) => service.serviceId), [...OPERATIONS_SERVICE_IDS_V1]);
  assert.equal(reference.services.every((service) => service.readOnlyRootFilesystem && service.noNewPrivileges
    && !service.privileged && !service.hostNetwork && !service.hostPid && !service.hostIpc && !service.dockerSocketMounted
    && !service.publishedPorts && !service.commandPresent && !service.entrypointPresent), true);
  assert.equal(reference.productionValuesPresent || reference.deployable || reference.runtimeInvoked
    || reference.providerContacted || reference.hostInspected || reference.grantsDeploymentAuthority, false);
  assert.deepEqual(parseOperationsComposeReferenceV1(reference), reference);
});

test("CR10A-OPS-010 uses ten internal exact-peer networks and only declares external flows", () => {
  const { topology, release } = foundations(), reference = buildOperationsComposeReferenceV1({ topology, release,
    healthContractDigest: OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 });
  assert.deepEqual(reference.networks.map((network) => network.networkId), [...OPERATIONS_COMPOSE_NETWORKS_V1]);
  assert.equal(reference.networks.every((network) => network.internal && !network.grantsNetworkAuthority), true);
  assert.equal(reference.networks.every((network) => network.exactPeerPair.length === 2), true);
  assert.equal(reference.declaredExternalFlowDigests.length, 5);
  assert.doesNotMatch(reference.renderedYaml, /^\s*ports:/m);
  assert.doesNotMatch(reference.renderedYaml, /(?:0\.0\.0\.0|docker\.sock|network_mode:|command:|entrypoint:)/i);
});

test("CR10A-OPS-010 keeps migration one-shot and PostgreSQL the only writable-volume role", () => {
  const { topology, release } = foundations(), reference = buildOperationsComposeReferenceV1({ topology, release,
    healthContractDigest: OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 });
  assert.equal(reference.services[2]!.boundedRestart, "never");
  assert.equal(reference.services.filter((service) => service.writableVolumeClasses.length > 0).length, 1);
  assert.equal(reference.services[3]!.writableVolumeClasses[0], "postgres_state");
  assert.equal(new Set(reference.services.map((service) => service.userReferencePlaceholder)).size, 7);
});

test("CR10A-OPS-010 rejects privilege, network, order, and nested re-signing drift", () => {
  const { topology, release } = foundations(), reference = buildOperationsComposeReferenceV1({ topology, release,
    healthContractDigest: OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 });
  const privileged = clone(reference); (privileged.services[0] as unknown as { privileged: boolean }).privileged = true;
  privileged.services[0] = resign(privileged.services[0] as unknown as Record<string, unknown>, "serviceReferenceDigest") as never;
  assert.throws(() => parseOperationsComposeReferenceV1(resign(privileged as unknown as Record<string, unknown>, "composeReferenceDigest")), rejected);
  const reordered = clone(reference); reordered.networks.reverse();
  assert.throws(() => parseOperationsComposeReferenceV1(resign(reordered as unknown as Record<string, unknown>, "composeReferenceDigest")), rejected);
});

test("CR10A-OPS-010 rejects secrets, extra fields, accessors, and Proxies", () => {
  const { topology, release } = foundations();
  assert.throws(() => buildOperationsComposeReferenceV1({ topology, release,
    healthContractDigest: OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1, accessToken: "not-allowed-value" }), rejected);
  const accessor = { topology, release, get healthContractDigest() { throw new Error("must not execute"); } };
  assert.throws(() => buildOperationsComposeReferenceV1(accessor), rejected);
  const proxy = observedProxy({ topology, release, healthContractDigest: OPERATIONS_HEALTH_CONTRACT_EVIDENCE_DIGEST_V1 }, "throwing");
  assert.throws(() => buildOperationsComposeReferenceV1(proxy.value), rejected); assert.equal(proxy.trapCount(), 0);
});

test("CR10A-OPS-020 renders seven hardened, value-free Linux unit references", () => {
  const { topology, release } = foundations(), reference = buildOperationsSystemdReferenceV1({ topology, release });
  assert.deepEqual(reference.units.map((unit) => unit.unitName), [...OPERATIONS_SYSTEMD_UNIT_NAMES_V1]);
  assert.deepEqual(reference.units.map((unit) => unit.serviceId), [...OPERATIONS_SERVICE_IDS_V1]);
  assert.equal(new Set(reference.units.map((unit) => unit.userReferencePlaceholder)).size, 7);
  assert.equal(reference.units.every((unit) => unit.unitText.includes("NoNewPrivileges=true")
    && unit.unitText.includes("ProtectSystem=strict") && unit.unitText.includes("CapabilityBoundingSet=")
    && !unit.installSectionPresent && !unit.shellPresent && !unit.rootUserAllowed && !unit.executable), true);
  assert.equal(reference.hostInspected || reference.daemonReloadAttempted || reference.serviceControlAttempted
    || reference.installAttempted || reference.grantsServiceControl, false);
  assert.deepEqual(parseOperationsSystemdReferenceV1(reference), reference);
});

test("CR10A-OPS-020 keeps migration one-shot, bounded restarts, and one writable data role", () => {
  const { topology, release } = foundations(), reference = buildOperationsSystemdReferenceV1({ topology, release });
  assert.equal(reference.units[2]!.serviceType, "oneshot"); assert.equal(reference.units[2]!.restartPolicy, "never");
  assert.equal(reference.units.filter((unit) => unit.restartPolicy === "on_failure_bounded").length, 6);
  assert.deepEqual(reference.units.filter((unit) => unit.writablePathClasses.length > 0).map((unit) => unit.role), ["postgres_primary"]);
  assert.equal(reference.units[3]!.addressFamilies.join(" "), "AF_UNIX");
});

test("CR10A-OPS-020 unit text has no install activation, root, shell, ambient capability, or unbounded restart", () => {
  const { topology, release } = foundations(), reference = buildOperationsSystemdReferenceV1({ topology, release });
  const text = reference.units.map((unit) => unit.unitText).join("\n");
  assert.doesNotMatch(text, /^\[Install\]$/m);
  assert.doesNotMatch(text, /(?:User=(?:root|0)\b|\/bin\/(?:sh|bash)\b|sudo\b|Restart=always|AmbientCapabilities=\S)/i);
  assert.match(text, /ConditionPathExists=\{\{[A-Z0-9_]+_OWNER_ENABLE_MARKER_REFERENCE\}\}/);
});

test("CR10A-OPS-020 rejects altered unit text and re-signed role semantics", () => {
  const { topology, release } = foundations(), reference = buildOperationsSystemdReferenceV1({ topology, release });
  const drift = clone(reference); drift.units[0]!.unitText += "ExecStartPost=/bin/sh\n";
  drift.units[0] = resign(drift.units[0] as unknown as Record<string, unknown>, "unitReferenceDigest") as never;
  assert.throws(() => parseOperationsSystemdReferenceV1(resign(drift as unknown as Record<string, unknown>, "systemdReferenceDigest")), rejected);
  const shared = clone(reference); shared.units[1]!.userReferencePlaceholder = shared.units[0]!.userReferencePlaceholder;
  shared.units[1] = resign(shared.units[1] as unknown as Record<string, unknown>, "unitReferenceDigest") as never;
  assert.throws(() => parseOperationsSystemdReferenceV1(resign(shared as unknown as Record<string, unknown>, "systemdReferenceDigest")), rejected);
});

test("CR10A-OPS-030 freezes separate owner and node protected-edge routes", () => {
  const { topology, release } = foundations(), reference = buildOperationsProtectedEdgeReferenceV1({ topology, release });
  assert.deepEqual(reference.routes.map((route) => route.routeId), [...OPERATIONS_EDGE_ROUTE_IDS_V1]);
  assert.equal(reference.routes[0]!.authentication, "phishing_resistant_owner_identity");
  assert.equal(reference.routes[0]!.ownerStrongFactorRequired, true);
  assert.equal(reference.routes[1]!.authentication, "node_asymmetric_application_identity");
  assert.equal(reference.routes[1]!.exactNodeAttestationRequired, true);
  assert.equal(reference.routes.every((route) => route.connectorDirection === "outbound_only" && route.originExposure === "none"
    && !route.publicOriginAllowed && !route.inboundNodeListenerAllowed && !route.wildcardRouteAllowed && !route.bypassAllowed), true);
  assert.deepEqual(parseOperationsProtectedEdgeReferenceV1(reference), reference);
});

test("CR10A-OPS-030 Cloudflare-shaped example contains shape only and no provider value or authority", () => {
  const { topology, release } = foundations(), reference = buildOperationsProtectedEdgeReferenceV1({ topology, release });
  assert.equal(reference.providerExampleKind, "cloudflare_tunnel_access_value_free_example");
  assert.match(reference.providerTemplate, /cloudflare_tunnel_access/);
  assert.doesNotMatch(reference.providerTemplate, /(?:https?:\/\/|0\.0\.0\.0|\*\.|"enabled":\s*true)/i);
  assert.equal(reference.accountIdentityPresent || reference.zoneIdentityPresent || reference.domainPresent
    || reference.hostnamePresent || reference.tunnelIdentityPresent || reference.credentialValuesPresent
    || reference.providerSdkPresent || reference.networkClientPresent || reference.providerContacted
    || reference.dnsMutationAllowed || reference.publicExposureAllowed || reference.deployable, false);
});

test("CR10A-OPS-030 records a complete disabled provider disposition with zero effects", () => {
  const { topology, release } = foundations(), reference = buildOperationsProtectedEdgeReferenceV1({ topology, release });
  const disposition = buildOperationsProtectedEdgeDisabledDispositionV1({ dispositionId: "disposition:operations:edge:disabled",
    edgeReference: reference, recordedAt: "2026-08-30T00:12:00.000Z" });
  assert.deepEqual(disposition.blockerCodes, [...OPERATIONS_EDGE_BLOCKER_CODES_V1]);
  assert.equal(disposition.providerAttempts + disposition.dnsMutations + disposition.tunnelMutations
    + disposition.accessPolicyMutations + disposition.publicExposures + disposition.credentialResolutions, 0);
  assert.equal(disposition.automaticRetryAllowed || disposition.grantsNetworkAuthority || disposition.grantsApproval
    || disposition.grantsExecutionAuthority, false);
  assert.deepEqual(parseOperationsProtectedEdgeDispositionV1(disposition), disposition);
});

test("CR10A-OPS-030 fake policy match remains owner-review evidence with no provider contact", () => {
  const { topology, release } = foundations(), reference = buildOperationsProtectedEdgeReferenceV1({ topology, release });
  const assessment = assessOperationsProtectedEdgeWithFakeV1({ assessmentId: "assessment:operations:edge:fake",
    edgeReference: reference, mode: "synthetic_policy_match", assessedAt: "2026-08-30T00:12:00.000Z" });
  assert.equal(assessment.state, "candidate_for_owner_review");
  assert.equal(assessment.routeResults.every((result) => result.state === "synthetic_match"), true);
  assert.equal(assessment.providerContacted || assessment.networkAttempted || assessment.dnsMutationAttempted
    || assessment.credentialResolutionAttempted || assessment.grantsNetworkAuthority || assessment.grantsApproval, false);
  assert.deepEqual(parseOperationsFakeEdgeAssessmentV1(assessment), assessment);
});

test("CR10A-OPS-030 rejects wildcard, bypass, route order, secret, and Proxy drift", () => {
  const { topology, release } = foundations(), reference = buildOperationsProtectedEdgeReferenceV1({ topology, release });
  const drift = clone(reference); (drift.routes[0] as unknown as { wildcardRouteAllowed: boolean }).wildcardRouteAllowed = true;
  drift.routes[0] = resign(drift.routes[0] as unknown as Record<string, unknown>, "routeReferenceDigest") as never;
  assert.throws(() => parseOperationsProtectedEdgeReferenceV1(resign(drift as unknown as Record<string, unknown>, "edgeReferenceDigest")), rejected);
  const reordered = clone(reference); reordered.routes.reverse();
  assert.throws(() => parseOperationsProtectedEdgeReferenceV1(resign(reordered as unknown as Record<string, unknown>, "edgeReferenceDigest")), rejected);
  assert.throws(() => buildOperationsProtectedEdgeReferenceV1({ topology, release, apiKey: "forbidden-value" }), rejected);
  const proxy = observedProxy({ topology, release }, "throwing"); assert.throws(() => buildOperationsProtectedEdgeReferenceV1(proxy.value), rejected);
  assert.equal(proxy.trapCount(), 0);
});

test("CR10A-OPS-040 resource policy is exact, advisory, topology-bound, and non-authorizing", () => {
  const { topology } = foundations(), policy = resourcePolicy(topology);
  assert.equal(policy.topologyDigest, topology.topologyDigest); assert.equal(policy.advisoryOnly, true);
  assert.equal(policy.missingMetricDisposition, "unknown"); assert.equal(policy.thresholdBreachDisposition, "fail");
  assert.equal(policy.grantsServiceControl || policy.grantsDeploymentAuthority, false);
});

test("CR10A-OPS-040 fake collector runs 48 required probes and produces only a readiness candidate", () => {
  const { collection } = collect("passing");
  assert.equal(collection.requiredProbeCount, 48); assert.equal(collection.notApplicableProbeCount, 29);
  assert.equal(collection.adapterCallCount, 48); assert.equal(collection.resourceEvidence.length, 7);
  assert.equal(collection.healthSnapshot.overallReadiness, "ready_candidate");
  assert.equal(collection.processInspectionAttempted || collection.filesystemInspectionAttempted || collection.networkAttempted
    || collection.databaseConnectionAttempted || collection.serviceControlAttempted || collection.grantsServiceControl
    || collection.grantsDeploymentAuthority, false);
  assert.deepEqual(parseOperationsProbeCollectionV1(collection), collection);
});

test("CR10A-OPS-040 database failure and resource pressure fail different services safely", () => {
  const database = collect("application_database_failure").collection;
  assert.equal(database.healthSnapshot.overallReadiness, "not_ready");
  assert.deepEqual(database.healthSnapshot.blockingServiceIds, [OPERATIONS_SERVICE_IDS_V1[1]]);
  assert.equal(database.healthSnapshot.observations[1]!.safeStatusCode, "required_probe_failed");
  const resource = collect("edge_resource_pressure").collection;
  assert.equal(resource.healthSnapshot.overallReadiness, "not_ready");
  assert.deepEqual(resource.healthSnapshot.blockingServiceIds, [OPERATIONS_SERVICE_IDS_V1[0]]);
  assert.equal(resource.resourceEvidence[0]!.safeStatusCode, "resource_threshold_exceeded");
});

test("CR10A-OPS-040 readiness projection exposes safe evidence without action controls", () => {
  const { collection } = collect("application_database_failure"), projection = projectOperationsHealthReadinessV1(collection);
  assert.equal(projection.services.length, 7); assert.deepEqual(projection.blockingServiceIds, [OPERATIONS_SERVICE_IDS_V1[1]]);
  assert.equal(projection.actionControlsPresent || projection.grantsApproval || projection.grantsServiceControl
    || projection.grantsDeploymentAuthority, false);
  assert.deepEqual(parseOperationsHealthReadinessProjectionV1(projection), projection);
});

test("CR10A-OPS-040 refuses untrusted adapters, production observers, foreign policy, and inapplicable overrides", () => {
  const { topology } = foundations(), policy = resourcePolicy(topology), fixture = buildOperationsSyntheticFakeProbeAdapterInputV1(topology);
  assert.throws(() => collectOperationsHealthWithFakeV1({ collectionId: "collection:operations:untrusted",
    snapshotId: "snapshot:operations:untrusted", topology, resourcePolicy: policy },
  { kind: "in_memory_fake_no_io", sample() { throw new Error("must not run"); } }), rejected);
  assert.throws(() => createOperationsFakeProbeAdapterV1({ ...fixture,
    observerIdentityDigest: topology.services[0]!.principalIdentityDigest }), rejected);
  const foreignValue = clone(topology); foreignValue.topologyId = "topology:operations:foreign";
  const foreign = resign(foreignValue as unknown as Record<string, unknown>, "topologyDigest"), foreignPolicy = buildOperationsResourcePolicyV1({
    policyId: "policy:operations:foreign", topology: foreign, maximumMemoryUtilizationPermille: 801,
    maximumCpuUtilizationPermille: 850, maximumStorageUtilizationPermille: 800, maximumSampleAgeSeconds: 120 });
  const adapter = createOperationsFakeProbeAdapterV1(fixture);
  assert.throws(() => collectOperationsHealthWithFakeV1({ collectionId: "collection:operations:foreign",
    snapshotId: "snapshot:operations:foreign", topology, resourcePolicy: foreignPolicy }, adapter), rejected);
  assert.throws(() => createOperationsFakeProbeAdapterV1({ ...fixture, overrides: [{ serviceId: OPERATIONS_SERVICE_IDS_V1[0],
    probeId: "database_transaction", state: "fail", safeStatusCode: "invented" }] }), rejected);
});

test("CR10A-OPS-040 derives resource truth again after fully re-signed nested drift", () => {
  const { collection } = collect("passing"), drift = clone(collection), resource = drift.resourceEvidence[0]!;
  resource.memoryUtilizationPermille = 999;
  drift.resourceEvidence[0] = resign(resource as unknown as Record<string, unknown>, "evidenceDigest") as never;
  const observation = drift.healthSnapshot.observations[0]!, probeIndex = observation.probes.findIndex((probe) => probe.probeId === "resource_headroom");
  observation.probes[probeIndex]!.evidenceDigest = drift.resourceEvidence[0]!.evidenceDigest;
  observation.probes[probeIndex] = resign(observation.probes[probeIndex] as unknown as Record<string, unknown>, "probeDigest") as never;
  drift.healthSnapshot.observations[0] = resign(observation as unknown as Record<string, unknown>, "observationDigest") as never;
  drift.healthSnapshot = resign(drift.healthSnapshot as unknown as Record<string, unknown>, "snapshotDigest") as never;
  const resigned = resign(drift as unknown as Record<string, unknown>, "collectionDigest") as unknown as OperationsProbeCollectionV1;
  assert.throws(() => parseOperationsProbeCollectionV1(resigned), rejected);
});

test("CR10A-OPS-040 rejects secret, extra, accessor, and Proxy fixtures without executing traps", () => {
  const { topology } = foundations(), fixture = buildOperationsSyntheticFakeProbeAdapterInputV1(topology);
  assert.throws(() => createOperationsFakeProbeAdapterV1({ ...fixture, refreshToken: "forbidden-value" }), rejected);
  const accessor = { ...fixture, get validUntil() { throw new Error("must not execute"); } };
  assert.throws(() => createOperationsFakeProbeAdapterV1(accessor), rejected);
  const proxy = observedProxy(fixture, "throwing"); assert.throws(() => createOperationsFakeProbeAdapterV1(proxy.value), rejected);
  assert.equal(proxy.trapCount(), 0);
});

test("CR10A-OPS-010/040 accepted implementation contains no runtime, host, network, database, provider, or service-control client", async () => {
  const files = ["compose-reference.ts", "systemd-reference.ts", "protected-edge-reference.ts", "probe-adapters.ts"];
  for (const file of files) {
    const source = await readFile(new URL(`../src/operations/v1/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /from\s+["']node:(?:child_process|fs|net|http|https|os)["']/);
    assert.doesNotMatch(source, /from\s+["'](?:postgres|pg|dockerode|cloudflare|@cloudflare|systemd)["']/i);
    assert.doesNotMatch(source, /(?:execFile|spawn|fetch|systemctl|docker\s+compose|cloudflared|wrangler)\s*\(/i);
  }
});
