import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { hmacSha256Tag, sha256Digest } from "../src/security";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";
import { LoopCandidatePublisherV1 } from "../src/improve-control-room/v1/loop-candidate-publisher";
import { loopCandidateEvidenceSchemaV1 } from "../src/improve-control-room/v1/loop-candidate-wire";
import { loopImprovementObservationSchemaV1, loopImprovementRunIdentitySchemaV1 } from "../src/improve-control-room/v1/schemas";
import { loopFinalizationErrorDiagnosticV1 } from "../src/web/v1/improve-control-room-loop-finalization";
import { loopByteHashV1 } from "../src/web/v1/improve-control-room-loop-adapter";

// Optional retained evidence stays outside the repository. No bridge, subprocess,
// live database, credentials or model is used by this reproduction.
test("B5 run-24 mapped completion publishes against signed proof-style database lineage", {
  skip: !process.env.CONTROL_ROOM_B5_REPRO_MAPPED,
}, async t => {
  const evidence = loopCandidateEvidenceSchemaV1.parse(JSON.parse(await readFile(process.env.CONTROL_ROOM_B5_REPRO_MAPPED!, "utf8")));
  const description = await readFile(process.env.CONTROL_ROOM_B5_REPRO_REQUEST!, "utf8");
  const settingsText = await readFile(process.env.CONTROL_ROOM_B5_REPRO_SETTINGS!, "utf8");
  const schemaDigest = process.env.CONTROL_ROOM_B5_REPRO_SCHEMA!;
  const b = evidence.binding;
  assert.equal(loopByteHashV1(description), b.requestSha256);
  assert.equal(loopByteHashV1(settingsText), b.settingsSha256);
  const f = await taskFixture(); t.after(() => f.db.close());
  const key = new Uint8Array(32).fill(64), at = new Date(now).toISOString();
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
  // Preserve all run evidence bytes, including project/request/link ids. Only
  // the disposable owner, tenant, clock and signing key belong to the fixture.
  await f.db.query(`INSERT INTO projects SELECT (jsonb_populate_record(NULL::projects,
    to_jsonb(p) || $2::jsonb)).* FROM projects p WHERE id=$1`, [f.project.projectId,
    JSON.stringify({ id: b.projectId, source_record_id: b.projectId })]);
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`, [b.projectId]);
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES($1,$2,'active',1,$3,$3)`, [scope.tenantId,b.projectId,at]);
  const common = { tenant_id: scope.tenantId, project_id: b.projectId, owner_identity_id: "identity:web", created_at: at };
  const insert = async (table: string, purpose: string, record: Record<string, unknown>) => {
    const row = { ...record, record_digest: sha256Digest(record), auth_tag: hmacSha256Tag(key, { purpose, record }) };
    const names = Object.keys(row);
    await f.db.query(`INSERT INTO ${table}(${names.join(",")}) VALUES(${names.map((_,i)=>`$${i+1}`).join(",")})`,
      Object.values(row).map(v=>v!==null&&typeof v==="object"?JSON.stringify(v):v));
  };
  await insert("control_loop_improvement_requests", "loop-improvement-request/v1", {
    ...common, id: b.requestId, idempotency_key: "b5-repro-intake-0001" });
  await insert("control_loop_improvement_inputs", "loop-improvement-input/v1", {
    ...common, request_id: b.requestId, version: b.localVersion, description, settings_text: settingsText,
    request_sha256: b.requestSha256, settings_sha256: b.settingsSha256, idempotency_key: "b5-repro-input-0001" });
  await insert("control_loop_improvement_run_links", "loop-improvement-run-link/v1", {
    ...common, id: b.runLinkId, request_id: b.requestId, initial_input_version: b.localVersion,
    adapter_id: b.adapterId, loop_run_id: b.loopRunId, tooling_revision: b.toolingRevision, a2_schema_version: 1 });
  const authorizationId = "loop-authorization:b5-reproduction";
  await insert("control_loop_improvement_authorizations", "loop-improvement-authorization/v1", {
    ...common, id: authorizationId, request_id: b.requestId, input_version: b.localVersion, run_link_id: b.runLinkId,
    start_key: "start:b5-repro-confirm-0001", request_sha256: b.requestSha256, settings_sha256: b.settingsSha256,
    a2_input_version: b.a2InputVersion, a2_settings_digest: b.settingsSha256, observed_revision: 4,
    confirmation: { path: "docs/request-source.md", sha256: b.requestSha256, who: "owner", at, input_version: b.a2InputVersion } });
  const binding = { schemaVersion: 1, body: { expectedVersion: b.localVersion, expectedRevision: 4, runLinkId: b.runLinkId },
    localVersion: b.localVersion, adapterId: b.adapterId, loopRunId: b.loopRunId, toolingRevision: b.toolingRevision,
    a2SchemaVersion: 1, schemaDigest, requestSha256: b.requestSha256, settingsSha256: b.settingsSha256,
    runLinkId: b.runLinkId, authorizationId, inputVersion: b.a2InputVersion, expectedRevision: 4, evidence: null };
  for (const entry_kind of ["claim", "result"]) await insert("control_loop_improvement_commands", "loop-improvement-command/v1", {
    ...common, command_id: `loop-command:${"1".repeat(32)}`, entry_kind, request_id: b.requestId, operation: "start",
    idempotency_key: "b5-repro-browser-start-0001", binding, result: entry_kind==="claim"?null:{state:"accepted",revision:5,
      adapterId:b.adapterId,loopRunId:b.loopRunId,toolingRevision:b.toolingRevision,evidenceDigest:sha256Digest("fixture start"),error:null} });
  const contract = { toolingRevision:b.toolingRevision, decodeRunIdentity:(v:unknown)=>loopImprovementRunIdentitySchemaV1.parse(v),
    decodeObservation:(v:unknown)=>loopImprovementObservationSchemaV1.parse(v), matchesSavedInput:()=>true };
  const source = { toolingRevision:b.toolingRevision,schemaDigest,readVerifiedCompletion:async()=>structuredClone(evidence) };
  const repository = { observe:async()=>({baseRevision:b.baseRevision,candidateRevision:b.candidateRevision,
    changedPaths:["index.html"],addedPaths:[],commitSubjects:["Fixture retained candidate"]}) };
  const config = { integrityKey:key,contract,schemaDigest,source,repository };
  const desk = new ImproveControlRoomDeskServiceV1(f.client,scope,key,undefined,()=>now,contract,config);
  const publisher = new LoopCandidatePublisherV1(desk,config);
  const input = { runLinkId:b.runLinkId,completionDigest:evidence.completionDigest };
  const stages:string[]=[];
  await assert.rejects(publisher.publishCompletion(input,stage=>stages.push(stage)),error=>{
    assert.ok(error instanceof Error);
    assert.equal((error as Error&{code:string}).code,"23514");
    assert.deepEqual(loopFinalizationErrorDiagnosticV1(error),[error.constructor.name,"loop candidate reviews shape rejected"]);
    return true;
  });
  assert.deepEqual(stages,["prepare","verify","record"]);
  const forbidden=["selectedModel","identityBasis"];
  for(const review of evidence.reviews)for(const field of forbidden)assert.ok(field in review);
  const rows=await f.client.query("SELECT payload FROM control_loop_update_candidates");
  assert.equal(rows.rows.length,0);
  console.log("RESULT: PASS run-24 original mapped bytes reproduce SQLSTATE 23514 reviews shape rejected at record; prepare and verify pass, no candidate recorded");
});

