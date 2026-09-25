import assert from "node:assert/strict";
import test, { after } from "node:test";
import { bootstrapMacLocalOwnerV1, seedMacLocalNodeV1 } from "../src/web/v1/mac-local-owner-bootstrap";
import { DatabaseNodeKeyResolver } from "../src/node-protocol/v1/persistence";
import { captureOwnerTrustedLocalEnablementV1, OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { createPrivateOwnerBootstrapCommand } from "../src/web/v1/private-owner-bootstrap";
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

test("bootstraps a local node once without a remote authentication key", async t => {
  const fixture = await privateOwnerBootstrapFixture({ fresh: "mac-node-a" }); t.after(fixture.close);
  const enablement = captureOwnerTrustedLocalEnablementV1({ schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1,
    mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:local", kind: "codex",
      executablePath: "/private/tmp/fixture-codex", recordedVersion: "fixture-version" }] });
  const config = { ...local("tenant:mac-node-a", "workspace:mac-node-a"), enablement };
  await bootstrapMacLocalOwnerV1(fixture.client, config, clock);
  assert.equal(await seedMacLocalNodeV1(fixture.client, config, clock), "created");
  assert.equal(await seedMacLocalNodeV1(fixture.client, config, clock), "already_present");
  const row = (await fixture.client.query<{ payload: { platform: string; softwareFingerprint: string } }>(
    "SELECT payload FROM control_nodes WHERE id=$1", ["mac-1"])).rows[0];
  assert.equal(row?.payload.platform, "macos");
  assert.equal(row?.payload.softwareFingerprint, enablement.enablementDigest);
  const keys = await fixture.client.query("SELECT id FROM control_node_keys WHERE node_id=$1", ["mac-1"]);
  assert.equal(keys.rows.length, 0);
  // The remote frame authenticator cannot resolve a public key for this local-only node.
  const remoteKey = await new DatabaseNodeKeyResolver(fixture.client).resolve({ tenantId: config.localOwnerSession.tenantId,
    actorId: "mac-1", senderKind: "node", keyId: "local-owner:mac-1" });
  assert.equal(remoteKey, undefined);
  await fixture.client.query("UPDATE control_nodes SET payload=jsonb_set(payload,'{softwareFingerprint}',to_jsonb($2::text)) WHERE id=$1",
    ["mac-1", "sha256:" + "f".repeat(64)]);
  await assert.rejects(seedMacLocalNodeV1(fixture.client, config, clock), /mac_local_node_conflict/);
});
