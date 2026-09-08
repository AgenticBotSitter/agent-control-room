import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { fixture, scope, key, deferred } from "./helpers/web-idea-start";

test("two starts that both reach lookup still produce only one owned claim", async t => {
  const f = await fixture(); t.after(() => f.db.close()); const both = deferred(), release = deferred();
  const resolve = f.runtime.resolve.bind(f.runtime); let waiting = 0;
  f.runtime.resolve = async (...args) => {
    const material = await resolve(...args); if (++waiting === 2) both.resolve(); await release.promise; return material;
  };
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  const a = service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  const b = service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  await both.promise; release.resolve(); const results = await Promise.all([a, b]);
  assert.equal(results.filter(r => !r.replayed).length, 1); assert.equal(f.counts().calls, 4);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.panel_start'")).rows.length, 1);
});
