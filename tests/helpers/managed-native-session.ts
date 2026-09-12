import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalApprovalStorageFixture } from "./canonical-approval-storage";
import { nativeStartAuthorityFixture } from "./native-start-authority";
import { qualityText } from "./native-quality-completion";
import { PortableNodeBridge, SqliteBridgeJournal } from "../../src/node-bridge";
import { NativeDispatchIntakeHandler } from "../../src/node-bridge/native-dispatch-handler";
import { FixedWindowProtocolRateLimiter, NodeProtocolAuthenticator, signNodeFrame, type SignedNodeFrame } from "../../src/node-protocol/v1";
import { ManagedNativeSessions, type ManagedNativeSessionSettings, type NativeSessionTransport } from "../../src/web/v1/managed-native-sessions";
import { NativeEvidenceReceiver } from "../../src/web/v1/native-evidence-receiver";
import { TaskResultCoordinator } from "../../src/web/v1/task-result-coordinator";
import { verifyNativeSessionDatabase, verifyNativeEvidenceDatabase, verifyNativeResultDatabase } from "../../src/web/v1/private-database-preflight";
import { NATIVE_DELIVERY_FEATURE, NATIVE_LEASE_DELIVERY_FEATURE } from "../../src/harness/v1/native-delivery";
import { prepareNativeExecutionHandoff } from "../../src/harness/hermes-native-v1/execution-handoff";
import { NativeObservationReporter } from "../../src/harness/hermes-native-v1/observation-reporter";
import { nativeTaskObservation, nativeTaskRegistration } from "../../src/harness/hermes-native-v1/task-observation";
import { resolvePinnedApprovalKey } from "../../src/node-policy/v1/pinned-approval-trust";
import { sha256Digest } from "../../src/security";
import type { DatabaseClient, DatabaseSession } from "../../src/persistence/database";
import { response, statusBody } from "../hermes-native-fixture";

export const currentSignal = () => new AbortController().signal;
type Login = "managed_auth_test" | "managed_evidence_test" | "managed_result_test";
type Base = Awaited<ReturnType<typeof canonicalApprovalStorageFixture>>;
type QueueLookup = Awaited<ReturnType<Base["coordinator"]["locateQueuedHarnessDelivery"]>>;
type Local = Pick<Awaited<ReturnType<typeof nativeStartAuthorityFixture>>,
  "policy" | "dependencies" | "journal" | "effects" | "executions" | "transport" | "calls" | "setNow" | "close"> & {
    prepared: { binding: Base["prepared"]["binding"] };
  };
export type ManagedNativePreparedContext = { f: Base; local: Local; providerRunId: string; resultText: string };

/** Real signed node protocol and restricted server SQL, entirely in disposable fake-native fixtures.
 * Canonical assignment/approval/dispatch and producer policy reads remain labelled privileged setup.
 * Never constructs a server session or supplies f.auth to the managed server. */
