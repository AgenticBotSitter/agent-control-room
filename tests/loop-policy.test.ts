// Required macOS host gates, lt-a2pin 03c3595 (no skips or fixture replacement):
// export CONTROL_ROOM_A2_TEST_LOOP="<pinned lead-tools checkout>/loop"
// test -n "$CONTROL_ROOM_A2_TEST_LOOP" && node --import tsx --test --test-name-pattern='^P71 real settings check$' tests/loop-policy.test.ts
// test -n "$CONTROL_ROOM_A2_TEST_LOOP" && node --import tsx --test --test-name-pattern='^P71 real provider settings check$' tests/loop-policy.test.ts
// Linux CI uses test:improve-control-room:linux-without-macos-host-gates. Its explicit
// name-pattern excludes only these two cases: the pin's interpreter shim is macOS-only.
// <root> is Node's synthetic ancestor: matching it would include every child test.
// The Mac lane and either exact command still FAIL if CONTROL_ROOM_A2_TEST_LOOP is missing.
// test:improve-control-room dispatches by host OS, preserving the frozen CI lane registration.
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

test("P71 Linux CI excludes exactly two macOS host gates without skip-as-pass", async t => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8'));
  const name = 'test:improve-control-room:linux-without-macos-host-gates';
  const lane = scripts[name] as string;
  const filter = / --test-name-pattern='([^']+)'/.exec(lane);
  assert.ok(filter, 'Linux lane names its two host-gate exclusions explicitly');
  const dispatcher = scripts['test:improve-control-room'] as string;
  assert.ok(dispatcher.startsWith(`if [ "$(uname -s)" = Linux ]; then pnpm run ${name}; else `));
  const host = dispatcher.split('; else ')[1]!.replace(/; fi$/, '');
  assert.equal(lane.replace(filter[0], ''), host, 'all other files and options stay in the lane');
  assert.doesNotMatch(lane, /skip|\|\|/);
  assert.match(scripts['test:components'], /pnpm test:improve-control-room(?: &&|$)/);
  assert.ok((await readFile('.github/workflows/ci.yml','utf8')).includes(' test:improve-control-room '));
  assert.match(scripts['test:loop-policy:real'] ?? '', /--test-name-pattern=['"]\^P71 real settings check\$['"]/);
  assert.doesNotMatch(scripts['test:loop-policy:real'], /skip|\|\|/);
  await mkdir(resolve('.test-tmp'), { recursive: true });
  const root = await mkdtemp(resolve('.test-tmp/p71-ci-filter-')); t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'ci.mjs');
  await writeFile(file, `import test from 'node:test'; import assert from 'node:assert/strict';
    test('P71 real settings check', () => assert.fail('macOS host gate must be separate'));
    test('P71 real provider settings check', () => assert.fail('macOS host gate must be separate'));
    test('ordinary policy check', () => assert.ok(true));
    test('P71 real settings check neighbour', () => assert.ok(true));
    test('P71 real provider settings check neighbour', () => assert.ok(true));
    test('prefix P71 real settings check', () => assert.ok(true));`);
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const { stdout } = await promisify(execFile)(process.execPath, ['--test', `--test-name-pattern=${filter[1]}`, file], { env, timeout: 10000 });
  assert.match(stdout, /# pass 4/); assert.match(stdout, /# fail 0/); assert.match(stdout, /# skipped 0/);
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
async function realSettingsFixture(t: TestContext) {
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
  const bootstrap=String.raw`import sys,json,shutil
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from test_a2_bridge import Bridge
d=Bridge();d.setUp()
try:
 p,_=d.prepare_intake()
 args=list(d.intake_args(p))
 availability=Path(args[args.index('--availability')+1]).read_text()
 # Preserve the repository under the adapter's confined work root before cleanup.
 repository=Path(sys.argv[2])/'work/repo'
 shutil.copytree(d.root/'repo',repository)
 settings=json.loads(d.settings_path.read_text())
 settings['project']['repository']=str(repository)
 print(json.dumps(dict(settings=json.dumps(settings),availability=availability,roster=d.roster.read_text())))
finally:
 d.doCleanups()
`;
  const {stdout}=await promisify(execFile)(interpreter,['-B','-c',bootstrap,loop,f.root],{cwd:f.root,timeout:30000,maxBuffer:131072,
    env:{PATH:'/usr/bin:/bin',TMPDIR:f.root,CONTROL_ROOM_TEST_BLOCK_AGENT_CLI:'1',PYTHONDONTWRITEBYTECODE:'1',NODE_ENV:'test'}});
  const fixture=JSON.parse(stdout) as {settings:string;availability:string;roster:string};
  await cp(loop,join(f.root,'tools/loop'),{recursive:true,filter:path=>!path.includes('__pycache__')&&!/(?:^|[/\\])(?:\.git|\.env(?:\.[^/]*)?|\.codex|\.hermes|\.aws|auth\.json|tokens?)(?:[/\\]|$)/i.test(path)});
  await cp(join(dirname(loop),'bin/lib'),join(f.root,'tools/bin/lib'),{recursive:true,filter:path=>!path.includes('__pycache__')&&!/(?:^|[/\\])(?:\.env(?:\.[^/]*)?|\.codex|\.hermes|\.aws|auth\.json|tokens?)(?:[/\\]|$)/i.test(path)});
  await writeFile(join(f.root,'tools/loop/models.tsv'),fixture.roster);
  await writeFile(join(f.root,'settings.json'),fixture.settings);await writeFile(join(f.root,'availability.json'),fixture.availability);
  const entrypoint=join(f.root,'tools/loop/bridge/cr-entry.py');
  const manifest=JSON.stringify({cr:sha(await readFile(join(f.root,'tools/loop/cr.py'),'utf8')),bridge:sha(await readFile(entrypoint,'utf8'))});
  await writeFile(join(f.root,'tooling.json'),manifest);
  const toolingRevision=`sha256:${sha(manifest)}`;
  const adapter=createImproveControlRoomLoopAdapterV1({...f.configuration,interpreter,interpreterSha256:loopByteHashV1(await readFile(interpreter)),
    entrypointSha256:loopByteHashV1(await readFile(entrypoint)),settingsSha256:sha(fixture.settings),availabilitySha256:sha(fixture.availability),
    toolingRevision,contract:{...f.configuration.contract,lineage:{...f.configuration.contract.lineage,toolingRevision}}});
  t.after(()=>adapter.close());
  return {adapter,settingsText:fixture.settings,root:f.root};
}

test("P71 real settings check", async t => {
  const {adapter,settingsText,root}=await realSettingsFixture(t);
  const fixture={settings:settingsText};
  const initialCheck=await adapter.checkSettings!(fixture.settings);
  assert.equal(initialCheck.eligible,true,`real cr accepts its qualified fixture defaults: ${JSON.stringify(initialCheck.reasons)}`);
  const composed=composeLoopSettingsV1({defaultsText:fixture.settings,project:'{}',selection:'{}',runEdits:'{}'});
  assert.equal((await adapter.checkSettings!(composed.text)).eligible,true,'real cr accepts deterministic merged encoding');
  await mkdir(join(root,'skills'),{recursive:true});
  await writeFile(join(root,'skills','recorded.md'),'Recorded skill fixture.');
  const paths=JSON.parse(settingsText);
  paths.project.skills=['recorded.md'];
  paths.project.outputs=['recorded-output.md'];
  assert.equal((await adapter.checkSettings!(JSON.stringify(paths))).eligible,true,'real cr accepts the explicit confined skills root and repository outputs');
  await symlink(join(root,'work'),join(root,'skills','escape'));
  paths.project.skills=['escape/outside-skill.md'];
  assert.equal((await adapter.checkSettings!(JSON.stringify(paths))).eligible,false,'real cr refuses a skill outside the configured root');
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
  const refusal=await adapter.checkSettings!(JSON.stringify(unknown));
  assert.equal(refusal.eligible,false);assert.ok(refusal.reasons.length>0,'real exit-3 refusal preserves the tools reason');
  console.log(`P71 real direct cr checks=5 valid=true unknown_model=false reason=${refusal.reasons[0]!.code}`);
  // Real intake/Start path independence, check-side final-family refusal, merge-rule parity and recovery require separate release evidence;
  // a passing direct checker alone does not confer POLICY-STORE-GREEN.
});

import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
if mode.startswith('envelope'):
 result=dict(schema_version=1,eligible=True,slots={},candidates={},reasons=[],reserved_final=None,fallback=False,roster_digest=None,availability_digest=None)
 # Recorded shapes from lt-a2pin 03c3595 lineup.py:52,287-315 and cr.py:736-772.
 # Top-level reasons add slot/model; slot and candidate reasons retain the base reason.
 if mode in ('envelope-waived','envelope-accepted','envelope-mixed','envelope-blocked','envelope-eligible-unwaived','envelope-ineligible-waived','envelope-exit-zero','envelope-exit-three'):
  reason=dict(code='FINAL_REVIEW_FALLBACK',explanation='No eligible unused final family remains; a reviewer-only family may provide final.',waived=True)
  if mode=='envelope-accepted': reason=dict(code='FINAL_BUILDER_FAMILY',explanation="The owner accepted the risk of a final from the builder's family.",waived=True)
  reasons=[reason]
  if mode in ('envelope-mixed','envelope-blocked','envelope-eligible-unwaived','envelope-exit-zero'):
   blocked=dict(code='FAMILY_BUILDER',explanation='Review family conflicts with the builder.',waived=False)
   reasons=([reason,blocked] if mode=='envelope-mixed' else [blocked])
  eligible=mode not in ('envelope-mixed','envelope-blocked','envelope-ineligible-waived','envelope-exit-zero')
  selection=dict(model='reviewer',route='codex',effort='high')
  fallback=mode!='envelope-accepted'
  result.update(eligible=eligible,fallback=fallback,reserved_final='reviewer',roster_digest='a'*64,availability_digest='b'*64,
   reasons=[dict(r,slot='final',model='reviewer') for r in reasons],
   slots={'final':dict(selection,role='final',requested_effort='high',eligible=eligible,reasons=reasons,chain_eligible=eligible,fallback=fallback)},
   candidates={'final':[dict(selection,provider='synthetic',family='reviewer-family',**{'class':'frontier'},eligible=eligible,reasons=reasons,recommended=eligible,fallback=fallback)]})
  if mode=='envelope-accepted':
   result['same_family_warnings']=[dict(code='same-family-accepted',rule='R296',run='synthetic-run',accepted_at='2026-01-01T00:00:00Z',conflicts=['FINAL_BUILDER_FAMILY'],explanation='The owner accepted the risk of same-family work; other families are available.')]
 # Exact recorded output of pinned check_role(final), two frontier families, no provider calls.
 if mode=='envelope-recorded-fallback': result=json.loads(r"""{"schema_version":1,"eligible":true,"slots":{"final":{"role":"final","model":"review-front","route":"codex","effort":"medium","requested_effort":"medium","eligible":true,"reasons":[{"code":"FINAL_REVIEW_FALLBACK","explanation":"No eligible unused final family remains; a reviewer-only family may provide final.","waived":true}],"chain_eligible":true,"fallback":true}},"candidates":{"final":[{"model":"build-front","route":"codex","provider":"codex","family":"build-family","class":"frontier","effort":"medium","eligible":false,"reasons":[{"code":"FINAL_BUILDER_FAMILY","explanation":"The final must NEVER come from the builder's family, under any override or legacy flag.","waived":false}],"recommended":false,"fallback":false},{"model":"review-front","route":"codex","provider":"codex","family":"review-family","class":"frontier","effort":"medium","eligible":true,"reasons":[{"code":"FINAL_REVIEW_FALLBACK","explanation":"No eligible unused final family remains; a reviewer-only family may provide final.","waived":true}],"recommended":true,"fallback":true}]},"reasons":[{"code":"FINAL_REVIEW_FALLBACK","explanation":"No eligible unused final family remains; a reviewer-only family may provide final.","waived":true,"slot":"final","model":"review-front"}],"reserved_final":"review-front","fallback":true,"roster_digest":"d8ed70d137a3a217148b8620cdbb5d4468b44f07e51cb2c05c228ab7bd9316f0","availability_digest":"27c03762c9bcbf197b7c2434ca20857bc8fcdd732a65d65bdcf1cf0f53646bc4"}""")
 if mode=='envelope-bad-type': result['fallback']='false'
 if mode=='envelope-bad-field': result['unexpected']=True
 if mode=='envelope-bad-slot': result['slots']={'build':True}
 if mode=='envelope-bad-reason': result.update(eligible=False,reasons=[dict(code='REFUSED',explanation='Refused',waived='false')])
 print(json.dumps(result));sys.exit(0 if mode=='envelope-exit-zero' else 3 if mode=='envelope-exit-three' else 0 if result['eligible'] else 3)
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
  assert.deepEqual(Object.keys(trace.env).filter(key => key !== '__CF_USER_TEXT_ENCODING').sort(), ['CR_CONFIG_ROOT','CR_RUNS','CR_SKILLS','CR_WORK_ROOT','LANG','LC_ALL','NODE_ENV']);
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


test('P71 direct checker projects the pinned lineup envelope and refuses unexpected shapes', async t => {
 const f=await checkerFixture(t);
 assert.deepEqual(await f.adapter.checkSettings!('{"mode":"envelope"}'),{eligible:true,reasons:[]});
 for(const mode of ['recorded-fallback','waived','accepted'])
  assert.deepEqual(await f.adapter.checkSettings!(JSON.stringify({mode:`envelope-${mode}`})),{eligible:true,reasons:[]},mode);
 for(const mode of ['mixed','blocked'])
  assert.deepEqual(await f.adapter.checkSettings!(JSON.stringify({mode:`envelope-${mode}`})),{eligible:false,reasons:[{code:'FAMILY_BUILDER',explanation:'Review family conflicts with the builder.'}]},mode);
 for(const mode of ['eligible-unwaived','ineligible-waived','exit-zero','exit-three'])
  await assert.rejects(f.adapter.checkSettings!(JSON.stringify({mode:`envelope-${mode}`})),/unavailable/,mode);
 for(const mode of ['type','field','slot','reason'])
  await assert.rejects(f.adapter.checkSettings!(JSON.stringify({mode:`envelope-bad-${mode}`})),/unavailable/,mode);
});


test('P71 real provider settings check',async t=>{
 const real=await realSettingsFixture(t),f=await policyFixture(t);
 assert.equal((await real.adapter.checkSettings!(real.settingsText)).eligible,true,'same fixture defaults must pass before adding providerRoute');
 const {LoopProviderServiceV1}=await import('../src/web/v1/loop-provider-service');
 const providers=new LoopProviderServiceV1(f.client,scope,{availability:async()=>{throw new Error('no credential probe');}},()=>now);
 await f.db.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
 VALUES('tenant:web','writer',1,'codex','','','','','','','','on','','','','identity:web',$1)`,[new Date(now).toISOString()]);
 for(const [i,id] of ['provider-one','provider-two'].entries())await providers.upsert(f.identity,id,{expectedVersion:i,provider:{
  provider_id:id,display_name:id,base_url:'https://example.com/api',billing_kind:'subscription',secret_ref:{kind:'launcher',launcher:'codex'},
  models:[{roster_name:'writer',launcher:'codex',served_model_id:`served/${id}`}],credit_amount_nano_usd:null,credit_expires_on:null,credit_note:'',price_source_url:null,price_source_format:null}},key());
 let checked=0;
 const tools={settingsText:real.settingsText,checkSettings:async(text:string)=>{
  assert.deepEqual(JSON.parse(text).providerRoute,{providerId:'provider-two',model:'writer'},'real cr must see the exact route');
  const result=await real.adapter.checkSettings!(text);checked++;
  console.log(`P71 providerRoute real cr eligible=${result.eligible} reasons=${result.reasons.map(r=>r.code).join(',')}`);
  return result;
 }};
 const policy=new LoopPolicyServiceV1(f.client,scope,tools,()=>now,providers);
 const handler=createLoopPolicyHttpHandlerV1({origin,trust,service:policy,clock:()=>now});
 const route={providerId:'provider-two',model:'writer'};
 const response=await handler(request(`${f.path}/selection`,'PUT',{expectedVersion:0,settings:JSON.stringify({providerRoute:route})},key()));
 const body=await response.clone().text();
 if(response.status!==201){
  assert.equal((await f.db.query('SELECT * FROM control_loop_policy_events')).rows.length,0);
  assert.equal((await f.db.query('SELECT * FROM control_loop_policy_layers')).rows.length,0);
  console.log('P71 refused providerRoute leaves layers=0 events=0');
 }
 assert.equal(checked,1);assert.equal(response.status,201,body);
 assert.equal((await f.db.query('SELECT * FROM control_loop_policy_events')).rows.length,1);
 assert.equal((await f.db.query('SELECT * FROM control_loop_policy_layers')).rows.length,1);
 const snapshot=await f.client.transaction(tx=>policy.snapshot(tx,f.project.projectId));
 const {ImproveControlRoomLoopServiceV1}=await import('../src/web/v1/improve-control-room-loop-service');
 const intake=recordedIntakeAdapter(tools);
 const bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:new Uint8Array(32).fill(65),adapter:intake.adapter,policy},()=>now);
 const saved=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description:'Synthetic provider choice'},key());
 assert.equal(saved.state,'accepted');
 const input=(await f.db.query<{settings_text:string;settings_sha256:string;auth_tag:string}>('SELECT * FROM control_loop_improvement_inputs WHERE request_id=$1',[saved.requestId])).rows[0]!;
 assert.deepEqual(JSON.parse(input.settings_text).providerRoute,route);assert.equal(input.settings_sha256,sha(input.settings_text));assert.match(input.auth_tag,/^hmac-sha256:/);
 assert.equal(intake.signedText(),input.settings_text,'intake adapter sees the exact signed copy');
 console.log('P71 real provider selection PUT: cr exit=0 eligible=true layers=1 events=1 signed route=provider-two/writer');
});

test('S3 providerRoute is complete strict non-null in every source and after composition',()=>{
 const valid={providerId:'provider-two',model:'synthetic/model'};
 for(const source of ['defaultsText','project','selection','runEdits'] as const){
  for(const route of [null,{}, {providerId:'provider-two'},{model:'synthetic/model'}, {...valid,extra:true},{...valid,providerId:'UPPER'},{...valid,model:''}])
   assert.throws(()=>composeLoopSettingsV1({defaultsText:'{}',[source]:JSON.stringify({providerRoute:route})}),refused,`${source} ${JSON.stringify(route)}`);
 }
 assert.throws(()=>composeLoopSettingsV1({defaultsText:JSON.stringify({providerRoute:valid}),selection:'{"providerRoute":{"providerId":"provider-one"}}'}),refused,'partial overrides cannot borrow a model');
 assert.deepEqual(JSON.parse(composeLoopSettingsV1({defaultsText:JSON.stringify({providerRoute:valid}),selection:'{"providerRoute":{"providerId":"provider-one","model":"other/model"}}'}).text).providerRoute,{providerId:'provider-one',model:'other/model'});
});

test('S3 selection revalidates provider mapping on save snapshot and after external check',async t=>{
 const f=await policyFixture(t);
 const {LoopProviderServiceV1}=await import('../src/web/v1/loop-provider-service');
 const providers=new LoopProviderServiceV1(f.client,scope,{availability:async()=>{throw new Error('no secret probe');}},()=>now);
 await f.db.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
 VALUES('tenant:web','synthetic/model',1,'synthetic-api','','','','','','','','on','','','','identity:web',$1)`,[new Date(now).toISOString()]);
 for(const [i,id] of ['provider-one','provider-two'].entries())await providers.upsert(f.identity,id,{expectedVersion:i,provider:{provider_id:id,display_name:id,base_url:'https://example.com/api',billing_kind:'subscription',secret_ref:{kind:'launcher',launcher:'synthetic-api'},models:[{roster_name:'synthetic/model',launcher:'synthetic-api',served_model_id:`served/${id}`}],credit_amount_nano_usd:null,credit_expires_on:null,credit_note:'',price_source_url:null,price_source_format:null}},key());
 // Fifth argument is the provider validator used by both process factories.
 const policy=new LoopPolicyServiceV1(f.client,scope,f.tools,()=>now,providers);
 const handler=createLoopPolicyHttpHandlerV1({origin,trust,service:policy,clock:()=>now});
 const route={providerId:'provider-two',model:'synthetic/model'},settings=JSON.stringify({providerRoute:route});
 assert.equal((await handler(request(`${f.path}/selection`,'PUT',{expectedVersion:0,settings},key()))).status,201);
 assert.deepEqual(JSON.parse((await policy.view(f.identity,f.project.projectId)).selection.settingsText).providerRoute,route);
 const snapshot=await f.client.transaction(tx=>policy.snapshot(tx,f.project.projectId));assert.deepEqual(JSON.parse(snapshot.text).providerRoute,route);
 const restart=new LoopPolicyServiceV1(f.client,scope,f.tools,()=>now,providers);
 assert.deepEqual(JSON.parse((await restart.view(f.identity,f.project.projectId)).selection.settingsText).providerRoute,route);
 for(const invalid of [null,{}, {...route,extra:true}])assert.equal((await handler(request(`${f.path}/selection`,'PUT',{expectedVersion:1,settings:JSON.stringify({providerRoute:invalid})},key()))).status,400);
 assert.equal((await handler(request(`${f.path}/selection`,'PUT',{expectedVersion:1,settings:JSON.stringify({providerRoute:{...route,model:'served/provider-two'}})},key()))).status,422);
 const intake=recordedIntakeAdapter(f.tools),{ImproveControlRoomLoopServiceV1}=await import('../src/web/v1/improve-control-room-loop-service');
 const bridge=new ImproveControlRoomLoopServiceV1(f.client,scope,{integrityKey:new Uint8Array(32).fill(65),adapter:intake.adapter,policy},()=>now);
 const receipt=await bridge.mutate(f.identity,f.project.projectId,null,'intake',{description:'Recorded route survives intake'},key());
 assert.equal(receipt.state,'accepted');
 const history=(await f.db.query('SELECT * FROM control_loop_improvement_inputs WHERE request_id=$1',[receipt.requestId])).rows;
 assert.equal(intake.signedText(),snapshot.text);

 f.setCheck(async()=>{await providers.remove(f.identity,'provider-two',{expectedVersion:2},key());return{eligible:true,reasons:[]};});
 const changed=await handler(request(`${f.path}/selection`,'PUT',{expectedVersion:1,settings},key()));
 assert.equal(changed.status,422,'mapping withdrawal during check must refuse the commit');assert.match(await changed.text(),/Provider removed/);
 assert.equal(await f.count(),1);assert.equal((await policy.view(f.identity,f.project.projectId)).selection.version,1);
 await assert.rejects(f.client.transaction(tx=>policy.snapshot(tx,f.project.projectId)),/loop_policy_refused/);
 assert.deepEqual((await f.db.query('SELECT * FROM control_loop_improvement_inputs WHERE request_id=$1',[receipt.requestId])).rows,history,'withdrawal does not rewrite signed history');
});

// Deterministic in-process intake receipt. It cannot execute Start or a provider.
function recordedIntakeAdapter(tools: {settingsText:string;checkSettings(text:string):Promise<{eligible:boolean;reasons:{code:string;explanation:string}[]}>}) {
 let signed:string|undefined;
 const toolingRevision='sha256:'+'a'.repeat(64);
 const unused=async():Promise<never>=>{throw new Error('unexpected recorded operation');};
 const adapter:import('../src/web/v1/improve-control-room-loop-adapter').LoopAdapterV1={
  adapterId:'adapter:s3-recorded',toolingRevision,schemaDigest:'sha256:'+'b'.repeat(64),...tools,
  contract:{toolingRevision,decodeRunIdentity:v=>loopImprovementRunIdentitySchemaV1.parse(v),decodeObservation:v=>loopImprovementObservationSchemaV1.parse(v),matchesSavedInput:()=>false},
  reserveRun:()=>`recorded-run-${++sequence}`,available:operation=>operation==='intake',
  intake:async(commandId,binding,text,beforeSpawn,settings)=>{
   beforeSpawn();signed=settings;assert.equal(sha(settings!),binding.settingsSha256);
   return {run:{adapterId:binding.adapterId,loopRunId:binding.loopRunId,toolingRevision,a2SchemaVersion:1},revision:1,inputVersion:1,state:'draft',description:text,settingsSha256:sha(settings!),settingsDigest:sha(settings!),confirmation:null,approval:null,question:null,progress:{step:'intake',completed:0,attention:'none'},receipts:[{commandId,bindingDigest:(await import('../src/security')).sha256Digest(binding),state:'accepted',error:null,evidenceDigest:'sha256:'+'c'.repeat(64)}]};
  },confirmRequest:unused,start:unused,stop:unused,approve:unused,answer:unused,status:unused,close:async()=>{},
 };
 return {adapter,signedText:()=>signed};
}
