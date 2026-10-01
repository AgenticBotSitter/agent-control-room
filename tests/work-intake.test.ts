import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { downRungBefore, readMigrationGraph } from "./helpers/down-migration-order";
import { AuditStore, auditPartition } from "../src/audit/audit-store";
import { adaptPglite } from "../src/persistence/database";
import { sha256Digest, type AuthenticatedPrincipal } from "../src/security";
import { CredentialedWorkBatchServiceV1, WorkBatchServiceV1, WorkBatchStoreV1,
  createFixedWorkIntakeCredentialVerifierV1, createWorkIntakeNodeBridgeV1, validateWorkBatchProposalV1 } from
  "../src/work-intake/v1";

const NOW = "2026-09-27T12:00:00.000Z";
const principal = (overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal => ({
  tenantId: "tenant:test", identityId: "identity:agent", actorType: "agent",
  authenticatedAt: "2026-09-27T11:59:00.000Z", expiresAt: "2026-09-27T13:00:00.000Z", ...overrides,
});
const proposal = (overrides: Record<string, unknown> = {}) => ({
  schema: "control-room.work-batch-proposal/v1", projectId: "project:test",
  tasks: [{ localId: "build", title: "Build", instructions: "Implement the bounded change.",
    requiredCapability: "code.change", role: "builder", requestedWorkerKind: "worker:code",
    requestedModelKey: "model:allowed", acceptanceCriteria: "The focused checks pass.",
    acceptanceTests: "Run the focused test lane." }], edges: [], ...overrides,
});

async function fixture() {
  const raw = new PGlite();
  for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort())
    await raw.exec(await readFile(`db/migrations/${file}`, "utf8"));
  await raw.exec("CREATE SCHEMA control_room_queue; CREATE TABLE control_room_queue.job(id text PRIMARY KEY)");
  await raw.query("INSERT INTO tenants(id,display_name) VALUES('tenant:test','Test tenant')");
  await raw.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Workspace')");
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,
    redaction_policy_version,cursor_retention_days) VALUES('adapter:test','tenant:test','manual','1','control_room_native',
    'fixture','v1',1)`);
  for (const id of ["project:test", "project:other"])
    await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,
      normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES($1,'tenant:test','workspace:test',
      'adapter:test',$1,'1','Project','ready','ready','healthy','control_room_native',$2,'{}')`, [id, NOW]);
  await raw.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,
    auth_subject_digest,state,created_at,updated_at) VALUES('identity:agent','tenant:test','agent','Proposing agent',
    'work-intake','${sha256Digest("agent")}', 'active',$1,$1)`, [NOW]);
  await raw.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,
    risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at) VALUES('grant:proposer','tenant:test',
    'identity:agent','work_batch_proposer','["work_batches.propose"]','["project:test"]','low',false,false,$1,$1)`, [NOW]);
  const db = adaptPglite(raw), store = new WorkBatchStoreV1(db, new Uint8Array(32).fill(7));
  return { raw, db, store, service: new WorkBatchServiceV1(store), close: () => raw.close() };
}

test("strict batch validation bounds the graph and refuses authority or secret-shaped additions", () => {
  assert.equal(validateWorkBatchProposalV1(JSON.stringify(proposal()), "project:test").accepted, true);
  const cases = [
    proposal({ projectId: "project:other" }),
    { ...proposal(), authority: "owner" },
    proposal({ tasks: [proposal().tasks[0], proposal().tasks[0]] }),
    proposal({ edges: [{ fromLocalId: "build", toLocalId: "missing" }] }),
    proposal({ tasks: [proposal().tasks[0], { ...proposal().tasks[0], localId: "check" }],
      edges: [{ fromLocalId: "build", toLocalId: "check" }, { fromLocalId: "check", toLocalId: "build" }] }),
    proposal({ tasks: Array.from({ length: 33 }, (_, i) => ({ ...proposal().tasks[0], localId: `task-${i}` })) }),
    proposal({ edges: Array.from({ length: 65 }, () => ({ fromLocalId: "build", toLocalId: "build" })) }),
    proposal({ tasks: [{ ...proposal().tasks[0], instructions: `Bearer ${"z".repeat(40)}` }] }),
  ];
  for (const value of cases) assert.equal(validateWorkBatchProposalV1(JSON.stringify(value), "project:test").accepted, false);
  const duplicate = '{"schema":"control-room.work-batch-proposal/v1","projectId":"project:test","projectId":"project:other","tasks":[],"edges":[]}';
  assert.deepEqual(validateWorkBatchProposalV1(duplicate, "project:test"), { accepted: false, safeReasonCode: "content_duplicate_key" });
});

