import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { nodeExchange } from "./helpers/web-node";
import { createMacLocalWebProcessV1 } from "../src/web/v1/mac-local-web-process";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { loopApprovalDescriptorSchemaV1 } from "../src/web/v1/improve-control-room-loop-attention-wire";
import { canonicalJson, hmacSha256Tag, sha256Digest } from "../src/security";
import { ImproveControlRoomDeskServiceV1 } from "../src/improve-control-room/v1/service";
import { loopImprovementRunIdentitySchemaV1, loopImprovementObservationSchemaV1,
  type LoopBridgeBindingV1, type LoopBridgeOperationV1 } from "../src/improve-control-room/v1/schemas";
import { ImproveControlRoomLoopServiceV1 } from "../src/web/v1/improve-control-room-loop-service";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1, loopEngineStatusSchemaV1,
  type LoopAdapterV1, type LoopEngineStatusV1, type LoopAdapterConfigurationV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { createImproveControlRoomHttpHandlerV1 } from "../src/web/v1/improve-control-room-http";
import { createPrivateNodeHandler } from "../src/web/v1/private-node-handler";
import { privateRequestBodyLimit } from "../src/web/v1/private-request-budgets";
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
const executable = `import os,sys,json,hashlib
root=os.path.dirname(os.path.abspath(__file__))
op,run=sys.argv[1:3]; args=sys.argv[3:]
path=os.path.join(root,'runs',run+'.json')
with open(os.path.join(root,'trace.jsonl'),'a') as f: f.write(json.dumps(dict(op=op,run=run,args=args,env=dict(os.environ),cwd=os.getcwd()))+'\\n')
def h(s): return hashlib.sha256(s.encode()).hexdigest()
def flag(k): return args[args.index(k)+1]
if op=='intake':
    with open(flag('--source')) as f: text=f.read()
    with open(flag('--settings')) as f: settings=f.read()
    s=dict(run=run,revision=1,inputVersion=1,state='draft',description=text,settingsSha256=h(settings),settingsDigest=h(settings),confirmation=None,approval=None,question=None,progress=dict(step='intake',completed=0,attention='none'),receipts=[])
else:
    with open(path) as f: s=json.load(f)
refusal=os.path.join(root,'refusal.json')
if os.path.exists(refusal):
    with open(refusal) as f: refused=json.load(f)
    if refused['op']==op:
        if refused.get('output','envelope')=='envelope': print(json.dumps(dict(schema_version=1,run=run,state=s['state'],revision=s['revision'],next=None,attention=[],steps=[],counters=dict(fixture=s),error='refused')))
        elif refused['output']=='malformed': print('unreadable')
        if refused.get('breakStatus'): os.remove(path)
        sys.exit(refused['code'])
if op=='confirm-request':
    if flag('--sha256')!=h(s['description']): sys.exit(2)
    s['confirmation']=dict(path='request.md',sha256=h(s['description']),at='2026-10-01T00:00:00.000Z',who='owner',input_version=s['inputVersion'])
    s['state']='ready';s['revision']+=1
if op=='start': s['state']='running';s['revision']+=1;s['progress']['step']='plan'
if op=='stop': s['state']='stopped';s['revision']+=1
if op=='approve': s['approval']=None;s['state']='running';s['revision']+=1
if op=='answer': s['question']=None;s['state']='running';s['revision']+=1
if op!='status':
    with open(path,'w') as f: json.dump(s,f)
if op!='approve': print(json.dumps(dict(schema_version=1,run=run,state=s['state'],revision=s['revision'],next=None,attention=[],steps=[],counters=dict(fixture=s),error=None)))
`;

