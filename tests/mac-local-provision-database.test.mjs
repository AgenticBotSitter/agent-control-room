import assert from "node:assert/strict";
import test from "node:test";
import { captureMacLocalInstallationBootstrapV1, captureProvisionedMacLocalConfigurationV1 } from "../scripts/mac-local/provision-database.mjs";
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

test("the provisioner has one fixed local-owner bootstrap and never accepts browser-selected roots", () => {
  assert.deepEqual(captureMacLocalInstallationBootstrapV1(), {
    tenantId: "tenant:mac-local", workspaceId: "workspace:mac-local",
    tenantDisplayName: "Agent Control Room", workspaceDisplayName: "This Mac",
    identityId: "identity:mac-local-owner", grantId: "grant:mac-local-owner",
    displayName: "Local owner", provider: "local-owner", subject: "owner:local",
    subjectDigest: "sha256:f4b51a3c57f093bcd8adf7c03d016ea6c36082fd7a51aa68fec632a4d48a6906",
  });
});
