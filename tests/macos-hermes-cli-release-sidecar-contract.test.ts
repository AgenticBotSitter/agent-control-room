import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MACOS_HERMES_CLI_RELEASE_SIDECAR_CONTRACT_V1,
  parseMacosHermesCliReleaseSidecarContractV1,
  prepareMacosHermesCliReleaseSidecarContractV1,
  serializeMacosHermesCliReleaseSidecarContractV1,
} from "../src/installer/v1/macos-hermes-cli-release-sidecar-contract";

const d = (character: string) => `sha256:${character.repeat(64)}`;
const input = Object.freeze({
  architecture: "arm64",
  nativeHostArtifactSha256: d("a"),
  nativeHostSourceSha256: d("b"),
  releaseSha256: d("c"),
  releaseVersion: "0.1.0",
  runtimeImageSha256: d("d"),
  runtimeManifestSha256: d("e"),
});
const refusal = /^Error: macos_hermes_cli_release_sidecar_contract_refused$/u;

test("defines a release-bound but deliberately non-authorizing Hermes launch sidecar contract", () => {
  const contract = prepareMacosHermesCliReleaseSidecarContractV1(input);
  assert.equal(contract.schema, MACOS_HERMES_CLI_RELEASE_SIDECAR_CONTRACT_V1);
  assert.equal(contract.hermesVersion, "0.21.3");
  assert.equal(contract.hermesSourceRevision, "00570550f37e9082676955d50f65c7d9ba846cc9");
  assert.equal(contract.runtimePackaging.kind, "read_only_complete_runtime_image");
  assert.equal(contract.runtimePackaging.modifiesHermesSource, false);
  assert.equal(contract.runtimePackaging.includesCredentials, false);
  assert.equal(contract.nativeHost.acceptsCallerExecutablePath, false);
  assert.equal(contract.nativeHost.acceptsCallerRuntimePath, false);
  assert.equal(contract.nativeHost.trustsMutablePathname, false);
  assert.equal(contract.nativeHost.launchesOnlyFromVerifiedReadOnlyRuntimeImage, true);
  assert.equal(contract.status, "contract_only");
  assert.equal(contract.grantsLaunchAuthority, false);
  assert.equal(contract.grantsQualificationAuthority, false);
  assert.equal(contract.nativeAttemptsMade, 0);
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.runtimePackaging), true);
  assert.equal(Object.isFrozen(contract.nativeHost), true);
  assert.equal(Object.isFrozen(contract.blockerCodes), true);
  assert.deepEqual(parseMacosHermesCliReleaseSidecarContractV1(JSON.parse(
    serializeMacosHermesCliReleaseSidecarContractV1(contract))), contract);
});

test("rejects paths, commands, credentials, extra fields, accessors and proxies before contract creation", () => {
  for (const extra of [
    { executablePath: "/private/owner/hermes" },
    { runtimePath: "/private/owner/runtime" },
    { command: "hermes" },
    { credential: "secret" },
    { grantsLaunchAuthority: true },
  ]) assert.throws(() => prepareMacosHermesCliReleaseSidecarContractV1({ ...input, ...extra }), refusal);
  assert.throws(() => prepareMacosHermesCliReleaseSidecarContractV1(new Proxy(input, {})), refusal);
  const getter = { ...input } as Record<string, unknown>;
  Object.defineProperty(getter, "runtimeImageSha256", { enumerable: true, get() { throw new Error("read"); } });
  assert.throws(() => prepareMacosHermesCliReleaseSidecarContractV1(getter), refusal);
});

test("rejects forged readiness and every manifest mutation", () => {
  const contract = prepareMacosHermesCliReleaseSidecarContractV1(input);
  const mutations: unknown[] = [
    { ...contract, status: "ready" },
    { ...contract, grantsLaunchAuthority: true },
    { ...contract, grantsQualificationAuthority: true },
    { ...contract, startsProcess: true },
    { ...contract, nativeAttemptsMade: 1 },
    { ...contract, blockerCodes: contract.blockerCodes.slice(1) },
    { ...contract, hermesVersion: "0.21.4" },
    { ...contract, releaseSha256: d("f") },
    { ...contract, runtimePackaging: { ...contract.runtimePackaging, includesCredentials: true } },
    { ...contract, runtimePackaging: { ...contract.runtimePackaging, rejectsLinks: false } },
    { ...contract, nativeHost: { ...contract.nativeHost, acceptsCallerExecutablePath: true } },
    { ...contract, nativeHost: { ...contract.nativeHost, trustsMutablePathname: true } },
    { ...contract, unreviewed: true },
  ];
  for (const mutation of mutations)
    assert.throws(() => parseMacosHermesCliReleaseSidecarContractV1(mutation), refusal);
});

test("a look-alike record, proxy, accessor or malformed digest cannot become a parsed contract", () => {
  const contract = prepareMacosHermesCliReleaseSidecarContractV1(input);
  assert.throws(() => parseMacosHermesCliReleaseSidecarContractV1(new Proxy(contract, {})), refusal);
  const getter = { ...contract } as Record<string, unknown>;
  Object.defineProperty(getter, "nativeHost", { enumerable: true, get() { throw new Error("read"); } });
  assert.throws(() => parseMacosHermesCliReleaseSidecarContractV1(getter), refusal);
  assert.throws(() => prepareMacosHermesCliReleaseSidecarContractV1({ ...input, runtimeImageSha256: "sha256:no" }), refusal);
  assert.throws(() => parseMacosHermesCliReleaseSidecarContractV1({}), refusal);
});