async function synthetic(t: TestContext) {
  await mkdir(resolve(".test-tmp"), { recursive: true });
  const root = await mkdtemp(resolve(".test-tmp/b1b-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ["runs", "work"]) await mkdir(join(root, dir));
  await writeFile(join(root, "engine.py"), executable);
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
  const receipts = new Map<string, LoopEngineStatusV1["receipts"]>();
  let raw: LoopAdapterV1;
  let documentNames = { report: "report.md", sidecar: "report.json" };
  let beforeAdmission: (() => Promise<void>) | undefined;
  const configuration: LoopAdapterConfigurationV1 = { adapterId: "adapter:synthetic", interpreter: realpathSync(process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/python3" : "/usr/bin/python3"),
    interpreterSha256: loopByteHashV1(await readFile(realpathSync(process.platform === "darwin" ? "/Library/Developer/CommandLineTools/usr/bin/python3" : "/usr/bin/python3"))),
    entrypointSha256: loopByteHashV1(executable), entrypoint: join(root, "engine.py"), toolingManifest: join(root, "tooling.json"), configRoot: root,
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
        const e = output as { schema_version: number; run: string; counters: { fixture: Record<string, unknown> } };
        assert.equal(e.schema_version, 1); assert.match(e.run, /^fixture-run-[a-f0-9]{32}$/);
        const { questionText: _text, blockedCode: _code, ...engine } = e.counters.fixture;
        return loopEngineStatusSchemaV1.parse({ ...engine, run: { adapterId: "adapter:synthetic", loopRunId: e.run,
          toolingRevision, a2SchemaVersion: 1 } });
      }, atomicAdmission: async (binding, invoke) => {
        await beforeAdmission?.();
        const current = await raw.status(binding.loopRunId);
        if (current.revision !== binding.expectedRevision || current.inputVersion !== binding.inputVersion
          || loopByteHashV1(current.description) !== binding.requestSha256 || current.settingsSha256 !== binding.settingsSha256
          || (binding.evidence && sha256Digest(binding.body.step ? current.approval : current.question) !== binding.evidence))
          throw new Error("SYNTHETIC atomic admission refusal");
        return invoke();
      } } };
  raw = createImproveControlRoomLoopAdapterV1(configuration);
  t.after(() => raw.close());
  const decorate = (s: LoopEngineStatusV1) => ({ ...s, receipts: [...(receipts.get(s.run.loopRunId) ?? []), ...s.receipts] });
  const apply = async (op: LoopBridgeOperationV1, commandId: string, binding: LoopBridgeBindingV1, text?: string, fence: () => void = () => {}) => {
    const s = await (op === "intake" ? raw.intake(commandId, binding, text!, fence) : op === "confirm" ? raw.confirmRequest(commandId, binding, fence)
      : op === "answer" ? raw.answer(commandId, binding, text!, fence) : raw[op](commandId, binding, fence));
    // Test-only receipt translation from this fixture's exact completed transition.
    const all = receipts.get(binding.loopRunId) ?? [];
    all.push(s.receipts.find(receipt => receipt.commandId === commandId)
      ?? { commandId, bindingDigest: sha256Digest(binding), state: "accepted", evidenceDigest: sha256Digest(s), error: null });
    receipts.set(binding.loopRunId, all); return decorate({ ...s, receipts: [] });
  };
  const adapter: LoopAdapterV1 = { ...raw, status: async run => decorate(await raw.status(run)),
    intake: (id, b, text, fence) => apply("intake", id, b, text, fence), confirmRequest: (id, b, fence) => apply("confirm", id, b, undefined, fence),
    start: (id, b, fence) => apply("start", id, b, undefined, fence), stop: (id, b, fence) => apply("stop", id, b, undefined, fence), approve: (id, b, fence) => apply("approve", id, b, undefined, fence),
    answer: (id, b, text, fence) => apply("answer", id, b, text, fence) };
  const edit = async (run: string, changes: Partial<LoopEngineStatusV1> & {questionText?:unknown;blockedCode?:"QUESTION_LIMIT"|"INPUT_CHANGED"}) => {
    const path = join(root, "runs", `${run}.json`), saved = JSON.parse(await readFile(path, "utf8"));
    await writeFile(path, JSON.stringify({ ...saved, ...changes, run: saved.run }));
  };
  const traces = async () => (await readFile(join(root, "trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line)) as {op: string; run: string; args: string[]; env: Record<string,string>; cwd: string}[];
  return { root, adapter, raw, configuration, edit, traces, setDocumentNames: (names: typeof documentNames) => { documentNames = names; }, setBeforeAdmission: (callback: () => Promise<void>) => { beforeAdmission = callback; } };
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
    expectedRevision: s.engine.revision, requestSha256: s.engine.requestSha256, settingsSha256: s.engine.settingsSha256 }); assert.equal(response.status, 202); assert.equal((await response.json() as {state:string}).state,"accepted"); return get(id); };
  return { ...f, ...engine, bridge, service, handler, base, post, get, intake, confirm };
}

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
  assert.deepEqual(first.args.slice(0,1),["--source"]); assert.deepEqual(first.args.slice(2),["--settings",join(f.root,"settings.json"),"--json"]);
  assert.deepEqual(traces.find(e=>e.op==="start")!.args,["--settings",join(f.root,"settings.json"),"--availability",join(f.root,"availability.json"),"--json"]);
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
  const race=await f.post(`${suffix}/start`,{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId});
  assert.equal((await race.json() as {state:string}).state,"uncertain");
  assert.equal((await f.traces()).filter(e=>e.op==="start").length,0,"B1b atomic seam refuses revision race before launch");
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
  const unqualified=createImproveControlRoomLoopAdapterV1({...f.configuration,contract:{...f.configuration.contract,qualifiedOperations:[],atomicAdmission:undefined}});t.after(()=>unqualified.close());
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter:unqualified},()=>now);
  await assert.rejects(bridge.mutate(f.identity,f.project.projectId,null,"intake",{description},"b1b-unqualified-0001"),/unavailable/);
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length,0);
  await writeFile(join(f.root,"settings.json"),"{}");
  assert.equal((await f.post("intake",{description})).status,503);
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

