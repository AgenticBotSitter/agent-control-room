import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hostReleaseIdentityV1, loadMacLocalWebHostReleaseV1, parseMacLocalWebHostArguments, startHostWithOptionalIntake,
  startMacLocalTaskHost, startMacLocalWebHost } from "../scripts/mac-local/start-web-host.mjs";
// The service host must never import bot executable inspection; it lives in
// its own module so the launcher's own module graph stays spawn-free.
import { readPinnedMacExecutableVersion, verifyPinnedMacModelPolicy }
  from "../scripts/mac-local/bot-executable-inspection.mjs";
import { startMacLocalFleetGateway } from "../scripts/mac-local/start-fleet-gateway.mjs";

async function buildReleaseInOwnedProcessGroup(t) {
  const child = spawn(process.execPath, ["scripts/build-vps.mjs"], { cwd: process.cwd(), detached: true,
    env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let finished = false, output = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { output += chunk; });
  const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  t.after(() => { if (!finished) killGroup(); });
  const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  finished = true; killGroup();
  assert.equal(status, 0, output);
}

test("Mac local web host launcher accepts only the owner-attended fixed protected root", () => {
  assert.deepEqual(parseMacLocalWebHostArguments(["--owner-attended", "--protected-root", "/Library/Application Support/Agent Control Room"]),
    { protectedRoot: "/Library/Application Support/Agent Control Room" });
  assert.deepEqual(parseMacLocalWebHostArguments(["--help"]), { help: true });
  for (const args of [[], ["--protected-root", "/tmp/x"], ["--owner-attended", "--protected-root", "relative"],
    ["--owner-attended", "--protected-root", "/tmp/x\n"]]) {
    assert.throws(() => parseMacLocalWebHostArguments(args), /mac_local_web_host_arguments_invalid/);
  }
});

test("item 9: the built web-host release loads all seven real modules before any listener can start", async t => {
  await buildReleaseInOwnedProcessGroup(t);
  const hostPath = fileURLToPath(new URL("../dist-vps/server/macLocalHost.js", import.meta.url));
  const missingPath = `${hostPath}.missing-fixture`;
  let moved = false;
  t.after(async () => { if (moved) await rename(missingPath, hostPath); });
  await rename(hostPath, missingPath); moved = true;
  await assert.rejects(loadMacLocalWebHostReleaseV1(), /Cannot find module|ERR_MODULE_NOT_FOUND/u);
  await rename(missingPath, hostPath); moved = false;

  const release = await loadMacLocalWebHostReleaseV1();
  assert.equal(typeof release.hostModule.createMacLocalProtectedHostV1, "function");
  assert.equal(typeof release.loaderModule.loadMacLocalProtectedConfigurationFromRootV1, "function");
  assert.equal(typeof release.postgresModule.createPrivatePostgresDatabase, "function");
  assert.equal(typeof release.servingModule.loadPrivateClientAssets, "function");
  assert.equal(typeof release.rendererModule.default, "function");
  assert.equal(typeof release.intakeModule.prepareWorkIntakePrivateServiceV1, "function");
  assert.equal(typeof release.fleetModule.prepareMacLocalFleetOwnerV1, "function");
  await assert.rejects(loadMacLocalWebHostReleaseV1(async path => path.endsWith("macLocalFleet.js")
    ? { prepareMacLocalFleetOwnerV1() {} } : import(path)), /mac_local_web_host_release_invalid/u);
  for (const name of ["prepareMacLocalFleetOwnerV1", "loadMacLocalFleetReleaseTrustV1", "loadMacLocalFleetConnectorReleaseV1"]) {
    const missing = { ...release.fleetModule }; delete missing[name];
    await assert.rejects(loadMacLocalWebHostReleaseV1(async path => path.endsWith("macLocalFleet.js")
      ? missing : import(path)), /mac_local_web_host_release_invalid/u);
  }
});

test("owner-attended setup reads a bounded exact executable version without shell expansion", async () => {
  const seen = [];
  const version = await readPinnedMacExecutableVersion("/usr/local/bin/example", { execFile: async (...args) => {
    seen.push(args); return { stdout: "example 1.2.3\n" };
  } });
  assert.equal(version, "example 1.2.3");
  assert.deepEqual(seen[0][0], "/usr/local/bin/example");
  assert.deepEqual(seen[0][1], ["--version"]);
  await assert.rejects(() => readPinnedMacExecutableVersion("/usr/local/bin/example", { execFile: async () => ({ stdout: "bad\nvalue" }) }),
    /mac_local_executable_version_unavailable/);
});

test("owner-attended setup validates an explicit model allowlist against the pinned CLI surface", async () => {
  const worker = { kind: "codex", executablePath: "/usr/local/bin/codex", modelPolicy: {
    models: ["gpt-build"], defaultModel: "gpt-build", efforts: ["high"], defaultEffort: "high",
  } };
  const calls = [];
  assert.equal(await verifyPinnedMacModelPolicy(worker, { execFile: async (_path, args) => {
    calls.push(args); return { stdout: args[0] === "debug" ? "gpt-build\n" : "--model\n" };
  } }), true);
  assert.deepEqual(calls, [["debug", "models"], ["exec", "--help"]]);
  assert.equal(await verifyPinnedMacModelPolicy(worker, { execFile: async (_path, args) => ({
    stdout: args[0] === "debug" ? "different-model\n" : "--model\n",
  }) }), false);
});

test("PLAN-05: installed web launcher passes the coordinator login and cleans a partial start", async () => {
  const calls = [];
  const ownerWebPush = Object.freeze({ subject: "mailto:owner@example.invalid", publicKey: "p".repeat(87),
    privateKey: "k".repeat(43) });
  const load = async path => {
    const name = path.split("/").at(-1);
    if (name === "macLocalProtectedLoader.js") return {
      async loadWorkIntakeServerConfigurationFromRootV1() { calls.push("load-intake"); return {
        port:3211,integrityKey:"y".repeat(43),database:{},credentials:[{workerId:"worker:test",workerKind:"codex"}]}; },
      async loadMacLocalProtectedConfigurationFromRootV1() { return {localOwnerSession:{tenantId:"tenant:fixture"},enablement:{workers:[{workerId:"worker:test",kind:"codex"}]}}; },
      async loadMacLocalDatabaseRolesFromRootV1() { calls.push("load-roles"); return { coordinator: { username: "control_room_coordinator" } }; },
      async loadOwnerWebPushConfigFromRootV1() { calls.push("load-owner-web-push"); return ownerWebPush; },
    };
    if (name === "macLocalHost.js") return { createMacLocalProtectedHostV1(input) {
      assert.equal(input.workBatchIntegrityKey instanceof Uint8Array, true);
      assert.equal(input.workBatchIntegrityKey.length, 32);
      assert.equal(input.ownerWebPush, ownerWebPush);
      assert.ok(input.fleet);
      calls.push("prepare-web"); return {
      async start() { calls.push("start-web"); return { async close() { calls.push("close-web"); } }; },
    }; } };
    if (name === "workIntakePrivateService.js") return { async prepareWorkIntakePrivateServiceV1(input) {
      assert.deepEqual(input.recurring, { tenantId: "tenant:fixture", database: { username: "control_room_coordinator" } });
      calls.push("prepare-intake"); return { async start() { calls.push("start-intake"); throw new Error("fixture"); },
        async close() { calls.push("close-intake"); } };
    } };
    if (name === "macLocalFleet.js") return { async loadMacLocalFleetReleaseTrustV1() { return {}; },
      async loadMacLocalFleetConnectorReleaseV1() { return undefined; },
      prepareMacLocalFleetOwnerV1() { return { fleet: { ownerAuthority: {} }, async close() { calls.push("close-fleet"); } }; } };
    if (name === "privatePostgres.js") return { createPrivatePostgresDatabase() {} };
    if (name === "serving.js") return { async loadPrivateClientAssets() { return {}; } };
    if (name === "index.js") return { default() {} };
    throw new Error(`unexpected ${name}`);
  };
  await assert.rejects(startMacLocalWebHost({ protectedRoot: "/protected" }, {
    load, loadHealthProbeKey: async () => Buffer.alloc(32, 7), hostReleaseIdentity: async () => "dev",
  }), /fixture/);
  assert.deepEqual(calls, ["load-intake", "load-owner-web-push", "load-roles", "prepare-web", "prepare-intake", "start-web", "start-intake",
    "close-intake", "close-web", "close-fleet"]);
});

test("optional intake preserves the web host readiness signal", async () => {
  let ready = true, intakeReady = true, intakeStarts = 0, closes = 0;
  const result = await startHostWithOptionalIntake({ async start() { return {
    isReady: () => ready, async close() { closes += 1; },
  }; } }, { integrityKey: "y".repeat(43) }, { async prepareWorkIntakePrivateServiceV1() { return {
    isReady: () => intakeReady, async start() { intakeStarts += 1; }, async close() { closes += 1; },
  }; } });
  assert.equal(intakeStarts, 1); assert.equal(result.isReady(), true);
  intakeReady = false; assert.equal(result.isReady(), false, "an unavailable recurring coordinator must fail host readiness");
  intakeReady = true; ready = false;
  assert.equal(result.isReady(), false, "the task-host monitor must see database-backed web readiness through intake");
  await result.close(); assert.equal(closes, 2);
});

test("task host is connector-only and loads neither a task provider nor a native queue worker", async () => {
  const loaded = [];
  const task = { async close() {}, isReady: () => true };
  const result = await startMacLocalTaskHost({ protectedRoot: "/protected" }, {
    readVersion: async () => assert.fail("connector-only host must not inspect a bot CLI"),
    loadHealthProbeKey: async () => Buffer.alloc(32, 7), hostReleaseIdentity: async () => "dev",
    load: async path => {
      loaded.push(path.split("/").at(-1));
      if (path.endsWith("macLocalHost.js")) return { createMacLocalProtectedHostV1: input => ({
        async start() {
          assert.equal(input.connectorOnly, true);
          assert.equal(input.createTaskApplication, undefined);
          assert.equal(input.startQueueWorker, undefined);
          assert.equal(input.readVersion, undefined);
          assert.ok(input.fleet);
          // cl-bringup N-M: without the pid the tagged health route answers 404 and
          // the installer's health check refuses the install.
          assert.equal(input.hostProcessId, process.pid);
          assert.equal(input.healthReleaseId, "dev");
          assert.equal(input.healthProbeKey.length, 32);
          return task;
        },
      }) };
      if (path.endsWith("macLocalProtectedLoader.js")) return {
        loadMacLocalProtectedConfigurationFromRootV1: async () => ({ localOwnerSession: { tenantId: "tenant:fixture" },
          workspaceId: "workspace:fixture",enablement:{workers:[]} }),
        loadWorkIntakeServerConfigurationFromRootV1: async()=>undefined,
        loadMacLocalDatabaseRolesFromRootV1: async()=>({}),
        loadOwnerWebPushConfigFromRootV1: async()=>undefined,
      };
      if (path.endsWith("privatePostgres.js")) return { createPrivatePostgresDatabase: () => ({
        client: { query: async () => ({ rows: [{ id: "project:fixture" }] }) }, async close() {},
      }) };
      if (path.endsWith("serving.js")) return { loadPrivateClientAssets: async () => ({ respond() {} }) };
      if (path.endsWith("index.js")) return { default() {} };
      if(path.endsWith("workIntakePrivateService.js"))return{prepareWorkIntakePrivateServiceV1(){}};
      if(path.endsWith("macLocalFleet.js"))return{loadMacLocalFleetReleaseTrustV1:async()=>({}),loadMacLocalFleetConnectorReleaseV1:async()=>undefined,
        prepareMacLocalFleetOwnerV1:()=>({fleet:{ownerAuthority:{}},async close(){}})};
      throw new Error(`unexpected ${path}`);
    },
  });
  assert.equal(result.isReady(), true);
  assert.deepEqual(loaded.sort(), ["index.js", "macLocalHost.js", "macLocalProtectedLoader.js",
    "privatePostgres.js", "serving.js", "workIntakePrivateService.js", "macLocalFleet.js"].sort());
});

test("a zero-project connector-only start remains website/intake-only", async () => {
  const loaded = [];
  const site = { async close() {}, isReady: () => true };
  const result = await startMacLocalTaskHost({ protectedRoot: "/protected" }, { loadHealthProbeKey: async () => Buffer.alloc(32, 7),
    hostReleaseIdentity: async () => "dev", load: async path => {
    const name = path.split("/").at(-1); loaded.push(name);
    if (name === "macLocalProtectedLoader.js") return {
      loadMacLocalProtectedConfigurationFromRootV1: async () => ({enablement:{workers:[]}}),
      loadWorkIntakeServerConfigurationFromRootV1:async()=>undefined,
      loadMacLocalDatabaseRolesFromRootV1:async()=>({}),
      loadOwnerWebPushConfigFromRootV1:async()=>undefined,
    };
    if (name === "privatePostgres.js") return { createPrivatePostgresDatabase: () => ({}) };
    if (name === "macLocalHost.js") return { createMacLocalProtectedHostV1: input => ({ async start() {
      assert.equal(input.connectorOnly, true); return site;
    } }) };
    if (name === "serving.js") return { loadPrivateClientAssets: async () => ({ respond() {} }) };
    if (name === "index.js") return { default() {} };
    if(name==="workIntakePrivateService.js")return{prepareWorkIntakePrivateServiceV1(){}};
    if(name==="macLocalFleet.js")return{loadMacLocalFleetReleaseTrustV1:async()=>({}),loadMacLocalFleetConnectorReleaseV1:async()=>undefined,
      prepareMacLocalFleetOwnerV1:()=>({fleet:{ownerAuthority:{}},async close(){}})};
    throw new Error(`unexpected ${name}`);
  } });
  assert.equal(result.isReady(), true);
  assert.equal(loaded.includes("macLocalTaskProvider.js"), false);
  assert.equal(loaded.includes("nativeQueueFactories.js"), false);
});

test("the Mac fleet gateway launcher composes one separate loopback service from protected roles", async () => {
  const loaded = [], calls = [], service = { origin: "http://127.0.0.1:3212", async start() { calls.push("start"); },
    async close() { calls.push("close"); } };
  const active = await startMacLocalFleetGateway({ protectedRoot: "/protected" }, { load: async path => {
    const name = path.split("/").at(-1); loaded.push(name);
    if (name === "macLocalProtectedLoader.js") return {
      loadMacLocalProtectedConfigurationFromRootV1: async () => ({ localOwnerSession: { tenantId: "tenant:test" } }),
      loadMacLocalDatabaseRolesFromRootV1: async () => ({ fleetGateway: {}, fleetOwner: {} }),
      loadWorkIntakeServerConfigurationFromRootV1: async () => ({ integrityKey: "k".repeat(43) }),
    };
    if (name === "privatePostgres.js") return { createPrivatePostgresDatabase() {} };
    if (name === "macLocalFleet.js") return {
      loadMacLocalFleetReleaseTrustV1: async () => ({ keyId: "test" }),
      loadMacLocalFleetConnectorReleaseV1: async () => ({ manifest: {} }),
      async prepareMacLocalFleetGatewayV1(input) {
        assert.equal(input.configuration.localOwnerSession.tenantId, "tenant:test");
        assert.ok(input.databaseRoles.fleetGateway); assert.ok(input.connectorRelease); assert.equal(input.releaseTrust.keyId, "test"); return service;
      },
    };
    throw new Error(`unexpected ${name}`);
  } });
  assert.equal(active, service);
  assert.deepEqual(calls, ["start"]);
  assert.deepEqual(loaded.sort(), ["macLocalFleet.js", "macLocalProtectedLoader.js", "privatePostgres.js"].sort());
  await active.close();
  assert.deepEqual(calls, ["start", "close"]);
});

test("an attended release reports <version>-<commit12> from its own sealed manifest (cl-bringup N-G)", async t => {
  const root = await mkdtemp(join(tmpdir(), "cr-release-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const server = join(root, "dist-vps", "server");
  await mkdir(server, { recursive: true });
  assert.equal(await hostReleaseIdentityV1(server), "dev", "a checkout has no sealed record");
  const manifest = { schema: "control-room.attended-build-manifest/v1", commit: "0123456789abcdef".repeat(2) + "01234567",
    version: "0.1.0", fileCount: 1, byteCount: 1, files: [] };
  await writeFile(join(root, "RELEASE_MANIFEST.json"), JSON.stringify(manifest));
  // The SAME id `buildReleaseV1` derives and the installer stages as `releases/<id>`.
  assert.equal(await hostReleaseIdentityV1(server), "0.1.0-0123456789ab");
  for (const bad of [{ ...manifest, schema: "other" }, { ...manifest, commit: "nothex" }, { ...manifest, version: "../x" }]) {
    await writeFile(join(root, "RELEASE_MANIFEST.json"), JSON.stringify(bad));
    assert.equal(await hostReleaseIdentityV1(server), "dev");
  }
  assert.equal(await hostReleaseIdentityV1(join(root, "missing")), "dev");
});
