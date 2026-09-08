import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { WebIdeaSynthesisOperation } from "../src/web/v1/idea-synthesis-operation";
import { WebIdeaDecisionOperation } from "../src/web/v1/idea-decision-operation";
import { CONTROL_ROOM_IDEA_ADAPTER_V1 } from "../src/idea-lab/v1/schemas";
import { fixture, scope, key, at } from "./helpers/web-idea-start";

test("completed injected panel becomes one recap and owner-selected project; replay creates neither again", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const synth = new WebIdeaSynthesisOperation(f.client, scope, key, () => now);
  const runId = `idea-run:${f.saved.sessionDigest.slice(7, 31)}`, input = { sessionDigest: f.saved.sessionDigest, runId };
  await assert.rejects(synth.synthesize(f.identity, f.saved.sessionId, input), /conflict/);
  await new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now).start(f.identity, f.saved.sessionId, { sessionDigest: f.saved.sessionDigest });
  await assert.rejects(synth.synthesize(f.identity, f.saved.sessionId, { ...input, runId: "idea-run:other" }), /conflict/);
  const receipt = await synth.synthesize(f.identity, f.saved.sessionId, input);
  assert.equal(receipt.replayed, false); assert.equal(receipt.startsWork, false);
  const replay = await new WebIdeaSynthesisOperation(f.client, scope, key, () => now + 1000).synthesize(f.identity, f.saved.sessionId, input);
  assert.equal(replay.replayed, true); assert.equal(replay.synthesisDigest, receipt.synthesisDigest);
  const saved = (await new IdeaLabProjectRegistryStoreV1(f.client, key).getSynthesis(scope.tenantId, f.saved.sessionId))!;
  assert.ok(saved.executiveSummary.includes("Extractive recap")); assert.ok(saved.executiveSummary.includes("Test opinion"));
  await f.client.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,$2,'control_room_native_ideas','1.0.0','control_room_native','fixture','v1',30)`, [CONTROL_ROOM_IDEA_ADAPTER_V1, scope.tenantId]);
  const value = { sessionDigest: input.sessionDigest, synthesisDigest: receipt.synthesisDigest,
    intent: { decision: "create_project", safeReasonCode: "owner_selected", project: { projectId: "project:recap-selected",
      title: "Shop experiment", summary: saved.nextExperiment, workspaceName: "Shop experiment", projectKind: "business_validation", priority: 50 } } };
  const decision = new WebIdeaDecisionOperation(f.client, scope, key, () => now + 2000);
  assert.equal((await decision.decide(f.identity, f.saved.sessionId, value)).projectId, "project:recap-selected");
  assert.equal((await decision.decide(f.identity, f.saved.sessionId, value)).replayed, true);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.synthesize'")).rows.length, 1);
  assert.equal((await f.client.query("SELECT * FROM control_jobs")).rows.length, 0);
  assert.equal(f.counts().calls, 4);
  await f.client.query("UPDATE control_role_grants SET revoked_at=$1", [at()]);
  await assert.rejects(synth.synthesize(f.identity, f.saved.sessionId, input), /access_denied/);
});
