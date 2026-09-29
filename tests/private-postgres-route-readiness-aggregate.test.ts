import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { consumePrivatePostgresRouteReadinessCapabilityV1,
  preparePrivatePostgresRouteReadinessSourceAssessmentV1,
  verifyPrivatePostgresRouteReadinessSourceAssessmentV1 } from
  "../src/installer/v1/private-postgres-route-readiness-aggregate";

const d = (value: unknown) => sha256Digest(value);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: d("topology"), databaseAuthorityDigest: d("database-authority"),
  endpointFingerprint: d("endpoint"), privateRouteEvidenceDigest: d("private-route"),
  certificateSha256: d("certificate"), restrictedRoleEvidenceDigest: d("restricted-role") });

test("the source assessment is aggregate-bound, redacted and explicitly blocked", () => {
  const prepared = preparePrivatePostgresRouteReadinessSourceAssessmentV1(binding);
  assert.equal(prepared.assessment.status, "blocked");
  assert.equal(prepared.assessment.blocker, "protected_owner_route_source_missing");
  assert.equal(prepared.assessment.createsSourceEvidence, false);
  assert.deepEqual(prepared.assessment.requiredProofs, ["current_private_route_authorization",
    "observed_tls_peer_identity", "restricted_role_database_preflight"]);
  assert.deepEqual(verifyPrivatePostgresRouteReadinessSourceAssessmentV1(prepared.aggregate,
    prepared.assessment), prepared.assessment);
  assert.doesNotMatch(JSON.stringify(prepared.assessment),
    /100\.\d+\.\d+\.\d+|postgresql:\/\/|certificate-value|role-name|private-route/u);
});

test("arbitrary route, certificate and role objects cannot manufacture readiness", () => {
  const prepared = preparePrivatePostgresRouteReadinessSourceAssessmentV1(binding);
  for (const capability of [
    { route: Object.freeze({ verified: true }), certificate: Object.freeze({ verified: true }),
      restrictedRole: Object.freeze({ verified: true }) },
    Object.freeze({ schema: "control-room.private-postgres-route-readiness-capability/v1" }),
    structuredClone(prepared.assessment),
  ]) assert.throws(() => consumePrivatePostgresRouteReadinessCapabilityV1({ aggregate: prepared.aggregate,
    capability }), /route_readiness_aggregate_refused/u);
});

test("foreign aggregate, output tampering and structural aggregate fakes are refused", () => {
  const prepared = preparePrivatePostgresRouteReadinessSourceAssessmentV1(binding);
  const foreign = preparePrivatePostgresRouteReadinessSourceAssessmentV1({ ...binding,
    topologyPlanDigest: d("foreign-topology") });
  assert.throws(() => verifyPrivatePostgresRouteReadinessSourceAssessmentV1(foreign.aggregate,
    prepared.assessment), /route_readiness_aggregate_refused/u);
  assert.throws(() => verifyPrivatePostgresRouteReadinessSourceAssessmentV1(prepared.aggregate,
    { ...prepared.assessment, status: "ready" }), /route_readiness_aggregate_refused/u);
  assert.throws(() => verifyPrivatePostgresRouteReadinessSourceAssessmentV1(
    { schema: "control-room.private-postgres-route-readiness-aggregate/v1" }, prepared.assessment),
  /route_readiness_aggregate_refused/u);
});

test("repeated fake-capability attempts remain blocked without mutating assessment custody", () => {
  const prepared = preparePrivatePostgresRouteReadinessSourceAssessmentV1(binding);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => consumePrivatePostgresRouteReadinessCapabilityV1({ aggregate: prepared.aggregate,
      capability: Object.freeze({ attempt }) }), /route_readiness_aggregate_refused/u);
    assert.deepEqual(verifyPrivatePostgresRouteReadinessSourceAssessmentV1(prepared.aggregate,
      prepared.assessment), prepared.assessment);
  }
});

test("hostile bindings cannot create assessment custody", () => {
  assert.throws(() => preparePrivatePostgresRouteReadinessSourceAssessmentV1(new Proxy(binding, {})),
    /route_readiness_aggregate_refused/u);
  assert.throws(() => preparePrivatePostgresRouteReadinessSourceAssessmentV1({ ...binding,
    certificateSha256: "not-a-digest" }), /route_readiness_aggregate_refused/u);
  assert.throws(() => preparePrivatePostgresRouteReadinessSourceAssessmentV1({ ...binding,
    privateRouteEvidenceDigest: d("changed"), extra: true }), /route_readiness_aggregate_refused/u);
});
