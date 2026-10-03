// mac:up's "the fleet gateway may be absent" tolerance.
//
// Two properties are load-bearing and are proved here behaviourally, not by
// reading the source:
//
//   1. Only the log bytes THIS attempt wrote may excuse the absence. The
//      gateway log is opened O_APPEND|O_CREAT and nothing ever truncates it, so
//      an earlier tolerated refusal left its marker in the file forever. The
//      pre-fix check searched the whole file, which meant one honest unsigned
//      run permanently excused every later port conflict and crash.
//
//   2. Only the missing-release refusal is tolerated. Any other reason the
//      gateway recorded must still fail the command.
//
// The default-path tests below inject NO command and no ready or stop
// function: startFleetGatewayForOwnerV1 spawns the production gateway command
// (scripts/mac-local/start-fleet-gateway.mjs), waits on the production
// fleetGatewayReady, and inspects the production log. The one test that does use
// a runtime parameter uses only startAndWait's existing liveness seam, to reach
// the same failure on a timed-out attempt.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifyGatewayLogV1, startFleetGatewayForOwnerV1 } from "../scripts/mac-local/up.mjs";
import { MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1, MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1, runtimePaths } from
  "../scripts/mac-local/stack.mjs";
import { releaseKeyIdV1 } from "../scripts/release-signing.mjs";
import { MAC_LOCAL_DATABASE_ROLES_V1, captureMacLocalDatabaseRolesV1 } from
  "../src/web/v1/mac-local-database-roles";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from
  "../src/web/v1/mac-local-protected-configuration";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";

async function writePrivate(path, value) {
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

/**
 * A disposable protected root the REAL gateway loaders accept: owned by this
 * account, owner-only throughout, with mac-local.json, database-roles.json and
 * release-trust.json. Nothing listens and no database is opened here: the real
 * gateway must refuse the missing signed connector release before any pool is
 * created, which is the one refusal the tolerance exists for.
 *
 * The values are built through the production captures, so this fixture cannot
 * drift into a shape the real loader would refuse for an unrelated reason.
 */
async function protectedRootFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "acr-gateway-tolerance-"));
  const config = join(root, "config");
  await mkdir(config, { mode: 0o700 });
  await chmod(root, 0o700);
  await chmod(config, 0o700);
  await mkdir(runtimePaths(root).runtime, { recursive: true, mode: 0o700 });
  const port = 32_100;
  const database = { host: "127.0.0.1", port: 59_780, database: "control_room",
    username: "control_room_web", password: "one-disposable-password", majorVersion: 17 };
  const role = username => ({ ...database, username });
  const roles = captureMacLocalDatabaseRolesV1({ schema: MAC_LOCAL_DATABASE_ROLES_V1, web: role("control_room_web"),
    coordinator: role("control_room_coordinator"), results: role("control_room_results"),
    publisher: role("control_room_publisher"), agentReviewer: role("control_room_agent_reviewer_login"),
    queueWorker: role("control_room_queue_worker"), fleetGateway: role("control_room_fleet"),
    fleetOwner: role("control_room_fleet_owner") });
  const macLocal = captureMacLocalProtectedConfigurationV1({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1,
    port, workspaceId: "workspace:gateway-tolerance",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: `http://127.0.0.1:${port}`,
      tenantId: "tenant:gateway-tolerance", provider: "local-owner", subject: "owner:local",
      ownerCodeDigest: `sha256:${createHash("sha256").update("one-disposable-code").digest("hex")}`,
      sessionSeconds: 28_800 },
    database, enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1",
      workers: [] } });
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicKeyValue = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  await writePrivate(join(config, "mac-local.json"), macLocal);
  await writePrivate(join(config, "database-roles.json"), roles);
  const trustPath = join(config, "release-trust.json");
  await writePrivate(trustPath, { schema: "control-room.release-trust/v1", epoch: 1,
    keyId: releaseKeyIdV1(publicKeyValue), publicKey: publicKeyValue, versionFloor: "0.0.1", revokedKeyIds: [] });
  t.after(async () => {
    // Only a pid this fixture's own attempt recorded is signalled, and only as
    // its own process group; startAndWait removes the pid file on a failed start.
    try {
      const recorded = (await readFile(runtimePaths(root).fleetGatewayPid, "utf8")).trim();
      if (/^[0-9]+$/u.test(recorded)) { try { process.kill(-Number(recorded), "SIGKILL"); } catch {} }
    } catch {}
    await rm(root, { recursive: true, force: true });
  });
  return { root, paths: runtimePaths(root), config };
}

