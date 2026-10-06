// Unhappy-path and stress probe for the chief-of-staff composition, run against a
// real disposable cluster as the production web login. Not part of any lane: this
// is the SELF-TEST evidence for the report (owner rule 4: bad input, missing
// data, a second concurrent caller, a retry after failure, and a stop halfway,
// under load).
//
//   PG_BIN=/opt/homebrew/opt/postgresql@17/bin CONTROL_ROOM_PG_TEST_PORT_BASE=59450 \
//     node --import tsx tests/orchui-unhappy-paths.probe.ts
import { Client } from "pg";
import { requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { sha256Digest } from "../src/security";
import { createProjectOrchestrationServiceV1 } from "../src/web/v1/project-orchestration-composition";
import { createProjectOrchestrationHttpHandlerV1 } from "../src/web/v1/project-orchestration-http";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { LocalOwnerSessionServiceV1 } from "../src/web/v1/local-owner-session";

const PORT = Number(process.env.ORCHESTRATION_PROBE_PORT ?? process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59450);
const ALLOWED = Array.from({ length: 10 }, (_, index) => PORT + index);
const RUN = Date.parse("2026-09-29T23:00:00.000Z"), clock = () => Math.max(Date.now(), RUN);
const NOW = new Date(RUN).toISOString(), LATER = new Date(RUN + 3_600_000).toISOString();
const scope = { tenantId: "tenant:up", workspaceId: "workspace:up", projectId: "project:up" };
const provider = "https://access.invalid", subject = "owner", tokenDigest = `sha256:${"d".repeat(64)}`;
const identity: VerifiedWebIdentity = { provider, subject, tokenDigest,
  issuedAt: new Date(clock()).toISOString(), expiresAt: new Date(clock() + 3_600_000).toISOString(),
  verificationExpiresAt: new Date(clock() + 3_600_000).toISOString() };
const KEY = new Uint8Array(32).fill(53);
const catalog = [{ workerId: "worker:chief", workerKind: "codex" as const, nodeId: "node:chief",
  modelPolicy: { models: ["model:plan"], defaultModel: "model:plan", efforts: ["high" as const],
    defaultEffort: "high" as const } }];
const CHIEF = { tenantId: scope.tenantId, identityId: "identity:chief", actorType: "agent" as const,
  authenticatedAt: NOW, expiresAt: LATER };

function database(client: Client): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, values?: unknown[]) =>
    ({ rows: (await client.query(sql, values as never[])).rows as T[] }) };
  return { query: session.query,
    transactionWithPreCommitCheck: async (work: (tx: DatabaseSession) => Promise<unknown>) => {
      await client.query("BEGIN");
      try { const value = await work(session); await client.query("COMMIT"); return value; }
      catch (error) { await client.query("ROLLBACK").catch(() => {}); throw error; }
    } } as unknown as DatabaseClient;
}

let runs = 0;
const receipt = { schema: "control-room.work-batch-receipt/v1" as const, batchId: "batch:up",
  projectId: scope.projectId, state: "proposed" as const, proposalDigest: `sha256:${"a".repeat(64)}`,
  revision: 1 as const, replayed: false, startsWork: false as const, grantsExecutionAuthority: false as const };
const coordinator = { async coordinateInitial() { runs += 1;
    return { status: "submitted" as const, submission: receipt, flagsByLocalId: {},
      startsWork: false as const, grantsExecutionAuthority: false as const }; },
  ownerPrefill() { throw new Error("intake_suggestion_not_found"); } };
const service = (client: Client, planner = false) => createProjectOrchestrationServiceV1({
  db: database(client), ...scope, queueCatalog: catalog, integrityKey: KEY, coordinator,
  ...(planner ? { planner: { principal: CHIEF, available: true } } : {}), clock });

