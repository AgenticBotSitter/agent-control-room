// Real Mac-local composition proof: the connector-only website owns the owner
// routes, a separate loopback gateway owns worker routes, and only a fake
// harness is run. Run directly with:
//   PG_BIN=/path/to/postgresql-17/bin pnpm test:mac-local-fleet-postgres
// The attack kit creates, migrates and destroys its own cluster on
// CONTROL_ROOM_PG_TEST_PORT_BASE (59600 by default); no existing database,
// protected root, bot CLI or LaunchAgent is required.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Pool } from "pg";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { DatabaseClient } from "../src/persistence/database";
import { sha256Digest } from "../src/security";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { MAC_LOCAL_DATABASE_ROLES_V1, type MacLocalDatabaseRolesV1 } from "../src/web/v1/mac-local-database-roles";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1, captureMacLocalProtectedConfigurationV1 } from "../src/web/v1/mac-local-protected-configuration";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createMacLocalProtectedHostV1 } from "../src/web/v1/mac-local-host";
import { handlePrivateWebRequest } from "../src/web/v1/private-process";
import { prepareMacLocalFleetGatewayV1, prepareMacLocalFleetOwnerV1 } from "../src/fleet/v1/mac-local-composition";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres, type RealPostgres } from "./support/attack-kit/index";
import { FLEET_TENANT, FLEET_WORKSPACE, PROJECT_A, seedFleetTenant, seedProposedTask } from "./support/fleet-fixture";
import * as connector from "../scripts/fleet/connector.mjs";
import { buildSignedFleetConnectorReleaseForTestV1 } from "./support/fleet-release";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59600), PG = requiresRealPostgres();

function database(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const configuration = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  return { configuration, open() { const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(configuration), host: login.host }));
    return { client: bound.client as DatabaseClient, close: () => bound.close() }; } };
}

async function freePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); return port;
}

