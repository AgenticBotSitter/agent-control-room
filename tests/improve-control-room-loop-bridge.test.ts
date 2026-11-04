import { LoopPolicyServiceV1 } from "../src/web/v1/loop-policy-service";
import { syntheticRecoveryCapability, syntheticRecoveryEngine } from "./helpers/improve-control-room-loop-recovery";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { z } from "zod";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { randomBytes } from "node:crypto";
import { execFile, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { loopMonitoringAttentionV1 } from "../src/web/v1/improve-control-room-loop-monitoring";
import { createInterface } from "node:readline";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { lstatSync, realpathSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { WebProjectService } from "../src/web/v1/project-service";
import { parseStrictJsonV1 } from "../src/installer/shared/strict-json.mjs";
import { syncBuiltinESMExports } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { loopApprovalDescriptorSchemaV1 } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { canonicalJson, hmacSha256Tag, sha256Digest } from "../src/security";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1,
  type LoopBridgeBindingV1, type LoopBridgeOperationV1 } from "../src/improve-control-room/v1/schemas";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, loopEngineStatusSchemaV1,
  type LoopAdapterV1, type LoopEngineStatusV1, type LoopAdapterConfigurationV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { taskFixture } from "./helpers/web-task";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { now, origin, request, token, trust } from "./helpers/web-foundation";
import { setTimeout as delay } from "node:timers/promises";
import { validatePrivateTaskStartupConfiguration } from "../src/web/v1/private-task-startup";
import { privateAgentTaskCompositionFixture } from "./helpers/private-agent-task-composition";

const KEY = new Uint8Array(32).fill(64);
const settingsText = JSON.stringify({ project: { host_adapter: "local-loop" }, fixture: "SYNTHETIC" });
const description = "Show the exact saved improvement.";

test("B1b mutation steps have separate budgets and retain lineage failures", async () => {
  const workflow = await readFile('.github/workflows/ci.yml', 'utf8');
  const job = workflow.slice(workflow.indexOf('  mutation-checks:'), workflow.indexOf('\n  pr-claims:'));
  const lineage = job.slice(job.indexOf('      - name: Prove saved loop lineage guards'), job.indexOf('      - name: Prove authorized loop bridge guards'));
  const bridge = job.slice(job.indexOf('      - name: Prove authorized loop bridge guards'), job.indexOf('      - name: Validate every declared mutation anchor'));
  assert.match(lineage, /timeout-minutes: 12/u); assert.match(lineage, /continue-on-error: true/u);
  assert.match(lineage, /id: lineage-guards/u); assert.doesNotMatch(lineage, /\n\s+if:/u);
  assert.match(bridge, /timeout-minutes: 10/u); assert.doesNotMatch(bridge, /\n\s+(?:if:|continue-on-error:)/u);
  const required = job.slice(job.indexOf('      - name: Require saved loop lineage guards to pass'));
  assert.match(required, /if: always\(\)/u);
  assert.ok(required.includes('LINEAGE_OUTCOME: ${{ steps.lineage-guards.outcome }}'));
  const command = required.match(/run: (.+)/u)![1]!;
  for (const outcome of ['success', 'failure', 'cancelled', 'skipped', '']) {
    const result = spawnSync('/bin/sh', ['-c', command], { env: { ...process.env, LINEAGE_OUTCOME: outcome } });
    assert.equal(result.status, outcome === 'success' ? 0 : 1, `lineage ${outcome} remains a required verdict`);
  }
});
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
        settingsText=open(flag('--settings')).read() if '--settings' in args else None,
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
  t.after(() => raw.close());
  const adapter = raw;
  const edit = async (run: string, changes: Partial<LoopEngineStatusV1> & {questionText?:unknown;blockedCode?:"QUESTION_LIMIT"|"INPUT_CHANGED"}) => {
    const path = join(root, "runs", `${run}.json`), saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, ...changes, run: saved.run }));
  };
  const traces = async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) as
    {op:string;run:string;args:string[];env:Record<string,string>;cwd:string;expectation:Record<string,unknown>|null;expectationText:string|null;fileMode:number|null;directoryMode:number|null;settingsText:string|null}[];
  return { root, adapter, raw, configuration, edit, traces, clearObservations:()=>observations.clear(), setDocumentNames: (names: typeof documentNames) => { documentNames = names; }, setBeforeAdmission: (callback: () => Promise<void>) => { beforeAdmission = callback; } };
}
async function fixture(t: TestContext) {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const engine = await synthetic(t);
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

// Optional adjacent tooling checkout, supplied by the build/review lane. The
// CLI uses its disposable Bridge fixture and dry launcher; no provider runs.
if (process.env.CONTROL_ROOM_A2_TEST_LOOP) test("B1b real CLI intake completes with numbered progress and legacy control", async t => {
  const loop = resolve(process.env.CONTROL_ROOM_A2_TEST_LOOP!);
  const module = await import(pathToFileURL(join(loop, "bridge/a2-contract.mjs")).href);
  const driver = String.raw`import json,sys
sys.path.insert(0,sys.argv[1])
from test_a2_bridge import Bridge
d=Bridge(); d.setUp()
try:
    path,_=d.prepare_intake()
    print(d.settings_path.read_text(),flush=True)
    p=json.load(sys.stdin)
    d.request.write_text(p['description'])
    path.write_text(json.dumps(p['expectation']))
    d.obj(d.cli(*d.intake_args(path)))
    status=d.obj(d.cli('status','synth','--json'))
    assert status['request']['admissions']==d.load()['chain']['admissions']
    print(json.dumps(status),flush=True)
finally:
    d.doCleanups()
`;
  for (const legacy of [false, true]) await t.test(legacy ? "legacy-label control" : "real numbered progress", async t => {
    const f = await fixture(t);
    const child = spawn("/usr/bin/python3", ["-B", "-c", driver, loop], {
      timeout: 60000, env: { PATH: "/usr/bin:/bin", TMPDIR: resolve(".test-tmp"), PYTHONDONTWRITEBYTECODE: "1",
        CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", NODE_ENV: "test" },
    });
    let stderr = ""; child.stderr.on("data", data => { stderr += data; });
    const exited = once(child, "close");
    t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    const settingsLine = await lines.next();
    assert.equal(settingsLine.done, false, "real CLI fixture supplies settings");
    const realSettings = settingsLine.value!;
    const lineage = { ...f.adapter.contract, decodeRunIdentity: (input: unknown) => loopImprovementRunIdentitySchemaV1.parse(input) };
    const contract = module.a2BridgeContractV1(lineage) as LoopAdapterConfigurationV1["contract"];
    let observed: LoopEngineStatusV1 | undefined;
    let failure: unknown;
    let record: { command_id: string; binding_digest: string; evidence: unknown } | undefined;
    const adapter: LoopAdapterV1 = { ...f.adapter, adapterId: module.A2_BRIDGE_ADAPTER_ID,
      schemaDigest: contract.schemaDigest, settingsText: realSettings, contract: lineage, reserveRun: () => "synth",
      intake: async (commandId, binding, text, beforeSpawn) => {
        try {
          const expectation = await contract.admissionExpectation!(Object.freeze({ ...binding, body: Object.freeze(binding.body) }),
            Object.freeze({ operation: "intake", commandId }));
          beforeSpawn();
          child.stdin.end(JSON.stringify({ expectation, description: text }));
          const statusLine = await lines.next();
          const [code] = await exited;
          assert.equal(code, 0, stderr); assert.equal(statusLine.done, false);
          const output = JSON.parse(statusLine.value!);
          record = output.request.admissions[0];
          observed = loopEngineStatusSchemaV1.parse(contract.decodeStatus(output));
          // Only the control changes the display label. The candidate carries
          // the real CLI status and decoder output unchanged into completion.
          return legacy ? { ...observed, progress: { ...observed.progress, step: "intake" } } : observed;
        } catch (error) { failure = error; throw error; }
      } };
    const bridge = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: "tenant:web", workspaceId: "workspace:web" },
      { integrityKey: KEY, adapter }, () => now);
    const key = "b1b-real-intake-0001";
    const result = await bridge.mutate(f.identity, f.project.projectId, null, "intake", { description }, key);
    assert.ifError(failure);
    assert.ok(observed, "real CLI status decoded before completion");
    assert.equal(observed.progress.step, "1"); assert.equal(observed.progress.role, "orchestrator");
    const rows = (await f.db.query<{ entry_kind: string; command_id: string; binding: LoopBridgeBindingV1; result: { evidenceDigest: string } | null }>(
      "SELECT entry_kind,command_id,binding,result FROM control_loop_improvement_commands WHERE request_id=$1 ORDER BY entry_kind", [result.requestId])).rows;
    const claim = rows.find(row => row.entry_kind === "claim")!;
    assert.equal(record!.command_id, claim.command_id); assert.equal(record!.binding_digest, sha256Digest(claim.binding));
    assert.deepEqual(record!.evidence, { request_sha256: loopByteHashV1(description), settings_sha256: loopByteHashV1(realSettings), input_version: 1 });
    assert.equal(result.state, "accepted", "real CLI intake completes with its exact durable admission");
    assert.deepEqual(rows.map(row => row.entry_kind), ["claim", "result"]);
    assert.equal(rows[1]!.result!.evidenceDigest, sha256Digest(record));
    assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_run_links WHERE request_id=$1", [result.requestId])).rows.length, 1);
    assert.equal((await bridge.mutate(f.identity, f.project.projectId, null, "intake", { description }, key)).commandId, result.commandId);
    assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands WHERE request_id=$1", [result.requestId])).rows.length, 2);
  });
});

test("B1b A2 engine receipts (unwrapped adapter)", async t => {
  const f=await fixture(t);
  assert.equal(f.adapter,f.raw,"website uses the unwrapped adapter");
  const result=await f.bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},"b1b-a2-raw-intake-0001");
  const desk=await f.service.viewLoopDesk(f.identity,f.project.projectId);
  assert.ok(desk.loopRequests.find(r=>r.requestId===result.requestId)?.runLink,"A2 unwrapped intake saves a non-null runLink");
  assert.equal(result.state,"accepted");
  const id=result.requestId;
  assert.equal((await f.handler(request(`${f.base}/${encodeURIComponent(id)}/status`))).status,200);
  let s=await f.confirm(id);const run=s.request.runLink!.loopRunId;
  assert.equal(s.request.savedAuthorization,true,"engine confirm receipt saves B1a authorization");
  assert.equal((await f.bridge.mutate(f.identity,f.project.projectId,id,"start",{expectedVersion:1,expectedRevision:s.engine.revision,
    runLinkId:s.request.runLink!.runLinkId},"b1b-a2-raw-start-0001")).state,"accepted","A2 start requires an engine record");
  for(const step of ["plan","spec"] as const){
    const approval={step,inputVersion:1,head:"a".repeat(40),reportSha256:"b".repeat(64)};
    await f.edit(run,{state:"waiting",approval});s=await f.get(id);
    assert.equal((await f.bridge.mutate(f.identity,f.project.projectId,id,"approve",{expectedVersion:1,expectedRevision:s.engine.revision,...approval},
      `b1b-a2-raw-approve-${step}`)).state,"accepted","A2 approve requires an engine record");
  }
  const question={questionId:"question:receipt",inputVersion:1,reportSha256:"d".repeat(64),owner:true,changesInput:false};
  await f.edit(run,{state:"waiting",question});s=await f.get(id);
  assert.equal((await f.bridge.mutate(f.identity,f.project.projectId,id,"answer",{expectedVersion:1,expectedRevision:s.engine.revision,
    questionId:question.questionId,inputVersion:1,questionReportSha256:question.reportSha256,text:"Keep the same scope."},"b1b-a2-raw-answer-0001")).state,"accepted","A2 answer requires an engine record");
  assert.equal((await f.bridge.mutate(f.identity,f.project.projectId,id,"stop",{runLinkId:s.request.runLink!.runLinkId},"b1b-a2-raw-stop-0001")).state,"accepted");
  const saved=JSON.parse(await readFile(join(f.root,"runs",run+".json"),"utf8"));
  assert.equal(Object.hasOwn(saved,"receipts"),false,"fixture persists only engine admission records");
  const records=admissionRecords.parse(saved.admissions);
  const rows=(await f.db.query<{command_id:string;operation:string;result:{evidenceDigest:string}}>(
    "SELECT command_id,operation,result FROM control_loop_improvement_commands WHERE entry_kind='result' AND operation<>'stop'")).rows;
  assert.equal(rows.length,6);
  for(const row of rows){
    const record=records.find(r=>r.command_id===row.command_id)!;
    assert.ok(record,"every accepted website effect has a saved engine record");
    assert.equal(row.result.evidenceDigest,sha256Digest(record),"stored evidenceDigest is the canonical whole engine record digest");
  }
  for(const op of ["intake","confirm-request","start","approve","answer"]){
    const trace=(await f.traces()).find(row=>row.op===op)!;
    assert.ok(trace.args.includes("--expect"),`A2 ${op} includes --expect`);
    assert.equal(trace.expectationText,canonicalJson(trace.expectation));
    assert.equal(trace.fileMode,0o600);assert.equal(trace.directoryMode,0o700);
    const expectation=trace.expectation!;
    const claim=(await f.db.query<{binding:LoopBridgeBindingV1}>("SELECT binding FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind='claim'",[expectation.command_id])).rows[0]!.binding;
    assert.equal(expectation.binding_digest,sha256Digest(claim));
    assert.equal(expectation.operation,op==="confirm-request"?"confirm":op);
    if(op==="approve")assert.deepEqual(expectation.approval,{piece:"plan",report_sha256:"b".repeat(64),head:"a".repeat(40),input_version:1},"approve carries the complete cached seal");
    if(op==="answer")assert.deepEqual(expectation.question,{id:"question:receipt",input_version:1,report_sha256:"d".repeat(64)},"answer carries the complete cached question descriptor");
  }
});

