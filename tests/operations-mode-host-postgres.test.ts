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
// The reserved disposable-cluster lane for this file is 58710-58719 by
// default and moves with CONTROL_ROOM_PG_TEST_PORT_BASE.
import assert from "node:assert/strict";
import { Client, Pool } from "pg";
import test from "node:test";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { createMacLocalProtectedHostV1 } from "../src/web/v1/mac-local-host";
import { createPostgresLocalOwnerSessionStoreV1 } from "../src/web/v1/local-owner-session-store";
import { LOCAL_OWNER_SESSION_PROFILE_V1, type LocalOwnerSessionProfileV1 } from "../src/web/v1/local-owner-session";
import { handlePrivateWebRequest } from "../src/web/v1/private-process";
import { WebOperationsModeServiceV1 } from "../src/web/v1/operations-mode-service";
import { createOperationsModeSupervisorPortV1,
  OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1 } from "../src/web/v1/operations-mode-supervisor-port";
import type { DatabaseClient } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";

const PORTS = Object.freeze(Array.from({ length: 10 }, (_, index) =>
  Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58710) + index));
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
/** Two tests bind a real listener, so each takes its own port on the reserved
 * disposable lane. The origin is derived from the port because the local owner
 * session's token digest binds to its own profile origin. */
const PORT = PORTS[5];
const SUPERVISOR_PORT = PORTS[6];
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OWNER_CODE_DIGEST = `sha256:${"b".repeat(64)}`;
const TOKEN = "a".repeat(43);
const COOKIE = `control_room_local_owner=${TOKEN}`;

const PROFILE: LocalOwnerSessionProfileV1 = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: ORIGIN,
  tenantId: TENANT, provider: PROVIDER, subject: OWNER, ownerCodeDigest: OWNER_CODE_DIGEST, sessionSeconds: 3600 };

/** The real token digest the local owner session derives for a given origin:
 * it binds the token to the installation's own profile, so a session row keyed
 * by anything else would authenticate nothing. Computed here the way the
 * service does it, rather than guessed, so the fixture and the verifier cannot
 * drift. */
const localTokenDigest = (origin: string) => sha256Digest({ token: TOKEN, installationBindingDigest: sha256Digest({
  schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin, tenantId: TENANT, provider: PROVIDER,
  subject: OWNER, ownerCodeDigest: OWNER_CODE_DIGEST }) });
