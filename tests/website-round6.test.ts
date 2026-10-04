import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { sha256Digest } from '../src/security';
import { createAccessVerifier } from '../src/web/v1/access-verifier';
import { LocalOwnerSessionServiceV1, LOCAL_OWNER_SESSION_PROFILE_V1 } from '../src/web/v1/local-owner-session';
import { createMacLocalWebProcessV1 } from '../src/web/v1/mac-local-web-process';
import { createPrivateWebProcess } from '../src/web/v1/private-process';
import { createMacLocalNodeHandler, createPrivateNodeHandler, createLocalSetupNodeHandler } from '../src/web/v1/private-node-handler';
import { createRecurringRuleHttpHandlerV1 } from '../src/web/v1/recurring-rule-http';
import { createReusableSkillHttpHandlerV1 } from '../src/web/v1/reusable-skill-http';
import { projectOrchestrationDescribeSchemaV1 } from '../src/web/v1/project-orchestration-wire';
import { createSoftwareAuthenticatorV1 } from './support/passkey-software-authenticator.mjs';
import { decodeAttestationObject, isoCBOR } from '@simplewebauthn/server/helpers';
import { SimpleWebAuthnVerifierV1 } from '../src/updater/v1/passkey.mjs';
import certificateChain from './fixtures/passkey-sizing-chain.json';
import { nodeExchange } from './helpers/web-node';

import { createProjectOrchestrationHttpHandlerV1 } from '../src/web/v1/project-orchestration-http';
import { createWorkBatchOwnerHttpHandlerV1 } from '../src/web/v1/work-batch-owner-http';
import { createLinearPipelineHttpHandlerV1 } from '../src/web/v1/linear-pipeline-http';
import { createFleetOwnerHttpHandlerV1 } from '../src/web/v1/fleet-owner-http';
import { createImproveControlRoomHttpHandlerV1 } from '../src/web/v1/improve-control-room-http';

type CBORValue = Parameters<typeof isoCBOR.encode>[0];

const NOW = Date.parse('2026-10-02T12:00:00.000Z');
const LOCAL = 'http://127.0.0.1:3210';
const HOSTED = 'https://private.example.invalid';
const ISSUER = 'https://access.example.invalid';
const OWNER_CODE = 'synthetic-owner-code-for-r6-review';
const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKey = pair.publicKey.export({ format: 'jwk' });
async function waitFor(condition: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
  assert.ok(condition(), 'expected concurrent requests did not enter before the deadline');
}
const render = () => new Response('synthetic-private-render');
const profile = { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: LOCAL, tenantId: 'tenant:fixture',
  provider: ISSUER, subject: 'fixture-owner', ownerCodeDigest: sha256Digest({ ownerCode: OWNER_CODE }),
  sessionSeconds: 900, trustedOrigin: 'https://mac.example.invalid' };
const blankDb = () => ({ async query() { throw new Error('database_must_not_be_called'); },
  async transaction() { throw new Error('database_must_not_be_called'); },
  async transactionWithPreCommitCheck() { throw new Error('database_must_not_be_called'); } });
const noDb = () => ({ client: blankDb() as any, close: async () => {}, isAvailable: () => true });
const trust = (now = NOW) => ({ issuer: ISSUER, audience: 'fixture-app', keys: [{ kid: 'fixture-key', jwk: publicKey }],
  validUntilMs: now + 300_000, maxSessionSeconds: 3600 });
