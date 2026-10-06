// Real-PostgreSQL confirmation for the two round-6 website authorization
// candidates, and the regression proof that the fixes hold.
//
// R6W-04 — a revoked same-subject session receiving a live coordination
//          write's receipt. The production steps from the qa recipe, run here:
//          two same-subject web sessions, one revoked DURABLY in PostgreSQL,
//          the live operation held open after authorization, then the revoked
//          session's request sent many times with the same body and
//          idempotency key. Every revoked caller must be refused, and the
//          durable head/receipt counts must show ONE write.
//
// R6W-05 — coordination, skills and recurring-rule reads omitting the
//          configured workspace. Two workspaces in one tenant, one project in
//          each, the web process configured for the first, and the ordinary
//          tenant-wide owner grant the production login really carries. Every
//          sibling-workspace read AND mutation must refuse; then the same
//          matrix under a narrow project-scoped grant.
//
// What is production here, and what is fixture:
//
//   * production: the real migrations, db/roles/private_web_roles.sql, the real
//     private-web pool and driver (createPrivatePgDatabase), the real hosted
//     Access JWT verifier, the real WebSessionAuthority, the real canonical
//     store, the real HTTP handlers wired as private-process.ts wires them.
//   * fixture: identities, grants, projects and sessions are seeded through the
//     migrator login, because an installation provisions them once at setup.
//     Nothing here grants control_room_web anything the role files do not, so a
//     read that needs more authority fails 42501 instead of being papered over.
//
// Port lane follows CONTROL_ROOM_PG_TEST_PORT_BASE like its neighbours.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import { Client } from "pg";
import { privilegeClassMarkerTables, revokeMarkerClassesSql } from "./support/privilege-class-markers";
import type { DatabaseSession } from "../src/persistence/database";
import { RecurringRuleServiceV1 } from "../src/recurring/v1";
import { ReusableSkillServiceV1 } from "../src/skills/v1";
import { createAccessVerifier, type AccessTrust, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { createCoordinationHttpHandler } from "../src/web/v1/coordination-http";
import { createPrivatePgDatabase } from "../src/web/v1/private-pg-database";
import { createProjectHttpHandler } from "../src/web/v1/project-http";
import type { ProjectCoordinationCanonicalPortV1 } from "../src/project-coordination/v1/services";
import {
  ProjectCoordinationHttpService,
  createProjectCoordinationCanonicalStoreAdapterV1,
  type ProjectCoordinationCanonicalStoreAdapter,
} from "../src/web/v1/project-coordination-http";
import { createRecurringRuleHttpHandlerV1 } from "../src/web/v1/recurring-rule-http";
import { createReusableSkillHttpHandlerV1 } from "../src/web/v1/reusable-skill-http";
import { WebProjectService } from "../src/web/v1/project-service";
import { sha256Digest } from "../src/security";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_BINS = ([process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"] as const)
  .filter((dir): dir is string => !!dir);
const BIN = CANDIDATE_BINS.find(dir => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN, /opt/homebrew/opt/postgresql@17/bin, or /usr/lib/postgresql/17/bin)" };
// Reserved disposable-cluster lane: 59300-59309 by default; the test runner's
// CONTROL_ROOM_PG_TEST_PORT_BASE moves the whole lane.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59300);
const exec = promisify(execFile);
const native = (name: string, args: string[]) => exec(join(BIN, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 120_000, maxBuffer: 1 << 26 });

const PG = { host: "127.0.0.1", port: PORT, database: "cr_r6wpg" } as const;
const ADMIN = { ...PG, user: "r6w_admin" } as const;
const WRITER = { ...PG, user: "r6w_writer", password: "r6wwrite" } as const;
const WEB = { ...PG, user: "r6w_web", password: "r6wweb" } as const;

const TOKEN = randomBytes(5).toString("hex");
const TENANT = `tenant:r6w-${TOKEN}`;
const WORKSPACE = `ws:r6w-main-${TOKEN}`;
const SIBLING_WORKSPACE = `ws:r6w-sibling-${TOKEN}`;
// The adapter id ordinary project reads require: sha256 of the deployment
// scope, exactly as WebProjectService.manualAdapterId() derives it. Seeding
// anything else would make the ordinary read 404 for a reason unrelated to the
// workspace fence.
const ADAPTER = `adapter:manual:${sha256Digest({ tenantId: TENANT, workspaceId: WORKSPACE }).slice(7, 39)}`;
const PROJECT = `project:r6w-${TOKEN}`;
const SIBLING_PROJECT = `project:r6wsib-${TOKEN}`;
const IDENTITY = `identity:r6w-owner-${TOKEN}`;
const COORDINATOR = `identity:r6w-coord-${TOKEN}`;
const GRANT = `grant:r6w-owner-${TOKEN}`;
const NARROW_GRANT = `grant:r6w-narrow-${TOKEN}`;
const SUBJECT = `owner-${TOKEN}`;
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const VERIFICATION_EXPIRES_AT = new Date(Date.now() + 7 * 86_400_000).toISOString();
const sessionDigest = (label: string) => sha256Digest({ session: `r6w-${label}-${TOKEN}` });

// Hosted private web origin and a real RS256 trust pair: two JWTs of the same
// subject are two credential issuances, which is the shape R6W-04 needs.
const ORIGIN = "https://private.r6w.invalid";
const KEYS = generateKeyPairSync("rsa", { modulusLength: 2048 });
const TRUST: AccessTrust = {
  issuer: "https://access.r6w.invalid",
  audience: "r6w-app",
  keys: [{ kid: "r6w-key", jwk: KEYS.publicKey.export({ format: "jwk" }) }],
  validUntilMs: Date.now() + 3_600_000,
  maxSessionSeconds: 604_800,
};
/** A real signed assertion. `nonce` varies the bytes, hence the token digest. */
function makeToken(nonce: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "r6w-key" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify({
    iss: TRUST.issuer, aud: [TRUST.audience], sub: SUBJECT, type: "app",
    iat: Math.floor(Date.now() / 1000) - 60, exp: Math.floor(Date.now() / 1000) + 300, nonce,
  })).toString("base64url");
  return `${header}.${claims}.${sign("RSA-SHA256", Buffer.from(`${header}.${claims}`), KEYS.privateKey).toString("base64url")}`;
}

type Web = ReturnType<typeof createPrivatePgDatabase>;
let admin!: Client;
let writer!: Client;
let web!: Web;
let run = "";
let started = false;

before(async () => {
  if (!PG_AVAILABLE) return;
  run = await mkdtemp(join(tmpdir(), "cr-r6wpg-"));
  const data = join(run, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "r6w_admin", "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
  started = true;
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "30", "-o",
    `-p ${PORT} -k '${run}' -c listen_addresses=127.0.0.1 -c shared_buffers=32MB -c max_connections=60`,
    "start"]);
  const bootstrap = new Client({ host: "127.0.0.1", port: PORT, database: "postgres", user: "r6w_admin" });
  await bootstrap.connect();
  try { await bootstrap.query(`CREATE DATABASE ${PG.database}`); } finally { await bootstrap.end(); }
  admin = new Client(ADMIN);
  await admin.connect();
  for (const file of (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort())
    await admin.query(await readFile(join(ROOT, "db/migrations", file), "utf8"));
  await admin.query(await readFile(join(ROOT, "db/roles/private_web_roles.sql"), "utf8"));
  await admin.query(await readFile(join(ROOT, "db/roles/private_web_database.sql"), "utf8"));
  // The real production login, holding exactly the group role the role files
  // define and nothing more.
  await admin.query(`CREATE ROLE r6w_web LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD 'r6wweb' IN ROLE control_room_private_web`);
  await admin.query(`CREATE ROLE r6w_writer LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD 'r6wwrite'`);
  await admin.query("GRANT ALL ON ALL TABLES IN SCHEMA public TO r6w_writer");
  await admin.query("GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO r6w_writer");
  // Holding SELECT on a privilege-class marker table IS membership of that
  // class, so GRANT ALL has just made this fixture login a fleet gateway and a
  // work-intake login, and the guards then refuse its own fixture writes.
  // Production reaches a marker only by inheriting its named group role.
  await admin.query(revokeMarkerClassesSql("r6w_writer", await privilegeClassMarkerTables(ROOT)));
  writer = new Client(WRITER);
  await writer.connect();

  await writer.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  for (const workspace of [WORKSPACE, SIBLING_WORKSPACE])
    await writer.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$3)", [workspace, TENANT, workspace]);
  await writer.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'r6w_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`,
  [ADAPTER, TENANT]);
  // One project in each workspace of the SAME tenant. This is the whole shape
  // of R6W-05: a sibling workspace is private data, and a tenant-wide owner
  // grant is not a workspace boundary.
  for (const [project, workspace, title] of [
    [PROJECT, WORKSPACE, "Main workspace project"],
    [SIBLING_PROJECT, SIBLING_WORKSPACE, "Sibling workspace project"],
  ] as const) {
    await writer.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
      title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
      VALUES($1,$2,$3,$4,$1,'fixture-v1',$5,'running','active','healthy','control_room_native',now(),'{}')`,
    [project, TENANT, workspace, ADAPTER, title]);
    await writer.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,'active',1,now(),now())`, [TENANT, project]);
  }
  // The owner is the subject the assertions carry. The named coordinator is a
  // DISTINCT human identity, because (tenant, provider, subject digest) is
  // unique and self-appointment is refused anyway.
  await writer.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Coordination owner',$3,$4,'active',$5,$5)`,
  [IDENTITY, TENANT, TRUST.issuer, sha256Digest({ provider: TRUST.issuer, subject: SUBJECT }), ISSUED_AT]);
  await writer.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES($1,$2,'human','Named coordinator',$3,$4,'active',$5,$5)`,
  [COORDINATOR, TENANT, TRUST.issuer, sha256Digest({ provider: TRUST.issuer, subject: `coordinator-${TOKEN}` }), ISSUED_AT]);
  // The ordinary tenant-wide owner grant the production login really carries.
  await writer.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`, [GRANT, TENANT, IDENTITY, ISSUED_AT]);
  // A narrow project-scoped grant, REVOKED for every default-path assertion and
  // restored only inside the narrow-grant cases below.
  await writer.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,revoked_at,created_at,updated_at)
    VALUES($1,$2,$3,'owner','["*"]',$4::jsonb,'critical',true,false,now(),$5,$5)`,
  [NARROW_GRANT, TENANT, IDENTITY, JSON.stringify([PROJECT]), ISSUED_AT]);

  web = createPrivatePgDatabase({ host: WEB.host, port: WEB.port, database: WEB.database,
    username: WEB.user, password: WEB.password, majorVersion: 17 });
});

after(async () => {
  await web?.close().catch(() => {});
  await writer?.end().catch(() => {});
  await admin?.end().catch(() => {});
  if (started && run) {
    try {
      await native("pg_ctl", ["-D", join(run, "data"), "-m", "immediate", "-w", "-t", "30", "stop"]);
    } catch (error) {
      process.stderr.write(`r6wpg cluster stop failed, removing anyway: ${String(error)}\n`);
    }
  }
  if (run) await rm(run, { recursive: true, force: true });
});

/** Resolve the identity a real assertion verifies to, exactly as the route does. */
const verifiedIdentity = (token: string): VerifiedWebIdentity =>
  createAccessVerifier(TRUST)(new Request(`${ORIGIN}/x`, { headers: { "cf-access-jwt-assertion": token } }),
    Date.now());

/** The production default path: real services over the real web pool and scope. */
const productionScope = { tenantId: TENANT, workspaceId: WORKSPACE };
const productionStore = () => createProjectCoordinationCanonicalStoreAdapterV1({
  database: web.client, tenantId: TENANT, workspaceId: WORKSPACE });
const productionService = () => new ProjectCoordinationHttpService({
  database: web.client, scope: productionScope, clock: () => Date.now(), store: productionStore() });

/** The real coordination handler, wired as private-process.ts wires it. */
function coordinationHandler(service = productionService()) {
  return createCoordinationHttpHandler({
    origin: ORIGIN, trust: TRUST, service, clock: () => Date.now(),
    authorizeCaller: async (verified, projectId) => { await service.authorizeCaller(verified, projectId); },
  });
}

async function insertSession(token: string): Promise<VerifiedWebIdentity> {
  const identity = verifiedIdentity(token);
  await writer.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
    VALUES($1,$2,$3,$4,$5)`, [TENANT, identity.tokenDigest, IDENTITY, identity.issuedAt, identity.expiresAt]);
  return identity;
}

