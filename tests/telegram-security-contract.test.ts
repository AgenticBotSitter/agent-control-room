import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { sha256Digest } from "../src/security/digest";
import {
  InMemoryTelegramCallbackStoreV1, TELEGRAM_CONTRACT_VERSION_V1, buildTelegramMessagePlanV1,
  consumeTelegramCallbackV1, issueTelegramCallbackTokenV1, telegramDeepLinkSchemaV1,
  telegramRecipientPolicySchemaV1, telegramSecretDigestForConfigurationV1, verifyTelegramWebhookSecretV1,
  type TelegramAttentionBindingV1, type TelegramCallbackRecordV1, type TelegramRecipientPolicyV1,
  type TelegramWebhookObservationV1,
} from "../src/telegram/v1";

const digest=(label:string)=>sha256Digest({label});
const now="2026-08-28T18:00:00.000Z";

function policy(overrides:Partial<TelegramRecipientPolicyV1>={}):TelegramRecipientPolicyV1 {
  return {schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,recipientId:"recipient:owner",tenantId:"tenant:one",chatIdDigest:digest("chat"),enabled:true,
    verifiedAt:"2026-08-28T00:00:00.000Z",allowedProjectIds:["project:alpha"],allowedMessageClasses:["approval_request","incident","question","review"],
    maximumRisk:"critical",quietHours:null,criticalMayBypassQuietHours:false,groupingWindowSeconds:120,policyExpiresAt:"2026-09-01T00:00:00.000Z",...overrides};
}

function attention(overrides:Partial<TelegramAttentionBindingV1>={}):TelegramAttentionBindingV1 {
  return {schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,attentionId:"attention:one",attentionDigest:digest("attention"),tenantId:"tenant:one",
    projectId:"project:alpha",messageClass:"question",deterministicRisk:"low",assessedRisk:"low",effectiveRisk:"low",urgency:"routine",
    safeTitle:"A decision is ready",safeSummary:"Choose a safe next step in Control Room.",evidenceDigests:[digest("evidence")],
    allowedResponseKinds:["acknowledge","decline","request_review"],responseOptions:[],createdAt:"2026-08-28T17:00:00.000Z",expiresAt:"2026-08-28T20:00:00.000Z",
    grantsApproval:false,grantsExecutionAuthority:false,...overrides};
}

function callbackRecord(overrides:Partial<TelegramCallbackRecordV1>={}):TelegramCallbackRecordV1 {
  return {schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,callbackId:"cb_0123456789abcdef",tenantId:"tenant:one",projectId:"project:alpha",
    recipientId:"recipient:owner",chatIdDigest:digest("chat"),attentionId:"attention:one",attentionDigest:digest("attention"),messageClass:"question",risk:"low",
    responseKind:"request_review",messagePlanDigest:digest("plan"),issuedAt:"2026-08-28T17:55:00.000Z",expiresAt:"2026-08-28T18:05:00.000Z",
    grantsApproval:false,grantsExecutionAuthority:false,...overrides};
}

function observation(callbackToken:string,overrides:Partial<TelegramWebhookObservationV1>={}):TelegramWebhookObservationV1 {
  return {schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,updateId:42,bodyDigest:digest("body"),chatIdDigest:digest("chat"),
    callbackQueryIdDigest:digest("query"),callbackToken,observedAt:now,...overrides};
}

test("recipient policy is strict, scoped, verified, and expiring",()=>{
  assert.equal(telegramRecipientPolicySchemaV1.parse(policy()).recipientId,"recipient:owner");
  assert.throws(()=>telegramRecipientPolicySchemaV1.parse({...policy(),rawChatId:"12345"}));
  assert.throws(()=>telegramRecipientPolicySchemaV1.parse(policy({policyExpiresAt:"2026-08-27T00:00:00.000Z"})),/expire/);
  assert.throws(()=>buildTelegramMessagePlanV1({policy:policy({enabled:false}),attention:attention(),now}),/disabled/);
  assert.throws(()=>buildTelegramMessagePlanV1({policy:policy(),attention:attention({tenantId:"tenant:other"}),now}),/tenant/);
  assert.throws(()=>buildTelegramMessagePlanV1({policy:policy(),attention:attention({projectId:"project:other"}),now}),/Project|project/);
});

