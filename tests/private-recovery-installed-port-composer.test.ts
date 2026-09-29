import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createPrivateRecoveryInstalledPortComposerV1, PRIVATE_RECOVERY_INSTALLED_PORT_CAPABILITY_V1,
  PRIVATE_RECOVERY_INSTALLED_PORT_COMPOSER_V1 } from
  "../src/installer/v1/private-recovery-installed-port-composer";

const refuses = (value: unknown) => assert.throws(() => createPrivateRecoveryInstalledPortComposerV1(value),
  /^Error: private_recovery_installed_port_composer_refused$/u);

function candidate() {
  return Object.freeze({ schema: PRIVATE_RECOVERY_INSTALLED_PORT_COMPOSER_V1,
    manifestCapability: Object.freeze({ schema: "fabricated-manifest" }),
    sidecarCapability: Object.freeze({ schema: "fabricated-sidecar" }),
    ownerQualificationCapability: Object.freeze({ schema: "fabricated-owner-qualification" }) });
}

test("the recovery installed-port join is source-only and cannot claim ready", () => {
  refuses(candidate());
  assert.equal(PRIVATE_RECOVERY_INSTALLED_PORT_CAPABILITY_V1,
    "control-room.private-recovery-installed-port-capability/v1");
});

test("copied, proxied, replayed and cross-bound custody candidates all refuse", () => {
  const original = candidate();
  const copied = { ...original, manifestCapability: { ...original.manifestCapability } };
  refuses(copied);
  refuses(new Proxy(candidate(), {}));

  // Reusing an identical structural tuple must not establish a retry route.
  refuses(original);
  refuses(original);

  const other = candidate();
  refuses({ ...candidate(), manifestCapability: other.manifestCapability,
    sidecarCapability: other.sidecarCapability });
});

test("callbacks, paths, argv, credentials, process ports, getters and extra props refuse before use", () => {
  let called = false;
  const callback = () => { called = true; };
  for (const extra of [
    { callback }, { manifestPath: "/private/recovery/manifest" }, { sidecarPath: "/private/recovery/sidecar" },
    { argv: ["--unsafe"] }, { credentials: "secret" }, { processPort: { execute: callback } },
  ]) refuses({ ...candidate(), ...extra });
  assert.equal(called, false);

  const accessor = Object.create(Object.prototype);
  Object.defineProperties(accessor, {
    schema: { enumerable: true, value: PRIVATE_RECOVERY_INSTALLED_PORT_COMPOSER_V1 },
    manifestCapability: { enumerable: true, get() { called = true; return {}; } },
    sidecarCapability: { enumerable: true, value: {} },
    ownerQualificationCapability: { enumerable: true, value: {} },
  });
  refuses(accessor);
  assert.equal(called, false);
});

test("the source adds no native, filesystem, network, credential, or ready execution surface", () => {
  const source = readFileSync(new URL("../src/installer/v1/private-recovery-installed-port-composer.ts", import.meta.url), "utf8");
  for (const forbidden of ["node:child_process", "node:fs", "node:net", "node:tls", "node:crypto",
    ".execute(", ".verifyExecution(", ".prepareLaunch(", ".assertCurrent(", "status: \"ready\""])
    assert.equal(source.includes(forbidden), false, forbidden);
});
