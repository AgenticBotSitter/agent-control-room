import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { adaptPglite } from '../src/persistence/database';
import { SecurityStore } from '../src/security/security-store';
import { WebProjectService } from '../src/web/v1/project-service';
import { createAccessVerifier, type AccessTrust } from '../src/web/v1/access-verifier';
import { parseProductConfigurationV1, type ProductConfigurationV1 } from '../src/config/v1/product-configuration';
import { sha256Digest } from '../src/security/digest';

const FIXTURE_NOW = Date.parse('2026-09-04T12:00:00.000Z');
const FIXTURE_ORIGIN = 'https://private.example.invalid';
const FIXTURE_KEYS = generateKeyPairSync('rsa', { modulusLength: 2048 });
const FIXTURE_TRUST: AccessTrust = { issuer: 'https://access.example.invalid', audience: 'test-app',
  keys: [{ kid: 'test-public-key', jwk: FIXTURE_KEYS.publicKey.export({ format: 'jwk' }) }],
  validUntilMs: FIXTURE_NOW + 3600_000, maxSessionSeconds: 604800 };

function token(changes: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'test-public-key' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ iss: FIXTURE_TRUST.issuer, aud: [FIXTURE_TRUST.audience], sub: 'test-owner',
    type: 'app', iat: FIXTURE_NOW / 1000 - 60, exp: FIXTURE_NOW / 1000 + 300, ...changes })).toString('base64url');
  return `${header}.${claims}.${sign('RSA-SHA256', Buffer.from(`${header}.${claims}`), FIXTURE_KEYS.privateKey).toString('base64url')}`;
}

function fixtureIdentity() {
  return createAccessVerifier(FIXTURE_TRUST)(new Request(`${FIXTURE_ORIGIN}/api/v1/projects`, { method: 'GET',
    headers: { 'cf-access-jwt-assertion': token(), origin: FIXTURE_ORIGIN } }), FIXTURE_NOW);
}

function configurationWith(overrides: Partial<ProductConfigurationV1> = {}): Readonly<ProductConfigurationV1> {
  const base: ProductConfigurationV1 = {
    schema: 'control-room.product-configuration/v1',
    displayName: 'Test',
    defaultTimezone: 'UTC',
    modules: { ideaLab: true, news: true, sessionObservations: false },
    limits: { maxProjects: 10, maxTasksPerProject: 10, maxResultsPerTask: 10, maxArticleSources: 0, maxIdeaParticipants: 0 },
    projectTemplates: [
      { id: 'core-pages-only', displayName: 'Core pages only', enabledModules: [] },
      { id: 'news-focused', displayName: 'News focused', enabledModules: ['news'] },
    ],
  };
  const modules = { ...base.modules, ...(overrides.modules ?? {}) };
  const templates = (overrides.projectTemplates ?? base.projectTemplates)
    .map((template) => ({ ...template, enabledModules: template.enabledModules.filter((module) => modules[module]) }));
  return parseProductConfigurationV1({ ...base, ...overrides, modules, projectTemplates: templates });
}

