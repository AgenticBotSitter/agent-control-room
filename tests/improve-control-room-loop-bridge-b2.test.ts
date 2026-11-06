import { S4_FIXTURE_ROUTE, s4FixtureRoutes, s4FixtureContractRoutes, s4ProviderServiceV1, s4TaskFixture } from './helpers/improve-control-room-loop-recovery';
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { nodeExchange } from "./helpers/web-node";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loopApprovalDescriptorSchemaV1 } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { sha256Digest } from "../src/security";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1,
  type LoopBridgeBindingV1 } from "../src/improve-control-room/v1/schemas";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, loopEngineStatusSchemaV1,
  type LoopAdapterV1, type LoopEngineStatusV1, type LoopAdapterConfigurationV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { createPrivateNodeHandler } from "../src/web/v1/private-node-handler";
import { privateRequestBodyLimit } from "../src/web/v1/private-request-budgets";
import { taskFixture } from "./helpers/web-task";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { now, origin, request, token, trust } from "./helpers/web-foundation";

const KEY = new Uint8Array(32).fill(64);
const settingsText = JSON.stringify({ project: { host_adapter: "local-loop" }, fixture: "SYNTHETIC", providerRoute:S4_FIXTURE_ROUTE });
const description = "Show the exact saved improvement.";

// Explicit SYNTHETIC executable: no worker/agent/provider is invoked. It records
// argv/env/cwd and persists only disposable run facts for the seven fixed calls.
const executable = String.raw`import os,sys,json,hashlib,fcntl
root=os.path.abspath(os.path.join(os.path.dirname(__file__),'../../..'))
op,run=sys.argv[1:3]; args=sys.argv[3:]
path=os.path.join(root,'runs',run+'.json')
lock=open(path+'.lock','a'); fcntl.flock(lock,fcntl.LOCK_EX)
def h(s): return hashlib.sha256(s.encode()).hexdigest()
def flag(k): return args[args.index(k)+1]
expected=None
if '--expect' in args:
    with open(flag('--expect')) as f: expected=json.load(f)
with open(os.path.join(root,'trace.jsonl'),'a') as f:
    f.write(json.dumps(dict(op=op,run=run,args=args,env=dict(os.environ),cwd=os.getcwd(),expectation=expected,
        expectationText=open(flag('--expect')).read() if expected else None,
        fileMode=os.stat(flag('--expect')).st_mode & 0o777 if expected else None,
        directoryMode=os.stat(os.path.dirname(flag('--expect'))).st_mode & 0o777 if expected else None))+'\n')
if op=='intake':
    with open(flag('--source')) as f: text=f.read()
    with open(flag('--settings')) as f: settings=f.read()
    s=dict(run=run,revision=1,inputVersion=1,state='draft',description=text,settingsSha256=h(settings),settingsDigest=h(settings),confirmation=None,approval=None,question=None,progress=dict(step='intake',completed=0,attention='none'),admissions=[])
else:
    with open(path) as f: s=json.load(f)
def emit(error=None, output='envelope'):
    if output=='malformed': print('unreadable'); return
    if output=='empty': return
    request=dict(input_version=s['inputVersion'],sha256=h(s['description']),text=s['description'],settings_sha256=s['settingsSha256'],confirmation=s['confirmation'],approval=s['approval'],question=s['question'],admissions=s['admissions'][-20:])
    print(json.dumps(dict(schema_version=1,run=run,state=s['state'],revision=s['revision'],next=None,attention=dict(code='OWNER_REQUIRED') if s['state']=='waiting' else None,steps=[],counters=dict(fixture=s),error=dict(code=error) if error else None,request=None if output=='null-request' else request)))
def refuse(code): emit(code); sys.exit(2)
control={}
refusal=os.path.join(root,'refusal.json')
if os.path.exists(refusal):
    with open(refusal) as f: control=json.load(f)
    if control['op']!=op: control={}
if control and not control.get('afterSave'):
    emit('REFUSED',control.get('output','envelope'))
    if control.get('breakStatus'): os.remove(path)
    sys.exit(control['code'])
operation='confirm' if op=='confirm-request' else op
if expected is not None:
    approval=s['approval']; question=s['question']
    approval_pin=dict(piece=approval['step'],report_sha256=approval['reportSha256'],head=approval['head'],input_version=approval['inputVersion']) if operation=='approve' and approval else None
    question_pin=dict(id=question['questionId'],input_version=question['inputVersion'],report_sha256=question['reportSha256']) if operation=='answer' and question else None
    pins=dict(schema_version=1,command_id=expected['command_id'],binding_digest=expected['binding_digest'],operation=operation,run=run,
        revision=None if op=='intake' else s['revision'],input_version=None if op=='intake' else s['inputVersion'],
        request_sha256=h(s['description']),settings_sha256=s['settingsSha256'],approval=approval_pin,question=question_pin)
    if expected!=pins: refuse('EXPECT_CHANGED')
    if any(r['command_id']==expected['command_id'] for r in s['admissions']): refuse('COMMAND_REPLAYED')
    if op=='confirm-request' and s['confirmation']: refuse('EXPECT_CHANGED')
# The guarded fixture never substitutes a JS status comparison for its lock.
# Missing --expect deliberately creates no admission; the product stays uncertain.
at='2026-10-01T00:00:00.000Z'
evidence=None
if op=='intake': evidence=dict(request_sha256=h(text),settings_sha256=h(settings),input_version=1)
if op=='confirm-request':
    if flag('--sha256')!=h(s['description']): refuse('EXPECT_CHANGED')
    s['confirmation']=dict(path='request.md',sha256=h(s['description']),at=at,who='owner',input_version=s['inputVersion'])
    s['state']='ready';s['revision']+=1
    evidence={k:v for k,v in s['confirmation'].items() if k!='path'}
if op=='start':
    s['state']='running';s['revision']+=1;s['progress']['step']='plan'
    evidence=dict(launch_key='a'*32,step=2,role='plan',input_version=s['inputVersion'],settings_sha256=s['settingsSha256'])
if op=='stop': s['state']='stopped';s['revision']+=1
if op=='approve':
    a=s['approval'];evidence=dict(piece=a['step'],report_sha256=a['reportSha256'],head=a['head'],input_version=a['inputVersion'])
    s['approval']=None;s['state']='running'
if op=='answer':
    q=s['question']
    if int(flag('--input-version'))!=q['inputVersion'] or q['inputVersion']!=s['inputVersion']: refuse('QUESTION_STALE')
    with open(flag('--file')) as f: answer=f.read()
    evidence=dict(question_id=q['questionId'],input_version=q['inputVersion'],report_sha256=q['reportSha256'],answer_sha256=h(answer))
    s['question']=None;s['state']='running';s['revision']+=1
if expected is not None:
    record=dict(command_id=expected['command_id'],operation=operation,binding_digest=control.get('bindingDigest',expected['binding_digest']),at=at,evidence=evidence)
    s['admissions'].append(record)
if op!='status':
    with open(path+'.tmp','w') as f: json.dump(s,f)
    os.replace(path+'.tmp',path)
emit(None,control.get('output','envelope'))
if control: sys.exit(control['code'])
`;

// Same operation-specific admission grammar and canonical whole-record mapping
// as the reviewed A2 contract. Invalid records fail the entire observation.
const rawHash = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().positive();
const admissionTime = z.string().datetime({offset:true});
const recordBase = {command_id:z.string().regex(/^loop-command:[a-f0-9]{32}$/),
  binding_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),at:admissionTime};