test("deterministic risk is a floor and recipient risk is a ceiling",()=>{
  assert.throws(()=>buildTelegramMessagePlanV1({policy:policy(),attention:attention({deterministicRisk:"high",assessedRisk:"low",effectiveRisk:"low"}),now}),/risk below/);
  assert.throws(()=>buildTelegramMessagePlanV1({policy:policy({maximumRisk:"medium"}),attention:attention({deterministicRisk:"high",assessedRisk:"high",effectiveRisk:"high"}),now}),/ceiling/);
});

test("high and critical risk are authenticated-dashboard deep-link only",()=>{
  for(const risk of ["high","critical"] as const){
    const plan=buildTelegramMessagePlanV1({policy:policy(),attention:attention({messageClass:"approval_request",deterministicRisk:risk,assessedRisk:risk,effectiveRisk:risk}),now});
    assert.deepEqual(plan.responseKinds,[]);
    assert.equal(plan.deepLink.path,"/attention/attention:one");
    assert.equal(plan.deepLink.requiresAuthenticatedDashboard,true);
    assert.equal(plan.deepLink.requiresStrongFactorForConsequentialApproval,true);
    assert.equal(plan.grantsApproval,false); assert.equal(plan.grantsExecutionAuthority,false);
  }
});

test("deep links reject external, traversal, query, fragment, and bearer-token forms",()=>{
  const base={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,attentionId:"attention:one",attentionDigest:digest("attention"),
    requiresAuthenticatedDashboard:true,requiresStrongFactorForConsequentialApproval:true,grantsApproval:false,grantsExecutionAuthority:false};
  for(const path of ["https://evil.invalid/x","//evil.invalid/x","/attention/../admin","/attention/one?token=abc","/attention/one#approve","/attention/%2e%2e"])
    assert.throws(()=>telegramDeepLinkSchemaV1.parse({...base,path}),/deep link/);
});

test("quiet hours defer ordinary messages and only explicit critical bypass applies",()=>{
  const quiet={timeZone:"UTC",startMinute:17*60,endMinute:19*60};
  assert.equal(buildTelegramMessagePlanV1({policy:policy({quietHours:quiet}),attention:attention(),now}).delivery,"defer_quiet_hours");
  assert.equal(buildTelegramMessagePlanV1({policy:policy({quietHours:quiet,criticalMayBypassQuietHours:false}),attention:attention({urgency:"critical"}),now}).delivery,"defer_quiet_hours");
  assert.equal(buildTelegramMessagePlanV1({policy:policy({quietHours:quiet,criticalMayBypassQuietHours:true}),attention:attention({urgency:"critical"}),now}).delivery,"deliver_now");
});

test("presentation rejects secret-shaped text before a message plan exists",()=>{
  assert.throws(()=>buildTelegramMessagePlanV1({policy:policy(),attention:attention({safeSummary:"api_key=super-secret-value"}),now}),/secret material/);
});

test("webhook shared secret verification is constant-shape and returns no secret",()=>{
  const secret="owner-generated-webhook-value-0123456789";
  const expectedSecretDigest=telegramSecretDigestForConfigurationV1(secret);
  assert.equal(verifyTelegramWebhookSecretV1({presentedSecret:secret,expectedSecretDigest}),undefined);
  assert.throws(()=>verifyTelegramWebhookSecretV1({presentedSecret:`${secret}x`,expectedSecretDigest}),/authentication failed/);
  assert.throws(()=>verifyTelegramWebhookSecretV1({presentedSecret:"short",expectedSecretDigest}),/authentication failed/);
});

test("signed callback is compact, recipient-bound, expiring, and proposal-only",()=>{
  const key=randomBytes(32); const record=callbackRecord(); const token=issueTelegramCallbackTokenV1(record,key);
  assert.ok(Buffer.byteLength(token)<=64);
  const store=new InMemoryTelegramCallbackStoreV1([record]);
  const receipt=consumeTelegramCallbackV1({observation:observation(token),expectedChatIdDigest:digest("chat"),now,key,store});
  assert.equal(receipt.status,"recorded");
  assert.equal(receipt.proposal.responseKind,"request_review");
  assert.equal(receipt.proposal.grantsApproval,false); assert.equal(receipt.proposal.grantsExecutionAuthority,false);
  assert.equal(receipt.proposal.requiresIndependentPolicyEvaluation,true);
});