test("B1b exact-current confirmation guard",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const current=await f.adapter.status(run);
  await f.edit(run,{confirmation:{...current.confirmation!,at:"2026-10-02T00:00:00.000Z"}});
  const before=(await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length;
  const response=await f.post(`${encodeURIComponent(id)}/start`,{expectedVersion:s.request.currentVersion,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId});
  assert.equal(response.status,409,"B1b changed owner confirmation refuses before claim");
  assert.equal((await f.db.query("SELECT * FROM control_loop_improvement_commands")).rows.length,before);
});

if(process.env.CONTROL_ROOM_B1B_REQUIRE_A2==="1") test("reviewed A2 bridge contract",()=>{
  assert.ok(process.env.CONTROL_ROOM_B1B_A2_CONTRACT,"I1–I3 NOT SUPPLIED: reviewed tooling/captures, atomic A2 admission and B0-qualified disposable proof required");
  assert.fail("I1–I3 real proof is unavailable until the reviewed upstream contract and harness are supplied; fixtures never establish integration");
});

test("B1b all seven routes recheck expiry, revocation, project and replay authority",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.get(id),suffix=encodeURIComponent(id);
  const routes=[
    {suffix:"intake",body:{description}},
    {suffix:`${suffix}/status`,body:undefined},
    {suffix:`${suffix}/confirm`,body:{expectedVersion:1,expectedRevision:s.engine.revision,requestSha256:s.engine.requestSha256,settingsSha256:s.engine.settingsSha256}},
    {suffix:`${suffix}/start`,body:{expectedVersion:1,expectedRevision:s.engine.revision,runLinkId:s.request.runLink!.runLinkId}},
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

test("B1b Stop still targets the original owned run after local draft/settings change",async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id);
  assert.equal((await f.post(`${encodeURIComponent(id)}/start`, { expectedVersion: s.request.currentVersion,
    expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId })).status, 202);
  const desk=new ImproveControlRoomDeskServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},KEY,undefined,()=>now,f.adapter.contract);
  await desk.reviseLoopDraft(f.identity,f.project.projectId,{requestId:id,expectedVersion:1,description:"Changed local draft.",settingsText:JSON.stringify({changed:true})},"b1b-changed-local-0001");
  const response=await f.post(`${encodeURIComponent(id)}/stop`,{runLinkId:s.request.runLink!.runLinkId});
  assert.equal((await response.json() as {state:string}).state,"accepted");
  assert.equal((await f.get(id)).engine.state,"stopped");
});

