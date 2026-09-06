import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { DatabaseClient, DatabaseSession } from "../../src/persistence/database";
import type { ServerNodeSessionConfig } from "../../src/node-control/server-node-session";
import { NATIVE_DELIVERY_FEATURE } from "../../src/harness/v1/native-delivery";
import { signNodeFrame } from "../../src/node-protocol/v1";
import type { PrivateTaskStartupConfiguration } from "../../src/web/v1/private-task-startup";
import type { TaskQualityConfiguration } from "../../src/web/v1/task-quality-coordinator";
import { nativeQualityCompletionFixture } from "./native-quality-completion";
import { taskStartupFixture } from "./task-startup";
type QualityFixture = Awaited<ReturnType<typeof nativeQualityCompletionFixture>>;
type EvidenceSettings = NonNullable<PrivateTaskStartupConfiguration["coordinator"]["evidence"]>;
type SessionSettings = NonNullable<PrivateTaskStartupConfiguration["coordinator"]["sessions"]>;

function qualityConfiguration(x: QualityFixture): TaskQualityConfiguration {
  return {
    integrityKey: Uint8Array.from(x.f.ownerConfig.integrityKey),
    harnessIntegrityKey: Uint8Array.from(x.f.ownerConfig.harnessIntegrityKey),
    checkpoints: x.f.ownerConfig.checkpoints,
    results: { ...x.f.ownerConfig.results, integrityKey: Uint8Array.from(x.f.ownerConfig.results.integrityKey) },
    scenarios: [{ ...x.scenario, rules: { ...x.scenario.rules,
      requiredHeadings: [...x.scenario.rules.requiredHeadings], forbiddenTerms: [...x.scenario.rules.forbiddenTerms] } }],
  };
}

export function restrictedPool(startup: Awaited<ReturnType<typeof taskStartupFixture>>, login: string) {
  let closes = 0, available = true;
  const client: DatabaseClient = {
    query: (sql, params) => client.transaction(tx => tx.query(sql, params)),
    transaction: work => client.transactionWithPreCommitCheck(work, () => {}),
    transactionWithPreCommitCheck: (work, check) => startup.db.transactionWithPreCommitCheck(async tx => {
      await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
      const session: DatabaseSession = { async query<T>(sql: string, params?: unknown[]) {
        const result = await tx.query<T>(sql, params);
        if (sql.includes("AS database_temp")) result.rows = result.rows.map(row => ({ ...row, database_temp: false }));
        return result;
      } };
      return work(session);
    }, check),
  };
  return { client, close: async () => { closes++; available = false; }, isAvailable: () => available,
    closes: () => closes, quarantine: () => { available = false; } };
}

export async function managedStartupFixture() {
  const x = await nativeQualityCompletionFixture();
  const startup = await taskStartupFixture(x.f.assignmentFixture);
  for (const role of ["native_results_roles.sql", "native_evidence_roles.sql", "native_session_roles.sql"])
    await startup.raw.exec(await readFile(`db/roles/${role}`, "utf8"));
  await startup.raw.exec(`CREATE ROLE result_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE session_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_results TO result_test; GRANT control_room_native_evidence TO evidence_test;
    GRANT control_room_native_sessions TO session_test`);
  const result = restrictedPool(startup, "result_test"), evidence = restrictedPool(startup, "evidence_test");
  const sessions = restrictedPool(startup, "session_test"), serverKeys = generateKeyPairSync("ed25519");
  const serverPublicKeySpki = serverKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const node: ServerNodeSessionConfig = { tenantId: x.registration.tenantId, nodeId: x.registration.nodeId,
    nodeKeyId: "key:test", serverId: "server:managed", serverKeyId: "key:server:managed", serverPublicKeySpki,
    transportIdentity: "transport:managed", features: [NATIVE_DELIVERY_FEATURE, "harness.native.snapshot.v1"],
    maxFrameBytes: 131_072, heartbeatIntervalSeconds: 30 };
  const resultDatabase = { ...startup.config.coordinator.database, username: "result_test" };
  const evidenceDatabase = { ...startup.config.coordinator.database, username: "evidence_test" };
  const sessionDatabase = { ...startup.config.coordinator.database, username: "session_test" };
  const evidenceSettings: EvidenceSettings = { database: evidenceDatabase, integrityKey: new Uint8Array(32).fill(75),
    storage: { ...x.f.config, integrityKey: Uint8Array.from(x.f.config.integrityKey), storage: x.f.config.storage },
    enrollments: [{ ...x.f.prepared.enrollment }] };
  const sessionSettings: SessionSettings = { database: sessionDatabase, nodes: [{ ...node }],
    sign: async frame => signNodeFrame(frame, serverKeys.privateKey) };
  const quality = qualityConfiguration(x);
  const approvals = { enrollments: [{ enrollment: { ...x.f.prepared.enrollment }, nodeClass: "personal-compute" as const }], store: x.f.store };
  const config: PrivateTaskStartupConfiguration = { ...startup.config, coordinator: { ...startup.config.coordinator,
    quality, approvals, resultDatabase, evidence: evidenceSettings, sessions: sessionSettings } };
  const names = { web: startup.config.web.database.username, coordinator: startup.config.coordinator.database.username,
    result: resultDatabase.username, evidence: evidenceDatabase.username, sessions: sessionDatabase.username };
  const openDatabase = (database: { username: string }) => {
    if (database.username === names.web) return startup.web;
    if (database.username === names.coordinator) return startup.coordinator;
    if (database.username === names.result) return result;
    if (database.username === names.evidence) return evidence;
    if (database.username === names.sessions) return sessions;
    throw new Error("unexpected_test_database");
  };
  return { x, startup, result, evidence, sessions, node, resultDatabase, evidenceDatabase, sessionDatabase,
    evidenceSettings, sessionSettings, config, openDatabase };
}