function token(subject = profile.subject, issued = NOW - 60_000, expires = NOW + 3_500_000, signingKey = pair.privateKey) {
  const a = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'fixture-key', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ iss: ISSUER, aud: ['fixture-app'], sub: subject, type: 'app',
    iat: issued / 1000, exp: expires / 1000 })).toString('base64url');
  return `${a}.${b}.${sign('RSA-SHA256', Buffer.from(`${a}.${b}`), signingKey).toString('base64url')}`;
}
function hostedRequest(path: string, jwt = token(), body: unknown = { description: 'A bounded request' }, origin: string | null = HOSTED) {
  return new Request(HOSTED + path, { method: 'POST', headers: { 'cf-access-jwt-assertion': jwt,
    'content-type': 'application/json', 'idempotency-key': 'r6-fixture-request-0001', ...(origin ? { origin } : {}) },
    body: JSON.stringify(body) });
}
async function session() {
  const local = new LocalOwnerSessionServiceV1(profile);
  const issued = await local.issue(new Request(LOCAL, { method: 'POST', headers: { origin: LOCAL } }), OWNER_CODE, NOW);
  return { local, cookie: issued.cookie.split(';')[0]! };
}
function fakePort(callback: (method: string, args: any[]) => any = () => ({ fixture: true })) {
  return new Proxy({}, { get(_target, method) { return async (...args: any[]) => callback(String(method), args); } }) as any;
}
async function localApp(options: Record<string, any> = {}) {
  const app = createMacLocalWebProcessV1({ origin: LOCAL, localOwnerSession: profile,
    workspaceId: 'workspace:fixture', database: noDb(), clock: () => NOW, ...options });
  const signed = await app.handle(new Request(LOCAL + '/api/v1/local-owner-session', { method: 'POST',
    headers: { origin: LOCAL, 'content-type': 'application/json' }, body: JSON.stringify({ ownerCode: OWNER_CODE }) }), render);
  assert.equal(signed.status, 201);
  return { app, cookie: signed.headers.get('set-cookie')!.split(';')[0]! };
}
async function exchange(node: ReturnType<typeof createMacLocalNodeHandler>, path: string, method: string,
  cookie?: string, body?: string, assertion?: string, origin = LOCAL) {
  const extra = ['Origin', origin, ...(cookie ? ['Cookie', cookie] : []),
    ...(assertion ? ['cf-access-jwt-assertion', assertion] : []),
    ...(body !== undefined ? ['Content-Type', 'application/json', 'Content-Length', String(Buffer.byteLength(body))] : [])];
  const io = nodeExchange({ path, method, headers: extra, body });
  io.input.rawHeaders[1] = new URL(origin).host;
  await node.handle(io.input, io.output);
  return { status: io.output.statusCode, body: io.body(), headers: io.headers };
}

test('R6W-01: hosted orchestration uses current trust across five-minute refresh', { timeout: 15000 }, async t => {
  let now = NOW, loads = 0, calls = 0, currentKey = publicKey;
  const orchestration = fakePort(() => { calls++; return { fixture: true }; });
  const create = () => createPrivateWebProcess({ origin: HOSTED, issuer: ISSUER, audience: 'fixture-app',
    tenantId: 'tenant:fixture', workspaceId: 'workspace:fixture', maxSessionSeconds: 3600,
    loadKeys: async () => { loads++; return [{ kid: 'fixture-key', jwk: currentKey }]; }, database: noDb(),
    orchestration, clock: () => now });
  const app = create(); t.after(() => app.close());
  const path = '/api/v1/projects/project:alpha/orchestration';
  assert.equal((await app.handle(hostedRequest(path), render)).status, 200);
  now += 300_000;
  // A new outer trust snapshot verifies exactly the same, still-live assertion.
  assert.equal(createAccessVerifier(trust(now))(hostedRequest(path), now).subject, profile.subject);
  const burst = await Promise.all(Array.from({ length: 50 }, () => app.handle(hostedRequest(path), render)));
  assert.equal(loads, 2, 'the outer key cache really refreshed');
  assert.equal(burst.every(response => response.status === 200), true);
  assert.equal(calls, 51, 'all refreshed requests reached the owner port');
  now += 300_000;
  assert.equal((await app.handle(hostedRequest(path, token(profile.subject, now - 1000, now + 600_000)), render)).status, 200,
    'a newly issued assertion uses current trust');
  assert.equal((await app.handle(hostedRequest('/api/v1/projects/project:alpha/orchestration-settings'), render)).status, 200);
  const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
  currentKey = rotated.publicKey.export({ format: 'jwk' });
  now += 300_000;
  const fresh = token(profile.subject, now - 1000, now + 600_000, rotated.privateKey);
  assert.equal((await app.handle(hostedRequest(path, fresh), render)).status, 200, 'the retained handler uses rotated keys');
  assert.equal((await app.handle(hostedRequest(path), render)).status, 401, 'old key cannot authenticate after rotation');
  currentKey = publicKey;
  const restarted = create(); t.after(() => restarted.close());
  assert.equal((await restarted.handle(hostedRequest(path, token(profile.subject, now - 1000, now + 600_000)), render)).status, 200);
});

