import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import handler from "../dist-vps/server/index.js";
import { createPrivateTaskBootstrap, startPrivateTaskApplication } from "../dist-vps/server/taskBootstrap.js";
import { installPrivateApplication, installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { taskStartupFixture } from "./helpers/task-startup.ts";
import { taskDraft } from "./helpers/web-task.ts";
import { instant } from "./hermes-native-fixture.ts";
import { request } from "./helpers/web-foundation.ts";
import { sha256Digest } from "../src/security/index.ts";

test("compiled two-pool bootstrap mounts protected planning, assignment and page rendering under shared logout", async t => {
  assert.equal(typeof startPrivateTaskApplication, "function");
  assert.equal((await handler(request())).status, 503);
  const f = await taskStartupFixture(); t.after(f.close);
  const bootstrap = createPrivateTaskBootstrap({ openDatabase: f.openDatabase, install: installPrivateApplication, clock: () => instant + 8000 });
  const app = await bootstrap.start(f.config); t.after(() => app.close());
  const project = `/api/v1/projects/${f.profile.projectId}`;
  const req = (path, method = "GET", body) => request(path, method, body, "built-task-startup-001", f.jwt);
  const created = await handler(req(`${project}/tasks`, "POST", taskDraft));
  assert.equal(created.status, 201, await created.clone().text());
  const proposal = await created.json();
  const planned = await handler(req(`${project}/tasks/${proposal.receipt.jobId}/plan`, "POST", { expectedInputDigest: sha256Digest(taskDraft) }));
  assert.equal(planned.status, 201, await planned.clone().text());
  const plan = (await planned.json()).receipt;
  const path = `${project}/tasks/${plan.jobId}/assignment`;
  assert.equal((await handler(req(path))).status, 200);
  const saved = await handler(req(path, "POST", { action: "assign", nodeId: f.route.nodeId, expectedInputDigest: plan.inputDigest }));
  assert.equal(saved.status, 201, await saved.clone().text()); assert.equal((await saved.json()).receipt.startsWork, false);
  const page = await handler(req(`/projects/${f.profile.projectId}/tasks/${plan.jobId}`));
  assert.equal(page.status, 200); assert.match(await page.text(), /<html/);
  assert.throws(() => installPrivateWebProcess({}), /already_configured/);
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(req(path))).status, 401);
  const closing = app.close(); assert.equal(app.isReady(), false); await closing;
  assert.equal((await handler(req(path))).status, 503); assert.equal(f.web.closes(), 1); assert.equal(f.coordinator.closes(), 1);
});

test("task startup and database role material never enter browser assets", () => {
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of files("dist-vps/client").filter(path => path.endsWith(".js")))
    assert.doesNotMatch(readFileSync(file, "utf8"), /private_task_startup_|control_room_task_coordinator|startPrivateTaskApplication/);
});