const admissionRecords = z.array(z.discriminatedUnion("operation", [
  z.object({...recordBase,operation:z.literal("intake"),evidence:z.object({request_sha256:rawHash,settings_sha256:rawHash,input_version:z.literal(1)}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("confirm"),evidence:z.object({sha256:rawHash,input_version:version,at:admissionTime,who:z.literal("owner")}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("start"),evidence:z.object({launch_key:z.string().regex(/^[a-f0-9]{32}$/),step:version,role:z.string().min(1),input_version:version,settings_sha256:rawHash}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("approve"),evidence:z.object({piece:z.enum(["plan","spec"]),report_sha256:rawHash,head:z.string().regex(/^[a-f0-9]{40}$/),input_version:version}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("answer"),evidence:z.object({question_id:z.string().min(1),input_version:version,report_sha256:rawHash,answer_sha256:rawHash}).strict()}).strict(),
])).max(20).refine(records=>new Set(records.map(r=>r.command_id)).size===records.length);

async function synthetic(t: TestContext) {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/b1b-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["runs", "work"]) await mkdir(join(root, dir));
  await mkdir(join(root,"tools/loop/bridge"),{recursive:true});
  await writeFile(join(root,"tools/loop/cr.py"),'import json; print(json.dumps(dict(eligible=True,reasons=[])))\n');
  await writeFile(join(root, "tools/loop/bridge/engine.py"), executable);
  await writeFile(join(root, "tooling.json"), JSON.stringify({ fixture: "SYNTHETIC", revision: 1 }));
  await writeFile(join(root, "settings.json"), settingsText); await writeFile(join(root, "availability.json"), "{}");
  const toolingRevision = `sha256:${loopByteHashV1(await readFile(join(root, "tooling.json")))}`;
  const lineage = { toolingRevision, decodeRunIdentity: (input: unknown) => {
    const value = loopImprovementRunIdentitySchemaV1.parse(input);
    assert.match(value.loopRunId, /^fixture-run-[a-f0-9]{32}$/); return value;
  }, decodeObservation: (input: unknown) => loopImprovementObservationSchemaV1.parse(input),
  matchesSavedInput: (_run: unknown, observation: { settingsDigest: string; confirmation: { path: string; sha256: string } }, input: { description: string; settingsText: string; requestSha256: string; settingsSha256: string }) =>
    observation.settingsDigest === loopByteHashV1(input.settingsText) && observation.confirmation.path === "request.md"
      && observation.confirmation.sha256 === loopByteHashV1(input.description) && input.requestSha256 === loopByteHashV1(input.description)
      && input.settingsSha256 === loopByteHashV1(input.settingsText) };
  const observations = new Map<string, LoopEngineStatusV1>();
  let raw: LoopAdapterV1;
  let documentNames = { report: "report.md", sidecar: "report.json" };
  let beforeAdmission: (() => Promise<void>) | undefined;
  const configuration: LoopAdapterConfigurationV1 = { adapterId: "adapter:synthetic", interpreter: realpathSync(process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/python3" : "/usr/bin/python3"),
    interpreterSha256: loopByteHashV1(await readFile(realpathSync(process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/python3" : "/usr/bin/python3"))),
    entrypointSha256: loopByteHashV1(executable), entrypoint: join(root, "tools/loop/bridge/engine.py"), toolingManifest: join(root, "tooling.json"), configRoot: root,
    workRoot: join(root, "work"), runRoot: join(root, "runs"), cwd: root, settingsFile: join(root, "settings.json"),
    availabilityFile: join(root, "availability.json"), toolingRevision, settingsSha256: loopByteHashV1(settingsText), availabilitySha256: loopByteHashV1("{}"),
    executionIdentity: { uid: process.getuid!(), isolationEvidenceDigest: `sha256:${"b".repeat(64)}` }, timeoutMs: 1000,
    contract: { lineage, providerRoutes:s4FixtureContractRoutes, schemaDigest: `sha256:${"c".repeat(64)}`, generateRunId: () => `fixture-run-${randomBytes(16).toString("hex")}`,
      qualifiedOperations: ["intake", "confirm", "start", "stop", "approve", "answer"],
      locateApprovalDocument: () => documentNames,
      decodeApprovalSidecar: (output: unknown) => loopApprovalDescriptorSchemaV1.parse(output),
      decisionProjection: { questionTextPath: ["counters", "fixture", "questionText"], decodeGate: (output, status) => {
        const raw = (output as {counters:{fixture:{questionText: string|null; blockedCode?:"QUESTION_LIMIT"|"INPUT_CHANGED"}}}).counters.fixture;
        return raw.blockedCode ? {kind:"blocked",code:raw.blockedCode,message:"The saved run requires owner attention."}
          : status.question ? {kind:"question",text:raw.questionText} : status.approval ? {kind:"approve"} : !status.confirmation ? {kind:"confirm"} : null;
      } },
      decodeStatus: (output: unknown) => {
        const e = output as {schema_version:number;run:string;request:{admissions:unknown}|null;counters:{fixture:Record<string,unknown>}};
        assert.equal(e.schema_version,1);assert.match(e.run,/^fixture-run-[a-f0-9]{32}$/);
        assert.ok(e.request,"A2 request channel is required");
        const records=admissionRecords.parse(e.request.admissions);
        const {questionText:_text,blockedCode:_code,admissions:_admissions,...engine}=e.counters.fixture;
        const status=loopEngineStatusSchemaV1.parse({...engine,run:{adapterId:"adapter:synthetic",loopRunId:e.run,toolingRevision,a2SchemaVersion:1},
          receipts:records.map(record=>({commandId:record.command_id,bindingDigest:record.binding_digest,
            state:"accepted",evidenceDigest:sha256Digest(record),error:null}))});
        observations.set(e.run,structuredClone(status));return status;
      }, admissionExpectation: async (binding, context) => {
        if (!Object.isFrozen(binding) || !Object.isFrozen(binding.body) || !Object.isFrozen(context)
          || !context || !/^loop-command:[a-f0-9]{32}$/.test(context.commandId)
          || !["intake","confirm","start","approve","answer"].includes(context.operation)) throw new Error("loop_adapter_unavailable");
        const op=context.operation,current=observations.get(binding.loopRunId),body=binding.body;
        let approval=null,question=null;
        if(op==="intake") {
          if(current || binding.runLinkId!==null || binding.inputVersion!==null || binding.expectedRevision!==null || binding.evidence!==null
            || typeof body.description!=="string") throw new Error("loop_adapter_unavailable");
        } else {
          if(!current || current.run.adapterId!==binding.adapterId || current.run.toolingRevision!==binding.toolingRevision
            || current.revision!==binding.expectedRevision || current.inputVersion!==binding.inputVersion
            || loopByteHashV1(current.description)!==binding.requestSha256 || current.settingsSha256!==binding.settingsSha256) throw new Error("loop_adapter_unavailable");
          if(op==="approve") {
            const a=current.approval;
            if(!a || sha256Digest(a)!==binding.evidence || a.step!==body.step || a.inputVersion!==body.inputVersion
              || a.head!==body.head || a.reportSha256!==body.reportSha256) throw new Error("loop_adapter_unavailable");
            approval={piece:a.step,report_sha256:a.reportSha256,head:a.head,input_version:a.inputVersion};
          } else if(op==="answer") {
            const q=current.question;
            if(!q || sha256Digest(q)!==binding.evidence || !q.owner || q.changesInput || q.questionId!==body.questionId
              || q.inputVersion!==body.inputVersion || q.reportSha256!==body.questionReportSha256) throw new Error("loop_adapter_unavailable");
            question={id:q.questionId,input_version:q.inputVersion,report_sha256:q.reportSha256};
          } else if(binding.evidence!==null || (op==="confirm" ? typeof body.requestSha256!=="string" : typeof body.runLinkId!=="string")) throw new Error("loop_adapter_unavailable");
        }
        const expected={schema_version:1,command_id:context.commandId,binding_digest:sha256Digest(binding),operation:op,
          run:binding.loopRunId,revision:op==="intake"?null:binding.expectedRevision,input_version:op==="intake"?null:binding.inputVersion,
          request_sha256:binding.requestSha256,settings_sha256:binding.settingsSha256,approval,question};
        await beforeAdmission?.();return expected;
      } } };
  raw = createImproveControlRoomLoopAdapterV1(configuration);
  t.after(() => raw.close());
  const adapter = raw;
  const edit = async (run: string, changes: Partial<LoopEngineStatusV1> & {questionText?:unknown;blockedCode?:"QUESTION_LIMIT"|"INPUT_CHANGED"}) => {
    const path = join(root, "runs", `${run}.json`), saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, ...changes, run: saved.run }));
  };
  const traces = async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) as
    {op:string;run:string;args:string[];env:Record<string,string>;cwd:string;expectation:Record<string,unknown>|null;expectationText:string|null;fileMode:number|null;directoryMode:number|null}[];
  return { root, adapter, raw, configuration, edit, traces, clearObservations:()=>observations.clear(), setDocumentNames: (names: typeof documentNames) => { documentNames = names; }, setBeforeAdmission: (callback: () => Promise<void>) => { beforeAdmission = callback; } };
}
async function fixture(t: TestContext) {
  const f = await s4TaskFixture(); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const engine = await synthetic(t);
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, {providers:s4ProviderServiceV1(f.client,{ tenantId: "tenant:web", workspaceId: "workspace:web" },() => now), integrityKey: KEY, adapter: engine.adapter }, () => now);
  const service = new ImproveControlRoomDeskServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, KEY, undefined, () => now);
  const handler = createImproveControlRoomHttpHandlerV1({ origin, trust, service, clock: () => now, loopBridge: bridge });
  const base = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements/loop`;
  let sequence = 0;
  const post = (suffix: string, body: unknown, key = `b1b-request-${String(++sequence).padStart(8, "0")}`) => handler(request(`${base}/${suffix}`, "POST", suffix.endsWith("/start")?{route:S4_FIXTURE_ROUTE,...body as object}:body, key));
  const get = (id: string) => bridge.status(f.identity, f.project.projectId, id);
  const intake = async () => { const response = await post("intake", { description }); assert.equal(response.status, 202); const receipt = await response.json() as { requestId: string; state: string }; assert.equal(receipt.state, "accepted"); return receipt.requestId; };
  const confirm = async (id: string) => { const s = await get(id); const response = await post(`${encodeURIComponent(id)}/confirm`, { expectedVersion: s.request.currentVersion,
    expectedRevision: s.engine.revision, requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 }); assert.equal(response.status, 202); assert.equal((await response.json() as {state:string}).state,"accepted","A2 confirm requires an engine record"); return get(id); };
  return { ...f, ...engine, bridge, service, handler, base, post, get, intake, confirm };
}

for (const step of ["1", "intake", "42", null]) test(`B1b intake completion ignores display step ${step}`, async t => {
  const f = await fixture(t);
  const adapter = { ...f.adapter, intake: async (...args: Parameters<LoopAdapterV1["intake"]>) => {
    const status = await f.adapter.intake(...args);
    return { ...status, progress: { ...status.progress, step } };
  } };
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" },
    {providers:s4ProviderServiceV1(f.client,{ tenantId: "tenant:web", workspaceId: "workspace:web" },() => now), integrityKey: KEY, adapter }, () => now);
  const result = await bridge.mutate(f.identity, f.project.projectId, null, "intake", { description }, "b1b-display-step-0001");
  assert.equal(result.state, "accepted", "intake admission is independent of display step");
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_run_links")).rows.length, 1);
});

// A2 chain_emit exposes steps[].n/role/model/identity; the reviewed decoder
// supplies these display values. Role names match A2 ROLES, including reviews.
test("B1b A2 live progress reaches the run panel", async t => {
  const f=await fixture(t),id=await f.intake();
  const initial=await f.get(id),run=initial.request.runLink!.loopRunId;
  const roles=["orchestrator","plan","plan-review","spec","spec-review","build",
    "code-review","attack-review","ui-review","ci-review","final"];
  for(const [index,role] of roles.entries()){
    const progress={step:String(index+1),role,attempt:2,requestedModel:"model:requested",
      observedModel:index===0?null:"model:observed",repairCount:3,completed:index,attention:"none" as const};
    await f.edit(run,{progress});
    const status=await f.get(id);
    assert.deepEqual(status.engine.progress,progress,"wire preserves decoded A2 progress");
    assert.deepEqual(status.display.progress,{stepId:String(index+1),role,attempt:2,
      requestedModel:"model:requested",observedModel:progress.observedModel,identityVerified:false,repairCount:3},
      "run panel shows saved model, role, step, attempt and repair values");
  }
  // The decoder reports A2's observed identity (cr.py chain_model_identity status "observed").
  const verified={step:"4",role:"plan-review",attempt:2,requestedModel:"model:requested",observedModel:"model:observed",
    identityVerified:true,repairCount:1,completed:3,attention:"owner" as const};
  await f.edit(run,{progress:verified});
  assert.deepEqual((await f.get(id)).display.progress,{stepId:"4",role:"plan-review",attempt:2,requestedModel:"model:requested",
    observedModel:"model:observed",identityVerified:true,repairCount:1},"verified identity reaches the run panel");
  await f.edit(run,{progress:{...verified,observedModel:null}});
  assert.equal((await f.get(id)).display.progress?.identityVerified,false,"verified needs an observed model");
  await f.edit(run,{progress:{step:"plan",completed:0,attention:"none"}});
  assert.deepEqual((await f.get(id)).display.progress,{stepId:"plan",role:null,attempt:null,
    requestedModel:null,observedModel:null,identityVerified:false,repairCount:null},"missing evidence remains unavailable");
});

test("B1b A2 expect pins", async t => {
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const before=await f.raw.status(run);let savedBefore="",statusReadsAtHook=0;
  f.setBeforeAdmission(async()=>{statusReadsAtHook=(await f.traces()).filter(r=>r.op==="status").length;await f.edit(run,{revision:before.revision+1});savedBefore=await readFile(join(f.root,"runs",run+".json"),"utf8");});
  const result=await f.bridge.mutate(f.identity,f.project.projectId,id,"start",{route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,
    runLinkId:s.request.runLink!.runLinkId},"b1b-a2-expect-start-0001");
  const trace=(await f.traces()).find(row=>row.op==="start")!;
  assert.ok(trace.args.includes("--expect"),"A2 Start includes exact --expect bytes");
  const claim=(await f.db.query<{command_id:string;binding:LoopBridgeBindingV1}>("SELECT command_id,binding FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0]!;
  assert.deepEqual(trace.expectation,{schema_version:1,command_id:claim.command_id,binding_digest:sha256Digest(claim.binding),operation:"start",run,
    revision:before.revision,input_version:before.inputVersion,request_sha256:loopByteHashV1(description),settings_sha256:loopByteHashV1(settingsText),approval:null,question:null},
    "A2 engine receives the original cached pins, explicit operation and claim id");
  assert.equal(result.state,"refused");
  assert.equal(await readFile(join(f.root,"runs",run+".json"),"utf8"),savedBefore,"EXPECT_CHANGED leaves run bytes identical with zero launch effects");
  assert.equal((await f.traces()).filter(r=>r.op==="status").length,statusReadsAtHook,"expectation construction performs no post-hook status reread");
  const after=await f.raw.status(run);assert.equal(after.state,"ready");assert.equal(after.receipts.length,before.receipts.length);
});

test("B1b A2 engine receipts refuse lead confirmation and mismatched record",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.get(id),run=s.request.runLink!.loopRunId;
  const lead=spawnSync(f.configuration.interpreter,[f.configuration.entrypoint,"confirm-request",run,"--sha256",s.engine.requestSha256,"--json"],
    {cwd:f.root,env:{NODE_ENV:"production",LANG:"C.UTF-8"},encoding:"utf8"});assert.equal(lead.status,0);
  const current=await f.get(id);
  const refused=await f.bridge.mutate(f.identity,f.project.projectId,id,"confirm",{expectedVersion:1,expectedRevision:current.engine.revision,
    requestSha256:current.engine.requestSha256,settingsSha256:current.engine.settingsSha256},"b1b-a2-lead-confirm-0001");
  assert.equal(refused.state,"refused");assert.equal((await f.get(id)).request.savedAuthorization,false);
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_authorizations")).rows.length,0);
  await writeFile(join(f.root,"refusal.json"),JSON.stringify({op:"intake",code:0,afterSave:true,bindingDigest:`sha256:${"f".repeat(64)}`}));
  const mismatch=await f.bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},"b1b-a2-foreign-receipt-0001");
  assert.equal(mismatch.state,"uncertain","an engine record with another binding never satisfies this claim");
});

test("B1b A2 expect pins cache and context refuse before files or spawn",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const binding:LoopBridgeBindingV1={schemaVersion:1,body:{route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},
    localVersion:1,adapterId:f.raw.adapterId,loopRunId:run,toolingRevision:f.raw.toolingRevision,a2SchemaVersion:1,schemaDigest:f.raw.schemaDigest,
    requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText),runLinkId:s.request.runLink!.runLinkId,
    authorizationId:"authorization:fixture",inputVersion:1,expectedRevision:s.engine.revision,evidence:null};
  const commandId=`loop-command:${"e".repeat(32)}`,context=Object.freeze({operation:"start" as const,commandId});
  const freeze=(b:LoopBridgeBindingV1)=>Object.freeze({...b,body:Object.freeze({...b.body})});
  const callback=f.configuration.contract.admissionExpectation!;
  const traces=(await f.traces()).length;
  await assert.rejects(async()=>callback(freeze(binding),undefined as never),/unavailable/);
  await assert.rejects(async()=>callback(freeze(binding),Object.freeze({...context,operation:"confirm"})),/unavailable/);
  await assert.rejects(async()=>callback(freeze(binding),Object.freeze({...context,commandId:"wrong-context"})),/unavailable/);
  await assert.rejects(async()=>callback(freeze({...binding,evidence:`sha256:${"a".repeat(64)}`}),context),/unavailable/);
  f.clearObservations();await assert.rejects(f.raw.start(commandId,binding,()=>{}),/unavailable/,"missing cache refuses before expect file or process");
  assert.equal((await f.traces()).length,traces);assert.deepEqual(await readdir(f.configuration.workRoot),[]);
  await f.edit(run,{revision:s.engine.revision+1});await f.raw.status(run);
  const displaced=(await f.traces()).length;
  await assert.rejects(f.raw.start(commandId,binding,()=>{}),/unavailable/,"displaced cache cannot refresh an old binding");
  assert.equal((await f.traces()).length,displaced);assert.deepEqual(await readdir(f.configuration.workRoot),[]);
  const absent=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,admissionExpectation:undefined}});
  try{for(const operation of ["intake","confirm","start","approve","answer"] as const)assert.equal(absent.available(operation),false);
    assert.equal(absent.available("stop"),true);
  }finally{await absent.close();}
});

test("B1b A2 expect path and byte collisions refuse before engine effects",async t=>{
  for(const collision of ["bytes","symlink","directory-mode"]){
    const f=await fixture(t),target=join(f.root,"outside.txt");await writeFile(target,"retain exact bytes");
    const original=f.configuration.contract.admissionExpectation!;
    const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,admissionExpectation:async(b,c)=>{
      const expected=await original(b,c),directory=join(f.configuration.workRoot,c.commandId.replace(":","-"));
      await mkdir(directory,{mode:collision==="directory-mode"?0o755:0o700});
      if(collision==="bytes")await writeFile(join(directory,"expect.json"),"mismatching bytes",{mode:0o600});
      if(collision==="symlink")await symlink(target,join(directory,"expect.json"));
      return expected;
    }}});
    try{
      const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{providers:s4ProviderServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},()=>now),integrityKey:KEY,adapter},()=>now);
      const result=await bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},`b1b-a2-collision-${collision}`);
      assert.equal(result.state,"uncertain");assert.deepEqual(await readdir(f.configuration.runRoot),[],"invalid expectation path/bytes spawn no engine and write no run");
      assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_run_links")).rows.length,0);
      assert.equal(await readFile(target,"utf8"),"retain exact bytes");
    }finally{await adapter.close();}
  }
});

test("B1b A2 malformed admission records fail the whole decode",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.get(id),run=s.request.runLink!.loopRunId;
  const file=join(f.root,"runs",run+".json"),original=JSON.parse(await readFile(file,"utf8")),record=original.admissions[0];
  for(const admissions of [[{...record,at:"yesterday"}],[{...record,operation:"stop"}],[{...record,evidence:{...record.evidence,extra:true}}],
    [record,record],Array.from({length:21},(_,i)=>({...record,command_id:`loop-command:${i.toString(16).padStart(32,"0")}`}))]){
    await writeFile(file,JSON.stringify({...original,admissions}));
    // Too many stored records is legal; the wire is only the newest twenty.
    if(admissions.length===21)assert.equal((await f.raw.status(run)).receipts.length,20);
    else await assert.rejects(f.raw.status(run),/unavailable/,"invalid engine records cannot yield a partial receipt list");
  }
  const offsetRecord={...record,at:"2026-10-01T00:00:00.123456-06:00"};
  await writeFile(file,JSON.stringify({...original,admissions:[offsetRecord]}));
  assert.equal((await f.raw.status(run)).receipts[0]!.evidenceDigest,sha256Digest(offsetRecord),"A2 offset timestamp stays byte-exact in the immutable record digest");
  await writeFile(file,JSON.stringify(original));assert.equal((await f.raw.status(run)).receipts.length,1);
});

test("B1b sealed SYNTHETIC approval, owner answer and atomic race refusal",async t=>{
  const f=await fixture(t),id=await f.intake();let s=await f.confirm(id);const run=s.request.runLink!.loopRunId,suffix=encodeURIComponent(id);
  for(const step of ["plan","spec"] as const){
    const approval={step,inputVersion:1,head:"a".repeat(40),reportSha256:"b".repeat(64)};
    await f.edit(run,{state:"waiting",approval});s=await f.get(id);
    const body={expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,...approval};
    assert.equal((await f.post(`${suffix}/approve`,{...body,reportSha256:"c".repeat(64)})).status,409);
    const r=await f.post(`${suffix}/approve`,body);assert.equal((await r.json() as {state:string}).state,"accepted");
    assert.equal((await f.post(`${suffix}/approve`,body)).status,409);
  }
  const question={questionId:"question:owner",inputVersion:1,reportSha256:"d".repeat(64),owner:true as const,changesInput:false as const};
  await f.edit(run,{state:"waiting",question});s=await f.get(id);
  const answer={expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,questionId:question.questionId,inputVersion:1,questionReportSha256:question.reportSha256,text:"Keep the approved scope."};
  assert.equal((await f.post(`${suffix}/answer`,{...answer,by:"orchestrator"})).status,400);
  await f.edit(run,{question:{...question,changesInput:true}});
  assert.equal((await f.post(`${suffix}/answer`,answer)).status,409);
  await f.edit(run,{question:{...question,owner:false}});
  assert.equal((await f.post(`${suffix}/answer`,answer)).status,409);
  await f.edit(run,{question});
  assert.equal((await f.post(`${suffix}/answer`,{...answer,inputVersion:"1"})).status,409);
  const r=await f.post(`${suffix}/answer`,answer);assert.equal((await r.json() as {state:string}).state,"accepted");
  assert.equal((await f.post(`${suffix}/answer`,answer)).status,409);
  await f.edit(run,{state:"ready"});s=await f.get(id);
  f.setBeforeAdmission(()=>f.edit(run,{revision:s.engine.revision+1}));
  const race=await f.post(`${suffix}/start`,{route:S4_FIXTURE_ROUTE,expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId});
  assert.equal(race.status,202);assert.equal((await race.json() as {state:string}).state,"refused");
  assert.equal((await f.traces()).filter(e=>e.op==="start").length,1,"B1b engine lock observes exactly one refused Start invocation");
  assert.equal((await f.raw.status(run)).state,"ready","B1b engine lock refuses revision race before launch");
});

test("B1b Node transport maximum UTF-8 bytes and hosted composition without pipelines",async t=>{
  const f=await fixture(t);
  const app=createPrivateWebProcess({origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys,
    clock:()=>now,database:{client:f.client,close:async()=>{}},loopBridge:{integrityKey:KEY,adapter:f.adapter}});
  t.after(()=>app.close());
  const handler=createPrivateNodeHandler({origin,application:{isReady:()=>true,close:()=>app.close()},handler:r=>app.handle(r,()=>new Response("unused")),
    assets:{count:0,digest:"SYNTHETIC",respond:()=>undefined}});
  const invoke=async(text:string,key:string)=>{
    const proof=request();
    const exchange=nodeExchange({path:`${f.base}/intake`,method:"POST",headers:["Content-Type","application/json","Origin",origin,
      "cf-access-jwt-assertion",proof.headers.get("cf-access-jwt-assertion")!,"Idempotency-Key",key],body:text});
    await handler.handle(exchange.input,exchange.output);return {status:exchange.output.statusCode,body:exchange.body()};
  };
  const maximal=JSON.stringify({description:"a".repeat(8000)}); // valid maximum character envelope
  assert.equal((await invoke(maximal,"b1b-transport-valid-0001")).status,202);
  // Escaped UTF-8 body is exactly 16384 bytes while decoded text stays <=8000.
  const escaped='{'+JSON.stringify('description')+':"'+"\\u0061".repeat(2727)+'a'.repeat(4)+'"}';
  assert.equal(Buffer.byteLength(escaped),16384);
  assert.equal((await invoke(escaped,"b1b-transport-byte-max-0001")).status,202);
  const oversize=escaped.slice(0,-2)+'a'+escaped.slice(-2);
  assert.equal((await invoke(oversize,"b1b-transport-oversize-0001")).status,413);
  assert.equal(privateRequestBodyLimit(`${f.base}/intake`,"POST",false),16384);
  assert.equal((await f.db.query("SELECT * FROM pipeline_runs")).rows.length,0);
});


test("B1b Mac composition without pipelines, local CSRF and child-before-database close",async t=>{
  const f=await fixture(t);const localOrigin="http://127.0.0.1:32123",ownerCode="synthetic-local-owner-code-long";
  const closes:string[]=[];
  const adapter={...f.adapter,close:async()=>{closes.push("children");await f.adapter.close();}};
  const app=createMacLocalWebProcessV1({origin:localOrigin,workspaceId:"workspace:web",clock:()=>now,
    localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:localOrigin,tenantId:"tenant:web",provider:trust.issuer,subject:"test-owner",ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
    database:{client:f.client,isAvailable:()=>true,close:async()=>{closes.push("database");}},loopBridge:{integrityKey:KEY,adapter}});
  t.after(()=>app.close());
  const call=(path:string,init?:RequestInit)=>app.handle(new Request(localOrigin+path,init),()=>new Response("unused"));
  const signin=await call("/api/v1/local-owner-session",{method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},body:JSON.stringify({ownerCode})});
  assert.equal(signin.status,201);const cookie=signin.headers.get("set-cookie")!;
  const headers={cookie,origin:localOrigin,"content-type":"application/json","idempotency-key":"b1b-mac-intake-0001"};
  const response=await call(`${f.base}/intake`,{method:"POST",headers,body:JSON.stringify({description})});
  assert.equal(response.status,202);const receipt=await response.json() as {requestId:string};
  assert.equal((await call(`${f.base}/${encodeURIComponent(receipt.requestId)}/status`,{headers:{cookie}})).status,200);
  assert.equal((await call(`${f.base}/intake`,{method:"POST",headers:{...headers,origin:"https://foreign.invalid"},body:JSON.stringify({description})})).status,403);
  await app.close();assert.deepEqual(closes,["children","database"]);
});

test("B1b all seven routes recheck expiry, revocation, project and replay authority",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.get(id),suffix=encodeURIComponent(id);
  const routes=[
    {suffix:"intake",body:{description}},
    {suffix:`${suffix}/status`,body:undefined},
    {suffix:`${suffix}/confirm`,body:{expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256}},
    {suffix:`${suffix}/start`,body:{route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId}},
    {suffix:`${suffix}/stop`,body:{runLinkId:s.request.runLink!.runLinkId}},
    {suffix:`${suffix}/approve`,body:{expectedVersion:1,expectedRevision:1,step:"plan",inputVersion:1,head:"a".repeat(40),reportSha256:"b".repeat(64)}},
    {suffix:`${suffix}/answer`,body:{expectedVersion:1,expectedRevision:1,questionId:"question:owner",inputVersion:1,questionReportSha256:"c".repeat(64),text:"Keep scope."}},
  ];
  const snapshot=async()=>JSON.stringify((await f.db.query("SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows);
  const original=await snapshot(),traceCount=(await f.traces()).length;
  const call=(route:typeof routes[number],jwt?:string,base=f.base)=>f.handler(request(`${base}/${route.suffix}`,route.body?"POST":"GET",route.body,"b1b-request-00000001",jwt));
  for(const route of routes){
    assert.equal((await call(route,token({exp:now/1000-1}))).status,401);
    const foreign=f.base.replace(encodeURIComponent(f.project.projectId),"project:foreign");
    assert.equal((await call(route,undefined,foreign)).status,404);
  }
  await f.db.exec("ALTER TABLE control_web_sessions DISABLE TRIGGER USER");
  await f.db.query("UPDATE control_role_grants SET created_at='2026-09-04T11:00:00Z'");
  for(const [change,restore,status] of [
    ["UPDATE control_web_sessions SET revoked_at=now()","UPDATE control_web_sessions SET revoked_at=NULL",401],
    ["UPDATE control_web_sessions SET expires_at='2026-09-04T11:59:30Z'","UPDATE control_web_sessions SET expires_at='2099-01-01'",401],
    ["UPDATE control_role_grants SET revoked_at='2026-09-04T12:00:00Z'","UPDATE control_role_grants SET revoked_at=NULL",403],
    ["UPDATE control_role_grants SET expires_at='2026-09-04T11:59:30Z'","UPDATE control_role_grants SET expires_at=NULL",403],
    ["UPDATE control_manual_project_heads SET lifecycle='archived'","UPDATE control_manual_project_heads SET lifecycle='active'",409],
  ] as const){
    await f.db.query(change);
    for(const route of routes)assert.equal((await call(route)).status,status);
    await f.db.query(restore);
  }
  await f.db.exec("ALTER TABLE control_web_sessions ENABLE TRIGGER USER");
  assert.equal(await snapshot(),original);assert.equal((await f.traces()).length,traceCount,"local refusals call no adapter");
});

test("B1b status is observational and no contract enables no route",async t=>{
  const f=await fixture(t),id=await f.intake();
  const tables=["control_loop_improvement_requests","control_loop_improvement_inputs","control_loop_improvement_run_links","control_loop_improvement_authorizations","control_loop_improvement_commands","control_web_sessions"];
  const snapshot=async()=>JSON.stringify(await Promise.all(tables.map(async table=>(await f.db.query(`SELECT * FROM ${table}`)).rows)));
  const before=await snapshot();await f.get(id);await f.get(id);assert.equal(await snapshot(),before);
  const handler=createImproveControlRoomHttpHandlerV1({origin,trust,service:f.service,clock:()=>now});
  assert.equal((await handler(request(`${f.base}/intake`,"POST",{description},"b1b-no-contract-0001"))).status,404);
  assert.throws(()=>createImproveControlRoomHttpHandlerV1({origin,trust}),/service_required/);
});

test("B1b Stop still targets the original owned run after refused settings change",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id);
  assert.equal((await f.post(`${encodeURIComponent(id)}/start`, {route:S4_FIXTURE_ROUTE, expectedVersion: s.request.currentVersion,
    expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId })).status, 202);
  const desk=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,f.adapter.contract);
  const before=(await f.db.query("SELECT * FROM control_loop_improvement_inputs ORDER BY version")).rows;
  await assert.rejects(desk.reviseLoopDraft(f.identity,f.project.projectId,{requestId:id,expectedVersion:1,description:"Changed local draft.",settingsText:JSON.stringify({changed:true})},"b1b-changed-local-0001"),{code:"conflict"});
  assert.deepEqual((await f.db.query("SELECT * FROM control_loop_improvement_inputs ORDER BY version")).rows,before);
  const response=await f.post(`${encodeURIComponent(id)}/stop`,{runLinkId:s.request.runLink!.runLinkId});
  assert.equal((await response.json() as {state:string}).state,"accepted");
  assert.equal((await f.get(id)).engine.state,"stopped");
});

test("B1b dropped request and lost dispatch reply consume one durable attempt",async t=>{
  const f=await fixture(t);let entered!:()=>void,release!:()=>void,calls=0;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const adapter={...f.adapter,intake:async(id:string,b:LoopBridgeBindingV1,text:string,fence:()=>void)=>{calls++;entered();await gate;return f.adapter.intake(id,b,text,fence);}};
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{providers:s4ProviderServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},()=>now),integrityKey:KEY,adapter},()=>now);
  const handler=createImproveControlRoomHttpHandlerV1({origin,trust,loopBridge:bridge,clock:()=>now});
  const key="b1b-dropped-request-0001",controller=new AbortController();
  const original=request(`${f.base}/intake`,"POST",{description},key);
  const pending=handler(new Request(original,{signal:controller.signal}));await waiting;controller.abort();
  try{
    const replay=await handler(request(`${f.base}/intake`,"POST",{description},key));
    assert.equal(replay.status,202);assert.equal((await replay.json() as {state:string}).state,"uncertain");
    assert.equal(calls,1,"B1b dropped caller never redispatches a committed claim");
  }finally{release();}
  assert.equal((await pending).status,202);
  assert.equal((await handler(request(`${f.base}/intake`,"POST",{description},key))).status,200);
  assert.equal(calls,1);
});

test("B1b malicious request bytes stay literal exclusive command-file contents",async t=>{
  const f=await fixture(t),text='literal $(touch injected) ; "../outside" \\u2028';
  const response=await f.post("intake",{description:text});assert.equal(response.status,202);
  const trace=(await f.traces()).find(e=>e.op==="intake")!;
  const receipt=await response.json() as {requestId:string};
  assert.equal((await f.get(receipt.requestId)).engine.draft,text,"engine consumed literal exclusive source-file bytes");
  await assert.rejects(readFile(trace.args[1]!,"utf8"),{code:"ENOENT"},"completed source file reclaimed");
  assert.equal((await readdir(f.root)).includes("injected"),false);
  for(const bad of [{description:"a",workerId:"worker:other"},{description:"a",source:"../outside"},{description:"a",settings:"private"}])assert.equal((await f.post("intake",bad)).status,400);
});

test("B1b expired admission never spawns and post-dispatch database failure reconciles",async t=>{
  const f=await fixture(t);let current=now,expire=true,launches=0,failResult=false,claimed=false;
  const traced=(tx:import('../src/persistence/database').DatabaseSession)=>({query:async<T>(sql:string,params?:unknown[])=>{
    if(sql.startsWith('INSERT INTO control_loop_improvement_commands')&&params?.[2]==='claim')claimed=true;
    if(failResult&&sql.startsWith('INSERT INTO control_loop_improvement_commands')&&params?.[2]==='result'){failResult=false;throw new Error('SYNTHETIC DB result loss');}
    return tx.query<T>(sql,params);
  }});
  const db:import('../src/persistence/database').DatabaseClient={query:f.client.query,transaction:callback=>f.client.transaction(tx=>callback(traced(tx))),
    transactionWithPreCommitCheck:async(callback,check)=>{const value=await f.client.transactionWithPreCommitCheck(tx=>callback(traced(tx)),check);if(expire&&claimed){expire=false;current+=6000;}return value;}};
  const adapter={...f.adapter,intake:async(id:string,b:LoopBridgeBindingV1,text:string,fence:()=>void)=>{launches++;return f.adapter.intake(id,b,text,fence);}};
  const bridge=new ImproveControlRoomLoopServiceV1(db,{tenantId:'tenant:web',workspaceId:'workspace:web'},{providers:s4ProviderServiceV1(db,{tenantId:'tenant:web',workspaceId:'workspace:web'},()=>current),integrityKey:KEY,adapter},()=>current);
  const expired=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-expired-admission-0001');
  assert.equal(expired.state,'uncertain');assert.equal(launches,0,'expired committed admission never reaches spawn');
  assert.equal((await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-expired-admission-0001')).state,'uncertain');assert.equal(launches,0);
  failResult=true;
  const lost=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-post-dispatch-db-0001');assert.equal(lost.state,'uncertain');
  const reconciled=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-post-dispatch-db-0001');assert.equal(reconciled.state,'accepted');assert.equal(reconciled.replayed,true);assert.equal(launches,1);
});

test("B1b sweep database errors reach the transaction while verification failures retain files", async t => {
  const f = await fixture(t);
  const crashed = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    {providers:s4ProviderServiceV1(f.client,{ tenantId: 'tenant:web', workspaceId: 'workspace:web' },() => now), integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
  const retained = await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-db-invalid');
  const finished = await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-db-finished');
  const diagnostic = t.mock.method(console, 'warn', () => {});
  const failures: unknown[] = [];
  let databaseError: unknown, sweeps = 0;
  const trace = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.includes("entry_kind='result'") && params?.[1] === finished.commandId) {
      try { await tx.query('SELECT missing_sweep_column FROM control_loop_improvement_commands'); }
      catch (error) { databaseError = error; throw error; }
      assert.fail('the injected query must fail');
    }
    const result = await tx.query<T>(sql, params);
    if (sql.includes('SELECT c.* FROM control_loop_improvement_commands')) {
      sweeps++;
      result.rows = [retained, finished].map(receipt => {
        const row = result.rows.find(raw => (raw as { command_id: string }).command_id === receipt.commandId)!;
        return receipt === retained ? { ...row, record_digest: `sha256:${'f'.repeat(64)}` } : row;
      });
    }
    return result;
  } });
  const client: DatabaseClient = { query: (sql, params) => f.client.query(sql, params),
    transaction: work => f.client.transaction(tx => work(trace(tx))),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(async tx => {
      try { return await work(trace(tx)); }
      catch (error) { failures.push(error); throw error; }
    }, check) };
  const restarted = new ImproveControlRoomLoopServiceV1(client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    {providers:s4ProviderServiceV1(client,{ tenantId: 'tenant:web', workspaceId: 'workspace:web' },() => now), integrityKey: KEY, adapter: f.adapter }, () => now);
  for (let i = 0; i < 2; i++) {
    const receipt = await restarted.mutate(f.identity, f.project.projectId, null, 'intake', { description }, `b1b-sweep-db-trigger-${i}`);
    assert.equal(receipt.state, 'accepted', 'best-effort sweep cannot change the admitted command result');
    assert.ok(databaseError instanceof Error);
    assert.equal(failures.length, i + 1, 'database error escapes the row catch and aborts the sweep transaction');
    assert.equal(failures[i], databaseError, 'the original database error reaches the transaction boundary');
    for (const row of [retained, finished]) assert.equal(await readFile(join(f.configuration.workRoot,
      row.commandId.replace(':', '-'), 'source.txt'), 'utf8'), description, 'failed sweep retains command files');
  }
  assert.equal(sweeps, 2, 'failed sweep remains eligible for retry');
  assert.deepEqual(diagnostic.mock.calls.map(call => call.arguments), [
    ['loop_command_sweep_verification_failed'], ['loop_command_sweep_verification_failed'],
  ], 'only verification failures produce the fixed row diagnostic');
});

test("B1b canStop after a refused Start agrees with the Stop route", async t => {
  const f = await fixture(t), id = await f.intake(), s = await f.confirm(id), suffix = encodeURIComponent(id);
  await writeFile(join(f.root, "refusal.json"), JSON.stringify({ op: "start", code: 3 }));
  const refused = await f.bridge.mutate(f.identity, f.project.projectId, id, 'start',
    {route:S4_FIXTURE_ROUTE, expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId }, 'b1b-refused-start-0001');
  assert.equal(refused.state, 'refused');
  await rm(join(f.root, "refusal.json"));
  const after = await f.get(id);
  assert.equal(after.display.startState, 'not_started'); assert.equal(after.display.canStart, false);
  assert.equal(after.display.canStop, true, 'canStop agrees with Stop after a refused Start');
  const stop = await f.post(`${suffix}/stop`, { runLinkId: s.request.runLink!.runLinkId });
  assert.equal(stop.status, 202); assert.equal((await stop.json() as { state: string }).state, 'accepted');
  assert.equal((await f.get(id)).display.canStop, false);
});

for (const [code, breakStatus] of [[1, false], [4, false], [2, true], [3, true]] as const) {
  test(`B1b approve empty output exit ${code} broken status ${breakStatus} stays uncertain`, async t => {
    const f = await fixture(t), id = await f.intake(); let s = await f.confirm(id);
    const approval = { step: 'plan' as const, inputVersion: 1, head: 'a'.repeat(40), reportSha256: 'b'.repeat(64) };
    await f.edit(s.request.runLink!.loopRunId, { state: 'waiting', approval }); s = await f.get(id);
    await writeFile(join(f.root, 'refusal.json'), JSON.stringify({ op: 'approve', code, output: 'empty', breakStatus }));
    const body = { expectedVersion: 1, expectedRevision: s.engine.revision, ...approval };
    const key = `b1b-approve-uncertain-${code}`;
    const receipt = await f.bridge.mutate(f.identity, f.project.projectId, id, 'approve', body, key);
    assert.equal(receipt.state, 'uncertain'); assert.equal(receipt.error, 'LAUNCH_UNCERTAIN');
    assert.equal((await f.bridge.mutate(f.identity, f.project.projectId, id, 'approve', body, key)).state, 'uncertain');
    assert.equal((await f.traces()).filter(trace => trace.op === 'approve').length, 1, 'uncertain approval never redispatches');
  });
}

test("B2b escaped question budget precedes the engine decoder", async t => {
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const question={questionId:"question:bounded",inputVersion:1,reportSha256:"d".repeat(64),owner:true,changesInput:false};
  const prefix='"\\\n\t' + 'é🧭';
  const exact=prefix+"x".repeat(12288-Buffer.byteLength(JSON.stringify(prefix)));
  assert.equal(Buffer.byteLength(JSON.stringify(exact)),12288);
  let seen: unknown;
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,decodeStatus:output=>{
    seen=(output as {counters:{fixture:{questionText:unknown}}}).counters.fixture.questionText;
    return f.configuration.contract.decodeStatus(output);
  }}});t.after(()=>adapter.close());
  for(const [text,expected] of [[exact,exact],[exact+"x",null],[{invalid:true},null],[undefined,null]] as const){
    await f.edit(run,{state:"waiting",question,questionText:text});
    const saved=await adapter.status(run);
    assert.equal(seen,expected,"raw text is budgeted before strict engine decoding");
    assert.deepEqual(saved.decisions?.gate,{kind:"question",text:expected});
    assert.deepEqual(saved.question,question);assert.deepEqual(saved.confirmation,(await f.adapter.status(run)).confirmation);
    assert.equal(saved.revision,s.engine.revision);assert.equal(saved.description,description);
  }
  await f.edit(run,{questionText:"x".repeat(65536)});
  await assert.rejects(adapter.status(run),/unavailable/,"aggregate stdout cap remains unchanged");
});

for(const composition of ["hosted","local"] as const)test(`B2b ${composition} attention and document composition`,async t=>{
  const canonical={observedAt:new Date(now).toISOString(),items:[],truncated:false};
  for(const mode of ["loop","canonical","both","neither","failed-canonical"] as const){
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const directory=join(f.configuration.runRoot,run);await mkdir(directory);
  const text="SYNTHETIC complete sealed plan.";const approval={step:"plan" as const,inputVersion:1,head:"a".repeat(40),reportSha256:loopByteHashV1(text)};
  await writeFile(join(directory,"report.md"),text);await writeFile(join(directory,"report.json"),JSON.stringify(approval));await f.edit(run,{state:"waiting",approval});
    let canonicalReads=0;
    const options={clock:()=>now,database:{client:f.client,isAvailable:()=>true,close:async()=>{}},
      ...(mode==="loop"||mode==="both"||mode==="failed-canonical"?{loopBridge:{integrityKey:KEY,adapter:f.adapter}}:{}),
      ...(mode==="canonical"||mode==="both"||mode==="failed-canonical"?{actionInboxSource:{read:async()=>{canonicalReads++;if(mode==="failed-canonical")throw new Error("SYNTHETIC unavailable canonical source");return canonical;}}}:{})};
    let call:(path:string)=>Promise<Response>,close:()=>Promise<void>;
    if(composition==="hosted"){
      const app=createPrivateWebProcess({...options,origin,...trust,tenantId:"tenant:web",workspaceId:"workspace:web",loadKeys:async()=>trust.keys});
      call=path=>app.handle(request(path),()=>new Response("unused"));close=()=>app.close();
    }else{
      const localOrigin="http://127.0.0.1:59359",ownerCode="SYNTHETIC-b2b-composition-owner-code";
      const app=createMacLocalWebProcessV1({...options,origin:localOrigin,workspaceId:"workspace:web",localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,
        origin:localOrigin,tenantId:"tenant:web",provider:trust.issuer,subject:"test-owner",ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900}});
      const response=await app.handle(new Request(localOrigin+"/api/v1/local-owner-session",{method:"POST",headers:{origin:localOrigin,"content-type":"application/json"},body:JSON.stringify({ownerCode})}),()=>new Response("unused"));
      assert.equal(response.status,201);const cookie=response.headers.get("set-cookie")!;
      call=path=>app.handle(new Request(localOrigin+path,{headers:{cookie}}),()=>new Response("unused"));close=()=>app.close();
    }
    try{
      const attention=await call("/api/v1/needs-me/action-items");
      assert.equal(attention.status,mode==="neither"?404:mode==="failed-canonical"?503:200);
      if(attention.status===200){const body=await attention.json();assert.deepEqual(body.items,[]);
        if(mode!=="canonical"){assert.equal(body.loop.state,"available");assert.equal(body.loop.items[0].kind,"approval");}
        else assert.equal(body.loop,undefined);
      }
      if(mode==="loop"||mode==="both"){
        const document=await call(`${f.base}/${encodeURIComponent(id)}/approval-document`);assert.equal(document.status,200);assert.equal((await document.json()).text,text);
      }
      assert.equal((await call("/api/v1/needs-me/action-items?extra=true")).status,400);
      assert.equal(canonicalReads,mode==="canonical"||mode==="both"||mode==="failed-canonical"?1:0);
    }finally{await close();}

  }
});



test('U81-B R11 exact-target status failure gates the real adapter observation', async t => {
  const f = await fixture(t), requestId = await f.intake();
  await f.confirm(requestId);
  const { LoopPolicyServiceV1 } = await import('../src/web/v1/loop-policy-service');
  const scope = { tenantId: 'tenant:web', workspaceId: 'workspace:web' };
  const policy = new LoopPolicyServiceV1(f.client, scope, f.raw, () => now);
  // Inject only classification so this legacy real-engine fixture enters the B8
  // projection branch. The adapter, signed claims, saved inputs and status are real.
  // Its saved non-selection settings cannot supply a valid exact B8 target.
  t.mock.method(policy, 'inputAdmissionKind', async () => 'product-b8' as const);
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, scope,
    { integrityKey: KEY, adapter: f.raw, policy }, () => now);
  const before = (await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows;
  const status = await bridge.status(f.identity, f.project.projectId, requestId);
  assert.equal(status.engine.state, 'ready');
  assert.equal(status.display.canStart, false);
  assert.equal(status.selection, undefined);
  assert.equal(status.decisions?.gate?.kind, 'blocked');
  assert.equal((status.decisions?.gate as {code:string}).code, 'UNAVAILABLE');
  assert.deepEqual((await f.db.query('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows, before);
});

async function d36Fixture(t: TestContext) {
  const started=performance.now(),clock=()=>now+Math.floor(performance.now()-started);
  const f=await taskFixture(clock);t.after(()=>f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`,[f.project.projectId]);
  const engine=await (await import('./helpers/loop-selection-start')).selectionStartAdapter(t);
  const {LoopPolicyServiceV1}=await import('../src/web/v1/loop-policy-service');
  let checks=0;
  const scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  const policy=new LoopPolicyServiceV1(f.client,scope,{settingsText:'{}',checkSettings:async()=>{
    checks++;return {eligible:true,reasons:[],projection:engine.projection as any,snapshot:engine.snapshot};
  }},clock);
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:KEY,adapter:engine.adapter,policy,
    selectionReady:()=>true,selectionGuard:{capture:async()=>engine.snapshot,assertCurrent:async()=>{}}},clock);
  const intake=await bridge.intakeSelection(f.identity,f.project.projectId,{description:'SYNTHETIC D36 saved selection',
    settingsEdits:JSON.stringify({...engine.selection,overrides:{reviewFamily:true,standardFinal:false}}),acceptSameFamilyRisk:true},'d36-intake-request-0001');
  assert.equal(intake.state,'accepted');
  const draft=await bridge.status(f.identity,f.project.projectId,intake.requestId);
  const confirmed=await bridge.mutate(f.identity,f.project.projectId,intake.requestId,'confirm',{expectedVersion:1,expectedRevision:1,
    requestSha256:draft.engine.requestSha256,settingsSha256:draft.engine.settingsSha256},'d36-confirm-request-0001');
  assert.equal(confirmed.state,'accepted');
  const status=await bridge.status(f.identity,f.project.projectId,intake.requestId);
  const service=new ImproveControlRoomDeskServiceV1(f.client,scope,KEY,undefined,clock);
  const handler=createImproveControlRoomHttpHandlerV1({origin,trust,service,clock,loopBridge:bridge});
  const path=`/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements/loop/${encodeURIComponent(intake.requestId)}`;
  const body={expectedVersion:1,expectedRevision:status.engine.revision,runLinkId:status.request.runLink!.runLinkId};
  const rows=async()=>{
    const all:Record<string,unknown>={};
    for(const table of ['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_policy_input_admissions',
      'control_loop_improvement_commands','control_loop_policy_waivers','control_loop_improvement_run_links','control_loop_improvement_authorizations'])
      all[table]=(await f.db.query(`SELECT * FROM ${table} ORDER BY 1,2,3`)).rows;
    return all;
  };
  return {...f,...engine,bridge,handler,path,body,rows,requestId:intake.requestId,get checks(){return checks;}};
}