test('R6W-02: both real Node wrappers admit existing skill and recurring-rule PUT', { timeout: 15000 }, async t => {
  const { local, cookie } = await session();
  let calls = 0, active = 0;
  let release = () => {};
  let gate = Promise.resolve();
  const hold = () => { gate = new Promise<void>(resolve => { release = resolve; }); };
  t.after(() => release());
  const service = fakePort(async () => { calls++; active++; await gate; active--; return { fixture: true }; });
  const rules = createRecurringRuleHttpHandlerV1({ origin: LOCAL, localOwnerSession: local, service, clock: () => NOW });
  const skills = createReusableSkillHttpHandlerV1({ origin: LOCAL, localOwnerSession: local, service, clock: () => NOW });
  const paths = ['/api/v1/projects/project:alpha/recurring-rules/rule:one', '/api/v1/projects/project:alpha/skills/skill:one'];
  const handlers = [rules, skills];
  const bodies = [{ expectedVersion: 1, schedule: 'every Monday at 9', timezone: 'UTC',
    title: 'Weekly review', instructions: 'Updated safely' }, { expectedVersion: 1, instructions: 'Updated safely' }];
  for (let i = 0; i < paths.length; i++) {
    assert.equal((await handlers[i]!(new Request(LOCAL + paths[i], { method: 'PUT', headers: { origin: LOCAL, cookie,
      'content-type': 'application/json' }, body: JSON.stringify(bodies[i]) }))).status, 200);
  }
  const handler = (request: Request) => request.url.includes('recurring-rules') ? rules(request) : skills(request);
  const node = createMacLocalNodeHandler({ origin: LOCAL, application: { isReady: () => true, close: async () => {} },
    handler, assets: { respond: () => undefined } as any }); t.after(() => node.close());
  hold();
  const pendingMac = Array.from({ length: 50 }, (_, index) => exchange(node, paths[index % 2]!, 'PUT', cookie,
    JSON.stringify(bodies[index % 2])));
  await waitFor(() => calls === 52);
  assert.equal(active, 50, '50 edits overlap inside the real Mac route');
  release();
  const responses = await Promise.all(pendingMac);
  assert.equal(responses.every(response => response.status === 200), true);
  assert.equal(calls, 52, 'all Mac edits reach the real route handlers');
  const hosted = createPrivateNodeHandler({ origin: HOSTED, application: { isReady: () => true, close: async () => {} },
    handler: request => (request.url.includes('recurring-rules')
      ? createRecurringRuleHttpHandlerV1({ origin: HOSTED, trust: trust(), service, clock: () => NOW })
      : createReusableSkillHttpHandlerV1({ origin: HOSTED, trust: trust(), service, clock: () => NOW }))(request), assets: { respond: () => undefined } as any });
  t.after(() => hosted.close());
  hold();
  const pendingHosted = Array.from({ length: 50 }, (_, i) => exchange(hosted, paths[i % 2]!, 'PUT',
    undefined, JSON.stringify(bodies[i % 2]), token(), HOSTED));
  await waitFor(() => calls === 102);
  assert.equal(active, 50, '50 edits overlap inside the real hosted route');
  release();
  const hostedBurst = await Promise.all(pendingHosted);
  assert.ok(hostedBurst.every(response => response.status === 200));
  assert.equal(calls, 102);
});

