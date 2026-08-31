import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { adaptPglite } from "../src/persistence/database";
import { InMemoryRollbackCheckpointStoreV1 } from "../src/security";
import { sha256Digest } from "../src/security/digest";
import { issueTelegramCallbackTokenV1, TelegramDurableStoreV1, TelegramIngressServiceV1, TelegramStoreErrorV1, TelegramSyntheticDeliveryCoordinatorV1,
  telegramSecretDigestForConfigurationV1, TELEGRAM_CONTRACT_VERSION_V1,
  type TelegramCallbackRecordV1, type TelegramMessagePlanV1, type TelegramPresentationV1, type TelegramRecipientPolicyV1 } from "../src/telegram/v1";
import { cr8dTelegramPresentationFixture } from "../app/fixtures/cr8d-ui";
import { observedProxy,type ObservedProxyMode } from "./proxy-test-helper";

const tenantId="tenant:control-room",projectId="project.wayfarer.lazy-river",recipientId="recipient:owner";
const integrityKey=new Uint8Array(32).fill(0x71),callbackKey=new Uint8Array(32).fill(0x52);
const t0="2026-08-28T18:01:00.000Z";const digest=(label:string)=>sha256Digest({label});

async function setup(initialPolicy=policy()){const raw=new PGlite();for(const file of (await readdir(resolve("db/migrations"))).filter((entry)=>entry.endsWith(".sql")).sort())await raw.exec(await readFile(resolve("db/migrations",file),"utf8"));
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ($1,'Telegram')`,[tenantId]);await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:telegram',$1,'Telegram')`,[tenantId]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days) VALUES ('adapter:telegram',$1,'fixture','v1','advisory','v1',30)`,[tenantId]);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload) VALUES ($1,$2,'workspace:telegram','adapter:telegram','source:telegram','v1','Telegram','ready','ready','healthy','advisory',$3,'{}'::jsonb)`,[projectId,tenantId,t0]);
  const checkpoints=new InMemoryRollbackCheckpointStoreV1({testOnly:true}),store=new TelegramDurableStoreV1(adaptPglite(raw),integrityKey,callbackKey,checkpoints);await store.provisionTenant(tenantId);await store.registerRecipient(initialPolicy);return{raw,store,checkpoints};}
function policy(overrides:Partial<TelegramRecipientPolicyV1>={}):TelegramRecipientPolicyV1{return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,recipientId,tenantId,chatIdDigest:digest("chat"),enabled:true,
  verifiedAt:"2026-08-28T17:00:00.000Z",allowedProjectIds:[projectId],allowedMessageClasses:["approval_request","incident","question","review"],maximumRisk:"critical",quietHours:null,
  criticalMayBypassQuietHours:false,groupingWindowSeconds:120,policyExpiresAt:"2026-09-01T00:00:00.000Z",...overrides};}
function messagePlan(overrides:Partial<TelegramMessagePlanV1>={}):TelegramMessagePlanV1{return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,messagePlanId:"message-plan:durable",tenantId,projectId,recipientId,
  attentionId:"attention:question",attentionDigest:digest("attention"),messageClass:"question",risk:"medium",urgency:"urgent",delivery:"deliver_now",groupingKey:"group:question",
  safeTitle:"Question needs review",safeSummary:"Review the bounded question in Control Room.",evidenceDigests:[],responseKinds:["request_review"],responseOptions:[],
  deepLink:{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,attentionId:"attention:question",attentionDigest:digest("attention"),path:"/attention/attention:question",requiresAuthenticatedDashboard:true,requiresStrongFactorForConsequentialApproval:true,grantsApproval:false,grantsExecutionAuthority:false},
  createdAt:"2026-08-28T18:00:00.000Z",expiresAt:"2026-08-28T18:10:00.000Z",grantsApproval:false,grantsExecutionAuthority:false,...overrides};}
