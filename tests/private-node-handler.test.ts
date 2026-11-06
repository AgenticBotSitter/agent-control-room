import assert from "node:assert/strict";
import test from "node:test";
import { createMacLocalNodeHandler, createPrivateNodeHandler, createLocalSetupNodeHandler } from "../src/web/v1/private-node-handler";
import { createLoopPolicyHttpHandlerV1 } from "../src/web/v1/loop-policy-http";
import { LoopPolicyServiceV1 } from "../src/web/v1/loop-policy-service";
import { LOCAL_OWNER_SESSION_PROFILE_V1, LocalOwnerSessionServiceV1 } from "../src/web/v1/local-owner-session";
import { sha256Digest } from "../src/security";
import { taskFixture } from "./helpers/web-task";
import { nodeExchange } from "./helpers/web-node";
import { now, origin as privateOrigin, token, trust } from "./helpers/web-foundation";

for (const mode of ['private', 'Mac-local'] as const) {
  test(`P71 ${mode} Node PUT persists and replays project and selection through authenticated policy handler`, async t => {
    const f = await taskFixture(); t.after(() => f.db.close());
    await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb) WHERE id=$1`, [f.project.projectId]);
    const origin = mode === 'private' ? privateOrigin : 'http://127.0.0.1:54321';
    let checks = 0, calls = 0;
    const service = new LoopPolicyServiceV1(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
      { settingsText: '{}', checkSettings: async () => { checks++; return { eligible: true, reasons: [] }; } }, () => now);
    const ownerCode = 'synthetic-policy-owner-code-0001';
    const local = mode === 'Mac-local' ? new LocalOwnerSessionServiceV1({ schema: LOCAL_OWNER_SESSION_PROFILE_V1,
      origin, tenantId: 'tenant:web', provider: trust.issuer, subject: 'test-owner', ownerCodeDigest: sha256Digest({ ownerCode }), sessionSeconds: 900 }) : undefined;
    const cookie = local ? (await local.issue(new Request(`${origin}/api/v1/local-owner-session`,
      { method: 'POST', headers: { origin } }), ownerCode, now)).cookie.split(';')[0]! : undefined;
    const policy = createLoopPolicyHttpHandlerV1({ origin, service, clock: () => now,
      ...(local ? { localOwnerSession: local } : { trust }) });
    const transport = (mode === 'private' ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
      application: { isReady: () => true, close: async () => {} }, assets: { count: 0, digest: "fixture", respond: () => undefined },
      handler: request => { calls++; return policy(request); } });
    const exchange = async (path: string, body: unknown, key: string, options: { anonymous?: boolean; foreign?: boolean } = {}) => {
      const text = JSON.stringify(body);
      const headers = ['Origin', options.foreign ? 'https://foreign.example.invalid' : origin, 'Content-Type', 'application/json',
        'Content-Length', String(Buffer.byteLength(text)), 'Idempotency-Key', key];
      if (!options.anonymous) headers.push(...(cookie ? ['Cookie', cookie] : ['Cf-Access-Jwt-Assertion', token()]));
      const e = nodeExchange({ method: 'PUT', path, body: text, headers }); e.input.rawHeaders[1] = new URL(origin).host;
      try { await transport.handle(e.input, e.output); return { status: e.output.statusCode, body: e.body() }; }
      finally { e.input.destroy(); e.output.destroy(); }
    };
    const base = `/api/v1/projects/${encodeURIComponent(f.project.projectId)}/loop-policy`;
    try {
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 0, settings: '{}' }, 'p72-node-missing-locks-0001')).status, 400);
      assert.equal(checks, 0, 'missing lockedPaths refuses before check or persistence');
      assert.equal((await f.db.query('SELECT * FROM control_loop_policy_events')).rows.length, 0);
      for (const layer of ['project', 'selection'] as const) {
        const body = { expectedVersion: 0, settings: JSON.stringify({ fixture: layer }), ...(layer === 'project' ? { lockedPaths: [] } : {}) }, key = `p71-node-${layer}-key-0001`;
        const first = await exchange(`${base}/${layer}`, body, key);
        assert.equal(first.status, 201, `${mode} ${layer} PUT reaches actual policy handler`);
        assert.deepEqual(JSON.parse(first.body), { replayed: false, version: 1 });
        const replay = await exchange(`${base}/${layer}`, body, key); assert.equal(replay.status, 200);
        assert.deepEqual(JSON.parse(replay.body), { replayed: true, version: 1 });
      }
      const identity = local ? local.verify(new Request(origin, { headers: { cookie: cookie! } }), now) : f.identity;
      assert.deepEqual(await service.view(identity, f.project.projectId), { project: { version: 1, settingsText: '{"fixture":"project"}', lockedPaths: [] }, selection: { version: 1, settingsText: '{"fixture":"selection"}' } });
      const rows = async () => ({ layers: (await f.db.query('SELECT * FROM control_loop_policy_layers ORDER BY layer')).rows,
        events: (await f.db.query('SELECT * FROM control_loop_policy_events ORDER BY layer')).rows });
      const saved = await rows(); assert.equal(saved.layers.length, 2); assert.equal(saved.events.length, 2); assert.equal(checks, 2);
      for (const [index, layer] of ['project', 'selection'].entries()) {
        const row = saved.layers[index] as Record<string, unknown>, event = saved.events[index] as Record<string, unknown>;
        assert.equal(row.layer, layer); assert.equal(Number(row.version), 1);
        assert.equal(row.settings_text, JSON.stringify({ fixture: layer }));
        assert.equal(row.settings_sha256, sha256Digest({ fixture: layer }).slice('sha256:'.length));
        assert.equal(event.layer, layer); assert.equal(Number(event.version), 1); assert.equal(event.before_sha256, null);
        assert.equal(event.after_sha256, row.settings_sha256);
      }
      for (const path of [`${base}/other`, `${base}/project/`, `${base}/selection?x=1`, `${base}/project/extra`,
        '/api/v1/loop-providers/fixture/extra', '/api/v1/loop-providers/UPPER', '/api/v1/loop-providers/ab',
        '/api/v1/loop-providers/fixture/', '/api/v1/loop-providers/fixture?x=1', '/api/v1/unrelated']) {
        const before = calls;
        assert.equal((await exchange(path, {}, 'p71-node-neighbour-0001')).status, 405, path); assert.equal(calls, before);
      }
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: '{}', lockedPaths: [] }, 'p71-node-anonymous-0001', { anonymous: true })).status, 401);
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: '{}', lockedPaths: [] }, 'p71-node-foreign-0001', { foreign: true })).status, 403);
      await f.db.query("UPDATE control_role_grants SET role_key='operator'");
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: '{}', lockedPaths: [] }, 'p71-node-operator-0001')).status, 403);
      await f.db.query("UPDATE control_role_grants SET role_key='owner'");
      const before = calls;
      assert.equal((await exchange(`${base}/project`, { expectedVersion: 1, settings: 'x'.repeat(8200), lockedPaths: [] }, 'p71-node-oversize-0001')).status, 413);
      assert.equal(calls, before); assert.equal(checks, 2); assert.deepEqual(await rows(), saved);
    } finally { await transport.close(); }
  });

  test(`P71 ${mode} Node admits only bounded provider PUT and retains existing edit routes`, async () => {
    const origin = mode === 'private' ? privateOrigin : 'http://127.0.0.1:54321'; let calls = 0;
    const transport = (mode === 'private' ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
      application: { isReady: () => true, close: async () => {} }, assets: { count: 0, digest: "fixture", respond: () => undefined },
      handler: async request => { calls++; assert.deepEqual(await request.json(), { expectedVersion: 0 }); return Response.json({ ok: true }); } });
    try {
      for (const path of ['/api/v1/loop-providers/fixture-provider', '/api/v1/projects/fixture/skills/item', '/api/v1/projects/fixture/recurring-rules/item']) {
        const body = JSON.stringify({ expectedVersion: 0 });
        const e = nodeExchange({ path, method: 'PUT', body, headers: ['Origin', origin, 'Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body))] });
        e.input.rawHeaders[1] = new URL(origin).host;
        try { await transport.handle(e.input, e.output); assert.equal(e.output.statusCode, 200, path); }
        finally { e.input.destroy(); e.output.destroy(); }
      }
      assert.equal(calls, 3);
    } finally { await transport.close(); }
  });
}

test('P71 read-only setup transport continues to refuse policy and provider PUT', async () => {
  let calls = 0;
  const transport = createLocalSetupNodeHandler({ origin: 'http://127.0.0.1:3000',
    isReady: () => true, close: async () => {}, assets: { count: 0, digest: "fixture", respond: () => undefined },
    planSource: { read: async () => ({ schema: "control-room.local-setup-journal-source/v1", status: "unavailable", performsEffect: false, permitsRetry: false }) },
    renderSetupPage: () => { calls++; return new Response('unexpected'); } });
  try {
    for (const path of ['/api/v1/loop-providers/fixture-provider', '/api/v1/projects/fixture/loop-policy/project']) {
      const e = nodeExchange({ path, method: 'PUT' }); e.input.rawHeaders[1] = '127.0.0.1:3000';
      try { await transport.handle(e.input, e.output); assert.equal(e.output.statusCode, 405); }
      finally { e.input.destroy(); e.output.destroy(); }
    }
    assert.equal(calls, 0);
  } finally { await transport.close(); }
});