test('R6W-03: outer transport admits supported larger orchestration and registration bodies', { timeout: 15000 }, async t => {
  let calls = 0;
  const { app, cookie } = await localApp({ orchestration: fakePort(() => { calls++; return { fixture: true }; }),
    passkeyRegistration: { options: async () => ({}), insert: async () => { calls++; return { accepted: true }; } } });
  t.after(() => app.close());
  const node = createMacLocalNodeHandler({ origin: LOCAL, application: app, handler: request => app.handle(request, render),
    assets: { respond: () => undefined } as any }); t.after(() => node.close());
  const cases = [
    ['/api/v1/projects/project:alpha/orchestration', { description: 'x'.repeat(9000) }],
    ['/api/v1/passkeys/registration', { registrationSecret: 'A'.repeat(43), comparisonCode: 'ABC234',
      response: { id: 'B'.repeat(43), rawId: 'B'.repeat(43), type: 'public-key',
        response: { clientDataJSON: 'C'.repeat(43), attestationObject: 'A'.repeat(9000) } }, authorizationAssertion: null }],
  ] as const;
  assert.equal(projectOrchestrationDescribeSchemaV1.safeParse(cases[0][1]).success, true);
  for (const [path, body] of cases) {
    const value = JSON.stringify(body);
    assert.equal((await app.handle(new Request(LOCAL + path, { method: 'POST', headers: { origin: LOCAL, cookie,
      'content-type': 'application/json', 'idempotency-key': 'r6-fixture-request-0001' }, body: value }), render)).status,
      path.includes('passkeys') ? 201 : 200);
    assert.equal((await exchange(node, path, 'POST', cookie, value)).status, path.includes('passkeys') ? 201 : 200);
  }
  assert.equal(calls, 4);
  assert.equal((await exchange(node, '/api/v1/projects/project:alpha/orchestration', 'POST', cookie,
    JSON.stringify({ description: 'small control' }))).status, 200);

});


test('R6W-01: 50 overlapping requests span refresh, key outage refuses and fresh retry recovers', { timeout: 15000 }, async t => {
  let now = NOW, loads = 0, fail = false, calls = 0;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const app = createPrivateWebProcess({ origin: HOSTED, issuer: ISSUER, audience: 'fixture-app',
    tenantId: 'tenant:fixture', workspaceId: 'workspace:fixture', maxSessionSeconds: 3600,
    loadKeys: async () => { loads++; if (fail) throw new Error('fixture_key_outage'); return [{ kid: 'fixture-key', jwk: publicKey }]; },
    database: noDb(), clock: () => now,
    orchestration: fakePort(async () => { calls++; await held; return { fixture: true }; }) });
  t.after(async () => { release(); await app.close(); });
  const path = '/api/v1/projects/project:alpha/orchestration';
  const first = Array.from({ length: 25 }, () => app.handle(hostedRequest(path), render));
  // Wait for actual entry, not an assumed number of microtasks.
  await waitFor(() => calls === 25);
  now += 300_000;
  const second = Array.from({ length: 25 }, () => app.handle(hostedRequest(path), render));
  await waitFor(() => calls === 50);
  assert.equal(loads, 2);
  release();
  assert.ok((await Promise.all([...first, ...second])).every(response => response.status === 200));
  now += 300_000; fail = true;
  assert.equal((await app.handle(hostedRequest(path), render)).status, 503);
  assert.equal(calls, 50);
  fail = false;
  assert.equal((await app.handle(hostedRequest(path), render)).status, 503, 'backoff does not use stale trust');
  now += 5000;
  assert.equal((await app.handle(hostedRequest(path), render)).status, 200);
  assert.equal((await app.handle(hostedRequest(path, 'invalid'), render)).status, 401);
  for (const suffix of ['-settings', '-retry'])
    assert.equal((await app.handle(hostedRequest(path + suffix), render)).status, 200);
});