function callback(overrides:Partial<TelegramCallbackRecordV1>={}):TelegramCallbackRecordV1{return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,callbackId:"cb_durable_001",tenantId,projectId,recipientId,
  chatIdDigest:digest("chat"),attentionId:"attention:question",attentionDigest:digest("attention"),messageClass:"question",risk:"medium",responseKind:"request_review",messagePlanDigest:sha256Digest(messagePlan()),
  issuedAt:"2026-08-28T18:00:00.000Z",expiresAt:"2026-08-28T18:10:00.000Z",grantsApproval:false,grantsExecutionAuthority:false,...overrides};}
function registration(record=callback(),plan=messagePlan()){return{record,messagePlan:plan};}
function presentation(overrides:Partial<TelegramPresentationV1>={}):TelegramPresentationV1{return{...cr8dTelegramPresentationFixture[0],...overrides};}
function observation(token:string,overrides:Record<string,unknown>={}){return{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,updateId:501,bodyDigest:digest("body"),chatIdDigest:digest("chat"),callbackQueryIdDigest:digest("query"),callbackToken:token,observedAt:t0,...overrides};}
const isCode=(code:string)=>(error:unknown)=>error instanceof TelegramStoreErrorV1&&error.safeCode===code;

test("CR8D durable recipient and callback registration are exact-replay safe and scoped",async()=>{const{raw,store}=await setup();try{
  assert.equal((await store.registerRecipient(policy())).replayed,true);await assert.rejects(store.registerRecipient(policy({maximumRisk:"medium"})),isCode("record_conflict"));
  const item=callback();assert.equal((await store.registerCallback(registration(item))).replayed,false);assert.equal((await store.registerCallback(registration(item))).replayed,true);
  await assert.rejects(store.registerCallback(registration(callback({callbackId:"cb_wrong_chat",chatIdDigest:digest("wrong")}))),isCode("recipient_not_allowed"));
  await assert.rejects(store.registerCallback(registration(callback({callbackId:"cb_unbound",messagePlanDigest:digest("unbound-plan")}))),isCode("callback_invalid"));
  const high=messagePlan({messagePlanId:"message-plan:high",risk:"high",responseKinds:[]});await assert.rejects(store.registerCallback(registration(callback({callbackId:"cb_high",messagePlanDigest:sha256Digest(high)}),high)),isCode("callback_invalid"));
}finally{await raw.close();}});

