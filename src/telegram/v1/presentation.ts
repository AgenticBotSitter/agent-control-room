import { assertNoSecretMaterial } from "../../security/redaction";
import { telegramMessagePlanSchemaV1, telegramPresentationPreferencesSchemaV1, telegramPresentationSchemaV1 } from "./schemas";
import { TELEGRAM_CONTRACT_VERSION_V1, type TelegramCallbackIntentV1, type TelegramDashboardLinkIntentV1, type TelegramMessagePlanV1,
  type TelegramPresentationPreferencesV1, type TelegramPresentationV1, type TelegramResponseKindV1, type TelegramRiskV1, type TelegramUrgencyV1 } from "./types";

const riskRank:Record<TelegramRiskV1,number>={low:0,medium:1,high:2,critical:3};
const urgencyRank:Record<TelegramUrgencyV1,number>={routine:0,urgent:1,critical:2};
const responseLabels:Record<TelegramResponseKindV1,{compact:string;descriptive:string}>={
  acknowledge:{compact:"Acknowledge",descriptive:"Acknowledge only"},
  answer_choice:{compact:"Choose",descriptive:"Record this choice"},
  request_review:{compact:"Review",descriptive:"Request another review"},
  request_retry:{compact:"Retry",descriptive:"Request a retry"},
  decline:{compact:"Decline",descriptive:"Decline this proposal"},
};

function maximum<T extends string>(values:T[],rank:Record<T,number>):T {
  return values.reduce((highest,value)=>rank[value]>rank[highest]?value:highest);
}
function truncate(value:string,maximumLength:number):string { return value.length<=maximumLength?value:`${value.slice(0,maximumLength-1)}…`; }
function titleCase(value:string):string { return value.replaceAll("_"," ").replace(/\b\w/g,(letter)=>letter.toUpperCase()); }

function renderEvidence(plan:TelegramMessagePlanV1,preference:TelegramPresentationPreferencesV1):string|undefined {
  if(preference.evidenceDisplay==="none") return undefined;
  if(preference.evidenceDisplay==="count") return `Evidence: ${plan.evidenceDigests.length} digest${plan.evidenceDigests.length===1?"":"s"}`;
  const visible=plan.evidenceDigests.slice(0,3).map((value)=>`${value.slice(0,19)}…`).join(", ");
  return `Evidence: ${visible||"none"}${plan.evidenceDigests.length>3?` +${plan.evidenceDigests.length-3} more`:""}`;
}

function dashboardIntent(plan:TelegramMessagePlanV1,label:string):TelegramDashboardLinkIntentV1 {
  return {kind:"dashboard_link",attentionId:plan.attentionId,attentionDigest:plan.attentionDigest,path:plan.deepLink.path,label,
    requiresAuthentication:true,grantsApproval:false,grantsExecutionAuthority:false};
}

function callbackIntents(plan:TelegramMessagePlanV1,preference:TelegramPresentationPreferencesV1):TelegramCallbackIntentV1[] {
  if(riskRank[plan.risk]>=riskRank.high) return [];
  const result:TelegramCallbackIntentV1[]=[];
  for(const responseKind of plan.responseKinds){
    if(responseKind==="answer_choice"){
      for(const option of plan.responseOptions) result.push({kind:"callback_intent",attentionId:plan.attentionId,attentionDigest:plan.attentionDigest,
        responseKind,responseValueDigest:option.valueDigest,label:option.label,grantsApproval:false,grantsExecutionAuthority:false});
    } else result.push({kind:"callback_intent",attentionId:plan.attentionId,attentionDigest:plan.attentionDigest,responseKind,
      label:responseLabels[responseKind][preference.buttonStyle],grantsApproval:false,grantsExecutionAuthority:false});
  }
  return result;
}

function compatible(left:TelegramMessagePlanV1,right:TelegramMessagePlanV1):boolean {
  return left.tenantId===right.tenantId&&left.recipientId===right.recipientId&&left.projectId===right.projectId&&
    left.groupingKey===right.groupingKey&&left.delivery===right.delivery;
}