const LOCAL_TOKEN_DIGEST = localTokenDigest(ORIGIN);

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
  for (const digest of [identity.tokenDigest, LOCAL_TOKEN_DIGEST,
    localTokenDigest(`http://127.0.0.1:${SUPERVISOR_PORT}`)]) {
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
    database: { client, close: async () => {}, isAvailable: () => true },
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

/** A task application that records the input the protected host gave it, and
 * exposes the coordinator's own stop methods so the host can attach them. */
function taskApplicationSpy() {
  const seen: { supervisor?: unknown } = {};
  const application = {
    revoked: [] as string[],
    // A batch key is configured, so the host requires the coordinator's own
    // batch authority and its web snapshot view. These are inert stand-ins:
    // this test exercises the operations port, not queue admission.
    operations: {}, isReady: () => true, close: async () => {},
    queueDelivery: undefined, queueRecovery: undefined,
    workBatchAuthority: { assertCurrent: () => true, isAcceptedResultCurrent: async () => true },
    workBatchView: { binding: "coordinator_snapshot" as const, assertCurrent: () => true,
      isAcceptedResultCurrent: async () => true, acceptedResultProof: async () => null },
    // The installation's running work, as the coordinator's own login sees it:
    // one genuinely running lease, which `stopped` must revoke.
    listRunning: async () => (application.revoked.length ? [] : [{ jobId: "job:running", attemptId: "job:running:a",
      leaseId: "job:running:l", leaseEpoch: 1, attemptVersion: 1, jobVersion: 1, projectId: PROJECT }]),
    revokeRunning: async (input: { jobId: string }) => { application.revoked.push(input.jobId); return "revoked" as const; } };
  return Object.freeze({ seen, application: Object.freeze(application) });
}

/** The real production entry point, on a real loopback port.
 *
 * This is the only level at which the original defect is visible: nothing
 * passed `operationsModeIntegrityKey`, so the endpoint 404'd on a real
 * installation while every service-level test passed. The defect was never in
 * the web process — it was in the composition above it — so a test that builds
 * `createMacLocalWebProcessV1` directly passes even with the wiring removed.
 *
 * The port is bound on the reserved disposable lane and released by close(). */
function productionHost(client: DatabaseClient, options: Readonly<{ key?: Uint8Array;
  spy?: ReturnType<typeof taskApplicationSpy>; port?: number }> = {}) {
  const rendered: Request[] = [];
  const host = createMacLocalProtectedHostV1({
    loadConfiguration: async () => ({ port: options.port ?? PORT, workspaceId: WORKSPACE,
      localOwnerSession: { ...PROFILE, origin: `http://127.0.0.1:${options.port ?? PORT}` },
      database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web",
        password: "pw-web", majorVersion: 17 },
      // The real configuration loader's shape, with one owner-trusted worker so
      // the enablement passes the same strict capture production does. The
      // executable is never run: readVersion is supplied, so nothing executes.
      enablement: { schema: "control-room.owner-trusted-local-enablement/v1", mode: "mac-local", nodeId: "mac-1",
        workers: [{ workerId: "worker:test", kind: "codex",
          executablePath: "/opt/homebrew/bin/codex", recordedVersion: "1.0.0" }] } }) as never,
    readVersion: async () => "1.0.0",
    openDatabase: () => ({ client, close: async () => {}, isAvailable: () => true }),
    assets: { count: 1, digest: `sha256:${"c".repeat(64)}`, respond: () => new Response("asset") },
    // The production renderer is the Next.js middleware, which forwards every
    // request to the installed private application. A stub that answers "page"
    // instead would swallow the request and prove nothing about the wiring, so
    // this forwards exactly the way the real middleware does and records only
    // what reached the page layer.
    render: request => handlePrivateWebRequest(request, () => { rendered.push(request); return new Response("page"); }),
    // The installed intake key is what production passes. It is the same key
    // the batch modules use, and it is what enables the operations mode.
    ...(options.key ? { workBatchIntegrityKey: options.key } : {}),
    ...(options.spy ? { createTaskApplication: async input => {
      // Read the exact option the default task provider reads, so a
      // differently-named field with the same shape cannot pass this test.
      options.spy!.seen.supervisor = (input as { supervisor?: unknown }).supervisor;
      return options.spy!.application as never;
    } } : {}),
    // The roles file is the fixed owner-only manifest, and the host refuses a
    // configuration whose web connection differs from it. Every login shares
    // one endpoint and differs only by name, which is what the capture accepts.
    ...(options.spy ? { loadDatabaseRoles: async () => ({
      schema: "control-room.mac-local-database-roles/v1",
      ...Object.fromEntries(["web", "coordinator", "results", "publisher", "agentReviewer", "queueWorker"]
        .map(name => [name, { host: "127.0.0.1", port: 5432, database: "control_room",
          username: `control_room_${name}`, password: `pw-${name}`, majorVersion: 17 }])) }) as never } : {}),
  });
  return Object.freeze({ host, rendered });
}

