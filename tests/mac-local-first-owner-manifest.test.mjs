import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createMacLocalFirstOwnerManifestV1, MAC_LOCAL_FIRST_OWNER_MANIFEST_V1, writeMacLocalFirstOwnerManifestV1 } from "../scripts/mac-local/first-owner-manifest.mjs";
import { sha256Digest } from "../src/security/index.ts";
import { CompletionGateStoreV1 } from "../src/completion-gate/v1/store.ts";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration.ts";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session.ts";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements.ts";
import { HERMES_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-local-v1/task-planning-contract.ts";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../src/harness/claude-code-v1/task-planning-contract.ts";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract.ts";

const configuration = Object.freeze({
  workspaceId: "workspace:mac-local",
  localOwnerSession: { tenantId: "tenant:mac-local", provider: "local-owner", subject: "owner:local" },
  enablement: { nodeId: "mac-1", workers: [
    { kind: "hermes", workerId: "worker:hermes", executablePath: "/private/hermes", recordedVersion: "test" },
    { kind: "claude-code", workerId: "worker:claude", executablePath: "/private/claude", recordedVersion: "test" },
    { kind: "codex", workerId: "worker:codex", executablePath: "/private/codex", recordedVersion: "test" },
  ] },
});
const reviewKey = new Uint8Array(32).fill(41);
const genesis = CompletionGateStoreV1.genesisIntegrityForKeyV1(configuration.localOwnerSession.tenantId, reviewKey);

test("first-owner manifest contains only the exact non-secret transfer fields", () => {
  const manifest = createMacLocalFirstOwnerManifestV1(configuration, "2026-09-25T12:00:00.000Z", genesis);
  assert.deepEqual(Object.keys(manifest), ["schema", "tenant", "workspace", "identity", "grant", "adapters", "nodes", "completionGateGenesis", "createdAt"]);
  assert.equal(manifest.schema, MAC_LOCAL_FIRST_OWNER_MANIFEST_V1);
  assert.deepEqual(manifest.tenant, { id: "tenant:mac-local", displayName: "Mac local" });
  assert.deepEqual(manifest.workspace, { id: "workspace:mac-local", displayName: "Mac local" });
  assert.deepEqual(manifest.identity, { id: "identity:tenant:mac-local:owner", displayName: "Owner",
    subjectDigest: sha256Digest({ provider: "local-owner", subject: "owner:local" }) });
  assert.deepEqual(manifest.grant, { id: "grant:tenant:mac-local:owner" });
  assert.deepEqual(manifest.completionGateGenesis, genesis);
  assert.deepEqual(manifest.nodes, [
    { nodeId: "mac-1.hermes", workerId: "worker:hermes", adapterId: HERMES_LOCAL_ADAPTER_V1 },
    { nodeId: "mac-1.claude", workerId: "worker:claude", adapterId: CLAUDE_CODE_LOCAL_ADAPTER_V1 },
    { nodeId: "mac-1.codex", workerId: "worker:codex", adapterId: CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 },
  ]);
  assert.equal(JSON.stringify(manifest).includes("/private/"), false);
  assert.equal(JSON.stringify(manifest).includes("test-only-password"), false);
  assert.equal(JSON.stringify(manifest).includes("subject\""), false);
});

test("first-owner manifest refuses missing workers and non-canonical timestamps", () => {
  assert.throws(() => createMacLocalFirstOwnerManifestV1({ ...configuration,
    enablement: { ...configuration.enablement, workers: configuration.enablement.workers.slice(0, 2) } }));
  assert.throws(() => createMacLocalFirstOwnerManifestV1(configuration, "2026-09-25"));
});

test("command reads the fixed protected config, writes a shareable file, and never overwrites", async () => {
  const root = await mkdtemp(join(tmpdir(), "acr-first-owner-manifest-"));
  const configDirectory = join(root, "config");
  await mkdir(configDirectory, { mode: 0o700 });
  const protectedConfiguration = {
    schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1,
    port: 3210,
    workspaceId: configuration.workspaceId,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210",
      tenantId: configuration.localOwnerSession.tenantId, provider: configuration.localOwnerSession.provider,
      subject: configuration.localOwnerSession.subject, ownerCodeDigest: sha256Digest({ ownerCode: "owner code for tests" }), sessionSeconds: 900 },
    database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "test-only-password", majorVersion: 17 },
    enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: configuration.enablement.workers },
  };
  const configPath = join(configDirectory, "mac-local.json");
  await writeFile(configPath, JSON.stringify(protectedConfiguration), { mode: 0o600 });
  await chmod(configPath, 0o600);
  const runtimeKeys = Object.fromEntries(["planning", "review", "harness", "results", "approvals", "deliveryReceipt"]
    .map((role, index) => [role, Buffer.from(new Uint8Array(32).fill(index + 1)).toString("base64url")]));
  await writeFile(join(configDirectory, "task-runtime.json"), JSON.stringify({
    schema: "control-room.mac-local-task-runtime/v1", keys: runtimeKeys,
    hermes: { profile: "test", provider: "test", model: "test", destination: "https://example.test:443" },
  }), { mode: 0o600 });
  const outFile = join(root, "first-owner.json");
  const written = await writeMacLocalFirstOwnerManifestV1(root, outFile);
  assert.deepEqual(JSON.parse(await readFile(outFile, "utf8")), written);
  assert.deepEqual(JSON.parse(await readFile(join(configDirectory, "first-owner-manifest.json"), "utf8")), written);
  assert.equal((await (await import("node:fs/promises")).stat(join(configDirectory, "first-owner-manifest.json"))).mode & 0o777, 0o600);
  const repeated = await writeMacLocalFirstOwnerManifestV1(root, join(root, "first-owner-copy.json"));
  assert.deepEqual(repeated, written);
  await assert.rejects(writeMacLocalFirstOwnerManifestV1(root, outFile));
});
