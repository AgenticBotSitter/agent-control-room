// Live-cluster proof for src/web/v1/project-coordination-http.ts:361, the
// other `repeatableReadSnapshot` caller identified in the #403 reviews
// (alongside ProjectActivityServiceV1.read(), proved in
// tests/project-activity-postgres.test.ts).
//
// A session revoked, an identity suspended, or a grant revoked BETWEEN the
// authority's setup transaction and its page transaction must still be
// refused: the page transaction re-reads and locks identity/session/grants
// under its own REPEATABLE READ snapshot (session-authority.ts), so a
// revocation landing in that gap can never be served from stale authority.
//
// This file provisions its OWN disposable PostgreSQL 17 cluster in a temp
// directory, applies the real migrations and the real private-web grant SQL,
// and removes it in `after()`. It never connects to an existing database and
// never drops one.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { Client } from "pg";
import type { DatabaseClient } from "../src/persistence/database";
import { createPrivatePgDatabase } from "../src/web/v1/private-pg-database";
import {
  ProjectCoordinationHttpService,
  createProjectCoordinationCanonicalStoreAdapterV1,
} from "../src/web/v1/project-coordination-http";
import { WebAccessError, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANDIDATE_BINS = ([process.env.PG_BIN, "/opt/homebrew/opt/postgresql@17/bin", "/usr/lib/postgresql/17/bin"] as const)
  .filter((dir): dir is string => !!dir);
const BIN = CANDIDATE_BINS.find(dir => existsSync(join(dir, "initdb")) && existsSync(join(dir, "postgres")))
  ?? "/usr/lib/postgresql/17/bin";
const PG_AVAILABLE = existsSync(join(BIN, "initdb")) && existsSync(join(BIN, "postgres"));
const needsPg = PG_AVAILABLE ? undefined : { skip: "needs PostgreSQL 17 binaries (PG_BIN, /opt/homebrew/opt/postgresql@17/bin, or /usr/lib/postgresql/17/bin)" };
// Reserved disposable-cluster lane: 58280-58289.
const PORT = 58280;
const exec = promisify(execFile);
const native = (name: string, args: string[]) => exec(join(BIN, name), args,
  { env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: run, NODE_ENV: "test" }, timeout: 120000, maxBuffer: 1 << 26 });

// The web reader runs as a member of control_room_private_web with
// column-scoped grants, exactly the real deployed role, not an unrestricted
// login.
const PG = { host: "127.0.0.1", port: PORT, database: "cr_cc403" } as const;
const ADMIN = { ...PG, user: "cc_admin" } as const;
const WRITER = { ...PG, user: "cc_writer", password: "ccwrite" } as const;
const WEB = { ...PG, user: "cc_web", password: "ccweb" } as const;

// Run-scoped ids, suffixed with a fresh random token so a database left
// behind by an earlier run can never collide with this one.
const TOKEN = randomBytes(5).toString("hex");
const TENANT_ID = `tenant:cc-${TOKEN}`;
const WORKSPACE_ID = `ws:cc-${TOKEN}`;
const ADAPTER_ID = `adapter:cc-${TOKEN}`;
const PROJECT_ID = `project:cc-${TOKEN}`;
const IDENTITY_ID = `identity:cc-owner-${TOKEN}`;
const GRANT_ID = `grant:cc-owner-${TOKEN}`;
const sessionDigest = (label: string) => sha256Digest({ session: `cc-${label}-${TOKEN}` });

const SESSION_ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const SESSION_EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const VERIFICATION_EXPIRES_AT = new Date(Date.now() + 7 * 86_400_000).toISOString();
const PROVIDER = "test";

type Web = ReturnType<typeof createPrivatePgDatabase>;

let admin!: Client;
let writer!: Client;
let web!: Web;
let run = "";
let started = false;

