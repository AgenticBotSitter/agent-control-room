import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskHost } from "../dist-vps/server/taskHost.js";
import { EventEmitter } from "node:events";
import { finished } from "node:stream/promises";
import { nodeExchange } from "./helpers/web-node.ts";
import { installPrivateApplication } from "../dist-vps/server/runtime.js";
import { NATIVE_DELIVERY_FEATURE } from "../src/harness/v1/native-delivery.ts";
import { nativeTaskSnapshotBodySchema } from "../src/harness/v1/native-observation.ts";
import { decodeNativeWire, encodeNativeWire } from "../src/harness/v1/native-wire.ts";
import { PortableNodeBridge, SqliteBridgeJournal } from "../src/node-bridge/index.ts";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame } from "../src/node-protocol/v1/index.ts";
import { sha256Digest } from "../src/security/index.ts";
import { nativeTaskLifecycleFixture } from "./helpers/native-task-lifecycle.ts";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { request } from "./helpers/web-foundation.ts";

function restrictedPool(startup, login) {
  let closes = 0, available = true;
  const client = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
      const session = { async query(sql, params) {
        const value = await tx.query(sql, params);
        if (sql.includes("AS database_temp")) value.rows = value.rows.map(row => ({ ...row, database_temp: false }));
        return value;
      } };
      return work(session);
    }, check),
  };
  return { client, close: async () => { closes++; available = false; }, isAvailable: () => available,
    closes: () => closes, quarantine: () => { available = false; } };
}