test("real Mac-local host plus gateway completes code, install, claim, fake run, result and owner review", async t => {
  if (!PG) { t.skip(realPostgresSkipMessage()); return; }
  await withRealPostgres(async postgres => {
    const adminLogin = postgres.admin({ database: postgres.database });
    const adminConfig = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
      username: adminLogin.user, password: adminLogin.password, majorVersion: 17 as const };
    const adminBound = bindPrivatePgPool(new Pool({ ...privatePgOptions(adminConfig), host: adminLogin.host }));
    const admin = { client: adminBound.client as DatabaseClient, close: () => adminBound.close() };
    const web = database(postgres, "web"), owner = database(postgres, "fleetOwner"), gatewayRole = database(postgres, "fleet");
    const intake = database(postgres, "control_room_work_intake_agent"), root = await mkdtemp(join(tmpdir(), "mac-fleet-pg-"));
    let host: { close(): Promise<void> } | undefined, gateway: Awaited<ReturnType<typeof prepareMacLocalFleetGatewayV1>> | undefined;
    let fleetOwner: ReturnType<typeof prepareMacLocalFleetOwnerV1> | undefined;
    try {
      await seedFleetTenant((sql, params) => admin.client.query(sql, params));
      const task = await seedProposedTask(admin.client, PROJECT_A, "mac-local-connector");
      const webPort = await freePort(), gatewayPort = await freePort(), ownerCode = "local-owner-code-for-connector-proof";
      const configuration = captureMacLocalProtectedConfigurationV1({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1,
        port: webPort, workspaceId: FLEET_WORKSPACE,
        localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: `http://127.0.0.1:${webPort}`,
          tenantId: FLEET_TENANT, provider: "test", subject: "identity:fleet-owner",
          ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 }, database: web.configuration,
        enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1",
          workers: [{ workerId: "worker:codex", kind: "codex", executablePath: "/fixture/codex", recordedVersion: "fake" }] } });
      const roleConfig = (role: string) => database(postgres, role).configuration;
      const roles: MacLocalDatabaseRolesV1 = Object.freeze({ schema: MAC_LOCAL_DATABASE_ROLES_V1, web: web.configuration,
        coordinator: roleConfig("coordinator"), results: roleConfig("results"), publisher: roleConfig("publisher"),
        // The connector-only host never opens the reviewer connection. The
        // attack kit's production application login supplies the required
        // distinct, valid connection shape without inventing a nonexistent
        // test-only role alias.
        agentReviewer: roleConfig("app"), queueWorker: roleConfig("queueWorker"),
        fleetGateway: gatewayRole.configuration, fleetOwner: owner.configuration });
      const openDatabase = (value: typeof web.configuration) => {
        const opened = value.username === web.configuration.username ? web.open()
          : value.username === owner.configuration.username ? owner.open()
            : value.username === gatewayRole.configuration.username ? gatewayRole.open()
              : value.username === intake.configuration.username ? intake.open() : (() => { throw new Error("unexpected production role"); })();
        // The Mac-local startup bridge requires the availability probe that the
        // production pool exposes and the supervisor's health monitor reads.
        return { ...opened, isAvailable: () => true };
      };
      // The connector refuses enrollment unless the gateway advertises a release
      // signed by the trust it hands out, so the production composition needs
      // one too. It lives in this test's own temp root, removed below.
      const release = await buildSignedFleetConnectorReleaseForTestV1({ root: resolve(root, "fleet"),
        builtFrom: "0".repeat(40) });
      // The installer pins a SIGNED bundle, not the source file: it re-verifies
      // the bytes it writes against the advertised sha256/size, so installing
      // `scripts/fleet/connector.mjs` directly is refused as
      // `connector_update_refused:installed_release`. This test therefore
      // installs the release it just built, exactly as the release-signing E2E
      // does, which is also the path a real machine takes.
      const bundledSource = resolve(root, "fleet", release.built.manifest.file);
      const bundledConnector = await import(pathToFileURL(bundledSource).href) as typeof connector;
      gateway = await prepareMacLocalFleetGatewayV1({ configuration, databaseRoles: roles, port: gatewayPort,
        workIntake: { database: intake.configuration, integrityKey: "k".repeat(43) } as never,
        releaseTrust: release.releaseTrust, connectorRelease: release.connectorRelease, openDatabase });
      await gateway.start();
      fleetOwner = prepareMacLocalFleetOwnerV1({ configuration, databaseRoles: roles, gatewayOrigin: gateway.origin, openDatabase });
      const protectedHost = createMacLocalProtectedHostV1({ connectorOnly: true, async loadConfiguration() { return configuration; },
        openDatabase, fleet: fleetOwner.fleet, assets: { count: 0, digest: "test", respond() { return undefined; } },
        render: request => handlePrivateWebRequest(request, () => new Response("local")),
        listenerTiming: { bindMs: 5_000, closeMs: 10_000 } });
      host = await protectedHost.start();
      const origin = configuration.localOwnerSession.origin;
      const signedIn = await fetch(`${origin}/api/v1/local-owner-session`, { method: "POST", headers: {
        origin, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ ownerCode }) });
      assert.equal(signedIn.status, 201, await signedIn.clone().text()); const cookie = signedIn.headers.get("set-cookie")!;
      const writeHeaders = { cookie, origin, "content-type": "application/json" };
      const issued = await fetch(`${origin}/api/v1/fleet/enrollment-codes`, { method: "POST", headers: writeHeaders,
        body: JSON.stringify({ displayName: "Local Codex", workerKind: "codex", projectIds: [PROJECT_A],
          capabilities: ["writing"], maxConcurrent: 1 }) });
      assert.equal(issued.status, 201, await issued.clone().text()); const enrollment = await issued.json() as { code: string };
      const commands: unknown[] = [];
      const installed = await bundledConnector.installConnector({ server: gateway.origin, code: enrollment.code, bot: "codex",
        name: "local-codex", homeDir: root, platform: "linux", env: { NODE_ENV: "test", CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1" },
        sourcePath: bundledSource,
        fetcher: fetch, runner: async (...args: unknown[]) => { commands.push(args); return { stdout: "", stderr: "" }; } } as never);
      assert.equal(commands.length, 1, "the bot CLI registration was faked exactly once");
      const localWorkers = await fetch(`${origin}/api/v1/local-workers`, { headers: { cookie } });
      assert.equal(localWorkers.status, 200);
      assert.deepEqual((await localWorkers.json() as { workers: { kind: string }[] }).workers.map(worker => worker.kind), ["codex"]);
      const offered = await fetch(`${origin}/api/v1/fleet/offers`, { method: "POST", headers: writeHeaders,
        body: JSON.stringify({ projectId: PROJECT_A, jobId: task.jobId, capability: "writing" }) });
      assert.equal(offered.status, 201, await offered.clone().text());
      // A released bundle uses the REAL reviewed harness factory, which ignores
      // `adapterModule` and drives the machine's local `codex` executable. This
      // test installs a real signed bundle, so it must therefore point the
      // codex harness at a fake CLI (tests/support/fake-codex-cli.sh) instead of
      // at a fake adapter module. That keeps the assertion meaningful: the
      // production adapter, delivery contract and result parsing all run.
      const fakeCodex = join(root, "fake-codex.sh");
      await copyFile(resolve("tests/support/fake-codex-cli.sh"), fakeCodex);
      await chmod(fakeCodex, 0o700);
      const workDir = join(root, "work");
      await mkdir(workDir, { recursive: true, mode: 0o700 });
      const harnessesPath = join(root, "fake-harnesses.json");
      await writeFile(harnessesPath, JSON.stringify({ schema: "control-room.fleet-harnesses/v1",
        adapterModule: resolve("tests/support/fleet-fake-harness-adapter.mjs"),
        harnesses: { codex: { enabled: true, deadlineMs: 30_000, executablePath: fakeCodex, workingDirectory: workDir } } }),
      { mode: 0o600 });
      const installedConnector = await import(`${pathToFileURL(installed.paths.connectorPath).href}?mac-local-pg=1`);
      const workerLog: string[] = [];
      const pass = await installedConnector.runWorker({ configPath: installed.paths.configPath, harnessesPath,
        fetcher: fetch, once: true, log: (line: unknown) => { workerLog.push(String(line)); }, progressIntervalMs: 25 });
      assert.equal(pass.outcome, "submitted", `the fake codex CLI should have completed the task; worker log: ${JSON.stringify(workerLog)}`);
      const board = await fetch(`${origin}/api/v1/fleet`, { headers: { cookie } });
      const result = (await board.json() as { results: { resultId: string; jobId: string }[] }).results[0]!;
      assert.equal(result.jobId, task.jobId);
      const reviewed = await fetch(`${origin}/api/v1/fleet/results/${result.resultId}/review`, { method: "POST",
        headers: writeHeaders, body: JSON.stringify({ decision: "accepted" }) });
      assert.equal(reviewed.status, 200, await reviewed.clone().text()); await gateway.store.reconcile();
      const state = await admin.client.query<{ state: string }>("SELECT state FROM control_jobs WHERE id=$1", [task.jobId]);
      assert.equal(state.rows[0]!.state, "succeeded");
    } finally {
      await Promise.allSettled([host?.close(), fleetOwner?.close(), gateway?.close(), admin.close()]);
      await rm(root, { recursive: true, force: true });
    }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 240_000 });
});
