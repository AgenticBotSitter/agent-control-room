import assert from "node:assert/strict";
import test from "node:test";
import { captureProvisionedMacLocalConfigurationV1 } from "../scripts/mac-local/provision-database.mjs";
import { captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration.ts";

test("the provisioner dry-run's prospective protected config survives the file JSON round trip", () => {
  const prospective = captureProvisionedMacLocalConfigurationV1({
    database: { host: "127.0.0.1", port: 15432, database: "control_room",
      username: "control_room_web", password: "test-password-not-a-secret", majorVersion: 17 },
    ownerCode: "test-owner-code-not-a-secret",
    workers: [
      { workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/example/codex", recordedVersion: "codex 1.2.3" },
      { workerId: "worker:claude:mac-1", kind: "claude-code", executablePath: "/opt/example/claude", recordedVersion: "claude 1.2.3" },
      { workerId: "worker:hermes:mac-1", kind: "hermes", executablePath: "/opt/example/hermes", recordedVersion: "hermes 1.2.3" },
    ],
  });
  const writtenFileContents = JSON.stringify(prospective);
  const loaded = captureMacLocalProtectedConfigurationV1(JSON.parse(writtenFileContents));
  assert.equal(loaded.workspaceId, prospective.workspaceId);
  assert.deepEqual(loaded.enablement.workers, prospective.enablement.workers);
  assert.match(loaded.enablement.enablementDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal("enablementDigest" in JSON.parse(writtenFileContents), false);
});
