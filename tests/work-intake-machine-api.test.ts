import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from "node:http";
import type { ListenOptions } from "node:net";
import { Readable } from "node:stream";
import test from "node:test";
import { WORK_INTAKE_CLIENT_CONFIG_PATH_V1, readProtectedWorkIntakeClientV1 } from "../scripts/run-work-intake";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { matchesPostgresProductionAclV1 } from "../src/installer/v1/postgres-production-privilege-contract";
import { sha256Digest,type AuthenticatedPrincipal } from "../src/security";
import { createFixedWorkIntakeCredentialVerifierV1, createWorkIntakeLoopbackClientV1,
  createWorkIntakeNodeBridgeV1, prepareWorkIntakePrivateServiceV1, WORK_INTAKE_CLIENT_CONFIGURATION_V1,
  type WorkBatchServiceV1 } from "../src/work-intake/v1";

const SECRET = "0123456789012345678901234567890123456789012";
const NOW = "2026-09-27T12:00:00.000Z";
const PRINCIPAL: AuthenticatedPrincipal = Object.freeze({ tenantId: "tenant:test", identityId: "identity:agent",
  actorType: "agent", authenticatedAt: "2026-09-27T11:00:00.000Z", expiresAt: "2026-09-27T13:00:00.000Z" });
const MAPPINGS=Object.freeze([{workerId:"worker:test",workerKind:"codex",credentialDigest:sha256Digest(SECRET),principal:PRINCIPAL}]);
type SyntheticResponse = ServerResponse & { status?: number; body?: string };

function request(method: string, url: string, body = Buffer.alloc(0), headers: IncomingHttpHeaders = {}, onRead?: () => void) {
  const source = Readable.from((async function* () { if (body.length) { onRead?.(); yield body; } })()) as IncomingMessage;
  return Object.assign(source, { method, url, headers });
}
function response(): SyntheticResponse {
  const output = { writeHead(status: number) { output.status = status; return output; },
    end(body?: string) { output.body = body ?? ""; return output; } } as unknown as SyntheticResponse;
  return output;
}
function service() {
  const calls: string[] = [];
  const value = {
    async authorizeBeforeBody(_principal: AuthenticatedPrincipal, projectId: string) {
      calls.push(`authorize:${projectId}`); return projectId === "project:test"
        ? { allowed: true as const, workspaceId: "workspace:test" }
        : { allowed: false as const, safeReasonCode: "no_matching_grant" as const };
    },
    async recordEnvelopeRefusal(_principal: AuthenticatedPrincipal, projectId: string, reasonCode: string) {
      calls.push(`refusal:${projectId}:${reasonCode}`);
    },
    async submit(input: { now: string }) { calls.push(`submit:${input.now}`); return { batchId: "batch:test",
      state: "proposed", startsWork: false, grantsExecutionAuthority: false }; },
    async status(input: { now: string }) { calls.push(`status:${input.now}`); return { state: "proposed" }; },
    async list(input: { now: string }) { calls.push(`list:${input.now}`); return []; },
  } as unknown as WorkBatchServiceV1;
  return { value, calls };
}

test("fixed bearer verification is constant-shape and never returns credential material", async () => {
  const verifier = createFixedWorkIntakeCredentialVerifierV1(SECRET, PRINCIPAL);
  assert.deepEqual(await verifier.verify(SECRET, NOW), PRINCIPAL);
  await assert.rejects(verifier.verify("x".repeat(43), NOW), /credential_refused/u);
  await assert.rejects(verifier.verify("short", NOW), /credential_refused/u);
  assert.throws(() => createFixedWorkIntakeCredentialVerifierV1("short", PRINCIPAL), /machine_auth_invalid/u);
});

test("machine boundary authenticates credential and project before reading a submission body", async () => {
  const mock = service(), bridge = createWorkIntakeNodeBridgeV1({
    verifier: createFixedWorkIntakeCredentialVerifierV1(SECRET, PRINCIPAL), service: mock.value, now: () => NOW });
  let reads = 0;
  for (const [url, authorization] of [["/v1/projects/project%3Atest/work-batches", "Bearer wrong"],
    ["/v1/projects/project%3Aother/work-batches", `Bearer ${SECRET}`],
    [`/v1/projects/project%3Atest/work-batches?credential=${SECRET}`, `Bearer ${SECRET}`],
    ["/v1/projects/project%2Ftest/work-batches", `Bearer ${SECRET}`],
    ["/v1/projects/project%252Ftest/work-batches", `Bearer ${SECRET}`]] as const) {
    const out = response();
    await bridge.handle(request("POST", url, Buffer.from("{}"), { authorization,
      "content-type": "application/json", "content-length": "2" }, () => { reads += 1; }), out);
    assert.ok(out.status === 401 || out.status === 404);
  }
  assert.equal(reads, 0);
  assert.deepEqual(mock.calls, ["authorize:project:other"]);
});