test('U81-B D36 failed Start leaves no committed claim through real adapter',async t=>{
  const f=await d36Fixture(t),before=await f.rows(),checked=f.checks;
  const {WebAccessError}=await import('../src/web/v1/access-verifier');
  const refused=(e:unknown)=>{assert.ok(e instanceof WebAccessError);assert.equal(e.code,'start_deferred_u81s');return true;};
  const post=async(body:unknown,key:string)=>{
    const response=await f.handler(request(f.path+'/start','POST',body,key));
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'start_deferred_u81s'});
  };
  for(let i=0;i<3;i++){
    await post(f.body,'d36-start-repeated-0001');
    await assert.rejects(f.bridge.mutate(f.identity,f.project.projectId,f.requestId,'start',f.body,'d36-start-direct-0001'),refused);
  }
  for(const extra of [{acceptSameFamilyRisk:true},{route:S4_FIXTURE_ROUTE},{route:S4_FIXTURE_ROUTE,paid:{capNanoUsd:'1000',optIn:true}}])
    await post({...f.body,...extra},'d36-start-shape-'+randomBytes(8).toString('hex'));
  await Promise.all(Array.from({length:20},(_,i)=>post(f.body,`d36-start-concurrent-${String(i).padStart(4,'0')}`)));
  assert.deepEqual(await f.rows(),before);assert.equal(f.checks,checked,'Start never calls the checker');
  assert.equal((await f.traces()).filter(r=>r.op==='start').length,0,'no synthetic Start invocation or worker');
  // Real process composition must reach the same typed refusal even when its
  // own source startup is unavailable. Start admission is never replaced.
  const app=createPrivateWebProcess({origin,...trust,loadKeys:async()=>trust.keys,tenantId:'tenant:web',workspaceId:'workspace:web',clock:()=>now,
    database:{client:f.client,close:async()=>{}},loopBridge:{integrityKey:KEY,adapter:f.adapter}});
  try{const response=await app.handle(request(f.path+'/start','POST',f.body,'d36-factory-start-0001'),()=>new Response('unused'));
    assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'start_deferred_u81s'});
  }finally{await app.close();}
  assert.deepEqual(await f.rows(),before);
});

