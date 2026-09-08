import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { fixture, scope, key } from "./helpers/web-idea-start";

test("denied admission and unknown provider outcomes are retained without another attempt", async t => {
  for (const denied of [true, false]) await t.test(String(denied), async t => {
    const f = await fixture(); t.after(() => f.db.close()); let attempts = 0;
    f.runtime.admissionAuthority.consume = async () => !denied;
    f.runtime.driver.invoke = async () => { attempts++; throw new Error("synthetic unknown outcome"); };
    const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
    const result = await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
    assert.equal(result.state, denied ? "failed_definite" : "ambiguous"); assert.equal(attempts, denied ? 0 : 1);
    await service.start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
    assert.equal(attempts, denied ? 0 : 1); assert.equal(f.counts().resolutions, 1);
  });
});