test("CR8D callback consumption survives restart, replays exactly, and stores no callback token",async()=>{const{raw,store,checkpoints}=await setup();try{
  const item=callback(),token=issueTelegramCallbackTokenV1(item,callbackKey);await store.registerCallback(registration(item));
  const first=await store.consumeCallback({tenantId,recipientId,observation:observation(token),now:t0});assert.equal(first.status,"recorded");assert.equal(first.proposal.grantsApproval,false);
  const restarted=new TelegramDurableStoreV1(adaptPglite(raw),integrityKey,callbackKey,checkpoints);const replay=await restarted.consumeCallback({tenantId,recipientId,observation:observation(token),now:t0});assert.equal(replay.status,"replayed");assert.deepEqual(replay.proposal,first.proposal);
  const rows=await raw.query<{body:string}>(`SELECT observation::text AS body FROM control_telegram_updates`);assert.doesNotMatch(rows.rows[0].body,new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
  assert.match(rows.rows[0].body,/callbackTokenDigest/);assert.equal((await raw.query(`SELECT * FROM control_telegram_callback_receipts`)).rows.length,1);
}finally{await raw.close();}});

test("CR8D callback update drift, callback reuse, wrong chat, and wrong MAC fail closed",async()=>{const{raw,store}=await setup();try{
  const item=callback(),token=issueTelegramCallbackTokenV1(item,callbackKey);await store.registerCallback(registration(item));await store.consumeCallback({tenantId,recipientId,observation:observation(token),now:t0});
  await assert.rejects(store.consumeCallback({tenantId,recipientId,observation:observation(token,{bodyDigest:digest("drift")}),now:t0}),isCode("replay_conflict"));
  await assert.rejects(store.consumeCallback({tenantId,recipientId,observation:observation(token,{updateId:502,callbackQueryIdDigest:digest("other")}),now:t0}),isCode("callback_consumed"));
  await assert.rejects(store.consumeCallback({tenantId,recipientId,observation:observation(token,{chatIdDigest:digest("other")}),now:t0}),isCode("recipient_not_allowed"));
  const tampered=`${token.slice(0,-1)}${token.endsWith("A")?"B":"A"}`;await assert.rejects(store.consumeCallback({tenantId,recipientId,observation:observation(tampered),now:t0}),isCode("callback_invalid"));
}finally{await raw.close();}});

test("CR8D delivery enqueue and successful settlement are idempotent across restart",async()=>{const{raw,store,checkpoints}=await setup();try{
  const queued=await store.enqueue({deliveryId:"delivery:one",idempotencyKey:"send:one",presentation:presentation(),now:t0});assert.equal(queued.replayed,false);
  assert.equal((await store.enqueue({deliveryId:"delivery:one",idempotencyKey:"send:one",presentation:presentation(),now:t0})).replayed,true);
  const claim=await store.claimNext({tenantId,claimId:"claim:one",now:t0,leaseSeconds:30});assert.equal(claim?.state,"sending");assert.equal(claim?.attemptCount,1);
  const receipt=await store.settle({tenantId,deliveryId:"delivery:one",claimId:"claim:one",now:"2026-08-28T18:01:01.000Z",outcome:"delivered",providerReceiptDigest:digest("provider-message")});assert.equal(receipt.state,"delivered");
  const restarted=new TelegramDurableStoreV1(adaptPglite(raw),integrityKey,callbackKey,checkpoints);assert.equal((await restarted.getDelivery(tenantId,"delivery:one"))?.state,"delivered");
  assert.deepEqual(await restarted.settle({tenantId,deliveryId:"delivery:one",claimId:"claim:one",now:"2026-08-28T18:01:02.000Z",outcome:"delivered",providerReceiptDigest:digest("provider-message")}),receipt);
  await assert.rejects(restarted.settle({tenantId,deliveryId:"delivery:one",claimId:"claim:one",now:"2026-08-28T18:01:02.000Z",outcome:"delivered",providerReceiptDigest:digest("provider-message"),safeReasonCode:"drift"}),isCode("invalid_record"));
  assert.equal(await restarted.claimNext({tenantId,claimId:"claim:other",now:"2026-08-28T18:01:03.000Z",leaseSeconds:30}),undefined);
}finally{await raw.close();}});

test("CR8Q Telegram settlement Proxies execute zero traps and cannot mutate delivery state",async()=>{for(const mode of ["transparent","key_hiding","descriptor_fabricating","throwing"] as ObservedProxyMode[]){const{raw,store}=await setup();try{const deliveryId=`delivery:proxy:${mode}`,claimId=`claim:proxy:${mode}`;await store.enqueue({deliveryId,idempotencyKey:`send:proxy:${mode}`,presentation:presentation({...presentation(),presentationId:`tgpresentation:proxy:${mode}`}),now:t0});await store.claimNext({tenantId,claimId,now:t0,leaseSeconds:30});
    const target={tenantId,deliveryId,claimId,now:"2026-08-28T18:01:01.000Z",outcome:"delivered" as const,providerReceiptDigest:digest(`proxy-provider-${mode}`),...(mode==="key_hiding"?{[Symbol("hidden")]:true}:{})},proxy=observedProxy(target,mode);await assert.rejects(store.settle(proxy.value),isCode("invalid_record"));assert.equal(proxy.trapCount(),0);assert.equal((await store.getDelivery(tenantId,deliveryId))?.state,"sending");
    const receipt=await store.settle({tenantId,deliveryId,claimId,now:"2026-08-28T18:01:02.000Z",outcome:"delivered",providerReceiptDigest:digest(`proxy-provider-${mode}`)});assert.equal(receipt.state,"delivered");
  }finally{await raw.close();}}});

test("CR8D only definite failures retry and the third attempt dead-letters",async()=>{const{raw,store}=await setup();try{
  await store.enqueue({deliveryId:"delivery:retry",idempotencyKey:"send:retry",presentation:presentation(),now:t0});
  for(let attempt=1;attempt<=3;attempt++){const second=attempt*2;const claimId=`claim:retry:${attempt}`;const claim=await store.claimNext({tenantId,claimId,now:`2026-08-28T18:01:0${second-2}.000Z`,leaseSeconds:5});assert.equal(claim?.attemptCount,attempt);
    const receipt=await store.settle({tenantId,deliveryId:"delivery:retry",claimId,now:`2026-08-28T18:01:0${second-1}.000Z`,outcome:"definite_failure",...(attempt<3?{retryAfterSeconds:1}:{} )});assert.equal(receipt.state,attempt===3?"dead_letter":"retry_wait");}
  assert.equal((await store.getDelivery(tenantId,"delivery:retry"))?.state,"dead_letter");
}finally{await raw.close();}});

test("CR8D ambiguous outcome and expired claim never auto-retry",async()=>{const{raw,store}=await setup();try{
  await store.enqueue({deliveryId:"delivery:ambiguous",idempotencyKey:"send:ambiguous",presentation:presentation(),now:t0});await store.claimNext({tenantId,claimId:"claim:ambiguous",now:t0,leaseSeconds:5});
  const ambiguous=await store.settle({tenantId,deliveryId:"delivery:ambiguous",claimId:"claim:ambiguous",now:"2026-08-28T18:01:01.000Z",outcome:"ambiguous"});assert.equal(ambiguous.state,"ambiguous");
  assert.deepEqual(await store.settle({tenantId,deliveryId:"delivery:ambiguous",claimId:"claim:ambiguous",now:"2026-08-28T18:01:02.000Z",outcome:"ambiguous"}),ambiguous);
  await assert.rejects(store.settle({tenantId,deliveryId:"delivery:ambiguous",claimId:"claim:ambiguous",now:"2026-08-28T18:01:02.000Z",outcome:"ambiguous",safeReasonCode:"changed"}),isCode("claim_mismatch"));
  await store.enqueue({deliveryId:"delivery:crash",idempotencyKey:"send:crash",presentation:presentation(),now:t0});await store.claimNext({tenantId,claimId:"claim:crash",now:t0,leaseSeconds:5});
  assert.equal(await store.recoverExpiredClaims(tenantId,"2026-08-28T18:01:06.000Z"),1);assert.equal((await store.getDelivery(tenantId,"delivery:crash"))?.safeReasonCode,"claim_expired_outcome_unknown");
  assert.equal(await store.claimNext({tenantId,claimId:"claim:new",now:"2026-08-28T18:01:07.000Z",leaseSeconds:5}),undefined);
}finally{await raw.close();}});

test("CR8D quiet-hour deliveries require a future release time and cannot claim early",async()=>{const{raw,store}=await setup();try{
  const deferred=presentation({...cr8dTelegramPresentationFixture[2],presentationId:"tgpresentation:deferred-store"});
  await assert.rejects(store.enqueue({deliveryId:"delivery:quiet-bad",idempotencyKey:"send:quiet-bad",presentation:deferred,now:t0}),isCode("invalid_record"));
  await store.enqueue({deliveryId:"delivery:quiet",idempotencyKey:"send:quiet",presentation:deferred,now:t0,notBefore:"2026-08-28T18:05:00.000Z"});
  assert.equal(await store.claimNext({tenantId,claimId:"claim:early",now:"2026-08-28T18:04:59.000Z",leaseSeconds:5}),undefined);
  assert.equal((await store.claimNext({tenantId,claimId:"claim:on-time",now:"2026-08-28T18:05:00.000Z",leaseSeconds:5}))?.state,"sending");
}finally{await raw.close();}});

test("CR8D concurrent claims select one delivery once",async()=>{const{raw,store}=await setup();try{
  await store.enqueue({deliveryId:"delivery:concurrent",idempotencyKey:"send:concurrent",presentation:presentation(),now:t0});const claims=await Promise.all([
    store.claimNext({tenantId,claimId:"claim:concurrent:a",now:t0,leaseSeconds:5}),store.claimNext({tenantId,claimId:"claim:concurrent:b",now:t0,leaseSeconds:5})]);
  assert.equal(claims.filter(Boolean).length,1);assert.equal(claims.find(Boolean)?.attemptCount,1);
}finally{await raw.close();}});

test("CR8D dispatch rechecks an append-only recipient policy replacement",async()=>{const{raw,store}=await setup();try{
  await store.enqueue({deliveryId:"delivery:revoked",idempotencyKey:"send:revoked",presentation:presentation(),now:t0});
  const original=policy();const disabled=policy({enabled:false,verifiedAt:"2026-08-28T18:01:30.000Z"});
  await store.replaceRecipientPolicy({expectedPolicyDigest:sha256Digest(original),policy:disabled});
  await assert.rejects(store.replaceRecipientPolicy({expectedPolicyDigest:sha256Digest(original),policy:policy({maximumRisk:"medium",verifiedAt:"2026-08-28T18:02:00.000Z"})}),isCode("record_conflict"));
  assert.equal(await store.claimNext({tenantId,claimId:"claim:revoked",now:"2026-08-28T18:02:00.000Z",leaseSeconds:5}),undefined);
  const delivery=await store.getDelivery(tenantId,"delivery:revoked");assert.equal(delivery?.state,"dead_letter");assert.equal(delivery?.safeReasonCode,"recipient_policy_not_current");
  const events=await store.listRecipientPolicyHistory(tenantId,recipientId);assert.deepEqual(events.map((event)=>event.policyDigest),[sha256Digest(original),sha256Digest(disabled)]);assert.equal(events[1].priorPolicyDigest,sha256Digest(original));
}finally{await raw.close();}});

test("CR8D authenticated mutable delivery state detects direct database tampering",async()=>{const{raw,store}=await setup();try{
  await store.enqueue({deliveryId:"delivery:tamper",idempotencyKey:"send:tamper",presentation:presentation(),now:t0});await raw.query(`UPDATE control_telegram_deliveries SET state='ambiguous',safe_reason_code='forged' WHERE tenant_id=$1 AND delivery_id='delivery:tamper'`,[tenantId]);
  await assert.rejects(store.getDelivery(tenantId,"delivery:tamper"),isCode("integrity_failed"));
}finally{await raw.close();}});

test("CR8D authenticated append-only observations and policy history detect direct tampering",async()=>{const{raw,store}=await setup();try{
  const item=callback(),token=issueTelegramCallbackTokenV1(item,callbackKey);await store.registerCallback(registration(item));await store.consumeCallback({tenantId,recipientId,observation:observation(token),now:t0});
  await raw.query(`ALTER TABLE control_telegram_updates DISABLE TRIGGER control_telegram_updates_append_only`);
  await raw.query(`UPDATE control_telegram_updates SET observation=jsonb_set(observation,'{bodyDigest}',to_jsonb($1::text)) WHERE tenant_id=$2 AND update_id=501`,[digest("forged-body"),tenantId]);
  await assert.rejects(store.consumeCallback({tenantId,recipientId,observation:observation(token),now:t0}),isCode("integrity_failed"));
  await raw.query(`ALTER TABLE control_telegram_recipient_policy_events DISABLE TRIGGER control_telegram_recipient_policy_events_append_only`);
  await raw.query(`UPDATE control_telegram_recipient_policy_events SET prior_policy_digest=$1 WHERE tenant_id=$2 AND recipient_id=$3`,[digest("forged-prior"),tenantId,recipientId]);
  await assert.rejects(store.listRecipientPolicyHistory(tenantId,recipientId),isCode("integrity_failed"));
}finally{await raw.close();}});

test("CR8D wrong integrity key and idempotency drift fail closed",async()=>{const{raw,store,checkpoints}=await setup();try{
  await store.enqueue({deliveryId:"delivery:drift",idempotencyKey:"send:drift",presentation:presentation(),now:t0});
  await assert.rejects(store.enqueue({deliveryId:"delivery:other",idempotencyKey:"send:drift",presentation:presentation(),now:t0}),isCode("record_conflict"));
  const wrong=new TelegramDurableStoreV1(adaptPglite(raw),randomBytes(32),callbackKey,checkpoints);await assert.rejects(wrong.getDelivery(tenantId,"delivery:drift"),isCode("integrity_failed"));
}finally{await raw.close();}});

test("CR8D ingress service verifies the webhook secret before durable callback mutation",async()=>{const{raw,store}=await setup();try{
  const secret="synthetic-webhook-secret-012345678901",item=callback(),token=issueTelegramCallbackTokenV1(item,callbackKey);await store.registerCallback(registration(item));
  const ingress=new TelegramIngressServiceV1(store,telegramSecretDigestForConfigurationV1(secret),()=>t0);
  await assert.rejects(ingress.handleCallback({presentedWebhookSecret:`${secret}x`,tenantId,recipientId,observation:observation(token)}),isCode("callback_invalid"));
  assert.equal((await raw.query(`SELECT * FROM control_telegram_updates`)).rows.length,0);
  assert.equal((await ingress.handleCallback({presentedWebhookSecret:secret,tenantId,recipientId,observation:observation(token)})).status,"recorded");
  const expiredIngress=new TelegramIngressServiceV1(store,telegramSecretDigestForConfigurationV1(secret),()=>item.expiresAt);
  await assert.rejects(expiredIngress.handleCallback({presentedWebhookSecret:secret,tenantId,recipientId,observation:observation(token)}),isCode("callback_invalid"));
}finally{await raw.close();}});

test("CR8D tenant state authentication detects privileged callback and delivery deletion",async()=>{for(const target of ["callback","delivery"] as const){const{raw,store}=await setup();try{
    if(target==="callback"){const item=callback();await store.registerCallback(registration(item));await raw.exec(`ALTER TABLE control_telegram_callbacks DISABLE TRIGGER control_telegram_callbacks_append_only`);await raw.query(`DELETE FROM control_telegram_callbacks WHERE tenant_id=$1 AND callback_id=$2`,[tenantId,item.callbackId]);await raw.exec(`ALTER TABLE control_telegram_callbacks ENABLE TRIGGER control_telegram_callbacks_append_only`);}
    else {await store.enqueue({deliveryId:"delivery:deleted",idempotencyKey:"send:deleted",presentation:presentation(),now:t0});await raw.query(`DELETE FROM control_telegram_deliveries WHERE tenant_id=$1 AND delivery_id='delivery:deleted'`,[tenantId]);}
    await assert.rejects(store.listRecipientPolicyHistory(tenantId,recipientId),isCode("integrity_failed"));
  }finally{await raw.close();}}});

test("CR8D synthetic delivery coordinator records success and treats thrown outcomes as ambiguous",async()=>{const{raw,store}=await setup();try{
  let tick=0;const times=[t0,"2026-08-28T18:01:01.000Z","2026-08-28T18:01:02.000Z","2026-08-28T18:01:03.000Z"];
  const coordinator=new TelegramSyntheticDeliveryCoordinatorV1(store,()=>times[Math.min(tick++,times.length-1)]);
  await store.enqueue({deliveryId:"delivery:coordinator",idempotencyKey:"send:coordinator",presentation:presentation(),now:t0});
  const success=await coordinator.drainOne(tenantId,{async send(value){assert.equal(value.grantsExecutionAuthority,false);return{outcome:"delivered",providerReceiptDigest:digest("synthetic-provider")};}});assert.equal(success?.state,"delivered");
  await store.enqueue({deliveryId:"delivery:throw",idempotencyKey:"send:throw",presentation:presentation({...presentation(),presentationId:"tgpresentation:throw"}),now:t0});
  const ambiguous=await coordinator.drainOne(tenantId,{async send(){throw new Error("synthetic disconnect");}});assert.equal(ambiguous?.state,"ambiguous");
  assert.equal((await store.getDelivery(tenantId,"delivery:throw"))?.safeReasonCode,"synthetic_transport_threw_outcome_unknown");
}finally{await raw.close();}});

test("CR8Q callback registration enforces the current recipient class, risk, and verification time",async()=>{
  for(const restricted of [policy({allowedMessageClasses:["informational"]}),policy({maximumRisk:"low"}),policy({verifiedAt:"2026-08-28T18:05:00.000Z"})]){const{raw,store}=await setup(restricted);try{
    await assert.rejects(store.registerCallback(registration()),isCode("recipient_not_allowed"));
  }finally{await raw.close();}}
});

test("CR8Q callback consumption rechecks current project, class, risk, and verification time",async()=>{
  const replacements=[policy({allowedProjectIds:["project:other"],verifiedAt:t0}),policy({allowedMessageClasses:["informational"],verifiedAt:t0}),policy({maximumRisk:"low",verifiedAt:t0}),policy({verifiedAt:"2026-08-28T18:05:00.000Z"})];
  for(const replacement of replacements){const{raw,store}=await setup();try{const item=callback(),token=issueTelegramCallbackTokenV1(item,callbackKey);await store.registerCallback(registration(item));
    await store.replaceRecipientPolicy({expectedPolicyDigest:sha256Digest(policy()),policy:replacement});
    await assert.rejects(store.consumeCallback({tenantId,recipientId,observation:observation(token),now:t0}),isCode("recipient_not_allowed"));
    assert.equal((await raw.query(`SELECT * FROM control_telegram_updates`)).rows.length,0);
  }finally{await raw.close();}}
});

test("CR8Q future-dated recipient policy cannot enqueue or reach sending",async()=>{
  const future=policy({verifiedAt:"2026-08-28T18:05:00.000Z"}),first=await setup(future);try{
    await assert.rejects(first.store.enqueue({deliveryId:"delivery:future-enqueue",idempotencyKey:"send:future-enqueue",presentation:presentation(),now:t0}),isCode("recipient_not_allowed"));
  }finally{await first.raw.close();}
  const second=await setup();try{await second.store.enqueue({deliveryId:"delivery:future-claim",idempotencyKey:"send:future-claim",presentation:presentation(),now:t0});
    await second.store.replaceRecipientPolicy({expectedPolicyDigest:sha256Digest(policy()),policy:future});assert.equal(await second.store.claimNext({tenantId,claimId:"claim:future",now:t0,leaseSeconds:5}),undefined);
    const delivery=await second.store.getDelivery(tenantId,"delivery:future-claim");assert.equal(delivery?.state,"dead_letter");assert.equal(delivery?.safeReasonCode,"recipient_policy_not_current");
  }finally{await second.raw.close();}
});

test("CR8Q external checkpoint rejects complete Telegram erasure",async()=>{const{raw,store}=await setup();try{
  await raw.exec(`ALTER TABLE control_telegram_recipient_policy_events DISABLE TRIGGER control_telegram_recipient_policy_events_append_only`);
  await raw.exec(`ALTER TABLE control_telegram_recipients DISABLE TRIGGER control_telegram_recipients_delete_guard`);
  await raw.query(`DELETE FROM control_telegram_recipient_policy_events WHERE tenant_id=$1`,[tenantId]);await raw.query(`DELETE FROM control_telegram_recipients WHERE tenant_id=$1`,[tenantId]);await raw.query(`DELETE FROM control_telegram_integrity WHERE tenant_id=$1`,[tenantId]);
  await raw.exec(`ALTER TABLE control_telegram_recipient_policy_events ENABLE TRIGGER control_telegram_recipient_policy_events_append_only`);await raw.exec(`ALTER TABLE control_telegram_recipients ENABLE TRIGGER control_telegram_recipients_delete_guard`);
  await assert.rejects(store.registerRecipient(policy()),isCode("integrity_failed"));await assert.rejects(store.provisionTenant(tenantId),isCode("integrity_failed"));
}finally{await raw.close();}});

test("CR8Q external checkpoint rejects an older valid Telegram snapshot",async()=>{const{raw,store}=await setup();try{
  const priorRecipient=(await raw.query<{chat_id_digest:string;policy_digest:string;policy_auth_tag:string;policy:unknown;verified_at:string|Date;expires_at:string|Date}>(`SELECT chat_id_digest,policy_digest,policy_auth_tag,policy,verified_at,expires_at FROM control_telegram_recipients WHERE tenant_id=$1 AND recipient_id=$2`,[tenantId,recipientId])).rows[0];
  const priorHead=(await raw.query<{revision:number;record_count:number;state_digest:string;state_auth_tag:string}>(`SELECT revision,record_count,state_digest,state_auth_tag FROM control_telegram_integrity WHERE tenant_id=$1`,[tenantId])).rows[0];
  const replacement=policy({maximumRisk:"medium",verifiedAt:t0});await store.replaceRecipientPolicy({expectedPolicyDigest:sha256Digest(policy()),policy:replacement});
  await raw.exec(`ALTER TABLE control_telegram_recipient_policy_events DISABLE TRIGGER control_telegram_recipient_policy_events_append_only`);await raw.query(`DELETE FROM control_telegram_recipient_policy_events WHERE tenant_id=$1 AND policy_digest=$2`,[tenantId,sha256Digest(replacement)]);await raw.exec(`ALTER TABLE control_telegram_recipient_policy_events ENABLE TRIGGER control_telegram_recipient_policy_events_append_only`);
  await raw.query(`UPDATE control_telegram_recipients SET chat_id_digest=$3,policy_digest=$4,policy_auth_tag=$5,policy=$6::jsonb,verified_at=$7,expires_at=$8 WHERE tenant_id=$1 AND recipient_id=$2`,[tenantId,recipientId,priorRecipient.chat_id_digest,priorRecipient.policy_digest,priorRecipient.policy_auth_tag,JSON.stringify(priorRecipient.policy),priorRecipient.verified_at,priorRecipient.expires_at]);
  await raw.query(`UPDATE control_telegram_integrity SET revision=$2,record_count=$3,state_digest=$4,state_auth_tag=$5 WHERE tenant_id=$1`,[tenantId,Number(priorHead.revision),Number(priorHead.record_count),priorHead.state_digest,priorHead.state_auth_tag]);
  await assert.rejects(store.listRecipientPolicyHistory(tenantId,recipientId),isCode("integrity_failed"));
}finally{await raw.close();}});

test("CR8Q Telegram store captures its trusted checkpoint functions",async()=>{const{raw,store,checkpoints}=await setup();try{
  checkpoints.read=()=>undefined;checkpoints.initialize=()=>{throw new Error("mutated initialize");};checkpoints.advance=()=>{throw new Error("mutated advance");};
  assert.equal((await store.registerCallback(registration())).replayed,false);
}finally{await raw.close();}});
