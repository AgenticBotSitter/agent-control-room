import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import handler from "../dist-vps/server/index.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { taskAssignmentFixture } from "./helpers/task-assignment.ts";
import { sha256Digest } from "../src/security/index.ts";
import { binding, instant } from "./hermes-native-fixture.ts";
import { at } from "./native-task-fixture.ts";
import { request, origin } from "./helpers/web-foundation.ts";

test("compiled assignment keeps scheduled planning and allocation server-only", async () => {
  const compiled = await readFile(new URL("../dist-vps/server/taskApplication.js", import.meta.url), "utf8");
  assert.match(compiled, /service:schedule-assignment:v1/);
  assert.match(compiled, /scheduled\.tasks\.plan/);
  assert.doesNotMatch(compiled, /api\/v1\/scheduled-assignment/);
});

test("compiled private assignment API records, reads and expires a real lease under shared logout", async t => {
  const f = await taskAssignmentFixture(); let now = instant + 8000;
  const coordinator = f.create(f.db, () => now);
  const app = installPrivateWebProcess({ ...f.accessTrust, ...f.scope, origin, tasks: f.ownerKeys,
    assignment: coordinator.webOperation(), loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: f.close }, clock: () => now });
  t.after(() => app.close());
  const base = `/api/v1/projects/${f.prepared.receipt.projectId}/tasks/${f.prepared.receipt.jobId}`, path = `${base}/assignment`;
  const req = (url = path, method = "GET", body) => request(url, method, body, undefined, f.jwt);
  assert.deepEqual(Object.keys(coordinator.webOperation()).sort(), ["assign", "expire", "options", "tenantId", "workspaceId"]);
  assert.equal("assignLocked" in coordinator, false);
  const options = await (await handler(req())).json(); assert.equal(options.candidates.length, 1); assert.equal(options.receipt, null);
  const draft = { action: "assign", expectedInputDigest: options.inputDigest, nodeId: options.candidates[0].nodeId };
  const anonymous = new Request(`${origin}${path}`, { method: "POST", headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(draft) });
  assert.equal((await handler(anonymous)).status, 401);
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

test("locked assignment preserves owner replay and node capacity", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const coordinator = f.create(f.db, () => instant + 8000, [{ ...f.route, maxConcurrentTasks: 2 }]);
  const first = await coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId,
    binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(first.replayed, false);
  const replay = await coordinator.assign(f.identity, binding.projectId, f.prepared.receipt.jobId,
    binding.nodeId, f.prepared.receipt.inputDigest);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);

  const secondDraft = { ...f.sourceDraft, title: "Compare two more launch ideas" };
  const secondSource = await f.tasks.propose(f.identity, binding.projectId, secondDraft, "assignment-source-capacity-002");
  const second = await f.planner.plan(f.identity, binding.projectId, secondSource.receipt.jobId, sha256Digest(secondDraft));
  await assert.rejects(coordinator.assign(f.identity, binding.projectId, second.receipt.jobId,
    binding.nodeId, second.receipt.inputDigest), { message: "conflict" });
  const active = await f.db.query("SELECT id FROM control_leases WHERE tenant_id=$1 AND node_id=$2 AND state='active'",
    [f.scope.tenantId, binding.nodeId]);
  assert.equal(active.rows.length, 2);
});

test("locked assignment preserves current fleet eligibility refusal", async t => {
  const f = await taskAssignmentFixture(); t.after(f.close);
  const critical = { ...f.telemetry, sequence: 2, observedAt: at(7000), fingerprint: sha256Digest("critical-telemetry"),
    payload: { ...f.telemetry.payload, thermalState: "critical" } };
  await f.signals.ingestAuthenticated(critical, at(7000), binding);
  await assert.rejects(f.assign(), { message: "conflict" });
  const attempts = await f.db.query("SELECT id FROM control_attempts WHERE tenant_id=$1 AND job_id=$2",
    [f.scope.tenantId, f.prepared.receipt.jobId]);
  const leases = await f.db.query("SELECT id FROM control_leases WHERE tenant_id=$1 AND job_id=$2",
    [f.scope.tenantId, f.prepared.receipt.jobId]);
  assert.equal(attempts.rows.length, 0); assert.equal(leases.rows.length, 0);
});
