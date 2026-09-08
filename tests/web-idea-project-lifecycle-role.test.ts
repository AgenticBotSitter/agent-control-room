import assert from "node:assert/strict";
import test from "node:test";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup.ts";
import { now, request } from "./helpers/web-foundation.ts";
import { createPrivateWebProcess } from "../src/web/v1/private-process.ts";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight.ts";

test("mounted Idea lifecycle works with restricted SQL permissions and exact action projection", async t => {
  const f = await limitedWebFixture();
  const app = createPrivateWebProcess({ ...startupConfig, database: f.pool, clock: () => now });
  t.after(() => app.close());
  await verifyPrivateDatabase(f.pool.client, startupConfig.database, startupConfig, now);
  const handle = (input: Request) => app.handle(input, () => new Response("shell"));
  const path = "/api/v1/projects/project.idea%3Aweb";
  const read = async () => (await (await handle(request(path))).json()).project;
  assert.deepEqual((await read()).ideaLifecycleActions, ["pause", "complete"]);
  for (const [index, action, actions] of [
    [1, "complete", ["archive"]], [2, "archive", ["reopen"]], [3, "reopen", ["pause", "complete"]],
  ] as const) {
    const response = await handle(request(`${path}/idea-lifecycle`, "POST", { action, expectedVersion: index }, `restricted-idea-${action}-001`));
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).project.version, index + 1);
    assert.deepEqual((await read()).ideaLifecycleActions, actions);
  }
  const replay = await handle(request(`${path}/idea-lifecycle`, "POST", { action: "complete", expectedVersion: 1 }, "restricted-idea-complete-001"));
  assert.equal((await replay.json()).replayed, true);
  const forged = request(`${path}/idea-lifecycle`, "POST", { action: "pause", expectedVersion: 4 }, "restricted-idea-crossorigin");
  forged.headers.set("origin", "https://other.example.invalid");
  assert.equal((await handle(forged)).status, 403);
  // A missing newly required column grant must fail startup, not leave a working-looking control.
  await f.db.exec("SET SESSION AUTHORIZATION postgres; REVOKE UPDATE (payload) ON projects FROM control_room_private_web; SET SESSION AUTHORIZATION web_test");
  assert.equal((await f.client.query<{ allowed: boolean }>("SELECT has_column_privilege('projects','payload','UPDATE') AS allowed")).rows[0].allowed, false);
  await assert.rejects(verifyPrivateDatabase(f.pool.client, startupConfig.database, startupConfig, now), /preflight_failed/);
});
