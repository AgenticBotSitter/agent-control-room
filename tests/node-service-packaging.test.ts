import assert from "node:assert/strict";
import test from "node:test";
import { verifyServicePackages } from "../src/node-service-packaging/v1/conformance";
import { diagnoseServicePackage } from "../src/node-service-packaging/v1/diagnostics";

test("value-free native service packages satisfy the CR-6A static conformance contract", async () => {
  const results = await verifyServicePackages();
  assert.deepEqual(results.map((result) => result.platform), ["linux", "macos", "windows"]);
  assert.ok(results.every((result) => result.checks.length >= 4));
});

const validMacInput = {
  platform: "macos" as const,
  runtimePath: "/opt/control-room/runtime/node",
  releaseDirectory: "/opt/control-room/releases/current",
  configPath: "/Library/Application Support/ControlRoom/node-config.json",
  stateRoot: "/Library/Application Support/ControlRoom/state",
  logRoot: "/Library/Logs/ControlRoom",
};

test("static diagnostics expose only safe status codes and never operate a supervisor", async () => {
  assert.equal((await diagnoseServicePackage(validMacInput)).code, "continuous_service_not_available");
  assert.equal((await diagnoseServicePackage({ ...validMacInput, configPath: "relative-config" })).code, "configuration_invalid");
  assert.equal((await diagnoseServicePackage({ ...validMacInput, runtimePresent: false })).code, "runtime_missing");
  assert.equal((await diagnoseServicePackage({ ...validMacInput, nativeEvidenceClaim: true })).code, "native_evidence_required");
});

test("valid paths and supplied runtime presence never certify continuous service readiness", async () => {
  for (const platform of ["macos", "linux", "windows"] as const) {
    const input = platform === "windows" ? { runtimePath: "C:/cr/node.exe", releaseDirectory: "C:/cr/release",
      configPath: "C:/cr/config", stateRoot: "C:/cr/state", logRoot: "C:/cr/log" } : validMacInput;
    const result = await diagnoseServicePackage({ ...input, platform, runtimePresent: true, systemdAvailable: true });
    assert.equal(result.code, "continuous_service_not_available");
    assert.doesNotMatch(JSON.stringify(result), /C:\/cr|\/opt\/|\/Library\//);
  }
});

test("linux diagnostics visibly reject a non-systemd context without attempting an alternate supervisor", async () => {
  const result = await diagnoseServicePackage({
    ...validMacInput,
    platform: "linux",
    runtimePath: "/opt/control-room/runtime/node",
    releaseDirectory: "/opt/control-room/releases/current",
    configPath: "/etc/control-room/node-config.json",
    stateRoot: "/var/lib/control-room",
    logRoot: "/var/log/control-room",
    systemdAvailable: false,
  });
  assert.equal(result.code, "supervisor_unavailable");
  assert.doesNotMatch(JSON.stringify(result), /\/opt\/|\/etc\/|\/var\//);
});