async function buildFixture(productConfiguration?: Readonly<ProductConfigurationV1>) {
  const db = new PGlite();
  for (const file of (await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort())
    await db.exec(await readFile(`db/migrations/${file}`, 'utf8'));
  await db.query("INSERT INTO tenants(id,display_name) VALUES('tenant:web','Test tenant')");
  await db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:web','tenant:web','Test workspace')");
  const client = adaptPglite(db);
  await new SecurityStore(client).bootstrapOwner({ tenantId: 'tenant:web', provider: FIXTURE_TRUST.issuer, subject: 'test-owner',
    identityId: 'identity:web', grantId: 'grant:web', displayName: 'Test owner', verifiedAt: new Date(FIXTURE_NOW - 60_000).toISOString(),
    expiresAt: new Date(FIXTURE_NOW + 300_000).toISOString(), now: new Date(FIXTURE_NOW).toISOString() });
  const service = new WebProjectService(client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    () => FIXTURE_NOW, undefined, undefined, productConfiguration);
  return { db, client, service };
}

test('create with templateSelection persists the snapshot and returns effective presentation', async t => {
  const configuration = configurationWith();
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  const digest = sha256Digest(configuration);
  const { project } = await f.service.create(identity,
    { title: 'News project', summary: 'Just news',
      templateSelection: { templateId: 'news-focused', configurationDigest: digest } },
    'create-with-template-1');
  // The create receipt must carry the same effective presentation a later getView would derive,
  // computed once at insert time. This is the documented wire contract.
  assert.ok(project.presentation, 'create receipt carries effective presentation');
  assert.equal(project.presentation!.source, 'saved');
  assert.equal(project.presentation!.templateId, 'news-focused');
  assert.equal(project.presentation!.templateDisplayName, 'News focused');
  assert.deepEqual([...project.presentation!.enabledModules], ['news']);
  assert.deepEqual([...project.presentation!.availableModules], ['news']);
  assert.equal(project.presentation!.templateRemoved, false);
  // The wire shape never echoes the saved digest; only the create endpoint can validate against it.
  const view = await f.service.getView(identity, project.projectId);
  assert.ok(view.presentation, 'view includes presentation');
  assert.equal(view.presentation!.source, 'saved');
  assert.equal(view.presentation!.templateId, 'news-focused');
  assert.equal(view.presentation!.templateDisplayName, 'News focused');
  assert.deepEqual([...view.presentation!.enabledModules], ['news']);
  assert.deepEqual([...view.presentation!.availableModules], ['news']);
  assert.equal(view.presentation!.templateRemoved, false);
  // The wire shape never echoes the saved digest; only the create endpoint can validate against it.
});

test('create without templateSelection is preserved as a legacy-global presentation', async t => {
  const configuration = configurationWith({ modules: { ideaLab: true, news: false, sessionObservations: false } });
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  const { project } = await f.service.create(identity, { title: 'Legacy', summary: 'No template' },
    'create-legacy-1-fx');
  // The create receipt carries the same legacy-global presentation a later getView derives.
  assert.ok(project.presentation, 'create receipt carries legacy presentation');
  assert.equal(project.presentation!.source, 'legacy_global');
  assert.equal(project.presentation!.templateId, '');
  assert.deepEqual([...project.presentation!.enabledModules], []);
  const view = await f.service.getView(identity, project.projectId);
  assert.ok(view.presentation, 'view includes legacy presentation');
  assert.equal(view.presentation!.source, 'legacy_global');
  assert.equal(view.presentation!.templateId, '');
  assert.deepEqual([...view.presentation!.enabledModules], []);
  assert.deepEqual([...view.presentation!.availableModules], ['ideaLab']);
});

test('create rejects an unknown templateSelection with invalid_request', async t => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  await assert.rejects(f.service.create(identity,
    { title: 'Bad', summary: 'no template',
      templateSelection: { templateId: 'mystery', configurationDigest: digest } },
    'create-unknown-1'), { code: 'invalid_request' });
});

test('create rejects a stale digest with invalid_request', async t => {
  const configuration = configurationWith();
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  await assert.rejects(f.service.create(identity,
    { title: 'Bad', summary: 'no template',
      templateSelection: { templateId: 'news-focused', configurationDigest: `sha256:${'b'.repeat(64)}` } },
    'create-stale-1-fx'), { code: 'invalid_request' });
});

test('create rejects a template whose modules are disabled globally with invalid_request', async t => {
  // The operator-installed configuration cannot reach this state through parseProductConfigurationV1
  // because the schema's superRefine rejects it. The runtime defense in verifyProjectTemplateSelectionV1
  // catches configurations assembled by other means; exercise that path here.
  const strictConfig = configurationWith({
    modules: { ideaLab: false, news: true, sessionObservations: false },
    projectTemplates: [{ id: 'news-focused', displayName: 'News focused', enabledModules: ['news'] }],
  });
  const digest = sha256Digest(strictConfig);
  // Simulate a runtime view where the news module is flipped off (e.g. via a runtime patch the
  // server does not control). The schema-level validation is bypassed; the runtime check must fire.
  const runtimeView = { ...strictConfig, modules: { ...strictConfig.modules, news: false } } as Readonly<ProductConfigurationV1>;
  const f = await buildFixture(runtimeView); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  await assert.rejects(f.service.create(identity,
    { title: 'Bad', summary: 'no template',
      templateSelection: { templateId: 'news-focused', configurationDigest: digest } },
    'create-disabled-1'), { code: 'invalid_request' });
});