test('R6W-02: PUT retains authentication, Origin, exact route, JSON and both body ceilings', { timeout: 15000 }, async t => {
  const { local, cookie } = await session();
  for (const hosted of [false, true]) {
    const origin = hosted ? HOSTED : LOCAL;
    let calls = 0, fail = false;
    const service = fakePort(() => { calls++; if (fail) throw new Error('fixture_save_failed'); return { fixture: true }; });
    const options = hosted ? { origin, trust: trust(), service, clock: () => NOW }
      : { origin, localOwnerSession: local, service, clock: () => NOW };
    const rules = createRecurringRuleHttpHandlerV1(options), skills = createReusableSkillHttpHandlerV1(options);
    const node = (hosted ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
      application: { isReady: () => true, close: async () => {} }, assets: { respond: () => undefined } as any,
      handler: request => request.url.includes('recurring-rules') ? rules(request) : skills(request),
      timing: { bodyMs: 30, requestMs: 2000, drainMs: 30 } });
    t.after(() => node.close());
    for (const path of ['/api/v1/projects/project:alpha/skills/skill:one', '/api/v1/projects/project:alpha/recurring-rules/rule:one']) {
      const invoke = (body = '{}', auth = true, suppliedOrigin = origin) => exchange(node, path, 'PUT',
        auth && !hosted ? cookie : undefined, body, auth && hosted ? token() : undefined, suppliedOrigin);
      assert.equal((await invoke('{}', false)).status, 401);
      for (const [headers, expected] of [
        [['Content-Type', 'application/json'], 403],
        [['Origin', origin, 'Content-Type', 'text/plain'], 400],
      ] as const) {
        const io = nodeExchange({ path, method: 'PUT', body: '{}', headers: [...headers,
          ...(hosted ? ['cf-access-jwt-assertion', token()] : ['Cookie', cookie])] });
        io.input.rawHeaders[1] = new URL(origin).host;
        await node.handle(io.input, io.output); assert.equal(io.output.statusCode, expected);
      }

      const foreign = nodeExchange({ path, method: 'PUT', body: '{}', headers: ['Origin', 'https://foreign.invalid',
        ...(hosted ? ['cf-access-jwt-assertion', token()] : ['Cookie', cookie]), 'Content-Type', 'application/json'] });
      foreign.input.rawHeaders[1] = new URL(origin).host;
      await node.handle(foreign.input, foreign.output); assert.equal(foreign.output.statusCode, 403);
      const crossSite = nodeExchange({ path, method: 'PUT', body: '{}', headers: ['Origin', origin,
        'Sec-Fetch-Site', 'cross-site', ...(hosted ? ['cf-access-jwt-assertion', token()] : ['Cookie', cookie]),
        'Content-Type', 'application/json'] });
      crossSite.input.rawHeaders[1] = new URL(origin).host;
      await node.handle(crossSite.input, crossSite.output); assert.equal(crossSite.output.statusCode, 403);
      assert.equal((await invoke('{')).status, 400);
      assert.equal((await invoke('x'.repeat(32_769))).status, 413);
      const chunked = nodeExchange({ path, method: 'PUT', body: 'x'.repeat(32_769), headers: ['Origin', origin,
        ...(hosted ? ['cf-access-jwt-assertion', token()] : ['Cookie', cookie]), 'Content-Type', 'application/json',
        'Transfer-Encoding', 'chunked'] });
      chunked.input.rawHeaders[1] = new URL(origin).host;
      await node.handle(chunked.input, chunked.output); assert.equal(chunked.output.statusCode, 413);
      assert.equal(calls, 0);
    }
    for (const path of ['/api/v1/projects', '/api/v1/projects/project:alpha/skills',
      '/api/v1/projects/project:alpha/skills/skill:one/more', '/api/v1/projects/project:alpha/skills/skill:one?x=1',
      '/api/v1/projects/project:alpha/recurring-rules/rule:one/pause', '/api/v1/passkeys/registration'])
      assert.equal((await exchange(node, path, 'PUT', undefined, '{}', undefined, origin)).status, 405, path);
    const path = '/api/v1/projects/project:alpha/skills/skill:one';
    assert.equal((await exchange(node, path, 'PATCH', undefined, '{}', undefined, origin)).status, 405);
    fail = true;
    assert.equal((await exchange(node, path, 'PUT', cookie, '{}', token(), origin)).status, 503);
    fail = false;
    assert.equal((await exchange(node, path, 'PUT', cookie, '{}', token(), origin)).status, 200);
    const incomplete = nodeExchange({ path, method: 'PUT', holdInput: true,
      headers: ['Origin', origin, 'Content-Length', '10', 'Content-Type', 'application/json'] });
    incomplete.input.rawHeaders[1] = new URL(origin).host;
    incomplete.input.on('error', () => {});
    const pending = node.handle(incomplete.input, incomplete.output);
    incomplete.input.destroy(); await pending;
    assert.equal(calls, 2, 'dropped body never reaches the service');
    assert.equal((await exchange(node, path, 'PUT', cookie, '{}', token(), origin)).status, 200);
  }
});

