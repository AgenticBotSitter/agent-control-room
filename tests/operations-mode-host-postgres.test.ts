// Real-PostgreSQL proof that the installation's Pause / Drain / Stop is
// actually composed into the Mac-local host, and that the supervisor's
// machine-health port reaches the same server-owned record the owner writes.
//
// The other suites prove the service and the HTTP handler in isolation. This
// file exists because the defect they could not see was a composition one:
// nothing passed `operationsModeIntegrityKey`, so the endpoint 404'd on a real
// installation while every service-level test passed. Everything here runs
// through the Mac-local web process's own route table, as the production
// login, so a regression in the wiring fails here.
//
// Reserved disposable-cluster lane for this file: 58710-58719.
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import test from "node:test";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createPostgresLocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import { LOCAL_OWNER_SESSION_PROFILE_V1, type LocalOwnerSessionProfileV1 } from "../src/web/v1/local-owner-session";
import { WebOperationsModeServiceV1 } from "../src/web/v1/operations-mode-service";
import { createOperationsModeSupervisorPortV1,
  OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1 } from "../src/web/v1/operations-mode-supervisor-port";
import type { DatabaseClient } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";

const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) => 58710 + index));
const PG = requiresRealPostgres();
const needsPg = () => (PG ? undefined : { skip: realPostgresSkipMessage() });

const PROVIDER = "test";
const ISSUED_AT = new Date(Date.now() - 60_000).toISOString();
const EXPIRES_AT = new Date(Date.now() + 3_600_000).toISOString();
const KEY = new Uint8Array(32).fill(73);
const TENANT = "tenant:operations-host";
const WORKSPACE = "workspace:operations-host";
const PROJECT = "project:operations-host";
const ADAPTER = "adapter:operations-host";
const OWNER = "identity:operations-host-owner";
const ORIGIN = "http://127.0.0.1:5871";
const OWNER_CODE_DIGEST = `sha256:${"b".repeat(64)}`;
const TOKEN = "a".repeat(43);
const COOKIE = `control_room_local_owner=${TOKEN}`;

const PROFILE: LocalOwnerSessionProfileV1 = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN,
  tenantId: TENANT, provider: PROVIDER, subject: OWNER, ownerCodeDigest: OWNER_CODE_DIGEST, sessionSeconds: 3600 };

/** The real token digest the local owner session derives: it binds the token
 * to the installation's own profile, so a session row keyed by anything else
 * would authenticate nothing. Computed here the same way the service does it,
 * rather than guessed, so the fixture and the verifier cannot drift. */
const LOCAL_TOKEN_DIGEST = sha256Digest({ token: TOKEN, installationBindingDigest: sha256Digest({
  schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN, tenantId: TENANT, provider: PROVIDER,
  subject: OWNER, ownerCodeDigest: OWNER_CODE_DIGEST }) });

const ownerIdentity = (): VerifiedWebIdentity => ({ provider: PROVIDER, subject: OWNER,
  tokenDigest: sha256Digest({ session: OWNER }), issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT,
  verificationExpiresAt: EXPIRES_AT });