test("proposal-only submission is replay-safe, audited, and creates no task or queue row", async t => {
  const f = await fixture(); t.after(() => void f.close());
  const input = { principal: principal(), projectId: "project:test", rawProposal: JSON.stringify(proposal()),
    idempotencyKey: "batch-submit-key-0001", now: NOW };
  const first = await f.service.submit(input); assert.equal("state" in first && first.state, "proposed");
  assert.ok("batchId" in first);
  const batchId = first.batchId;
  assert.equal(first.startsWork, false); assert.equal(first.grantsExecutionAuthority, false);
  const replay = await f.service.submit(input); assert.equal("replayed" in replay && replay.replayed, true);
  const restarted = new WorkBatchServiceV1(new WorkBatchStoreV1(f.db, new Uint8Array(32).fill(7)));
  const afterRestart = await restarted.submit(input);
  assert.equal("replayed" in afterRestart && afterRestart.replayed, true);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batches")).rows[0]!.count, 1);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_revisions")).rows[0]!.count, 1);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM control_action_inbox")).rows[0]!.count, 1);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM control_jobs")).rows[0]!.count, 0);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM control_room_queue.job")).rows[0]!.count, 0);
  await assert.rejects(f.raw.query(`INSERT INTO work_batches
    SELECT 'batch:forged',tenant_id,project_id,proposed_by_identity_id,proposed_by_actor_type,proposed_at,
      'approved',proposed_by_identity_id,proposed_at,NULL,proposal,queue_depth_limit,batch_digest,auth_tag,version,created_at,updated_at
    FROM work_batches WHERE id=$1`, [batchId]), /proposal-only work batch insert rejected/);
  await assert.rejects(f.raw.query(`INSERT INTO work_batch_revisions
    SELECT 'revision:forged',tenant_id,batch_id,2,edited_by_identity_id,edited_at,'submitted',proposal,revision_digest,auth_tag
    FROM work_batch_revisions WHERE batch_id=$1`, [batchId]), /work batch revision insert rejected/);
  const verification = await new AuditStore(f.db).verify("tenant:test", auditPartition(NOW));
  assert.equal(verification.valid, true);
  await assert.rejects(f.service.submit({ ...input, rawProposal: JSON.stringify(proposal({ tasks: [{ ...proposal().tasks[0], title: "Changed" }] })) }), /replay_conflict/);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batches")).rows[0]!.count, 1);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_events WHERE action='work_batches.propose.replayed'")).rows[0]!.count, 2);
  await f.raw.query("UPDATE control_role_grants SET revoked_at=statement_timestamp() WHERE id='grant:proposer'");
  await assert.rejects(f.raw.query(`INSERT INTO work_batches
    SELECT 'batch:forged-with-revoked-grant',tenant_id,project_id,proposed_by_identity_id,proposed_by_actor_type,
      statement_timestamp(),'proposed',NULL,NULL,NULL,proposal,queue_depth_limit,batch_digest,auth_tag,1,
      statement_timestamp(),statement_timestamp() FROM work_batches WHERE id=$1`, [batchId]),
  /proposal-only work batch insert rejected/);
});

test("every hostile proposal is durably refused, audited, and leaves both intake tables empty", async t => {
  const f = await fixture(); t.after(() => void f.close());
  const two = [proposal().tasks[0], { ...proposal().tasks[0], localId: "check" }];
  const values = [
    proposal({ projectId: "project:other" }),
    proposal({ tasks: [proposal().tasks[0], proposal().tasks[0]] }),
    proposal({ edges: [{ fromLocalId: "build", toLocalId: "missing" }] }),
    proposal({ tasks: two, edges: [{ fromLocalId: "build", toLocalId: "check" }, { fromLocalId: "check", toLocalId: "build" }] }),
    proposal({ tasks: Array.from({ length: 33 }, (_, i) => ({ ...proposal().tasks[0], localId: `task-${i}` })) }),
    proposal({ edges: Array.from({ length: 65 }, () => ({ fromLocalId: "build", toLocalId: "build" })) }),
    proposal({ tasks: [{ ...proposal().tasks[0], instructions: `Bearer ${"z".repeat(40)}` }] }),
    { ...proposal(), endpoint: "http://127.0.0.1/private" },
  ];
  for (const [index, value] of values.entries()) {
    const result = await f.service.submit({ principal: principal(), projectId: "project:test",
      rawProposal: JSON.stringify(value), idempotencyKey: `hostile-proposal-${String(index).padStart(4, "0")}`, now: NOW });
    assert.equal("accepted" in result && result.accepted, false);
  }
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batches")).rows[0]!.count, 0);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batch_revisions")).rows[0]!.count, 0);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_events")).rows[0]!.count, values.length);
  assert.equal((await new AuditStore(f.db).verify("tenant:test", auditPartition(NOW))).valid, true);
});