const coordinationPost = (token: string, key: string, body: unknown, projectId = PROJECT) =>
  coordinationHandler()(new Request(`${ORIGIN}/api/v1/projects/${encodeURIComponent(projectId)}/coordination/appoint-coordinator`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-access-jwt-assertion": token,
      "idempotency-key": key },
    body: JSON.stringify(body),
  }));

// ---------------------------------------------------------------------------
// R6W-04
// ---------------------------------------------------------------------------

test("R6W-04: a durably revoked same-subject session is refused every coalesced follower request", { timeout: 180_000 }, async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // Two sessions of ONE subject. The verifier produces a distinct tokenDigest
  // per assertion and both rows exist, so this is the real two-credential
  // shape rather than one credential counted twice.
  const liveToken = makeToken("live"), revokedToken = makeToken("revoked");
  const live = await insertSession(liveToken);
  const revoked = await insertSession(revokedToken);
  assert.equal(live.subject, revoked.subject, "one subject, two credentials");
  assert.notEqual(live.tokenDigest, revoked.tokenDigest);
  // Sessions are revoked rather than deleted, because control_web_sessions is
  // append-only for the same reason control_project_coordinator_heads is: a
  // revocation is a fact, not an erasure. The coordinator head and the
  // idempotency receipts cannot be removed at all, and do not need to be -- the
  // whole cluster is this run's and `after` removes the data directory.
  t.after(async () => {
    await admin.query("UPDATE control_web_sessions SET revoked_at=coalesce(revoked_at,now()) WHERE tenant_id=$1 AND token_digest=ANY($2::text[])",
      [TENANT, [live.tokenDigest, revoked.tokenDigest]]).catch(() => {});
  });

  // Revoke the second session DURABLY, exactly as the production steps require.
  await writer.query("UPDATE control_web_sessions SET revoked_at=now() WHERE tenant_id=$1 AND token_digest=$2",
    [TENANT, revoked.tokenDigest]);

  const version = Number((await durableHeads())[PROJECT] ? 1 : 0);
  const revision = { projectId: PROJECT, expectedCoordinatorVersion: version, expectedPolicyVersion: 0,
    expectedConflictsVersion: 0, expectedAttentionVersion: 0, observedAt: new Date().toISOString() };
  const body = { revision, coordinatorActorType: "human", coordinatorIdentityId: COORDINATOR };

  // Control 1: alone, the revoked credential is refused 401, so the authority
  // really does see the durable revocation.
  const alone = await coordinationPost(revokedToken, "r6w-coalesce-key-0001", body);
  assert.equal(alone.status, 401, `sequential revoked control: ${await alone.clone().text()}`);
  assert.equal((await durableHeads())[PROJECT] ?? 0, 0, "the refused control wrote nothing");

  // Control 2: the live credential alone performs the durable write.
  const succeeded = await coordinationPost(liveToken, "r6w-coalesce-key-0001", body);
  assert.equal(succeeded.status, 200, `live control: ${await succeeded.clone().text()}`);
  assert.equal((await succeeded.json() as { status: string }).status, "accepted");

  // THE DEFECT WINDOW. A live operation is parked at the durable engine -- where
  // a real coordinator write spends its time, inside its own transaction -- and
  // the revoked credential's request is repeated against it with the same body
  // and idempotency key. Before the fix, the coalescing map answered each of
  // these from the leader's promise with the leader's receipt and no check of the
  // follower's own credential.
  //

  /** One parked leader: a fresh gate, a fresh handler over the same store. */
  const parkedLeader = (key: string) => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const onEnter = new Promise<void>(resolve => { entered = resolve; });
    const park = { release, gate, onEnter };
    // The gate rides on the engine port bound to the leader's AMBIENT session.
    // Delegating to the pool-bound port instead (the first attempt) opened a
    // second connection, and the session transaction's FOR UPDATE lock timed out
    // as 55P03 -- a 503 leader, which would have masked the thing being measured.
    const gated = (port: ProjectCoordinationCanonicalPortV1): ProjectCoordinationCanonicalPortV1 =>
      Object.freeze({ ...port, assignProjectCoordinatorV1: async (
        input: Parameters<ProjectCoordinationCanonicalPortV1["assignProjectCoordinatorV1"]>[0],
      ) => {
        if (input.idempotencyKey === key) { entered(); await gate; }
        return port.assignProjectCoordinatorV1(input);
      } });
    const store: ProjectCoordinationCanonicalStoreAdapter = Object.freeze({
      ...productionStore(),
      coordinator: gated(productionStore().coordinator),
      bindSession: (session: DatabaseSession) => {
        const bound = productionStore().bindSession!(session);
        return Object.freeze({ ...bound, coordinator: gated(bound.coordinator) });
      },
    });
    const service = new ProjectCoordinationHttpService({
      database: web.client, scope: productionScope, clock: () => Date.now(), store });
    const handler = createCoordinationHttpHandler({
      origin: ORIGIN, trust: TRUST, service, clock: () => Date.now(),
      authorizeCaller: async (verified, projectId) => { await service.authorizeCaller(verified, projectId); },
    });
    const post = (token: string, requestKey: string) => handler(new Request(
      `${ORIGIN}/api/v1/projects/${encodeURIComponent(PROJECT)}/coordination/appoint-coordinator`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN, "cf-access-jwt-assertion": token,
          "idempotency-key": requestKey },
        body: JSON.stringify(body),
      }));
    return { post, park };
  };

  // Two shapes of the same overlap, measured separately.
  //
  // 1. ONE follower at a time. This is the shape that exposes the defect with no
  //    confound: the leader holds one pool connection, the follower needs one,
  //    and the answer therefore reflects authorization rather than capacity.
  // 2. A concurrent burst, to find where the pool runs out and to confirm that
  //    even at that point nothing receives a receipt.
  //
  // (2) alone is not enough: the pool is `max: 8`, so an oversized burst
  // produces 503s that would hide a leaked receipt behind a capacity answer.
  const concurrent = async (count: number, run: (token: string, key: string) => Promise<Response>, key: string) =>
    (await Promise.all(Array.from({ length: count }, () => run(revokedToken, key)))).map(response => response.status);

  // Overlap 1, sequential follower: the follower joins the leader's in-flight
  // promise and waits for it exactly as a real coalesced client would. One at a
  // time, so the answer reflects authorization rather than pool capacity: the
  // leader holds one connection and the follower needs one, and nothing else is
  // competing.
  const a = parkedLeader("r6w-coalesce-key-0002");
  const leaderA = a.post(liveToken, "r6w-coalesce-key-0002");
  await a.park.onEnter;
  const oneFollower = await a.post(revokedToken, "r6w-coalesce-key-0002");
  const oneFollowerStatus = oneFollower.status;
  const oneFollowerBody = await oneFollower.clone().text();
  a.park.release();
  const leaderAResponse = await leaderA;
  // THE DEFECT, stated as one property and checked FIRST: a revoked credential
  // must never be told that a write it did not authorize succeeded. A receipt is
  // exactly that, so this is checked before anything about the leader's own
  // outcome, which under a leak is not the interesting answer.
  assert.notEqual(oneFollowerStatus, 200,
    `a durably revoked session received the live caller's receipt: ${oneFollowerBody.slice(0, 200)}`);
  assert.doesNotMatch(oneFollowerBody, /accepted/,
    "the revoked follower received an accepted outcome envelope");
  assert.equal(oneFollowerStatus, 401,
    `the revoked follower must be refused authentication_required, not ${oneFollowerStatus}: ${
      oneFollowerBody.slice(0, 200)}`);
  assert.equal(leaderAResponse.status, 200,
    `the live caller's own write must succeed: ${await leaderAResponse.clone().text()}`);

  // Overlap 2, same shape on a FRESH in-flight slot, plus the live caller's own
  // coalescing on that key -- the optimization the fix must not have broken.
  const b = parkedLeader("r6w-coalesce-key-0003");
  const leaderB = b.post(liveToken, "r6w-coalesce-key-0003");
  await b.park.onEnter;
  const followerB = await b.post(revokedToken, "r6w-coalesce-key-0003");
  const followerBStatus = followerB.status;
  const followerBBody = await followerB.clone().text();
  const liveFollower = b.post(liveToken, "r6w-coalesce-key-0003");
  b.park.release();
  const [leaderBResponse, liveFollowerResponse] = await Promise.all([leaderB, liveFollower]);
  assert.deepEqual([leaderBResponse.status, liveFollowerResponse.status], [200, 200],
    "the live caller's own coalescing must still work after the fix");
  assert.deepEqual(await leaderBResponse.clone().json(), await liveFollowerResponse.clone().json(),
    "a coalesced follower of the SAME caller receives the leader's outcome, as designed");
  assert.notEqual(followerBStatus, 200,
    `a durably revoked session received the live caller's receipt on the second overlap: ${
      followerBBody.slice(0, 200)}`);
  assert.equal(followerBStatus, 401,
    `the second revoked follower must be refused authentication_required, not ${followerBStatus}`);

  // Overlap 3, a concurrent burst on a third fresh slot: load, not capacity
  // confusion. Every follower must be refused, and none may receive a receipt.
  const c = parkedLeader("r6w-coalesce-key-0004");
  const leaderC = c.post(liveToken, "r6w-coalesce-key-0004");
  await c.park.onEnter;
  const AT_CAPACITY = 6;
  const burst = await concurrent(AT_CAPACITY, c.post, "r6w-coalesce-key-0004");
  c.park.release();
  assert.equal((await leaderC).status, 200, "the third live write must succeed");
  assert.equal(burst.filter(status => status === 200).length, 0,
    `a revoked follower received the leader's receipt under load (${burst.join(",")})`);
  assert.equal(burst.length, AT_CAPACITY);

  // Every follower answer across all three overlaps: no 200 anywhere, and at
  // this pool occupancy every refusal is a credential refusal rather than a
  // capacity answer. Reported rather than folded into "refused".
  const followerStatuses = [oneFollowerStatus, followerBStatus, ...burst];
  assert.deepEqual([...new Set(followerStatuses)], [401],
    `with one leader and ${AT_CAPACITY + 1} followers against a pool of max: 8, every refusal should be a `
    + `401 credential answer; saw ${[...new Set(followerStatuses)].join(",")}`);
  t.diagnostic(`R6W-04 coalescing measurement (production pool max: 8, one connection held by each parked `
    + `leader): two sequential followers -> 401 each; a ${AT_CAPACITY}-way concurrent burst -> `
    + `${[...new Set(burst)].join(",")}; the live caller coalescing on the same key -> 200. No follower `
    + `received a receipt at any size.`);

  // The durable truth: one coordinator head, one receipt per real write. Twelve
  // revoked followers across two overlaps produced neither.
  assert.equal((await durableHeads())[PROJECT], 1,
    "one durable coordinator head; every follower added none");
  const receipts = await web.client.query<{ n: string }>(
    "SELECT count(*)::text n FROM control_idempotency WHERE tenant_id=$1 AND operation_scope='project-coordinator-lifecycle'",
    [TENANT]);
  assert.equal(Number(receipts.rows[0]!.n), 4, "one durable receipt per real write, none per follower");
  const audit = await web.client.query<{ n: string }>(
    "SELECT count(DISTINCT assigned_by_owner_identity_id)::text n FROM control_project_coordinator_heads WHERE tenant_id=$1 AND project_id=$2",
    [TENANT, PROJECT]);
  assert.equal(Number(audit.rows[0]!.n), 1,
    "every durable coordinator assignment is attributed to the one live owner identity");

  // After the overlap, the revoked credential is still refused on its own: the
  // fix is not a one-shot guard, and the refusal is not order-dependent.
  assert.equal((await coordinationPost(revokedToken, "r6w-coalesce-key-0002", body)).status, 401);
  // A credential whose session row was never created cannot join this caller's
  // slot either -- the key binds the issuance, not the subject.
  const foreign = makeToken("live-again");
  assert.equal((await coordinationPost(foreign, "r6w-coalesce-key-0002", body)).status, 401,
    "an assertion whose session row does not exist is refused, never coalesced onto a stranger's result");
});

