import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest as d } from "../src/security/canonical-digest";
import { captureLocalPlatformServiceObservationV1, localPlatformServiceObservationDigestV1 } from "../src/installer/v1/local-platform-service-observation";
import { localHermesServiceObservationDigestV1 } from "../src/installer/v1/local-hermes-installation-binding";

const observation = { state: "running", topologyPlanDigest: d("topology"), releaseDigest: d("release"),
  serviceIdentityDigest: d("service"), databaseAuthorityDigest: d("database"), protectedDataBindingDigest: d("data"),
  supervisorReadinessDigest: d("supervisor"), observationDigest: d("observation") };

test("shared platform service observation preserves existing stage outcomes byte-for-byte", () => {
  for (const state of ["running", "stopped", "failed", "uncertain", "revoked"]) {
    const value = { ...observation, state };
    const prior = d({ purpose: "local-hermes-service-observation/v1", observation: value });
    assert.equal(localPlatformServiceObservationDigestV1(value), prior);
    assert.equal(localHermesServiceObservationDigestV1(value), prior);
    assert.ok(Object.isFrozen(captureLocalPlatformServiceObservationV1(value)));
  }
});

test("shared platform observation refuses malformed and extra fields without disclosure", () => {
  for (const value of [undefined, { ...observation, state: "healthy" }, { ...observation, path: "PRIVATE" },
    { ...observation, observationDigest: "PRIVATE" }]) {
    assert.throws(() => localPlatformServiceObservationDigestV1(value), /^Error: local_platform_service_observation_refused$/);
    assert.throws(() => localHermesServiceObservationDigestV1(value), /^Error: local_hermes_installation_binding_refused$/);
  }
});
