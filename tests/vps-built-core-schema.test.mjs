import assert from "node:assert/strict";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createPrivateWebBootstrap } from "../dist-vps/server/bootstrap.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup.ts";
import { fixture, now, origin, request } from "./helpers/web-foundation.ts";
import { readPrivateWebSchemaDigest, privateWebSchemaDigest } from "../src/web/v1/private-database-preflight.ts";

test("default test preparation retains the private external-content schema", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const tables = await f.client.query("SELECT to_regclass('public.control_external_content_releases') AS present");
  assert.equal(tables.rows[0].present, "control_external_content_releases");
});

for (const profile of ["full", "without-external-content"]) test(`compiled schema boundary: ${profile}`, async t => {
  const f = await limitedWebFixture(profile);
  t.after(() => f.pool.close());
  const tables = await f.client.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'control_external_content%'");
  if (profile === "without-external-content") {
    assert.deepEqual(tables.rows, []);
    assert.notEqual(await readPrivateWebSchemaDigest(f.client), privateWebSchemaDigest);
    let installs = 0;
    const bootstrap = createPrivateWebBootstrap({ openDatabase: () => f.pool, clock: () => now,
      install: () => { installs++; throw new Error("Unexpected installation"); } });
    await assert.rejects(bootstrap.start(startupConfig), /private_startup_prerequisites_failed/);
    assert.equal(installs, 0); assert.equal(f.closes(), 1);
    assert.equal((await handler(request())).status, 503);
    return;
  }
  assert.ok(tables.rows.length > 0);
  assert.equal(await readPrivateWebSchemaDigest(f.client), privateWebSchemaDigest);
  const app = await createPrivateWebBootstrap({ openDatabase: () => f.pool,
    install: installPrivateWebProcess, clock: () => now }).start(startupConfig);
  t.after(() => app.close());
  assert.equal(app.isReady(), true);
  assert.equal((await handler(new Request(`${origin}/api/v1/projects`))).status, 401);
  const created = await handler(request(undefined, "POST", { title: "Generic research", summary: "Disposable contributor project" }, "core-schema-project-001"));
  assert.equal(created.status, 201, await created.clone().text());
  const { project } = await created.json();
  const projectPath = `/api/v1/projects/${encodeURIComponent(project.projectId)}`;
  const taskPath = `${projectPath}/tasks`;
  const proposed = await handler(request(taskPath, "POST", { title: "Compare options", instructions: "Return a synthetic comparison; do not contact a provider." }, "core-schema-task-001"));
  assert.equal(proposed.status, 201, await proposed.clone().text());
  const { receipt } = await proposed.json();
  const detail = await handler(request(`${taskPath}/${encodeURIComponent(receipt.jobId)}`));
  assert.equal(detail.status, 200);
  const saved = await detail.json();
  assert.equal(saved.task.state, "proposed"); assert.deepEqual(saved.attempts, []);
  const page = await handler(request(`/projects/${encodeURIComponent(project.projectId)}/tasks`));
  assert.equal(page.status, 200); assert.match(await page.text(), /Loading protected tasks/);
  assert.equal((await handler(request("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(request(projectPath))).status, 401);
  await app.close(); assert.equal(f.closes(), 1);
  assert.equal((await handler(request(projectPath))).status, 503);
});
