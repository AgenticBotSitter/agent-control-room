import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureProvisionedMacLocalConfigurationV1, prepareProvisionedWorkIntakeConfigurationV1,
  ensureHealthProbeKeyV1, renewRetainedWorkIntakeCredentialsV1, selectProvisionedWorkIntakeClientV1 } from
  "../scripts/mac-local/provision-database.mjs";
import { captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration.ts";

test("the provisioner dry-run's prospective protected config survives the file JSON round trip", () => {
  const prospective = captureProvisionedMacLocalConfigurationV1({
    database: { host: "127.0.0.1", port: 15432, database: "control_room",
      username: "control_room_web", password: "test-password-not-a-secret", majorVersion: 17 },
    ownerCode: "test-owner-code-not-a-secret",
    workIntakeProjectIds: ["project:one"],
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
  assert.deepEqual(loaded.workIntakeProjectIds, ["project:one"]);
  assert.match(loaded.enablement.enablementDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal("enablementDigest" in JSON.parse(writtenFileContents), false);
});

test("provisioning creates one private independent health-probe key and preserves it on retry", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-health-probe-")); t.after(() => rm(root, { recursive: true, force: true }));
  await ensureHealthProbeKeyV1(root);
  const path = join(root, "service", "health-probe.key"), first = await readFile(path, "utf8"), entry = await stat(path);
  assert.match(first, /^[A-Za-z0-9_-]{43}\n$/u);
  assert.equal(entry.mode & 0o777, 0o600);
  await ensureHealthProbeKeyV1(root);
  assert.equal(await readFile(path, "utf8"), first, "retry must retain the installed probe identity");
});

test("the protected intake scope defaults closed and rejects ambiguous wildcard combinations", () => {
  const base = { database: { host: "127.0.0.1", port: 15432, database: "control_room",
    username: "control_room_web", password: "test-password-not-a-secret", majorVersion: 17 },
  ownerCode: "test-owner-code-not-a-secret", workers: [
    { workerId: "worker:codex:mac-1", kind: "codex", executablePath: "/opt/example/codex", recordedVersion: "codex 1.2.3" },
    { workerId: "worker:claude:mac-1", kind: "claude-code", executablePath: "/opt/example/claude", recordedVersion: "claude 1.2.3" },
    { workerId: "worker:hermes:mac-1", kind: "hermes", executablePath: "/opt/example/hermes", recordedVersion: "hermes 1.2.3" },
  ] };
  assert.deepEqual(captureProvisionedMacLocalConfigurationV1(base).workIntakeProjectIds, []);
  assert.throws(() => captureProvisionedMacLocalConfigurationV1({ ...base,
    workIntakeProjectIds: ["*", "project:one"] }), /mac_local_protected_configuration_invalid/u);
});

test("provisioner prepares one protected client-and-server intake record without starting anything", () => {
  const record = prepareProvisionedWorkIntakeConfigurationV1({ database: { host: "127.0.0.1", port: 15432,
    database: "control_room", username: "control_room_work_intake_agent", password: "fixture", majorVersion: 17 },
  integrityKey: "b".repeat(43), credentials:[{workerId:"worker:codex:mac-1",workerKind:"codex",
    credentialDigest:`sha256:${"a".repeat(64)}`,principal:{tenantId:"tenant:mac-local",identityId:"identity:test",
      actorType:"agent",authenticatedAt:"2026-09-27T12:00:00.000Z",expiresAt:"2026-10-27T12:00:00.000Z"}}] });
  assert.equal(record.port, 3211);
  assert.equal(record.database.username, "control_room_work_intake_agent");
  assert.equal(record.queueDepthLimit, 10);
  assert.equal(record.credentials[0].principal.expiresAt, "2026-10-27T12:00:00.000Z");
  assert.equal(Object.keys(record).sort().join(","),
    "credentials,database,integrityKey,port,queueDepthLimit,schema");
});

test("the installed CLI receives exactly the explicitly selected registered agent credential", () => {
  const clients=["codex","claude-code","hermes"].map(kind=>({worker:{kind},client:{
    schema:"control-room.work-intake-client/v1",origin:"http://127.0.0.1:3211",
    bearerSecret:(kind==="codex"?"a":kind==="claude-code"?"b":"c").repeat(43)}}));
  assert.equal(selectProvisionedWorkIntakeClientV1(clients,"claude-code").bearerSecret,"b".repeat(43));
  assert.throws(()=>selectProvisionedWorkIntakeClientV1(clients,"unknown"),/provision_work_intake_cli_worker_refused/u);
});

test("owner-authorized reprovisioning renews retained credentials without rotating their bearer", () => {
  const existing=prepareProvisionedWorkIntakeConfigurationV1({ database: { host: "127.0.0.1", port: 15432,
    database: "control_room", username: "control_room_work_intake_agent", password: "fixture", majorVersion: 17 },
  integrityKey: "b".repeat(43), credentials:[{workerId:"worker:codex:mac-1",workerKind:"codex",
    credentialDigest:`sha256:${"a".repeat(64)}`,principal:{tenantId:"tenant:mac-local",identityId:"identity:test",
      actorType:"agent",authenticatedAt:"2026-08-01T00:00:00.000Z",expiresAt:"2026-08-31T00:00:00.000Z"}}] });
  const prospective=[{...existing.credentials[0],principal:{...existing.credentials[0].principal,
    authenticatedAt:"2026-09-27T12:00:00.000Z",expiresAt:"2026-10-27T12:00:00.000Z"}}];
  const renewed=renewRetainedWorkIntakeCredentialsV1(existing,prospective,"2026-09-27T12:00:00.000Z");
  assert.equal(renewed[0].credentialDigest,existing.credentials[0].credentialDigest);
  assert.equal(renewed[0].principal.authenticatedAt,"2026-09-27T12:00:00.000Z");
  assert.equal(renewed[0].principal.expiresAt,"2026-10-27T12:00:00.000Z");
  assert.throws(()=>renewRetainedWorkIntakeCredentialsV1(existing,[{...prospective[0],
    credentialDigest:`sha256:${"c".repeat(64)}`}],"2026-09-27T12:00:00.000Z"),/work_intake_roster_drift_refused/u);
  assert.throws(()=>renewRetainedWorkIntakeCredentialsV1(existing,[{...prospective[0],principal:{
    ...prospective[0].principal,identityId:"identity:wrong"}}],"2026-09-27T12:00:00.000Z"),
  /work_intake_roster_drift_refused/u);
});
