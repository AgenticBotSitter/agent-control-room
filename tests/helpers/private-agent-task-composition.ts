import { EventEmitter } from "node:events";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseClient, DatabaseSession } from "../../src/persistence/database";
import { NATIVE_DELIVERY_FEATURE } from "../../src/harness/v1/native-delivery";
import { PG_BOSS_NATIVE_SUBMISSION, nativeTaskSubmissionId } from "../../src/persistence/pg-boss-native-task-submission";
import { signNodeFrame } from "../../src/node-protocol/v1";
import { sha256Digest } from "../../src/security";
import { createNativeQueueWorkerBootstrap } from "../../src/web/v1/native-queue-worker-startup";
import type { PrivateTaskStartupConfiguration } from "../../src/web/v1/private-task-startup";
import { nativeTaskLifecycleFixture } from "./native-task-lifecycle";
import { taskStartupFixture } from "./task-startup";

type Pool = ReturnType<Awaited<ReturnType<typeof taskStartupFixture>>["pool"]>;

export type SyntheticServer = EventEmitter & {
  bindCount: number;
  closeCount: number;
  boundHost?: string;
  boundPort?: number;
  listen(options: { host: string; port: number }, callback?: () => void): SyntheticServer;
  close(callback?: (error?: Error) => void): SyntheticServer;
  closeIdleConnections(): void;
  closeAllConnections(): void;
};