test("authenticated HTTP-envelope refusals are durable while invalid credentials remain unattributed", async t => {
  const f = await fixture(); t.after(() => void f.close());
  const secret = "0123456789012345678901234567890123456789012";
  const bridge = createWorkIntakeNodeBridgeV1({ verifier: createFixedWorkIntakeCredentialVerifierV1(secret, principal()),
    service: f.service, now: () => NOW });
  const send = async (body: Buffer, headers: Record<string, string>) => {
    const source = Readable.from(body.length ? [body] : []) as IncomingMessage;
    Object.assign(source, { method: "POST", url: "/v1/projects/project%3Atest/work-batches", headers });
    const response = { writeHead(status: number) { response.status = status; return response; },
      end() { return response; }, status: 0 } as unknown as ServerResponse & { status: number };
    await bridge.handle(source, response); return response.status;
  };
  const auth = { authorization: `Bearer ${secret}` };
  assert.equal(await send(Buffer.from("{}"), { ...auth, "content-type": "text/plain" }), 413);
  assert.equal(await send(Buffer.from("{"), { ...auth, "content-type": "application/json" }), 400);
  assert.equal(await send(Buffer.from('{"idempotencyKey":"one","idempotencyKey":"two","proposal":{}}'),
    { ...auth, "content-type": "application/json" }), 400);
  assert.equal(await send(Buffer.from('{"idempotencyKey":"one","proposal":{},"extra":true}'),
    { ...auth, "content-type": "application/json" }), 400);
  assert.equal(await send(Buffer.alloc(256 * 1024 + 1), { ...auth, "content-type": "application/json" }), 413);
  const recorded = (await f.raw.query<{ reason: string }>(`SELECT safe_metadata->>'reasonCode' reason
    FROM audit_events WHERE action='work_batches.propose.refused' ORDER BY chain_sequence`)).rows;
  assert.deepEqual(recorded.map(row => row.reason), ["http_content_type_refused", "http_envelope_invalid",
    "http_envelope_invalid", "http_envelope_invalid", "http_body_over_limit"]);
  assert.equal(await send(Buffer.from("{"), { authorization: `Bearer ${"x".repeat(43)}`,
    "content-type": "application/json" }), 401);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int count FROM audit_events")).rows[0]!.count, 5);
  assert.equal((await new AuditStore(f.db).verify("tenant:test", auditPartition(NOW))).valid, true);
});