test("the production host serves the operations-mode endpoint on a real port", { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    // Seeded before the host starts: the local owner session store loads its
    // persisted sessions during startup, so a row written afterwards would
    // never be seen.
    await seedTenant(admin);
    const { host, rendered } = productionHost(client, { key: KEY });
    // The host's start() is the one the launcher calls; it returns the composed
    // service, which is what owns the listener.
    const started = await host.start();
    try {
      assert.ok(started, "the production host must start with the installed key");
      // A real request over a real socket, through the host's own composition.
      const response = await fetch(`http://127.0.0.1:${PORT}/api/v1/operations-mode`, {
        headers: { cookie: COOKIE, origin: ORIGIN, host: `127.0.0.1:${PORT}`,
          "sec-fetch-site": "same-origin", accept: "application/json" } });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const view = JSON.parse(text) as { mode: string; revision: number; admitsNewWork: boolean };
      assert.equal(view.mode, "running");
      assert.equal(view.revision, 0);
      assert.equal(view.admitsNewWork, true);
      assert.equal(rendered.length, 0, "the API route must be answered by the app, not fall through to a page");

      // And the write path reaches the same recorded decision.
      const posted = await fetch(`http://127.0.0.1:${PORT}/api/v1/operations-mode`, { method: "POST",
        headers: { cookie: COOKIE, origin: ORIGIN, "sec-fetch-site": "same-origin",
          accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ mode: "paused", reason: "owner lunch" }) });
      const postedText = await posted.text();
      assert.equal(posted.status, 200, postedText);
      assert.equal((JSON.parse(postedText) as { mode: string }).mode, "paused");

      // `stopped` is the only mode whose receipt depends on the coordinator's
      // stop authority. This host was composed without a task application, so
      // the honest receipt is stopRequests: null — "no stop request was sent",
      // not a claim that nothing was running. Asserting it here pins that
      // absence is reported rather than implied.
      const stoppedResponse = await fetch(`http://127.0.0.1:${PORT}/api/v1/operations-mode`, { method: "POST",
        headers: { cookie: COOKIE, origin: ORIGIN, "sec-fetch-site": "same-origin",
          accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ mode: "stopped", reason: "owner stop" }) });
      const stoppedText = await stoppedResponse.text();
      assert.equal(stoppedResponse.status, 200, stoppedText);
      const stopped = JSON.parse(stoppedText) as { mode: string; stopRequests: unknown };
      assert.equal(stopped.mode, "stopped");
      assert.equal(stopped.stopRequests, null,
        "with no coordinator composed there is no stop request to report, and the receipt must say so");
    } finally { await started.close(); await close(); await admin.end(); }
  }, { port: PORTS[8], allowedPorts: PORTS, boundMs: 180_000 });
});

test("the protected host hands the task application a working supervisor port", { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      // Seeded before the host starts: the local owner session store loads its
      // persisted sessions during startup, so a row written afterwards would
      // never be seen.
      await seedTenant(admin);
      const spy = taskApplicationSpy();
      const { host } = productionHost(client, { key: KEY, spy, port: SUPERVISOR_PORT });
      const started = await host.start();
      try {
        // Without this the supervisor has no way to pause, and a failed
        // machine-health check would leave the installation running.
        const supervisor = spy.seen.supervisor as { operations: { pauseNewStarts(input: { reasonCode: "machine_health_failed";
          observedAt: string }): Promise<{ state: string; receiptId: string }> }; supervisorId: string } | undefined;
        assert.ok(supervisor, "the task application must be offered the supervisor wiring");
        assert.equal(supervisor.supervisorId, "supervisor:mac-local",
          "the health loop must report under the one fixed Mac-local supervisor");
        const operations = supervisor.operations;
        assert.ok(operations, "the task application must be offered the supervisor's operations port");
        assert.equal(typeof operations.pauseNewStarts, "function");

        // And the port it was handed really is the server-owned mode, reached
        // through the host's own composition rather than a private copy.
        const result = await operations.pauseNewStarts({ reasonCode: "machine_health_failed",
          observedAt: new Date().toISOString() });
        assert.equal(result.state, "paused");
        const view = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
        assert.equal((await view.read(ownerIdentity())).mode, "paused",
          "the supervisor's pause must land in the same record the owner reads");

        // The stop authority the host attached is the coordinator's own, not a
        // weaker private copy. `attachStopAuthority` refuses a second
        // attachment precisely so two different stop paths can never both
        // claim to be the one, and a receipt reporting the counts of the wrong
        // one is the false all-clear this control exists to prevent.
        const stoppedResponse = await fetch(`http://127.0.0.1:${SUPERVISOR_PORT}/api/v1/operations-mode`,
          { method: "POST", headers: { cookie: COOKIE, origin: `http://127.0.0.1:${SUPERVISOR_PORT}`,
            "sec-fetch-site": "same-origin", accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify({ mode: "stopped", reason: "owner stop" }) });
        const stoppedText = await stoppedResponse.text();
        assert.equal(stoppedResponse.status, 200, stoppedText);
        const stopped = JSON.parse(stoppedText) as { mode: string; stopRequests: { requested: number;
          revoked: number; uncertainJobIds: string[] } | null };
        assert.equal(stopped.mode, "stopped");
        assert.deepEqual(stopped.stopRequests, { requested: 1, revoked: 1, uncertainJobIds: [] },
          "the host must attach the coordinator's stop authority, so Stop reaches running work");
        assert.deepEqual(spy.application.revoked, ["job:running"],
          "the revoke must run on the coordinator's own path, not a weaker private copy");
      } finally { await started.close(); }
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[9], allowedPorts: PORTS, boundMs: 180_000 });
});

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