export async function privateAgentTaskCompositionFixture() {
  const lifecycle = await nativeTaskLifecycleFixture();
  const startup = await taskStartupFixture(lifecycle.f.assignmentFixture);
  for (const role of ["native_results_roles.sql", "native_evidence_roles.sql", "native_session_roles.sql"])
    await startup.raw.exec(await readFile(`db/roles/${role}`, "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE session_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test;
    GRANT control_room_native_evidence TO evidence_test;
    GRANT control_room_native_sessions TO session_test`);

  const serverKeys = generateKeyPairSync("ed25519");
  const serverPublicKeySpki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const certificate = Buffer.from("synthetic server-composition certificate");
  const certificateDigest = `sha256:${createHash("sha256").update(certificate).digest("hex")}`;
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const evidenceDatabase = { ...startup.config.coordinator.database, username: "evidence_test" };
  const sessionDatabase = { ...startup.config.coordinator.database, username: "session_test" };
  const workerDatabase = { ...startup.config.coordinator.database, username: "worker_test" };
  const node = {
    tenantId: lifecycle.registration.tenantId,
    nodeId: lifecycle.registration.nodeId,
    nodeKeyId: "key:test",
    serverId: "server:composition",
    serverKeyId: "key:server:composition",
    serverPublicKeySpki,
    transportIdentity: "transport:composition",
    features: [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"],
    maxFrameBytes: 131_072,
    heartbeatIntervalSeconds: 30,
  };
  const scenario = () => {
    const trace: string[] = [];
    const pools = new Map<string, Pool>();
    // Synthetic transport interruption. The pool object stays owned by the
    // composition; only its liveness probe reports the loss, exactly as a real
    // pool reports a dropped backend. Reconnection restores the same pool.
    const offline = new Set<string>();
    const restrictedPool = (login: "result_test" | "evidence_test" | "session_test") => {
      let closeCount = 0, available = true;
      const client: DatabaseClient = {
        query: (sql, values) => client.transaction(tx => tx.query(sql, values)),
        transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
        transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
          await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
          const session: DatabaseSession = { async query<T>(sql: string, values?: unknown[]) {
            const result = await tx.query<T>(sql, values);
            if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
            return result;
          } };
          return work(session);
        }, check),
      };
      return { client, async close() { closeCount++; available = false; trace.push(`pool-close:${login}`); },
        isAvailable: () => available, closes: () => closeCount, quarantine: () => { available = false; } };
    };
    pools.set("web_test", startup.pool("web_test"));
    pools.set("coordinator_test", startup.pool("coordinator_test"));
    pools.set("result_test", restrictedPool("result_test"));
    pools.set("evidence_test", restrictedPool("evidence_test"));
    pools.set("session_test", restrictedPool("session_test"));
    const openDatabase = (database: { username: string }) => {
      trace.push(`pool-open:${database.username}`);
      const pool = pools.get(database.username);
      if (!pool) throw new Error("synthetic_unknown_pool");
      const originalClose = pool.close.bind(pool);
      const wrap = (session: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, values?: unknown[]) {
        // pg-boss owns this schema in production. This matrix injects the result
        // of its separate permission gate instead of installing a queue schema.
        if (sql.includes("WITH relations AS") && sql.includes("has_schema_privilege('control_room_queue','USAGE')"))
          return { rows: [{ valid: true }] as T[] };
        return session.query<T>(sql, values);
      } });
      const client: DatabaseClient = {
        query: (sql, values) => wrap(pool.client).query(sql, values),
        transaction: work => pool.client.transaction(session => work(wrap(session))),
        transactionWithPreCommitCheck: (work, check) => pool.client.transactionWithPreCommitCheck(session => work(wrap(session)), check),
      };
      return { ...pool, client, isAvailable: () => !offline.has(database.username) && pool.isAvailable(),
        async close() {
          if (["web_test", "coordinator_test"].includes(database.username)) trace.push(`pool-close:${database.username}`);
          await originalClose();
        } };
    };
    const disconnect = (login: string) => { offline.add(login); trace.push(`pool-disconnect:${login}`); };
    const reconnect = (login: string) => { offline.delete(login); trace.push(`pool-reconnect:${login}`); };
    const servers: SyntheticServer[] = [];
    const makeServer = (kind: "native" | "web", mode: "success" | "bind-failure" | "bind-timeout" = "success") => {
      const server = new EventEmitter() as SyntheticServer;
      server.bindCount = 0; server.closeCount = 0;
      server.listen = (options, callback) => {
        server.bindCount++; server.boundHost = options.host; server.boundPort = options.port; trace.push(`${kind}-listen`);
        if (mode !== "bind-timeout")
          queueMicrotask(() => mode === "success" ? callback?.() : server.emit("error", new Error("synthetic_bind_failure")));
        return server;
      };
      server.close = callback => {
        server.closeCount++; trace.push(`${kind}-close`); queueMicrotask(() => callback?.()); return server;
      };
      server.closeIdleConnections = () => {};
      server.closeAllConnections = () => {};
      servers.push(server); return server;
    };
    let workerPoolCloses = 0, workerPoolAvailable = true;
    const workerClient: DatabaseClient = {
      async query<T>(sql: string) {
        if (sql.includes("current_user=session_user")) return { rows: [{ valid: true, database_temp: false }] as T[] };
        if (sql.includes("rolcanlogin=(rolname=current_user)")) return { rows: [
          { rolname: "control_room_native_queue_worker", valid: true }, { rolname: "worker_test", valid: true },
        ] as T[] };
        if (sql.includes("pg-boss-worker-permissions/v1")) return { rows: [{ valid: true }] as T[] };
        if (sql.includes("AS unsafe")) return { rows: [{ unsafe: false }] as T[] };
        return { rows: [] as T[] };
      },
      transaction: work => work(workerClient),
      transactionWithPreCommitCheck: async (work, check) => { const value = await work(workerClient); await check(); return value; },
    };
    const workerPool = { client: workerClient, isAvailable: () => workerPoolAvailable,
      async close() { if (!workerPoolAvailable) return; workerPoolAvailable = false; workerPoolCloses++; trace.push("worker-pool-close"); },
      closes: () => workerPoolCloses };
    let queueHandler: ((jobs: unknown[]) => Promise<void>) | undefined;
    const queue = { name: PG_BOSS_NATIVE_SUBMISSION.name, table: PG_BOSS_NATIVE_SUBMISSION.table,
      policy: "standard", partition: false, retryLimit: 0, deadLetter: null, notify: false };
    class SyntheticBoss {
      constructor(_options: unknown) { trace.push("queue-constructor"); }
      on(_event: string, _listener: (error: unknown) => void) { trace.push("queue-error-listener"); }
      async start() { trace.push("queue-start"); }
      async stop() { trace.push("queue-stop"); }
      async getQueue() { return queue; }
      async work(_name: string, _options: unknown, callback: (jobs: unknown[]) => Promise<void>) {
        queueHandler = callback; trace.push("queue-poller-start"); return "worker:composition";
      }
      async offWork() { trace.push("queue-poller-stop"); }
      async cancel() { trace.push("queue-cancel"); }
    }
    let workerRuntime: { status(): { accepting: boolean }; close(): Promise<void> } | undefined;
    const queueBootstrap = createNativeQueueWorkerBootstrap({ PgBoss: SyntheticBoss as never,
      openDatabase() { trace.push("worker-pool-open"); return workerPool; } });
    const startNativeWorker = async (input: Parameters<typeof queueBootstrap.start>[0]) => {
      workerRuntime = await queueBootstrap.start(input); return workerRuntime;
    };
    const reference = {
      schema: "control-room.native-task-submission/v1" as const,
      tenantId: lifecycle.registration.tenantId,
      projectId: lifecycle.registration.projectId,
      jobId: lifecycle.registration.jobId,
      attemptId: lifecycle.registration.attemptId,
      queueId: `native-queue:${sha256Digest({ tenantId: lifecycle.registration.tenantId,
        jobId: lifecycle.registration.jobId, attemptId: lifecycle.registration.attemptId }).slice(7)}` as `native-queue:${string}`,
      inputDigest: lifecycle.registration.nativeTask!.inputDigest,
      packetDigest: sha256Digest("synthetic-composition-packet"),
    };
    // The same locator carrying the packet digest the durable queue intent was
    // actually enqueued with, so canonical queue authorization admits it and the
    // canonical never-staged fence — not the digest mismatch — decides.
    const approvedReference = { ...reference, packetDigest: sha256Digest(lifecycle.f.packet) };
    const poll = async (options: { retryCount?: number; canonical?: boolean } = {}) => {
      if (!queueHandler) throw new Error("synthetic_poller_not_started");
      const data = options.canonical ? approvedReference : reference;
      return queueHandler([{ id: nativeTaskSubmissionId(data), name: queue.name, data,
        retryCount: options.retryCount ?? 0, retryLimit: 0, state: "active", policy: "standard", deadLetter: null,
        signal: new AbortController().signal }]);
    };
    // Read-only durable evidence for this exact attempt, through the fixture's
    // superuser client. These are the rows `requireNeverStaged` consults, so a
    // restart that re-executed the attempt would change these counts.
    const durableEvidence = async () => {
      const row = (await startup.raw.query<Record<string, string | number>>(
        `SELECT
           (SELECT count(*) FROM control_native_delivery_envelopes WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3) AS envelopes,
           (SELECT count(*) FROM control_native_transmission_intents WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3) AS intents,
           (SELECT count(*) FROM control_native_delivery_receipts WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3) AS receipts,
           (SELECT count(*) FROM control_harness_runs WHERE tenant_id=$1 AND job_id=$2 AND attempt_id=$3) AS runs,
           (SELECT count(*) FROM audit_events WHERE tenant_id=$1 AND action='native.queue.unsent_recovered'
              AND correlation_id=$4) AS recoveries`,
        [reference.tenantId, reference.jobId, reference.attemptId, reference.queueId])).rows[0]!;
      return Object.fromEntries(Object.entries(row).map(([name, value]) => [name, Number(value)])) as Record<
        "envelopes" | "intents" | "receipts" | "runs" | "recoveries", number>;
    };
    const configuration: PrivateTaskStartupConfiguration = {
      ...startup.config,
      coordinator: {
        ...startup.config.coordinator,
        approvals: { enrollments: [{ enrollment: lifecycle.f.prepared.enrollment, nodeClass: "personal-compute" }], store: lifecycle.f.store },
        quality: { ...lifecycle.f.ownerConfig, scenarios: [] },
        resultDatabase,
        evidence: {
          database: evidenceDatabase,
          integrityKey: new Uint8Array(32).fill(75),
          storage: { ...lifecycle.f.config, integrityKey: Uint8Array.from(lifecycle.f.config.integrityKey) },
          enrollments: [{ ...lifecycle.f.prepared.enrollment }],
        },
        sessions: {
          database: sessionDatabase,
          nodes: [{ ...node }],
          sign: async frame => signNodeFrame(frame, serverKeys.privateKey),
        },
        nativeHttp: {
          origin: "https://machine.example.test",
          peers: [{ nodeId: lifecycle.registration.nodeId, certificateDigest, task: {
            projectId: lifecycle.registration.projectId,
            jobId: lifecycle.registration.jobId,
            attemptId: lifecycle.registration.attemptId,
            inputDigest: lifecycle.registration.nativeTask!.inputDigest,
          } }],
          isPeerCurrent: () => true,
        },
        nativeQueue: true,
        nativeQueueRecovery: true,
        queueWorker: { database: workerDatabase, concurrency: 2 },
      },
    };
    return { trace, pools, openDatabase, servers, makeServer, configuration, startup, lifecycle,
      startNativeWorker, workerPool, workerStatus: () => workerRuntime?.status(), poll,
      disconnect, reconnect, reference, approvedReference, durableEvidence,
      tls: { host: "127.0.0.1", port: 443, key: new Uint8Array([1]), cert: new Uint8Array([2]), ca: new Uint8Array([3]) } };
  };
  return { scenario, close: lifecycle.close };
}