/** Groups only compatible plans inside a caller-supplied policy window. It never sends or signs anything. */
export function groupTelegramMessagePlansV1(input:{plans:unknown[];preferences:unknown;groupingWindowSeconds:number;now:string}):TelegramMessagePlanV1[][] {
  const preferences=telegramPresentationPreferencesSchemaV1.parse(input.preferences) as TelegramPresentationPreferencesV1;
  const now=Date.parse(input.now);
  if(!Number.isFinite(now)) throw new Error("current time invalid");
  if(now<Date.parse(preferences.updatedAt)||now>=Date.parse(preferences.expiresAt)) throw new Error("presentation preferences not current");
  if(!Number.isInteger(input.groupingWindowSeconds)||input.groupingWindowSeconds<0||input.groupingWindowSeconds>3600) throw new Error("grouping window invalid");
  const plans=input.plans.map((value)=>telegramMessagePlanSchemaV1.parse(value) as TelegramMessagePlanV1)
    .sort((left,right)=>left.createdAt.localeCompare(right.createdAt)||left.messagePlanId.localeCompare(right.messagePlanId));
  const groups:TelegramMessagePlanV1[][]=[];
  for(const plan of plans){
    if(plan.tenantId!==preferences.tenantId||plan.recipientId!==preferences.recipientId) throw new Error("presentation preference scope mismatch");
    if(now>=Date.parse(plan.expiresAt)) throw new Error("message plan expired");
    const current=groups.at(-1); const first=current?.[0];
    const withinWindow=first ? Date.parse(plan.createdAt)-Date.parse(first.createdAt)<=input.groupingWindowSeconds*1000 : false;
    if(!current||!first||current.length>=preferences.maximumGroupedItems||!compatible(first,plan)||!withinWindow) groups.push([plan]);
    else current.push(plan);
  }
  return groups;
}

export function renderTelegramPresentationV1(input:{plans:unknown[];preferences:unknown;createdAt:string}):TelegramPresentationV1 {
  const preferences=telegramPresentationPreferencesSchemaV1.parse(input.preferences) as TelegramPresentationPreferencesV1;
  const plans=input.plans.map((value)=>telegramMessagePlanSchemaV1.parse(value) as TelegramMessagePlanV1);
  if(plans.length<1||plans.length>preferences.maximumGroupedItems) throw new Error("presentation group size invalid");
  if(plans.some((plan)=>plan.tenantId!==preferences.tenantId||plan.recipientId!==preferences.recipientId)) throw new Error("presentation preference scope mismatch");
  if(plans.some((plan)=>!compatible(plans[0],plan))) throw new Error("presentation plans are not group-compatible");
  const createdAt=Date.parse(input.createdAt);
  if(!Number.isFinite(createdAt)||createdAt<Date.parse(preferences.updatedAt)||createdAt>=Date.parse(preferences.expiresAt)) throw new Error("presentation preferences not current");
  if(plans.some((plan)=>createdAt>=Date.parse(plan.expiresAt))) throw new Error("message plan expired");
  assertNoSecretMaterial({plans,preferences},"Telegram presentation input");
  const risk=maximum(plans.map((plan)=>plan.risk),riskRank); const urgency=maximum(plans.map((plan)=>plan.urgency),urgencyRank);
  const lines=[`CONTROL ROOM · ${plans.length===1?titleCase(plans[0].messageClass):`${plans.length} grouped items`} · ${risk.toUpperCase()}`];
  plans.forEach((plan,index)=>{
    lines.push("",`${plans.length===1?"":`${index+1}. `}${plan.safeTitle}`,truncate(plan.safeSummary,preferences.verbosity==="compact"?180:300));
    if(preferences.includeProjectId) lines.push(`Project: ${plan.projectId}`);
    if(preferences.verbosity==="standard"||plan.urgency!=="routine") lines.push(`Urgency: ${titleCase(plan.urgency)}`);
    const evidence=renderEvidence(plan,preferences); if(evidence) lines.push(evidence);
    if(preferences.verbosity==="standard") lines.push(`Expires: ${plan.expiresAt}`);
  });
  if(plans[0].delivery==="defer_quiet_hours") lines.push("","Delivery is deferred by quiet hours.");
  lines.push("","Telegram can record a response proposal only. It cannot approve or run this work.");
  const buttons=plans.length===1
    ? [...callbackIntents(plans[0],preferences),dashboardIntent(plans[0],riskRank[risk]>=riskRank.high?"Open protected approval":"Open in Control Room")]
    : plans.map((plan,index)=>dashboardIntent(plan,`Open item ${index+1}`));
  const sourceMessagePlanIds=plans.map((plan)=>plan.messagePlanId).sort();
  const presentation:TelegramPresentationV1={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,
    presentationId:`tgpresentation:${sourceMessagePlanIds[0]}:${sourceMessagePlanIds.at(-1)}:${sourceMessagePlanIds.length}`,
    tenantId:plans[0].tenantId,recipientId:plans[0].recipientId,projectId:plans[0].projectId,groupingKey:plans[0].groupingKey,
    sourceMessagePlanIds,messageClasses:[...new Set(plans.map((plan)=>plan.messageClass))].sort(),risk,urgency,delivery:plans[0].delivery,plainText:lines.join("\n"),parseMode:"none",buttons,createdAt:input.createdAt,
    expiresAt:plans.map((plan)=>plan.expiresAt).sort()[0],grantsApproval:false,grantsExecutionAuthority:false};
  const parsed=telegramPresentationSchemaV1.parse(presentation) as TelegramPresentationV1;
  assertNoSecretMaterial(parsed,"Telegram presentation");
  return parsed;
}
