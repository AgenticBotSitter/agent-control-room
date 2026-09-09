import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createPrivateWebBootstrap, startPrivateWebApplication } from "../dist-vps/server/bootstrap.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup.ts";
import { now, request } from "./helpers/web-foundation.ts";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createConfiguration } from "../deploy/operator-config.mjs";

test("built bootstrap import is inert and operator saved views reach actual compiled routes", async t => {
  assert.equal(typeof startPrivateWebApplication, "function");
  assert.equal((await handler(request())).status, 503);
  const f = await limitedWebFixture();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cr-built-saved-views-")));
  const previous = process.env.CONTROL_ROOM_SETTINGS_FILE;
  t.after(async () => {
    if (previous === undefined) delete process.env.CONTROL_ROOM_SETTINGS_FILE;
    else process.env.CONTROL_ROOM_SETTINGS_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const { loadKeys, ideaProjects, connections, ...web } = startupConfig;
  void connections;
  const path = join(directory, "settings.json"); process.env.CONTROL_ROOM_SETTINGS_FILE = path;
  await writeFile(path, JSON.stringify({ port: 3210, web,
    savedViews: { ideaIntegrityKeyHex: Buffer.from(ideaProjects.integrityKey).toString('hex'), newsIntegrityKeyHex: '62'.repeat(32) } }), { mode: 0o600 });
  const prepared = await createConfiguration({ signal: new AbortController().signal });
  const bootstrap = createPrivateWebBootstrap({ openDatabase: () => f.pool, install: installPrivateWebProcess, clock: () => now });
  // Trust is injected for this disposable test; never contact a real issuer.
  const projectId = 'project.idea:web';
  const sourceKey = 'ab'.repeat(32);
  const readers = [{ tenantId: startupConfig.tenantId, workspaceId: startupConfig.workspaceId,
    projectId, sourceKey, view: () => ({ projectId, status: 'offline', ageMs: null, rows: [],
      executionAuthority: false, completionVerified: false, cleanupVerified: false }) }];
  const app = await bootstrap.start({ ...prepared.configuration.web, loadKeys, herdrObservations: readers });
  readers[0].view = () => { throw new Error('mutated reader'); };
  readers.length = 0;
  try {
    assert.equal(app.isReady(), true);
    const observations = await handler(request('/api/v1/projects/project.idea%3Aweb/observations'));
    assert.equal(observations.status, 200);
    assert.equal((await observations.json()).sources[0].sourceKey, sourceKey);
    assert.equal((await handler(request())).status, 200);
    const ideas = await handler(request('/api/v1/ideas'));
    assert.equal(ideas.status, 200); assert.equal((await ideas.json()).sessions.length, 1);
    const news = await handler(request('/api/v1/projects/project.idea%3Aweb/news'));
    assert.equal(news.status, 200); assert.equal((await news.json()).availability, 'configured');
    const created = await handler(request(undefined, "POST", { title: "Built startup", summary: "Restricted disposable role" }));
    assert.equal(created.status, 201);
    assert.throws(() => installPrivateWebProcess({}), /already_configured/);
    const closing = app.close(); assert.equal(app.isReady(), false);
    assert.equal((await handler(request())).status, 503); await closing;
    assert.equal(f.closes(), 1);
  } finally { await app.close(); }
});

test("database startup, role checks and credential configuration stay out of browser assets", () => {
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of files("dist-vps/client").filter(path => path.endsWith(".js")))
    assert.doesNotMatch(readFileSync(file, "utf8"), /private_startup_prerequisites_failed|control_room_private_web|database_outcome_uncertain|transaction_timeout/);
});

test("compiled website startup cannot silently discard task coordinator capabilities", async () => {
  let effects = 0;
  const effect = () => { effects++; throw new Error('unexpected effect'); };
  for (const name of ['approvals', 'submission', 'queueAttention']) {
    const bootstrap = createPrivateWebBootstrap({ openDatabase: effect, install: effect });
    await assert.rejects(bootstrap.start({ ...startupConfig, [name]: {} }),
      { message: 'private_startup_config_invalid' });
  }
  assert.equal(effects, 0);
  assert.equal((await handler(request())).status, 503);
});

test('compiled startup refuses invalid observation enrollment before opening a database', async () => {
  let effects = 0;
  const effect = () => { effects++; throw new Error('unexpected effect'); };
  const reader = { tenantId: startupConfig.tenantId, workspaceId: startupConfig.workspaceId,
    projectId: 'project:fixture', sourceKey: 'ab'.repeat(32), view: effect };
  for (const sources of [null, {}, new Array(1), [undefined], [reader, reader], [{ ...reader, tenantId: 'foreign' }],
    [{ ...reader, sourceKey: 'invalid' }], [{ ...reader, view: null }]]) {
    await assert.rejects(createPrivateWebBootstrap({ openDatabase: effect, install: effect })
      .start({ ...startupConfig, herdrObservations: sources }), { message: 'private_startup_config_invalid' });
  }
  assert.equal(effects, 0);
});

test("operator configuration accepts only the restricted single-site settings without starting resources", async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "cr-operator-settings-")));
  const previous = process.env.CONTROL_ROOM_SETTINGS_FILE;
  t.after(async () => {
    if (previous === undefined) delete process.env.CONTROL_ROOM_SETTINGS_FILE;
    else process.env.CONTROL_ROOM_SETTINGS_FILE = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "settings.json");
  const { loadKeys, ideaProjects, connections, ...web } = startupConfig;
  void loadKeys; void ideaProjects; void connections;
  process.env.CONTROL_ROOM_SETTINGS_FILE = path;
  const signal = new AbortController().signal;
  await writeFile(path, JSON.stringify({ port: 3210, web }), { mode: 0o600 });
  const prepared = await createConfiguration({ signal });
  assert.equal(prepared.mode, "website-only");
  assert.deepEqual(Object.keys(prepared.configuration), ["web"]);
  assert.equal(typeof prepared.configuration.web.loadKeys, "function");
  assert.equal(prepared.configuration.web.ideaProjects, undefined);
  assert.equal(prepared.configuration.web.news, undefined);
  const savedViews = { ideaIntegrityKeyHex: '61'.repeat(32), newsIntegrityKeyHex: '62'.repeat(32) };
  await writeFile(path, JSON.stringify({ port: 3210, web, savedViews }));
  const saved = await createConfiguration({ signal });
  assert.equal(saved.mode, 'website-only');
  assert.deepEqual(Object.keys(saved.configuration), ['web']);
  assert.deepEqual(saved.configuration.web.ideaProjects.integrityKey, new Uint8Array(32).fill(0x61));
  assert.deepEqual(saved.configuration.web.news.integrityKey, new Uint8Array(32).fill(0x62));
  assert.equal(saved.configuration.coordinator, undefined);
  assert.equal(saved.configuration.news, undefined);
  for (const invalid of [{}, null, [], { ideaIntegrityKeyHex: 'invalid' },
    { newsIntegrityKeyHex: 'a'.repeat(63) }, { ideaIntegrityKeyHex: 'g'.repeat(64) },
    { ...savedViews, runtime: {} }, { ...savedViews, collector: {} }]) {
    await writeFile(path, JSON.stringify({ port: 3210, web, savedViews: invalid }));
    await assert.rejects(createConfiguration({ signal }), /operator_settings_invalid/);
  }
  for (const added of [{ secondaryAccess: {} }, { tasks: {} }, { loadKeys: "injected" }]) {
    await writeFile(path, JSON.stringify({ port: 3210, web: { ...web, ...added } }));
    await assert.rejects(createConfiguration({ signal }), /operator_settings_invalid/);
  }
  await assert.rejects(createConfiguration({ signal: AbortSignal.abort() }), /canceled/);
});