test("the gateway log classifier separates the one tolerated refusal from every fault", () => {
  const marker = `${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}${MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1}\n`;
  assert.deepEqual(classifyGatewayLogV1(marker), { reported: 1, missingReleaseOnly: true });
  // A marker plus a later real fault is a fault: the marker must never excuse a crash.
  assert.deepEqual(classifyGatewayLogV1(`${marker}${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}listen EADDRINUSE:3212\n`),
    { reported: 2, missingReleaseOnly: false, fault: "listen EADDRINUSE:3212" });
  assert.deepEqual(classifyGatewayLogV1(`${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}TypeError: x is not a function\n`),
    { reported: 1, missingReleaseOnly: false, fault: "TypeError: x is not a function" });
  // Nothing recorded at all is a fault, not a tolerated absence: an unproven
  // refusal must never become a silently missing gateway.
  assert.deepEqual(classifyGatewayLogV1(""), { reported: 0, missingReleaseOnly: false });
  // An unrelated subsystem's line is not the gateway's own error line.
  assert.deepEqual(classifyGatewayLogV1("some other subsystem said something\n"),
    { reported: 0, missingReleaseOnly: false });
});

test("the real gateway refuses for a missing signed release, and that refusal is tolerated", async t => {
  const { root, paths } = await protectedRootFixture(t);
  const started = Date.now();
  const pid = await startFleetGatewayForOwnerV1(root, paths);
  assert.equal(pid, undefined, "the one allowed web-only state returns no gateway pid");
  assert.ok(Date.now() - started < 30_000, "the refused gateway must fail fast, not after the full wait");
  const body = await readFile(paths.fleetGatewayLog, "utf8");
  assert.ok(body.includes(`${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}${MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1}`),
    `the real gateway must have recorded its exact refusal under the declared prefix: ${JSON.stringify(body)}`);
  // The refused child is stopped and its pid file removed: a failed start must
  // never leave an orphan mac:down cannot reach.
  await assert.rejects(readFile(paths.fleetGatewayPid, "utf8"), error => error.code === "ENOENT");
});

test("a tolerated refusal in an earlier run cannot excuse this run's real fault (finding 1)", async t => {
  // The owner's exact sequence with the OLD code: mac:up before ever signing a
  // release (marker written to the never-truncated log), then a genuine gateway
  // fault. The stale marker must not carry over -- searching the whole log
  // reported "the web host runs without it" and exited 0 with no gateway.
  const { root, paths, config } = await protectedRootFixture(t);
  await writeFile(paths.fleetGatewayLog,
    `mac-local-fleet-gateway: ${MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1}\n`, { mode: 0o600 });
  const bytesBefore = (await readFile(paths.fleetGatewayLog)).length;

  // The trust file becomes group/world writable, which the real gateway's own
  // loader refuses. This is a fault, not the tolerated absence -- and it is the
  // real production refusal code, produced by the real production process.
  await chmod(join(config, "release-trust.json"), 0o666);
  await assert.rejects(startFleetGatewayForOwnerV1(root, paths), /did not start within 30s/u);

  const appended = (await readFile(paths.fleetGatewayLog)).subarray(bytesBefore).toString("utf8");
  assert.ok(appended.includes("mac_local_fleet_release_trust_refused"),
    `this attempt must have recorded the real refusal: ${JSON.stringify(appended)}`);
  assert.ok(!appended.includes(MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1),
    "the stale marker must not be inside the bytes this attempt wrote");
});

