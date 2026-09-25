import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { macLocalRouteFromTailscaleStatusV1, parseRepointArgumentsV1, provisionMacLocalDatabaseV1 } from "../scripts/mac-local/provision-database.mjs";
import { sha256Digest } from "../src/security/canonical-digest.ts";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration.ts";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session.ts";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements.ts";
import { MAC_LOCAL_DATABASE_ROLES_V1 } from "../src/web/v1/mac-local-database-roles.ts";
import { runtimePaths } from "../scripts/mac-local/stack.mjs";
import { missingTaskRuntimeInstruction } from "../scripts/mac-local/up.mjs";

const roleNames = { web: "control_room_web", coordinator: "control_room_coordinator",
  results: "control_room_results", queueWorker: "control_room_queue_worker" };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-repoint-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  const config = join(root, "config");
  await mkdir(config, { mode: 0o700 });
  const originalDb = { host: "127.0.0.1", port: 15432, database: "control_room", username: roleNames.web,
    password: "web-password-keep-this", majorVersion: 17 };
  const originalRoles = Object.fromEntries(Object.entries(roleNames).map(([key, username]) => [key, {
    ...originalDb, username, password: `${key}-password-keep-this` }]));
  const mac = { schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
      provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode: "synthetic-owner-code" }), sessionSeconds: 28_800 },
    database: originalDb,
    enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [
      { workerId: "worker:hermes:mac-1", kind: "hermes", executablePath: "/opt/bin/hermes", recordedVersion: "1.0.0" }] } };
  const macPath = join(config, "mac-local.json"), rolesPath = join(config, "database-roles.json");
  await writeFile(macPath, `${JSON.stringify(mac)}\n`, { mode: 0o600 });
  await writeFile(rolesPath, `${JSON.stringify({ schema: MAC_LOCAL_DATABASE_ROLES_V1, ...originalRoles })}\n`, { mode: 0o600 });
  const status = { Self: { Tags: ["tag:general", "tag:control-room-client"] }, Peer: { server: {
    Online: true, Tags: ["tag:control-room-vps"], TailscaleIPs: ["100.100.2.3"], DNSName: "database.example.invalid." } } };
  const route = macLocalRouteFromTailscaleStatusV1(status,
    "## VPS evidence (synthetic)\n\nTLS, SCRAM and loopback checks passed.\n\n## Live acceptance\n");
  return { root, config, route, macPath, rolesPath, mac, originalRoles, status };
}

test("repoint-only changes only route fields and preserves all role passwords without SSH inputs", async t => {
  const f = await fixture(t);
  const beforeMac = JSON.parse(await readFile(f.macPath, "utf8"));
  const beforeRoles = JSON.parse(await readFile(f.rolesPath, "utf8"));
  const result = await provisionMacLocalDatabaseV1({ repointOnly: true, protectedRoot: f.root, route: f.route });
  assert.deepEqual(result, { repointed: true });
  const afterMac = JSON.parse(await readFile(f.macPath, "utf8"));
  const afterRoles = JSON.parse(await readFile(f.rolesPath, "utf8"));
  assert.equal(afterMac.database.host, "100.100.2.3");
  assert.equal(afterMac.database.port, 5432);
  assert.equal(afterMac.database.privateEndpoint.schema, "control-room.private-postgres-endpoint/v2");
  assert.equal(afterMac.database.privateEndpoint.serverIdentity.serverName, "database.example.invalid");
  assert.equal(afterMac.database.password, beforeMac.database.password);
  const restoredMac = structuredClone(afterMac); restoredMac.database.host = beforeMac.database.host;
  restoredMac.database.port = beforeMac.database.port; delete restoredMac.database.privateEndpoint;
  assert.deepEqual(restoredMac, beforeMac);
  assert.equal(afterRoles.schema, beforeRoles.schema);
  for (const key of Object.keys(roleNames)) {
    assert.equal(afterRoles[key].host, "100.100.2.3");
    assert.equal(afterRoles[key].port, 5432);
    assert.equal(afterRoles[key].privateEndpoint.serverIdentity.serverName, "database.example.invalid");
    assert.equal(afterRoles[key].password, beforeRoles[key].password);
    const restoredRole = structuredClone(afterRoles[key]); restoredRole.host = beforeRoles[key].host;
    restoredRole.port = beforeRoles[key].port; delete restoredRole.privateEndpoint;
    assert.deepEqual(restoredRole, beforeRoles[key]);
  }
});

test("repoint-only rejects loopback, non-Tailscale IPs, wrong ports, and extra fields without changing config", async t => {
  for (const overrides of [{ host: "127.0.0.1" }, { host: "192.0.2.8" }, { port: 15432 }, { schema: "v1" }]) {
    const f = await fixture(t);
    const beforeMac = await readFile(f.macPath, "utf8"), beforeRoles = await readFile(f.rolesPath, "utf8");
    await assert.rejects(provisionMacLocalDatabaseV1({ repointOnly: true, protectedRoot: f.root, route: { ...f.route, ...overrides } }));
    assert.equal(await readFile(f.macPath, "utf8"), beforeMac);
    assert.equal(await readFile(f.rolesPath, "utf8"), beforeRoles);
  }
});

test("route discovery requires the tagged Mac and one online tagged VPS", async t => {
  const evidence = "## VPS evidence (synthetic)\nchecked\n## Live acceptance\n";
  const f = await fixture(t);
  assert.throws(() => macLocalRouteFromTailscaleStatusV1({ ...f.status, Self: { Tags: ["tag:general"] } }, evidence), /client_tag_missing/u);
  assert.throws(() => macLocalRouteFromTailscaleStatusV1({ Self: { Tags: ["tag:general", "tag:control-room-client"] }, Peer: {} }, evidence), /vps_peer_refused/u);
  assert.throws(() => macLocalRouteFromTailscaleStatusV1({ Self: { Tags: ["tag:general", "tag:control-room-client"] }, Peer: {
    a: { Online: true, Tags: ["tag:control-room-vps"], TailscaleIPs: ["100.100.2.3"], DNSName: "db.example.invalid" },
    b: { Online: true, Tags: ["tag:control-room-vps"], TailscaleIPs: ["100.100.2.4"], DNSName: "db2.example.invalid" } } }, evidence), /vps_peer_refused/u);
});

test("repoint CLI accepts the package-manager separator and refuses extra arguments", () => {
  assert.equal(parseRepointArgumentsV1(["--", "--repoint-only", "--protected-root", "/protected"]), "/protected");
  assert.equal(parseRepointArgumentsV1(["--repoint-only", "--protected-root", "/protected"]), "/protected");
  for (const args of [
    ["--", "--repoint-only", "--protected-root", "/protected", "extra"],
    ["--", "--repoint-only", "--protected-root", "/protected", "--ssh-target", "host"],
    ["--", "--repoint-only", "--protected-root", "/protected", "--"],
    ["--", "--repoint-only", "--protected-root"],
  ]) assert.throws(() => parseRepointArgumentsV1(args), /arguments_refused/u);
});

test("mac:up and mac:down runtime state no longer includes a local database tunnel", () => {
  assert.deepEqual(Object.keys(runtimePaths("/protected")).sort(), ["hostLog", "hostPid", "provider", "runtime"]);
});

test("mac:up reports the exact one-time Hermes settings command without embedding secrets", () => {
  assert.equal(missingTaskRuntimeInstruction("/private/Control Room"),
    'task settings missing: run pnpm mac:prepare-task-runtime -- --protected-root "/private/Control Room" --hermes-profile cr --hermes-provider opencode-go --hermes-model space-bunny-free --hermes-destination https://opencode.ai:443');
});