test("exact machine routes use only the trusted clock and reject extra or oversized input", async () => {
  const mock = service(), bridge = createWorkIntakeNodeBridgeV1({
    verifier: createFixedWorkIntakeCredentialVerifierV1(SECRET, PRINCIPAL), service: mock.value, now: () => NOW });
  const headers = { authorization: `Bearer ${SECRET}`, "content-type": "application/json" };
  const payload = Buffer.from(JSON.stringify({ idempotencyKey: "machine-submit-0001", proposal: { projectId: "project:test" } }));
  const submitted = response();
  await bridge.handle(request("POST", "/v1/projects/project%3Atest/work-batches", payload,
    { ...headers, "content-length": String(payload.length) }), submitted);
  assert.equal(submitted.status, 202);
  assert.ok(mock.calls.includes(`submit:${NOW}`));

  const suppliedClock = Buffer.from(JSON.stringify({ idempotencyKey: "machine-submit-0002",
    proposal: { projectId: "project:test" }, now: "1999-01-01T00:00:00.000Z" }));
  const refused = response();
  await bridge.handle(request("POST", "/v1/projects/project%3Atest/work-batches", suppliedClock,
    { ...headers, "content-length": String(suppliedClock.length) }), refused);
  assert.equal(refused.status, 400);
  const oversized = response();
  await bridge.handle(request("POST", "/v1/projects/project%3Atest/work-batches", Buffer.alloc(0),
    { ...headers, "content-length": "262145" }), oversized);
  assert.equal(oversized.status, 413);
  assert.ok(mock.calls.includes("refusal:project:test:http_envelope_invalid"));
  assert.ok(mock.calls.includes("refusal:project:test:http_body_over_limit"));
  const listed = response(); await bridge.handle(request("GET", "/v1/projects/project%3Atest/work-batches",
    Buffer.alloc(0), { authorization: `Bearer ${SECRET}` }), listed); assert.equal(listed.status, 200);
  const status = response(); await bridge.handle(request("GET", "/v1/projects/project%3Atest/work-batches/batch%3Atest",
    Buffer.alloc(0), { authorization: `Bearer ${SECRET}` }), status); assert.equal(status.status, 200);
});

test("protected loopback client sends the bearer only in the header and accepts no caller clock", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createWorkIntakeLoopbackClientV1({ origin: "http://127.0.0.1:3212", bearerSecret: SECRET,
    fetch: async (url, init) => { calls.push({ url, init }); return { ok: true, async json() { return { ok: true, result: [] }; } }; } });
  await client.list({ projectId: "project:test" });
  assert.equal(calls[0]!.url, "http://127.0.0.1:3212/v1/projects/project%3Atest/work-batches");
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, `Bearer ${SECRET}`);
  assert.doesNotMatch(calls[0]!.url, new RegExp(SECRET, "u"));
  assert.throws(() => createWorkIntakeLoopbackClientV1({ origin: "http://localhost:3212", bearerSecret: SECRET }),
    /client_config_invalid/u);
});

test("production privilege preflight admits only the dedicated role on intake tables", () => {
  assert.equal(matchesPostgresProductionAclV1("public.work_batches",
    "{control_room_schema_owner=arwdDxtm/control_room_schema_owner,control_room_backup=r/control_room_schema_owner,control_room_work_intake=ar/control_room_schema_owner}"), true);
  assert.equal(matchesPostgresProductionAclV1("public.work_batches",
    "{control_room_schema_owner=arwdDxtm/control_room_schema_owner,control_room_private_web=ar/control_room_schema_owner,control_room_work_intake=ar/control_room_schema_owner}"), false);
});

