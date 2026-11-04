import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { loopApprovalDescriptorSchemaV1 } from "../../src/web/v1/improve-control-room-loop-attention-wire";
import { sha256Digest } from "../../src/security";
import { ImproveControlRoomDeskServiceV1 } from "../../src/improve-control-room/v1/service";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1 } from "../../src/improve-control-room/v1/schemas";
import { ImproveControlRoomLoopServiceV1 } from "../../src/web/v1/improve-control-room-loop-service";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, loopEngineStatusSchemaV1,
  type LoopAdapterV1, type LoopEngineStatusV1, type LoopAdapterConfigurationV1 } from "../../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomHttpHandlerV1 } from "../../src/web/v1/improve-control-room-http";
import { taskFixture } from "./web-task";
import { now, origin, request, trust } from "./web-foundation";

export const KEY = new Uint8Array(32).fill(64);
export const settingsText = JSON.stringify({ project: { host_adapter: "local-loop" }, fixture: "SYNTHETIC" });
export const description = "Show the exact saved improvement.";

// Explicit SYNTHETIC executable: no worker/agent/provider is invoked. It records
// argv/env/cwd and persists only disposable run facts for the seven fixed calls.
export const executable = String.raw`import os,sys,json,hashlib,fcntl
root=os.path.dirname(os.path.abspath(__file__))
op,run=sys.argv[1:3]; args=sys.argv[3:]
path=os.path.join(root,'runs',run+'.json')
lock=open(path+'.lock','a'); fcntl.flock(lock,fcntl.LOCK_EX)
def h(s): return hashlib.sha256(s.encode()).hexdigest()
def flag(k): return args[args.index(k)+1]
repository_branch=None
if op=='intake':
    import subprocess
    with open(flag('--settings')) as f: repository=json.load(f).get('project',{}).get('repository')
    if repository: repository_branch=subprocess.check_output(['/usr/bin/git','-C',repository,'branch','--show-current'],env={'GIT_CONFIG_GLOBAL':'/dev/null','GIT_CONFIG_NOSYSTEM':'1'}).decode().strip()
expected=None
if '--expect' in args:
    with open(flag('--expect')) as f: expected=json.load(f)
with open(os.path.join(root,'trace.jsonl'),'a') as f:
    f.write(json.dumps(dict(op=op,run=run,args=args,env=dict(os.environ),cwd=os.getcwd(),repositoryBranch=repository_branch,expectation=expected,
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
    envelope=dict(schema_version=1,run=run,state=s['state'],revision=s['revision'],next=None,attention=dict(code='OWNER_REQUIRED') if s['state']=='waiting' else None,steps=[],counters=dict(fixture=s),error=dict(code=error) if error else None,request=None if output=='null-request' else request)
    override=os.path.join(root,'status-envelope.json')
    if os.path.exists(override):
        with open(override) as f: envelope.update(json.load(f))
    print(json.dumps(envelope))
def refuse(code): emit(code); sys.exit(2)
control={}
refusal=os.path.join(root,'refusal.json')
if os.path.exists(refusal):
    with open(refusal) as f: control=json.load(f)
    if control['op']!=op: control={}
if control and not control.get('afterSave'):
    if control.get('runDirectory') or control.get('savedRun'):
        os.makedirs(os.path.join(root,'runs',run),exist_ok=True)
        with open(os.path.join(root,'runs',run,'run.lock'),'w') as f: f.write('')
    if control.get('savedRun'):
        with open(os.path.join(root,'runs',run,'run.json'),'w') as f: f.write('{}')
    if control.get('output')=='null-state':
        print(json.dumps(dict(schema_version=1,run=control.get('envelopeRun',run),state=None,revision=0,next=None,attention=None,steps=[],counters={},error=dict(code=control.get('errorCode','SETTINGS_REPOSITORY'),message='PRIVATE engine detail must not cross HTTP'),request=None)),flush=True)
        if control.get('hang'):
            import time
            time.sleep(10)
        sys.exit(control['code'])
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
export const rawHash = z.string().regex(/^[a-f0-9]{64}$/), version = z.number().int().positive();
const admissionTime = z.string().datetime({offset:true});
const recordBase = {command_id:z.string().regex(/^loop-command:[a-f0-9]{32}$/),
  binding_digest:z.string().regex(/^sha256:[a-f0-9]{64}$/),at:admissionTime};
export const admissionRecords = z.array(z.discriminatedUnion("operation", [
  z.object({...recordBase,operation:z.literal("intake"),evidence:z.object({request_sha256:rawHash,settings_sha256:rawHash,input_version:z.literal(1)}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("confirm"),evidence:z.object({sha256:rawHash,input_version:version,at:admissionTime,who:z.literal("owner")}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("start"),evidence:z.object({launch_key:z.string().regex(/^[a-f0-9]{32}$/),step:version,role:z.string().min(1),input_version:version,settings_sha256:rawHash}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("approve"),evidence:z.object({piece:z.enum(["plan","spec"]),report_sha256:rawHash,head:z.string().regex(/^[a-f0-9]{40}$/),input_version:version}).strict()}).strict(),
  z.object({...recordBase,operation:z.literal("answer"),evidence:z.object({question_id:z.string().min(1),input_version:version,report_sha256:rawHash,answer_sha256:rawHash}).strict()}).strict(),
])).max(20).refine(records=>new Set(records.map(r=>r.command_id)).size===records.length);

export async function synthetic(t: TestContext, repository?: string) {
  let raw: LoopAdapterV1 | undefined;
  t.after(() => raw?.close());
  const configuredSettings = repository ? JSON.stringify({ project: { host_adapter: "local-loop", repository }, fixture: "SYNTHETIC" }) : settingsText;
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/b1b-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["runs", "work"]) await mkdir(join(root, dir));
  await writeFile(join(root, "engine.py"), executable);
  await writeFile(join(root, "tooling.json"), JSON.stringify({ fixture: "SYNTHETIC", revision: 1 }));
  await writeFile(join(root, "settings.json"), configuredSettings); await writeFile(join(root, "availability.json"), "{}");
  for (const name of ["engine.py", "tooling.json", "settings.json", "availability.json"]) {
    assert.ok(await stat(join(root, name)).then(value => value.isFile(), () => false),
      `B5 shared bridge fixture requires setup artifact ${name}`);
  }
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
  let documentNames = { report: "report.md", sidecar: "report.json" };
  let beforeAdmission: (() => Promise<void>) | undefined;
  const configuration: LoopAdapterConfigurationV1 = { adapterId: "adapter:synthetic", interpreter: realpathSync(process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/python3" : "/usr/bin/python3"),
    interpreterSha256: loopByteHashV1(await readFile(realpathSync(process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/python3" : "/usr/bin/python3"))),
    entrypointSha256: loopByteHashV1(executable), entrypoint: join(root, "engine.py"), toolingManifest: join(root, "tooling.json"), configRoot: root,
    workRoot: join(root, "work"), runRoot: join(root, "runs"), cwd: root, settingsFile: join(root, "settings.json"),
    availabilityFile: join(root, "availability.json"), toolingRevision, settingsSha256: loopByteHashV1(configuredSettings), availabilitySha256: loopByteHashV1("{}"),
    executionIdentity: { uid: process.getuid!(), isolationEvidenceDigest: `sha256:${"b".repeat(64)}` }, timeoutMs: 1000,
    contract: { lineage, schemaDigest: `sha256:${"c".repeat(64)}`, generateRunId: () => `fixture-run-${randomBytes(16).toString("hex")}`,
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
  const adapter = raw;
  const edit = async (run: string, changes: Partial<LoopEngineStatusV1> & {questionText?:unknown;blockedCode?:"QUESTION_LIMIT"|"INPUT_CHANGED"}) => {
    const path = join(root, "runs", `${run}.json`), saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, ...changes, run: saved.run }));
  };
  const traces = async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) as
    {op:string;run:string;repositoryBranch:string|null;args:string[];env:Record<string,string>;cwd:string;expectation:Record<string,unknown>|null;expectationText:string|null;fileMode:number|null;directoryMode:number|null}[];
  return { root, adapter, raw, configuration, edit, traces, observed: (run: string) => observations.get(run), clearObservations:()=>observations.clear(), setDocumentNames: (names: typeof documentNames) => { documentNames = names; }, setBeforeAdmission: (callback: () => Promise<void>) => { beforeAdmission = callback; } };
}
export async function fixture(t: TestContext, repository?: string) {
  let db: Awaited<ReturnType<typeof taskFixture>>["db"] | undefined;
  t.after(() => db?.close());
  const f = await taskFixture(); db = f.db;
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const engine = await synthetic(t, repository);
  const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, { integrityKey: KEY, adapter: engine.adapter }, () => now);
  const service = new ImproveControlRoomDeskServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" }, KEY, undefined, () => now);
  const handler = createImproveControlRoomHttpHandlerV1({ origin, trust, service, clock: () => now, loopBridge: bridge });
  const base = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/improvements/loop`;
  let sequence = 0;
  const post = (suffix: string, body: unknown, key = `b1b-request-${String(++sequence).padStart(8, "0")}`) => handler(request(`${base}/${suffix}`, "POST", body, key));
  const get = (id: string) => bridge.status(f.identity, f.project.projectId, id);
  const intake = async () => { const response = await post("intake", { description }); assert.equal(response.status, 202); const receipt = await response.json() as { requestId: string; state: string }; assert.equal(receipt.state, "accepted"); return receipt.requestId; };
  const confirm = async (id: string) => { const s = await get(id); const response = await post(`${encodeURIComponent(id)}/confirm`, { expectedVersion: s.request.currentVersion,
    expectedRevision: s.engine.revision, requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 }); assert.equal(response.status, 202); assert.equal((await response.json() as {state:string}).state,"accepted","A2 confirm requires an engine record"); return get(id); };
  return { ...f, ...engine, bridge, service, handler, base, post, get, intake, confirm };
}