test("B5 selected review identity reproduces SQL contract mismatch at record",async t=>{
  const {syntheticCandidateFixture}=await import("./helpers/improve-control-room-loop-finalization");
  const f=await syntheticCandidateFixture();t.after(f.close);
  f.edit(e=>{for(const review of e.reviews)Object.assign(review,{selectedModel:"Fixture selected model",identityBasis:"selected"});});
  const otherSchema=sha256Digest("Fixture mismatched schema");
  const mismatched={...f.config,schemaDigest:otherSchema,source:{...f.config.source,schemaDigest:otherSchema}};
  const unprepared=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},
    f.config.integrityKey,undefined,()=>now,f.config.contract,mismatched);
  const preparing:string[]=[];
  await assert.rejects(new LoopCandidatePublisherV1(unprepared,mismatched).publishCompletion(
    {runLinkId:f.runLinkId,completionDigest:f.evidence().completionDigest},stage=>preparing.push(stage)),{code:"conflict"});
  assert.deepEqual(preparing,["prepare"]);
  f.dirty(true);
  const verifying:string[]=[];
  await assert.rejects(f.publisher.publishCompletion({runLinkId:f.runLinkId,completionDigest:f.evidence().completionDigest},stage=>verifying.push(stage)),
    /SYNTHETIC dirty repository/);
  assert.deepEqual(verifying,["prepare","verify"]);f.dirty(false);
  const stages:string[]=[];
  await assert.rejects(f.publisher.publishCompletion({runLinkId:f.runLinkId,completionDigest:f.evidence().completionDigest},stage=>stages.push(stage)),
    {code:"23514",message:"loop candidate reviews shape rejected"});
  assert.deepEqual(stages,["prepare","verify","record"]);
  assert.equal((await f.client.query("SELECT id FROM control_loop_update_candidates")).rows.length,0);
  // Positive control isolates the SQL exact-key mismatch. This only changes the
  // synthetic fixture, never the run-24 evidence or the product mapping.
  f.edit(e=>{for(const review of e.reviews){delete review.selectedModel;delete review.identityBasis;}});
  assert.equal((await f.publish()).state,"recorded");
  console.log("RESULT: PASS synthetic prepare/verify/record stage probes; review identity SQL mismatch isolated by successful positive control");
});