/** A real child that stays alive and never serves, so startAndWait genuinely
 * reaches its timeout. `lines` become its stderr, one per line. */
function aliveButNotServingCommand(lines) {
  return [process.execPath, "-e", [
    ...lines.map(line => `process.stderr.write(${JSON.stringify(`${line}\n`)});`),
    "setInterval(() => {}, 1000);",
  ].join("\n")];
}

test("the same-attempt fault is still classified when this attempt writes no line of its own", async t => {
  // The exact shape of the reported hazard, at the smallest size: an earlier
  // tolerated refusal already in the never-truncated log, and an attempt that
  // writes NOTHING recognisable (a child that hangs, or a gateway that dies
  // before it prints). Reading the whole file would report the stale marker and
  // report "the web host runs without it"; only the bytes this attempt wrote are
  // empty, so the command must fail.
  const { root, paths } = await protectedRootFixture(t);
  await writeFile(paths.fleetGatewayLog,
    `${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}${MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1}\n`, { mode: 0o600 });
  await assert.rejects(
    startFleetGatewayForOwnerV1(root, paths, { command: aliveButNotServingCommand([]), alive: () => true,
      fleetGatewayReady: async () => false }),
    /did not start within 30s/u,
    "a stale marker from an earlier run must not excuse an unexplained failure now");
});

test("a real fault rethrows even when the gateway is alive and never becomes ready (finding 2)", async t => {
  // startAndWait's runtime parameter (up.mjs) exists to reach the timeout path
  // without a 30-second wait. The child is a real process that stays alive and
  // never serves, so the attempt genuinely times out; its stderr is the marker
  // line followed by the real fault, both written by that one attempt.
  const { root, paths } = await protectedRootFixture(t);
  const marker = `${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}${MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1}`;
  // Exactly one role is substituted: the child. startAndWait, the log slice, the
  // classification and the throw are all the production code.
  await assert.rejects(
    startFleetGatewayForOwnerV1(root, paths, {
      command: aliveButNotServingCommand([marker, `${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}listen EADDRINUSE:3212`]),
      alive: () => true, fleetGatewayReady: async () => false }),
    /did not start within 30s/u,
  );
  const body = await readFile(paths.fleetGatewayLog, "utf8");
  assert.ok(body.includes(`${marker}\n`), "the tolerated marker really was written, in this attempt");
  assert.match(body, /listen EADDRINUSE:3212/u, "the fault was written after the marker, in the same attempt");
});

test("the tolerance still holds when the attempt times out rather than failing fast", async t => {
  // The counterpart on the allowed path: an attempt that reaches the timeout
  // having recorded ONLY the tolerated marker reports the web-only state
  // instead of failing the command.
  const { root, paths } = await protectedRootFixture(t);
  const marker = `${MAC_LOCAL_GATEWAY_ERROR_PREFIX_V1}${MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1}`;
  const pid = await startFleetGatewayForOwnerV1(root, paths, {
    command: aliveButNotServingCommand([marker]), alive: () => true, fleetGatewayReady: async () => false });
  assert.equal(pid, undefined, "only the missing-release refusal is tolerated, including on the timeout path");
});

test("a multi-byte line already in the log cannot shift the byte boundary", async t => {
  // The boundary is bytes, not characters: a prior line of multi-byte text must
  // not make the slice start inside a character and lose the marker.
  const { root, paths } = await protectedRootFixture(t);
  await writeFile(paths.fleetGatewayLog, `${"é".repeat(64)} earlier unrelated line\n`, { mode: 0o600 });
  assert.equal(await startFleetGatewayForOwnerV1(root, paths), undefined,
    "the tolerance survives a multi-byte log prefix");
});