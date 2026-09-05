import assert from "node:assert/strict";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { ownerReviewFixture } from "./helpers/web-owner-review.ts";
import { binding, instant } from "./hermes-native-fixture.ts";
import { request, origin } from "./helpers/web-foundation.ts";

test("compiled private task routes record exact owner changes through Completion Gate and shared revocation", async t => {
  const f = await ownerReviewFixture();
  const app = installPrivateWebProcess({ ...f.accessTrust, origin, tenantId: binding.tenantId, workspaceId: f.scope.workspaceId,
    tasks: f.ownerKeys, loadKeys: async () => f.accessTrust.keys, database: { client: f.db, close: f.close }, clock: () => instant + 6000 });
  t.after(() => app.close());
  const base = `/api/v1/projects/${binding.projectId}/tasks/${binding.jobId}`, resultPath = `${base}/results`;
  const path = `${resultPath}/${f.artifact.artifactId}/reviews/${f.target.id}`;
  const req = (url, method = "GET", body, key) => request(url, method, body, key, f.jwt);
  assert.equal((await (await handler(req(resultPath))).json()).reviewCommands, "configured");
  const options = await handler(req(path)); assert.equal(options.status, 200); assert.equal((await options.json()).canReview, true);
  const draft = { ...f.draft, decision: "changes_requested", feedback: "Add a clear setup example." };
  const saved = await handler(req(path, "POST", draft, "compiled-owner-review-001")); assert.equal(saved.status, 201, await saved.clone().text());
  const receipt = (await saved.json()).receipt; assert.equal(receipt.startsRevision, false);
  assert.equal((await handler(req(path, "POST", draft, "compiled-owner-review-001"))).status, 200);
  const page = await (await handler(req(resultPath))).json(); assert.equal(page.reviews[0].status, "changes_requested");
  assert.equal((await (await handler(req(path))).json()).ownReview.feedback, draft.feedback);
  const shell = await (await handler(req(`/projects/${binding.projectId}/tasks/${binding.jobId}`))).text();
  assert.doesNotMatch(shell, /Add a clear setup example/);
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  assert.equal((await handler(req(path))).status, 401);
});