test('R6W-03: all larger route families have bounded declared and chunked transport budgets', { timeout: 15000 }, async t => {
  const paths: [string, string, number][] = [
    ['/api/v1/projects/p/tasks', 'POST', 32_768], ['/api/v1/local-pilot/workspace', 'POST', 32_768],
    ['/api/v1/projects/p/recurring-rules', 'POST', 32_768], ['/api/v1/projects/p/recurring-rules/r', 'PUT', 32_768],
    ['/api/v1/projects/p/skills', 'POST', 32_768], ['/api/v1/projects/p/skills/s', 'PUT', 32_768],
    ['/api/v1/projects/p/orchestration', 'POST', 129_536], ['/api/v1/projects/p/orchestration-settings', 'POST', 129_536],
    ['/api/v1/projects/p/orchestration-retry', 'POST', 129_536],
    ['/api/v1/projects/p/pipelines/b/suggestions/s/use', 'POST', 129_536],
    ['/api/v1/projects/p/pipelines/b/suggestions/s/dismiss', 'POST', 129_536],
    ['/api/v1/projects/p/pipelines/b', 'POST', 131_072],
    ['/api/v1/projects/p/pipeline-templates', 'POST', 65_536], ['/api/v1/projects/p/pipeline-runs/r/unattended', 'POST', 65_536],
    ['/api/v1/fleet/offers', 'POST', 16_384], ['/api/v1/projects/p/improvements', 'POST', 16_384],
    ['/api/v1/update-candidates/c/decision', 'POST', 16_384],
    ['/api/v1/passkeys/registration', 'POST', 20_000], ['/api/v1/passkeys/registration/options', 'POST', 20_000],
    ['/api/v1/unknown', 'POST', 8192],
  ];
  for (const hosted of [false, true]) {
    const origin = hosted ? HOSTED : LOCAL;
    let calls = 0;
    const node = (hosted ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
      application: { isReady: () => true, close: async () => {} }, assets: { respond: () => undefined } as any,
      timing: { bodyMs: 20, requestMs: 2000 },
      handler: async request => { calls++; await request.text(); return Response.json({ accepted: true }); } });
    t.after(() => node.close());
    for (const [path, method, declaredLimit] of paths) {
      const limit = hosted && (path.startsWith('/api/v1/passkeys/') || path === '/api/v1/local-pilot/workspace')
        ? 8192 : declaredLimit;
      const body = JSON.stringify({ text: 'x'.repeat(limit - 11) });
      assert.equal(Buffer.byteLength(body), limit);
      for (const chunked of [false, true]) {
        const invoke = async (value: string) => {
          const io = nodeExchange({ path, method, body: value, headers: ['Origin', origin, 'Content-Type', 'application/json',
            ...(chunked ? ['Transfer-Encoding', 'chunked'] : ['Content-Length', String(Buffer.byteLength(value))])] });
          io.input.rawHeaders[1] = new URL(origin).host;
          await node.handle(io.input, io.output); return io.output.statusCode;
        };
        assert.equal(await invoke(body), 200, path);
        assert.equal(await invoke(body + ' '), 413, path);
      }
      // Oversized declared bodies must be refused before reading, even if the
      // sender withholds every byte. The streaming ceiling alone cannot prove it.
      const withheld = nodeExchange({ path, method, holdInput: true,
        headers: ['Origin', origin, 'Content-Type', 'application/json', 'Content-Length', String(limit + 1)] });
      withheld.input.rawHeaders[1] = new URL(origin).host;
      await node.handle(withheld.input, withheld.output);
      assert.equal(withheld.output.statusCode, 413, path);
    }
    assert.equal(calls, paths.length * 2);
  }
});

