import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { sha256Digest } from "../src/security/canonical-digest";
import { createPrivatePostgresRouteOwnerRunnerV1,
  PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_COMPOSITION_V1 } from
  "../src/installer/v1/private-postgres-route-owner-runner-composition";
import { preparePrivatePostgresRouteReadinessSourceAssessmentV1,
  verifyPrivatePostgresRouteReadinessSourceAssessmentV1 } from
  "../src/installer/v1/private-postgres-route-readiness-aggregate";

const d = (value: unknown) => sha256Digest(value);
const binding = Object.freeze({ installationId: "control-room-one", releaseDigest: d("release"),
  topologyPlanDigest: d("topology"), databaseAuthorityDigest: d("database-authority"),
  endpointFingerprint: d("endpoint"), privateRouteEvidenceDigest: d("private-route"),
  certificateSha256: d("certificate"), restrictedRoleEvidenceDigest: d("restricted-role") });

function input(capability: unknown) {
  const prepared = preparePrivatePostgresRouteReadinessSourceAssessmentV1(binding);
  return { prepared, value: Object.freeze({ schema: PRIVATE_POSTGRES_ROUTE_OWNER_RUNNER_COMPOSITION_V1,
    aggregate: prepared.aggregate, sourceAssessment: prepared.assessment,
    installedConfigurationActivationEvidence: capability }) };
}

test("structural installed-configuration capabilities cannot create even the blocked owner runner", () => {
  const shapes = [
    Object.freeze({ schema: "control-room.private-installed-configuration-v3-post-write-verification-capability/v1" }),
    Object.freeze({ installationId: binding.installationId, releaseDigest: binding.releaseDigest,
      topologyPlanDigest: binding.topologyPlanDigest, planDigest: d("plan"), publicationEvidenceDigest: d("publication"),
      configurationSha256: d("configuration"), manifestSha256: d("manifest") }),
  ];
  for (const shape of shapes) {
    const f = input(shape);
    assert.throws(() => createPrivatePostgresRouteOwnerRunnerV1(f.value), /owner_writer_refused/u);
    assert.throws(() => createPrivatePostgresRouteOwnerRunnerV1({ ...f.value,
      installedConfigurationActivationEvidence: structuredClone(shape) }), /owner_writer_refused/u);
    assert.throws(() => createPrivatePostgresRouteOwnerRunnerV1({ ...f.value,
      installedConfigurationActivationEvidence: new Proxy(shape, {}) }), /owner_writer_refused/u);
    assert.deepEqual(verifyPrivatePostgresRouteReadinessSourceAssessmentV1(f.prepared.aggregate,
      f.prepared.assessment), f.prepared.assessment);
  }
});

test("foreign aggregate and substituted construction fields fail before an owner boundary exists", () => {
  const f = input(Object.freeze({ schema: "forged" }));
  const foreign = preparePrivatePostgresRouteReadinessSourceAssessmentV1({ ...binding,
    topologyPlanDigest: d("foreign-topology") });
  assert.throws(() => createPrivatePostgresRouteOwnerRunnerV1({ ...f.value, aggregate: foreign.aggregate }),
    /route_readiness_aggregate_refused/u);
  for (const [name, value] of [["endpoint", "100.100.100.100"], ["certificate", "secret-certificate"],
    ["role", "control_room_web"], ["callback", () => true]] as const) {
    assert.throws(() => createPrivatePostgresRouteOwnerRunnerV1({ ...f.value, [name]: value }),
      /route_owner_runner_composition_refused/u);
  }
});

test("the composition imports no network, database, process, filesystem or TLS host", async () => {
  const source = await readFile(new URL("../src/installer/v1/private-postgres-route-owner-runner-composition.ts",
    import.meta.url), "utf8");
  assert.doesNotMatch(source, /from "node:(?:net|tls|child_process|fs|dns)"/u);
  assert.doesNotMatch(source, /from "(?:pg|postgres)"/u);
  assert.doesNotMatch(source, /createPrivatePgDatabase|qualifyPrivatePgSession|verifyPrivateDatabase/u);
  assert.match(source, /protected_postgres_route_native_host_missing/u);
  assert.match(source, /capabilityMinted: false/u);
});

test("repeated forged attempts remain refused without promoting the blocked assessment", () => {
  const forged = Object.freeze({ schema: "control-room.private-installed-configuration-v3-post-write-verification-capability/v1" });
  const f = input(forged);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => createPrivatePostgresRouteOwnerRunnerV1(f.value), /owner_writer_refused/u);
    assert.equal(f.prepared.assessment.status, "blocked");
    assert.equal(f.prepared.assessment.blocker, "protected_owner_route_source_missing");
  }
});