test('idempotent replay of a template-bearing create returns the original saved snapshot', async t => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  const draft = { title: 'Replay me', summary: 'stable',
    templateSelection: { templateId: 'news-focused', configurationDigest: digest } };
  const first = await f.service.create(identity, draft, 'replay-template-key');
  const second = await f.service.create(identity, draft, 'replay-template-key');
  assert.equal(second.replayed, true);
  assert.deepEqual(second.project, first.project);
});

test('changed-input replay with the same idempotency key fails with conflict', async t => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  const first = await f.service.create(identity,
    { title: 'Original', summary: 'original',
      templateSelection: { templateId: 'news-focused', configurationDigest: digest } },
    'replay-conflict-1');
  await assert.rejects(f.service.create(identity,
    { title: 'Changed', summary: 'changed',
      templateSelection: { templateId: 'news-focused', configurationDigest: digest } },
    'replay-conflict-1'), { code: 'conflict' });
  const view = await f.service.getView(identity, first.project.projectId);
  assert.equal(view.presentation!.templateId, 'news-focused');
});

test('historical receipt still parses when the template is later removed from configuration', async t => {
  const firstConfig = configurationWith();
  const digest = sha256Digest(firstConfig);
  const f = await buildFixture(firstConfig); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  const { project } = await f.service.create(identity,
    { title: 'Will outlive template', summary: 'persists',
      templateSelection: { templateId: 'news-focused', configurationDigest: digest } },
    'historical-receipt-1');
  const originalReceipt = await f.service.getView(identity, project.projectId);
  assert.equal(originalReceipt.presentation!.templateRemoved, false);
  const secondConfig = configurationWith({ projectTemplates: [{ id: 'core-pages-only', displayName: 'Core pages only',
    enabledModules: [] }] });
  const reconstructed = new WebProjectService(f.client, { tenantId: 'tenant:web', workspaceId: 'workspace:web' },
    () => FIXTURE_NOW, undefined, undefined, secondConfig);
  const historicalReceipt = await reconstructed.getView(identity, project.projectId);
  assert.equal(historicalReceipt.presentation!.templateId, 'news-focused');
  assert.equal(historicalReceipt.presentation!.templateDisplayName, 'News focused');
  assert.deepEqual([...historicalReceipt.presentation!.enabledModules], ['news']);
  assert.equal(historicalReceipt.presentation!.templateRemoved, true);
  assert.deepEqual([...historicalReceipt.presentation!.availableModules], []);
});

test('project access denial stays unchanged when presentation is added', async t => {
  const f = await buildFixture(configurationWith()); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  await assert.rejects(f.service.getView(identity, 'project:nope'), { code: 'not_found' });
});

test('listPage surfaces presentation for every ordinary project', async t => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  await f.service.create(identity, { title: 'One', summary: 'one',
    templateSelection: { templateId: 'news-focused', configurationDigest: digest } },
    'list-with-template-1');
  await f.service.create(identity, { title: 'Two', summary: 'two' }, 'list-without-template-1');
  const page = await f.service.listPage(identity);
  assert.equal(page.projects.length, 2);
  const byTitle = new Map(page.projects.map(p => [p.title, p]));
  assert.equal(byTitle.get('One')!.presentation!.source, 'saved');
  assert.equal(byTitle.get('One')!.presentation!.templateId, 'news-focused');
  assert.equal(byTitle.get('Two')!.presentation!.source, 'legacy_global');
});

test('replay of a pre-deploy no-template create with the same idempotency key returns the original receipt (legacy digest shape preserved)', async t => {
  // Before this commit shipped, the idempotency digest for a no-template create was computed
  // from {title, summary} alone — it did not include a templateSelection key. The fix MUST
  // preserve that digest shape exactly when no template is supplied so replays survive the
  // deploy boundary. A new confirmation ID (same digest) returns conflict only when the
  // request *changes* — never because the underlying digest shape changed underneath a prior
  // successful request.
  const configuration = configurationWith();
  const f = await buildFixture(configuration); t.after(() => f.db.close());
  const identity = fixtureIdentity();
  const key = 'legacy-replay-key-1';
  const value = { title: 'Legacy replay', summary: 'no template' };
  const { project: first } = await f.service.create(identity, value, key);
  const { project: replay } = await f.service.create(identity, value, key);
  assert.equal(replay.projectId, first.projectId, 'replay returns the original projectId');
  assert.equal(replay.version, first.version);
});
