import assert from "node:assert/strict";
import test from "node:test";
import { captureOwnerTrustedLocalEnablementV1, OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { buildMacLocalTaskTemplatesV1 } from "../src/web/v1/mac-local-task-provider-templates";
import type { MacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import type { MacLocalTaskRuntimeV1 } from "../src/web/v1/mac-local-task-runtime";

const enablement = captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1,
  mode: "mac-local", nodeId: "mac-1", workers: (["hermes", "claude-code", "codex"] as const).map(kind => ({
    workerId: `worker:${kind}`, kind, executablePath: `/private/tmp/${kind}`, recordedVersion: "current" })) });
const configuration = { localOwnerSession: { tenantId: "tenant:local" }, enablement } as MacLocalProtectedConfigurationV1;
const runtime = { hermes: { profile: "cr", provider: "opencode-go", model: "space-bunny-free",
  destination: "https://opencode.ai:443" } } as MacLocalTaskRuntimeV1;

test("builds three project-bound, approval-required templates and three distinct local routes", () => {
  const value = buildMacLocalTaskTemplatesV1([{ projectId: "project:first", createdAt: "2026-09-25T00:00:00.000Z" }], configuration, runtime);
  assert.equal(value.templates.length, 3);
  assert.deepEqual(value.routes.map(item => item.nodeId), ["mac-1.hermes", "mac-1.claude", "mac-1.codex"]);
  assert.deepEqual(value.templates.map(item => item.authority.credentialRefs[0]), [
    "credential:owner-cli:hermes", "credential:owner-cli:claude-code", "credential:owner-cli:codex"]);
  assert.deepEqual(value.templates.map(item => item.authority.allowedNetworkDestinations), [
    ["https://opencode.ai:443"], [], []]);
  assert.ok(value.templates.every(item => item.authority.effectPolicy === "approval_required"));
  assert.equal(value.templates[0]?.acceptanceProfileId, value.profiles[0]?.id);
  assert.deepEqual(buildMacLocalTaskTemplatesV1([{ projectId: "project:first", createdAt: "2026-09-25T00:00:00.000Z" }], configuration, runtime), value);
  assert.throws(() => buildMacLocalTaskTemplatesV1([], configuration, runtime), /mac_local_template_limit/);
  assert.throws(() => buildMacLocalTaskTemplatesV1(Array.from({ length: 6 }, (_, i) => ({
    projectId: `project:${i}`, createdAt: "2026-09-25T00:00:00.000Z" })), configuration, runtime), /mac_local_template_limit/);
});