test("role creation and least-privilege grants travel through reviewed production provisioning", async () => {
  const [roles, provision, grants, browser, migration] = await Promise.all([
    ...["production_roles.sql", "production_provision.sql", "production_table_grants.sql", "private_web_roles.sql"]
      .map(file => readFile(`db/roles/${file}`, "utf8")),
    readFile("db/migrations/0093_work_batch_intake.sql", "utf8")]);
  assert.match(roles, /CREATE ROLE control_room_work_intake NOLOGIN/u);
  assert.match(provision, /CREATE ROLE control_room_work_intake NOLOGIN/u);
  assert.match(provision, /CREATE ROLE control_room_work_intake_agent LOGIN/u);
  assert.match(provision, /GRANT control_room_work_intake TO control_room_work_intake_agent/u);
  assert.match(grants, /GRANT SELECT ON control_identities, control_role_grants, projects, work_batches/u);
  assert.doesNotMatch(grants, /GRANT .*control_jobs.* TO control_room_work_intake/u);
  assert.doesNotMatch(grants, /GRANT .*control_room_queue.* TO control_room_work_intake/u);
  assert.doesNotMatch(browser, /work_batches|work_batch_revisions/u);
  assert.match(migration, /CREATE TABLE work_intake_role_anchor/u);
  assert.match(migration, /pg_has_role\(s\.oid,a\.grantee,'member'\)/u);
  assert.doesNotMatch(migration, /r\.rolname='control_room_work_intake'/u);
  assert.match(grants, /GRANT SELECT ON work_intake_role_anchor TO control_room_work_intake/u);
  assert.match(migration, /NOT s\.rolsuper/u);
  assert.match(migration, /CREATE POLICY control_idempotency_work_intake_scope/u);
  assert.match(migration, /CREATE POLICY audit_events_work_intake_scope/u);
  assert.match(migration, /AS RESTRICTIVE FOR ALL/u);
  assert.match(migration, /DEFERRABLE INITIALLY DEFERRED/u);
  assert.match(migration, /work_intake_canonical_jsonb/u);
  assert.doesNotMatch(migration, /guard_work_intake_audit_event_insert\(\) RETURNS trigger\s+LANGUAGE plpgsql SECURITY DEFINER/u);
  assert.match(grants, /GRANT EXECUTE ON FUNCTION work_intake_canonical_jsonb\(jsonb\) TO control_room_work_intake/u);
  assert.match(grants, /GRANT UPDATE \(web_lock\) ON control_identities, control_role_grants TO control_room_work_intake/u);
  assert.match(grants, /GRANT UPDATE \(coordinator_lock\) ON projects TO control_room_work_intake/u);
  assert.match(migration, /NEW\.event_digest<>expected_digest OR NEW\.event_hash<>expected_hash/u);
  assert.match(migration, /NEW\.result->>'startsWork'<>'false'/u);
  assert.match(migration, /NEW\.result->>'grantsExecutionAuthority'<>'false'/u);
  assert.match(migration, /NEW\.event_count<>OLD\.event_count\+1/u);
  assert.doesNotMatch(migration, /NEW\.action LIKE 'work_batches\.%'/u);
});

test("invokable CLI binds to one protected configuration path and exact secret-bearing document", async () => {
  const source = JSON.stringify({ schema: WORK_INTAKE_CLIENT_CONFIGURATION_V1,
    origin:"http://127.0.0.1:3212",bearerSecret:SECRET });
  const stat = { isFile: () => true, uid: BigInt(process.getuid?.() ?? -1), mode: BigInt(0o600),
    size: BigInt(Buffer.byteLength(source)), dev: BigInt(1), ino: BigInt(2), mtimeNs: BigInt(3) };
  let closed = 0;
  const openFile = async () => ({ stat: async () => stat, readFile: async () => source,
    close: async () => { closed += 1; } });
  const client = await readProtectedWorkIntakeClientV1(WORK_INTAKE_CLIENT_CONFIG_PATH_V1,
    { openFile: openFile as never });
  assert.equal(typeof client.submit, "function"); assert.equal(closed, 1);
  await assert.rejects(readProtectedWorkIntakeClientV1("/tmp/not-the-installed-store.json",
    { openFile: openFile as never }), /protected_configuration_refused/u);
});

test("production composition is inert, role-pinned, loopback-only, and closes its database", async () => {
  let opened = 0, closed = 0, created = 0, listen: ListenOptions | undefined;
  const database: DatabaseClient = Object.freeze({ async query() { return { rows: [] }; },
    async transaction<T>(callback: (session: DatabaseSession) => Promise<T>) { return callback(database); },
    async transactionWithPreCommitCheck<T>(callback: (session: DatabaseSession) => Promise<T>, check: () => Promise<void>) {
      const result = await callback(database); await check(); return result; } });
  const server = new EventEmitter() as Server;
  server.listen = ((options: ListenOptions, callback: () => void) => { listen = options; queueMicrotask(callback); return server; }) as typeof server.listen;
  server.close = (callback?: (error?: Error) => void) => { queueMicrotask(() => callback?.()); return server; };
  server.closeIdleConnections = () => {}; server.closeAllConnections = () => {};
  const prepared = await prepareWorkIntakePrivateServiceV1({ port: 3212, credentials:MAPPINGS,
    integrityKey: new Uint8Array(32).fill(4), database: { host: "127.0.0.1", port: 5432, database: "control_room",
      username: "control_room_work_intake_agent", password: "disposable", majorVersion: 17 } }, {
    openDatabase: () => { opened += 1; return { client: database, isAvailable: () => true,
      async close() { closed += 1; } }; }, createServer: () => { created += 1; return server; }, now: () => NOW });
  assert.equal(opened, 1); assert.equal(created, 0);
  await prepared.start(); assert.equal(created, 1); assert.equal(listen?.host, "127.0.0.1");
  await prepared.close(); assert.equal(closed, 1);
  await assert.rejects(prepareWorkIntakePrivateServiceV1({ port: 3212, credentials:MAPPINGS,
    integrityKey: new Uint8Array(32), database: { host: "127.0.0.1", port: 5432, database: "control_room",
      username: "control_room_private_web", password: "disposable", majorVersion: 17 } }, { openDatabase: () => {
      throw new Error("must not open"); } }), /prepare_failed/u);
});