for(const code of [1,2,3]) for(const output of code===1?["envelope"]:["envelope","null-request"]){
  test(`B1b A2 engine receipts save then exit ${code} ${output}`,async t=>{
    const f=await fixture(t),key=`b1b-a2-saved-exit-${code}-${output}`;
    await writeFile(join(f.root,"refusal.json"),JSON.stringify({op:"intake",code,afterSave:true,output}));
    const result=await f.bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},key);
    assert.equal(result.state,code===1?"uncertain":"accepted","saved engine receipt survives exit 2/3 without becoming refused");
    const spawns=(await f.traces()).length;
    const replay=await f.bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},key);
    assert.equal(replay.state,"accepted");assert.equal(replay.replayed,true);
    const traces=await f.traces();assert.equal(traces.filter(row=>row.op==="intake").length,1,"same-key replay never redispatches an effect");
    assert.equal(traces.length,spawns+(code===1?1:0),"replay reads status only when result was uncertain");
    const s=await f.get(result.requestId),record=(await f.raw.status(s.request.runLink!.loopRunId)).receipts.find(r=>r.commandId===result.commandId)!;
    const row=(await f.db.query<{result:{evidenceDigest:string}}>("SELECT result FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind='result'",[result.commandId])).rows[0]!;
    assert.equal(row.result.evidenceDigest,record.evidenceDigest);
  });
}

test("B1b A2 answer uses question version below run version",async t=>{
  const f=await fixture(t),id=await f.intake(),draft=await f.get(id),run=draft.request.runLink!.loopRunId;
  await f.edit(run,{inputVersion:2,revision:2});const s=await f.confirm(id);
  const question={questionId:"question:stale-version",inputVersion:1,reportSha256:"d".repeat(64),owner:true,changesInput:false};
  await f.edit(run,{state:"waiting",question});
  const before=await readFile(join(f.root,"runs",run+".json"),"utf8");
  const result=await f.bridge.mutate(f.identity,f.project.projectId,id,"answer",{expectedVersion:1,expectedRevision:s.engine.revision,
    questionId:question.questionId,inputVersion:1,questionReportSha256:question.reportSha256,text:"Keep scope."},"b1b-a2-question-version-0001");
  const trace=(await f.traces()).find(r=>r.op==="answer")!;
  assert.equal(trace.args[trace.args.indexOf("--input-version")+1],"1","A2 answer argv uses body.inputVersion, never run inputVersion");
  assert.equal(result.state,"refused");
  assert.equal(await readFile(join(f.root,"runs",run+".json"),"utf8"),before,"QUESTION_STALE preserves the run bytes");
});

test("B1b website intake confirm start status stop", async t => {
  const f = await fixture(t), id = await f.intake();
  let s = await f.get(id); const run = s.request.runLink!.loopRunId;
  assert.equal(s.engine.state, "draft"); assert.equal(s.request.savedAuthorization, false);
  assert.deepEqual((await f.traces()).filter(e => ["start", "approve", "answer"].includes(e.op)), []);
  await f.edit(run, { description: "Adopt the exact edited draft.", revision: 2, inputVersion: 2 });
  s = await f.confirm(id); assert.equal(s.request.currentVersion, 2); assert.equal(s.request.runLink!.initialInputVersion, 1);
  assert.equal(s.request.savedAuthorization, true);
  assert.equal((await f.post(`${encodeURIComponent(id)}/confirm`, { expectedVersion: s.request.currentVersion,
    expectedRevision: s.engine.revision, requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 })).status,409,
    "new keys cannot rewrite an already saved owner confirmation");
  const startBody = { expectedVersion: 2, expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId };
  const key = "b1b-start-exact-0001";
  const started = await f.post(`${encodeURIComponent(id)}/start`, startBody, key);
  assert.equal(started.status, 202); assert.equal((await started.json() as {state:string}).state,"accepted");
  assert.equal((await f.get(id)).engine.state,"running");
  const replay = await f.post(`${encodeURIComponent(id)}/start`, startBody, key);
  assert.equal(replay.status, 200); assert.equal((await replay.json() as {replayed:boolean}).replayed,true);
  assert.equal((await f.post(`${encodeURIComponent(id)}/start`, startBody)).status,409);
  const reconstructed = new ImproveControlRoomLoopServiceV1(f.client, {tenantId:"tenant:web",workspaceId:"workspace:web"}, {integrityKey:KEY,adapter:f.adapter},()=>now);
  await reconstructed.status(f.identity,f.project.projectId,id);
  const stopBody = {runLinkId:s.request.runLink!.runLinkId};
  assert.equal((await f.post(`${encodeURIComponent(id)}/stop`,stopBody)).status,202);
  assert.equal((await f.get(id)).engine.state,"stopped");
  assert.equal((await f.post(`${encodeURIComponent(id)}/stop`,stopBody)).status,202);
  const traces=await f.traces(); assert.equal(traces.filter(e=>e.op==="start").length,1,"B1b one-dispatch launch count");
  for(const trace of traces){ assert.equal(trace.cwd,f.root); // macOS libSystem adds this locale marker after exec; it is not inherited by spawn.
    const { __CF_USER_TEXT_ENCODING: _systemLocale, ...configuredEnv } = trace.env;
    assert.deepEqual(configuredEnv,{LANG:"C.UTF-8",LC_ALL:"C.UTF-8",NODE_ENV:"production"}); }
  const first=traces.find(e=>e.op==="intake")!;
  assert.deepEqual(first.args.slice(0,1),["--source"]); assert.deepEqual(first.args.slice(2),["--settings",join(dirname(first.args.at(-1)!),"settings.json"),"--availability",join(f.root,"availability.json"),"--json","--expect",first.args.at(-1)!]);
  assert.deepEqual(traces.find(e=>e.op==="start")!.args,["--settings",join(dirname(traces.find(e=>e.op==="start")!.args.at(-1)!),"settings.json"),"--availability",join(f.root,"availability.json"),"--json","--expect",traces.find(e=>e.op==="start")!.args.at(-1)!]);
  for(const table of ["pipeline_runs","control_jobs","control_native_task_queue","control_improvement_requests","control_update_candidates"])
    assert.equal((await f.db.query<{n:number}>(`SELECT count(*)::int n FROM ${table}`)).rows[0]!.n,0);
  console.log("B1b SYNTHETIC journey adoption=2 initial=1 starts=1 pipeline_tasks_publication=0 argv_env_cwd=exact");
});

test("B1b strict bodies, hashes, lineage and owner refusal",async t=>{
  const f=await fixture(t), id=await f.intake(), suffix=encodeURIComponent(id);
  const before=(await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length;
  const initial=await f.get(id);
  for(const body of [{description:" "},{description:"ok",argv:["evil"]},{description:"x".repeat(8001)}])
    assert.equal((await f.post("intake",body)).status,400);
  assert.equal((await f.post(`${suffix}/confirm`,{expectedVersion:1,expectedRevision:initial.engine.revision,requestSha256:"0".repeat(64),settingsSha256:initial.engine.settingsSha256})).status,409);
  assert.equal((await f.post(`${suffix}/confirm`,{expectedVersion:2,expectedRevision:initial.engine.revision,requestSha256:initial.engine.requestSha256,settingsSha256:initial.engine.settingsSha256})).status,409);
  assert.equal((await f.post(`${suffix}/start`,{expectedVersion:1,expectedRevision:1,runLinkId:initial.request.runLink!.runLinkId})).status,409);
  assert.equal((await f.post(`${suffix}/stop`,{runLinkId:"loop-link:foreign"})).status,404);
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length,before);
  const paths=["intake",`${suffix}/status`,`${suffix}/confirm`,`${suffix}/start`,`${suffix}/stop`,`${suffix}/approve`,`${suffix}/answer`];
  const bodies=[{description},undefined,{expectedVersion:1,expectedRevision:1,requestSha256:initial.engine.requestSha256,settingsSha256:initial.engine.settingsSha256},
    {expectedVersion:1,expectedRevision:1,runLinkId:initial.request.runLink!.runLinkId},{runLinkId:initial.request.runLink!.runLinkId},
    {expectedVersion:1,expectedRevision:1,step:"plan",inputVersion:1,head:"a".repeat(40),reportSha256:"a".repeat(64)},
    {expectedVersion:1,expectedRevision:1,questionId:"question:owner",inputVersion:1,questionReportSha256:"b".repeat(64),text:"Keep scope."}];
  for(let i=0;i<paths.length;i++){
    const req=request(`${f.base}/${paths[i]}`,i===1?"GET":"POST",bodies[i],"b1b-refusal-check-0001"); req.headers.set("origin","https://foreign.invalid"); req.headers.set("sec-fetch-site","cross-site");
    assert.equal((await f.handler(req)).status,403);
    const missing=request(`${f.base}/${paths[i]}`,i===1?"GET":"POST",bodies[i],"b1b-refusal-check-0001");missing.headers.delete("cf-access-jwt-assertion");
    assert.equal((await f.handler(missing)).status,401);
  }
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  for(let i=0;i<paths.length;i++) assert.equal((await f.handler(request(`${f.base}/${paths[i]}`,i===1?"GET":"POST",bodies[i],"b1b-refusal-check-0001"))).status,403,"B1b denied caller attempts zero persistence");
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length,before);
});

test("B1b claim without result never redispatches and signed tampering refuses",async t=>{
  const f=await fixture(t),id=await f.intake();const s=await f.confirm(id),suffix=encodeURIComponent(id);
  let launches=0;
  const adapter={...f.adapter,start:async()=>{launches++;throw new Error("SYNTHETIC lost result");}};
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
  const body={expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId};
  const key="b1b-lost-launch-0001";
  assert.equal((await bridge.mutate(f.identity,f.project.projectId,id,"start",body,key)).state,"uncertain");
  assert.equal((await bridge.mutate(f.identity,f.project.projectId,id,"start",body,key)).state,"uncertain");
  assert.equal(launches,1,"B1b pending claim never dispatches twice");
  await f.db.exec("ALTER TABLE control_loop_improvement_commands DISABLE TRIGGER USER");
  await f.db.query("UPDATE control_loop_improvement_commands SET auth_tag=$1 WHERE idempotency_key=$2",[`hmac-sha256:${"0".repeat(64)}`,key]);
  assert.equal((await f.post(`${suffix}/start`,body,key)).status,503);
});

test("B1b configured execution/path fence, missing qualification and pin drift",async t=>{
  const f=await fixture(t);const link=join(f.root,"linked-settings.json");await symlink(join(f.root,"settings.json"),link);
  assert.throws(()=>createImproveControlRoomLoopAdapterV1({...f.configuration,settingsFile:link}),/unavailable/,"B1b configured symlink refusal");
  assert.throws(()=>createImproveControlRoomLoopAdapterV1({...f.configuration,entrypoint:join(f.root,"..","engine.py")}),/unavailable/);
  assert.throws(()=>createImproveControlRoomLoopAdapterV1({...f.configuration,executionIdentity:{...f.configuration.executionIdentity,uid:-1}}),/unavailable/);
  const unqualified=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,qualifiedOperations:[],admissionExpectation:undefined}});t.after(()=>unqualified.close());
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter:unqualified},()=>now);
  await assert.rejects(bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},"b1b-unqualified-0001"),/unavailable/);
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length,0);
  await writeFile(join(f.root,"settings.json"),"{}");
  assert.equal((await f.post("intake",{description})).status,503);
});


test("B1b exact-current confirmation guard",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const current=await f.adapter.status(run);
  await f.edit(run,{confirmation:{...current.confirmation!,at:"2026-10-02T00:00:00.000Z"}});
  const before=(await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length;
  const response=await f.post(`${encodeURIComponent(id)}/start`,{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId});
  assert.equal(response.status,409,"B1b changed owner confirmation refuses before claim");
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length,before);
});