test("transactional authority reread catches revocation after the pre-parse check", async t => {
  const f = await fixture(); t.after(() => void f.close());
  const authorize = f.store.authorize.bind(f.store); let first = true;
  f.store.authorize = async (...args) => {
    const result = await authorize(...args);
    if (first) { first = false; await f.raw.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:proposer'", [NOW]); }
    return result;
  };
  await assert.rejects(f.service.submit({ principal: principal(), projectId: "project:test",
    rawProposal: JSON.stringify(proposal()), idempotencyKey: "revoked-between-checks-0001", now: NOW }), /no_matching_grant/u);
  assert.equal((await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM work_batches")).rows[0]!.count, 0);
});

test("the executable down migration refuses records and removes every owned object when empty", async t => {
  const populated = await fixture(); t.after(() => void populated.close());
  await populated.service.submit({ principal: principal(), projectId: "project:test", rawProposal: JSON.stringify(proposal()),
    idempotencyKey: "down-refusal-record-0001", now: NOW });
  const queueDown = await readFile("db/down/0104_work_batch_agent_queue.sql", "utf8");
  const ownerDown = await readFile("db/down/0102_work_batch_owner_approval.sql", "utf8");
  const down = await readFile("db/down/0093_work_batch_intake.sql", "utf8");
  const graph = await readMigrationGraph(".");
  // 0104's own rung goes first, newest first, exactly as a stacked rollback would
  // take it: 0213's view reads 0104's admissions table, so 0104's down cannot run
  // while that view is still there.
  for (const file of downRungBefore(graph, "0104_work_batch_agent_queue.sql").files)
    await populated.raw.exec(await readFile(`db/down/${file}`, "utf8"));
  await populated.raw.exec(queueDown);
  await assert.rejects(populated.raw.exec(ownerDown), /down migration refused/u);
  await populated.raw.exec("ROLLBACK");
  assert.equal((await populated.raw.query("SELECT 1 FROM work_batches")).rows.length, 1);

  const empty = new PGlite(); t.after(() => void empty.close());
  for (const file of (await readdir("db/migrations")).filter(file => file.endsWith(".sql")).sort())
    await empty.exec(await readFile(`db/migrations/${file}`, "utf8"));
  // The rung is DERIVED from the SQL, not listed by hand. Every policy that
  // reads the intake binding has to be dropped before the binding goes, every
  // table with a foreign key onto work_batches has to go before the table it
  // points at, and 0151/0153 build their append-only triggers on a function
  // 0109 owns -- which is why 0109's down refuses to run before them. A
  // hand-maintained list went stale on exactly that last edge and the
  // executable down migration was never tested against a cluster carrying it.
  const rung = downRungBefore(graph, "0093_work_batch_intake.sql");
  assert.ok(rung.files.includes("0109_pipeline_unattended_advance.sql"),
    "the rung must carry 0109, whose down guards the history guard 0151 and 0153 still build on");
  assert.ok(rung.files.includes("0110_work_batch_intake_flag_dismissals.sql"),
    "the rung must carry 0110, whose table has a foreign key onto work_batches");
  for (const file of [...rung.files, "0093_work_batch_intake.sql"])
    await empty.exec(await readFile(`db/down/${file}`, "utf8"));
  const objects = await empty.query<{ batches: string | null; revisions: string | null; first_guard: string | null; second_guard: string | null }>(
    `SELECT to_regclass('work_batches')::text batches,to_regclass('work_batch_revisions')::text revisions,
      to_regprocedure('guard_proposal_only_work_batch_insert()')::text first_guard,
      to_regprocedure('guard_initial_work_batch_revision_insert()')::text second_guard`);
  assert.deepEqual(objects.rows[0], { batches: null, revisions: null, first_guard: null, second_guard: null });
});

test("project scope, expiry, revocation, and forbidden actions fail before proposal parsing and are audited", async t => {
  const f = await fixture(); t.after(() => void f.close());
  let rawRead = false;
  const malformed = { toString() { rawRead = true; return "{"; } };
  await assert.rejects(f.service.submit({ principal: principal(), projectId: "project:other",
    rawProposal: malformed as unknown as string, idempotencyKey: "wrong-project-0001", now: NOW }), /no_matching_grant/);
  assert.equal(rawRead, false);
  for (const action of ["tasks.assign", "batches.approve", "tasks.dispatch", "tasks.retry", "tasks.cancel", "settings.change"])
    assert.deepEqual(await f.store.authorizeAction(principal(), "project:test", action, NOW),
      { allowed: false, safeReasonCode: "no_matching_grant" });
  assert.deepEqual(await f.store.authorize(principal({ actorType: "human" }), "project:test", NOW),
    { allowed: false, safeReasonCode: "credential_inactive" });
  assert.deepEqual(await f.store.authorize(principal({ actorType: "service" }), "project:test", NOW),
    { allowed: false, safeReasonCode: "credential_inactive" });
  assert.deepEqual(await f.store.authorize(principal({ actorType: "node" }), "project:test", NOW),
    { allowed: false, safeReasonCode: "credential_inactive" });
  await assert.rejects(f.service.submit({ principal: principal({ expiresAt: "2026-09-27T11:59:59.000Z" }),
    projectId: "project:test", rawProposal: malformed as unknown as string,
    idempotencyKey: "expired-agent-0001", now: NOW }), /no_matching_grant/);
  assert.equal(rawRead, false);
  await f.raw.query("UPDATE control_role_grants SET revoked_at=$1 WHERE id='grant:proposer'", [NOW]);
  await assert.rejects(f.service.submit({ principal: principal(), projectId: "project:test", rawProposal: malformed as unknown as string,
    idempotencyKey: "revoked-agent-0001", now: NOW }), /no_matching_grant/);
  assert.equal(rawRead, false);
  const events = await f.raw.query<{ count: number }>("SELECT count(*)::int AS count FROM audit_events");
  assert.equal(events.rows[0]!.count, 9);
  const refusalActors = (await f.raw.query<{ actor_type: string }>(
    "SELECT DISTINCT actor_type FROM audit_events WHERE actor_type IN ('human','service','worker') ORDER BY actor_type")).rows;
  assert.deepEqual(refusalActors, [], "non-agent refusals are not misattributed as intake-agent audit events");
  assert.equal((await new AuditStore(f.db).verify("tenant:test", auditPartition(NOW))).valid, true);
});

test("credential material stays behind the verifier and never enters the durable receipt", async t => {
  const f = await fixture(); t.after(() => void f.close());
  const secret = Object.freeze({ opaque: true }); let seen: unknown;
  const service = new CredentialedWorkBatchServiceV1({ async verify(value) { seen = value; return principal(); } }, f.service, () => NOW);
  const result = await service.submit({ credential: secret, projectId: "project:test",
    rawProposal: JSON.stringify(proposal()), idempotencyKey: "credential-submit-0001" });
  assert.equal(seen, secret);
  assert.doesNotMatch(JSON.stringify(result), /credential|opaque|secret/u);
});