test('U81-B D36 withheld Start status stays unavailable',async t=>{
  const f=await d36Fixture(t),before=await f.rows();
  const status=await f.bridge.status(f.identity,f.project.projectId,f.requestId);
  assert.equal(status.display.canStart,false);assert.equal(status.display.attention?.code,'start_deferred_u81s');
  assert.match(status.display.attention!.message,/subscription-launcher/);assert.ok(status.selection,'valid projection stays available');
  assert.equal(status.display.confirmationCurrent,true);assert.equal(status.engine.state,'ready');
  assert.deepEqual(await f.rows(),before);
});

test('U81-B D36 retained Start replay and Stop keep real adapter native history',async t=>{
  const f=await fixture(t),id=await f.intake();await f.confirm(id);
  const s=await f.get(id),body={route:S4_FIXTURE_ROUTE,expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId};
  const first=await f.post(`${encodeURIComponent(id)}/start`,body,'d36-retained-start-0001');
  assert.equal(first.status,202);const receipt=await first.json() as {commandId:string;state:string};assert.equal(receipt.state,'accepted');
  const {LoopPolicyServiceV1}=await import('../src/web/v1/loop-policy-service');
  const scope={tenantId:'tenant:web',workspaceId:'workspace:web'},policy=new LoopPolicyServiceV1(f.client,scope,f.raw,()=>now);
  // Model an already committed pre-D36 B8 claim using valid signed history.
  // Only retained-kind lookup is injected; replay and Stop use the real adapter.
  t.mock.method(policy,'inputAdmissionKind',async()=>'product-b8' as const);
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:KEY,adapter:f.raw,policy},()=>now);
  const starts=(await f.traces()).filter(r=>r.op==='start').length;
  const replay=await bridge.mutate(f.identity,f.project.projectId,id,'start',body,'d36-retained-start-0001');
  assert.equal(replay.commandId,receipt.commandId);assert.equal(replay.replayed,true);assert.equal(replay.state,'accepted');
  assert.equal((await f.traces()).filter(r=>r.op==='start').length,starts);
  const stopped=await bridge.mutate(f.identity,f.project.projectId,id,'stop',{runLinkId:body.runLinkId},'d36-retained-stop-0001');
  assert.equal(stopped.state,'accepted');assert.equal((await f.raw.status(s.request.runLink!.loopRunId)).state,'stopped');
});

