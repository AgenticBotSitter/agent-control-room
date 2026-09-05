import assert from "node:assert/strict";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { ownerReviewFixture } from "./helpers/web-owner-review.ts";
import { taskDraft } from "./helpers/web-task.ts";
import { instant, enrollment } from "./hermes-native-fixture.ts";
import { request, origin } from "./helpers/web-foundation.ts";
import { TaskExecutionPlanner } from "../src/web/v1/task-execution-planner.ts";
import { computeAuthorityDigest, sha256Digest } from "../src/security/index.ts";

test("compiled task page and protected planning API use the supplied real planner without dispatch", async t => {
  const f = await ownerReviewFixture();
  const authority = { projectId: f.profile.projectId, allowedExecutor: "executor:hermes-native",
    allowedOperations: ["harness.hermes.native.start"], credentialRefs: ["credential:test"], filesystemRoots: [],
    networkPolicy: "allowlist", allowedNetworkDestinations: [enrollment.canonicalDestination], effectPolicy: "approval_required",
    maxRisk: "low", maxDurationSeconds: 60, maxConcurrentEffects: 1, expiresAt: new Date(instant + 300_000).toISOString(), digest: "" };
  authority.digest = computeAuthorityDigest(authority);
  const planner = new TaskExecutionPlanner(f.db, f.scope, { template: { id: "template:compiled", adapter: "hermes-native-runs/v1",
    instructions: "Use only the supplied information.", authority, acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) },
    integrityKey: new Uint8Array(32).fill(55), reviewIntegrityKey: f.reviewKey, checkpoints: f.checkpoints }, () => instant + 7000);
  const app = installPrivateWebProcess({ ...f.accessTrust, ...f.scope, origin,
    tasks: f.ownerKeys, planning: planner.webOperation(), loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: f.close }, clock: () => instant + 7000 });
  t.after(() => app.close());
  const base = `/api/v1/projects/${f.profile.projectId}/tasks`;
  const req = (path, method = "GET", body) => request(path, method, body, "compiled-plan-source-001", f.jwt);
  const proposal = await handler(req(base, "POST", taskDraft)); assert.equal(proposal.status, 201);
  const source = (await proposal.json()).receipt.jobId, planPath = `${base}/${source}/plan`;
  assert.equal((await (await handler(req(planPath))).json()).availability, "available");
  const response = await handler(req(planPath, "POST", { expectedInputDigest: sha256Digest(taskDraft) }));
  assert.equal(response.status, 201, await response.clone().text()); const { receipt } = await response.json();
  assert.equal(receipt.startsWork, false); assert.equal(receipt.grantsExecutionAuthority, false);
  const prepared = await (await handler(req(`${base}/${receipt.jobId}`))).json();
  assert.equal(prepared.task.state, "proposed"); assert.deepEqual(prepared.attempts, []);
  const shell = await handler(req(`/projects/${f.profile.projectId}/tasks/${source}`));
  assert.equal(shell.status, 200); assert.doesNotMatch(await shell.text(), /Use only the supplied information/);
  assert.equal((await handler(req(planPath, "POST", { expectedInputDigest: sha256Digest(taskDraft) }))).status, 200);
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(req(planPath))).status, 401);
});
