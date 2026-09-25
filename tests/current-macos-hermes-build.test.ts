import assert from "node:assert/strict";
import test from "node:test";
import {
  HERMES_MACOS_CURRENT_BUILD_V1,
  HERMES_MACOS_CURRENT_SOURCE_REVISION_V1,
  HERMES_MACOS_CURRENT_VERSION_V1,
  currentMacosHermesConnectorProfileV1,
  verifyCurrentMacosHermesBuildV1,
} from "../src/harness/hermes-local-v1";

test("current Mac Hermes build is exact and retains the observed source revision", () => {
  assert.equal(verifyCurrentMacosHermesBuildV1(`${HERMES_MACOS_CURRENT_BUILD_V1}\nInstall directory: /private/path`), HERMES_MACOS_CURRENT_BUILD_V1);
  assert.equal(currentMacosHermesConnectorProfileV1.harnessVersion, HERMES_MACOS_CURRENT_VERSION_V1);
  assert.equal(currentMacosHermesConnectorProfileV1.sourceRevision, HERMES_MACOS_CURRENT_SOURCE_REVISION_V1);
});

test("current Mac Hermes build refuses a changed release, source revision, or malformed version", () => {
  for (const value of [
    HERMES_MACOS_CURRENT_BUILD_V1.replace("v0.20.0", "v0.20.1"),
    HERMES_MACOS_CURRENT_BUILD_V1.replace("b50bb77e", "00000000"),
    "Hermes Agent v0.20.0",
    "",
    undefined,
  ]) assert.throws(() => verifyCurrentMacosHermesBuildV1(value));
});
