import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { fixture, scope, key } from "./helpers/web-idea-start";

test("interruption after a durable claim does not resubmit a prepared run on retry", async t => {
  const f = await fixture(); t.after(() => f.db.close()); let checks = 0;
  f.runtime.admissionAuthority.consume = async () => { checks++; throw new Error("synthetic uncertain admission"); };
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  await assert.rejects(service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest }), /uncertain admission/);
  const replay = await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  assert.equal(replay.state, "prepared"); assert.equal(replay.replayed, true); assert.equal(replay.retryPermitted, false);
  assert.equal(checks, 1); assert.equal(f.counts().calls, 0); assert.equal(f.counts().resolutions, 1);
});