test('U81-B D36 Mac-local factory Start refuses before claims through real adapter',async t=>{
  const f=await d36Fixture(t),before=await f.rows(),localOrigin='http://127.0.0.1:32123',ownerCode='synthetic-d36-local-owner-code';
  const app=createMacLocalWebProcessV1({origin:localOrigin,workspaceId:'workspace:web',clock:()=>now,
    localOwnerSession:{schema:LOCAL_OWNER_SESSION_PROFILE_V1,origin:localOrigin,tenantId:'tenant:web',provider:trust.issuer,subject:'test-owner',ownerCodeDigest:sha256Digest({ownerCode}),sessionSeconds:900},
    database:{client:f.client,isAvailable:()=>true,close:async()=>{}},loopBridge:{integrityKey:KEY,adapter:f.adapter}});
  try{
    const call=(path:string,init:RequestInit)=>app.handle(new Request(localOrigin+path,init),()=>new Response('unused'));
    const signin=await call('/api/v1/local-owner-session',{method:'POST',headers:{origin:localOrigin,'content-type':'application/json'},body:JSON.stringify({ownerCode})});
    assert.equal(signin.status,201);
    for(let i=0;i<3;i++){
      const response=await call(f.path+'/start',{method:'POST',headers:{origin:localOrigin,cookie:signin.headers.get('set-cookie')!,
        'content-type':'application/json','idempotency-key':'d36-mac-factory-start-0001'},body:JSON.stringify(f.body)});
      assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'start_deferred_u81s'});
    }
    assert.deepEqual(await f.rows(),before);assert.equal((await f.traces()).filter(r=>r.op==='start').length,0);
  }finally{await app.close();}
});
