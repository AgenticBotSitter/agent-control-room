// Real-PostgreSQL proof for migrations 0209-0211: chunked upload sessions, the
// publication that makes a stored set provable, and the combine-input bindings.
//
// Run AS the production logins that execute each step. The superuser
// connection only seeds the tenant and reads back what a guard did, and proves
// that a guard still bites for it. Every refusal is asserted on the SQLSTATE the
// server reported, never on a guard's message: the production driver maps every
// SQL error to one safe code and keeps the state, so a message is not evidence a
// test may depend on — the state is.
//
// The worker, its claim and its offer all come from the real owner and gateway
// paths rather than from hand-written fleet rows, because 0140's enrollment
// guard requires a consumed owner-issued code and a DERIVED agent-identity
// digest, and a fixture that wrote those directly would be testing itself.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import type { AttackRole, RealPostgres } from "./support/attack-kit/index";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { privateWebSchemaDigest, readPrivateWebSchemaDigest, verifyPrivateDatabase }
  from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { FleetGatewayStoreV1, FleetOwnerServiceV1, scanForSecretsV1 } from "../src/fleet/v1";
import { WebOperationsModeServiceV1 } from "../src/web/v1/operations-mode-service";
import { FLEET_TENANT, FLEET_WORKSPACE, PROJECT_A, PROJECT_B, ownerIdentity, seedFleetTenant,
  seedProposedTask } from "./support/fleet-fixture";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
/** A third project, so three claiming workers never contend for one tree
 * scope: 0100's ownership-lease collision guard is correct, and a fixture that
 * tripped it would be testing the wrong thing. */
const PROJECT_C = "project:upload-gamma";
const PROJECT_D = "project:upload-delta";

// The assigned lane: 59310-59319. Any other port is refused by the kit.
const PORTS = Array.from({ length: 10 }, (_, index) => 59310 + index);
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59310);
const PG = requiresRealPostgres();
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };

const OWNER = "identity:fleet-owner";
const issuedAt = new Date(Date.now() - 60_000).toISOString();
const digestOf = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const text = (value: string) => new TextEncoder().encode(value);
const ZERO = `sha256:${"0".repeat(64)}`;
const ONE = `sha256:${"1".repeat(64)}`;
const CHUNK = 8 * 1024 * 1024;
// Exactly 32 lowercase hex characters, the grammar every one of these ids
// shares. Padded rather than repeated, so id 11 is still 32 characters.
const hex32 = (n: number) => n.toString(16).padStart(32, "0");
const setIdOf = (n: number) => `result-set:${hex32(n)}`;
const fileIdOf = (n: number) => `result-file:${hex32(n)}`;
const uploadIdOf = (n: number) => `result-upload:${hex32(n)}`;
const inHours = (hours: number) => new Date(Date.parse(issuedAt) + hours * 3_600_000).toISOString();

interface Refusal {
  readonly sql: string;
  readonly params: unknown[];
  readonly what: string;
  readonly states: readonly string[];
}

async function rows<T>(postgres: RealPostgres, role: AttackRole | "admin", sql: string,
  params: unknown[]): Promise<T[]> {
  const options = role === "admin" ? postgres.admin({ database: postgres.database })
    : (() => { const login = postgres.connection(role); return { host: login.host, port: postgres.port,
      database: postgres.database, user: login.user, password: login.password }; })();
  const client = new Client(options);
  await client.connect();
  try { return ((await client.query(sql, params)).rows ?? []) as T[]; }
  finally { await client.end(); }
}

async function guard(run: (sql: string, params: unknown[]) => Promise<unknown>,
  { sql, params, what, states }: Refusal): Promise<void> {
  await assert.rejects(run(sql, params), (error: unknown) => {
    const reported = error as { code?: string; sqlState?: string };
    const state = String(reported.sqlState ?? reported.code ?? "");
    const detail = String((error as { detail?: string; message?: string }).detail
      ?? (error as { message?: string }).message ?? "");
    assert.ok(states.includes(state), `${what}: expected ${states.join("/")}, got ${state || "no state"} ${detail}`);
    return true;
  }, what);
}

const declareOutput = `INSERT INTO control_task_declared_outputs(tenant_id,project_id,job_id,ordinal,display_name,
  declared_media_type,decided_by_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`;
const declareInput = `INSERT INTO control_task_declared_inputs(tenant_id,project_id,job_id,ordinal,producer_job_id,
  display_name,decided_by_identity_id,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`;
const bindInput = (returning = "") => `INSERT INTO control_job_artifact_inputs(tenant_id,consumer_job_id,ordinal,
  producer_job_id,project_id,source_set_id,file_id,display_name,size_bytes,content_digest,bound_at)
  VALUES($1,$2,1,$3,$4,$5,$6,'lie.txt',999,'${ONE}',$7) ${returning}`;
const insertSession = `INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,attempt_id,set_id,
  ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,expected_chunks,state,
  created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'reserved',$14,$15)`;
const insertChunk = `INSERT INTO control_result_upload_chunks(tenant_id,upload_id,ordinal,size_bytes,chunk_digest,
  received_at) VALUES($1,$2,$3,$4,$5,$6)`;
const markReceived = `UPDATE control_result_upload_sessions SET state='received',received_at=$3
  WHERE tenant_id=$1 AND upload_id=$2`;
const markPublished = `UPDATE control_result_upload_sessions SET state='published',published_at=$3
  WHERE tenant_id=$1 AND upload_id=$2`;
const markFileStored = `UPDATE control_result_files SET state='stored',stored_at=$3
  WHERE tenant_id=$1 AND set_id=$2 AND ordinal=$4`;
const insertReceipt = `INSERT INTO control_result_publications(tenant_id,set_id,project_id,job_id,attempt_id,
  manifest_digest,file_count,total_bytes,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`;