async function seedTenant(admin: Client, owners: readonly string[] = [OWNER]) {
  const now = new Date().toISOString();
  await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [TENANT]);
  await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [WORKSPACE, TENANT]);
  await admin.query(`INSERT INTO adapter_registry
    (id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [ADAPTER, TENANT]);
  await admin.query(`INSERT INTO projects
    (id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,
     health,authority_mode,observed_at,payload,updated_at)
    VALUES($1,$2,$3,$4,$1,'1',$1,'running','fixture','healthy','control_room_native',$5,'{}',$5)`,
  [PROJECT, TENANT, WORKSPACE, ADAPTER, now]);
  await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [TENANT, PROJECT, now]);
  for (const id of owners) {
    await admin.query(`INSERT INTO control_identities
      (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human',$1,$3,$4,'active',$5,$5)`,
    [id, TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: id }), now]);
    await admin.query(`INSERT INTO control_role_grants
      (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
       require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
    [`grant:operations-host:${id}`, TENANT, id, now]);
  }
  const identity = ownerIdentity();
  for (const digest of [identity.tokenDigest, LOCAL_TOKEN_DIGEST]) {
    await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [TENANT, digest, OWNER, identity.issuedAt, identity.expiresAt]);
  }
}

function webClient(postgres: { port: number; database: string;
  connection(role: "web"): { user: string; password: string; host: string } }) {
  const login = postgres.connection("web");
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions({ host: "127.0.0.1", port: postgres.port,
    database: postgres.database, username: login.user, password: login.password, majorVersion: 17 as const }),
    host: login.host }));
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(tx)),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(tx), check) };
  return { client, close: () => bound.close() };
}

/** The Mac-local web process exactly as the host composes it, minus the socket.
 * This is the route table that answered 404 for every operations-mode call
 * before the wiring, so the test drives this object and not the service. */
function host(client: DatabaseClient, options: Readonly<{ key?: Uint8Array }> = {}) {
  return createMacLocalWebProcessV1({ origin: ORIGIN, workspaceId: WORKSPACE,
    localOwnerSession: PROFILE,
    // The signed-in session the cookie above resolves to. The store is the real
    // database-backed one, so the session is the installation's own.
    localOwnerSessionStore: createPostgresLocalOwnerSessionStoreV1(client, PROFILE),
    initialLocalOwnerSessions: [{ tokenDigest: LOCAL_TOKEN_DIGEST, issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT }],
    database: { client, close: async () => {} },
    ...(options.key ? { operationsModeIntegrityKey: options.key } : {}),
    taskWorkersStarted: false });
}

/** An API route must never fall through to the page renderer. If the wiring
 * regresses, this throws rather than returning a 200 HTML page that reads as a
 * working endpoint. */
const render = () => { throw new Error("an API route fell through to the page renderer") };

const call = (path: string, method: "GET" | "POST", body?: unknown) =>
  new Request(`${ORIGIN}${path}`, { method, headers: { cookie: COOKIE, origin: ORIGIN,
    "sec-fetch-site": "same-origin", accept: "application/json",
    ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test("the composed Mac-local host routes the operations-mode endpoint, and it is the server's state",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      const service = host(client, { key: KEY });

      // Before this wiring the host answered 404 here while every service-level
      // test passed. The route table is what was missing.
      const read = await service.handle(call("/api/v1/operations-mode", "GET"), render);
      assert.equal(read.status, 200, await read.clone().text());
      const view = await read.json() as { mode: string; revision: number; admitsNewWork: boolean };
      assert.equal(view.mode, "running");
      assert.equal(view.revision, 0, "an installation nobody has paused reports no decision, not a fabricated one");
      assert.equal(view.admitsNewWork, true);

      const posted = await service.handle(call("/api/v1/operations-mode", "POST",
        { mode: "paused", reason: "owner lunch" }), render);
      assert.equal(posted.status, 200, await posted.clone().text());
      const receipt = await posted.json() as { schema: string; mode: string; revision: number; setAt: string;
        replayed: boolean; stopRequests: null; startsWork: boolean; grantsExecutionAuthority: boolean };
      assert.deepEqual(receipt, { schema: "control-room.installation-operations-mode-receipt/v1", mode: "paused",
        revision: 1, setAt: receipt.setAt, replayed: false, stopRequests: null, startsWork: false,
        grantsExecutionAuthority: false });

      // It is the server's state, not this browser's: a separate service
      // instance over the same database, on the production login, reads the
      // same decision.
      const other = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      assert.equal((await other.read(ownerIdentity())).mode, "paused");
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[0], allowedPorts: PORTS, boundMs: 180_000 });
});

test("a host with no operations mode leaves the endpoint absent rather than showing a switch that does nothing",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      const response = await host(client).handle(call("/api/v1/operations-mode", "GET"), render);
      assert.notEqual(response.status, 200, "no key must mean no endpoint, never a default that pretends to work");
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[1], allowedPorts: PORTS, boundMs: 180_000 });
});

test("a failed health check pauses through the same recorded decision, and only pauses",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      const service = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      const port = createOperationsModeSupervisorPortV1({ target: service });

      const paused = await port.pauseNewStarts({ reasonCode: "machine_health_failed",
        observedAt: new Date().toISOString() });
      assert.equal(paused.state, "paused");
      assert.match(paused.receiptId, /^supervisor-pause:[a-f0-9]{32}$/);
      const view = await service.read(ownerIdentity());
      assert.equal(view.mode, "paused");
      assert.equal(view.reason, OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1);
      assert.equal(view.setByIdentityId, OWNER, "the record is the owner's, because the owner is who authorized it");

      // A second cycle on a still-unhealthy machine must not append a revision
      // every time, or the owner's own history disappears under machine noise.
      const again = await port.pauseNewStarts({ reasonCode: "machine_health_failed",
        observedAt: new Date().toISOString() });
      assert.equal(again.state, "already_paused");
      assert.equal((await service.read(ownerIdentity())).revision, 1,
        "an unhealthy machine must not keep appending revisions");
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM installation_operations_mode_revisions")).rows[0]!.n, 1);

      // The port cannot escalate. It has no resume and no stop: only the owner
      // can move this switch off `paused`.
      assert.deepEqual(Object.keys(port), ["pauseNewStarts"]);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[2], allowedPorts: PORTS, boundMs: 180_000 });
});

test("the same health observation always yields the same receipt id, so a duplicated cycle is visibly a duplicate",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      const service = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      const port = createOperationsModeSupervisorPortV1({ target: service });
      const observedAt = new Date().toISOString();
      const first = await port.pauseNewStarts({ reasonCode: "machine_health_failed", observedAt });
      const second = await port.pauseNewStarts({ reasonCode: "machine_health_failed", observedAt });
      assert.equal(first.receiptId, second.receiptId);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[3], allowedPorts: PORTS, boundMs: 180_000 });
});

test("a health check cannot pause an installation with no live owner grant",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      // The owner identity exists and its web session still works, but the
      // grant that authorizes an operations-mode write is gone. A health check
      // must refuse rather than write a record nobody authorized.
      await admin.query("DELETE FROM control_role_grants WHERE identity_id=$1", [OWNER]);
      const service = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      await assert.rejects(service.pauseForMachineHealth(OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1),
        /operations_mode_owner_unavailable/);
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM installation_operations_mode_revisions")).rows[0]!.n, 0);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[4], allowedPorts: PORTS, boundMs: 180_000 });
});

test("two live owners refuse the installation pause rather than choosing one",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin, [OWNER, "identity:operations-host-owner-two"]);
      const service = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      await assert.rejects(service.pauseForMachineHealth(OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1),
        /operations_mode_owner_unavailable/,
        "two owners is a refusal, not a choice of whichever row sorted first");
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM installation_operations_mode_revisions")).rows[0]!.n, 0);
      // The owner's own session path is unaffected: the refusal is specific to
      // the installation pause, not to the endpoint.
      assert.equal((await service.read(ownerIdentity())).mode, "running");
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[5], allowedPorts: PORTS, boundMs: 180_000 });
});

test("an unhealthy machine does not overwrite a mode the owner chose",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      const service = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      // The owner drains by hand first; the machine must not overwrite it.
      await service.set(ownerIdentity(), { mode: "draining", reason: "finishing tonight" });
      const port = createOperationsModeSupervisorPortV1({ target: service });
      const result = await port.pauseNewStarts({ reasonCode: "machine_health_failed",
        observedAt: new Date().toISOString() });
      assert.equal(result.state, "already_paused", "a mode the owner chose is not replaced by a machine's reason");
      const view = await service.read(ownerIdentity());
      assert.equal(view.mode, "draining");
      assert.equal(view.reason, "finishing tonight");
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[6], allowedPorts: PORTS, boundMs: 180_000 });
});