/** Durable coordinator heads per project, read through the production login. */
async function durableHeads(): Promise<Record<string, number>> {
  const rows = await web.client.query<{ project_id: string; n: string }>(
    "SELECT project_id,count(*)::text n FROM control_project_coordinator_heads WHERE tenant_id=$1 GROUP BY project_id",
    [TENANT]);
  return Object.fromEntries(rows.rows.map(row => [row.project_id, Number(row.n)]));
}


// ---------------------------------------------------------------------------
// R6W-05
// ---------------------------------------------------------------------------

test("R6W-05: coordination, skills and recurring-rule reads and writes refuse a sibling workspace's project", { timeout: 120_000 }, async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  const token = makeToken("sibling");
  const identity = await insertSession(token);
  t.after(async () => {
    await admin.query("DELETE FROM control_web_sessions WHERE tenant_id=$1 AND token_digest=ANY($2::text[])",
      [TENANT, [identity.tokenDigest]]);
  });

  // Real private content in the sibling workspace's project, written by the
  // migrator so the production login reads it as stored data, not as a fake.
  const skillId = `skill:r6w-${TOKEN}`;
  await writer.query(`INSERT INTO control_skills(tenant_id,project_id,skill_id,name,current_version,state,
    created_by_identity_id,created_at,updated_at) VALUES($1,$2,$3,'Sibling skill',1,'active',$4,now(),now())`,
  [TENANT, SIBLING_PROJECT, skillId, IDENTITY]);
  await writer.query(`INSERT INTO control_skill_versions(tenant_id,project_id,skill_id,version,name,instructions,
    content_digest,created_by_identity_id,created_at)
    VALUES($1,$2,$3,1,'Sibling skill','Private sibling skill instructions',$4,$5,now())`,
  [TENANT, SIBLING_PROJECT, skillId,
    sha256Digest({ schema: "control-room.reusable-skill/v1", skillId, version: 1, name: "Sibling skill",
      instructions: "Private sibling skill instructions" }), IDENTITY]);
  const ruleId = `recurring-rule:r6w-${TOKEN}`;
  await writer.query(`INSERT INTO control_recurring_rules(tenant_id,project_id,rule_id,state,plain_schedule,
    cron_expression,timezone,task_template,version,created_by_identity_id,updated_by_identity_id,created_at,
    updated_at,last_evaluated_at)
    VALUES($1,$2,$3,'active','every Monday at 9','0 9 * * 1','UTC',
      $4::jsonb,1,$5,$5,now(),now(),now())`,
  [TENANT, SIBLING_PROJECT, ruleId,
    JSON.stringify({ title: "Sibling recurring task", instructions: "Private sibling rule instructions",
      requiredCapability: "task.proposal.review" }), IDENTITY]);

  const auth = { "cf-access-jwt-assertion": token };
  const projectId = encodeURIComponent(SIBLING_PROJECT);
  const coordination = coordinationHandler();
  const skills = createReusableSkillHttpHandlerV1({ origin: ORIGIN, trust: TRUST,
    service: new ReusableSkillServiceV1(web.client, productionScope, () => Date.now()) });
  const recurring = createRecurringRuleHttpHandlerV1({ origin: ORIGIN, trust: TRUST,
    service: new RecurringRuleServiceV1(web.client, productionScope, () => Date.now()) });
  // The ordinary project read, as the comparison surface the fix routes
  // everything else through.
  const ordinary = createProjectHttpHandler({ origin: ORIGIN, trust: TRUST,
    service: new WebProjectService(web.client, productionScope, () => Date.now()) });

  // Positive control first: the SAME handlers and the SAME caller succeed for
  // the configured workspace's project. A matrix that refused everything would
  // prove nothing about the fence.
  const own = encodeURIComponent(PROJECT);
  assert.equal((await ordinary(new Request(`${ORIGIN}/api/v1/projects/${own}`, { headers: auth }))).status, 200);
  assert.equal((await coordination(new Request(`${ORIGIN}/api/v1/projects/${own}/coordination`, { headers: auth }))).status, 200);
  assert.equal((await skills(new Request(`${ORIGIN}/api/v1/projects/${own}/skills`, { headers: auth }))).status, 200);
  assert.equal((await recurring(new Request(`${ORIGIN}/api/v1/projects/${own}/recurring-rules`, { headers: auth }))).status, 200);

  // The defect, exactly as the recipe states it: under the ordinary wildcard
  // owner grant, every sibling-workspace surface must refuse.
  const refusals: [string, number][] = [];
  const read = async (label: string, run: Promise<Response>) => {
    const response = await run;
    const text = await response.clone().text();
    assert.doesNotMatch(text, /Sibling workspace|Private sibling/,
      `${label} disclosed sibling-workspace data: ${text.slice(0, 200)}`);
    refusals.push([label, response.status]);
    return response;
  };
  // The four READ surfaces, in the same order as the absent-project matrix
  // below, so the oracle check compares like with like.
  await read("ordinary project read", ordinary(new Request(`${ORIGIN}/api/v1/projects/${projectId}`, { headers: auth })));
  await read("coordination page", coordination(new Request(`${ORIGIN}/api/v1/projects/${projectId}/coordination`, { headers: auth })));
  await read("skills catalog", skills(new Request(`${ORIGIN}/api/v1/projects/${projectId}/skills`, { headers: auth })));
  await read("recurring catalog", recurring(new Request(`${ORIGIN}/api/v1/projects/${projectId}/recurring-rules`, { headers: auth })));
  // Every MUTATION surface too: a fence that refuses the read but accepts the
  // write would still be a data-exposure and integrity boundary failure.
  // The create needs its per-action idempotency key (int8's create contract), or it
  // is refused as malformed before it ever reaches the workspace fence under test.
  await read("skill create", skills(new Request(`${ORIGIN}/api/v1/projects/${projectId}/skills`, {
    method: "POST", headers: { ...auth, "content-type": "application/json", origin: ORIGIN,
      "idempotency-key": "r6w-sibling-skill-create-0001" },
    body: JSON.stringify({ name: "Attempted", instructions: "Attempted cross-workspace creation." }) })));
  await read("recurring create", recurring(new Request(`${ORIGIN}/api/v1/projects/${projectId}/recurring-rules`, {
    method: "POST", headers: { ...auth, "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ schedule: "every Monday at 9", timezone: "UTC", title: "Attempted",
      instructions: "Attempted cross-workspace creation." }) })));
  await read("skill update", skills(new Request(`${ORIGIN}/api/v1/projects/${projectId}/skills/${encodeURIComponent(skillId)}`, {
    method: "PUT", headers: { ...auth, "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ expectedVersion: 1, instructions: "Attempted cross-workspace edit." }) })));
  await read("recurring update", recurring(new Request(`${ORIGIN}/api/v1/projects/${projectId}/recurring-rules/${encodeURIComponent(ruleId)}`, {
    method: "PUT", headers: { ...auth, "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ expectedVersion: 1, schedule: "every Monday at 9", timezone: "UTC", title: "Attempted",
      instructions: "Attempted cross-workspace edit." }) })));
  await read("recurring pause", recurring(new Request(
    `${ORIGIN}/api/v1/projects/${projectId}/recurring-rules/${encodeURIComponent(ruleId)}/pause`, {
      method: "POST", headers: { ...auth, "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ paused: true, expectedVersion: 1 }) })));
  // Every sibling-workspace surface refused, and refused with a client error,
  // never a 200 and never a 5xx that would invite a retry loop.
  for (const [label, status] of refusals) {
    assert.ok(status === 403 || status === 404, `${label} answered ${status}, expected a refusal`);
  }

  // An absent project must look exactly like a sibling-workspace project, or
  // these endpoints become a probe for the existence of another workspace's
  // project.
  const absent = encodeURIComponent(`project:r6wabsent-${TOKEN}`);
  const absentStatuses = await Promise.all([
    ordinary(new Request(`${ORIGIN}/api/v1/projects/${absent}`, { headers: auth })),
    coordination(new Request(`${ORIGIN}/api/v1/projects/${absent}/coordination`, { headers: auth })),
    skills(new Request(`${ORIGIN}/api/v1/projects/${absent}/skills`, { headers: auth })),
    recurring(new Request(`${ORIGIN}/api/v1/projects/${absent}/recurring-rules`, { headers: auth })),
  ]);
  for (const [index, [label, status]] of refusals.slice(0, 4).entries()) {
    assert.equal(status, absentStatuses[index]!.status,
      `${label} answers a sibling-workspace project differently (${status}) from an absent one (${
        absentStatuses[index]!.status}); the difference is an existence oracle`);
  }

  // Nothing was written into the sibling workspace by any of the refusals.
  const siblings = await web.client.query<{ n: string }>(
    `SELECT (SELECT count(*)::text FROM control_skills WHERE tenant_id=$1 AND project_id=$2) AS skills,
            (SELECT count(*)::text FROM control_recurring_rules WHERE tenant_id=$1 AND project_id=$2) AS rules,
            (SELECT count(*)::text FROM control_skill_versions WHERE tenant_id=$1 AND project_id=$2) AS versions`,
    [TENANT, SIBLING_PROJECT]);
  assert.deepEqual(siblings.rows[0], { skills: "1", rules: "1", versions: "1" },
    "a refused cross-workspace request changed the sibling workspace's rows");
  const unchanged = await writer.query<{ instructions: string }>(
    "SELECT instructions FROM control_skill_versions WHERE tenant_id=$1 AND project_id=$2 AND skill_id=$3",
    [TENANT, SIBLING_PROJECT, skillId]);
  assert.equal(unchanged.rows[0]!.instructions, "Private sibling skill instructions");

  // Narrow-grant control: with ONLY the configured project's grant live (the
  // tenant-wide grant revoked), the grant check refuses on its own and the
  // workspace fence is not what stopped it.
  await writer.query("UPDATE control_role_grants SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2", [TENANT, NARROW_GRANT]);
  try {
    assert.equal((await ordinary(new Request(`${ORIGIN}/api/v1/projects/${own}`, { headers: auth }))).status, 200,
      "the narrow grant still permits the configured project");
    for (const [label, run] of [
      ["ordinary project read", ordinary(new Request(`${ORIGIN}/api/v1/projects/${projectId}`, { headers: auth }))],
      ["coordination page", coordination(new Request(`${ORIGIN}/api/v1/projects/${projectId}/coordination`, { headers: auth }))],
      ["skills catalog", skills(new Request(`${ORIGIN}/api/v1/projects/${projectId}/skills`, { headers: auth }))],
      ["recurring catalog", recurring(new Request(`${ORIGIN}/api/v1/projects/${projectId}/recurring-rules`, { headers: auth }))],
    ] as const) {
      const response = await run;
      // 403 (grant refuses) or 404 (the workspace fence answers first) are both
      // refusals. What must never happen is a 200: that is the exposure.
      assert.ok(response.status === 403 || response.status === 404,
        `${label} under a narrow grant answered ${response.status}: ${await response.clone().text()}`);
    }
  } finally {
    await writer.query("UPDATE control_role_grants SET revoked_at=now() WHERE tenant_id=$1 AND id=$2", [TENANT, NARROW_GRANT]);
  }
});

test("R6W-05: the coordination store refuses to resolve a project without a configured workspace", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // A deployment that forgets the workspace must not silently serve a
  // tenant-wide project lookup: the adapter REFUSES to resolve, loudly.
  const unfenced = createProjectCoordinationCanonicalStoreAdapterV1({ database: web.client, tenantId: TENANT });
  await assert.rejects(unfenced.project(PROJECT), /coordination_store_workspace_not_configured/);
  // An empty workspace is refused at construction, not treated as "no fence".
  assert.throws(() => createProjectCoordinationCanonicalStoreAdapterV1({
    database: web.client, tenantId: TENANT, workspaceId: "" }), /coordination_store_workspace_invalid/);
});

test("the R6W-04 and R6W-05 real-PostgreSQL proofs ran when PostgreSQL is available", () => {
  assert.equal(web.isAvailable(), true);
  assert.equal(PG_AVAILABLE, true);
});