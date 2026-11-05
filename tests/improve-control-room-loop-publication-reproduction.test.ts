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
import { createImproveControlRoomLoopFinalizerV1, verifyFinalizationRecordV1 } from "../src/web/v1/improve-control-room-loop-finalization";
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
  const receipt = await publisher.publishCompletion(input, stage => stages.push(stage));
  assert.equal(receipt.state, "recorded");
  assert.deepEqual(stages, ["prepare", "verify", "record"]);
  assert.equal((await publisher.publishCompletion(input)).state, "replayed");
  const rows = await f.client.query<{payload:typeof evidence}>("SELECT payload FROM control_loop_update_candidates");
  assert.equal(rows.rows.length, 1);
  assert.deepEqual(rows.rows[0]!.payload, evidence);
  assert.deepEqual((await desk.readLoopCandidate(f.identity,b.projectId,b.requestId)).candidate?.evidence.reviews,evidence.reviews);
  // A synthetic envelope exercises the product's private verifyPublication via
  // its exported record verifier, using the actual newly persisted receipt.
  const target={schemaVersion:1 as const,...scope,projectId:b.projectId,requestId:b.requestId,ownerIdentityId:"identity:web",
    runLinkId:b.runLinkId,localVersion:b.localVersion,authorizationId,startCommandId:`loop-command:${"1".repeat(32)}`,
    startBindingDigest:sha256Digest(binding),run:{adapterId:b.adapterId,loopRunId:b.loopRunId,toolingRevision:b.toolingRevision,a2SchemaVersion:1 as const},
    inputVersion:b.a2InputVersion,requestSha256:b.requestSha256,settingsSha256:b.settingsSha256,
    settingsDigest:b.settingsSha256,expectedRevision:b.engineRevision,schemaDigest};
  const finalBinding={...target,eventDigest:sha256Digest("SYNTHETIC run-24 finalization envelope")};
  const inventoryDigest=sha256Digest("SYNTHETIC run-24 retained inventory");
  const material={schemaVersion:1,binding:finalBinding,sequence:1,previousDigest:null,phase:"published",
    observation:{schemaVersion:1,binding:finalBinding,outcome:"candidate_ready",reasonCode:"FINISHED",evidenceDigest:sha256Digest(evidence),
      completionDigest:evidence.completionDigest,inventoryDigest,observedAt:at},
    custody:{schemaVersion:1,binding:finalBinding,inventoryDigest,retentionDigest:evidence.retentionDigest,verifiedAt:at},
    termination:{schemaVersion:1,binding:finalBinding,inventoryDigest,state:"already-ended",ownershipDigest:inventoryDigest,observedAt:at},
    publication:receipt,cleanup:null,recordedAt:at};
  assert.equal(verifyFinalizationRecordV1({...material,recordDigest:sha256Digest(material)},target).publication?.state,"recorded");
  const wrongReceipt={...material,publication:{...receipt,engineRevision:receipt.engineRevision+1}};
  assert.throws(()=>verifyFinalizationRecordV1({...wrongReceipt,recordDigest:sha256Digest(wrongReceipt)},target),/loop_finalization_unavailable/);
  console.log("RESULT: PASS run-24 original mapped bytes publish through record, replay and verifyPublication; stored reviews and owner detail preserve both identity fields");
});

test("B5 selected review identity publishes through record and finalization receipt verification",async t=>{
  const {finalizationFixture}=await import("./helpers/improve-control-room-loop-finalization");
  const f=await finalizationFixture();t.after(f.close);
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
  // Refresh the sealed synthetic finalization observation after adding identity fields.
  const evidence=f.evidence();
  f.state.retentionDigest=evidence.retentionDigest;
  f.state.observation={...f.state.observation,completionDigest:evidence.completionDigest,
    binding:{...f.state.observation.binding,eventDigest:sha256Digest({outcome:"candidate_ready",completionDigest:evidence.completionDigest})}};
  const {join}=await import("node:path");
  for(const name of Object.keys(f.state.corpus))f.state.corpus[name]=sha256Digest([...await readFile(join(f.retained,name))]);
  f.state.observation.inventoryDigest=sha256Digest(f.state.corpus);await f.save();
  const stages:string[]=[];
  const record=await createImproveControlRoomLoopFinalizerV1({capability:f.capability,
    authorize:async()=>f.target,signal:new AbortController().signal,
    publishCompletion:(input,onStage)=>f.publisher.publishCompletion(input,stage=>{stages.push(stage);onStage?.(stage);}),
  }).finalize(f.target);
  assert.equal(record?.phase,"cleanup");assert.ok(record.publication);
  assert.deepEqual(stages,["prepare","verify","record"]);
  assert.equal((await f.publish()).state,"replayed");
  const rows=await f.client.query<{payload:typeof evidence}>("SELECT payload FROM control_loop_update_candidates");
  assert.equal(rows.rows.length,1);assert.deepEqual(rows.rows[0]!.payload.reviews,evidence.reviews);
  const card=(await f.desk.readLoopCandidate(f.identity,f.project.projectId,f.requestId)).candidate!;
  assert.deepEqual(card.evidence.reviews,evidence.reviews);
  const page=await f.desk.readLoopCandidates(f.identity);
  assert.deepEqual(page.candidates[0]!.evidence.reviews,evidence.reviews);
  console.log("RESULT: PASS synthetic identity publication reaches record, verifyPublication, published and announced; detail and owner list readers preserve identity");
});