if (!requiresRealPostgres()) { console.log("SKIP: real PostgreSQL unavailable"); process.exit(0); }
await withRealPostgres(async postgres => {
  const admin = new Client(postgres.admin()); await admin.connect();
  const web = new Client(postgres.connection("control_room_web")); await web.connect();
  try {
    const adapter = `adapter:manual:${sha256Digest({ w: scope.workspaceId }).slice(7, 39)}`;
    await admin.query("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
    await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)",
      [scope.workspaceId, scope.tenantId]);
    await admin.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
      VALUES($1,$2,'control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapter, scope.tenantId]);
    await admin.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
      VALUES($1,$2,$3,$4,$1,'1','P','planned','manual_project_active','healthy','control_room_native',$5,'{}',$5)`,
    [scope.projectId, scope.tenantId, scope.workspaceId, adapter, NOW]);
    await admin.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
      VALUES($1,$2,'active',1,$3,$3)`, [scope.tenantId, scope.projectId, NOW]);
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES($1,$2,'human','F',$3,$4,'active',$5,$5)`,
    ["identity:up-owner", scope.tenantId, provider, sha256Digest({ provider, subject }), NOW]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES($1,$2,$3,'owner','["*"]'::jsonb,'["*"]'::jsonb,'critical',false,false,$4,$4)`,
    ["g:up", scope.tenantId, "identity:up-owner", NOW]);
    await admin.query(`INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at)
      VALUES($1,$2,$3,$4,$5)`, [scope.tenantId, tokenDigest, "identity:up-owner", identity.issuedAt, identity.expiresAt]);

    const port = await service(web);
    const local = { profile: { origin: "http://127.0.0.1:3210" }, assertLocalRequest() {},
      verify() { return identity; } } as unknown as LocalOwnerSessionServiceV1;
    const handle = createProjectOrchestrationHttpHandlerV1({ origin: "http://127.0.0.1:3210", service: port,
      localOwnerSession: local });
    const describePathFor = (projectId: string) => `/api/v1/projects/${encodeURIComponent(projectId)}/orchestration`;
    const describePath = describePathFor(scope.projectId);
    const call = (description: string, key: string) => handle(new Request(`http://127.0.0.1:3210${describePath}`,
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ description }) }));
    const out: Record<string, unknown> = {};

    // 1. BAD INPUT, against a composition that HAS a planner host -- otherwise the
    // 404 below would be the planner refusal, which is checked first, and the input
    // guard would never be exercised at all.
    const liveHandle = createProjectOrchestrationHttpHandlerV1({ origin: "http://127.0.0.1:3210",
      service: service(web, true), localOwnerSession: local });
    const callLive = (description: string, key: string) => liveHandle(new Request(
      `http://127.0.0.1:3210${describePathFor(scope.projectId)}`, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key },
        body: JSON.stringify({ description }) }));
    out.badInputWithPlanner = {
      empty: (await callLive("", "request:up-0101")).status,
      whitespaceOnly: (await callLive("   ", "request:up-0102")).status,
      overCharacterLimit: (await callLive("x".repeat(16_001), "request:up-0103")).status,
      multiByteAtLimit: (await callLive("あ".repeat(16_000), "request:up-0104")).status,
      shortIdempotencyKey: (await callLive("valid", "short")).status,
      valid: (await callLive("A legal bounded job", "request:up-0105")).status };
    out.coordinatorCallsAfterBadInputWithPlanner = runs;

    // The same inputs against the no-planner composition: the planner refusal wins,
    // which is what makes "describing is not switched on" true even for bad input.
    out.badInput = {
      empty: (await call("", "request:up-0001")).status,
      whitespaceOnly: (await call("   ", "request:up-0002")).status,
      overCharacterLimit: (await call("x".repeat(16_001), "request:up-0003")).status,
      multiByteAtLimit: (await call("あ".repeat(16_000), "request:up-0004")).status,
      shortIdempotencyKey: (await call("valid", "short")).status,
      noContentType: (await handle(new Request(`http://127.0.0.1:3210${describePath}`,
        { method: "POST", headers: { "idempotency-key": "request:up-0005" }, body: "{}" }))).status,
      getOnDescribe: (await handle(new Request(`http://127.0.0.1:3210${describePath}`))).status,
      queryString: (await handle(new Request(`http://127.0.0.1:3210${describePath}?x=1`,
        { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "request:up-0006" },
          body: JSON.stringify({ description: "x" }) }))).status };
    out.coordinatorCallsAfterBadInput = runs;

    // 2. MISSING DATA: a batch and a project that are not there.
    const missing = async (fn: () => Promise<unknown>) => fn().then(v => `ok:${JSON.stringify(v).slice(0, 40)}`,
      (e: unknown) => `${(e as Error).constructor.name}:${(e as Error).message}`);
    out.missingData = {
      unknownBatchSuggestions: await missing(() => port.listSuggestions(identity, scope.projectId, "batch:missing")),
      unknownBatchUse: await missing(() => port.useSuggestion(identity, scope.projectId, "batch:missing",
        "split-suggestion:" + "a".repeat(32), 1)),
      unknownBatchDismiss: await missing(() => port.dismissSuggestion(identity, scope.projectId, "batch:missing",
        "split-suggestion:" + "a".repeat(32), 1)),
      unknownProjectSettings: await missing(() => port.readSettings(identity, "project:not-here")),
      unknownProjectSave: await missing(() => port.saveSettings(identity, "project:not-here",
        { expectedVersion: 0, choice: { mode: "none" } })) };

    // 3. A CONFIRMED describe, then the SAME key again (the coordinator's single
    //    flight must not run the planner twice for one owner request).
    const first = await call("Prepare the launch plan", "request:up-retry-0001");
    out.firstDescribe = { status: first.status, body: await first.json() };
    const retry = await call("Prepare the launch plan", "request:up-retry-0001");
    out.retry = { status: retry.status, coordinatorRuns: runs };

    // 4. A body that stops mid-stream, and one that never ends.
    const truncated = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"description":"Prepare')); controller.close(); } });
    out.truncatedBody = (await handle(new Request(`http://127.0.0.1:3210${describePath}`,
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "request:up-0007" },
        body: truncated, duplex: "half" } as RequestInit))).status;
    const neverEnds = new ReadableStream<Uint8Array>({ start() { /* never closes */ } });
    const startedAt = Date.now();
    out.neverEndingBody = { status: (await handle(new Request(`http://127.0.0.1:3210${describePath}`,
      { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "request:up-0008" },
        body: neverEnds, duplex: "half" } as RequestInit))).status, ms: Date.now() - startedAt };

    // 5. STOP HALFWAY: a signal already aborted before the call.
    const aborted = new AbortController(); aborted.abort();
    out.stopHalfway = await missing(() => service(web, true).describe(identity, scope.projectId,
      { description: "Stop halfway" }, "request:up-abort-0001", aborted.signal));
    out.coordinatorCallsAfterAbort = runs;

    // 6. UNDER LOAD: 20 concurrent describes on ONE project, each on its own
    //    connection, with a planner host present so the coordinator IS reached.
    const before = runs;
    const started = Date.now();
    const callers = Array.from({ length: 20 }, async (_unused, index) => {
      const client = new Client(postgres.connection("control_room_web", { applicationName: `up-${index}` }));
      await client.connect();
      try {
        return await service(client, true).describe(identity, scope.projectId,
          { description: `Concurrent bounded job ${index}` },
          `request:up-conc-${String(index).padStart(4, "0")}-0001`)
          .then(value => ({ ok: true as const, status: value.status }),
            (error: unknown) => ({ ok: false as const, message: String((error as Error).message) }));
      } finally { await client.end(); }
    });
    const results = await Promise.all(callers);
    out.load = { callers: results.length, ok: results.filter(r => r.ok).length,
      coordinatorRuns: runs - before, ms: Date.now() - started,
      distinctStatuses: [...new Set(results.map(r => r.ok ? r.status : `error:${r.message}`))] };

    // 7. 20 concurrent settings saves on one project, same expected version.
    await service(web).saveSettings(identity, scope.projectId, { expectedVersion: 0, choice: { mode: "none" } });
    const savers = Array.from({ length: 20 }, async (_unused, index) => {
      const client = new Client(postgres.connection("control_room_web", { applicationName: `up-save-${index}` }));
      await client.connect();
      try {
        return await service(client).saveSettings(identity, scope.projectId, { expectedVersion: 1,
          choice: index % 2 === 0 ? { mode: "selected", workerId: "worker:chief", workerKind: "codex",
            modelKey: "model:plan", effort: "high" } : { mode: "none" } })
          .then(value => ({ ok: true as const, version: value.version }),
            (error: unknown) => ({ ok: false as const, message: String((error as Error).message) }));
      } finally { await client.end(); }
    });
    const saves = await Promise.all(savers);
    out.concurrentSaves = { callers: saves.length, won: saves.filter(s => s.ok).length,
      conflicts: saves.filter(s => !s.ok).length,
      finalVersion: (await web.query(`SELECT version FROM control_project_settings WHERE tenant_id=$1 AND project_id=$2`,
        [scope.tenantId, scope.projectId])).rows[0]?.version };

    // 8. Nothing was started anywhere on this path.
    // Counted as the SCHEMA OWNER on purpose: the web login holds no privilege on
    // work_batch_split_suggestions at all (0200 grants it SELECT on the view only),
    // and a count the product login cannot run is the shape of the guarantee.
    out.startedNothing = {
      batches: (await admin.query(`SELECT count(*)::int AS n FROM work_batches WHERE tenant_id=$1 AND project_id=$2`,
        [scope.tenantId, scope.projectId])).rows[0].n,
      suggestions: (await admin.query(`SELECT count(*)::int AS n FROM work_batch_split_suggestions WHERE tenant_id=$1`,
        [scope.tenantId])).rows[0].n };
    console.log(JSON.stringify(out, null, 2));
  } finally { await web.end(); await admin.end(); }
}, { port: PORT, allowedPorts: ALLOWED, boundMs: 300_000 });