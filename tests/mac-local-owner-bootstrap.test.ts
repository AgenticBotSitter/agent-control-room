import assert from "node:assert/strict";
import test, { after } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapMacLocalOwnerV1, seedMacLocalNodeV1 } from "../src/web/v1/mac-local-owner-bootstrap";
import { DatabaseNodeKeyResolver, DatabaseReplayGuard, FixedWindowProtocolRateLimiter,
  NODE_PROTOCOL_V1, NodeProtocolAuthenticator, signNodeFrame } from "../src/node-protocol/v1";
import { captureOwnerTrustedLocalEnablementV1, OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
import { sha256Digest } from "../src/security";
import { CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1 } from "../src/harness/codex-v1/owner-trusted-local-task-planning-contract";
import { HERMES_LOCAL_ADAPTER_V1 } from "../src/harness/hermes-local-v1/task-planning-contract";
import { CLAUDE_CODE_LOCAL_ADAPTER_V1 } from "../src/harness/claude-code-v1/task-planning-contract";
import { checkMacLocalNodeKeyPinV1 } from "../src/web/v1/mac-local-node-key-pin";
import type { MacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import { closePrivateOwnerBootstrapConformanceDatabase, conformanceNow,
  privateOwnerBootstrapFixture } from "./helpers/private-owner-bootstrap-conformance";

after(closePrivateOwnerBootstrapConformanceDatabase);

const local = (tenantId: string, workspaceId: string) => ({ workspaceId,
  localOwnerSession: { tenantId, provider: "local-owner", subject: "owner:local" } }) as unknown as MacLocalProtectedConfigurationV1;
const clock = () => conformanceNow;

test("creates the fixed local owner once and re-runs as a no-op", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-owner-a" }); t.after(fixture.close);
  const config = local("tenant:mac-owner-a", "workspace:mac-owner-a");
  assert.equal(await bootstrapMacLocalOwnerV1(fixture.client, config, clock), "created");
  assert.equal(await bootstrapMacLocalOwnerV1(fixture.client, config, clock), "already_present");
  assert.deepEqual(await fixture.counts(), { identities: 1, grants: 1 });
  const grant = await fixture.client.query<{ role_key: string }>("SELECT role_key FROM control_role_grants WHERE tenant_id=$1", ["tenant:mac-owner-a"]);
  assert.equal(grant.rows[0]?.role_key, "owner");
});

test("never adopts an existing tenant owned by someone else", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-owner-b" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion });
  await assert.rejects(bootstrapMacLocalOwnerV1(fixture.client,
    local(fixture.configuration.tenantId, fixture.configuration.workspaceId), clock), /mac_local_owner_bootstrap_conflict/);
  assert.deepEqual(await fixture.counts(), { identities: 1, grants: 1 });
});

test("refuses a workspace id that already belongs to another tenant", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-owner-c" }); t.after(fixture.close);
  await createPrivateOwnerBootstrapCommand({ openDatabase: fixture.openDatabase(), clock })({
    configuration: fixture.configuration, database: fixture.database, trust: fixture.trust, assertion: fixture.assertion });
  await assert.rejects(bootstrapMacLocalOwnerV1(fixture.client,
    local("tenant:mac-owner-c-other", fixture.configuration.workspaceId), clock), /mac_local_owner_bootstrap_conflict/);
  const tenant = await fixture.client.query("SELECT id FROM tenants WHERE id=$1", ["tenant:mac-owner-c-other"]);
  assert.equal(tenant.rows.length, 0);
});

test("refuses when the owner matches but the configured workspace is not in the tenant", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-owner-d" }); t.after(fixture.close);
  assert.equal(await bootstrapMacLocalOwnerV1(fixture.client, local("tenant:mac-owner-d", "workspace:mac-owner-d"), clock), "created");
  await assert.rejects(bootstrapMacLocalOwnerV1(fixture.client, local("tenant:mac-owner-d", "workspace:mac-owner-d-other"), clock),
    /mac_local_owner_bootstrap_conflict/);
});