const carrierConfiguration = z.object({
  adapterId:z.string().min(1),interpreter:z.string(),entrypoint:z.string(),toolingManifest:z.string(),
  interpreterSha256:rawHash,entrypointSha256:rawHash,runRoot:z.string(),workRoot:z.string(),configRoot:z.string(),cwd:z.string(),
  settingsFile:z.string(),availabilityFile:z.string(),toolingRevision:z.string().regex(/^sha256:[a-f0-9]{64}$/),
  settingsSha256:rawHash,availabilitySha256:rawHash,
  executionIdentity:z.object({uid:z.number().int().nonnegative(),isolationEvidenceDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/)}).strict(),
  timeoutMs:z.number().int().min(100).max(60000).optional(),
}).strict();
const carrierSchema=z.object({modulePath:z.string(),moduleSha256:rawHash,configuration:carrierConfiguration,
  qualifiedOperations:z.array(z.enum(["intake","confirm","start","stop","approve","answer"])).max(6)
    .refine(ops=>new Set(ops).size===ops.length),
  recovery:z.boolean().optional(),monitoring:z.literal(true).optional(),finalization:z.enum(["retain","cleanup"]).optional(),
  race:z.object({run:z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/),entrypoint:z.string(),entrypointSha256:rawHash}).strict().optional(),
}).strict().refine(c=>!c.race || c.qualifiedOperations.length===0,"race carrier cannot qualify production operations");
function checkedCarrierPath(path:string,directory=false){
  assert.ok(isAbsolute(path) && resolve(path)===path,"carrier paths are absolute and canonical");
  assert.doesNotMatch(path,/(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.aws|\.codex|\.hermes|auth\.json|credentials|tokens?)(?:[/\\]|$)/iu);
  for(let part=path;;part=dirname(part)){
    assert.equal(lstatSync(part).isSymbolicLink(),false,"carrier paths cannot follow symlinks");
    if(part===dirname(part))break;
  }
  assert.equal(realpathSync(path),path);
  assert.ok(directory?lstatSync(path).isDirectory():lstatSync(path).isFile(),"carrier path has the required file type");
  return path;
}
async function loadA2Carrier(path:string){
  checkedCarrierPath(path);assert.ok(lstatSync(path).size<=65536,"carrier byte cap");
  const carrier=carrierSchema.parse(parseStrictJsonV1(await readFile(path,"utf8"),{maxBytes:65536}));
  assert.equal(carrier.recovery,true,"check 6 requires recovery");
  assert.equal(carrier.monitoring,true,"check 6 requires monitoring");
  assert.equal(Object.hasOwn(carrier,"finalization"),false,"F13: check 6 never owns finalization");
  const c=carrier.configuration,root=c.configRoot;
  for(const path of [root,c.runRoot,c.workRoot,c.cwd])checkedCarrierPath(path,true);
  assert.equal(c.runRoot,join(root,"runs"));assert.equal(c.workRoot,join(root,"work"));assert.equal(c.cwd,join(root,"product"));
  assert.equal(c.entrypoint,join(root,"tools/loop/bridge/cr-entry.py"));assert.equal(c.toolingManifest,join(root,"config","manifest.sha256"));
  assert.equal(carrier.modulePath,join(root,"tools","loop","bridge","a2-contract.mjs"));
  assert.equal(c.settingsFile,join(root,"config/settings.json"));
  assert.equal(c.availabilityFile,join(root,"config/availability.json"));
  checkedCarrierPath(c.availabilityFile); // monitored bytes refresh; the module admits their pinned path/hash shape
  const hashes:[[string,string],...[string,string][]]=[[carrier.modulePath,carrier.moduleSha256],[c.interpreter,c.interpreterSha256],
    [c.entrypoint,c.entrypointSha256],[c.toolingManifest,c.toolingRevision.slice(7)],[c.settingsFile,c.settingsSha256]];
  if(carrier.race){assert.equal(carrier.race.entrypoint,join(root,"tools/loop/bridge/race-entry.py"));hashes.push([carrier.race.entrypoint,carrier.race.entrypointSha256]);}
  for(const [path,hash] of hashes){checkedCarrierPath(path);assert.equal(loopByteHashV1(await readFile(path)),hash,"carrier digest checked before import or spawn");}
  const lineage={toolingRevision:c.toolingRevision,decodeRunIdentity:(value:unknown)=>{
    const run=loopImprovementRunIdentitySchemaV1.parse(value);
    assert.equal(run.adapterId,c.adapterId);assert.equal(run.toolingRevision,c.toolingRevision);
    assert.match(run.loopRunId,/^[a-z0-9][a-z0-9-]{0,40}$/);return run;
  },decodeObservation:(value:unknown)=>{
    const observation=loopImprovementObservationSchemaV1.parse(value);
    assert.equal(observation.confirmation.path,"docs/request-source.md");return observation;
  },matchesSavedInput:(_run:unknown,observation:{settingsDigest:string;confirmation:{path:string;sha256:string}},input:{description:string;settingsText:string;requestSha256:string;settingsSha256:string})=>
    observation.settingsDigest===loopByteHashV1(canonicalJson(parseStrictJsonV1(input.settingsText,{maxBytes:65536})))
    && observation.confirmation.path==="docs/request-source.md" && observation.confirmation.sha256===loopByteHashV1(input.description)
    && input.requestSha256===loopByteHashV1(input.description) && input.settingsSha256===loopByteHashV1(input.settingsText)};
  const module=await import(pathToFileURL(carrier.modulePath).href);
  assert.equal(typeof module.a2BridgeContractV1,"function","reviewed A2 carrier exports the contract factory");
  assert.equal(typeof module.loadA2Carrier,"function","reviewed module owns carrier construction");
  const loaded=await module.loadA2Carrier(path,{root,lineage});
  const contract=loaded.configuration.contract as LoopAdapterConfigurationV1["contract"];
  assert.equal(contract.lineage,lineage,"desk and service share the reviewed B1a lineage instance");
  assert.match(contract.schemaDigest,/^sha256:[a-f0-9]{64}$/);
  for(const name of ["generateRunId","decodeStatus","admissionExpectation","locateApprovalDocument","decodeApprovalSidecar"] as const)
    assert.equal(typeof contract[name],"function",`reviewed A2 export supplies ${name} before any spawn`);
  assert.equal(typeof contract.decisionProjection?.decodeGate,"function");
  assert.ok(contract.decisionProjection?.questionTextPath.length);
  assert.ok(contract.decisionProjection.questionTextPath.every(part=>typeof part==="string" && part && !["__proto__","prototype","constructor"].includes(part)));
  return {carrier,configuration:loaded.configuration as LoopAdapterConfigurationV1};
}

test("B1b A2 carrier validates every pin before import or spawn",async t=>{
  const f=await synthetic(t),root=join(f.root,"carrier");
  for(const part of ["runs","work","product","config","tools/loop/bridge"])await mkdir(join(root,part),{recursive:true});
  const modulePath=join(root,"tools/loop/bridge/a2-contract.mjs"),marker=join(root,"tools/loop/bridge/imported");
  const source=`import {writeFileSync} from "node:fs";writeFileSync(new URL("./imported",import.meta.url),"loaded");
export const a2BridgeContractV1=lineage=>({lineage,schemaDigest:"sha256:${"c".repeat(64)}",qualifiedOperations:[],
generateRunId:()=>"web-${"a".repeat(32)}",decodeStatus:()=>{throw new Error("no synthetic observations")},admissionExpectation:()=>({}),
locateApprovalDocument:()=>({report:"gate.md",sidecar:"gate.json"}),decodeApprovalSidecar:value=>value,
decisionProjection:{questionTextPath:["attention","text"],decodeGate:()=>null}});
export async function loadA2Carrier(file,{lineage}){const {readFile}=await import('node:fs/promises');const c=JSON.parse(await readFile(file,'utf8'));
return {configuration:{...c.configuration,contract:{...a2BridgeContractV1(lineage),recovery:{enabled:()=>true},monitoring:{enabled:()=>true},qualifiedOperations:c.qualifiedOperations}}};}`;
  await writeFile(modulePath,source);await writeFile(join(root,"tools/loop/bridge/cr-entry.py"),"# carrier loader fixture");
  await writeFile(join(root,"tools/loop/bridge/race-entry.py"),"# carrier race fixture");await writeFile(join(root,"config/manifest.sha256"),"synthetic manifest");
  await writeFile(join(root,"config/settings.json"),settingsText);await writeFile(join(root,"config/availability.json"),"{}");
  const configuration={...f.configuration,configRoot:root,runRoot:join(root,"runs"),workRoot:join(root,"work"),cwd:join(root,"product"),
    entrypoint:join(root,"tools/loop/bridge/cr-entry.py"),entrypointSha256:loopByteHashV1("# carrier loader fixture"),
    toolingManifest:join(root,"config/manifest.sha256"),toolingRevision:`sha256:${loopByteHashV1("synthetic manifest")}`,
    settingsFile:join(root,"config/settings.json"),availabilityFile:join(root,"config/availability.json")};
  const {contract:_contract,...data}=configuration;
  const carrier={modulePath,moduleSha256:loopByteHashV1(source),configuration:data,qualifiedOperations:[],recovery:true,monitoring:true};
  const file=join(root,"config/contract.json");
  const invalid=[{...carrier,recovery:false},{...carrier,recovery:undefined},{...carrier,monitoring:undefined},
    {...carrier,monitoring:false},{...carrier,finalization:"retain"},{...carrier,finalization:"cleanup"},
    {...carrier,configuration:{...data,entrypoint:join(root,"cr-entry.py")}},
    {...carrier,configuration:{...data,settingsFile:join(root,"config/other.json")}},
    {...carrier,configuration:{...data,availabilityFile:join(root,"config/other.json")}},{...carrier,moduleSha256:"0".repeat(64)},{...carrier,extra:true},
    {...carrier,configuration:{...data,executionIdentity:{...data.executionIdentity,uid:null}}},
    {...carrier,race:{run:"race-run",entrypoint:join(root,"tools/loop/bridge/race-entry.py"),entrypointSha256:loopByteHashV1("# carrier race fixture")},qualifiedOperations:["approve"]},
    {...carrier,configuration:{...data,cwd:f.root}},{...carrier,modulePath:f.configuration.entrypoint}];
  for(const key of ["interpreterSha256","entrypointSha256","settingsSha256"] as const)
    invalid.push({...carrier,configuration:{...data,[key]:"0".repeat(64)}});
  invalid.push({...carrier,configuration:{...data,toolingRevision:`sha256:${"0".repeat(64)}`}});
  invalid.push({...carrier,race:{run:"race-run",entrypoint:join(root,"tools/loop/bridge/race-entry.py"),entrypointSha256:"0".repeat(64)}});
  invalid.push({...carrier,configuration:{...data,availabilitySha256:"bad"}});
  for(const bad of invalid){await writeFile(file,JSON.stringify(bad));await assert.rejects(loadA2Carrier(file));
    await assert.rejects(readFile(marker),{code:"ENOENT"},"invalid carrier cannot import or spawn");}
  await writeFile(file,JSON.stringify(carrier));
  const loaded=await loadA2Carrier(file);assert.equal(await readFile(marker,"utf8"),"loaded");
  assert.equal(loaded.configuration.contract.generateRunId(),`web-${"a".repeat(32)}`);
  assert.equal(loaded.configuration.contract.recovery?.enabled(),true);
  assert.equal(loaded.configuration.contract.monitoring?.enabled(),true);
  // Fresh monitoring bytes do not invalidate an immutable carrier's bootstrap hash.
  await writeFile(configuration.availabilityFile,JSON.stringify({schema_version:1,checked_at:new Date().toISOString(),
    entries:[{model:"SYNTHETIC",route:"synthetic",available:true}]}));
  for(let restart=0;restart<2;restart++)assert.equal((await loadA2Carrier(file)).configuration.contract.monitoring?.enabled(),true);
  const race={run:"race-run",entrypoint:join(root,"tools/loop/bridge/race-entry.py"),entrypointSha256:loopByteHashV1("# carrier race fixture")};
  await writeFile(file,JSON.stringify({...carrier,race}));assert.deepEqual((await loadA2Carrier(file)).carrier.race,race);
});

