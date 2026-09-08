import assert from "node:assert/strict";
import test from "node:test";
import { now } from "./helpers/web-foundation";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { WebIdeaStartOperation } from "../src/web/v1/idea-start-operation";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { startupConfig } from "./helpers/web-startup";
import { request } from "./helpers/web-foundation";
import { WebIdeaSynthesisOperation } from "../src/web/v1/idea-synthesis-operation";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeaDiscussion } from "../private-app/app/idea-workspace";
import { ideaDetailSchema } from "../src/web/v1/idea-wire";
import { createIdeaSynthesisClient } from "../src/web/v1/idea-synthesis-client";
import { fixture, scope, key } from "./helpers/web-idea-start";

test("HTTP start remains unconfigured by default and requires same-origin authenticated exact requests", async t => {
  const f = await fixture(); t.after(() => f.db.close());
  const creation = new IdeaSessionCreationService(f.client, scope, key, buildIdeaLabFixtureV1().session.participants, () => now);
  const service = new WebIdeaStartOperation(f.client, f.runtimeDb, scope, key, f.runtime, () => now);
  const options = { ...startupConfig, database: { client: f.client, close: async () => {} }, clock: () => now,
    ideaProjects: { integrityKey: key }, ideaCreation: { ...scope, create: creation.create.bind(creation) } };
  const synthesis = new WebIdeaSynthesisOperation(f.client, scope, key, () => now);
  const closed = createPrivateWebProcess(options), app = createPrivateWebProcess({ ...options,
    ideaCreation: { ...options.ideaCreation, start: service.start.bind(service),
      synthesize: synthesis.synthesize.bind(synthesis) } });
  t.after(async () => { await closed.close(); await app.close(); });
  const path = `/api/v1/ideas/${encodeURIComponent(f.saved.sessionId)}/start`, body = { sessionDigest: f.saved.sessionDigest };
  const handle = (req: Request) => app.handle(req, () => new Response("shell"));
  const detail = async () => ideaDetailSchema.parse(await (await handle(request(`/api/v1/ideas/${encodeURIComponent(f.saved.sessionId)}`))).json());
  assert.equal((await detail()).canSynthesize, false);
  assert.equal((await closed.handle(request(path, "POST", body), () => new Response("shell"))).status, 503);
  const foreign = request(path, "POST", body); foreign.headers.set("origin", "https://other.example");
  assert.equal((await handle(foreign)).status, 403);
  const anonymous = request(path, "POST", body); anonymous.headers.delete("cf-access-jwt-assertion");
  assert.equal((await handle(anonymous)).status, 401);
  assert.equal((await handle(request(path, "GET"))).status, 400);
  assert.equal((await handle(request(path, "POST", { ...body, admission: {} }))).status, 400);
  assert.equal((await handle(request(path, "POST", { ...body, padding: "x".repeat(2200) }))).status, 400);
  assert.equal(f.counts().calls, 0);
  assert.equal((await handle(request(path, "POST", body))).status, 201);
  assert.equal((await handle(request(path, "POST", body))).status, 200);
  assert.equal(f.counts().calls, 4);
  const recapPath = `/api/v1/ideas/${encodeURIComponent(f.saved.sessionId)}/synthesis`;
  const recapInput = { ...body, runId: `idea-run:${f.saved.sessionDigest.slice(7, 31)}` };
  const ready = await detail(); assert.equal(ready.canSynthesize, true);
  assert.ok(renderToStaticMarkup(createElement(IdeaDiscussion, { detail: ready })).includes("Prepare recap"));
  assert.equal((await closed.handle(request(recapPath, "POST", recapInput), () => new Response("shell"))).status, 503);
  const foreignRecap = request(recapPath, "POST", recapInput); foreignRecap.headers.set("origin", "https://other.example");
  assert.equal((await handle(foreignRecap)).status, 403);
  assert.equal((await handle(request(recapPath, "POST", { ...recapInput, executiveSummary: "injected" }))).status, 400);
  let lose = true, recapRequests = 0;
  const recapClient = createIdeaSynthesisClient(async (url, options) => {
    recapRequests++; assert.equal(String(url), recapPath);
    const response = await handle(request(String(url), "POST", JSON.parse(String(options?.body))));
    if (lose) { lose = false; throw new Error("synthetic lost recap acknowledgement"); } return response;
  });
  await assert.rejects(recapClient.synthesize(f.saved.sessionId, recapInput), /uncertain/); assert.equal(recapRequests, 1);
  assert.equal((await recapClient.synthesize(f.saved.sessionId, recapInput)).replayed, true);
  assert.equal((await handle(request(recapPath, "POST", recapInput))).status, 200);
  const prepared = await detail(); assert.equal(prepared.canSynthesize, false);
  assert.ok(!renderToStaticMarkup(createElement(IdeaDiscussion, { detail: prepared })).includes("Prepare recap</button>"));
  assert.equal(f.counts().calls, 4);
  await handle(request("/api/v1/session/logout", "POST"));
  assert.equal((await handle(request(path, "POST", body))).status, 401);
  assert.equal((await handle(request(recapPath, "POST", recapInput))).status, 401);
});