export async function managedNativeSessionFixture(context?: ManagedNativePreparedContext, options: { reporting?: boolean; queue?: boolean; stopHandshakeAtDispatch?: boolean; leaseDelivery?: boolean;
  receiptTimeoutMs?: number;
  onQueueReady?: import("../../src/web/v1/task-assignment-coordinator").TaskAssignmentCoordinator["recoverForReadyNode"] } = {}) {
  const f = context?.f ?? await canonicalApprovalStorageFixture();
  const cleanup: (() => void | Promise<void>)[] = [f.close];
  const admin = async <T>(work: () => Promise<T>): Promise<T> => {
    // PGlite retains SESSION AUTHORIZATION after commit. Only setup, fake-node work and
    // observer reads cross this boundary; all managed authentication/evidence writes enter roles.
    await f.raw.exec("SET SESSION AUTHORIZATION postgres; RESET ROLE");
    return work();
  };
  try {
    const local: Local = context?.local ?? await nativeStartAuthorityFixture(undefined, f.prepared.enrollment, f.assignmentFixture);
    cleanup.push(local.close);
    local.policy.approvalKey = await resolvePinnedApprovalKey(f.approvals, f.approvals.binding(), f.packet.approval.body.approvalKeyId);
    assert.equal(sha256Digest(local.prepared.binding), sha256Digest(f.prepared.binding));
    for (const file of ["native_session_roles.sql", "native_evidence_roles.sql", "native_results_roles.sql"])
      await f.raw.exec(await readFile(`db/roles/${file}`, "utf8"));
    await f.raw.exec(`CREATE ROLE managed_auth_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE managed_evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      CREATE ROLE managed_result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      GRANT control_room_native_sessions TO managed_auth_test;
      GRANT control_room_native_evidence TO managed_evidence_test;
      GRANT control_room_native_results TO managed_result_test;
      SET search_path=pg_catalog, public; SET statement_timeout='5s'; SET lock_timeout='2s';
      SET transaction_timeout='10s'; SET idle_in_transaction_session_timeout='5s'`);
    const observed: { login: Login; sql: string }[] = [];
    const hooks: { afterQuery?: (login: Login, sql: string) => void; afterQueueStage?: () => Promise<void>;
      afterQueueLocate?: (target: QueueLookup) => QueueLookup;
      beforeQueueStage?: () => void; beforeQueueTransmit?: () => void } = {};
    let healthy = true, admitted = 0;
    const pool = (login: Login): DatabaseClient => {
      const db: DatabaseClient = { query: (sql, params) => db.transaction(tx => tx.query(sql, params)),
        transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
        transactionWithPreCommitCheck: (work, check) => f.db.transactionWithPreCommitCheck(async tx => {
          await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
          const who = (await tx.query<{ current_user: string; session_user: string }>("SELECT current_user,session_user")).rows[0];
          assert.equal(who.current_user, login); assert.equal(who.session_user, login);
          const tracked: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
            const result = await tx.query<T>(sql, params); observed.push({ login, sql }); hooks.afterQuery?.(login, sql); return result;
          } };
          return work(tracked);
        }, check) };
      return db;
    };
    const authDb = pool("managed_auth_test"), evidenceDb = pool("managed_evidence_test"), resultDb = pool("managed_result_test");
    const metadata = (db: DatabaseClient): DatabaseClient => ({ ...db, transaction: work => db.transaction(tx => work({
      async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        // Sole preflight adaptation: known PGlite TEMP metadata reporting limitation.
        if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result;
      },
    })) });
    const databaseConfig = { host: "127.0.0.1" as const, port: 5432, database: "template1", password: "synthetic-only", majorVersion: 17 as const };
    const checkedScope = { ...f.scope, ownerIdentityId: "identity:test", issuer: f.accessTrust.issuer };
    const verifyAuth = (scope = checkedScope) => verifyNativeSessionDatabase(metadata(authDb),
      { ...databaseConfig, username: "managed_auth_test" }, scope, f.clock());
    const verify = async () => {
      await verifyAuth();
      await verifyNativeEvidenceDatabase(metadata(evidenceDb), { ...databaseConfig, username: "managed_evidence_test" }, checkedScope, f.clock());
      await verifyNativeResultDatabase(metadata(resultDb), { ...databaseConfig, username: "managed_result_test" }, checkedScope, f.clock());
    };
    const resultService = new TaskResultCoordinator(resultDb, f.scope, f.plannerConfig, { ...f.ownerConfig, scenarios: [] }, f.clock);
    const receiverConfig: ConstructorParameters<typeof NativeEvidenceReceiver>[1] = { scope: f.scope,
      integrityKey: new Uint8Array(32).fill(75), harnessIntegrityKey: f.harnessKey, enrollments: [f.prepared.enrollment],
      storage: f.config, results: { ...f.scope, register: resultService.register.bind(resultService), submit: resultService.submit.bind(resultService) }, clock: f.clock };
    const receiver = new NativeEvidenceReceiver(evidenceDb, receiverConfig);
    const serverKeys = generateKeyPairSync("ed25519"), spki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
    const features = [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1", ...(options.leaseDelivery ? [NATIVE_LEASE_DELIVERY_FEATURE] : [])];
    const settings: ManagedNativeSessionSettings = { nodes: [{ tenantId: f.scope.tenantId, nodeId: f.prepared.request.nodeId,
      nodeKeyId: "key:test", serverId: "server:managed", serverKeyId: "key:managed-server", serverPublicKeySpki: spki,
      transportIdentity: "transport:managed", features, maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 }],
      async sign(frame) { return signNodeFrame(frame, serverKeys.privateKey); } };
    const canonicalSetupDb: DatabaseClient = { query: (sql, params) => admin(() => f.db.query(sql, params)),
      transaction: work => admin(() => f.db.transaction(work)),
      transactionWithPreCommitCheck: (work, check) => admin(() => f.db.transactionWithPreCommitCheck(work, check)) };
    let inputRegistrations = 0;
    // This fixture proves routing/authority, not package submission (covered separately).
    const queueCoordinator = f.create(canonicalSetupDb, { async enqueueInSession() { throw new Error("fixture queue submission not used"); } });
    const routes: ConstructorParameters<typeof ManagedNativeSessions>[3] = {
      queue: options.queue ? {
        ready: options.onQueueReady,
        locate: async (...args) => {
          const target = await admin(() => queueCoordinator.locateQueuedHarnessDelivery(...args));
          return hooks.afterQueueLocate ? hooks.afterQueueLocate(target) : target;
        },
        stage: async (...args) => {
          hooks.beforeQueueStage?.();
          const value = await admin(() => queueCoordinator.stageApprovedQueueDelivery(...args));
          await hooks.afterQueueStage?.(); return value;
        },
        transmit: (...args) => { hooks.beforeQueueTransmit?.(); return admin(() => queueCoordinator.transmitApprovedQueueDelivery(...args)); },
      } : undefined,
      // Canonical approval/envelope/intent/receipt work is privileged fixture composition, not
      // evidence of new coordinator grants. Server authentication is always the manager's pool.
      stage: (...args) => admin(() => f.coordinator.stageQueuedNativeDelivery(...args)),
      transmit: (...args) => admin(() => f.coordinator.transmitQueuedNativeDelivery(...args)),
      receipt: (session, raw, signal) => f.store.receiveDeliveryReceipt(canonicalSetupDb, session, raw, signal),
      progress: receiver.receive.bind(receiver),
      recover: receiver.recover.bind(receiver),
      register: (...args) => { inputRegistrations++; return receiver.register(...args); },
    };
    const manager = new ManagedNativeSessions(authDb, settings, f.scope, routes,
      async work => { admitted++; return work(); }, () => { if (!healthy) throw new Error("synthetic_pool_unavailable"); }, f.clock,
      options.receiptTimeoutMs);
    cleanup.push(() => manager.close());
    const timestamp = () => new Date(f.clock()).toISOString();
    function makePeer() {
      const journal = new SqliteBridgeJournal(":memory:"); cleanup.push(() => journal.close());
      const handler = new NativeDispatchIntakeHandler(f.prepared.enrollment, journal,
        { approvals: f.approvals, security: f.native.trust }, f.clock); cleanup.push(() => handler.close());
      // The fake node trusts only the synthetic server key. This is not server authentication.
      const bridge = new PortableNodeBridge({ tenantId: f.scope.tenantId, nodeId: f.prepared.request.nodeId, keyId: "key:test", features }, journal,
        { async sign(frame) { return signNodeFrame(frame, f.keys.privateKey); } },
        new NodeProtocolAuthenticator({ async resolve(value) { return { ...value, algorithm: "ed25519", publicKeySpki: spki,
          state: "active", principalState: "active", validFrom: new Date(f.clock() - 60_000).toISOString() }; } }, journal,
        new FixedWindowProtocolRateLimiter(120, 60)), undefined, undefined, handler);
      cleanup.push(() => bridge.close());
      const incoming: string[] = [], outgoing: string[] = [], sent: SignedNodeFrame[] = [];
      const state = { available: true, closes: 0, sends: 0, failSend: false, failClose: false };
      const transport: NativeSessionTransport = { async send(raw) {
        state.sends++; if (state.failSend) throw new Error("synthetic_transport_send_failure"); outgoing.push(raw);
      }, async close() { state.closes++; state.available = false; if (state.failClose) throw new Error("synthetic_transport_close_failure"); },
      isAvailable: () => state.available };
      const open = () => admin(async () => {
        await bridge.open({ async send(raw) { incoming.push(raw); sent.push(JSON.parse(raw)); }, async close() {} },
          { now: timestamp(), transportIdentity: "transport:managed-server" });
        const raw = incoming.shift(); assert.ok(raw); return raw;
      });
      const acknowledge = () => admin(async () => {
        const raw = outgoing.shift(); assert.ok(raw); await bridge.receive(raw, timestamp());
      });
      return { journal, bridge, incoming, outgoing, sent, state, transport, open, acknowledge };
    }
    const attach = async () => {
      const peer = makePeer(), handle = await manager.attach(f.prepared.request.nodeId, peer.transport), hello = await peer.open();
      return { peer, handle, hello };
    };
    const attachQueue = async () => {
      const peer = makePeer(), handle = await manager.attachInput(f.prepared.request.nodeId, peer.transport,
        { mode: "initial", assignment: "queue" });
      const hello = await peer.open(); return { peer, handle, hello };
    };
    type Connection = Awaited<ReturnType<typeof attach>>;
    const handshake = async (x: Connection, hello: string | Uint8Array = x.hello) => {
      await x.handle.hello(hello, currentSignal());
      for (let count = 0; count < 20 && (x.peer.outgoing.length || x.peer.incoming.length); count++) {
        while (x.peer.outgoing.length && !(options.stopHandshakeAtDispatch && JSON.parse(x.peer.outgoing[0]).type === "harness.native.dispatch")) await x.peer.acknowledge();
        while (x.peer.incoming.length) await x.handle.reconcile(x.peer.incoming.shift()!, currentSignal());
        if (options.stopHandshakeAtDispatch && x.peer.outgoing.length && JSON.parse(x.peer.outgoing[0]).type === "harness.native.dispatch") return;
      }
      assert.equal(x.peer.outgoing.length + x.peer.incoming.length, 0);
    };
    const handshakeQueue = async (x: Awaited<ReturnType<typeof attachQueue>>) => {
      await x.handle.receive(x.hello, undefined, currentSignal());
      for (let count = 0; count < 20 && (x.peer.outgoing.length || x.peer.incoming.length); count++) {
        while (x.peer.outgoing.length) await x.peer.acknowledge();
        while (x.peer.incoming.length) await x.handle.receive(x.peer.incoming.shift()!, undefined, currentSignal());
      }
      assert.equal(x.peer.outgoing.length + x.peer.incoming.length, 0);
    };
    const task = { projectId: f.args[1], jobId: f.args[2], inputDigest: f.args[3], packetDigest: sha256Digest(f.packet) };
    const registration = nativeTaskRegistration(f.prepared.binding, f.args[3], f.prepared.request.leaseId, f.prepared.request.leaseEpoch, timestamp());
    const request = { projectId: task.projectId, jobId: task.jobId, attemptId: registration.attemptId, inputDigest: task.inputDigest };
    const prepareNode = async (peer: ReturnType<typeof makePeer>, frame: SignedNodeFrame<"harness.native.dispatch">) => {
      // Local handoff and provider are wholly synthetic, unchanged native-start fixture APIs.
      let resultText: string | undefined;
      const handoff = await admin(() => prepareNativeExecutionHandoff({ queueId: frame.body.queueId,
        enrollment: f.prepared.enrollment, serverActorId: "server:managed" }, {
        deliveries: peer.journal, runs: local.journal, approvals: f.approvals,
        ...(options.reporting ? { reporting: peer.bridge } : {}),
        security: { currentServerTrustRevision: () => f.native.trust.currentServerTrustRevision(),
          async resolveServerKey() { return new Uint8Array(Buffer.from(spki, "base64url")); } },
        local: local.dependencies, clock: f.clock, transport: { ...local.transport,
          async json(wire: Parameters<typeof local.transport.json>[0]) {
            if (wire.operation === "status" && resultText !== undefined) {
              await wire.authorize(); local.calls.push(wire.operation);
              return response(statusBody("completed", { ...(context ? { run_id: context.providerRunId } : {}),
                session_id: f.prepared.binding.sessionId, output: resultText,
                usage: { input_tokens: 12, output_tokens: 5 } }));
            }
            return local.transport.json(wire);
          },
        },
      }, f.abort.signal));
      cleanup.push(() => handoff.close());
      const reporter = options.reporting ? new NativeObservationReporter({ queueId: frame.body.queueId,
        enrollment: f.prepared.enrollment, serverId: frame.actorId, serverKeyId: frame.keyId, serverPublicKeySpki: spki }, {
        deliveries: peer.journal, runs: local.journal, bridge: peer.bridge, clock: f.clock,
        assertAvailable: () => { if (f.abort.signal.aborted) throw new Error("synthetic_reporting_unavailable"); },
      }) : undefined;
      if (reporter) cleanup.push(() => reporter.close());
      const advanceNative = (phase: "start" | "running" | "completed") => admin(async () => {
        if (phase === "start") await handoff.start();
        else { const now = f.clock() + 1000; f.setNow(now); local.setNow(now); if (phase === "completed") resultText = context?.resultText ?? qualityText; await handoff.poll(); }
        return nativeTaskObservation(handoff.snapshot(), registration.nativeTask!);
      });
      const produce = async (phase: "start" | "running" | "completed") => {
        const body = await advanceNative(phase);
        // The default retains existing fixture publication. Opt-in handoff reports itself.
        if (!options.reporting) await admin(() => peer.bridge.publishNativeSnapshot(body, timestamp()));
        const raw = peer.incoming.shift(); assert.ok(raw); return { raw, body };
      };
      return { handoff, produce, advanceNative, reporter };
    };
    const dispatch = async (x: Connection) => {
      await admin(async () => { await f.save(); await f.coordinator.enqueueNativeTask(...f.args, task.packetDigest, f.abort.signal); });
      await x.handle.stage(f.identity, task, currentSignal()); await x.handle.transmit(f.identity, task, currentSignal());
      const frame = JSON.parse(x.peer.outgoing[0]) as SignedNodeFrame<"harness.native.dispatch">;
      await x.peer.acknowledge();
      const receipt = await x.handle.receipt(x.peer.incoming.shift()!, currentSignal());
      return { receipt, ...await prepareNode(x.peer, frame) };
    };
    const states = () => admin(async () => ({ job: await f.canonical.get(f.scope.tenantId, "job", task.jobId),
      attempt: await f.canonical.get(f.scope.tenantId, "attempt", registration.attemptId),
      lease: await f.canonical.get(f.scope.tenantId, "lease", registration.nativeTask!.leaseId) }));
    const protocol = () => admin(async () => ({
      connections: (await f.db.query("SELECT * FROM node_protocol_connections ORDER BY connection_id")).rows,
      replay: (await f.db.query("SELECT * FROM node_protocol_replay ORDER BY message_id")).rows,
    }));
    const counts = () => admin(async () => ({
      runs: (await f.db.query("SELECT * FROM control_harness_runs WHERE id=$1", [registration.id])).rows,
      events: (await f.db.query("SELECT * FROM control_harness_run_events WHERE run_id=$1 ORDER BY sequence", [registration.id])).rows,
      artifacts: (await f.db.query("SELECT * FROM control_artifact_manifests WHERE job_id=$1", [task.jobId])).rows,
      receipts: (await f.db.query("SELECT * FROM control_native_artifact_receipts WHERE run_id=$1", [registration.id])).rows,
    }));
    return { f, local, admin, authDb, evidenceDb, resultDb, observed, hooks, settings, manager, receiver,
      verify, verifyAuth, checkedScope, makePeer, attach, attachQueue, handshake, handshakeQueue, dispatch, prepareNode, task, registration, request, states, protocol, counts,
      inputRegistrations: () => inputRegistrations,
      admitted: () => admitted, setHealthy: (value: boolean) => { healthy = value; },
      close: async () => { let failed = false;
        for (const fn of cleanup.reverse()) { try { await fn(); } catch { failed = true; } }
        if (failed) throw new Error("synthetic_fixture_cleanup_failed"); } };
  } catch (error) { for (const fn of cleanup.reverse()) { try { await fn(); } catch { /* Preserve setup failure. */ } } throw error; }
}