if(process.env.CONTROL_ROOM_B1B_REQUIRE_A2==="1") test("reviewed A2 bridge contract",{timeout:1800000},async t=>{
  const path=process.env.CONTROL_ROOM_B1B_A2_CONTRACT;
  assert.ok(path,"I1–I3 NOT SUPPLIED: reviewed tooling/captures, atomic A2 admission and B0-qualified disposable proof required");
  const {carrier,configuration}=await loadA2Carrier(path);
  const port=Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE??59420);
  assert.ok(port>=59420 && port<=59429,"real proof uses its reserved PostgreSQL ports");
  const proof=await withRealPostgres(async pg=>{
    const admin=new Pool(pg.connection("admin")),web=bindPrivatePgPool(new Pool(pg.connection("web")));
    try{
    await admin.query("INSERT INTO tenants(id,display_name) VALUES('tenant:web','Bridge proof')");
    await admin.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:web','tenant:web','Bridge proof')");
    await admin.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
      VALUES('identity:web','tenant:web','human','Proof owner',$1,$2,'active',$3,$3)`,[trust.issuer,sha256Digest({provider:trust.issuer,subject:"test-owner"}),new Date(now-60000).toISOString()]);
    await admin.query(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,allow_external_effects,require_strong_factor,created_at,updated_at)
      VALUES('grant:web','tenant:web','identity:web','owner','["*"]','["*"]','critical',true,false,$1,$1)`,[new Date(now-60000).toISOString()]);
    const identity=createAccessVerifier(trust)(request(),now);
    const projects=new WebProjectService(web.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},()=>now);
    const {project}=await projects.create(identity,{title:"Bridge proof",summary:"Disposable reviewed A2 proof"},"a2-proof-project-0001");
    await admin.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
      '{"schema":"control-room.project-presentation/v1","templateId":"control-room","configurationDigest":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","templateDisplayName":"Control Room","enabledModules":[]}'::jsonb) WHERE id=$1`,[project.projectId]);
    // Qualification exists only in this proof's memory. Never rewrite the carrier.
    const qualified={...configuration,contract:{...configuration.contract,qualifiedOperations:["intake","confirm","start","stop","approve","answer"] as const}};
    const adapter=createImproveControlRoomLoopAdapterV1(qualified);
    const ownedRuns=new Set<string>();
    const native=async(op:"status"|"advance",run:string)=>{
      for(const [file,hash] of [[configuration.interpreter,configuration.interpreterSha256],[configuration.entrypoint,configuration.entrypointSha256]])
        assert.equal(loopByteHashV1(await readFile(checkedCarrierPath(file!))),hash,"native command uses the pinned executable bytes");
      const {stdout}=await promisify(execFile)(configuration.interpreter,[configuration.entrypoint,op,run,"--json"],
        {cwd:configuration.cwd,env:{NODE_ENV:"production",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"},timeout:60000,maxBuffer:65536});
      return parseStrictJsonV1(stdout,{maxBytes:65536}) as {steps:{role:string;state:string}[];error:unknown};
    };
    const savedRun=async(run:string)=>JSON.parse(await readFile(checkedCarrierPath(join(configuration.runRoot,run,"run.json")),"utf8"));
    const desk=new ImproveControlRoomDeskServiceV1(web.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,configuration.contract.lineage);
    const makeBridge=(adapter:LoopAdapterV1)=>new ImproveControlRoomLoopServiceV1(web.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
    const bridge=makeBridge(adapter);
    const handler=createImproveControlRoomHttpHandlerV1({origin,trust,service:desk,clock:()=>now,loopBridge:bridge});
    const base=`/api/v1/projects/${encodeURIComponent(project.projectId)}/improvements/loop`;
    let sequence=0;
    const post=async(id:string|null,op:string,body:unknown,target=handler)=>{
      const response=await target(request(`${base}/${id?encodeURIComponent(id)+"/":""}${op}`,"POST",body,`a2-proof-command-${++sequence}`));
      assert.equal(response.status,202);return await response.json() as {requestId:string;commandId:string;state:string;engineRevision:number};
    };
    const evidence=async(result:{commandId:string;state:string;engineRevision:number},run:string)=>{
      assert.equal(result.state,"accepted","real A2 command has positive saved evidence");
      const status=await adapter.status(run);assert.equal(result.engineRevision,status.revision);
      const receipt=status.receipts.find(r=>r.commandId===result.commandId)!;assert.ok(receipt);
      const row=(await web.client.query<{binding:LoopBridgeBindingV1;result:{evidenceDigest:string}}>(
        "SELECT binding,result FROM control_loop_improvement_commands WHERE command_id=$1 AND entry_kind='result'",[result.commandId])).rows[0]!;
      assert.equal(receipt.bindingDigest,sha256Digest(row.binding));assert.equal(row.result.evidenceDigest,receipt.evidenceDigest);
      const saved=parseStrictJsonV1(await readFile(join(configuration.runRoot,run,"run.json"),"utf8")) as {chain:{admissions:{command_id:string}[]}};
      const record=admissionRecords.parse([saved.chain.admissions.find(record=>record.command_id===result.commandId)])[0]!;
      assert.equal(record.binding_digest,sha256Digest(row.binding));
      assert.equal(receipt.evidenceDigest,sha256Digest(record),"real receipt hashes the canonical immutable engine record");
      assert.doesNotMatch(canonicalJson(record),/[/\\]/u,"admission evidence contains no host paths");
      console.log("A2 admission "+canonicalJson(record));
    };
    const adoptGate=async(run:string)=>{
      const status=await adapter.status(run);assert.ok(status.confirmation,"prepared gate has exact confirmed request evidence");ownedRuns.add(run);
      const saved=await desk.saveLoopDraft(identity,project.projectId,{description:status.description,settingsText:adapter.settingsText},`a2-gate-draft-${++sequence}`);
      const id=saved.request.requestId;
      const link=await desk.recordLoopRunLink({projectId:project.projectId,requestId:id,initialInputVersion:1,run:status.run});
      await desk.authorizeLoopStart(identity,project.projectId,{requestId:id,expectedVersion:1,runLinkId:link.runLink.runLinkId,
        requestSha256:loopByteHashV1(status.description),settingsSha256:status.settingsSha256},`a2-gate-authorize-${++sequence}`,
        {revision:status.revision,inputVersion:status.inputVersion,settingsDigest:status.settingsDigest,confirmation:status.confirmation});
      return {id,status};
    };
    try{
      const intake=await post(null,"intake",{description:"Confirm this disposable bridge proof before starting work."});
      let s=await bridge.status(identity,project.projectId,intake.requestId);
      assert.ok(s.request.runLink);const run=s.request.runLink.loopRunId;ownedRuns.add(run);
      await evidence(intake,run);assert.equal(s.request.savedAuthorization,false);
      assert.equal((await handler(request(`${base}/${encodeURIComponent(intake.requestId)}/status`))).status,200);
      // Intake's real orchestrator must end, then advance consumes its proposal.
      const intakeBound=Date.now()+600000;
      for(;;){
        const observed=await native("status",run);assert.equal(observed.error,null);
        const attempt=observed.steps.at(-1);assert.equal(attempt?.role,"orchestrator");
        if(attempt.state==="done")break;
        assert.ok(["starting","running"].includes(attempt.state),"intake must finish with a real usable proposal");
        assert.ok(Date.now()<intakeBound,"intake attempt ends within its bound");await delay(1000);
      }
      assert.equal((await native("advance",run)).error,null,"native advance consumes the real intake proposal");
      s=await bridge.status(identity,project.projectId,intake.requestId);
      const confirmed=await post(intake.requestId,"confirm",{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,
        requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256});await evidence(confirmed,run);
      s=await bridge.status(identity,project.projectId,intake.requestId);assert.equal(s.request.savedAuthorization,true);
      const start=await post(intake.requestId,"start",{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId});
      await evidence(start,run);
      const started=await savedRun(run),last=started.steps.at(-1);
      assert.equal(last.role,"plan");assert.equal(last.deadline.budget_seconds,60,"reviewed one-minute attempt budget");
      const beforeCounters=structuredClone(started.chain.counters),beforeSteps=started.steps.length;
      const deadlineBound=Date.now()+120000;
      for(;;){
        const observed=(await adapter.status(run)).monitoring;assert.ok(observed?.deadline,"real plan attempt has a saved deadline");
        assert.equal(observed.deadline.attemptId,last.deadline.attempt);
        assert.notEqual(observed.workerState,"ended","a plan attempt ending before the live deadline proof fails");
        assert.notEqual(observed.reasonCode,"CLOCK_UNCERTAIN");
        if(Date.now()>=Date.parse(observed.deadline.dueAt)+5000){assert.equal(observed.workerState,"live");break;}
        assert.ok(Date.now()<deadlineBound,"live deadline observation stays bounded");await delay(1000);
      }
      assert.equal((await native("advance",run)).error,null,"native advance saves the overdue fact");
      // One observation proves deadline exceeded and worker live together.
      const monitoring=(await adapter.status(run)).monitoring;assert.ok(monitoring);
      assert.equal(monitoring.reasonCode,"DEADLINE_EXCEEDED");assert.equal(monitoring.deadline?.state,"exceeded");
      assert.equal(monitoring.workerState,"live");
      const overdue=await savedRun(run);assert.ok(overdue.steps.at(-1).overdue);
      assert.equal(overdue.steps.at(-1).overdue.worker,"live");
      assert.equal(overdue.steps.length,beforeSteps);assert.deepEqual(overdue.chain.counters,beforeCounters);
      const summary=loopMonitoringAttentionV1(monitoring);assert.ok(summary);assert.equal(summary.code,"DEADLINE_EXCEEDED");
      const attention=await bridge.readAttention(identity);assert.equal(attention.state,"available");
      if(attention.state!=="available")assert.fail("website attention must be available");
      const item=attention.items.find(item=>item.projectId===project.projectId&&item.requestId===intake.requestId&&item.runLinkId===s.request.runLink!.runLinkId);
      assert.ok(item,"website attention includes this request");assert.equal(item.summary,`${summary.message} ${summary.nextAction}`);
      const stop=await post(intake.requestId,"stop",{runLinkId:s.request.runLink!.runLinkId});assert.equal(stop.state,"accepted");
      const stopped=await savedRun(run);assert.ok(stopped.chain.stopped_at,"native Stop is saved");
      assert.deepEqual(stopped.steps.at(-1).overdue,overdue.steps.at(-1).overdue,"Stop retains the overdue fact");
      console.log("B1b deadline=exceeded worker=live saved_overdue=true counters_unchanged=true website_attention=true stopped=true");
      assert.equal((await bridge.status(identity,project.projectId,intake.requestId)).engine.state,"stopped");
      // Discover only lead-prepared harness runs. Never fabricate engine state or receipts.
      const gates=new Map<string,string>();
      for(const entry of await readdir(configuration.runRoot,{withFileTypes:true})){
        if(!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(entry.name) || entry.name===carrier.race?.run)continue;
        const status=await adapter.status(entry.name);
        if(status.approval)gates.set(status.approval.step,entry.name);
        if(status.question?.owner && !status.question.changesInput)gates.set("question",entry.name);
      }
      for(const step of ["plan","spec","question"]){
        const gate=gates.get(step);assert.ok(gate,`lead supplied real ${step} gate`);
        const {id,status}=await adoptGate(gate);
        const result=step==="question"?await post(id,"answer",{expectedVersion:1,expectedRevision:status.revision,questionId:status.question!.questionId,
          inputVersion:status.question!.inputVersion,questionReportSha256:status.question!.reportSha256,text:"Keep the approved scope."})
          :await post(id,"approve",{expectedVersion:1,expectedRevision:status.revision,...status.approval!});
        await evidence(result,gate);
      }
      assert.ok(carrier.race,"lead supplied the deterministic G3 race carrier");
      const raced=createImproveControlRoomLoopAdapterV1({...qualified,entrypoint:carrier.race.entrypoint,entrypointSha256:carrier.race.entrypointSha256});
      try{
        const {id,status}=await adoptGate(carrier.race.run);assert.equal(status.approval?.step,"plan");
        const racedBridge=makeBridge(raced),racedHandler=createImproveControlRoomHttpHandlerV1({origin,trust,service:desk,clock:()=>now,loopBridge:racedBridge});
        const result=await post(id,"approve",{expectedVersion:1,expectedRevision:status.revision,...status.approval!},racedHandler);
        assert.equal(result.state,"refused","real A2 race refuses old approval pins");
        checkedCarrierPath(join(configuration.configRoot,"evidence","race.fired"));
        const stop=JSON.parse(await readFile(join(configuration.configRoot,"evidence","race-stop.json"),"utf8"));
        assert.equal(stop.state,"stopped");assert.equal(stop.revision,status.revision+1);
        const afterStop=await readFile(join(configuration.runRoot,carrier.race.run,"run.json"),"utf8");
        assert.equal(JSON.parse(afterStop).chain.revision,stop.revision);
        assert.equal(JSON.parse(afterStop).chain.admissions.some((r:{command_id:string})=>r.command_id===result.commandId),false);
        assert.equal((await raced.status(carrier.race.run)).state,"stopped");
        assert.equal(await readFile(join(configuration.runRoot,carrier.race.run,"run.json"),"utf8"),afterStop);
      }finally{await raced.close();}
    }finally{
      // Stop every proof run before closing the adapter or database, even on failure.
      try{for(const run of ownedRuns){const stop=spawnSync(configuration.interpreter,[configuration.entrypoint,"stop",run,"--json"],
        {cwd:configuration.cwd,env:{NODE_ENV:"production",LANG:"C.UTF-8",LC_ALL:"C.UTF-8"},encoding:"utf8",timeout:60000});assert.equal(stop.status,0,"proof run cleanup Stop succeeds");}}
      finally{await adapter.close();}
    }
    }finally{await web.close();await admin.end();}
  },{port,allowedPorts:Array.from({length:10},(_,i)=>59420+i),database:"a2_bridge_proof",boundMs:1800000});
  assert.equal(proof.cleanedUp,true);assert.deepEqual(proof.leftovers,[]);

});

test("B1b bounded malformed/overflow commands, deadline and owned child reap",async t=>{
  const f=await synthetic(t),run=f.adapter.reserveRun();
  for(const source of ['print("x"*70000)','print("not-json")','print("{}")']){
    await writeFile(f.configuration.entrypoint,source);
    const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,entrypointSha256:loopByteHashV1(source)});
    try{await assert.rejects(adapter.status(run),/unavailable/);}finally{await adapter.close();}
  }
  const pidFile=join(f.root,"owned.pid"),source=`import os,time\nwith open(${JSON.stringify(pidFile)},'w') as f: f.write(str(os.getpid()))\ntime.sleep(60)\n`;
  await writeFile(f.configuration.entrypoint,source);
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,entrypointSha256:loopByteHashV1(source),timeoutMs:5000});
  const pending=adapter.status(run).then(()=>assert.fail("hung command cannot succeed"),()=>undefined);
  let pid=0;
  for(let attempt=0;attempt<100;attempt++){
    try{pid=Number(await readFile(pidFile,"utf8"));if(pid)break;}catch{}
    await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.ok(pid>0);await adapter.close();await pending;
  assert.throws(()=>process.kill(pid,0),{code:"ESRCH"},"owned command child was reaped");
  await rm(pidFile);
  const timed=createImproveControlRoomLoopAdapterV1({...f.configuration,entrypointSha256:loopByteHashV1(source),timeoutMs:100});
  const began=Date.now();try{await assert.rejects(timed.status(run),/unavailable/);assert.ok(Date.now()-began<3000);}finally{await timed.close();}
});

test("B1b configured executable pin guard",async t=>{
  const f=await synthetic(t);await writeFile(f.configuration.entrypoint,'print("changed executable")');
  assert.throws(()=>createImproveControlRoomLoopAdapterV1(f.configuration),/unavailable/,"B1b changed executable refuses construction before any command");
});

test("B1b admission expiry after A2 lock wait cannot spawn",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id);let current=now;
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:'tenant:web',workspaceId:'workspace:web'},{integrityKey:KEY,adapter:f.adapter},()=>current);
  f.setBeforeAdmission(async()=>{current+=6000;});
  const result=await bridge.mutate(f.identity,f.project.projectId,id,'start',{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},'b1b-lock-expiry-0001');
  assert.equal((await f.traces()).filter(e=>e.op==='start').length,0,'B1b expired admission after lock wait spawns no Start');
  assert.equal(result.state,'uncertain');
});

for (const [operation, code, output = "envelope"] of [["approve", 2, "empty"], ["approve", 3, "malformed"], ["approve", 2], ["approve", 3], ["confirm", 2], ["start", 3], ["intake", 2], ["answer", 3], ["stop", 2]] as const) {
  test(`B1b exit ${code} ${operation} ${output} records refusal despite unchanged engine state`, async t => {
    const f = await fixture(t);
    let id: string | null = null, body: Record<string, unknown> = { description };
    if (operation !== "intake") {
      id = await f.intake();
      let s = operation === "confirm" ? await f.get(id) : await f.confirm(id);
      const approval = { step: "plan" as const, inputVersion: 1, head: "a".repeat(40), reportSha256: "b".repeat(64) };
      const question = { questionId: "question:refusal", inputVersion: 1, reportSha256: "c".repeat(64), owner: true, changesInput: false };
      if (operation === "approve" || operation === "answer") {
        await f.edit(s.request.runLink!.loopRunId, { state: "waiting", approval, question }); s = await f.get(id);
      }
      body = { expectedVersion: 1, expectedRevision: s.engine.revision };
      if (operation === "approve") Object.assign(body, approval);
      if (operation === "answer") Object.assign(body, { questionId: question.questionId, inputVersion: 1, questionReportSha256: question.reportSha256, text: "Keep this scope." });
      if (operation === "start") body.runLinkId = s.request.runLink!.runLinkId;
      if (operation === "stop") {
        assert.equal((await f.post(`${encodeURIComponent(id)}/start`, { expectedVersion: s.request.currentVersion,
          expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId })).status, 202);
        body = { runLinkId: s.request.runLink!.runLinkId };
      }
      if (operation === "confirm") Object.assign(body, { requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 });
    }
    await writeFile(join(f.root, "refusal.json"), JSON.stringify({ op: operation === "confirm" ? "confirm-request" : operation, code, output }));
    const key = `b1b-exit-refusal-${operation}-${code}`;
    const result = await f.bridge.mutate(f.identity, f.project.projectId, id, operation, body, key);
    assert.equal(result.state, "refused", "definite process refusal is recorded as refused");
    assert.equal(result.error, code === 2 ? "REFUSED" : "INELIGIBLE");
    const replay = await f.bridge.mutate(f.identity, f.project.projectId, id, operation, body, key);
    assert.deepEqual(replay, { ...result, replayed: true });
    assert.equal((await f.traces()).filter(trace => trace.op === (operation === "confirm" ? "confirm-request" : operation)).length, 1);
    assert.deepEqual(await readdir(f.configuration.workRoot), [], "refused result releases command files too");
  });
}

test("B1b command files remain until result append and are reclaimed after reconciliation", async t => {
  const f = await fixture(t);
  let failResult = true, beforeAppend = false;
  const traced = (tx: import('../src/persistence/database').DatabaseSession) => ({ query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.startsWith('INSERT INTO control_loop_improvement_commands') && params?.[2] === 'result') {
      beforeAppend = true;
      const directories = await readdir(f.configuration.workRoot);
      assert.equal(directories.length, 1, "uncommitted result retains command directory");
      assert.equal(await readFile(join(f.configuration.workRoot, directories[0]!, "source.txt"), "utf8"), description);
      if (failResult) { failResult = false; throw new Error("SYNTHETIC result append failure"); }
    }
    return tx.query<T>(sql, params);
  } });
  const db: import('../src/persistence/database').DatabaseClient = { query: f.client.query,
    transaction: callback => f.client.transaction(tx => callback(traced(tx))),
    transactionWithPreCommitCheck: (callback, check) => f.client.transactionWithPreCommitCheck(tx => callback(traced(tx)), check) };
  const bridge = new ImproveControlRoomLoopServiceV1(db, { tenantId: 'tenant:web', workspaceId: 'workspace:web' }, { integrityKey: KEY, adapter: f.adapter }, () => now);
  const key = "b1b-cleanup-reconcile-0001";
  const lost = await bridge.mutate(f.identity, f.project.projectId, null, 'intake', { description }, key);
  assert.equal(beforeAppend, true); assert.equal(lost.state, 'uncertain');
  assert.equal((await readdir(f.configuration.workRoot)).length, 1, "unresolved command files are retained");
  const result = await bridge.mutate(f.identity, f.project.projectId, null, 'intake', { description }, key);
  assert.equal(result.state, 'accepted'); assert.equal(result.replayed, true);
  assert.deepEqual(await readdir(f.configuration.workRoot), [], "committed result releases only its command directory");
  assert.equal((await f.traces()).filter(trace => trace.op === 'intake').length, 1);
});

test("B1b cleanup refuses a command still in use and preserves unrelated directories", async t => {
  const f = await fixture(t), id = await f.intake(), s = await f.confirm(id);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.setBeforeAdmission(async () => { entered(); await gate; });
  const pending = f.bridge.mutate(f.identity, f.project.projectId, id, 'start',
    { expectedVersion: 1, expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId }, 'b1b-cleanup-active-0001');
  try {
    await waiting;
    const row = (await f.db.query<{ command_id: string }>("SELECT command_id FROM control_loop_improvement_commands WHERE operation='start' AND entry_kind='claim'")).rows[0]!;
    const directory = join(f.configuration.workRoot, row.command_id.replace(':', '-'));
    const unrelated = join(f.configuration.workRoot, `loop-command-${'f'.repeat(32)}`);
    await mkdir(directory, { mode: 0o700 }); await writeFile(join(directory, 'in-use.txt'), 'retain');
    await mkdir(unrelated, { mode: 0o700 }); await writeFile(join(unrelated, 'source.txt'), 'unresolved other command');
    await assert.rejects(f.raw.releaseCommandFiles!(row.command_id), /unavailable/, "active command cannot be reclaimed");
    assert.equal(await readFile(join(directory, 'in-use.txt'), 'utf8'), 'retain');
    release(); assert.equal((await pending).state, 'accepted');
    await assert.rejects(readFile(join(directory, 'in-use.txt')), { code: 'ENOENT' });
    assert.equal(await readFile(join(unrelated, 'source.txt'), 'utf8'), 'unresolved other command');
  } finally { release(); await pending; }
});


test("B1b cleanup failure keeps the committed receipt unchanged when rm throws", async t => {
  const f = await fixture(t);
  const originalRm = fsPromises.rm;
  let failures = 0;
  const mocked = t.mock.method(fsPromises, 'rm', async (path: Parameters<typeof rm>[0], options: Parameters<typeof rm>[1]) => {
    if (String(path).startsWith(join(f.configuration.workRoot, 'loop-command-'))) {
      failures++; throw new Error('SYNTHETIC rm failure');
    }
    return originalRm(path, options);
  });
  syncBuiltinESMExports();
  try {
    const key = 'b1b-cleanup-throw-0001';
    const receipt = await f.bridge.mutate(f.identity, f.project.projectId, null, 'intake', { description }, key);
    assert.ok(failures > 0, 'rm actually threw during command cleanup');
    assert.equal(receipt.state, 'accepted', 'cleanup failure preserves committed receipt');
    assert.equal(receipt.error, null);
    assert.equal((await readdir(f.configuration.workRoot)).length, 1);
    const replay = await f.bridge.mutate(f.identity, f.project.projectId, null, 'intake', { description }, key);
    assert.deepEqual(replay, { ...receipt, replayed: true }, 'cleanup failure preserves replayed receipt');
    mocked.mock.restore(); syncBuiltinESMExports();
    assert.deepEqual(await f.bridge.mutate(f.identity, f.project.projectId, null, 'intake', { description }, key), replay);
    assert.deepEqual(await readdir(f.configuration.workRoot), []);
    assert.equal((await f.traces()).filter(trace => trace.op === 'intake').length, 1);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test("B1b first-use sweep removes only durable finished command directories", async t => {
  const f = await fixture(t);
  const crashed = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
  const receipt = await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-finished-0001');
  assert.equal(receipt.state, 'accepted');
  const failed = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {}, intake: async (...args) => {
      await f.adapter.intake(...args); throw new Error('SYNTHETIC crash before result');
    } } }, () => now);
  const pending = await failed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-pending-0001');
  assert.equal(pending.state, 'uncertain');
  const pendingDirectory = join(f.configuration.workRoot, pending.commandId.replace(':', '-'));
  const finished = join(f.configuration.workRoot, receipt.commandId.replace(':', '-'));
  const unresolved = join(f.configuration.workRoot, `loop-command-${'e'.repeat(32)}`);
  const unrelated = join(f.configuration.workRoot, 'unrelated');
  await mkdir(unresolved); await writeFile(join(unresolved, 'source.txt'), 'unresolved');
  await mkdir(unrelated); await writeFile(join(unrelated, 'source.txt'), 'unrelated');
  // A new service's first mutation uses a new key and root, not an exact replay.
  const restarted = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: f.adapter }, () => now);
  assert.equal((await restarted.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-trigger-0001')).state, 'accepted');
  await assert.rejects(readFile(join(finished, 'source.txt')), { code: 'ENOENT' }, 'first-use sweep reclaims durable finished command');
  assert.equal(await readFile(join(unresolved, 'source.txt'), 'utf8'), 'unresolved');
  assert.equal(await readFile(join(pendingDirectory, 'source.txt'), 'utf8'), description, 'signed claim without result is never swept');
  assert.equal(await readFile(join(unrelated, 'source.txt'), 'utf8'), 'unrelated');
});

test("B1b first-use sweep skips stale and invalid rows and finishes once", async t => {
  const f = await fixture(t);
  const retained: Awaited<ReturnType<ImproveControlRoomLoopServiceV1['mutate']>>[] = [];
  for (let index = 0; index < 3; index++) {
    const crashed = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
      { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
    const receipt = await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, `b1b-sweep-retain-${index}`);
    assert.equal(receipt.state, 'accepted'); retained.push(receipt);
  }
  const crashed = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
  const finished = await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, 'b1b-sweep-valid-0001');
  const diagnostic = t.mock.method(console, 'warn', () => {});
  let sweeps = 0;
  const trace = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    const result = await tx.query<T>(sql, params);
    if (sql.includes('SELECT c.* FROM control_loop_improvement_commands')) {
      sweeps++;
      // Present the stale signed row first, then an invalid claim, then an invalid result.
      const order = [...retained, finished].map(row => row.commandId);
      result.rows.sort((a, b) => order.indexOf((a as { command_id: string }).command_id) - order.indexOf((b as { command_id: string }).command_id));
      result.rows = result.rows.map(row => {
        const raw = row as Record<string, unknown>;
        if (raw.command_id !== retained[0]!.commandId) return row;
        // Simulate a correctly signed claim from a previous configured schema.
        const { record_digest: _digest, auth_tag: _tag, ...historical } = raw;
        const material = { ...historical,
          binding: { ...raw.binding as LoopBridgeBindingV1, schemaDigest: `sha256:${'d'.repeat(64)}` },
          created_at: new Date(raw.created_at as string).toISOString() };
        return { ...material, record_digest: sha256Digest(material),
          auth_tag: hmacSha256Tag(KEY, { purpose: 'loop-improvement-command/v1', record: material }) } as T;
      });
      result.rows = result.rows.map(row => (row as { command_id: string }).command_id === retained[1]!.commandId
        ? { ...row, record_digest: `sha256:${'f'.repeat(64)}` } : row);
    }
    if (sql.includes("entry_kind='result'") && params?.[1] === retained[2]!.commandId)
      result.rows = result.rows.map(row => ({ ...row, auth_tag: `hmac-sha256:${'f'.repeat(64)}` }));
    return result;
  } });
  const client: DatabaseClient = { query: (sql, params) => f.client.query(sql, params),
    transaction: work => f.client.transaction(tx => work(trace(tx))),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(trace(tx)), check) };
  const restarted = new ImproveControlRoomLoopServiceV1(client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: f.adapter }, () => now);
  const before = (await f.db.query<Record<string, unknown>>('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows;
  for (let i = 0; i < 2; i++) assert.equal((await restarted.mutate(f.identity, f.project.projectId, null, 'intake',
    { description }, `b1b-sweep-once-${i}`)).state, 'accepted');
  await assert.rejects(readFile(join(f.configuration.workRoot, finished.commandId.replace(':', '-'), 'source.txt')),
    { code: 'ENOENT' }, 'sweep continues past stale and invalid rows to clean the verified finished command');
  assert.equal(sweeps, 1, 'finished-claims SELECT runs once despite stale and invalid rows');
  assert.deepEqual(diagnostic.mock.calls.map(call => call.arguments), Array.from({ length: 3 },
    () => ['loop_command_sweep_verification_failed']), 'one fixed diagnostic per skipped row, without row data');
  for (const receipt of retained) assert.equal(await readFile(join(f.configuration.workRoot, receipt.commandId.replace(':', '-'), 'source.txt'), 'utf8'), description);
  const after = (await f.db.query<Record<string, unknown>>('SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind')).rows;
  assert.deepEqual(after.filter(row => before.some(prior => prior.command_id === row.command_id)), before, 'sweep never rewrites retained signed bytes');
});

test("B1b slow restart sweep stays outside the Start freshness window", async t => {
  const f = await fixture(t), scope = { tenantId: 'tenant:web', workspaceId: 'workspace:web' };
  // A previous process committed finished intakes but crashed before removing their folders.
  const crashed = new ImproveControlRoomLoopServiceV1(f.client, scope,
    { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
  const retained = [];
  for (let i = 0; i < 2; i++) retained.push(await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, `b1b-slow-sweep-retain-${i}`));
  const id = await f.intake(), s = await f.confirm(id);
  // Real advancing clock anchored at the fixture instant; each release is slow.
  const started = Date.now(), clock = () => now + (Date.now() - started);
  let releases = 0;
  const restarted = new ImproveControlRoomLoopServiceV1(f.client, scope, { integrityKey: KEY, admissionFreshnessMs: 2000,
    adapter: { ...f.adapter, releaseCommandFiles: async commandId => { releases++; await delay(800); return f.adapter.releaseCommandFiles!(commandId); } } }, clock);
  const body = { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId };
  const result = await restarted.mutate(f.identity, f.project.projectId, id, 'start', body, 'b1b-slow-sweep-start-0001');
  assert.equal((await f.traces()).filter(e => e.op === 'start').length, 1, 'Start dispatches exactly once despite a slow sweep');
  assert.equal(result.state, 'accepted'); assert.equal(result.replayed, false);
  assert.ok(releases >= 3, 'the slow sweep still ran after dispatch');
  for (const receipt of retained) await assert.rejects(readFile(join(f.configuration.workRoot, receipt.commandId.replace(':', '-'), 'source.txt')), { code: 'ENOENT' });
  assert.deepEqual(await restarted.mutate(f.identity, f.project.projectId, id, 'start', body, 'b1b-slow-sweep-start-0001'), { ...result, replayed: true });
  assert.equal((await f.traces()).filter(e => e.op === 'start').length, 1);
});

test("B1b restart sweep releases one bounded page per call and resumes", async t => {
  const f = await fixture(t), scope = { tenantId: 'tenant:web', workspaceId: 'workspace:web' };
  const crashed = new ImproveControlRoomLoopServiceV1(f.client, scope,
    { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
  const retained = new Set<string>();
  for (let i = 0; i < 17; i++) retained.add((await crashed.mutate(f.identity, f.project.projectId, null, 'intake', { description }, `b1b-sweep-page-${i}`)).commandId);
  const released: string[] = [];
  let sweeps = 0, calls = 0;
  const trace = (tx: DatabaseSession): DatabaseSession => ({ query: async <T>(sql: string, params?: unknown[]) => {
    if (sql.includes('SELECT c.* FROM control_loop_improvement_commands')) sweeps++;
    return tx.query<T>(sql, params);
  } });
  const client: DatabaseClient = { query: (sql, params) => f.client.query(sql, params),
    transaction: work => f.client.transaction(tx => work(trace(tx))),
    transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(trace(tx)), check) };
  const restarted = new ImproveControlRoomLoopServiceV1(client, scope, { integrityKey: KEY,
    adapter: { ...f.adapter, releaseCommandFiles: async commandId => { calls++; if (retained.has(commandId)) released.push(commandId); return f.adapter.releaseCommandFiles!(commandId); } } }, () => now);
  const trigger = async (i: number) => assert.equal((await restarted.mutate(f.identity, f.project.projectId, null, 'intake', { description }, `b1b-sweep-page-trigger-${i}`)).state, 'accepted');
  // Each trigger releases its own folder once; the first sweep page holds 16 of the 18 finished intakes.
  await trigger(0);
  assert.equal(calls, 1 + 16, 'sweep releases at most one bounded page per call');
  assert.ok(released.length < retained.size);
  await trigger(1);
  assert.equal(released.length, retained.size);
  assert.deepEqual(new Set(released), retained, 'the next call resumes after the previous page');
  const resumed = calls;
  await trigger(2);
  assert.equal(calls, resumed + 1); assert.equal(sweeps, 2, 'an exhausted sweep is not repeated');
  assert.deepEqual(await readdir(f.configuration.workRoot), []);
});

test("B1b split loop and legacy pipeline integrity keys refuse both web compositions", async t => {
  const engine = await synthetic(t), other = new Uint8Array(32).fill(65);
  // Construction never queries; any database use here is a test failure.
  const client: DatabaseClient = { query: async () => assert.fail("unexpected query"), transaction: async () => assert.fail("unexpected transaction"),
    transactionWithPreCommitCheck: async () => assert.fail("unexpected transaction") };
  const hosted = (workBatchKey: Uint8Array) => createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, clock: () => now, database: { client, close: async () => {} },
    loopBridge: { integrityKey: KEY, adapter: engine.adapter }, workBatches: { integrityKey: workBatchKey } });
  assert.throws(() => hosted(other), /invalid_private_app_config/, 'hosted composition refuses a split loop key');
  await hosted(Uint8Array.from(KEY)).close();
  const localOrigin = "http://127.0.0.1:32124";
  const mac = (workBatchIntegrityKey: Uint8Array) => createMacLocalWebProcessV1({ origin: localOrigin, workspaceId: "workspace:web", clock: () => now,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: localOrigin, tenantId: "tenant:web", provider: trust.issuer, subject: "test-owner",
      ownerCodeDigest: sha256Digest({ ownerCode: "synthetic-local-owner-code-long" }), sessionSeconds: 900 },
    database: { client, isAvailable: () => true, close: async () => {} }, loopBridge: { integrityKey: KEY, adapter: engine.adapter }, workBatchIntegrityKey });
  assert.throws(() => mac(other), /mac_local_web_process_config_invalid/, 'Mac composition refuses a split loop key');
  await mac(Uint8Array.from(KEY)).close();
});

test("B1b startup capture refuses a split loop and pipelines integrity key", async t => {
  const engine = await synthetic(t), other = new Uint8Array(32).fill(65);
  const composition = await privateAgentTaskCompositionFixture(); t.after(composition.close);
  const scenario = composition.scenario();
  const startup = (pipelineKey: Uint8Array) => validatePrivateTaskStartupConfiguration({ ...scenario.configuration,
    loopBridge: { integrityKey: KEY, adapter: engine.configuration },
    coordinator: { ...scenario.configuration.coordinator, pipelines: { integrityKey: pipelineKey, selectionAuthority: { assertCurrent: () => true } } } } as never);
  assert.throws(() => startup(other), /private_task_startup_config_invalid/, 'startup refuses a split loop key');
  const captured = startup(Uint8Array.from(KEY)); t.after(() => captured.loopBridge!.adapter.close());
  assert.deepEqual(captured.loopBridge!.integrityKey, KEY);
});

test("B1b cleanup rechecks configured pins and uid before removing files", async t => {
  const f = await fixture(t);
  const commandId = `loop-command:${'d'.repeat(32)}`, directory = join(f.configuration.workRoot, commandId.replace(':', '-'));
  await mkdir(directory); await writeFile(join(directory, 'source.txt'), 'retain');
  await writeFile(f.configuration.entrypoint, executable + '\n# changed pin\n');
  await assert.rejects(f.raw.releaseCommandFiles!(commandId), /unavailable/, 'cleanup refuses stale executable pin');
  assert.equal(await readFile(join(directory, 'source.txt'), 'utf8'), 'retain');
  await writeFile(f.configuration.entrypoint, executable);
  const uid = process.getuid!();
  const mocked = t.mock.method(process as NodeJS.Process & { getuid(): number }, 'getuid', () => uid + 1);
  try {
    await assert.rejects(f.raw.releaseCommandFiles!(commandId), /unavailable/, 'cleanup refuses changed uid');
    assert.equal(await readFile(join(directory, 'source.txt'), 'utf8'), 'retain');
  } finally { mocked.mock.restore(); }
  await f.raw.releaseCommandFiles!(commandId);
  await assert.rejects(readFile(join(directory, 'source.txt')), { code: 'ENOENT' });
});

test("B2b approval document isolation", async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const directory=join(f.configuration.runRoot,run);await mkdir(directory);
  const path=`${f.base}/${encodeURIComponent(id)}/approval-document`;
  const put=async(bytes:string|Buffer,sidecarChange:Record<string,unknown>={})=>{
    const approval={step:"plan" as const,inputVersion:1,head:"a".repeat(40),reportSha256:loopByteHashV1(bytes)};
    await writeFile(join(directory,"report.md"),bytes);await writeFile(join(directory,"report.json"),JSON.stringify({...approval,...sidecarChange}));
    await f.edit(run,{state:"waiting",approval});return approval;
  };
  const journal=async()=>JSON.stringify((await f.db.query("SELECT * FROM control_loop_improvement_commands ORDER BY command_id,entry_kind")).rows);
  const before=await journal();
  for(const text of ["Complete report.\r\n".repeat(5000),"\u0001".repeat(262144)]){
    await put(text);const response=await f.handler(request(path));assert.equal(response.status,200);
    const serialized=await response.text();assert.ok(Buffer.byteLength(serialized)<=1600000);
    assert.equal(JSON.parse(serialized).text,text);assert.ok(Buffer.byteLength(text)>65536);
    assert.equal((await f.get(id)).engine.approval?.reportSha256,loopByteHashV1(text));
  }
  assert.equal(await journal(),before,"document GET creates no claim/result");
  const known="Known original complete sealed document.";
  const seal=await put(known);
  await writeFile(join(directory,"report.md"),"Known changed complete sealed document.");
  const changed=await f.handler(request(path));
  const changedBody=await changed.text();
  assert.ok(!changedBody.includes("Known changed complete sealed document."),"B2b changed complete text is refused before approval");
  assert.equal(changed.status,503);
  await put("x".repeat(262145));assert.equal((await f.handler(request(path))).status,503);
  await put(Buffer.from([0xff,0xfe]));assert.equal((await f.handler(request(path))).status,503);
  await put(known,{head:"b".repeat(40)});assert.equal((await f.handler(request(path))).status,503);
  await put(known);await writeFile(join(directory,"report.json"),"x".repeat(65537));assert.equal((await f.handler(request(path))).status,503);
  await put(known);await rm(join(directory,"report.md"));await symlink(join(f.root,"settings.json"),join(directory,"report.md"));
  assert.equal((await f.handler(request(path))).status,503);await rm(join(directory,"report.md"));await put(known);
  for(const report of ["../settings.json","/absolute/report.md","../other-run/report.md",".codex/auth.json"]){
    f.setDocumentNames({report,sidecar:"report.json"});assert.equal((await f.handler(request(path))).status,503);
  }
  f.setDocumentNames({report:"report.md",sidecar:"report.json"});
  const reads=(await f.traces()).length;
  assert.equal((await f.handler(request(path,"GET",undefined,undefined,token({exp:now/1000-1})))).status,401);
  assert.equal((await f.handler(request(path.replace(encodeURIComponent(f.project.projectId),"project:foreign")))).status,404);
  const wrongOrigin=request(path);wrongOrigin.headers.set("sec-fetch-site","cross-site");assert.equal((await f.handler(wrongOrigin)).status,403);
  assert.equal((await f.handler(request(path+"?file=report.md"))).status,400);
  assert.equal((await f.handler(request(path.replace("approval-document","unknown-document")))).status,404);
  const hasBody=request(path);Object.defineProperty(hasBody,"body",{value:new ReadableStream()});assert.equal((await f.handler(hasBody)).status,400);
  assert.equal((await f.traces()).length,reads,"invalid authority/routes perform no adapter access");
  await f.db.query("UPDATE control_role_grants SET revoked_at='2026-09-04T12:00:00Z'");
  assert.equal((await f.handler(request(path))).status,403);
  await f.db.query("UPDATE control_role_grants SET revoked_at=NULL");
  const unauthorizedReads=(await f.traces()).length;
  for(const foreignScope of [{tenantId:"tenant:foreign",workspaceId:"workspace:web"},{tenantId:"tenant:web",workspaceId:"workspace:foreign"}]){
    const foreignBridge=new ImproveControlRoomLoopServiceV1(f.client,foreignScope,{integrityKey:KEY,adapter:f.adapter},()=>now);
    const foreignHandler=createImproveControlRoomHttpHandlerV1({origin,trust,loopBridge:foreignBridge,clock:()=>now});
    assert.equal((await foreignHandler(request(path))).status,foreignScope.tenantId==="tenant:foreign"?403:404);
  }
  await f.db.query(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,created_at,updated_at)
    VALUES('identity:b2b-other','tenant:web','human','Other fixture owner','test',$1,'active',$2,$2)`,[sha256Digest({provider:"test",subject:"b2b-other-fixture"}),new Date(now).toISOString()]);
  const foreignRoot={tenant_id:"tenant:web",id:"request:b2b-foreign",project_id:f.project.projectId,owner_identity_id:"identity:b2b-other",idempotency_key:"b2b-foreign-document-0001",created_at:new Date(now).toISOString()};
  await f.db.query(`INSERT INTO control_loop_improvement_requests(tenant_id,id,project_id,owner_identity_id,idempotency_key,created_at,record_digest,auth_tag) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [...Object.values(foreignRoot),sha256Digest(foreignRoot),hmacSha256Tag(KEY,{purpose:"loop-improvement-request/v1",record:foreignRoot})]);
  assert.equal((await f.handler(request(`${f.base}/${encodeURIComponent(foreignRoot.id)}/approval-document`))).status,404);
  const foreignLinkSession=(tx:DatabaseSession):DatabaseSession=>({query:async<T>(sql:string,params?:unknown[])=>{
    const result=await tx.query<T>(sql,params);
    if(sql.includes("FROM control_loop_improvement_run_links"))result.rows=result.rows.map(row=>({...row,id:"loop-link:foreign"}));
    return result;
  }});
  const foreignLinkDb:DatabaseClient={query:f.client.query,
    transaction:work=>f.client.transaction(tx=>work(foreignLinkSession(tx))),
    transactionWithPreCommitCheck:(work,check)=>f.client.transactionWithPreCommitCheck(tx=>work(foreignLinkSession(tx)),check)};
  const foreignLinkBridge=new ImproveControlRoomLoopServiceV1(foreignLinkDb,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter:f.adapter},()=>now);
  const foreignLinkHandler=createImproveControlRoomHttpHandlerV1({origin,trust,loopBridge:foreignLinkBridge,clock:()=>now});
  assert.equal((await foreignLinkHandler(request(path))).status,503,"unverified foreign link is refused before external access");
  assert.equal((await f.traces()).length,unauthorizedReads,"foreign tenant/creator/link read no status or document");
  const rotating={...f.adapter,readApprovalDocument:async(r:string,a:typeof seal)=>{
    const text=await f.adapter.readApprovalDocument!(r,a);await f.edit(run,{revision:s.engine.revision+1});return text;
  }};
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter:rotating},()=>now);
  const handler=createImproveControlRoomHttpHandlerV1({origin,trust,loopBridge:bridge,clock:()=>now});
  assert.equal((await handler(request(path))).status,409,"changed gate/revision drops complete document");
  assert.equal(await journal(),before);console.log("B2b document complete=262144 escaped_budget=1600000 invalid_utf8/hash/seal/path/race=refused writes=0");
});

test("P71 intake preserves explicit run settings in the signed copy", async t => {
  const f = await fixture(t);
  const response = await f.post("intake", { description, settingsEdits: '{"fixture":"RUN"}' });
  if (response.status !== 202) await f.bridge.mutate(f.identity, f.project.projectId, null, "intake",
    { description, settingsEdits: '{"fixture":"RUN"}' }, "p71-diagnostic-intake-0001");
  assert.equal(response.status, 202, "P71 accepts closed intake settingsEdits");
  const receipt = await response.json() as { requestId: string; state: string };
  assert.equal(receipt.state, "accepted");
  const input = (await f.db.query<{ settings_text: string }>("SELECT settings_text FROM control_loop_improvement_inputs WHERE request_id=$1", [receipt.requestId])).rows[0]!;
  assert.equal(input.settings_text, '{"fixture":"RUN","project":{"host_adapter":"local-loop"}}\n');
  const s = await f.confirm(receipt.requestId);
  assert.equal(s.engine.settingsSha256, loopByteHashV1(input.settings_text));
});

test("P71 adapter rejects wrong signed text before every non-stop operation", async t => {
  const f = await fixture(t);
  const run=f.adapter.reserveRun();
  const binding:LoopBridgeBindingV1={schemaVersion:1,body:{description},localVersion:1,adapterId:f.adapter.adapterId,
    loopRunId:run,toolingRevision:f.adapter.toolingRevision,a2SchemaVersion:1,schemaDigest:f.adapter.schemaDigest,
    requestSha256:loopByteHashV1(description),settingsSha256:loopByteHashV1(settingsText),runLinkId:null,authorizationId:null,
    inputVersion:null,expectedRevision:null,evidence:null};
  // The independently known hash is the defaults hash. The supplied text is wrong.
  // A fresh intake binding and empty observation cache remove other refusal guards.
  await assert.rejects(()=>f.raw.intake(`loop-command:${randomBytes(16).toString('hex')}`,binding,description,()=>{},'{}'),
    /unavailable/,'P71 independent signed-text hash guard');
  const id=await f.intake(),s=await f.confirm(id),current=await f.raw.status(s.request.runLink!.loopRunId);
  const b={...binding,loopRunId:current.run.loopRunId,runLinkId:s.request.runLink!.runLinkId,
    inputVersion:current.inputVersion,expectedRevision:current.revision,body:{runLinkId:s.request.runLink!.runLinkId}};
  for (const operation of ['confirm', 'start', 'approve', 'answer'] as const) {
    const command = `loop-command:${randomBytes(16).toString('hex')}`;
    const before = (await f.traces()).length;
    const call = operation === 'answer' ? () => f.raw.answer(command, b, 'answer', () => {}, '{}')
      : operation === 'confirm' ? () => f.raw.confirmRequest(command, b, () => {}, '{}')
      : () => f.raw[operation](command, b, () => {}, '{}');
    await assert.rejects(call, /unavailable/, `P71 ${operation} signed-text hash guard`);
    assert.equal((await f.traces()).length, before, `P71 ${operation} never spawns with wrong text`);
  }
});

test('P71 A and B signed copies survive layers, normalized confirmation and restart with distinct settings paths',async t=>{
  const f=await fixture(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  const policy=new LoopPolicyServiceV1(f.client,scope,f.adapter,()=>now);
  await policy.put(f.identity,f.project.projectId,'project',{expectedVersion:0,settings:'{"fixture":"A"}'},'p71-bridge-layer-a-0001');
  const a=await f.intake(),aState=await f.get(a),aRun=aState.request.runLink!.loopRunId;
  const history=(await f.db.query('SELECT * FROM control_loop_improvement_inputs WHERE request_id=$1',[a])).rows;
  await policy.put(f.identity,f.project.projectId,'selection',{expectedVersion:0,settings:'{"fixture":"B"}'},'p71-bridge-layer-b-0001');
  const b=await f.intake(),bState=await f.get(b);
  assert.notEqual(aState.engine.settingsSha256,bState.engine.settingsSha256);
  await f.edit(aRun,{description:'Engine normalized saved A.',inputVersion:2,revision:2});
  const confirmed=await f.confirm(a);assert.equal(confirmed.request.currentVersion,2);
  const restarted=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:KEY,adapter:f.adapter,policy},()=>now);
  const start=await restarted.mutate(f.identity,f.project.projectId,a,'start',{expectedVersion:2,expectedRevision:confirmed.engine.revision,
    runLinkId:confirmed.request.runLink!.runLinkId},'p71-bridge-restart-start-0001');assert.equal(start.state,'accepted');
  assert.deepEqual((await f.db.query('SELECT * FROM control_loop_improvement_inputs WHERE request_id=$1 AND version=1',[a])).rows,history);
  const inputs=(await f.db.query<{settings_text:string}>('SELECT settings_text FROM control_loop_improvement_inputs WHERE request_id=$1 ORDER BY version',[a])).rows;
  assert.deepEqual(inputs.map(i=>i.settings_text),['{"fixture":"A","project":{"host_adapter":"local-loop"}}\n','{"fixture":"A","project":{"host_adapter":"local-loop"}}\n']);
  const sources=(await f.db.query<{defaults_sha256:string;layer_versions:{project:number;selection:number};waiver_id:null}>('SELECT defaults_sha256,layer_versions,waiver_id FROM control_loop_policy_input_sources WHERE request_id=$1 ORDER BY input_version',[a])).rows;
  assert.equal(sources.length,2);assert.deepEqual(sources[0],sources[1]);assert.deepEqual(sources[0]!.layer_versions,{project:1,selection:0});
  const traces=(await f.traces()).filter(trace=>trace.run===aRun),intake=traces.find(trace=>trace.op==='intake')!,started=traces.find(trace=>trace.op==='start')!;
  const settingsPath=(trace:typeof intake)=>trace.args[trace.args.indexOf('--settings')+1];
  assert.notEqual(settingsPath(intake),settingsPath(started));assert.equal(intake.settingsText,inputs[0]!.settings_text);assert.equal(started.settingsText,intake.settingsText);
  assert.deepEqual(await readdir(f.configuration.workRoot),[]);
});

test('P71 altered per-command settings copy fails EEXIST before engine execution',async t=>{
  const f=await fixture(t),run=f.adapter.reserveRun(),command=`loop-command:${randomBytes(16).toString('hex')}`;
  const binding:LoopBridgeBindingV1={schemaVersion:1,body:{description},localVersion:1,adapterId:f.adapter.adapterId,loopRunId:run,
    toolingRevision:f.adapter.toolingRevision,a2SchemaVersion:1,schemaDigest:f.adapter.schemaDigest,requestSha256:loopByteHashV1(description),
    settingsSha256:loopByteHashV1(settingsText),runLinkId:null,authorizationId:null,inputVersion:null,expectedRevision:null,evidence:null};
  const directory=join(f.configuration.workRoot,command.replace(':','-'));await mkdir(directory,{mode:0o700});
  await writeFile(join(directory,'settings.json'),'{}',{mode:0o600});
  await assert.rejects(()=>f.raw.intake(command,binding,description,()=>{},settingsText),/unavailable/);
  await assert.rejects(readFile(join(f.root,'trace.jsonl')),{code:'ENOENT'},'EEXIST compares saved bytes before any execute');
});

test('P71 intake refusal, unavailable check and binding overflow retain no draft/source/claim',async t=>{
  const f=await fixture(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  for(const [expected,checker] of [[422,async()=>({eligible:false,reasons:[{code:'SYNTHETIC_REFUSAL',explanation:'Unavailable model'}]})],[503,async()=>{throw new Error('unavailable');}]] as const){
    const adapter={...f.adapter,checkSettings:checker},bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:KEY,adapter},()=>now);
    const http=createImproveControlRoomHttpHandlerV1({origin,trust,loopBridge:bridge,clock:()=>now});
    const response=await http(request(f.base+'/intake','POST',{description},`p71-check-refusal-${randomBytes(8).toString('hex')}`));
    assert.equal(response.status,expected);
    for(const table of ['control_loop_improvement_requests','control_loop_policy_input_sources','control_loop_improvement_commands'])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0);
  }
  // Composed settings fit 64 KiB, but serializing the edit text again inside a signed binding does not.
  const edits=JSON.stringify({x:'"'.repeat(18000)});
  await assert.rejects(f.bridge.mutate(f.identity,f.project.projectId,null,'intake',{description,settingsEdits:edits},'p71-binding-overflow-0001'),{code:'invalid_request'});
  for(const table of ['control_loop_improvement_requests','control_loop_policy_input_sources','control_loop_improvement_commands'])assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0);
});

test('P71 direct recovery checks non-default saved hash and inspect/status/claim order, with an atomic capability fence',async t=>{
  const f=await syntheticRecoveryEngine(t),signed='{"project":{"host_adapter":"local-loop"},"fixture":"NON_DEFAULT"}',run=f.raw.reserveRun();
  const binding:LoopBridgeBindingV1={schemaVersion:1,body:{description},localVersion:1,adapterId:f.raw.adapterId,loopRunId:run,
    toolingRevision:f.raw.toolingRevision,a2SchemaVersion:1,schemaDigest:f.raw.schemaDigest,requestSha256:loopByteHashV1(description),
    settingsSha256:loopByteHashV1(signed),runLinkId:null,authorizationId:null,inputVersion:null,expectedRevision:null,evidence:null};
  await f.raw.intake(`loop-command:${randomBytes(16).toString('hex')}`,binding,description,()=>{},signed);
  await f.edit(run,{state:'running',settingsDigest:'canonical-engine-digest'});
  const saved=await f.raw.status(run),events:string[]=[];
  const recoveryBinding:import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryBindingV1={schemaVersion:1,tenantId:'tenant:web',workspaceId:'workspace:web',
    projectId:'project:fixture',ownerIdentityId:'identity:web',requestId:'request:fixture',runLinkId:'link:fixture',localVersion:1,
    authorizationId:'authorization:fixture',startCommandId:`loop-command:${'a'.repeat(32)}`,startBindingDigest:sha256Digest('start'),run:saved.run,
    inputVersion:saved.inputVersion,requestSha256:binding.requestSha256,settingsSha256:binding.settingsSha256,settingsDigest:saved.settingsDigest,
    expectedRevision:saved.revision,schemaDigest:f.raw.schemaDigest,action:'wait'};
  let calls=0,drift=false;
  const capability={enabled:()=>true,inspect:async()=>{events.push('inspect');return{schemaVersion:1 as const,run:saved.run,revision:saved.revision,
    mode:'runnable' as const,action:'wait' as const,driver:{state:'ended' as const,generation:null,evidenceDigest:sha256Digest('ended')},receipt:null,evidenceDigest:sha256Digest('inspect')};},
    claimDriver:async(b:Readonly<typeof recoveryBinding>,spawn:()=>Promise<import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryChildV1>)=>{
      events.push('claimDriver');calls++;
      // Installation-owned admission re-reads and fences under its own lock, including drift AFTER status.
      if(drift)await f.edit(run,{settingsSha256:'f'.repeat(64)});
      const current=await f.raw.status(run);
      if(current.settingsSha256!==b.settingsSha256||current.revision!==b.expectedRevision||current.settingsDigest!==b.settingsDigest)
        return{kind:'uncertain' as const,evidenceDigest:sha256Digest('fence refused drift')};
      return{kind:'started' as const,generation:'a'.repeat(32),child:await spawn()};
    }};
  const configuration={...f.configuration,contract:{...f.configuration.contract,recovery:capability,decodeStatus:(value:unknown)=>{
    events.push('status');return f.configuration.contract.decodeStatus(value);
  }}};
  const adapter=createImproveControlRoomLoopAdapterV1(configuration);t.after(()=>adapter.close());
  const result=await adapter.recover!(recoveryBinding);assert.equal(result.kind,'started');
  assert.deepEqual(events.slice(0,3),['inspect','status','claimDriver']);
  if(result.kind==='started'){const done=result.child.done.catch(()=>{});await result.child.close();await done;}
  events.length=0;drift=true;
  const before=(await f.traces()).filter(trace=>trace.op==='wait').length;
  const refused=await adapter.recover!(recoveryBinding);assert.equal(refused.kind,'uncertain');
  assert.equal((await f.traces()).filter(trace=>trace.op==='wait').length,before,'capability drift fence spawns no recovery driver');
  assert.equal(calls,2);
  await f.edit(run,{settingsSha256:binding.settingsSha256});
  for(const patch of [{settingsSha256:'e'.repeat(64)},{settingsDigest:'wrong-digest'},{revision:saved.revision+1}]){
    await f.edit(run,{...saved,...patch});
    await assert.rejects(adapter.recover!(recoveryBinding),/unavailable/);
    assert.equal(calls,2,'status mismatch refuses before claimDriver');
    await f.edit(run,saved);
  }
  // Status parse failures/unavailable reads also clear the per-run acquisition.
  for(const decode of [()=>{throw new Error('failed status');},()=>({...saved,settingsSha256:undefined})]){
    const bad=createImproveControlRoomLoopAdapterV1({...configuration,contract:{...configuration.contract,decodeStatus:decode as unknown as typeof configuration.contract.decodeStatus}});t.after(()=>bad.close());
    for(let i=0;i<2;i++)await assert.rejects(bad.recover!(recoveryBinding),/unavailable/);
    assert.equal(calls,2,'failed status never claims and retry is not spuriously busy');
  }
});

test('P71 restart sweep removes all five finished operation directories and retains unfinished claims',async t=>{
  const f=await fixture(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'},retained={...f.adapter,releaseCommandFiles:undefined};
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:KEY,adapter:retained},()=>now);
  const intake=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'p71-sweep-intake-0001');assert.equal(intake.state,'accepted');
  const requestId=intake.requestId,finished=[intake];
  let s=await bridge.status(f.identity,f.project.projectId,requestId);
  finished.push(await bridge.mutate(f.identity,f.project.projectId,requestId,'confirm',{expectedVersion:1,expectedRevision:s.engine.revision,
    requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256},'p71-sweep-confirm-0001'));
  s=await bridge.status(f.identity,f.project.projectId,requestId);
  finished.push(await bridge.mutate(f.identity,f.project.projectId,requestId,'start',{expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId},'p71-sweep-start-0001'));
  const approval={step:'plan' as const,head:'a'.repeat(40),reportSha256:'b'.repeat(64),inputVersion:1};
  await f.edit(s.request.runLink!.loopRunId,{state:'waiting',approval});s=await bridge.status(f.identity,f.project.projectId,requestId);
  finished.push(await bridge.mutate(f.identity,f.project.projectId,requestId,'approve',{expectedVersion:1,expectedRevision:s.engine.revision,...approval},'p71-sweep-approve-0001'));
  const question={questionId:'question:p71-sweep',inputVersion:1,reportSha256:'c'.repeat(64),owner:true,changesInput:false};
  await f.edit(s.request.runLink!.loopRunId,{state:'waiting',question});s=await bridge.status(f.identity,f.project.projectId,requestId);
  finished.push(await bridge.mutate(f.identity,f.project.projectId,requestId,'answer',{expectedVersion:1,expectedRevision:s.engine.revision,
    questionId:question.questionId,inputVersion:1,questionReportSha256:question.reportSha256,text:'Keep the scope.'},'p71-sweep-answer-0001'));
  assert.ok(finished.every(receipt=>receipt.state==='accepted'));
  for(const receipt of finished)assert.equal((await readFile(join(f.configuration.workRoot,receipt.commandId.replace(':','-'),'expect.json'),'utf8')).length>0,true);
  const crashed=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:KEY,adapter:{...retained,
    intake:async(...args:Parameters<LoopAdapterV1['intake']>)=>{await f.adapter.intake(...args);throw new Error('SYNTHETIC crash before result');}}},()=>now);
  const unfinished=await crashed.mutate(f.identity,f.project.projectId,null,'intake',{description},'p71-sweep-unfinished-0001');assert.equal(unfinished.state,'uncertain');
  const restarted=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:KEY,adapter:f.adapter},()=>now);
  assert.equal((await restarted.mutate(f.identity,f.project.projectId,null,'intake',{description},'p71-sweep-restart-0001')).state,'accepted');
  for(const receipt of finished)await assert.rejects(readFile(join(f.configuration.workRoot,receipt.commandId.replace(':','-'),'expect.json')),{code:'ENOENT'});
  assert.equal(await readFile(join(f.configuration.workRoot,unfinished.commandId.replace(':','-'),'source.txt'),'utf8'),description);
  assert.deepEqual(await readdir(f.configuration.workRoot),[unfinished.commandId.replace(':','-')]);
});

test('P71 recovery status timeout and failed read release acquisition without claiming a driver',async t=>{
  const f=await syntheticRecoveryEngine(t),run=f.raw.reserveRun(),signed=f.raw.settingsText;
  const b:LoopBridgeBindingV1={schemaVersion:1,body:{description},localVersion:1,adapterId:f.raw.adapterId,loopRunId:run,
    toolingRevision:f.raw.toolingRevision,a2SchemaVersion:1,schemaDigest:f.raw.schemaDigest,requestSha256:loopByteHashV1(description),
    settingsSha256:loopByteHashV1(signed),runLinkId:null,authorizationId:null,inputVersion:null,expectedRevision:null,evidence:null};
  await f.raw.intake(`loop-command:${randomBytes(16).toString('hex')}`,b,description,()=>{},signed);
  await f.edit(run,{state:'running'});const saved=await f.raw.status(run);
  const recoveryBinding:import('../src/web/v1/improve-control-room-loop-adapter').LoopRecoveryBindingV1={schemaVersion:1,tenantId:'tenant:web',workspaceId:'workspace:web',
    projectId:'project:fixture',ownerIdentityId:'identity:web',requestId:'request:fixture',runLinkId:'link:fixture',localVersion:1,authorizationId:'authorization:fixture',
    startCommandId:`loop-command:${'a'.repeat(32)}`,startBindingDigest:sha256Digest('start'),run:saved.run,inputVersion:saved.inputVersion,
    requestSha256:b.requestSha256,settingsSha256:b.settingsSha256,settingsDigest:saved.settingsDigest,expectedRevision:saved.revision,schemaDigest:f.raw.schemaDigest,action:'wait'};
  const file=f.configuration.entrypoint,script=await readFile(file,'utf8');
  const updated=script.replace("op,run=sys.argv[1:3];args=sys.argv[3:];file=os.path.join(root,'runs',run+'.json')", "op,run=sys.argv[1:3];args=sys.argv[3:];file=os.path.join(root,'runs',run+'.json')\nif op=='status' and os.path.exists(os.path.join(root,'status-hang')): time.sleep(10)");
  assert.notEqual(updated,script,'the timeout probe is actually loaded');await writeFile(file,updated);
  let calls=0;
  const capability={enabled:()=>true,inspect:async()=>({schemaVersion:1 as const,run:saved.run,revision:saved.revision,mode:'runnable' as const,action:'wait' as const,
    driver:{state:'ended' as const,generation:null,evidenceDigest:sha256Digest('ended')},receipt:null,evidenceDigest:sha256Digest('inspect')}),
    claimDriver:async()=>{calls++;return{kind:'uncertain' as const,evidenceDigest:sha256Digest('no driver needed')};}};
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,entrypointSha256:loopByteHashV1(updated),timeoutMs:200,
    contract:{...f.configuration.contract,recovery:capability}});t.after(()=>adapter.close());
  await writeFile(join(f.root,'status-hang'),'SYNTHETIC');
  for(let i=0;i<2;i++)await assert.rejects(adapter.recover!(recoveryBinding),/unavailable/);
  assert.equal(calls,0,'timed out status never reaches claimDriver');await rm(join(f.root,'status-hang'));
  const runFile=join(f.root,'runs',run+'.json'),bytes=await readFile(runFile);await rm(runFile);
  await assert.rejects(adapter.recover!(recoveryBinding),/unavailable/);assert.equal(calls,0);
  await writeFile(runFile,bytes);assert.equal((await adapter.recover!(recoveryBinding)).kind,'uncertain');assert.equal(calls,1);
});

test('P71 intake rollback maps deadlock/serialization SQLSTATEs without repeating checks or retaining partial lineage',async t=>{
  const f=await fixture(t),scope={tenantId:'tenant:web',workspaceId:'workspace:web'};
  for(const sqlState of ['40P01','40001']){
    let checks=0,rollbacks=0;
    const wrap=(tx:DatabaseSession):DatabaseSession=>({query:(sql,params)=>{
      if(sql.startsWith('INSERT INTO control_loop_improvement_commands'))throw Object.assign(new Error('SYNTHETIC commit rollback'),{sqlState});
      return tx.query(sql,params);
    }});
    const database:DatabaseClient={query:f.client.query.bind(f.client),transaction:work=>f.client.transaction(tx=>work(wrap(tx))),
      transactionWithPreCommitCheck:async(work,check)=>{try{return await f.client.transactionWithPreCommitCheck(tx=>work(wrap(tx)),check);}catch(error){rollbacks++;throw error;}}};
    const bridge=new ImproveControlRoomLoopServiceV1(database,scope,{integrityKey:KEY,adapter:{...f.adapter,checkSettings:async()=>{checks++;return{eligible:true,reasons:[]};}}},()=>now);
    await assert.rejects(bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},`p71-loop-rollback-${sqlState}-0001`),{code:'conflict'});
    assert.equal(checks,1,'one external check, no automatic retry');assert.equal(rollbacks,1);
    for(const table of ['control_loop_improvement_requests','control_loop_improvement_inputs','control_loop_policy_input_sources','control_loop_improvement_commands'])
      assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length,0,'rollback leaves no partial '+table);
    await assert.rejects(readFile(join(f.root,'trace.jsonl')),{code:'ENOENT'},'rolled-back admission never dispatches');
  }
});