async function installRestrictedPools(startup) {
  for (const role of ["native_results_roles.sql", "native_evidence_roles.sql", "native_session_roles.sql"])
    await startup.raw.exec(readFileSync(`db/roles/${role}`, "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE session_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test; GRANT control_room_native_evidence TO evidence_test;
    GRANT control_room_native_sessions TO session_test`);
  return { result: restrictedPool(startup, "result_test"), evidence: restrictedPool(startup, "evidence_test"),
    sessions: restrictedPool(startup, "session_test") };
}

for (const mode of ["progress", "recover"]) test(`compiled five-role startup owns a signed session and refuses ${mode} without complete matching historical proof`, async t => {
  const x = await nativeTaskLifecycleFixture(); t.after(x.close);
  assert.equal((await x.f.db.query("SELECT 1 AS present FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [x.registration.tenantId, x.registration.id])).rows.length, 0);
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  const { result, evidence, sessions } = await installRestrictedPools(startup);
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const evidenceDatabase = { ...startup.config.coordinator.database, username: "evidence_test" };
  const sessionDatabase = { ...startup.config.coordinator.database, username: "session_test" };
  const serverKeys = generateKeyPairSync("ed25519");
  const serverPublicKeySpki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const node = { tenantId: x.registration.tenantId, nodeId: x.registration.nodeId, nodeKeyId: "key:test",
    serverId: "server:managed", serverKeyId: "key:server:managed", serverPublicKeySpki,
    transportIdentity: "transport:managed", features: [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 };
  const evidenceSettings = { database: evidenceDatabase, integrityKey: new Uint8Array(32).fill(75),
    storage: { ...x.f.config, integrityKey: Uint8Array.from(x.f.config.integrityKey) },
    enrollments: [{ ...x.f.prepared.enrollment }] };
  const sessionSettings = { database: sessionDatabase, nodes: [{ ...node }],
    sign: async frame => signNodeFrame(frame, serverKeys.privateKey) };
  const profile = x.f.profile;
  const scenario = { scenarioId: "scenario:content", acceptanceProfileId: profile.id,
    acceptanceProfileDigest: sha256Digest(profile), rules: { version: "document-structure/v1",
      minUtf8Bytes: 20, maxUtf8Bytes: 4096, requiredHeadings: ["Result", "Evidence"], forbiddenTerms: [] } };
  const opened = [], preflights = [], writes = [], proofReads = [];
  const openDatabase = config => {
    opened.push(config.username);
    const pool = config.username === "web_test" ? startup.web
      : config.username === "coordinator_test" ? startup.coordinator
      : config.username === "result_test" ? result
      : config.username === "evidence_test" ? evidence
      : config.username === "session_test" ? sessions
      : (() => { throw new Error("unexpected_test_database"); })();
    const db = pool.client;
    const observe = work => async tx => work({ async query(sql, params) {
      const value = await tx.query(sql, params);
      if (sql.includes("FROM control_native_delivery_envelopes"))
        proofReads.push((await tx.query("SELECT current_user,session_user")).rows[0]);
      if (sql.includes("AS database_temp"))
        preflights.push((await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0]);
      const match = /INSERT INTO (control_[a-z_]+|node_protocol_[a-z_]+)/.exec(sql);
      if (match) {
        const identity = (await tx.query("SELECT current_user,session_user,rolsuper FROM pg_roles WHERE rolname=current_user")).rows[0];
        writes.push({ table: match[1], ...identity });
      }
      return value;
    } });
    return { ...pool, client: { ...db, transaction: work => db.transaction(observe(work)),
      transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(observe(work), check) } };
  };
  const certificate = Buffer.from("synthetic compiled machine certificate bytes");
  const certificateDigest = `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
  const nativeHttp = mode === "progress" ? { origin: "https://machine.example.test",
    peers: [{ nodeId: x.registration.nodeId, certificateDigest, task: { projectId: x.registration.projectId,
      jobId: x.registration.jobId, attemptId: x.registration.attemptId,
      inputDigest: x.registration.nativeTask.inputDigest } }], isPeerCurrent: () => true } : undefined;
  const machineSocket = { encrypted: true, authorized: true, destroyed: false,
    getPeerCertificate: () => ({ raw: certificate }) };
  const machineRequest = command => {
    const body = JSON.stringify(command);
    return new Request("https://machine.example.test/v1/control-room/native", { method: "POST", body,
      headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } });
  };
  let installed;
  const servers = [];
  const fakeServer = () => {
    const server = new EventEmitter(); server.binds = 0; server.closes = 0;
    server.listen = (options, callback) => { server.binds++; server.boundHost = options.host; queueMicrotask(callback); return server; };
    server.close = callback => { server.closes++; queueMicrotask(() => callback?.()); return server; };
    server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
    servers.push(server); return server;
  };
  let machineServer;
  const starting = createPrivateTaskHost({ clock: x.f.clock, openDatabase, createServer: fakeServer,
    createNativeServer: () => { machineServer = fakeServer(); return machineServer; },
    install: value => {
      assert.equal(preflights.length, 5);
      installed = value;
      // The process installation is deliberately one-shot. The second case tests
      // the compiled supplied-resource factory, not a second process installation.
      if (mode === "progress") installPrivateApplication(value);
    } }).start({ port: 3210, handler, assets: { count: 0, digest: "synthetic-no-assets", respond: () => undefined },
    ...(mode === "progress" ? { nativeHttps: { host: "100.64.0.1", port: 443,
      key: new Uint8Array([1]), cert: new Uint8Array([2]), ca: new Uint8Array([3]) } } : {}),
    configuration: { ...startup.config, coordinator: { ...startup.config.coordinator,
      approvals: { enrollments: [{ enrollment: x.f.prepared.enrollment, nodeClass: "personal-compute" }], store: x.f.store },
      quality: { ...x.f.ownerConfig, scenarios: [scenario] }, resultDatabase,
      evidence: evidenceSettings, sessions: sessionSettings, nativeHttp } },
  });
  // All caller-owned settings are captured before startup's first asynchronous preflight.
  sessionSettings.database.username = "mutated_session_login"; sessionSettings.nodes[0].nodeId = "node:mutated";
  sessionSettings.sign = async () => { throw new Error("mutated_sign"); };
  evidenceSettings.enrollments[0].nodeId = "node:mutated";
  const runtime = await starting; t.after(() => runtime.close());
  assert.equal(servers.length, mode === "progress" ? 2 : 1);
  assert.ok(servers.every(server => server.binds === 1));
  assert.equal(servers.at(-1).boundHost, "127.0.0.1");
  async function machineExchange(command) {
    const req = machineRequest(command);
    const stream = nodeExchange({ path: new URL(req.url).pathname, method: "POST", body: await req.text() });
    stream.input.rawHeaders = ["Host", "machine.example.test:443", ...[...req.headers].flat(),
      "Accept-Encoding", "identity", "Connection", "close"];
    // The native client uses a new TLS connection per exchange, never socket reuse.
    stream.input.socket = { ...machineSocket };
    const completed = finished(stream.output); machineServer.emit("request", stream.input, stream.output); await completed;
    return new Response(stream.body(), { status: stream.output.statusCode });
  }
  assert.equal(runtime.isReady(), true); assert.ok(runtime.connections); assert.ok(runtime.evidence);
  assert.equal(typeof runtime.connections.attachWire, "function");
  assert.deepEqual(opened, ["web_test", "coordinator_test", "result_test", "evidence_test", "session_test"]);
  assert.deepEqual(preflights, [
    { current_user: "web_test", session_user: "web_test", rolsuper: false },
    { current_user: "coordinator_test", session_user: "coordinator_test", rolsuper: false },
    { current_user: "result_test", session_user: "result_test", rolsuper: false },
    { current_user: "evidence_test", session_user: "evidence_test", rolsuper: false },
    { current_user: "session_test", session_user: "session_test", rolsuper: false },
  ]);
  assert.deepEqual(Object.keys(runtime).sort(), ["close", "connections", "evidence", "isReady",
    ...(mode === "progress" ? ["nativeHttp"] : []), "quality", "results"]);
  if (mode === "progress") {
    assert.ok(runtime.nativeHttp); assert.equal(runtime.nativeHttp, installed.nativeHttp);
    assert.equal(typeof runtime.nativeHttp.handleNode, "function");
  } else {
    assert.equal("nativeHttp" in runtime, false); assert.equal("nativeHttp" in installed, false);
  }

  const journal = new SqliteBridgeJournal(":memory:");
  const outgoing = [], incoming = [], serverFrames = [];
  let transportCloses = 0, transportAvailable = true;
  const bridge = new PortableNodeBridge({ tenantId: x.registration.tenantId, nodeId: x.registration.nodeId,
    keyId: "key:test", features: [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"] }, journal,
  { async sign(frame) { return signNodeFrame(frame, x.f.keys.privateKey); } },
  new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: serverPublicKeySpki,
    state: "active", principalState: "active", validFrom: new Date(x.f.clock() - 60_000).toISOString() }; } }, journal,
  new FixedWindowProtocolRateLimiter(100, 60)));
  t.after(async () => { await bridge.close(); journal.close(); });
  if (mode === "progress") {
    const beforeWrites = writes.length, beforeCalls = [...x.local.calls], beforeEffects = x.local.effects.countFull();
    const nodePackets = [], receivedPackets = [];
    const opened = await machineExchange({ schema: "control-room.native-http/v1", operation: "open", mode: "initial" });
    assert.equal(opened.status, 200);
    const generation = await opened.json(); assert.deepEqual(generation.packets, []); assert.equal(generation.more, false);
    await bridge.open({ async send(raw) { nodePackets.push(encodeNativeWire(raw, "node_to_server")); }, async close() {} },
      { now: new Date(x.f.clock()).toISOString(), transportIdentity: "transport:compiled-http-node" });
    let more = false;
    for (let count = 0; count < 20 && (nodePackets.length || more); count++) {
      const response = await machineExchange({ schema: "control-room.native-http/v1",
        operation: "exchange", connection: generation.connection, packet: nodePackets.shift() ?? null });
      assert.equal(response.status, 200); const value = await response.json();
      assert.equal(value.connection, generation.connection); more = value.more;
      for (const packet of value.packets) {
        receivedPackets.push(packet);
        // Directional codec only: no packet-type routing or saved result reader in this pump.
        await bridge.receive(decodeNativeWire(packet, "server_to_node").raw, new Date(x.f.clock()).toISOString());
      }
    }
    assert.equal(nodePackets.length, 0); assert.equal(more, false);
    // Inspect only after routing, to establish the signed handshake and absence of dispatch.
    const receivedTypes = receivedPackets.map(packet => JSON.parse(JSON.parse(packet).raw).type);
    assert.deepEqual(receivedTypes, ["connection.accepted", "node.reconciliation.request", "protocol.ack"]);
    const httpWrites = writes.slice(beforeWrites);
    assert.ok(httpWrites.some(row => row.table === "node_protocol_connections"));
    assert.ok(httpWrites.some(row => row.table === "node_protocol_replay"));
    assert.ok(httpWrites.every(row => row.current_user === "session_test" && row.session_user === "session_test" && row.rolsuper === false));
    assert.deepEqual(x.local.calls, beforeCalls); assert.equal(x.local.effects.countFull(), beforeEffects);
    const closed = await machineExchange({ schema: "control-room.native-http/v1", operation: "close", connection: generation.connection });
    assert.equal(closed.status, 200); await bridge.disconnected();
  }
  // Preserve the original direct-session missing-history negative proof independently.
  const handle = await runtime.connections.attach(x.registration.nodeId, {
    async send(raw) { outgoing.push(raw); serverFrames.push(JSON.parse(raw)); },
    async close() { transportCloses++; transportAvailable = false; }, isAvailable: () => transportAvailable,
  });
  assert.equal(handle.grantsExecutionAuthority, false);
  await bridge.open({ async send(raw) { incoming.push(raw); }, async close() {} },
    { now: new Date(x.f.clock()).toISOString(), transportIdentity: "transport:managed-node" });
  await handle.hello(incoming.shift(), new AbortController().signal);
  for (let count = 0; count < 20 && (outgoing.length || incoming.length); count++) {
    while (outgoing.length) await bridge.receive(outgoing.shift(), new Date(x.f.clock()).toISOString());
    while (incoming.length) await handle.reconcile(incoming.shift(), new AbortController().signal);
  }
  assert.equal(outgoing.length + incoming.length, 0);
  assert.ok(serverFrames.some(frame => frame.type === "connection.accepted"));
  assert.ok(serverFrames.some(frame => frame.type === "node.reconciliation.request"));
  assert.equal(serverFrames.some(frame => frame.type === "harness.native.dispatch"), false);

  const input = { projectId: x.registration.projectId, jobId: x.registration.jobId,
    attemptId: x.registration.attemptId, inputDigest: x.f.assignmentFixture.prepared.receipt.inputDigest };
  const nativeCalls = [...x.local.calls], nativeEffects = x.local.effects.countFull();
  const body = nativeTaskSnapshotBodySchema.parse({ runId: x.registration.id, projectId: x.registration.projectId,
    jobId: x.registration.jobId, attemptId: x.registration.attemptId, leaseId: x.registration.nativeTask.leaseId,
    leaseEpoch: x.registration.nativeTask.leaseEpoch, bindingDigest: x.registration.nativeTask.bindingDigest,
    sessionKeyDigest: x.registration.nativeSessionKeyDigest, nativeRunKeyDigest: null, snapshotVersion: 1,
    observedAt: new Date(x.f.clock()).toISOString(), upstreamUpdatedAt: null, state: "prepared", availability: "unknown",
    lastActivity: "none", stopAttempted: false, safeReason: "none", result: null, usage: null });
  await bridge.publishNativeSnapshot(body, new Date(x.f.clock()).toISOString());
  const serverFrameCount = serverFrames.length;
  await assert.rejects(mode === "progress"
    ? handle.progress(incoming.shift(), undefined, new AbortController().signal)
    : handle.recover(input, new AbortController().signal),
    { message: "native_session_operation_uncertain" });
  if (mode === "recover") assert.deepEqual(proofReads, [{ current_user: "evidence_test", session_user: "evidence_test" }]);
  assert.equal(outgoing.length, 0); assert.equal(serverFrames.length, serverFrameCount);
  assert.equal(transportCloses, 1); assert.deepEqual(x.local.calls, nativeCalls);
  assert.equal(x.local.effects.countFull(), nativeEffects);
  await startup.raw.exec("SET SESSION AUTHORIZATION postgres");
  assert.equal((await startup.raw.query("SELECT 1 AS present FROM control_harness_runs WHERE tenant_id=$1 AND id=$2",
    [x.registration.tenantId, x.registration.id])).rows.length, 0);
  assert.equal((await x.f.reviewStore.inspectSubject(x.registration.tenantId,
    x.registration.projectId, x.registration.jobId)).targets.length, 0);

  const sessionTables = new Set(writes.filter(row => row.current_user === "session_test").map(row => row.table));
  assert.equal(sessionTables.has("node_protocol_connections"), true);
  assert.equal(sessionTables.has("node_protocol_replay"), true);
  assert.ok(writes.filter(row => ["node_protocol_connections", "node_protocol_replay"].includes(row.table))
    .every(row => row.current_user === "session_test" && row.session_user === "session_test" && row.rolsuper === false));
  assert.equal(writes.some(row => row.current_user === "evidence_test" || row.current_user === "result_test"), false);
  const hiddenPath = `/api/v1/projects/${input.projectId}/tasks/${input.jobId}/native-sessions`;
  if (mode === "progress") assert.equal((await handler(request(hiddenPath, "POST", input, undefined, x.f.jwt))).status, 404);

  const retained = handle;
  if (mode === "progress") {
    machineServer.emit("error", new Error("synthetic machine listener failure"));
    assert.equal(runtime.isReady(), false, "machine failure immediately removes combined readiness");
  }
  await runtime.close(); assert.equal(runtime.isReady(), false); assert.equal(transportCloses, 1);
  assert.ok(servers.every(server => server.closes === 1));
  if (mode === "progress") assert.equal((await runtime.nativeHttp.handle(machineRequest({
    schema: "control-room.native-http/v1", operation: "open", mode: "initial" }), machineSocket)).status, 503);
  assert.equal(startup.web.closes(), 1); assert.equal(startup.coordinator.closes(), 1); assert.equal(result.closes(), 1);
  assert.equal(evidence.closes(), 1); assert.equal(sessions.closes(), 1);
  await assert.rejects(async () => retained.reconcile("{}", new AbortController().signal), { message: "task_coordinator_unavailable" });
  assert.deepEqual(x.local.calls, nativeCalls); assert.equal(x.local.effects.countFull(), nativeEffects);
});

test("compiled browser assets exclude managed session implementation and restricted role material", () => {
  const files = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
  const javascript = files("dist-vps/client").filter(file => file.endsWith(".js"));
  assert.ok(javascript.length > 0);
  for (const file of javascript) assert.doesNotMatch(readFileSync(file, "utf8"),
    /ManagedNativeSessions|recoverNativeDelivery|native_recovery_unavailable|control_room_native_sessions|native_session_unavailable|native_session_operation_uncertain|node_protocol_replay|DatabaseNodeKeyResolver|native_http_unavailable|native_http_close_uncertain|native_https_service_|requestCert/);
});