test("bootstraps one unspendable identity per local worker and refuses remote frames", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-node-a" }); t.after(fixture.close);
  const enablement = captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1,
    mode: "mac-local", nodeId: "mac-1", workers: [
      { workerId: "worker:hermes", kind: "hermes", executablePath: "/private/tmp/fixture-hermes", recordedVersion: "fixture-version" },
      { workerId: "worker:claude", kind: "claude-code", executablePath: "/private/tmp/fixture-claude", recordedVersion: "fixture-version" },
      { workerId: "worker:codex", kind: "codex", executablePath: "/private/tmp/fixture-codex", recordedVersion: "fixture-version" },
    ] });
  const config = { ...local("tenant:mac-node-a", "workspace:mac-node-a"), enablement };
  await bootstrapMacLocalOwnerV1(fixture.client, config, clock);
  assert.equal(await seedMacLocalNodeV1(fixture.client, config, clock), "created");
  assert.equal(await seedMacLocalNodeV1(fixture.client, config, clock), "already_present");
  const root = await mkdtemp(join(tmpdir(), "acr-node-pin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "config"), { mode: 0o700 });
  await checkMacLocalNodeKeyPinV1(fixture.client, root, config, true);
  await checkMacLocalNodeKeyPinV1(fixture.client, root, config);
  const pinFile = join(root, "config", "node-keys.json");
  const pinned = JSON.parse(await readFile(pinFile, "utf8"));
  pinned.fingerprints["mac-1.codex"] = "sha256:" + "f".repeat(64);
  await writeFile(pinFile, `${JSON.stringify(pinned)}\n`, { mode: 0o600 });
  await assert.rejects(checkMacLocalNodeKeyPinV1(fixture.client, root, config), /mac_local_node_key_pin_mismatch/);
  await rm(pinFile);
  await assert.rejects(checkMacLocalNodeKeyPinV1(fixture.client, root, config), /mac_local_node_key_pin_mismatch/);
  const now = new Date(conformanceNow).toISOString();
  const authenticator = new NodeProtocolAuthenticator(new DatabaseNodeKeyResolver(fixture.client),
    new DatabaseReplayGuard(fixture.client), new FixedWindowProtocolRateLimiter(100, 60));
  for (const worker of ["hermes", "claude", "codex"]) {
    const nodeId = `mac-1.${worker}`, keyId = `local-owner:${nodeId}`;
    const row = (await fixture.client.query<{ payload: { platform: string; softwareFingerprint: string } }>(
      "SELECT payload FROM control_nodes WHERE id=$1", [nodeId])).rows[0];
    assert.equal(row?.payload.platform, "macos");
    const adapterId = worker === "hermes" ? HERMES_LOCAL_ADAPTER_V1
      : worker === "claude" ? CLAUDE_CODE_LOCAL_ADAPTER_V1 : CODEX_OWNER_TRUSTED_LOCAL_ADAPTER_V1;
    assert.equal(row?.payload.softwareFingerprint, sha256Digest({ purpose: "mac-local-worker-node", nodeId,
      workerId: `worker:${worker}`, adapterId }));
    const keys = await fixture.client.query("SELECT id FROM control_node_keys WHERE node_id=$1", [nodeId]);
    assert.deepEqual(keys.rows.map((key: { id: string }) => key.id), [keyId]);
    const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "node_to_server", senderKind: "node",
      tenantId: config.localOwnerSession.tenantId, actorId: nodeId, keyId,
      connectionId: `connection:local-${worker}`, sequence: 1, messageId: `message:local-${worker}`,
      correlationId: `correlation:local-${worker}`, nonce: `local_node_forged_nonce_${worker}_1234567890123456`,
      sentAt: now, expiresAt: new Date(conformanceNow + 60_000).toISOString(), type: "connection.hello",
      body: { supportedProtocols: [NODE_PROTOCOL_V1], features: ["harness.native.snapshot.v1"],
        requestedMaxFrameBytes: 16_384, lastAcknowledgedServerSequence: 0, unresolvedAttemptIds: [] } },
    generateKeyPairSync("ed25519").privateKey);
    await assert.rejects(authenticator.verify(JSON.stringify(frame), { expectedDirection: "node_to_server",
      receivedAt: now, transportIdentity: "transport:local-test" }), /unauthenticated/);
  }
  await fixture.client.query("UPDATE control_nodes SET payload=jsonb_set(payload,'{softwareFingerprint}',to_jsonb($2::text)) WHERE id=$1",
    ["mac-1.codex", "sha256:" + "f".repeat(64)]);
  await assert.rejects(seedMacLocalNodeV1(fixture.client, config, clock), /mac_local_node_conflict/);
});
