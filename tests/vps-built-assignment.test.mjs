import assert from "node:assert/strict";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { taskAssignmentFixture } from "./helpers/task-assignment.ts";
import { instant } from "./hermes-native-fixture.ts";
import { request, origin } from "./helpers/web-foundation.ts";

test("compiled private assignment API records, reads and expires a real lease under shared logout", async t => {
  const f = await taskAssignmentFixture(); let now = instant + 8000;
  const coordinator = f.create(f.db, () => now);
  const app = installPrivateWebProcess({ ...f.accessTrust, ...f.scope, origin, tasks: f.ownerKeys,
    assignment: coordinator.webOperation(), loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: f.close }, clock: () => now });
  t.after(() => app.close());
  const base = `/api/v1/projects/${f.prepared.receipt.projectId}/tasks/${f.prepared.receipt.jobId}`, path = `${base}/assignment`;
  const req = (url = path, method = "GET", body) => request(url, method, body, undefined, f.jwt);
  const options = await (await handler(req())).json(); assert.equal(options.candidates.length, 1); assert.equal(options.receipt, null);
  const draft = { action: "assign", expectedInputDigest: options.inputDigest, nodeId: options.candidates[0].nodeId };
  const saved = await handler(req(path, "POST", draft)); assert.equal(saved.status, 201, await saved.clone().text());
  const { receipt } = await saved.json(); assert.equal(receipt.startsWork, false);
  assert.equal((await (await handler(req(base))).json()).task.state, "leased");
  assert.equal((await handler(req(path, "POST", draft))).status, 200);
  assert.equal((await (await handler(req())).json()).receipt.leaseId, receipt.leaseId);
  now = instant + 70_000;
  const expired = await handler(req(path, "POST", { action: "expire", expectedInputDigest: options.inputDigest }));
  assert.equal(expired.status, 201, await expired.clone().text()); assert.equal((await expired.json()).receipt.leaseState, "expired");
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(req())).status, 401);
});
