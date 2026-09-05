import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { request, origin } from "./helpers/web-foundation";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { WebTaskService } from "../src/web/v1/task-service";
import { taskResultsPageSchema, taskResultContentSchema } from "../src/web/v1/task-result-wire";
import { sha256Digest } from "../src/security";

const path = "/api/v1/projects/project:test/tasks/job:test/results";
test("private results expose scoped content and exact recorded quality review without approving canonical work", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("A useful received document.");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const { profile, target } = await f.reviewTarget(receipt.contentHash);
  const base = { schemaVersion: "control-room-completion-gate/v1", tenantId: binding.tenantId, projectId: binding.projectId,
    targetId: target.id, targetDigest: sha256Digest(target), acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile),
    evidenceDigests: [receipt.contentHash], grantsApproval: false, grantsExecutionAuthority: false };
  await f.reviewStore.recordVerification({ ...base, id: "verification:content", scenarioId: "scenario:content", outcome: "passed",
    verifier: { actorId: "identity:verifier", actorType: "human" }, verifiedAt: at(3000) });
  await f.reviewStore.recordReview({ ...base, id: "review:content", authority: "completion_gate", decision: "accepted",
    reviewer: { actorId: "identity:test", actorType: "human" }, assessedRisk: "low", effectiveRisk: "low", findingIds: [], reviewedAt: at(4000) });
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  assert.equal(page.items.length, 1); assert.equal(page.items[0].qualityAccepted, false);
  assert.equal(page.reviews[0].status, "ready"); assert.deepEqual(page.reviews[0].matchingArtifactIds, [receipt.artifactId]);
  assert.equal(page.reviews[0].grantsApproval, false); assert.equal(page.reviewCommands, "not_connected");
  assert.equal(JSON.stringify(page).includes("A useful received document"), false);
  for (const value of ["node:test", "memory://", "identity:verifier", "auth_tag"])
    assert.equal(JSON.stringify(page).includes(value), false);
  const content = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  assert.equal(content.text, "A useful received document."); assert.equal(content.untrustedContent, true);
  assert.equal((await f.tasks.detail(f.identity, binding.projectId, binding.jobId)).task.state, "leased");
});

test("result bytes require a separate content grant, current project access and unrevoked session", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Access-scoped result");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["projects.read","tasks.read"]'::jsonb`);
  assert.equal(taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId)).canReadContent, false);
  await assert.rejects(f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId), { code: "access_denied" });
  await f.db.query(`UPDATE control_role_grants SET allowed_actions='["*"]'::jsonb,project_ids='["project:other"]'::jsonb`);
  await assert.rejects(f.tasks.results(f.identity, binding.projectId, binding.jobId), { code: "access_denied" });
  await f.db.query(`UPDATE control_role_grants SET project_ids='["*"]'::jsonb`);
  await assert.rejects(new WebTaskService(f.db, { ...f.scope, tenantId: "tenant:other" }, () => instant + 6000, f.taskKeys)
    .results(f.identity, binding.projectId, binding.jobId));
  await f.db.query("UPDATE control_web_sessions SET revoked_at=$1", [at(6000)]);
  await assert.rejects(f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId), { code: "authentication_required" });
});

test("missing configuration, empty records, wrong artifact and mismatched review fingerprint stay distinct", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const absent = taskResultsPageSchema.parse(await new WebTaskService(f.db, f.scope, () => instant + 6000)
    .results(f.identity, binding.projectId, binding.jobId));
  assert.equal(absent.resultSource, "not_configured"); assert.equal(absent.reviewSource, "not_configured");
  const empty = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  assert.equal(empty.resultSource, "configured"); assert.equal(empty.reviewSource, "configured"); assert.deepEqual(empty.items, []);
  await f.reviewTarget(sha256Digest("another result"));
  const input = f.complete("Current result"); await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  assert.deepEqual(taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId)).reviews[0].matchingArtifactIds, []);
  await assert.rejects(f.tasks.results(f.identity, binding.projectId, binding.jobId, "artifact:other"), { code: "not_found" });
});

test("recorded review reads verify the external checkpoint and never repair or advance it", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const earlier = f.checkpoints.read(`completion-gate:${binding.tenantId}`);
  await f.reviewTarget(sha256Digest("Result")); let writes = 0;
  const tasks = new WebTaskService(f.db, f.scope, () => instant + 6000, { ...f.taskKeys, reviews: { integrityKey: f.reviewKey,
    checkpoints: { read: () => earlier, initialize: () => { writes++; throw new Error(); }, advance: () => { writes++; throw new Error(); } } } });
  await assert.rejects(tasks.results(f.identity, binding.projectId, binding.jobId), /integrity_failed/); assert.equal(writes, 0);
  const checkpoint = f.checkpoints.read(`completion-gate:${binding.tenantId}`);
  await f.tasks.results(f.identity, binding.projectId, binding.jobId);
  assert.deepEqual(f.checkpoints.read(`completion-gate:${binding.tenantId}`), checkpoint);
});

test("private result HTTP accepts only authenticated same-origin GETs and never leaks content in errors", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Only authorized content");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const handle = createTaskHttpHandler({ origin, trust: f.accessTrust, clock: () => instant + 6000, service: f.tasks });
  const req = (url = path, method = "GET") => request(url, method, undefined, undefined, f.jwt);
  const metadata = await handle(req()); assert.equal(metadata.status, 200); assert.equal(metadata.headers.get("cache-control"), "no-store");
  const content = await handle(req(`${path}/${receipt.artifactId}`)); assert.equal(content.status, 200);
  assert.equal((await content.json()).text, "Only authorized content");
  for (const bad of [req(path, "POST"), req(`${path}/${receipt.artifactId}`, "DELETE"), req(`${path}?url=https://example.invalid`),
    request(`${path}/${receipt.artifactId}`, "GET", undefined, undefined, "invalid")]) {
    const response = await handle(bad); assert.ok(response.status >= 400); assert.equal((await response.text()).includes("Only authorized content"), false);
  }
  const cross = req(); cross.headers.set("sec-fetch-site", "cross-site"); assert.equal((await handle(cross)).status, 403);
});

test("restricted result process reads evidence while artifact and execution writes remain unavailable", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Restricted SQL result");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  await f.reviewTarget(receipt.contentHash);
  await f.raw.exec(await readFile("db/roles/private_web_roles.sql", "utf8"));
  await f.raw.exec("SET ROLE control_room_private_web");
  const app = createPrivateWebProcess({ ...f.accessTrust, origin, tenantId: binding.tenantId, workspaceId: f.scope.workspaceId,
    tasks: { ...f.taskKeys, harnessIntegrityKey: f.harnessKey }, loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: async () => {} }, clock: () => instant + 6000 });
  t.after(() => app.close());
  const handle = (url: string) => app.handle(request(url, "GET", undefined, undefined, f.jwt), () => new Response("shell"));
  assert.equal((await handle(path)).status, 200); assert.equal((await handle(`${path}/${receipt.artifactId}`)).status, 200);
  for (const sql of ["INSERT INTO control_native_artifact_receipts DEFAULT VALUES", "INSERT INTO control_artifact_manifests DEFAULT VALUES",
    "INSERT INTO control_completion_gate_records DEFAULT VALUES",
    "DELETE FROM control_native_artifact_receipts", "UPDATE control_jobs SET state='succeeded'"]) await assert.rejects(f.db.query(sql));
  assert.equal((await app.handle(request("/api/v1/session/logout", "POST", undefined, undefined, f.jwt), () => new Response())).status, 204);
  assert.equal((await handle(`${path}/${receipt.artifactId}`)).status, 401);
});
