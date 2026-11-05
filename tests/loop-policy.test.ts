import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { type TestContext } from "node:test";
import { composeLoopSettingsV1 } from "../src/web/v1/loop-policy-compose";
import { readPrivateWebSchemaDigest } from "../src/web/v1/private-database-preflight";
import { LoopPolicyServiceV1 } from "../src/web/v1/loop-policy-service";
import { createLoopPolicyHttpHandlerV1 } from "../src/web/v1/loop-policy-http";
import { WebAccessError } from "../src/web/v1/access-verifier";
import { taskFixture } from "./helpers/web-task";
import { now, origin, request, trust } from "./helpers/web-foundation";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";

const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const defaults = ' { "z":3, "roles":{"build":"default","final":"default"}, "array":[1,2] }\n';
const refused = (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request";
let sequence = 0;
const key = () => `p71-policy-key-${String(++sequence).padStart(8, "0")}`;

test("P71 composition four-layer precedence and independently specified exact bytes", () => {
  assert.deepEqual(composeLoopSettingsV1({ defaultsText: defaults }), { text: defaults, sha256: sha(defaults) });
  const expected = '{"array":[9],"roles":{"build":"run","final":"project","new":null},"z":{"nested":true}}\n';
  const input = { defaultsText: defaults, project: '{"roles":{"final":"project"},"z":null}',
    selection: '{"roles":{"build":"selection","new":null},"array":[9]}', runEdits: '{"roles":{"build":"run"},"z":{"nested":true}}' };
  assert.deepEqual(composeLoopSettingsV1(input), { text: expected, sha256: sha(expected) });
  assert.deepEqual(composeLoopSettingsV1({ ...input, selection: '{"array":[9],"roles":{"new":null,"build":"selection"}}' }), { text: expected, sha256: sha(expected) });
  assert.equal(composeLoopSettingsV1({ defaultsText: '{"a":{"b":1}}', runEdits: '{"a":null}' }).text, '{"a":null}\n');
  assert.equal(composeLoopSettingsV1({ defaultsText: '{"a":[1]}', runEdits: '{"a":{"b":2}}' }).text, '{"a":{"b":2}}\n');
  assert.equal(composeLoopSettingsV1({ defaultsText: '{}', runEdits: '{"2":2,"10":10}' }).text, '{"10":10,"2":2}\n');
  assert.equal(composeLoopSettingsV1({ defaultsText: '{}', runEdits: '{"overrides":{"explicit":true}}' }).text, '{"overrides":{"explicit":true}}\n');
});

test("P71 composition refuses decoded duplicate, prototype, secret, inherited overrides and bounded output", () => {
  for (const text of ['[]', 'null', '{', '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"x":{"constructor":{}}}',
    '{"__proto__":{}}', '{"array":[{"prototype":1}]}', '{"api_key":"SYNTHETIC"}', '{"x":1e999}']) {
    assert.throws(() => composeLoopSettingsV1({ defaultsText: '{}', runEdits: text }), refused, text);
  }
  for (const layer of ['project','selection'] as const)
    assert.throws(() => composeLoopSettingsV1({ defaultsText: '{}', [layer]: '{"overrides":{}}' }), refused);
  const a = JSON.stringify({ a: 'a'.repeat(40000) }), b = JSON.stringify({ b: 'b'.repeat(40000) });
  assert.throws(() => composeLoopSettingsV1({ defaultsText: a, project: b }), refused, "composed bound applies across individually bounded inputs");
  assert.throws(() => composeLoopSettingsV1({ defaultsText: JSON.stringify({ a: 'é'.repeat(33000) }) }), refused, "bound counts UTF-8 bytes");
});

test("P71 preserves unknown paid-named settings without assigning authority", () => {
  const text = '{"paid":false,"nested":{"paidPin":null},"array":[{"paid":true}],"providerRoute":{"providerId":"fixture","model":"fixture-model"}}';
  for (const source of ['defaultsText', 'project', 'selection', 'runEdits'] as const) {
    const input = { defaultsText: '{}', [source]: text };
    assert.deepEqual(JSON.parse(composeLoopSettingsV1(input).text), JSON.parse(text), source);
  }
});

test("P71 ordinary CI excludes only the mandatory real-tools test and exposes a fail-closed real lane", async t => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  assert.match(scripts['test:improve-control-room'], /--test-skip-pattern=['"]\^P71 real settings check\$['"]/,
    'ordinary CI must exclude the qualified-tools acceptance test');
  assert.match(scripts['test:loop-policy:real'] ?? '', /--test-name-pattern=['"]\^P71 real settings check\$['"]/);
  assert.doesNotMatch(scripts['test:loop-policy:real'], /skip|\|\|/);
  const pattern = /--test-skip-pattern='([^']+)'/.exec(scripts['test:improve-control-room'])![1]!;
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-tmp/p71-ci-filter-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'ci.mjs');
  await writeFile(file, `import test from 'node:test'; import assert from 'node:assert/strict';
    test('P71 real settings check', () => assert.fail('qualified tools must be separate'));
    test('ordinary policy check', () => assert.ok(true));`);
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', `--test-skip-pattern=${pattern}`, file], { env, timeout: 10000 });
  assert.match(stdout, /ok 1 - ordinary policy check/);
  assert.match(stdout, /# pass 1/); assert.match(stdout, /# fail 0/);

});

test("P71 downgrade refuses retained run-edit commands before changing the schema", async t => {
  const f = await policyFixture(t);
  const { ImproveControlRoomDeskServiceV1 } = await import('../src/improve-control-room/v1/service');
  const desk = new ImproveControlRoomDeskServiceV1(f.client, scope, new Uint8Array(32).fill(65), undefined, () => now);
  const draft = await desk.saveLoopDraft(f.identity, f.project.projectId,
    { description: 'Retained edited command', settingsText: '{}' }, key());
  const binding = { schemaVersion: 1, body: { description: 'Retained edited command', settingsEdits: '{}' }, localVersion: 1,
    adapterId: 'adapter:fixture', loopRunId: 'run:fixture', toolingRevision: 'sha256:'+'a'.repeat(64), schemaDigest: 'sha256:'+'b'.repeat(64),
    a2SchemaVersion: 1, requestSha256: sha('Retained edited command'), settingsSha256: sha('{}'), runLinkId: null,
    authorizationId: null, inputVersion: null, expectedRevision: null, evidence: null };
  const insert = (command: string, body: unknown) => f.db.query(`INSERT INTO control_loop_improvement_commands
    (tenant_id,command_id,entry_kind,request_id,project_id,owner_identity_id,operation,idempotency_key,binding,record_digest,auth_tag,created_at)
    VALUES($1,$2,'claim',$3,$4,'identity:web','intake',$5,$6,'sha256:'||repeat('c',64),'hmac-sha256:'||repeat('d',64),$7)`,
    [scope.tenantId, command, draft.request.requestId, f.project.projectId, key(), JSON.stringify({ ...binding, body }), new Date(now).toISOString()]);
  await insert('loop-command:'+'1'.repeat(32), binding.body);
  const before = (await f.db.query('SELECT * FROM control_loop_improvement_commands')).rows;
  for (const table of ['control_loop_policy_layers','control_loop_policy_events','control_loop_policy_input_sources'])
    assert.equal((await f.db.query(`SELECT * FROM ${table}`)).rows.length, 0);
  await f.db.exec(await readFile('db/down/0307_control_loop_policy_validate.sql','utf8'));
  const schemaBefore = await readPrivateWebSchemaDigest(f.client);
  await assert.rejects(f.db.exec(await readFile('db/down/0306_control_loop_policy.sql','utf8')),
    { code: '23514', message: 'loop policy retained command rows' });
  await f.db.exec('ROLLBACK');
  assert.deepEqual((await f.db.query('SELECT * FROM control_loop_improvement_commands')).rows, before);
  assert.equal(await readPrivateWebSchemaDigest(f.client), schemaBefore, 'refusal preserves the schema before 0306 down');
  assert.equal((await f.db.query("SELECT relname FROM pg_class WHERE relname IN ('control_loop_policy_layers','control_loop_policy_events','control_loop_policy_input_sources')")).rows.length, 3);
});

test("P71 empty downgrade restores the validated pre-P71 release schema pin", async t => {
  const f = await policyFixture(t);
  await f.db.exec(await readFile('db/down/0309_control_loop_provider_prices.sql','utf8'));
  await f.db.exec(await readFile('db/down/0308_control_loop_providers.sql','utf8'));
  await f.db.exec(await readFile('db/down/0307_control_loop_policy_validate.sql','utf8'));
  await f.db.exec(await readFile('db/down/0306_control_loop_policy.sql','utf8'));
  assert.equal((await f.db.query<{ convalidated: boolean }>("SELECT convalidated FROM pg_constraint WHERE conname='control_loop_improvement_commands_check1'")).rows[0]!.convalidated, true);
  // The release pin shipped immediately before P71 (7cc303ebc).
  assert.equal(await readPrivateWebSchemaDigest(f.client), '8cbc9b7afcb491a0e41f500bde4e919c57e2e8e257caa5e6687ca87c5e66ee4c');
});

async function policyFixture(t: TestContext) {
  const f = await taskFixture(); t.after(() => f.db.close());
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}',
    '{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
  const checks: string[] = [];
  let check: (text: string) => Promise<{ eligible: boolean; reasons: { code: string; explanation: string }[] }> = async () => ({ eligible: true, reasons: [] });
  const tools = { settingsText: defaults, checkSettings: async (text: string) => { checks.push(text); return check(text); } };
  const service = new LoopPolicyServiceV1(f.client, scope, tools, () => now);
  const handler = createLoopPolicyHttpHandlerV1({ origin, trust, service, clock: () => now });
  const path = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/loop-policy`;
  const put = (layer: string, body: unknown, k = key()) => handler(request(`${path}/${layer}`, 'PUT', body, k));
  const count = async () => (await f.db.query<{ n: number }>('SELECT count(*)::int AS n FROM control_loop_policy_events')).rows[0]!.n;
  return { ...f, service, handler, path, put, checks, count, tools, setCheck: (next: typeof check) => { check = next; } };
}

test("P71 policy replacement, audit, latest replay, stale keys and restart", async t => {
  const f = await policyFixture(t), project = f.project.projectId;
  assert.deepEqual(await f.service.view(f.identity, project), { project: { version: 0, settingsText: '{}' }, selection: { version: 0, settingsText: '{}' } });
  const k = key(), body = { expectedVersion: 0, settings: '{"roles":{"build":"project"}}' };
  const first = await f.put('project', body, k); assert.equal(first.status, 201); assert.deepEqual(await first.json(), { replayed: false, version: 1 });
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const replay = await f.put('project', body, k); assert.equal(replay.status, 200); assert.equal(f.checks.length, 1);
  assert.equal((await f.put('project', { ...body, settings: '{}' }, k)).status, 409);
  assert.equal((await f.put('project', body)).status, 409); assert.equal(await f.count(), 1);
  assert.equal((await f.put('project', { expectedVersion: 1, settings: '{"other":true}' })).status, 201);
  assert.equal((await f.put('project', body, k)).status, 409, 'older key is not replayed');
  assert.equal((await f.put('selection', { expectedVersion: 0, settings: '{"z":null}' })).status, 201);
  assert.equal(await f.count(), 3);
  const restarted = new LoopPolicyServiceV1(f.client, scope, f.tools, () => now);
  assert.deepEqual(await restarted.view(f.identity, project), { project: { version: 2, settingsText: '{"other":true}' }, selection: { version: 1, settingsText: '{"z":null}' } });
  assert.equal(f.checks[2], '{"array":[1,2],"other":true,"roles":{"build":"default","final":"default"},"z":null}\n', 'whole-layer save replaces removed keys');
  const events = (await f.db.query<{ before_sha256: string | null; after_sha256: string; version: number }>('SELECT * FROM control_loop_policy_events ORDER BY layer,version')).rows;
  assert.equal(events[0]!.before_sha256, null); assert.equal(events[1]!.before_sha256, sha(body.settings));
  assert.equal(events[1]!.after_sha256, sha('{"other":true}'));
});

test("P71 owner guard refuses operator, expired and foreign scope before check/write", async t => {
  const f = await policyFixture(t), body = { expectedVersion: 0, settings: '{}' };
  await f.db.query("UPDATE control_role_grants SET role_key='operator'");
  assert.equal((await f.put('project', body)).status, 403, 'P71 independent owner-only denial');
  assert.equal(f.checks.length, 0); assert.equal(await f.count(), 0);
  await f.db.query("UPDATE control_role_grants SET role_key='owner'");
  await assert.rejects(f.service.put({ ...f.identity, expiresAt: new Date(now - 1).toISOString() }, f.project.projectId, 'project', body, key()), { code: 'authentication_required' });
  const otherScope = new LoopPolicyServiceV1(f.client, { ...scope, workspaceId: 'workspace:foreign' }, f.tools, () => now);
  await assert.rejects(otherScope.put(f.identity, f.project.projectId, 'project', body, key()), { code: 'not_found' });
  assert.equal(f.checks.length, 0); assert.equal(await f.count(), 0);
});

test("P71 refusal and unavailable checks leave no layers, events or drafts; transport stays 8 KiB", async t => {
  const f = await policyFixture(t);
  for (const body of [{ expectedVersion: 0, settings: '{"overrides":{}}' }, { expectedVersion: 0, settings: '{"x":1,"x":2}' },
    { expectedVersion: 0, settings: '{}', unknown: true }, { expectedVersion: 0, settings: '{"api_key":"SYNTHETIC"}' }])
    assert.equal((await f.put('project', body)).status, 400);
  assert.equal(f.checks.length, 0);
  assert.equal((await f.put('project', { expectedVersion: 0, settings: JSON.stringify({ large: 'x'.repeat(8200) }) })).status, 413);
  assert.equal(f.checks.length, 0); assert.equal(await f.count(), 0);
  f.setCheck(async () => ({ eligible: false, reasons: [{ code: 'SYNTHETIC_ENGINE_CODE', explanation: 'Model unavailable' }] }));
  const refusal = await f.put('project', { expectedVersion: 0, settings: '{}' }); assert.equal(refusal.status, 422);
  assert.deepEqual(await refusal.json(), { error: 'policy_refused', reasons: [{ code: 'SYNTHETIC_ENGINE_CODE', explanation: 'Model unavailable' }] });
  f.setCheck(async () => { throw new Error('private diagnostic never exposed'); });
  const unavailable = await f.put('project', { expectedVersion: 0, settings: '{}' }); assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'service_unavailable' });
  assert.equal(await f.count(), 0);
  assert.equal((await f.db.query('SELECT * FROM control_loop_policy_layers')).rows.length, 0);
  assert.equal((await f.db.query('SELECT * FROM control_loop_improvement_requests')).rows.length, 0);
  assert.equal((await f.handler(request(f.path, 'DELETE'))).status, 400);
});

test("P71 commit recheck detects equal-bytes version drift, authority expiry and rollback SQLSTATE mapping", async t => {
  const f = await policyFixture(t), body = { expectedVersion: 0, settings: '{}' };
  f.setCheck(async () => {
    await f.db.query(`INSERT INTO control_loop_policy_layers(tenant_id,project_id,layer,version,settings_text,settings_sha256,updated_by,updated_at,last_idempotency_key,last_request_digest)
      VALUES($1,$2,'selection',1,'{}',$3,'identity:web',$4,'p71-other-layer-0001',$5)`, [scope.tenantId, f.project.projectId, sha('{}'), new Date(now).toISOString(), 'sha256:'+'a'.repeat(64)]);
    return { eligible: true, reasons: [] };
  });
  assert.equal((await f.put('project', body)).status, 409); assert.equal(await f.count(), 0);
  for (const sqlState of ['40P01','40001']) {
    let rolledBack = false;
    const db: DatabaseClient = { query: f.client.query.bind(f.client), transaction: f.client.transaction.bind(f.client),
      transactionWithPreCommitCheck: async <T,>(operation: (tx: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) => {
        try { return await f.client.transactionWithPreCommitCheck(async tx => {
          const value = await operation(tx); throw Object.assign(new Error('injected rollback'), { sqlState }); return value;
        }, check); } finally { rolledBack = true; }
      } };
    const service = new LoopPolicyServiceV1(db, scope, f.tools, () => now);
    await assert.rejects(service.put(f.identity, f.project.projectId, 'project', body, key()), { code: 'conflict' });
    assert.equal(rolledBack, true); assert.equal(await f.count(), 0);
  }
});

// Missing qualified tools is a failing prerequisite, never a green skip.
test("P71 real settings check", async t => {
  assert.ok(process.env.CONTROL_ROOM_A2_TEST_LOOP, 'P71-7 requires qualified pinned CONTROL_ROOM_A2_TEST_LOOP; fixtures cannot substitute');
  const loop=resolve(process.env.CONTROL_ROOM_A2_TEST_LOOP!);
  assert.doesNotMatch(loop,/(?:^|[/\\])(?:\.codex|\.hermes|\.aws|\.env|auth\.json|tokens?)(?:[/\\]|$)/i);
  const pythonShim=await readFile(join(dirname(loop),'bin/lib/python.sh'),'utf8');
  const pinned=/CR_PYTHON=(\S+)/.exec(pythonShim);
  assert.ok(pinned,'qualified tools supply their pinned interpreter');
  const interpreter=realpathSync(pinned[1]!.replace(/^["']|["']$/g,''));
  const f=await checkerFixture(t);await f.adapter.close();
  // Reuse the repository's established real Bridge fixture, whose launcher is dry.
  // It supplies engine-valid settings and availability without a live installation.
  const bootstrap=String.raw`import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from test_a2_bridge import Bridge
d=Bridge();d.setUp()
try:
 p,_=d.prepare_intake()
 args=list(d.intake_args(p))
 availability=Path(args[args.index('--availability')+1]).read_text()
 print(json.dumps(dict(settings=d.settings_path.read_text(),availability=availability)))
finally:
 d.doCleanups()
`;
  const {stdout}=await promisify(execFile)(interpreter,['-B','-c',bootstrap,loop],{cwd:f.root,timeout:30000,maxBuffer:131072,
    env:{PATH:'/usr/bin:/bin',TMPDIR:f.root,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',PYTHONDONTWRITEBYTECODE:'1',NODE_ENV:'test'}});
  const fixture=JSON.parse(stdout) as {settings:string;availability:string};
  await cp(loop,join(f.root,'tools/loop'),{recursive:true,filter:path=>!path.includes('__pycache__')&&!/(?:^|[/\\])(?:\.git|\.env(?:\.[^/]*)?|\.codex|\.hermes|\.aws|auth\.json|tokens?)(?:[/\\]|$)/i.test(path)});
  await cp(join(dirname(loop),'bin/lib'),join(f.root,'tools/bin/lib'),{recursive:true,filter:path=>!path.includes('__pycache__')&&!/(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.codex|\.hermes|\.aws|auth\.json|tokens?)(?:[/\\]|$)/i.test(path)});
  await writeFile(join(f.root,'settings.json'),fixture.settings);await writeFile(join(f.root,'availability.json'),fixture.availability);
  const entrypoint=join(f.root,'tools/loop/bridge/cr-entry.py');
  const manifest=JSON.stringify({cr:sha(await readFile(join(f.root,'tools/loop/cr.py'),'utf8')),bridge:sha(await readFile(entrypoint,'utf8'))});
  await writeFile(join(f.root,'tooling.json'),manifest);
  const toolingRevision=`sha256:${sha(manifest)}`;
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,interpreter,interpreterSha256:loopByteHashV1(await readFile(interpreter)),
    entrypointSha256:loopByteHashV1(await readFile(entrypoint)),settingsSha256:sha(fixture.settings),availabilitySha256:sha(fixture.availability),
    toolingRevision,contract:{...f.configuration.contract,lineage:{...f.configuration.contract.lineage,toolingRevision}}});
  t.after(()=>adapter.close());
  await t.test('qualified fixture defaults',async()=>{assert.equal((await adapter.checkSettings!(fixture.settings)).eligible,true,'real cr accepts its qualified fixture defaults');});
  const composed=composeLoopSettingsV1({defaultsText:fixture.settings,project:'{}',selection:'{}',runEdits:'{}'});
  await t.test('deterministic merged encoding',async()=>{assert.equal((await adapter.checkSettings!(composed.text)).eligible,true,'real cr accepts deterministic merged encoding');});
  const unknown=JSON.parse(fixture.settings) as Record<string,unknown>;
  let changed=false;
  const replaceModel=(value:unknown)=>{
    if(!value||typeof value!=='object'||changed)return;
    for(const [key,child] of Object.entries(value)){
      if(key==='model'&&typeof child==='string'){(value as Record<string,unknown>)[key]='p71-unknown-model';changed=true;return;}
      replaceModel(child);
    }
  };
  replaceModel(unknown);
  assert.ok(changed,'qualified settings must identify a model for the unknown-model refusal probe');
  await t.test('unknown model refusal',async()=>{
  const refusal=await adapter.checkSettings!(JSON.stringify(unknown));
  assert.equal(refusal.eligible,false);assert.ok(refusal.reasons.length>0,'real exit-3 refusal preserves the tools reason');
  console.log(`P71 real direct cr checks=3 valid=true unknown_model=false reason=${refusal.reasons[0]!.code}`);
  });
  // Real intake/Start path independence, check-side final-family refusal, merge-rule parity and recovery require separate release evidence;
  // a passing direct checker alone does not confer POLICY-STORE-GREEN.
});

import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createImproveControlRoomLoopAdapterV1, loopByteHashV1 } from "../src/web/v1/improve-control-room-loop-adapter";
import { loopImprovementObservationSchemaV1, loopImprovementRunIdentitySchemaV1 } from "../src/improve-control-room/v1/schemas";

async function checkerFixture(t: TestContext) {
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-tmp/p71-check-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['tools/loop/bridge','work','runs']) await mkdir(join(root,path), { recursive: true, mode: 0o700 });
  const script = String.raw`import sys,os,json,time
root=os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
args=sys.argv[1:]
settings=args[args.index('--settings')+1]
with open(settings) as f: candidate=json.load(f)
with open(os.path.join(root,'trace.jsonl'),'a') as f:
 f.write(json.dumps(dict(args=args,settingsText=open(settings).read(),fileMode=os.stat(settings).st_mode&0o777,directoryMode=os.stat(os.path.dirname(settings)).st_mode&0o777,env=dict(os.environ),bytecode=sys.dont_write_bytecode))+'\n')
mode=candidate.get('mode','ok')
if mode=='timeout': time.sleep(10)
if mode=='large': print('x'*70000);sys.exit(0)
if mode=='malformed': print('no json');sys.exit(0)
if mode=='badexit': print(json.dumps(dict(eligible=True,reasons=[])));sys.exit(3)
if mode=='stderr': print('/private/diagnostic',file=sys.stderr);sys.exit(1)
reasons=[]
if mode=='refuse': reasons=[dict(code='SYNTHETIC_UNKNOWN_MODEL',explanation='Model unavailable')]
if mode=='model-slash': reasons=[dict(code='SYNTHETIC_UNKNOWN_MODEL',explanation='Model synthetic/vendor unavailable')]
if mode=='secret': reasons=[dict(code='SYNTHETIC',explanation='api_key=sk-'+('a'*40))]
if mode=='path': reasons=[dict(code='SYNTHETIC',explanation='Cannot read /private/fixture/file')]
print(json.dumps(dict(eligible=not reasons,reasons=reasons)))
sys.exit(3 if reasons else 0)
`;
  const entrypoint = join(root,'tools/loop/bridge/cr-entry.py');
  await writeFile(entrypoint, '# SYNTHETIC bridge, not invoked by settings checks\n');
  await writeFile(join(root,'tools/loop/cr.py'), script);
  const settingsText = '{"project":{"host_adapter":"local-loop"}}';
  await writeFile(join(root,'settings.json'), settingsText);
  await writeFile(join(root,'availability.json'), '{}'); await writeFile(join(root,'tooling.json'), '{}');
  const interpreter = realpathSync(process.platform === 'darwin' ? '/Library/Developer/CommandLineTools/usr/bin/python3' : '/usr/bin/python3');
  const toolingRevision = `sha256:${sha('{}')}`;
  const configuration: import("../src/web/v1/improve-control-room-loop-adapter").LoopAdapterConfigurationV1 = { adapterId: 'adapter:policy-check', interpreter,
    interpreterSha256: loopByteHashV1(await readFile(interpreter)), entrypoint, entrypointSha256: sha(await readFile(entrypoint,'utf8')),
    toolingManifest: join(root,'tooling.json'), configRoot: root, workRoot: join(root,'work'), runRoot: join(root,'runs'), cwd: root,
    settingsFile: join(root,'settings.json'), settingsSha256: sha(settingsText), availabilityFile: join(root,'availability.json'), availabilitySha256: sha('{}'),
    toolingRevision, executionIdentity: { uid: process.getuid!(), isolationEvidenceDigest: `sha256:${'a'.repeat(64)}` }, timeoutMs: 1000,
    contract: { lineage: { toolingRevision, decodeRunIdentity: value => loopImprovementRunIdentitySchemaV1.parse(value),
      decodeObservation: value => loopImprovementObservationSchemaV1.parse(value), matchesSavedInput: () => false },
      schemaDigest: `sha256:${'b'.repeat(64)}`, generateRunId: () => 'run:synthetic', decodeStatus: () => { throw new Error('not used'); }, qualifiedOperations: [] } };
  const adapter=createImproveControlRoomLoopAdapterV1(configuration);
  t.after(() => adapter.close());
  const traces = async () => (await readFile(join(root,'trace.jsonl'),'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { root, adapter, traces, configuration };
}

test("P71 direct settings checker bounds argv, files, JSON, refusals, timeout and close", async t => {
  const f = await checkerFixture(t);
  assert.deepEqual(await f.adapter.checkSettings!('{}'), { eligible: true, reasons: [] });
  const trace = (await f.traces())[0]!;
  assert.deepEqual(trace.args.slice(0,3), ['check','lineup','--settings']);
  assert.equal(trace.args[5], join(f.root,'availability.json')); assert.equal(trace.args[6], '--json');
  assert.equal(trace.settingsText, '{}'); assert.equal(trace.fileMode, 0o600); assert.equal(trace.directoryMode, 0o700);
  assert.equal(trace.bytecode, true, '-B prevents bytecode writes into the pinned tools tree');
  assert.deepEqual(Object.keys(trace.env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort(), ['LANG','LC_ALL','NODE_ENV']);
  assert.deepEqual(await readdir(join(f.root,'work')), []);
  assert.deepEqual(await f.adapter.checkSettings!('{"mode":"refuse"}'), { eligible: false,
    reasons: [{ code: 'SYNTHETIC_UNKNOWN_MODEL', explanation: 'Model unavailable' }] });
  assert.deepEqual(await f.adapter.checkSettings!('{"mode":"model-slash"}'), { eligible: false, reasons: [{ code: 'SYNTHETIC_UNKNOWN_MODEL', explanation: 'Model synthetic/vendor unavailable' }] });
  for (const mode of ['large','malformed','badexit','stderr','secret','path','timeout']) {
    await assert.rejects(() => f.adapter.checkSettings!(JSON.stringify({ mode })), /unavailable/, mode);
    assert.deepEqual(await readdir(join(f.root,'work')), [], `${mode} removes temporary files after child close`);
  }
  const pending = f.adapter.checkSettings!('{"mode":"timeout"}');
  const rejected = assert.rejects(pending, /unavailable/);
  await new Promise(resolve => setTimeout(resolve, 100)); await f.adapter.close(); await rejected;
  assert.deepEqual(await readdir(join(f.root,'work')), []);
  await assert.rejects(() => f.adapter.checkSettings!('{}'), /unavailable/);
});

test('P71 commit reauthorizes revoked owner and compares exact defaults hash despite equal effective bytes',async t=>{
  const f=await policyFixture(t),body={expectedVersion:0,settings:'{}'};
  f.setCheck(async()=>{await f.db.query('UPDATE control_role_grants SET revoked_at=$1',[new Date(now).toISOString()]);return{eligible:true,reasons:[]};});
  assert.equal((await f.put('project',body)).status,403,'owner revocation during the external check is refused before commit');
  assert.equal(await f.count(),0);assert.equal((await f.db.query('SELECT * FROM control_loop_policy_layers')).rows.length,0);
  await f.db.query('UPDATE control_role_grants SET revoked_at=NULL');
  f.setCheck(async()=>{f.tools.settingsText=JSON.stringify(JSON.parse(defaults));return{eligible:true,reasons:[]};});
  assert.equal((await f.put('project',body)).status,409,'equivalent defaults with different pinned bytes invalidate the preflight');
  assert.equal(await f.count(),0);assert.equal((await f.db.query('SELECT * FROM control_loop_policy_layers')).rows.length,0);
});

import { canonicalJson } from '../src/security';
import { encodeSelectionSourceBundleV1,selectionSnapshotFromBundleV1 } from '../src/web/v1/loop-selection-snapshot-wire';

/** Synthetic executable only: validates product transport, never qualifies Python policy. */
async function selectedTransportFixture(t:TestContext){
  const f=await checkerFixture(t);await f.adapter.close();
  await mkdir(join(f.root,'roster'),{mode:0o700});
  const roster='synthetic transport roster\n',health={schema_version:1 as const,checked_at:new Date().toISOString(),entries:[{model:'fixture',route:'fixture',available:true}]};
  await writeFile(join(f.root,'roster/roster-export.tsv'),roster,{mode:0o600});
  await writeFile(f.configuration.availabilityFile,JSON.stringify(health),{mode:0o600});
  await chmod(f.configuration.availabilityFile,0o600);
  const script=String.raw`import sys,json,hashlib,time
from pathlib import Path
root=Path(__file__).resolve().parents[3]
a=sys.argv[1:]
s=Path(a[a.index('--settings')+1]).read_bytes()
b=json.loads(Path(a[a.index('--selection-snapshot')+1]).read_text())
c=json.loads(Path(a[a.index('--selection-context')+1]).read_text())
h=json.loads(Path(a[a.index('--availability')+1]).read_text())
with (root/'trace.jsonl').open('a') as f:f.write(json.dumps(dict(args=a,context=c,health=h,settingsText=s.decode()))+'\n')
if json.loads(s).get('hold'):time.sleep(10)
C=lambda v:json.dumps(v,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
H=lambda v:hashlib.sha256(v).hexdigest()
snap=dict(rosterDigest=H(b['roster']['text'].encode()),availabilityDigest=H(C(h)),revision=b['revision'])
eff=dict(model='fixture',route='fixture',effort='medium',family='fixture',**{'class':'frontier','cost':'free'})
p=dict(family_policy='review-only',lineup=[dict(role=role,index=0,requested=eff,effective=eff,refusals=[],fallback=False) for role in ['plan','spec','build','code_reviews','final']],reservedFinal=eff,waivedReasons=[],rosterDigest=snap['rosterDigest'],availabilityDigest=snap['availabilityDigest'])
p['lineupDigest']=H(C(dict(settingsSha256=H(s),snapshot=snap,projection=p)))
print(json.dumps(dict(eligible=True,reasons=[],projection=p,snapshot=snap)))
`;
  await writeFile(f.configuration.entrypoint,script);
  for(const name of ['lineup.py','run_settings.py','selection_contract.py','bridge/a2-contract.mjs','bridge/selection-schema.json'])
    await writeFile(join(f.root,'tools/loop',name),'SYNTHETIC transport pin '+name+'\n');
  const files=['cr.py','lineup.py','run_settings.py','selection_contract.py','bridge/a2-contract.mjs','bridge/selection-schema.json','bridge/cr-entry.py'];
  let manifest='';for(const file of files)manifest+=loopByteHashV1(await readFile(join(f.root,'tools/loop',file)))+'  tools/loop/'+file+'\n';
  await writeFile(f.configuration.toolingManifest,manifest);
  const toolingRevision='sha256:'+sha(manifest),schemaDigest='sha256:'+loopByteHashV1(await readFile(join(f.root,'tools/loop/bridge/selection-schema.json')));
  const capability={schemaVersion:1 as const,revision:'b8-selection-review-only/1' as const,schemaDigest,
    encodeContext(value:unknown){return canonicalJson(value);},decodeResult(value:any,pins:{settingsSha256:string}){
      const {lineupDigest,...rest}=value.projection;
      assert.equal(lineupDigest,sha(canonicalJson({settingsSha256:pins.settingsSha256,snapshot:value.snapshot,projection:rest})));return value;
    }};
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,toolingRevision,
    entrypointSha256:sha(script),availabilitySha256:sha(JSON.stringify(health)),
    contract:{...f.configuration.contract,lineage:{...f.configuration.contract.lineage,toolingRevision},selectionProjection:capability,
      qualifiedOperations:['intake'],admissionExpectation:()=>({})}});t.after(()=>adapter.close());
  const sources=adapter.selectionSources!;sources.initialize();
  const bundle={schemaVersion:1 as const,revision:'selection-source-v1:'+'a'.repeat(32),roster:{version:'1',exportedVersion:'1',text:roster},availability:health};
  const lease=sources.acquire();try{sources.publish(lease,bundle);}finally{lease.release();}
  return {...f,adapter,sources,bundle,capability,toolingRevision};
}

test('T-SNAPSHOT selected transport copies exact settings context bundle health and captures immutable codec',async t=>{
  const f=await selectedTransportFixture(t),context={mode:'preview' as const,sameFamilyIntent:false};
  f.capability.encodeContext=()=>{throw Error('mutated supplier method must not run');};
  const text=' {"project":{"host_adapter":"local-loop"},"kept":"é"}\n';
  const value=await f.adapter.checkSettings!(text,context);assert.equal(value.eligible,true);
  assert.deepEqual(value.snapshot,selectionSnapshotFromBundleV1(f.bundle));
  const [trace]=await f.traces();assert.equal(trace.settingsText,text);assert.deepEqual(trace.context,context);assert.deepEqual(trace.health,f.bundle.availability);
  assert.deepEqual(trace.args.slice(0,2),['check','lineup']);assert.ok(trace.args.includes('--selection-context'));assert.ok(trace.args.includes('--selection-snapshot'));
  assert.deepEqual(await readdir(join(f.root,'work')),[]);
});

test('T-SNAPSHOT selected transport refuses changed manifest bytes, schema pin and source revision',async t=>{
  const f=await selectedTransportFixture(t),ctx={mode:'preview' as const,sameFamilyIntent:false};
  const file=join(f.root,'tools/loop/selection_contract.py'),old=await readFile(file);
  await writeFile(file,'changed');await assert.rejects(Promise.resolve().then(()=>f.adapter.checkSettings!('{}',ctx)));await writeFile(file,old);
  const lease=f.sources.acquire();try{f.sources.invalidate(lease);}finally{lease.release();}
  await assert.rejects(f.adapter.checkSettings!('{}',ctx));
  assert.equal(await readFile(join(f.root,'trace.jsonl'),'utf8').catch(()=>''),'','refused before checker spawn');
});

test('T-SNAPSHOT selected cancellation reaps child and removes owned temporary directory',async t=>{
  const f=await selectedTransportFixture(t),controller=new AbortController();
  const pending=f.adapter.checkSettings!('{"hold":true}',{mode:'preview',sameFamilyIntent:false},{signal:controller.signal,timeoutMs:500});
  const timer=setTimeout(()=>controller.abort(),200);try{await assert.rejects(pending);}finally{clearTimeout(timer);}
  assert.equal((await f.traces()).length,1,'cancellation must reap a child that actually entered the checker');
  assert.deepEqual(await readdir(join(f.root,'work')),[]);
});

test('T-SNAPSHOT dispatch capsule binds complete command before spawn callback',async t=>{
  const f=await selectedTransportFixture(t),commandId='loop-command:'+'a'.repeat(32),text='{"project":{"host_adapter":"local-loop"}}';let spawnCallbacks=0;
  const binding={schemaVersion:1,body:{description:'fixture'},localVersion:1,adapterId:f.adapter.adapterId,loopRunId:'fixture-run',toolingRevision:f.toolingRevision,
    a2SchemaVersion:1,schemaDigest:f.adapter.schemaDigest,requestSha256:sha('fixture'),settingsSha256:sha(text),runLinkId:null,authorizationId:null,
    inputVersion:null,expectedRevision:null,evidence:null} as import('../src/improve-control-room/v1/schemas').LoopBridgeBindingV1;
  await assert.rejects(f.adapter.intake(commandId,binding,'fixture',()=>{spawnCallbacks++;},text,
    {commandId,bindingDigest:'sha256:'+'0'.repeat(64),snapshot:selectionSnapshotFromBundleV1(f.bundle),lineupDigest:'b'.repeat(64)}));
  assert.equal(spawnCallbacks,0,'capsule mismatch cannot reach the spawn boundary');
});
