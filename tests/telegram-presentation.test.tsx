import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { sha256Digest } from "../src/security/digest";
import { groupTelegramMessagePlansV1, renderTelegramPresentationV1, TELEGRAM_CONTRACT_VERSION_V1,
  type TelegramMessagePlanV1, type TelegramPresentationPreferencesV1 } from "../src/telegram/v1";
import { TelegramMessagePreview } from "../app/components/telegram-message-preview";
import { cr8dPresentationPreferencesFixture, cr8dTelegramPresentationFixture } from "../app/fixtures/cr8d-ui";

const digest=(label:string)=>sha256Digest({label});
const createdAt="2026-08-28T18:01:00.000Z";
function preferences(overrides:Partial<TelegramPresentationPreferencesV1>={}):TelegramPresentationPreferencesV1 { return {...cr8dPresentationPreferencesFixture,...overrides}; }
function plan(overrides:Partial<TelegramMessagePlanV1>={}):TelegramMessagePlanV1 {
  const attentionId=overrides.attentionId??"attention:test"; const attentionDigest=overrides.attentionDigest??digest("attention");
  return {schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,messagePlanId:"tgplan:test",recipientId:"recipient:owner",tenantId:"tenant:control-room",
    projectId:"project.wayfarer.lazy-river",attentionId,attentionDigest,messageClass:"question",risk:"low",urgency:"routine",delivery:"deliver_now",
    groupingKey:"tggrp:test",safeTitle:"A bounded question",safeSummary:"Choose a reviewed option.",evidenceDigests:[digest("evidence")],
    responseKinds:["acknowledge","decline"],responseOptions:[],deepLink:{schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,attentionId,attentionDigest,
      path:`/attention/${attentionId}`,requiresAuthenticatedDashboard:true,requiresStrongFactorForConsequentialApproval:true,grantsApproval:false,grantsExecutionAuthority:false},
    createdAt:"2026-08-28T18:00:00.000Z",expiresAt:"2026-08-28T18:15:00.000Z",grantsApproval:false,grantsExecutionAuthority:false,...overrides};
}

test("CR8D renderer produces plain-text negative-authority presentations",()=>{
  const output=renderTelegramPresentationV1({plans:[plan()],preferences:preferences(),createdAt});
  assert.equal(output.parseMode,"none"); assert.match(output.plainText,/Telegram can record a response proposal only/);
  assert.equal(output.grantsApproval,false); assert.equal(output.grantsExecutionAuthority,false);
  assert.deepEqual(output.buttons.map((button)=>button.kind),["callback_intent","callback_intent","dashboard_link"]);
  assert.ok(output.buttons.every((button)=>button.grantsApproval===false&&button.grantsExecutionAuthority===false));
  assert.doesNotMatch(JSON.stringify(output),/callbackToken|callback_data|webhook|Bearer|secret/i);
});

test("CR8D answer choices bind fixed labels to opaque option digests",()=>{
  const options=[{valueDigest:digest("a"),label:"Option A"},{valueDigest:digest("b"),label:"Option B"}].sort((a,b)=>a.valueDigest.localeCompare(b.valueDigest));
  const output=renderTelegramPresentationV1({plans:[plan({responseKinds:["answer_choice"],responseOptions:options})],preferences:preferences(),createdAt});
  const intents=output.buttons.filter((button)=>button.kind==="callback_intent");
  assert.deepEqual(intents.map((intent)=>intent.label),options.map((option)=>option.label));
  assert.deepEqual(intents.map((intent)=>intent.responseValueDigest),options.map((option)=>option.valueDigest));
});

test("CR8D high and critical presentations are protected-dashboard only",()=>{
  for(const risk of ["high","critical"] as const){
    const output=renderTelegramPresentationV1({plans:[plan({risk,responseKinds:[],responseOptions:[],messageClass:"approval_request"})],preferences:preferences(),createdAt});
    assert.deepEqual(output.buttons.map((button)=>button.kind),["dashboard_link"]);
    assert.match(output.buttons[0].label,/protected approval/i);
  }
});

