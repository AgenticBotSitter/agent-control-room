import assert from "node:assert/strict";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { webNativeResultFixture } from "./helpers/web-native-result.ts";
import { binding, instant } from "./hermes-native-fixture.ts";
import { at } from "./native-task-fixture.ts";
import { request, origin } from "./helpers/web-foundation.ts";

test("compiled private result routes read signed native artifacts and checkpoint-verified reviews under shared revocation", async t => {
  const f = await webNativeResultFixture();
  const input = f.complete("Synthetic compiled artifact result");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  await f.reviewTarget(receipt.contentHash);
  const app = installPrivateWebProcess({ ...f.accessTrust, origin, tenantId: binding.tenantId, workspaceId: f.scope.workspaceId,
    tasks: f.taskKeys, loadKeys: async () => f.accessTrust.keys,
    database: { client: f.db, close: f.close }, clock: () => instant + 6000 });
  t.after(() => app.close());
  const req = (path, method = "GET") => request(path, method, undefined, undefined, f.jwt);
  const base = "/api/v1/projects/project:test/tasks/job:test", route = `${base}/results`;
  const shell = await handler(req("/projects/project:test/tasks/job:test")); assert.equal(shell.status, 200);
  const html = await shell.text(); assert.match(html, /Loading protected tasks/); assert.doesNotMatch(html, /Synthetic compiled artifact result/);
  const detail = await (await handler(req(base))).json(); assert.equal(detail.artifacts, "configured"); assert.equal(detail.review, "recorded");
  const metadata = await handler(req(route)); assert.equal(metadata.status, 200);
  const page = await metadata.json(); assert.equal(page.items.length, 1); assert.equal(page.reviews[0].status, "pending");
  assert.deepEqual(page.reviews[0].matchingArtifactIds, [receipt.artifactId]);
  const content = await handler(req(`${route}/${receipt.artifactId}`)); assert.equal(content.status, 200);
  assert.equal(content.headers.get("cache-control"), "no-store"); assert.equal((await content.json()).text, "Synthetic compiled artifact result");
  assert.equal((await handler(req("/api/v1/session/logout", "POST"))).status, 204);
  for (const path of [route, `${route}/${receipt.artifactId}`, base]) assert.equal((await handler(req(path))).status, 401);
});