test('R6W-03: measured software registrations and chain/extension sizing models fit with headroom', { timeout: 15000 }, async t => {
  const rpId = 'passkey.example.invalid', origin = 'https://' + rpId, challenge = 'A'.repeat(43);
  const response = createSoftwareAuthenticatorV1({ rpId, origin }).register(challenge);
  const verifier = new SimpleWebAuthnVerifierV1();
  const config = { installationId: 'fixture-install', rpId, expectedOrigin: origin };
  assert.equal((await verifier.verifyRegistration({ response, expectedChallenge: challenge, config })).credentialId, response.id);
  const chain = certificateChain.map(value => Buffer.from(value, 'base64'));
  const certs = chain.map(value => new X509Certificate(value));
  assert.ok(certs[0]!.verify(certs[1]!.publicKey));
  assert.ok(certs[1]!.verify(certs[2]!.publicKey));
  assert.ok(certs[2]!.verify(certs[2]!.publicKey));
  const decoded = decodeAttestationObject(Buffer.from(response.response.attestationObject, 'base64url'));
  const authData = Buffer.from(decoded.get('authData')!);
  authData[32] = authData[32]! | 0x80; // ED: actual encoded authenticator extensions follow.
  const extendedAuthData = Buffer.concat([authData, isoCBOR.encode(new Map<string, CBORValue>([
    ['credProtect', 3], ['hmac-secret', true], ['largeBlobKey', Buffer.alloc(32)], ['minPinLength', 6],
  ]))]);
  const extensions = { credProps: { rk: true }, largeBlob: { supported: true }, prf: { enabled: true } };
  const models = [
    { name: 'none', value: response },
    { name: 'packed-x5c-extensions', value: { ...response, clientExtensionResults: extensions,
      response: { ...response.response, attestationObject: Buffer.from(isoCBOR.encode(new Map<string, CBORValue>([
        ['fmt', 'packed'], ['authData', extendedAuthData], ['attStmt', new Map<string, CBORValue>([
          ['alg', -257], ['sig', Buffer.alloc(512)], ['x5c', chain],
        ])],
      ]))).toString('base64url') } } },
    { name: 'tpm-x5c-extensions', value: { ...response, clientExtensionResults: extensions,
      response: { ...response.response, attestationObject: Buffer.from(isoCBOR.encode(new Map<string, CBORValue>([
        ['fmt', 'tpm'], ['authData', extendedAuthData], ['attStmt', new Map<string, CBORValue>([
          ['ver', '2.0'], ['alg', -257], ['sig', Buffer.alloc(512)], ['x5c', chain],
          ['certInfo', Buffer.alloc(256)], ['pubArea', Buffer.alloc(1024)],
        ])],
      ]))).toString('base64url') } } },
  ];
  // Non-none models measure encoding/transport, not valid hardware attestation:
  // their statement signatures/TPM structures are sizing bytes. Real DER chain
  // signatures are checked above; updater's existing none-only policy stays put.
  let calls = 0;
  const { app, cookie } = await localApp({ passkeyRegistration: { options: async () => ({}),
    insert: async () => { calls++; return { accepted: true }; } } });
  t.after(() => app.close());
  const node = createMacLocalNodeHandler({ origin: LOCAL, application: app,
    handler: request => app.handle(request, render), assets: { respond: () => undefined } as any });
  t.after(() => node.close());
  for (const model of models) {
    const body = JSON.stringify({ registrationSecret: 'A'.repeat(43), comparisonCode: 'ABC234',
      response: model.value, authorizationAssertion: null });
    const bytes = Buffer.byteLength(body);
    assert.ok(bytes < 20_000 / 2, 'at least 2x measured registration headroom');
    assert.equal((await exchange(node, '/api/v1/passkeys/registration', 'POST', cookie, body)).status, 201);
    console.log(`passkey-sizing ${model.name}: JSON=${bytes}; attestation=${Buffer.from(model.value.response.attestationObject, 'base64url').length}; DER=${chain.map(cert => cert.length).join(',')}`);
    if (model.name !== 'none') await assert.rejects(
      verifier.verifyRegistration({ response: model.value, expectedChallenge: challenge, config }), /updater_passkey_attestation_refused/);
  }
  assert.equal(calls, models.length);
  // The route keeps its pre-existing 20 KB parser budget; the outer transport
  // now matches it. Oversized requests remain refused before the port.
  const oversized = JSON.stringify({ registrationSecret: 'A'.repeat(43), comparisonCode: 'ABC234',
    response: { value: 'x'.repeat(20_000) }, authorizationAssertion: null });
  assert.equal((await exchange(node, '/api/v1/passkeys/registration', 'POST', cookie, oversized)).status, 413);
  assert.equal(calls, models.length);
});