test("CR8D preferences change verbosity and evidence display without changing authority",()=>{
  const compact=renderTelegramPresentationV1({plans:[plan()],preferences:preferences({verbosity:"compact",includeProjectId:false,evidenceDisplay:"none",buttonStyle:"compact"}),createdAt});
  assert.doesNotMatch(compact.plainText,/Project:|Evidence:|Expires:/); assert.equal(compact.buttons[0].label,"Acknowledge");
  const standard=renderTelegramPresentationV1({plans:[plan()],preferences:preferences({evidenceDisplay:"digests"}),createdAt});
  assert.match(standard.plainText,/Project: project\.wayfarer/); assert.match(standard.plainText,/sha256:/); assert.match(standard.plainText,/Expires:/);
});

test("CR8D grouping is deterministic, bounded, compatible, and windowed",()=>{
  const plans=[plan({messagePlanId:"tgplan:b",createdAt:"2026-08-28T18:00:20.000Z"}),plan({messagePlanId:"tgplan:a"}),
    plan({messagePlanId:"tgplan:c",createdAt:"2026-08-28T18:02:00.000Z"})];
  const groups=groupTelegramMessagePlansV1({plans,preferences:preferences({maximumGroupedItems:2}),groupingWindowSeconds:60,now:createdAt});
  assert.deepEqual(groups.map((group)=>group.map((item)=>item.messagePlanId)),[["tgplan:a","tgplan:b"],["tgplan:c"]]);
  const grouped=renderTelegramPresentationV1({plans:groups[0],preferences:preferences({maximumGroupedItems:2}),createdAt});
  assert.equal(grouped.sourceMessagePlanIds.length,2); assert.ok(grouped.buttons.every((button)=>button.kind==="dashboard_link"));
});

test("CR8D grouping separates projects, recipients, delivery modes, and grouping keys",()=>{
  const variants=[plan({messagePlanId:"tgplan:base"}),plan({messagePlanId:"tgplan:project",projectId:"project.other"}),
    plan({messagePlanId:"tgplan:delivery",delivery:"defer_quiet_hours"}),plan({messagePlanId:"tgplan:key",groupingKey:"tggrp:other"})];
  const groups=groupTelegramMessagePlansV1({plans:variants,preferences:preferences(),groupingWindowSeconds:60,now:createdAt});
  assert.equal(groups.length,4);
  assert.throws(()=>groupTelegramMessagePlansV1({plans:[plan({recipientId:"recipient:other"})],preferences:preferences(),groupingWindowSeconds:60,now:createdAt}),/scope mismatch/);
});

test("CR8D renderer rejects expired preferences, expired plans, secret text, and incompatible direct groups",()=>{
  assert.throws(()=>renderTelegramPresentationV1({plans:[plan()],preferences:preferences({expiresAt:createdAt}),createdAt}),/not current/);
  assert.throws(()=>renderTelegramPresentationV1({plans:[plan({expiresAt:createdAt})],preferences:preferences(),createdAt}),/expired/);
  assert.throws(()=>renderTelegramPresentationV1({plans:[plan({safeSummary:"api_key=unsafe-example-value"})],preferences:preferences(),createdAt}),/secret material/);
  assert.throws(()=>renderTelegramPresentationV1({plans:[plan(),plan({messagePlanId:"tgplan:other",projectId:"project.other"})],preferences:preferences(),createdAt}),/not group-compatible/);
});

test("CR8D UI fixture covers question, high risk, quiet-hour deferral, and grouping without controls",()=>{
  const html=renderToStaticMarkup(<TelegramMessagePreview presentations={cr8dTelegramPresentationFixture}/>);
  assert.match(html,/Synthetic preview only/); assert.match(html,/Choose the next review route/); assert.match(html,/High risk/);
  assert.match(html,/Delivery is deferred by quiet hours/); assert.match(html,/2 grouped items/); assert.match(html,/Response proposal intent · unsigned/);
  assert.match(html,/Protected dashboard intent · sign-in required/); assert.doesNotMatch(html,/<button|<a\s/i);
  assert.doesNotMatch(html,/callbackToken|callback_data|Bearer|private key|credential:/i);
});

test("CR8D UI escapes hostile text and exposes a scoped empty state",()=>{
  const hostile={...cr8dTelegramPresentationFixture[0],plainText:"<script>unsafe()</script>"};
  const html=renderToStaticMarkup(<TelegramMessagePreview presentations={[hostile]}/>);
  assert.match(html,/&lt;script&gt;unsafe\(\)&lt;\/script&gt;/); assert.doesNotMatch(html,/<script>/);
  assert.match(renderToStaticMarkup(<TelegramMessagePreview presentations={[]}/>),/No Telegram presentations are visible/);
});