before(async () => {
  if (!PG_AVAILABLE) return;
  // A disposable cluster of our own, in a temp directory, removed in
  // after(). initdb creates a brand-new cluster, and the only database in it
  // is the one created below.
  run = await mkdtemp(join(tmpdir(), "cr-cc403-"));
  const data = join(run, "data");
  await mkdir(data, { recursive: true, mode: 0o700 });
  assert.match((await native("postgres", ["--version"])).stdout, /PostgreSQL\) 17\./);
  await native("initdb", ["-D", data, "-U", "cc_admin", "--auth-local=trust", "--auth-host=trust", "--no-locale", "--encoding=UTF8"]);
  started = true;
  await native("pg_ctl", ["-D", data, "-l", join(run, "server.log"), "-w", "-t", "30", "-o",
    `-p ${PORT} -k '${run}' -c listen_addresses=127.0.0.1 -c shared_buffers=32MB -c max_connections=30`,
    "start"]);
  const bootstrap = new Client({ host: "127.0.0.1", port: PORT, database: "postgres", user: "cc_admin" });
  await bootstrap.connect();
  try { await bootstrap.query(`CREATE DATABASE ${PG.database}`); } finally { await bootstrap.end(); }
  admin = new Client(ADMIN);
  await admin.connect();
  // The exact production schema and grant SQL under review, not a substitute.
  for (const file of (await readdir(join(ROOT, "db/migrations"))).filter(name => name.endsWith(".sql")).sort())
    await admin.query(await readFile(join(ROOT, "db/migrations", file), "utf8"));
  await admin.query(await readFile(join(ROOT, "db/roles/private_web_roles.sql"), "utf8"));
  await admin.query(await readFile(join(ROOT, "db/roles/private_web_database.sql"), "utf8"));
  await admin.query(`CREATE ROLE cc_web LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD 'ccweb' IN ROLE control_room_private_web`);
  // db/roles/private_web_roles.sql does not grant control_room_private_web
  // SELECT on attention_items, but composeProjectCoordinationPage's
  // readAttention() unconditionally queries it on every read(). Without this
  // grant every coordination page read fails with permission_denied before
  // this file's proof (or any real read()) can even reach the authority
  // check under test. This is a test-local, additive grant only -- it does
  // NOT touch the production role file -- so this gap is reported
  // separately rather than silently patched in production SQL.
  await admin.query(`GRANT SELECT ON attention_items TO control_room_private_web`);
  await admin.query(`GRANT SELECT ON control_job_dependencies TO control_room_private_web`);
  await admin.query(`CREATE ROLE cc_writer LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS
    PASSWORD 'ccwrite'`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA public TO cc_writer`);
  await admin.query(`GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO cc_writer`);

  writer = new Client(WRITER);
  await writer.connect();

  await writer.query("INSERT INTO tenants(id,display_name) VALUES($1,'Coordination revocation tenant')", [TENANT_ID]);
  await writer.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,'Coordination revocation workspace')",
    [WORKSPACE_ID, TENANT_ID]);
  await writer.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    project_types,supported_read_operations,supported_commands,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'coordination_pg_fixture','fixture-v1','control_room_native','fixture','[]','[]','[]','redaction-v1',30)`,
  [ADAPTER_ID, TENANT_ID]);
  await writer.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,
    title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES($1,$2,$3,$4,$1,'fixture-v1',$1,'running','active','healthy','control_room_native',now(),'{}')`,
  [PROJECT_ID, TENANT_ID, WORKSPACE_ID, ADAPTER_ID]);
  await writer.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,now(),now())`, [TENANT_ID, PROJECT_ID]);

  const subjectDigest = sha256Digest({ provider: PROVIDER, subject: `owner-${TOKEN}` });
  await writer.query(
    `INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
     VALUES($1,$2,'human','Coordination owner',$3,$4,'active',$5,$5)`,
  [IDENTITY_ID, TENANT_ID, PROVIDER, subjectDigest, SESSION_ISSUED_AT]);
  await writer.query(
    `INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
     allow_external_effects,require_strong_factor,created_at,updated_at)
     VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
  [GRANT_ID, TENANT_ID, IDENTITY_ID, SESSION_ISSUED_AT]);
  await writer.query(
    `INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
     VALUES($1,$2,$3,$4,$5)`,
  [TENANT_ID, sessionDigest("owner"), IDENTITY_ID, SESSION_ISSUED_AT, SESSION_EXPIRES_AT]);

  // The real bounded production pool, the private read role.
  web = createPrivatePgDatabase({ host: WEB.host, port: WEB.port, database: WEB.database,
    username: WEB.user, password: WEB.password, majorVersion: 17 });
});

after(async () => {
  await web?.close().catch(() => {});
  await writer?.end().catch(() => {});
  await admin?.end().catch(() => {});
  // Always stop the cluster and remove its data directory, even after a
  // failure: a leaked postmaster holds this Mac's scarce shared memory and
  // its port. The stop happens before the removal, and a failed stop is
  // reported rather than swallowed, so a leak can never pass unnoticed.
  if (started && run) {
    try {
      await native("pg_ctl", ["-D", join(run, "data"), "-m", "immediate", "-w", "-t", "30", "stop"]);
    } catch (error) {
      process.stderr.write(`coordination cluster stop failed, removing anyway: ${String(error)}\n`);
    }
  }
  if (run) await rm(run, { recursive: true, force: true });
});

const identity = (tokenLabel: string): VerifiedWebIdentity => ({
  provider: PROVIDER, subject: `owner-${TOKEN}`, tokenDigest: sessionDigest(tokenLabel),
  issuedAt: SESSION_ISSUED_AT, expiresAt: SESSION_EXPIRES_AT, verificationExpiresAt: VERIFICATION_EXPIRES_AT,
});

const failureMessage = (reason: unknown) => {
  const code = (reason as { code?: unknown } | null)?.code;
  return [typeof code === "string" ? code : "", String(reason)].filter(Boolean).join(": ");
};

async function refuses(promise: Promise<unknown>, code: "authentication_required" | "access_denied") {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WebAccessError, `expected a WebAccessError, received ${failureMessage(error)}`);
    assert.equal(error.code, code);
    return true;
  });
}

test("coordination read: an owner identity reads the project page over a real cluster", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  const scope = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID };
  const store = createProjectCoordinationCanonicalStoreAdapterV1({ database: web.client, tenantId: TENANT_ID });
  const service = new ProjectCoordinationHttpService({ database: web.client, scope, clock: () => Date.now(), store });
  const page = await service.read(identity("owner"), PROJECT_ID);
  assert.equal(page.project.projectId, PROJECT_ID);
  assert.equal(page.coordinatorHead.state, "none");
  assert.equal(web.isAvailable(), true);
});

test("revocation between the setup and page transactions is refused", async t => {
  if (needsPg) { t.skip(needsPg.skip); return; }
  // Wraps the real web.client so the SECOND transactionWithPreCommitCheck
  // call (the page transaction; the first is repeatableReadSnapshot's setup
  // transaction) runs `hook` just before it starts. This is the exact gap
  // session-authority.ts claims is closed by the page transaction's own
  // re-read and lock of identity/session/grants.
  const between = (hook: () => Promise<void>): DatabaseClient => {
    let calls = 0;
    return Object.freeze({
      query: (statement: string, params?: unknown[]) => web.client.query(statement, params),
      transaction: callback => web.client.transaction(callback),
      transactionWithPreCommitCheck: async (callback, check) => {
        calls += 1;
        if (calls === 2) await hook();
        return web.client.transactionWithPreCommitCheck(callback, check);
      },
    } as DatabaseClient);
  };
  const scope = { tenantId: TENANT_ID, workspaceId: WORKSPACE_ID };
  const store = createProjectCoordinationCanonicalStoreAdapterV1({ database: web.client, tenantId: TENANT_ID });

  // A session revoked in the gap is refused as authentication_required. The
  // fresh token is inserted by the setup transaction itself (first use), so
  // this never touches any session another case relies on.
  {
    const fresh = { ...identity("owner"), tokenDigest: sessionDigest("between-revoke-session") };
    const service = new ProjectCoordinationHttpService({
      database: between(() => admin.query(
        "UPDATE control_web_sessions SET revoked_at=now() WHERE tenant_id=$1 AND token_digest=$2",
        [TENANT_ID, fresh.tokenDigest]).then(() => {})),
      scope, clock: () => Date.now(), store,
    });
    await refuses(service.read(fresh, PROJECT_ID), "authentication_required");
  }

  // An identity suspended in the gap is refused as access_denied. Restored
  // in finally so no later test sees a suspended coordination owner.
  {
    const fresh = { ...identity("owner"), tokenDigest: sessionDigest("between-revoke-identity") };
    try {
      const service = new ProjectCoordinationHttpService({
        database: between(() => admin.query(
          "UPDATE control_identities SET state='suspended', updated_at=now() WHERE tenant_id=$1 AND id=$2",
          [TENANT_ID, IDENTITY_ID]).then(() => {})),
        scope, clock: () => Date.now(), store,
      });
      await refuses(service.read(fresh, PROJECT_ID), "access_denied");
    } finally {
      await admin.query("UPDATE control_identities SET state='active', updated_at=now() WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, IDENTITY_ID]);
    }
  }

  // A grant revoked in the gap is refused as access_denied. Restored in
  // finally so no later test sees the owner without its wildcard grant.
  {
    const fresh = { ...identity("owner"), tokenDigest: sessionDigest("between-revoke-grant") };
    try {
      const service = new ProjectCoordinationHttpService({
        database: between(() => admin.query(
          "UPDATE control_role_grants SET revoked_at=now() WHERE tenant_id=$1 AND id=$2",
          [TENANT_ID, GRANT_ID]).then(() => {})),
        scope, clock: () => Date.now(), store,
      });
      await refuses(service.read(fresh, PROJECT_ID), "access_denied");
    } finally {
      await admin.query("UPDATE control_role_grants SET revoked_at=NULL WHERE tenant_id=$1 AND id=$2",
        [TENANT_ID, GRANT_ID]);
    }
  }

  // The owner identity is fully usable again for any later test.
  const stillValidService = new ProjectCoordinationHttpService({ database: web.client, scope, clock: () => Date.now(), store });
  const stillValid = await stillValidService.read(identity("owner"), PROJECT_ID);
  assert.equal(stillValid.project.projectId, PROJECT_ID);
  assert.equal(web.isAvailable(), true);
  t.diagnostic("revocation between setup and page transactions: session -> authentication_required, "
    + "identity suspended -> access_denied, grant revoked -> access_denied");
});