test("an agent identity is never resolved as the owner, however wide its grant",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      // An agent holding the owner role key and every action. The 0155 guard
      // refuses a non-human identity at the insert, and the installation path
      // must not resolve it as "the owner" either: a health check must not be
      // able to write a decision as a machine.
      const agent = "identity:operations-host-agent";
      await admin.query(`INSERT INTO control_identities
        (id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
        VALUES($1,$2,'agent',$1,$3,$4,'active',$5,$5)`,
      [agent, TENANT, PROVIDER, sha256Digest({ provider: PROVIDER, subject: agent }), new Date().toISOString()]);
      await admin.query(`INSERT INTO control_role_grants
        (id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,
         require_strong_factor,created_at,updated_at)
        VALUES($1,$2,$3,'owner','["*"]','["*"]','critical',true,false,$4,$4)`,
      [`grant:operations-host:${agent}`, TENANT, agent, new Date().toISOString()]);
      // With a human owner present, the human is the one resolved, and the
      // agent never appears as the author of the decision.
      const service = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      const port = createOperationsModeSupervisorPortV1({ target: service });
      await port.pauseNewStarts({ reasonCode: "machine_health_failed", observedAt: new Date().toISOString() });
      const view = await service.read(ownerIdentity());
      assert.equal(view.mode, "paused");
      assert.equal(view.setByIdentityId, OWNER, "only the human owner may author an operations-mode decision");
      const history = await admin.query<{ set_by_identity_id: string }>(
        "SELECT set_by_identity_id FROM installation_operations_mode_revisions");
      assert.ok(history.rows.every(row => row.set_by_identity_id === OWNER),
        "an agent identity must never author an operations-mode record");
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[7], allowedPorts: PORTS, boundMs: 180_000 });
});

test("an owner grant without operations.set_mode does not authorize a pause",
  { timeout: 600_000 }, async t => {
  const skip = needsPg();
  if (skip) { t.skip(skip.skip); return; }
  await withRealPostgres(async postgres => {
    const admin = new Client(postgres.admin({ database: postgres.database }));
    await admin.connect();
    const { client, close } = webClient(postgres);
    try {
      await seedTenant(admin);
      // The owner role, but not the action. This is the grant an operator-shaped
      // installation would have: able to run the installation, not to stop it.
      await admin.query(`UPDATE control_role_grants SET allowed_actions='["tasks.read"]' WHERE identity_id=$1`,
        [OWNER]);
      const service = new WebOperationsModeServiceV1(client, { tenantId: TENANT, workspaceId: WORKSPACE }, KEY);
      await assert.rejects(service.pauseForMachineHealth(OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1),
        /operations_mode_owner_unavailable/,
        "the owner role alone is not the authority; operations.set_mode is");
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM installation_operations_mode_revisions")).rows[0]!.n, 0);
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[2], allowedPorts: PORTS, boundMs: 180_000 });
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
      // The revision count is the part an idempotent insert would still pass but
      // a genuine overwrite would not: the machine must append nothing.
      assert.equal(view.revision, 1, "a machine pause must not append a revision over the owner's own decision");
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM installation_operations_mode_revisions")).rows[0]!.n, 1,
        "exactly one recorded decision: the owner's");

      // The port reports `already_paused` for any non-running mode, so only the
      // service can tell "declined" from "rewrote". On a non-running
      // installation the pause must be a no-op, not a new decision.
      const direct = await service.pauseForMachineHealth(OPERATIONS_MODE_MACHINE_HEALTH_REASON_V1);
      assert.equal(direct.mode, "draining", "a machine pause must not change a mode the owner set");
      assert.equal(direct.replayed, true, "declining to pause is a replay, not a new decision");
      assert.equal((await admin.query(
        "SELECT count(*)::int AS n FROM installation_operations_mode_revisions")).rows[0]!.n, 1);
      // And the owner's recorded reason survives: the machine's reason must not
      // be written in its place under the same revision.
      assert.equal((await service.read(ownerIdentity())).reason, "finishing tonight");
    } finally { await close(); await admin.end(); }
  }, { port: PORTS[6], allowedPorts: PORTS, boundMs: 180_000 });
});
