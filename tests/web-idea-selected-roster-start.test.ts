import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { WebIdeaService } from "../src/web/v1/idea-service";
import { fixture, scope, key } from "./helpers/web-idea-start";

test("the selected three-person roster reaches only those three injected participants and never restarts on replay", async t => {
  const selected = ["bot:customer", "bot:market", "bot:skeptic"];
  const f = await fixture(selected); t.after(() => f.db.close());
  const read = new WebIdeaService(f.client, scope, key, () => now);
  assert.deepEqual((await read.detail(f.identity, f.saved.sessionId)).session.participants.map(p => p.participantId), selected);
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  const input = { sessionDigest: f.saved.sessionDigest };
  assert.equal((await service.start(f.identity, f.saved.sessionId, input)).state, "completed");
  assert.equal(f.counts().calls, 3);
  const detail = await read.detail(f.identity, f.saved.sessionId);
  assert.deepEqual(detail.contributions.map(c => c.participantId).sort(), [...selected].sort());
  assert.equal((await service.start(f.identity, f.saved.sessionId, input)).replayed, true);
  assert.equal(f.counts().calls, 3);
});