test("choice callbacks bind an opaque option digest and never raw answer text",()=>{
  const key=randomBytes(32); const record=callbackRecord({responseKind:"answer_choice",responseValueDigest:digest("option-a")});
  const token=issueTelegramCallbackTokenV1(record,key); const receipt=consumeTelegramCallbackV1({observation:observation(token),
    expectedChatIdDigest:digest("chat"),now,key,store:new InMemoryTelegramCallbackStoreV1([record])});
  assert.equal(receipt.proposal.responseValueDigest,digest("option-a"));
  assert.throws(()=>issueTelegramCallbackTokenV1({...record,responseValueDigest:undefined},key),/requires one bound value/);
  assert.throws(()=>issueTelegramCallbackTokenV1({...callbackRecord(),responseValueDigest:digest("unexpected")},key),/requires one bound value/);
});

test("callback rejects tampering, wrong recipient, future issue, and expiry",()=>{
  const key=randomBytes(32); const record=callbackRecord(); const token=issueTelegramCallbackTokenV1(record,key);
  const makeStore=()=>new InMemoryTelegramCallbackStoreV1([record]);
  const tampered=`${token.slice(0,-1)}${token.endsWith("A")?"B":"A"}`;
  assert.throws(()=>consumeTelegramCallbackV1({observation:observation(tampered),expectedChatIdDigest:digest("chat"),now,key,store:makeStore()}),/invalid|authentication/);
  assert.throws(()=>consumeTelegramCallbackV1({observation:observation(token,{chatIdDigest:digest("other")}),expectedChatIdDigest:digest("chat"),now,key,store:makeStore()}),/chat binding/);
  assert.throws(()=>consumeTelegramCallbackV1({observation:observation(token),expectedChatIdDigest:digest("chat"),now:"2026-08-28T17:54:00.000Z",key,store:makeStore()}),/not yet valid/);
  assert.throws(()=>consumeTelegramCallbackV1({observation:observation(token),expectedChatIdDigest:digest("chat"),now:"2026-08-28T18:05:00.000Z",key,store:makeStore()}),/expired/);
  assert.throws(()=>issueTelegramCallbackTokenV1(callbackRecord({expiresAt:"2026-08-28T18:11:00.000Z"}),key),/at most 15 minutes/);
});

test("callback IDs use one unambiguous token grammar end to end",()=>{
  const key=randomBytes(32);for(const callbackId of ["abc","Callback_123","callback-id"]){const record=callbackRecord({callbackId}),token=issueTelegramCallbackTokenV1(record,key),store=new InMemoryTelegramCallbackStoreV1([record]);
    assert.equal(consumeTelegramCallbackV1({observation:observation(token),expectedChatIdDigest:digest("chat"),now,key,store}).proposal.callbackId,callbackId);}
  for(const callbackId of ["callback.one","callback:one","-callback","ab"])assert.throws(()=>issueTelegramCallbackTokenV1(callbackRecord({callbackId}),key));
});

test("exact retry replays one receipt while drift and callback reuse fail closed",()=>{
  const key=randomBytes(32); const record=callbackRecord(); const token=issueTelegramCallbackTokenV1(record,key); const store=new InMemoryTelegramCallbackStoreV1([record]);
  const first=consumeTelegramCallbackV1({observation:observation(token),expectedChatIdDigest:digest("chat"),now,key,store});
  const retry=consumeTelegramCallbackV1({observation:observation(token),expectedChatIdDigest:digest("chat"),now,key,store});
  assert.equal(first.status,"recorded"); assert.equal(retry.status,"replayed"); assert.deepEqual(retry.proposal,first.proposal);
  assert.throws(()=>consumeTelegramCallbackV1({observation:observation(token,{bodyDigest:digest("drift")}),expectedChatIdDigest:digest("chat"),now,key,store}),/replay conflict/);
  assert.throws(()=>consumeTelegramCallbackV1({observation:observation(token,{updateId:43,callbackQueryIdDigest:digest("other-query")}),expectedChatIdDigest:digest("chat"),now,key,store}),/different update/);
});

test("token authenticates the full server-side record, including authority-negative fields",()=>{
  const key=randomBytes(32); const original=callbackRecord(); const token=issueTelegramCallbackTokenV1(original,key);
  const changed=callbackRecord({responseKind:"decline"});
  assert.throws(()=>consumeTelegramCallbackV1({observation:observation(token),expectedChatIdDigest:digest("chat"),now,key,
    store:new InMemoryTelegramCallbackStoreV1([changed])}),/authentication/);
  assert.throws(()=>issueTelegramCallbackTokenV1({...original,grantsApproval:true},key));
});
