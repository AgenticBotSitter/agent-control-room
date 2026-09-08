import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { WebIdeaService } from "../src/web/v1/idea-service";
import { fixture, scope, key, deferred } from "./helpers/web-idea-start";

test("a duplicate owner start reads the active run without blocking on a provider or dispatching twice", async t => {
  const f = await fixture(); t.after(() => f.db.close()); const entered = deferred(), release = deferred();
  const invoke = f.runtime.driver.invoke.bind(f.runtime.driver);
  f.runtime.driver.invoke = async input => { entered.resolve(); await release.promise; return invoke(input); };
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  const read = new WebIdeaService(f.client, scope, key, () => now, true, true, true, true);
  assert.equal((await read.detail(f.identity, f.saved.sessionId)).canStart, true);
  const first = service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  await entered.promise;
  assert.equal((await read.detail(f.identity, f.saved.sessionId)).canStart, false);
  const second = await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  assert.equal(second.replayed, true); assert.equal(second.state, "running");
  assert.equal(f.counts().resolutions, 1); release.resolve();
  const done = await first; assert.equal(done.state, "completed"); assert.equal(f.counts().calls, 4);
  assert.equal((await read.detail(f.identity, f.saved.sessionId)).canStart, false);
  assert.equal((await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest })).replayed, true);
  assert.equal(f.counts().calls, 4);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.panel_start'")).rows.length, 1);
});
