import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { taskAssignmentFixture } from "./helpers/task-assignment.ts";
import { instant } from "./hermes-native-fixture.ts";
import { origin, request } from "./helpers/web-foundation.ts";

test("compiled task composition is inert and owns both supplied resources through assignment and close", async t => {
  const { createPrivateTaskApplication } = await import("../dist-vps/server/taskApplication.js");
  assert.equal(typeof createPrivateTaskApplication, "function");
  const f = await taskAssignmentFixture(); t.after(f.close); let webCloses = 0, taskCloses = 0;
  const app = await createPrivateTaskApplication({ ...f.accessTrust, ...f.scope, origin,
    loadKeys: async () => f.accessTrust.keys, tasks: f.ownerKeys, clock: () => instant + 8000,
    database: { client: { ...f.db }, close: async () => { webCloses++; }, isAvailable: () => true } }, {
    scope: f.scope, planning: f.plannerConfig, routes: [f.route], clock: () => instant + 8000,
    database: { client: f.db, close: async () => { taskCloses++; }, isAvailable: () => true },
  });
  const path = `/api/v1/projects/${f.prepared.receipt.projectId}/tasks/${f.prepared.receipt.jobId}/assignment`;
  const handle = (method = "GET", body) => app.handle(request(path, method, body, undefined, f.jwt), () => new Response("shell"));
  assert.equal((await handle()).status, 200);
  const saved = await handle("POST", { action: "assign", nodeId: f.route.nodeId, expectedInputDigest: f.prepared.receipt.inputDigest });
  assert.equal(saved.status, 201, await saved.clone().text()); assert.equal((await saved.json()).receipt.startsWork, false);
  assert.equal(app.isReady(), true); await app.close(); assert.equal(app.isReady(), false);
  assert.equal(webCloses, 1); assert.equal(taskCloses, 1); assert.equal((await handle()).status, 503);
  const entry = await readFile("dist-vps/server/index.js", "utf8");
  assert.doesNotMatch(entry, /createPrivateTaskApplication\(/);
});
