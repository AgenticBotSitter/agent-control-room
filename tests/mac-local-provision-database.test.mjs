import assert from "node:assert/strict";
import test from "node:test";
import { captureProvisionedMacLocalConfigurationV1, prepareProvisionedWorkIntakeConfigurationV1 } from
  "../scripts/mac-local/provision-database.mjs";
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

test("provisioner prepares one protected client-and-server intake record without starting anything", () => {
  const record = prepareProvisionedWorkIntakeConfigurationV1({ database: { host: "127.0.0.1", port: 15432,
    database: "control_room", username: "control_room_work_intake_agent", password: "fixture", majorVersion: 17 },
  bearerSecret: "a".repeat(43), integrityKey: "b".repeat(43), now: "2026-09-27T12:00:00.000Z" });
  assert.equal(record.port, 3211);
  assert.equal(record.database.username, "control_room_work_intake_agent");
  assert.equal(record.queueDepthLimit, 10);
  assert.equal(record.principal.expiresAt, "2027-09-27T12:00:00.000Z");
  assert.equal(Object.keys(record).sort().join(","),
    "bearerSecret,database,integrityKey,port,principal,queueDepthLimit,schema");
});