test("B1b dropped request and lost dispatch reply consume one durable attempt",async t=>{
  const f=await fixture(t);let entered!:()=>void,release!:()=>void,calls=0;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const adapter={...f.adapter,intake:async(id:string,b:LoopBridgeBindingV1,text:string,fence:()=>void)=>{calls++;entered();await gate;return f.adapter.intake(id,b,text,fence);}};
  const bridge=new ImproveControlRoomLoopServiceV1(f.client,{tenantId:"tenant:web",workspaceId:"workspace:web"},{integrityKey:KEY,adapter},()=>now);
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
  const f=await fixture(t);let current=now,expire=true,launches=0,failResult=false;
  const traced=(tx:import('../src/persistence/database').DatabaseSession)=>({query:async<T>(sql:string,params?:unknown[])=>{
    if(failResult&&sql.startsWith('INSERT INTO control_loop_improvement_commands')&&params?.[2]==='result'){failResult=false;throw new Error('SYNTHETIC DB result loss');}
    return tx.query<T>(sql,params);
  }});
  const db:import('../src/persistence/database').DatabaseClient={query:f.client.query,transaction:callback=>f.client.transaction(tx=>callback(traced(tx))),
    transactionWithPreCommitCheck:async(callback,check)=>{const value=await f.client.transactionWithPreCommitCheck(tx=>callback(traced(tx)),check);if(expire){expire=false;current+=6000;}return value;}};
  const adapter={...f.adapter,intake:async(id:string,b:LoopBridgeBindingV1,text:string,fence:()=>void)=>{launches++;return f.adapter.intake(id,b,text,fence);}};
  const bridge=new ImproveControlRoomLoopServiceV1(db,{tenantId:'tenant:web',workspaceId:'workspace:web'},{integrityKey:KEY,adapter},()=>current);
  const expired=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-expired-admission-0001');
  assert.equal(expired.state,'uncertain');assert.equal(launches,0,'expired committed admission never reaches spawn');
  assert.equal((await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-expired-admission-0001')).state,'uncertain');assert.equal(launches,0);
  failResult=true;
  const lost=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-post-dispatch-db-0001');assert.equal(lost.state,'uncertain');
  const reconciled=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description},'b1b-post-dispatch-db-0001');assert.equal(reconciled.state,'accepted');assert.equal(reconciled.replayed,true);assert.equal(launches,1);
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

test("B1b sweep database errors reach the transaction while verification failures retain files", async t => {
  const f = await fixture(t);
  const crashed = new ImproveControlRoomLoopServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    { integrityKey: KEY, adapter: { ...f.adapter, releaseCommandFiles: async () => {} } }, () => now);
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
    { integrityKey: KEY, adapter: f.adapter }, () => now);
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

test("B1b canStop after a refused Start agrees with the Stop route", async t => {
  const f = await fixture(t), id = await f.intake(), s = await f.confirm(id), suffix = encodeURIComponent(id);
  await writeFile(join(f.root, "refusal.json"), JSON.stringify({ op: "start", code: 3 }));
  const refused = await f.bridge.mutate(f.identity, f.project.projectId, id, 'start',
    { expectedVersion: s.request.currentVersion, expectedRevision: s.engine.revision, runLinkId: s.request.runLink!.runLinkId }, 'b1b-refused-start-0001');
  assert.equal(refused.state, 'refused');
  await rm(join(f.root, "refusal.json"));
  const after = await f.get(id);
  assert.equal(after.display.startState, 'not_started'); assert.equal(after.display.canStart, false);
  assert.equal(after.display.canStop, true, 'canStop agrees with Stop after a refused Start');
  const stop = await f.post(`${suffix}/stop`, { runLinkId: s.request.runLink!.runLinkId });
  assert.equal(stop.status, 202); assert.equal((await stop.json() as { state: string }).state, 'accepted');
  assert.equal((await f.get(id)).display.canStop, false);
});

test("B1b split loop and legacy pipeline integrity keys refuse every composition", async t => {
  const f = await fixture(t), other = new Uint8Array(32).fill(65);
  const hosted = (workBatchKey: Uint8Array) => createPrivateWebProcess({ origin, ...trust, tenantId: "tenant:web", workspaceId: "workspace:web",
    loadKeys: async () => trust.keys, clock: () => now, database: { client: f.client, close: async () => {} },
    loopBridge: { integrityKey: KEY, adapter: f.adapter }, workBatches: { integrityKey: workBatchKey } });
  assert.throws(() => hosted(other), /invalid_private_app_config/, 'hosted composition refuses a split loop key');
  const app = hosted(Uint8Array.from(KEY)); await app.close();
  const localOrigin = "http://127.0.0.1:32124";
  const mac = (workBatchIntegrityKey: Uint8Array) => createMacLocalWebProcessV1({ origin: localOrigin, workspaceId: "workspace:web", clock: () => now,
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: localOrigin, tenantId: "tenant:web", provider: trust.issuer, subject: "test-owner",
      ownerCodeDigest: sha256Digest({ ownerCode: "synthetic-local-owner-code-long" }), sessionSeconds: 900 },
    database: { client: f.client, isAvailable: () => true, close: async () => {} }, loopBridge: { integrityKey: KEY, adapter: f.adapter }, workBatchIntegrityKey });
  assert.throws(() => mac(other), /mac_local_web_process_config_invalid/, 'Mac composition refuses a split loop key');
  await mac(Uint8Array.from(KEY)).close();
  const composition = await privateAgentTaskCompositionFixture(); t.after(composition.close);
  const scenario = composition.scenario();
  const startup = (pipelineKey: Uint8Array) => validatePrivateTaskStartupConfiguration({ ...scenario.configuration,
    loopBridge: { integrityKey: KEY, adapter: f.configuration },
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

for(const composition of ["hosted","local"] as const)test(`B2b ${composition} attention and document composition`,async t=>{
  const f=await fixture(t),id=await f.intake(),s=await f.confirm(id),run=s.request.runLink!.loopRunId;
  const directory=join(f.configuration.runRoot,run);await mkdir(directory);
  const text="SYNTHETIC complete sealed plan.";const approval={step:"plan" as const,inputVersion:1,head:"a".repeat(40),reportSha256:loopByteHashV1(text)};
  await writeFile(join(directory,"report.md"),text);await writeFile(join(directory,"report.json"),JSON.stringify(approval));await f.edit(run,{state:"waiting",approval});
  const canonical={observedAt:new Date(now).toISOString(),items:[],truncated:false};
  for(const mode of ["loop","canonical","both","neither","failed-canonical"] as const){
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
    // Each fixture composition owns an adapter lifecycle, so restore a fresh factory after close.
    if(mode!=="failed-canonical"){
      const replacement=createImproveControlRoomLoopAdapterV1(f.configuration);
      Object.assign(f.adapter,{...replacement});t.after(()=>replacement.close());
    }
  }
});
