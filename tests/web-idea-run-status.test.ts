import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { taskFixture } from "./helpers/web-task";
import { now } from "./helpers/web-foundation";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { WebIdeaService } from "../src/web/v1/idea-service";
import { ideaDetailSchema } from "../src/web/v1/idea-wire";
import { IdeaDiscussion } from "../private-app/app/idea-workspace";
import { IdeaLabBotRunStoreV1 } from "../src/idea-lab/v1/coordinator-store";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { buildRepositoryFakeProviderEvidenceV1, IdeaLabBotCoordinatorV1, DeterministicIdeaLabFakeDriverV1 } from "../src/idea-lab/v1/coordinator";

const key = new Uint8Array(32).fill(65), scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
async function fixture() {
  const f = await taskFixture(), roster = buildIdeaLabFixtureV1().session.participants;
  const saved = await new IdeaSessionCreationService(f.client, scope, key, roster, () => now).create(f.identity,
    { title: "Test idea", ideaSummary: "Help local shops", targetCustomer: "Shop owners", maxRounds: 1, maxDurationSeconds: 300, maxCostUsd: 2 }, "idea-status-0001");
  const registry = new IdeaLabProjectRegistryStoreV1(f.client, key), ledger = new IdeaLabBotRunStoreV1(f.client, key);
  const session = (await registry.getSession(scope.tenantId, saved.sessionId))!;
  const evidence = session.participants.map((p, i) => buildRepositoryFakeProviderEvidenceV1(session, p,
    { evidenceId: `evidence:status:${i}`, capturedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300000).toISOString() }));
  const service = new WebIdeaService(f.client, scope, key, () => now);
  return { ...f, registry, ledger, session, evidence, service };
}
test("private Idea status shows a pending stop and settled cancellation without claiming live connection", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  assert.equal((await f.service.detail(f.identity, f.session.sessionId)).run, null);
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; }), released = new Promise<void>(resolve => { release = resolve; });
  const fake = new DeterministicIdeaLabFakeDriverV1();
  const coordinator = new IdeaLabBotCoordinatorV1(f.ledger, f.registry, { mode: "repository_fake", async invoke(input) {
    entered(); await released; return fake.invoke(input);
  } }, () => new Date(now).toISOString());
  const pending = coordinator.execute({ runId: "idea-run:status", session: f.session, evidence: f.evidence, safePrompt: "Discuss this idea." });
  await waiting;
  const running = ideaDetailSchema.parse(await f.service.detail(f.identity, f.session.sessionId));
  assert.equal(running.run?.state, "running"); assert.equal(running.run.messagesUsed, 0);
  const html = renderToStaticMarkup(createElement(IdeaDiscussion, { detail: running }));
  assert.ok(html.includes("no settled result")); assert.ok(html.includes("does not prove that a bot is still connected"));
  await f.ledger.requestCancel("idea-run:status",new Date(now).toISOString());
  const stopping=ideaDetailSchema.parse(await f.service.detail(f.identity,f.session.sessionId));
  assert.ok(renderToStaticMarkup(createElement(IdeaDiscussion,{detail:stopping})).includes("Stop requested. This is not confirmation"));
  release(); await pending;
  const completed = ideaDetailSchema.parse(await f.service.detail(f.identity, f.session.sessionId));
  assert.equal(completed.run?.state, "cancelled"); assert.equal(completed.run.messagesUsed, 1);
  assert.equal(completed.run.providerContacted, false); assert.equal(completed.contributions.length, 1);
  assert.equal(ideaDetailSchema.safeParse({ ...completed, run: { ...completed.run, sessionId: "idea:other" } }).success, false);
  assert.equal(ideaDetailSchema.safeParse({ ...completed, run: { ...completed.run, messagesUsed: 3 } }).success, false);
});
test("completed panel status requires all retained turns",async t=>{
  const f=await fixture();t.after(()=>f.db.close());
  await new IdeaLabBotCoordinatorV1(f.ledger,f.registry,new DeterministicIdeaLabFakeDriverV1(),()=>new Date(now).toISOString())
    .execute({runId:"idea-run:completed",session:f.session,evidence:f.evidence,safePrompt:"Discuss."});
  const detail=ideaDetailSchema.parse(await f.service.detail(f.identity,f.session.sessionId));
  assert.equal(detail.run?.state,"completed");assert.equal(detail.run.messagesUsed,4);assert.equal(detail.contributions.length,4);
  assert.equal(ideaDetailSchema.safeParse({...detail,run:{...detail.run,messagesUsed:3}}).success,false);
});
test("uncertain provider outcome is visible and conflicting panel histories are not silently selected", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const coordinator = new IdeaLabBotCoordinatorV1(f.ledger, f.registry, { mode: "repository_fake", async invoke() { throw new Error("synthetic uncertainty"); } }, () => new Date(now).toISOString());
  const input = { runId: "idea-run:uncertain", session: f.session, evidence: f.evidence, safePrompt: "Discuss." };
  await coordinator.execute(input);
  const detail = ideaDetailSchema.parse(await f.service.detail(f.identity, f.session.sessionId));
  assert.equal(detail.run?.state, "ambiguous");
  assert.ok(renderToStaticMarkup(createElement(IdeaDiscussion, { detail })).includes("Outcome uncertain — do not restart"));
  await coordinator.execute({ ...input, runId: "idea-run:conflicting" });
  await assert.rejects(f.service.detail(f.identity, f.session.sessionId), /state_conflict/);
});