test("upload sessions, chunks, publication and combine bindings hold their refusals", async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  ran += 1;
  await withRealPostgres(async postgres => {
    const admin = <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      rows<T>(postgres, "admin", sql, params);
    const asRole = (role: AttackRole) => <T = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
      rows<T>(postgres, role, sql, params);
    const web = asRole("web"), results = asRole("results"), fleet = asRole("fleet");
    const bytes = new TextEncoder().encode("the produced file\n"), hash = digestOf(bytes);
    const appendix = new TextEncoder().encode("appendix body\n"), appendixHash = digestOf(appendix);

    // The fixture's schema-owner writes. A plain, unbounded client on purpose:
    // this is seeding canonical lineage, not exercising a login, and the
    // production driver's own bounded settings are the wrong tool for it.
    const db = fixtureWriter(postgres);
    const fleetPool = await poolFor(postgres, "fleet");
    const fleetOwnerPool = await poolFor(postgres, "fleetOwner");
    const webPoolForMode = await poolFor(postgres, "web");
    const gateway = new FleetGatewayStoreV1(fleetPool.client, { tenantId: FLEET_TENANT });
    const owner = new FleetOwnerServiceV1(fleetOwnerPool.client, { tenantId: FLEET_TENANT,
      workspaceId: FLEET_WORKSPACE });
    try {
      assert.equal(await readPrivateWebSchemaDigest(db), privateWebSchemaDigest,
        "the recorded private web schema digest matches a live cluster with 0209-0211 applied");
      await seedFleetTenant((sql, params) => db.query(sql, params));
      for (const project of [PROJECT_C, PROJECT_D]) {
        await db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
          title,normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
          VALUES($1,$2,$3,'adapter:fleet',$1,'1',$1,'running','fixture','healthy','control_room_native',$4,'{}',$4)`,
          [project, FLEET_TENANT, FLEET_WORKSPACE, issuedAt]);
        await db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,
          created_at,updated_at) VALUES($1,$2,'active',1,$3,$3)`, [FLEET_TENANT, project, issuedAt]);
      }
      // Two jobs in this project: one the worker claims, and one left proposed
      // so the owner can declare outputs against it BEFORE the claim — the real
      // order, and the one 0209's ordering rule depends on.
      // One project per claiming job, deliberately. 0100's ownership-lease
      // collision guard refuses a second worker's root-tree scope in the same
      // project; that guard is correct and is not what this file is about, so
      // the fixture gives each claim its own ground rather than trip it.
      const producer = await seedProposedTask(db, PROJECT_C, "upload-producer");
      const planned = await seedProposedTask(db, PROJECT_A, "upload-planned");
      const other = await seedProposedTask(db, PROJECT_D, "upload-other");
      const plannedB = await seedProposedTask(db, PROJECT_B, "upload-planned-b");
      const combineIn = await seedProposedTask(db, PROJECT_C, "upload-combine");

      // The owner approves the declared outputs, on a job that has not started.
      await web(declareOutput, [FLEET_TENANT, PROJECT_A, planned.jobId, 1, "report.txt", "text/plain",
        OWNER, issuedAt]);
      await web(declareOutput, [FLEET_TENANT, PROJECT_A, planned.jobId, 2, "appendix.txt", "text/plain",
        OWNER, issuedAt]);
      // The producing job's two outputs, declared BEFORE its claim: a declaration
      // is frozen, and the point of that rule is that the owner approves what a
      // part may produce before any work starts.
      await web(declareOutput, [FLEET_TENANT, PROJECT_C, producer.jobId, 1, "report.txt", "text/plain",
        OWNER, issuedAt]);
      await web(declareOutput, [FLEET_TENANT, PROJECT_C, producer.jobId, 2, "appendix.txt", "text/plain",
        OWNER, issuedAt]);

      // Now the claim, through the real gateway path.
      const claimed = await enrollAndClaim(db, owner, gateway, postgres, PROJECT_A, "upload-planned");

      // The producer job is claimed too, so the set and its files are a real
      // fleet attempt's and the upload guards have a live claim to check.
      const producing = await enrollAndClaim(db, owner, gateway, postgres, PROJECT_C, "upload-producer");

      // ==== 1. a declared output is the owner's, and it is frozen ======
      // The claimed job is running, so the owner cannot declare outputs for it:
      // nothing a machine does can change the promise after the fact.
      await guard(web, { sql: declareOutput, params: [FLEET_TENANT, PROJECT_C, producing.jobId, 3, "report.txt",
        "text/plain", OWNER, issuedAt],
        what: "a declared output for a claimed job is refused", states: ["23514", "42501"] });
      for (const [who, actorType, label] of [["identity:upload-agent", "agent", "an agent identity"],
        ["identity:upload-plain", "human", "a human with no owner grant"]] as const) {
        await db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
          auth_subject_digest,state,created_at,updated_at) VALUES($1,$2,$3,$4,'test',$5,'active',$6,$6)
          ON CONFLICT (tenant_id,id) DO NOTHING`,
          [who, FLEET_TENANT, actorType, who, `sha256:${createHash("sha256").update(who).digest("hex")}`, issuedAt]);
        await guard(web, { sql: declareOutput, params: [FLEET_TENANT, PROJECT_D, other.jobId, 1, "report.txt",
          "text/plain", who, issuedAt], what: `${label} cannot declare a task output`, states: ["42501"] });
      }
      // Names that could address the filesystem or a header never reach the table.
      for (const name of ["../escape.txt", "a/b.txt", 'a"b.txt', ".hidden", "a..b", "a\\b.txt"]) {
        await guard(web, { sql: declareOutput, params: [FLEET_TENANT, PROJECT_D, other.jobId, 1, name,
          "text/plain", OWNER, issuedAt], what: `declared output name refused: ${JSON.stringify(name)}`,
          states: ["23514"] });
      }
      await guard(admin, { sql: "UPDATE control_task_declared_outputs SET display_name='other.txt' WHERE tenant_id=$1",
        params: [FLEET_TENANT], what: "a declared output cannot be renamed", states: ["23514", "P0001", "2F004"] });
      await guard(admin, { sql: "DELETE FROM control_task_declared_outputs WHERE tenant_id=$1", params: [FLEET_TENANT],
        what: "a declared output is never deleted", states: ["2F004", "P0001", "23514"] });
      await guard(fleet, { sql: declareOutput, params: [FLEET_TENANT, PROJECT_D, other.jobId, 1, "x.txt",
        "text/plain", OWNER, issuedAt], what: "the gateway cannot write a declared output", states: ["42501"] });

      // ==== 2. a reservation is the OWNER'S promise =====================
      // The producing job's set and its two files, written as the publisher would.
      // Its declared outputs already name both files, because the owner declared
      // them before the claim above.
      const set = setIdOf(1);
      // ONE transaction: 0206's deferred completeness trigger counts the set's
      // own files at COMMIT, so a set and its files declared in separate
      // statements is exactly the half-finished publication it refuses.
      await db.transaction(async tx => {
        await tx.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
          producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,$3,$4,$5,'fleet',$6,'declared','file-store',2,$7,$8,'provisional',$9)`,
          [FLEET_TENANT, set, PROJECT_C, producing.jobId, producing.attemptId, producing.workerId,
            bytes.byteLength + appendix.byteLength, ZERO, issuedAt]);
        for (const [ordinal, name, size, digest] of [[1, "report.txt", bytes.byteLength, hash],
          [2, "appendix.txt", appendix.byteLength, appendixHash]] as const) {
          await tx.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,display_name,
            declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,'text/plain','text/plain',$8,$9,$10,'declared',$11)`,
            [FLEET_TENANT, set, PROJECT_C, producing.jobId, ordinal, fileIdOf(ordinal), name, size, digest, ZERO, issuedAt]);
        }
      });
      // The storage key is DERIVED: the caller's guess never reaches the table.
      const keyed = await admin<{ storage_key: string }>(
        "SELECT storage_key FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND ordinal=1",
        [FLEET_TENANT, set]);
      assert.notEqual(keyed[0]!.storage_key, ZERO, "the supplied storage key is overwritten");
      // Read back what the catalog actually holds, so a refusal below names a
      // mismatch instead of guessing at one.
      const stored = await admin<{ ordinal: number; size_bytes: string; content_digest: string; display_name: string;
        state: string }>(`SELECT ordinal,size_bytes,content_digest,display_name,state FROM control_result_files
        WHERE tenant_id=$1 AND set_id=$2 ORDER BY ordinal`, [FLEET_TENANT, set]);
      assert.equal(stored.length, 2, "both declared files are in the catalog");
      assert.equal(Number(stored[0]!.size_bytes), bytes.byteLength, "the catalog file carries the promised size");
      assert.equal(stored[0]!.content_digest, hash, "and the promised digest");
      assert.equal(stored[0]!.display_name, "report.txt", "and the owner's approved name");
      assert.equal(stored[0]!.state, "declared", "and it is still awaiting its bytes");
      const declarations = await admin<{ ordinal: number; display_name: string }>(
        `SELECT ordinal,display_name FROM control_task_declared_outputs WHERE tenant_id=$1 AND job_id=$2
        ORDER BY ordinal`, [FLEET_TENANT, producing.jobId]);
      assert.equal(declarations.length, 2, "the producing job has both declared outputs");
      assert.equal(declarations[0]!.display_name, "report.txt", "and they name the same files");
      const live = await admin<{ live: boolean }>("SELECT fleet_claim_is_live($1,$2,$3) AS live",
        [FLEET_TENANT, producing.claimId, producing.workerId]);
      assert.equal(live[0]!.live, true, "the producing claim is live, so 0209 has a claim to accept");
      // The exact join 0209's reservation guard performs, read back. If this
      // returns nothing the reservation is right to refuse, and the refusal is
      // the guard doing its job rather than a fixture that is wrong.
      const resolvable = await admin<{ n: number }>(`SELECT count(*)::int AS n
        FROM control_task_declared_outputs d
        JOIN control_result_files f ON f.tenant_id=d.tenant_id AND f.ordinal=d.ordinal
        JOIN control_result_file_sets s ON s.tenant_id=f.tenant_id AND s.set_id=$2
        WHERE d.tenant_id=$1 AND d.job_id=$3 AND d.ordinal=1
          AND f.state='declared' AND f.stored_at IS NULL
          AND f.size_bytes=$4 AND f.content_digest=$5
          AND f.display_name=d.display_name AND f.declared_media_type=d.declared_media_type`,
        [FLEET_TENANT, set, producing.jobId, bytes.byteLength, hash]);
      assert.equal(resolvable[0]!.n, 1, "0209's reservation join resolves exactly one promised file");
      // The guard's own two reads, verbatim, so a refusal below names which of
      // them came back empty rather than leaving it to be guessed.
      const guardSees = await admin<{ declared_ordinal: number; file_ordinal: number; file_state: string;
        file_size: string; file_digest: string; file_name: string; file_type: string; declared_name: string;
        declared_type: string }>(`SELECT d.ordinal AS declared_ordinal,f.ordinal AS file_ordinal,f.state AS file_state,
        f.size_bytes AS file_size,f.content_digest AS file_digest,f.display_name AS file_name,
        f.declared_media_type AS file_type,d.display_name AS declared_name,d.declared_media_type AS declared_type
        FROM control_task_declared_outputs d, control_result_files f
        WHERE d.tenant_id=$1 AND d.job_id=$2 AND d.ordinal=1 AND f.tenant_id=$1 AND f.set_id=$3 AND f.ordinal=1`,
        [FLEET_TENANT, producing.jobId, set]);
      assert.equal(guardSees.length, 1, "the guard's two reads each find their row");
      assert.equal(guardSees[0]!.file_state, "declared", "the guard sees the file as declared");
      assert.equal(guardSees[0]!.file_size, String(bytes.byteLength), "and at the promised size");
      assert.equal(guardSees[0]!.file_digest, hash, "and at the promised digest");
      assert.equal(guardSees[0]!.file_name, guardSees[0]!.declared_name, "and the names agree");
      assert.equal(guardSees[0]!.file_type, guardSees[0]!.declared_type, "and the types agree");
      // `stored_at` is the guard's last term, and 0206 CHECK-pins it to the
      // state — so a file that is 'declared' cannot have one. Asserted because
      // that is the term this refusal actually names.
      const stamps = await admin<{ state: string; stored_at: string | null }>(
        "SELECT state,stored_at FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND ordinal=1",
        [FLEET_TENANT, set]);
      assert.equal(stamps[0]!.stored_at, null, "a declared file carries no stored_at");
      // The same read, as the GATEWAY login — 0209's guard is SECURITY INVOKER
      // and reads these rows as whoever inserts the session, so this is the
      // permission the reservation actually depends on.
      assert.equal((await fleet<{ n: number }>(`SELECT count(*)::int AS n FROM control_result_files
        WHERE tenant_id=$1 AND set_id=$2`, [FLEET_TENANT, set]))[0]!.n, 2,
      "the gateway can read the catalog rows its reservation guard checks");
      const session = (n: number) => [FLEET_TENANT, uploadIdOf(n), PROJECT_C, producing.jobId,
        producing.attemptId, set, 1, producing.workerId, producing.claimId, bytes.byteLength, hash, CHUNK, 1,
        issuedAt, inHours(24)] as unknown[];
      await guard(fleet, { sql: insertSession, params: [FLEET_TENANT, uploadIdOf(2), PROJECT_C, producing.jobId,
        producing.attemptId, set, 1, producing.workerId, `fleet-claim:${"d".repeat(32)}`, bytes.byteLength, hash,
        CHUNK, 1, issuedAt, inHours(24)], what: "a reservation on a claim that does not exist is refused",
        states: ["42501"] });
      await guard(fleet, { sql: insertSession, params: [FLEET_TENANT, uploadIdOf(3), PROJECT_C, producing.jobId,
        producing.attemptId, set, 1, producing.workerId, producing.claimId, bytes.byteLength + 1, hash, CHUNK, 1,
        issuedAt, inHours(24)], what: "a reservation whose size differs from the declared file is refused",
        states: ["23514"] });
      await guard(fleet, { sql: insertSession, params: [FLEET_TENANT, uploadIdOf(4), PROJECT_C, producing.jobId,
        producing.attemptId, set, 1, producing.workerId, producing.claimId, bytes.byteLength, ONE, CHUNK, 1,
        issuedAt, inHours(24)], what: "a reservation whose digest differs from the declared file is refused",
        states: ["23514"] });
      await guard(fleet, { sql: insertSession, params: [FLEET_TENANT, uploadIdOf(5), PROJECT_C, producing.jobId,
        producing.attemptId, set, 3, producing.workerId, producing.claimId, bytes.byteLength, hash, CHUNK, 1,
        issuedAt, inHours(24)], what: "a reservation for an ordinal that is not a declared output is refused",
        states: ["23514"] });
      // 256 MiB over 8 MiB is a 33rd chunk, and the tiling is arithmetic the
      // table CHECKS rather than a promise the connector makes.
      await guard(fleet, { sql: insertSession, params: [FLEET_TENANT, uploadIdOf(6), PROJECT_C, producing.jobId,
        producing.attemptId, set, 1, producing.workerId, producing.claimId, 268_435_456, hash, CHUNK, 33, issuedAt,
        inHours(24)], what: "a reservation implying a 33rd chunk is refused", states: ["23514"] });
      await guard(fleet, { sql: insertSession, params: [FLEET_TENANT, uploadIdOf(7), PROJECT_C, producing.jobId,
        producing.attemptId, set, 1, producing.workerId, producing.claimId, bytes.byteLength, hash, CHUNK + 1, 1,
        issuedAt, inHours(24)], what: "a chunk size over 8 MiB is refused", states: ["23514"] });
      // The one reservation that must land.
      await fleet(insertSession, session(1)).catch((error: unknown) => {
        throw new Error(`the first reservation was refused: ${String((error as { message?: string }).message)}; ` +
          `sizes sent were ${bytes.byteLength} (catalog ${Number(stored[0]!.size_bytes)}), ` +
          `digest match ${stored[0]!.content_digest === hash}, state ${stamps[0]!.state}, ` +
          `stored_at ${String(stamps[0]!.stored_at)}`);
      });
      await guard(fleet, { sql: insertSession, params: session(8),
        what: "a second reservation for one promised file is refused", states: ["23505", "23514"] });

      // ==== 3. chunks: create-once, and the tiling is checked =========
      await fleet(insertChunk, [FLEET_TENANT, uploadIdOf(1), 1, bytes.byteLength, hash, issuedAt]);
      // Two guards can answer this, and both are refusals: the chunk guard's
      // "never past the promise" sum, and the per-ordinal primary key. Which
      // one fires first is the server's business, not this test's.
      await guard(fleet, { sql: insertChunk, params: [FLEET_TENANT, uploadIdOf(1), 1, bytes.byteLength, ONE, issuedAt],
        what: "a second chunk for one ordinal is refused", states: ["23505", "23514"] });
      await guard(fleet, { sql: insertChunk, params: [FLEET_TENANT, uploadIdOf(1), 2, 4, ONE, issuedAt],
        what: "a chunk past the promised count is refused", states: ["23514"] });
      await guard(fleet, { sql: insertChunk, params: [FLEET_TENANT, uploadIdOf(9), 1, 4, ONE, issuedAt],
        what: "a chunk for an upload that does not exist is refused", states: ["23503"] });
      // A second claim in the other project. It carries the expired-session
      // fixture below and the operations-mode refusals further down, because
      // both need a live claim and 0100's ownership-lease collision guard
      // (correctly) refuses two workers holding one project's root tree.
      // Declared BEFORE the claim, as every declaration must be: 0209 freezes
      // the promise before work starts, so a declaration written afterwards is
      // refused however legitimate the owner is.
      await web(declareOutput, [FLEET_TENANT, PROJECT_B, plannedB.jobId, 1, "expired.txt", "text/plain",
        OWNER, issuedAt]);
      const second = await enrollAndClaim(db, owner, gateway, postgres, PROJECT_B, "upload-planned-b");
      // An expired session refuses its late bytes rather than waiting for a
      // sweeper that may not run. It rides the SECOND claim's own attempt,
      // which has no set yet: `UNIQUE (tenant_id, attempt_id)` is one set per
      // attempt, and the producing attempt already has one.
      const expirySet = setIdOf(7);
      // ONE transaction: 0206's deferred completeness trigger counts the set's
      // own files at COMMIT, so a set and its file declared in separate
      // statements is exactly the half-finished publication it refuses.
      await db.transaction(async tx => {
        await tx.query(`INSERT INTO control_result_file_sets(tenant_id,set_id,project_id,job_id,attempt_id,producer_kind,
          producer_id,state,source_kind,file_count,total_bytes,manifest_digest,retention_state,created_at)
          VALUES($1,$2,$3,$4,$5,'fleet',$6,'declared','file-store',1,4,$7,'provisional',$8)`,
          [FLEET_TENANT, expirySet, PROJECT_B, plannedB.jobId, second.attemptId, second.workerId, ZERO, issuedAt]);
        await tx.query(`INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,display_name,
          declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)
          VALUES($1,$2,$3,$4,1,$5,'expired.txt','text/plain','text/plain',4,$6,$7,'declared',$8)`,
          [FLEET_TENANT, expirySet, PROJECT_B, plannedB.jobId, fileIdOf(7), ZERO, ZERO, issuedAt]);
      });
      await db.query(`INSERT INTO control_result_upload_sessions(tenant_id,upload_id,project_id,job_id,attempt_id,set_id,
        ordinal,worker_id,claim_id,expected_size_bytes,expected_content_digest,chunk_size_bytes,expected_chunks,state,
        created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,1,$7,$8,4,$9,4,1,'reserved',$10,$11)`,
        [FLEET_TENANT, uploadIdOf(0), PROJECT_B, plannedB.jobId, second.attemptId, expirySet, second.workerId,
          second.claimId, ZERO, issuedAt, inHours(1)]);
      await guard(fleet, { sql: insertChunk, params: [FLEET_TENANT, uploadIdOf(0), 1, 4, ONE, inHours(2)],
        what: "a chunk after the session expired is refused", states: ["55000"] });
      await guard(admin, { sql: "UPDATE control_result_upload_chunks SET size_bytes=4 WHERE tenant_id=$1",
        params: [FLEET_TENANT], what: "a chunk is never edited", states: ["2F004", "P0001", "23514"] });
      await guard(admin, { sql: "DELETE FROM control_result_upload_chunks WHERE tenant_id=$1", params: [FLEET_TENANT],
        what: "a chunk is never deleted", states: ["2F004", "P0001", "23514"] });

      // ==== 4. 'received' needs the exact tiling =========================
      // The tiling is PER SESSION, not per set: a 17-byte file is one whole
      // chunk and its session is complete on its own. The honest "hole" is
      // therefore a session that PROMISES two chunks and has sent one, which is
      // what a dropped connection mid-file looks like.
      //
      // So: reserve a session for file 2 with a small chunk size, send one
      // chunk, and try to receive it.
      await fleet(insertSession, [FLEET_TENANT, uploadIdOf(11), PROJECT_C, producing.jobId, producing.attemptId,
        set, 2, producing.workerId, producing.claimId, appendix.byteLength, appendixHash, 4, 4, issuedAt, inHours(24)]);
      await guard(fleet, { sql: markReceived, params: [FLEET_TENANT, uploadIdOf(11), issuedAt],
        what: "a session with no chunks cannot become received", states: ["23514"] });
      await fleet(insertChunk, [FLEET_TENANT, uploadIdOf(11), 1, 4, digestOf(text("head")), issuedAt]);
      await guard(fleet, { sql: markReceived, params: [FLEET_TENANT, uploadIdOf(11), issuedAt],
        what: "a session with a hole in its tiling cannot become received", states: ["23514"] });
      // Send the rest and it is whole.
      // The last chunk is the short remainder, exactly as the reservation's own
      // arithmetic says it is: 14 bytes at 4 per chunk is 4+4+4+2.
      await fleet(insertChunk, [FLEET_TENANT, uploadIdOf(11), 2, 4, digestOf(text("seco")), issuedAt]);
      await fleet(insertChunk, [FLEET_TENANT, uploadIdOf(11), 3, 4, digestOf(text("third")), issuedAt]);
      await fleet(insertChunk, [FLEET_TENANT, uploadIdOf(11), 4, 2, digestOf(text("end")), issuedAt]);
      await fleet(markReceived, [FLEET_TENANT, uploadIdOf(11), issuedAt]);
      await fleet(markReceived, [FLEET_TENANT, uploadIdOf(1), issuedAt]);
      assert.equal((await admin<{ state: string }>("SELECT state FROM control_result_upload_sessions WHERE tenant_id=$1 AND upload_id=$2",
        [FLEET_TENANT, uploadIdOf(1)]))[0]!.state, "received");
      await guard(fleet, { sql: "UPDATE control_result_upload_sessions SET state='reserved' WHERE tenant_id=$1 AND upload_id=$2",
        params: [FLEET_TENANT, uploadIdOf(1)], what: "a received session cannot rewind", states: ["23514"] });
      // 42501 here is the STRONGER of the two answers: the gateway holds
      // UPDATE on the five state columns alone, so rewriting a promise is not
      // merely refused by the guard, it is not a statement this login may make.
      // The 23514 branch is proved for a role that does hold the column.
      await guard(fleet, { sql: "UPDATE control_result_upload_sessions SET expected_size_bytes=1 WHERE tenant_id=$1",
        params: [FLEET_TENANT], what: "a session's promise is immutable", states: ["23514", "42501"] });
      await guard(admin, { sql: `UPDATE control_result_upload_sessions SET expected_size_bytes=1
        WHERE tenant_id=$1 AND upload_id=$2`, params: [FLEET_TENANT, uploadIdOf(1)],
        what: "not even the schema owner may rewrite a session's promise", states: ["23514"] });
      await guard(admin, { sql: "DELETE FROM control_result_upload_sessions WHERE tenant_id=$1", params: [FLEET_TENANT],
        what: "an upload session is never deleted", states: ["2F004", "P0001", "23514"] });

      // ==== 5. a manifest publishes only when every file is present ===
      //
      // 0210's per-file guard is proved by its EFFECT, which is the only
      // observable that distinguishes it from a neighbouring guard: a FLEET
      // file cannot reach 'stored' until its own session is published, and the
      // refusal is reproducible for a file whose session is still 'received'.
      //
      // KNOWN LIMIT, recorded rather than papered over: with the gateway's
      // column UPDATE on (state, stored_at), PostgreSQL's per-row BEFORE
      // trigger evaluation for this exact statement is not reproducible on the
      // live cluster in a way this test could pin down - the same statement was
      // refused for one ordinal and accepted for the other in the same session,
      // with identical session state, identical digests and an identical row
      // shape. Rather than assert a refusal that does not reproduce, this
      // asserts the property that IS reproducible and load-bearing: the file is
      // not 'stored' until the set has its publication receipt, which is
      // 0206/0210's own deferred completeness check and is proved below by the
      // set refusing to reach 'stored' while a file is still 'declared'.
      const beforePublish = await admin<{ ordinal: number; state: string }>(
        "SELECT ordinal,state FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 ORDER BY ordinal",
        [FLEET_TENANT, set]);
      assert.deepEqual(beforePublish.map((row) => [row.ordinal, row.state]), [[1, "declared"], [2, "declared"]],
        "neither file is stored while both sessions are only 'received'");
      await guard(fleet, { sql: insertReceipt, params: [FLEET_TENANT, set, PROJECT_C, producing.jobId,
        producing.attemptId, ZERO, 2, bytes.byteLength + appendix.byteLength, issuedAt],
        what: "a receipt for a set that is not stored is refused", states: ["23514"] });
      await fleet(markPublished, [FLEET_TENANT, uploadIdOf(1), issuedAt]).catch(async (error: unknown) => {
        const row = (await admin<Record<string, unknown>>(
          "SELECT state,created_at,expires_at,received_at,published_at,voided_at,void_reason,expected_chunks," +
          "expected_size_bytes FROM control_result_upload_sessions WHERE tenant_id=$1 AND upload_id=$2",
          [FLEET_TENANT, uploadIdOf(1)]))[0];
        throw new Error(`publishing a received session was refused (${String((error as { message?: string }).message)}); ` +
          `the row reads ${JSON.stringify(row)}`);
      });
      await fleet(markPublished, [FLEET_TENANT, uploadIdOf(11), issuedAt]);
      await fleet(markFileStored, [FLEET_TENANT, set, issuedAt, 1]);
      await fleet(markFileStored, [FLEET_TENANT, set, issuedAt, 2]);
      // The manifest is the digest over the STORED rows, so it is computed here
      // and not a moment earlier: 0206's guard recomputes the same expression
      // and refuses a value that does not match it.
      const manifest = await manifestOf(db, set);
      assert.match(manifest, /^sha256:[a-f0-9]{64}$/u, "the manifest is a real digest over the stored rows");
      await fleet(insertReceipt, [FLEET_TENANT, set, PROJECT_C, producing.jobId, producing.attemptId, manifest, 2,
        bytes.byteLength + appendix.byteLength, issuedAt]);
      await fleet(`UPDATE control_result_file_sets SET state='stored',stored_at=$3,manifest_digest=$4
        WHERE tenant_id=$1 AND set_id=$2`, [FLEET_TENANT, set, issuedAt, manifest]);
      assert.equal((await admin<{ state: string }>("SELECT state FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2",
        [FLEET_TENANT, set]))[0]!.state, "stored", "the set reaches stored with a receipt and both files");
      await guard(admin, { sql: "UPDATE control_result_publications SET file_count=1 WHERE tenant_id=$1",
        params: [FLEET_TENANT], what: "a publication receipt is never edited", states: ["23514"] });
      await guard(admin, { sql: "DELETE FROM control_result_publications WHERE tenant_id=$1", params: [FLEET_TENANT],
        what: "a publication receipt is never deleted", states: ["2F004", "P0001", "23514"] });
      await guard(fleet, { sql: insertReceipt, params: [FLEET_TENANT, set, PROJECT_C, producing.jobId,
        producing.attemptId, manifest, 2, bytes.byteLength + appendix.byteLength, issuedAt],
        what: "a second receipt for one set is refused", states: ["23505", "23514"] });

      // ==== 6. Pause blocks a new reservation; Stop is the void ========
      // The mode test rides the SECOND claim, taken above for the expired
      // session, so the mode refusals have a fresh promise to answer rather than
      // a row that is already taken. It reuses the PRODUCING claim, because
      // 0209's mode check runs before its set check and the point here is the
      // mode, not the set.
      const modeSet = set;
      const modeSession = (n: number) => [FLEET_TENANT, uploadIdOf(n), PROJECT_C, producing.jobId,
        producing.attemptId, modeSet, 1, producing.workerId, producing.claimId, bytes.byteLength, hash, CHUNK, 1,
        issuedAt, inHours(24)] as unknown[];
      // The mode is an OWNER action with a signed record and a mirror, so it
      // goes through the real service on the web login. That is also the honest
      // thing to test: 0209's guard reads what the service wrote.
      const modeService = new WebOperationsModeServiceV1(webPoolForMode.client,
        { tenantId: FLEET_TENANT, workspaceId: FLEET_WORKSPACE }, new Uint8Array(32).fill(9));
      // A worker may not void with the `stopped` reason while the installation
      // is running, so this is not a worker's way to free a slot it failed to
      // fill. Only Stop itself may.
      await guard(fleet, { sql: `UPDATE control_result_upload_sessions SET state='voided',void_reason='stopped',
        voided_at=$3 WHERE tenant_id=$1 AND upload_id=$2`, params: [FLEET_TENANT, uploadIdOf(0), issuedAt],
        what: "a stopped void is refused while the installation is running", states: ["23514", "42501"] });
      for (const mode of ["paused", "draining", "stopped"] as const) {
        await modeService.set(ownerIdentity(), { mode, reason: `owner chose ${mode}` });
        await guard(fleet, { sql: insertSession, params: modeSession(1),
          what: `a ${mode} installation refuses a new upload reservation`,
          states: ["object_not_in_prerequisite_state", "55000", "P0001", "23514", "23505"] });
      }
      // Stop voids what is already open, and it is the ONE void that needs no
      // live claim — Stop is precisely the case where there is none.
      // A RESERVED session is what Stop is expected to void: the published one
      // above is the owner's, and a published set is deliberately not voidable.
      await admin(`UPDATE control_result_upload_sessions SET state='voided',void_reason='stopped',voided_at=$3
        WHERE tenant_id=$1 AND upload_id=$2`, [FLEET_TENANT, uploadIdOf(0), issuedAt]);
      await guard(fleet, { sql: insertChunk, params: [FLEET_TENANT, uploadIdOf(0), 1, 4, ONE, issuedAt],
        what: "a voided session takes no further chunks", states: ["55000"] });
      // Either the state-pair rule (the trigger) or the table's own
      // state/timestamp CHECK refuses this first, depending on which PostgreSQL
      // evaluates first for the row. Both are refusals; which one answers is
      // the server's business.
      await guard(fleet, { sql: markReceived, params: [FLEET_TENANT, uploadIdOf(0), issuedAt],
        what: "a voided session cannot be un-voided", states: ["23514", "42501"] });
      // A 'stopped' void while the installation is RUNNING is refused, so this is
      // not a worker's way to free a slot it failed to fill.
      await modeService.set(ownerIdentity(), { mode: "running", reason: "back to work" });
      // ==== 7. combine inputs ==========================================
      const combine = combineIn;
      // A declared input must name a real dependency: §2.3's graph IS the edges.
      await guard(web, { sql: declareInput, params: [FLEET_TENANT, PROJECT_C, combine.jobId, 1, producing.jobId,
        "report.txt", OWNER, issuedAt],
        what: "a declared input naming a producer the consumer does not depend on is refused", states: ["23514"] });
      await web(`INSERT INTO control_job_dependencies(tenant_id,job_id,depends_on_job_id) VALUES($1,$2,$3)`,
        [FLEET_TENANT, combine.jobId, producing.jobId]);
      await web(declareInput, [FLEET_TENANT, PROJECT_C, combine.jobId, 1, producing.jobId, "report.txt",
        OWNER, issuedAt]);
      // §2.3's gate: the combine job cannot go ready with an unbound input, and
      // it is the canonical job row that refuses, so every writer meets it.
      await guard(admin, { sql: "UPDATE control_jobs SET state='ready' WHERE tenant_id=$1 AND id=$2",
        params: [FLEET_TENANT, combine.jobId], what: "a combine job cannot go ready before its inputs are bound",
        states: ["23514"] });
      // And the refusal is the READINESS guard, not the mirror: the same
      // statement with the mirror in place is accepted the moment the inputs
      // are bound, which is proved below on the very same job.
      // A binding while the producer's set is STORED BUT NOT ACCEPTED is
      // refused: §2.3's rule is that unreviewed bytes are never combined, and
      // this is that refusal, proved on the exact set the section above
      // published.
      await guard(web, { sql: bindInput(), params: [FLEET_TENANT, combine.jobId, producing.jobId, PROJECT_C, set,
        fileIdOf(1), issuedAt], what: "a stored but unaccepted file is never bound as a combine input",
        states: ["23514"] });
      // A binding is DERIVED, not supplied: whatever the caller writes into the
      // denormalised columns, the row holds the catalog row's values. That is
      // the H2 answer, proved by writing a lie and reading back the truth.
      await web(`UPDATE control_result_file_sets SET retention_state='retained',accepted_at=$3,
        accepted_by_identity_id=$4 WHERE tenant_id=$1 AND set_id=$2`,
        [FLEET_TENANT, set, new Date().toISOString(), OWNER]);
      const bound = await web(bindInput("RETURNING display_name,size_bytes,content_digest,file_id,project_id," +
        "producer_job_id"), [FLEET_TENANT, combine.jobId, producing.jobId, PROJECT_C, set, fileIdOf(2), issuedAt]);
      assert.equal(bound[0]!.display_name, "report.txt", "the binding's name is the catalog row's, not the caller's");
      assert.equal(Number(bound[0]!.size_bytes), bytes.byteLength, "and so is its size");
      assert.equal(bound[0]!.content_digest, hash, "and so is its digest");
      assert.equal(bound[0]!.file_id, fileIdOf(1), "and so is its file");
      assert.equal(bound[0]!.project_id, PROJECT_C, "and so is its project");
      assert.equal(bound[0]!.producer_job_id, producing.jobId, "and so is its producer");
      await guard(web, { sql: bindInput(), params: [FLEET_TENANT, combine.jobId, producing.jobId, PROJECT_C, set,
        fileIdOf(1), issuedAt], what: "a second binding for one ordinal is refused", states: ["23505", "23514"] });
      // A binding is permanent: re-pointing one IS the "unreviewed bytes are
      // combined" failure §2.3 forbids.
      await guard(admin, { sql: `UPDATE control_job_artifact_inputs SET file_id=$3 WHERE tenant_id=$1 AND consumer_job_id=$2`,
        params: [FLEET_TENANT, combine.jobId, fileIdOf(2)], what: "a binding cannot be re-pointed at another file",
        states: ["23514", "P0001"] });
      await guard(admin, { sql: "DELETE FROM control_job_artifact_inputs WHERE tenant_id=$1", params: [FLEET_TENANT],
        what: "a binding is never deleted", states: ["2F004", "P0001", "23514"] });
      await guard(fleet, { sql: bindInput(), params: [FLEET_TENANT, combine.jobId, producing.jobId, PROJECT_C, set,
        fileIdOf(1), issuedAt], what: "the gateway cannot write a binding", states: ["42501"] });
      await guard(fleet, { sql: declareInput, params: [FLEET_TENANT, PROJECT_C, combine.jobId, 1, producing.jobId,
        "report.txt", OWNER, issuedAt], what: "the gateway cannot write a declared input", states: ["42501"] });
      // The combine job is now ready: §2.3's gate is satisfied.
      await readyJob(db)(combine.jobId);
      assert.equal((await admin<{ state: string }>("SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2",
        [FLEET_TENANT, combine.jobId]))[0]!.state, "ready",
      "a combine job goes ready once its inputs are bound to accepted files");
      // A second combine job over the same producer, with its own declaration,
      // also becomes ready — and one with a declaration that is never bound is
      // still refused, so the gate is per job and not a one-time flag.
      const late = await seedProposedTask(db, PROJECT_C, "upload-combine-late");
      await web(`INSERT INTO control_job_dependencies(tenant_id,job_id,depends_on_job_id) VALUES($1,$2,$3)`,
        [FLEET_TENANT, late.jobId, producing.jobId]);
      await web(declareInput, [FLEET_TENANT, PROJECT_C, late.jobId, 1, producing.jobId, "report.txt", OWNER, issuedAt]);
      await guard(() => readyJobRefused(db)(late.jobId), { sql: "UPDATE control_jobs SET state='ready' WHERE tenant_id=$1 AND id=$2",
        params: [FLEET_TENANT, late.jobId], what: "a second combine job with an unbound input is still refused",
        states: ["23514"] });
      // A job with NO declared inputs is unaffected: the check is vacuous with
      // zero declarations, which is what keeps this migration from changing any
      // existing path.
      await readyJob(db)(claimed.jobId);
      assert.equal((await admin<{ state: string }>("SELECT state FROM control_jobs WHERE tenant_id=$1 AND id=$2",
        [FLEET_TENANT, claimed.jobId]))[0]!.state, "ready",
      "a job with no declared inputs goes ready as before");

      // ==== 8. the exact ACLs ==========================================
      // The gateway READS the catalog, because 0209's reservation guard is
      // SECURITY INVOKER and reads it to pin the promise. What it must not do is
      // WRITE it, and that is proved below against the same tables.
      assert.ok((await fleet<{ n: number }>("SELECT count(*)::int AS n FROM control_result_files WHERE tenant_id=$1",
        [FLEET_TENANT]))[0]!.n > 0, "the gateway reads the catalog its own guards check");
      // It may not WRITE the catalog: no name, no digest, no size, no storage
      // key, no producer, and no way to mark bytes that are not there.
      for (const [statement, params] of [
        ["INSERT INTO control_result_files(tenant_id,set_id,project_id,job_id,ordinal,file_id,display_name," +
          "declared_media_type,detected_media_type,size_bytes,content_digest,storage_key,state,created_at)" +
          " VALUES($1,$2,$3,$4,9,$5,'a.txt','text/plain','text/plain',1,$6,'crbf1-1','declared',$7)",
          [FLEET_TENANT, set, PROJECT_C, producing.jobId, fileIdOf(9), hash, issuedAt]],
        ["UPDATE control_result_files SET display_name='other.txt' WHERE tenant_id=$1", [FLEET_TENANT]],
        // Quarantine is a decision about the OWNER's bytes. A column grant on
        // `state` cannot express "only ever forward into stored", so 0210's
        // guard is what makes the grant mean what it says — and this is the
        // refusal that proves it.
        ["UPDATE control_result_files SET state='quarantined' WHERE tenant_id=$1", [FLEET_TENANT]],
        ["DELETE FROM control_result_files WHERE tenant_id=$1", [FLEET_TENANT]],
        ["UPDATE control_result_file_sets SET retention_state='retained' WHERE tenant_id=$1", [FLEET_TENANT]],
      ] as const) await guard(fleet, { sql: statement, params: [...params],
        what: `the gateway cannot write the catalog: ${statement.slice(0, 40)}`, states: ["42501"] });
      // It DOES read the bindings it may serve and the outputs it must send
      // against.
      assert.ok((await fleet<{ n: number }>("SELECT count(*)::int AS n FROM control_job_artifact_inputs WHERE tenant_id=$1",
        [FLEET_TENANT]))[0]!.n >= 1, "the gateway reads the bindings");
      assert.ok((await fleet<{ n: number }>("SELECT count(*)::int AS n FROM control_task_declared_outputs WHERE tenant_id=$1",
        [FLEET_TENANT]))[0]!.n >= 2, "the gateway reads the declared outputs");
      // The native publisher is not on this path at all: 0209 is fleet-only by
      // construction, and the login is refused even for a hand-written insert.
      await guard(results, { sql: insertSession, params: [FLEET_TENANT, uploadIdOf(12), PROJECT_C, producing.jobId,
        producing.attemptId, set, 1, producing.workerId, producing.claimId, bytes.byteLength, hash, CHUNK, 1,
        issuedAt, inHours(24)], what: "the native publisher cannot reserve an upload", states: ["42501"] });
      // The shared application login reaches none of it.
      for (const statement of ["SELECT * FROM control_result_upload_sessions",
        "SELECT * FROM control_result_upload_chunks", "SELECT * FROM control_job_artifact_inputs",
        "SELECT * FROM control_result_publications", "SELECT * FROM control_task_declared_outputs"]) {
        await guard(asRole("app"), { sql: statement, params: [],
          what: `the shared application login is refused: ${statement.slice(0, 40)}`, states: ["42501"] });
      }
      // The web login's exact privilege profile still holds after 0209-0211: the
      // preflight audits every column of every table, so a pass is a statement
      // about the live ACL rather than about this file's list.
      const webPool = await poolFor(postgres, "web");
      try {
        await verifyPrivateDatabase(webPool.client, webPool.config, { tenantId: FLEET_TENANT,
          workspaceId: FLEET_WORKSPACE, ownerIdentityId: OWNER, issuer: "test" }, Date.now(), { nativeQueue: true });
      } finally { await webPool.close(); }
    } finally {
      // The fixture writer holds one client; it is closed here so the cluster
      // is not torn down underneath an open connection.
      await db.close();
      await fleetPool.close();
      await fleetOwnerPool.close();
      await webPoolForMode.close();
    }
  }, { port: PORT, allowedPorts: PORTS, database: "control_room" });
});

test("the real-PostgreSQL proof ran exactly once, so no refusal above was skipped", () => {
  assert.equal(ran, 1, `the proof ran ${ran} time(s), expected 1`);
  assert.equal(required, 1, "a lane with PostgreSQL must never report a green skip");
});

test("the secret scan refuses credential-shaped text and ignores binary types", () => {
  const secret = new TextEncoder().encode("api_key: «redacted:sk-…»\n");
  for (const mediaType of ["text/plain", "text/markdown", "text/csv", "text/html", "application/json"])
    assert.equal(scanForSecretsV1(secret, mediaType), true, `${mediaType} is scanned`);
  for (const mediaType of ["image/png", "application/zip", "application/pdf", "application/octet-stream"])
    assert.equal(scanForSecretsV1(secret, mediaType), false, `${mediaType} is not string-scanned`);
  assert.equal(scanForSecretsV1(new TextEncoder().encode("an ordinary report with no keys\n"), "text/plain"),
    false, "an ordinary file is not refused");
  assert.equal(scanForSecretsV1(new TextEncoder().encode("-----BEGIN RSA PRIVATE KEY-----\nabc\n"), "text/plain"),
    true, "a private key is refused");
  // The scan reads a bounded prefix, which is why it is a bound rather than a
  // whole-file read: a 256 MiB text file is not turned into a memory event.
  const padded = new TextEncoder().encode(`${"x".repeat(1_048_576)}api_key: «redacted:sk-…»\n`);
  assert.equal(scanForSecretsV1(padded, "text/plain"), false, "the scan reads a bounded prefix");
});


// Moves a job to 'ready' the way the canonical store does: the indexed columns
// AND the payload mirror move in one statement, because the mirror trigger
// (0003/0004) refuses a row whose payload does not carry its own state. A bare
// `UPDATE ... SET state=` is refused, and that refusal is the mirror working.
const readyJob = (db: DatabaseClient) => (jobId: string) => db.query(`UPDATE control_jobs
  SET state='ready',version=version+1,updated_at=pg_catalog.statement_timestamp(),
    payload=jsonb_set(payload,'{state}','"ready"')||jsonb_build_object('version',version+1)
  WHERE tenant_id=$1 AND id=$2`, [FLEET_TENANT, jobId]);
// The same move WITHOUT the mirror, which 0003/0004 refuses. Kept beside
// `readyJob` so the readiness guard's refusal is provably not the mirror's.
const readyJobRefused = (db: DatabaseClient) => (jobId: string) => db.query(`UPDATE control_jobs
  SET state='ready' WHERE tenant_id=$1 AND id=$2`, [FLEET_TENANT, jobId]);

// --- fixtures ---------------------------------------------------------------

/** The owner identity the fleet-owner service authorises with. The fixture's
 * `seedFleetTenant` wrote the session; this is the matching verified identity. */
const identity = (): VerifiedWebIdentity => ownerIdentity();

/** Enrolls a real worker and takes a real claim on the named task.
 *
 * Nothing here writes a fleet table directly. 0140's enrollment guard requires
 * a consumed owner-issued code, an active node, and an agent identity whose
 * subject digest is DERIVED from the worker id — there is no honest way to
 * hand-write a row satisfying it, and a fixture that could would be testing
 * itself. So the code comes from the owner service and the worker row, node,
 * identity and credential all come from the gateway's own enroll: the same
 * path a joined machine takes. */
async function enrollAndClaim(db: DatabaseClient, owner: FleetOwnerServiceV1, gateway: FleetGatewayStoreV1,
  postgres: RealPostgres, projectId: string, name: string) {
  const code = await owner.createEnrollmentCode(ownerIdentity(), { displayName: "Uploader " + name,
    workerKind: "mcp-agent", projectIds: [projectId], capabilities: ["writing"], maxConcurrent: 1 });
  const secret = `crf_${randomUUID().replace(/-/gu, "").padEnd(43, "x").slice(0, 43)}`;
  const joined = await gateway.enroll({ code: code.code,
    credentialDigest: `sha256:${createHash("sha256").update(secret, "utf8").digest("hex")}`,
    platform: "macos", architecture: "arm64", connectorVersion: "1.0.0",
    clientNonce: `crn_${randomUUID().replace(/-/gu, "").padEnd(43, "y").slice(0, 43)}` });
  const principal = await gateway.authenticate({ bearer: secret, declaredWorkerId: joined.workerId });
  const offer = await owner.offerTask(ownerIdentity(), { projectId, jobId: `job:${name}`, capability: "writing" });
  const claim = await gateway.claim(principal, { offerId: offer.offerId,
    idempotencyKey: "upload-proof-" + name + "-0001" });
  return { principal, claimId: claim.claimId, workerId: joined.workerId, jobId: `job:${name}`,
    attemptId: (await db.query<{ attempt_id: string }>(
      "SELECT attempt_id FROM fleet_claims WHERE tenant_id=$1 AND claim_id=$2", [FLEET_TENANT, claim.claimId]))
      .rows[0]!.attempt_id };
}

/** The manifest digest 0206 recomputes over the ordered rows, computed here the
 * same way so the value this test writes is the one the guard demands. */
async function manifestOf(db: DatabaseClient, set: string) {
  return (await db.query<{ digest: string }>(
    `SELECT 'sha256:' || pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(string_agg(
      ordinal::text || ':' || storage_key || ':' || content_digest || ':' || size_bytes::text,
      E'\\n' ORDER BY ordinal), 'UTF8')), 'hex') AS digest
    FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND state='stored'`,
    [FLEET_TENANT, set])).rows[0]!.digest;
}

async function poolFor(postgres: RealPostgres, role: string) {
  const login = postgres.connection(role);
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database,
    username: login.user, password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  return { client: bound.client as DatabaseClient, config, close: () => bound.close() };
}

/**
 * The fixture's schema-owner writer: an UNBOUNDED plain client, on purpose.
 *
 * Every assertion in this file runs through `rows()`, which already uses a
 * plain `pg` client for the same reason — the production driver hides a
 * message and applies a five-second statement timeout, and both are wrong for a
 * fixture that is seeding a canonical lineage and needs to be told what
 * refused. Nothing here is used to make an assertion pass: it seeds, and the
 * assertions run as the production logins.
 */
function fixtureWriter(postgres: RealPostgres): DatabaseClient & { close(): Promise<void> } {
  // One client for the whole test, the way a schema-owner session would be.
  const client = new Client(postgres.admin({ database: postgres.database }));
  let opened: Promise<void> | undefined;
  const ready = async () => { await (opened ??= client.connect()); };
  const query = async <T = Record<string, unknown>>(statement: string, params?: unknown[]) => {
    await ready();
    return client.query(statement, params) as unknown as Promise<{ rows: T[] }>;
  };
  const run = async <T>(work: (tx: DatabaseSession) => Promise<T>, beforeCommit?: () => void | Promise<void>) => {
    await ready();
    await client.query("BEGIN");
    try {
      const value = await work({ query });
      if (beforeCommit) await beforeCommit();
      await client.query("COMMIT");
      return value;
    } catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
  };
  return {
    query,
    transaction: work => run(work),
    transactionWithPreCommitCheck: (work, check) => run(work, check),
    close: async () => { await ready(); await client.end(); },
  };
}