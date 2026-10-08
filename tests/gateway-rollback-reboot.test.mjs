import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// Lead-run only. The reviewed practice-VM controller supplies this adapter and
// a separately captured OLD fixture. No host command, VM creation or reboot is
// performed by this file. The adapter owns the real install/reboot and teardown.
const adapter = process.env.CONTROL_ROOM_GATEWAY_R1_VM_CONTROLLER;
const fixturePath = process.env.CONTROL_ROOM_GATEWAY_R1_OLD_FIXTURE;
const digest = /^sha256:[a-f0-9]{64}$/u;
test("old updater installs R1 without moving the gateway", {
  skip: !adapter || !fixturePath ? "LEAD-RUN on the practice Mac VM via the reviewed rehearsal controller" : false,
  timeout: 1_200_000,
}, async () => {
  assert.equal(process.platform, "darwin", "VM rehearsal is a Mac-only proof");
  assert.ok(isAbsolute(adapter) && isAbsolute(fixturePath));
  const old = JSON.parse(await readFile(fixturePath, "utf8"));
  assert.match(old.updaterBundleDigest, digest); assert.equal(old.gatewayLocalHost, "127.0.0.1");
  const controller = await import(pathToFileURL(adapter).href);
  assert.equal(typeof controller.oldUpdaterInstallsR1V1, "function");
  const result = await controller.oldUpdaterInstallsR1V1({ oldFixture: old, candidateCommit: process.env.CONTROL_ROOM_GATEWAY_R1_COMMIT });
  assert.equal(result.executingUpdaterDigest, old.updaterBundleDigest, "OLD actually executes the installation");
  assert.equal(result.installExit, 0); assert.equal(result.declarationPresent, false, "OLD's builder emits no new declaration");
  assert.match(result.installedUpdaterDigest, digest); assert.notEqual(result.installedUpdaterDigest, old.updaterBundleDigest);
  assert.equal(result.afterRebootUpdaterDigest, result.installedUpdaterDigest);
  assert.equal(result.nextInvocationCapabilityRefusal, "gateway_capability_refused", "next installed invocation runs the R1 reader, not a marker");
  assert.equal(result.gatewayLocalHost, "127.0.0.1"); assert.equal(result.webLocalHost, "127.0.0.1");
  assert.equal(result.profileDigest, old.profileDigest); assert.equal(result.protectedConfigDigest, old.protectedConfigDigest);
  assert.equal(result.signedGatewayHealth, true); assert.equal(result.newRouteActions, 0);
  assert.equal(result.rootCustodyWrongOwnerRefused, true); assert.equal(result.cleanupReached, true);
});
