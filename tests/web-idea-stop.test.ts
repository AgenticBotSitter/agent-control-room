import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { taskFixture } from "./helpers/web-task";
import { now, request } from "./helpers/web-foundation";
import { startupConfig } from "./helpers/web-startup";
import { IdeaSessionCreationService } from "../src/web/v1/idea-create-operation";
import { createPrivateWebProcess } from "../src/web/v1/private-process";
import { IdeaLabProjectRegistryStoreV1 } from "../src/idea-lab/v1/store";
import { IdeaLabBotRunStoreV1 } from "../src/idea-lab/v1/coordinator-store";
import { buildIdeaLabBotRunV1 } from "../src/idea-lab/v1/coordinator";
import { buildIdeaLabFixtureV1 } from "../src/idea-lab/v1/fixture";
import { sha256Digest } from "../src/security";
import { createIdeaStopClient } from "../src/web/v1/idea-stop-client";
import { IdeaStopControl } from "../private-app/app/idea-stop-control";

test("protected stop saves one audit, recovers a lost response and cannot target another run or bypass logout", async t => {
  const f = await taskFixture(), key = new Uint8Array(32).fill(69), scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
  const service = new IdeaSessionCreationService(f.client, scope, key, buildIdeaLabFixtureV1().session.participants, () => now);
  const saved = await service.create(f.identity, { title: "Stop test", ideaSummary: "Help shops", targetCustomer: "Shop owners",
    maxRounds: 1, maxDurationSeconds: 300, maxCostUsd: 2 }, "idea-stop-create01");
  const session = (await new IdeaLabProjectRegistryStoreV1(f.client,key).getSession(scope.tenantId,saved.sessionId))!;
  const ledger = new IdeaLabBotRunStoreV1(f.client,key), runId = "idea-run:http-stop";
  await ledger.prepare(buildIdeaLabBotRunV1({ runId,...scope,sessionId:saved.sessionId,sessionDigest:saved.sessionDigest,
    evidenceDigests:session.participants.map(p=>sha256Digest(p.participantId)).sort(),state:"prepared",attempts:[],messagesUsed:0,
    costUsd:0,safeCode:"prepared",providerContacted:false,startedAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString() }));
  const app = createPrivateWebProcess({ ...startupConfig, database: { client:f.client,close:()=>f.db.close() },clock:()=>now,
    ideaProjects:{integrityKey:key},ideaCreation:{...scope,create:service.create.bind(service),stop:service.stop.bind(service)} });
  t.after(()=>app.close()); const path=`/api/v1/ideas/${encodeURIComponent(saved.sessionId)}/stop`;
  const body={runId,sessionDigest:saved.sessionDigest}, handle=(req:Request)=>app.handle(req,()=>new Response("shell"));
  assert.equal((await (await handle(request(`/api/v1/ideas/${saved.sessionId}`))).json()).canStop,true);
  assert.equal((await handle(request(path,"POST",{...body,runId:"idea-run:other"}))).status,409);
  const foreign=request(path,"POST",body);foreign.headers.set("origin","https://other.example");assert.equal((await handle(foreign)).status,403);
  let lose=true,calls=0;
  const client=createIdeaStopClient(async (url,options)=>{
    calls++;assert.equal(String(url),path);assert.equal(options?.redirect,"error");
    const response=await handle(request(String(url),"POST",JSON.parse(String(options?.body))));
    if(lose){lose=false;throw new Error("synthetic lost acknowledgement");}return response;
  });
  await assert.rejects(client.stop(saved.sessionId,body),/uncertain/);assert.equal(calls,1);
  const receipt=await client.stop(saved.sessionId,body);assert.equal(receipt.state,"cancelled");assert.equal(receipt.startsWork,false);
  assert.equal((await f.client.query("SELECT * FROM audit_events WHERE action='idea_lab.panel_cancel'")).rows.length,1);
  assert.equal((await (await handle(request(`/api/v1/ideas/${saved.sessionId}`))).json()).canStop,false);
  await handle(request("/api/v1/session/logout","POST"));assert.equal((await handle(request(path,"POST",body))).status,401);
  const html=renderToStaticMarkup(createElement(IdeaStopControl,{sessionId:saved.sessionId,sessionDigest:saved.sessionDigest,runId}));
  assert.ok(html.includes("Stop discussion"));assert.ok(html.includes("turn already underway"));
  const wrong=createIdeaStopClient(async()=>Response.json({...receipt,runId:"idea-run:wrong"}));
  await assert.rejects(wrong.stop(saved.sessionId,body),/uncertain/);
});