test('R6W-02: setup remains read-only and stopping during PUT drains transport without a second operation', { timeout: 15000 }, async t => {
  const setup = createLocalSetupNodeHandler({ origin: LOCAL, assets: { respond: () => undefined } as any,
    renderSetupPage: () => new Response('setup'), planSource: { read: async () => ({ status: 'not_found' } as any) },
    isReady: () => true, close: async () => {} });
  t.after(() => setup.close());
  assert.equal((await exchange(setup, '/api/v1/projects/p/skills/s', 'PUT', undefined, '{}')).status, 405);
  let calls = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const node = createMacLocalNodeHandler({ origin: LOCAL, assets: { respond: () => undefined } as any,
    application: { isReady: () => true, close: async () => {} }, timing: { requestMs: 1000, drainMs: 20 },
    handler: async () => { calls++; await gate; return Response.json({ saved: true }); } });
  t.after(async () => { release(); await node.close().catch(() => {}); });
  const pending = exchange(node, '/api/v1/projects/p/skills/s', 'PUT', undefined, '{}');
  await waitFor(() => calls === 1);
  await assert.rejects(node.close(), { message: 'private_serving_drain_uncertain' });
  await pending; release();
  assert.equal((await exchange(node, '/api/v1/projects/p/skills/s', 'PUT', undefined, '{}')).status, 503);
  assert.equal(calls, 1);
});

test('R6W-03: larger bodies traverse both wrappers and each real route parser', { timeout: 15000 }, async t => {
  const { local, cookie } = await session();
  for (const hosted of [false, true]) {
    const origin = hosted ? HOSTED : LOCAL;
    let calls = 0;
    const service = fakePort(() => { calls++; return { fixture: true, replayed: false }; });
    const options = hosted ? { origin, trust: trust(), service, clock: () => NOW }
      : { origin, localOwnerSession: local, service, clock: () => NOW };
    const cases: [ReturnType<typeof createReusableSkillHttpHandlerV1>, string, string, object, number][] = [
      [createRecurringRuleHttpHandlerV1(options), '/api/v1/projects/p/recurring-rules', 'POST', {}, 201],
      [createRecurringRuleHttpHandlerV1(options), '/api/v1/projects/p/recurring-rules/r', 'PUT', {}, 200],
      [createReusableSkillHttpHandlerV1(options), '/api/v1/projects/p/skills', 'POST', {}, 201],
      [createReusableSkillHttpHandlerV1(options), '/api/v1/projects/p/skills/s', 'PUT', {}, 200],
      [createProjectOrchestrationHttpHandlerV1(options), '/api/v1/projects/p/orchestration', 'POST', { description: 'x'.repeat(9000) }, 200],
      [createWorkBatchOwnerHttpHandlerV1(options), '/api/v1/projects/p/pipelines/b', 'POST', { batchId: 'b' }, 201],
      [createLinearPipelineHttpHandlerV1(options), '/api/v1/projects/p/pipeline-templates', 'POST', {}, 201],
      [createLinearPipelineHttpHandlerV1({ ...options, advance: service }), '/api/v1/projects/p/pipeline-runs/r/unattended', 'POST', { runId: 'r' }, 201],
      [createFleetOwnerHttpHandlerV1(options), '/api/v1/fleet/offers', 'POST', {}, 201],
      [createImproveControlRoomHttpHandlerV1(options), '/api/v1/projects/p/improvements', 'POST', {}, 201],
      [createImproveControlRoomHttpHandlerV1(options), '/api/v1/update-candidates/c/decision', 'POST', { candidateId: 'c' }, 201],
    ];
    for (const [handler, path, method, fields, expected] of cases) {
      const node = (hosted ? createPrivateNodeHandler : createMacLocalNodeHandler)({ origin,
        application: { isReady: () => true, close: async () => {} }, handler, assets: { respond: () => undefined } as any });
      try {
        // Ports deliberately accept the fixture: this proves transport/parser
        // agreement, not service validation, persistence or SQL authorization.
        const body = JSON.stringify({ ...fields, instructions: 'x'.repeat(9000) });
        assert.equal((await exchange(node, path, method, cookie, body, token(), origin)).status, expected, path);
      } finally { await node.close(); }
    }
    assert.equal(calls, cases.length);
  }
});
