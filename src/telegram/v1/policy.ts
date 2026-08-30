import { assertNoSecretMaterial } from "../../security/redaction";
import { sha256Digest } from "../../security/digest";
import { telegramAttentionBindingSchemaV1, telegramMessagePlanSchemaV1, telegramRecipientPolicySchemaV1 } from "./schemas";
import { TELEGRAM_CONTRACT_VERSION_V1, type TelegramAttentionBindingV1, type TelegramMessagePlanV1, type TelegramRecipientPolicyV1, type TelegramRiskV1 } from "./types";

const riskRank:Record<TelegramRiskV1,number>={low:0,medium:1,high:2,critical:3};

function localMinute(now:Date,timeZone:string):number {
  const parts=new Intl.DateTimeFormat("en-US",{timeZone,hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);
  const hour=Number(parts.find((part)=>part.type==="hour")?.value);
  const minute=Number(parts.find((part)=>part.type==="minute")?.value);
  if(!Number.isInteger(hour)||!Number.isInteger(minute)) throw new Error("quiet-hours clock unavailable");
  return hour*60+minute;
}

function isQuiet(now:Date,policy:TelegramRecipientPolicyV1):boolean {
  if(!policy.quietHours) return false;
  const minute=localMinute(now,policy.quietHours.timeZone);
  const {startMinute,endMinute}=policy.quietHours;
  return startMinute<endMinute ? minute>=startMinute&&minute<endMinute : minute>=startMinute||minute<endMinute;
}

export function buildTelegramMessagePlanV1(input:{policy:unknown;attention:unknown;now:string}):TelegramMessagePlanV1 {
  const policy=telegramRecipientPolicySchemaV1.parse(input.policy) as TelegramRecipientPolicyV1;
  const attention=telegramAttentionBindingSchemaV1.parse(input.attention) as TelegramAttentionBindingV1;
  const now=new Date(input.now);
  if(!Number.isFinite(now.getTime())) throw new Error("current time invalid");
  if(!policy.enabled) throw new Error("recipient disabled");
  if(now.getTime()<Date.parse(policy.verifiedAt)) throw new Error("recipient policy not yet valid");
  if(now.getTime()>=Date.parse(policy.policyExpiresAt)) throw new Error("recipient policy expired");
  if(now.getTime()>=Date.parse(attention.expiresAt)) throw new Error("attention expired");
  if(policy.tenantId!==attention.tenantId) throw new Error("recipient tenant mismatch");
  if(!policy.allowedProjectIds.includes(attention.projectId)) throw new Error("project not allowed for recipient");
  if(!policy.allowedMessageClasses.includes(attention.messageClass)) throw new Error("message class not allowed for recipient");
  if(riskRank[attention.assessedRisk]>riskRank[attention.effectiveRisk] || riskRank[attention.deterministicRisk]>riskRank[attention.effectiveRisk])
    throw new Error("effective risk below required floor");
  if(riskRank[attention.effectiveRisk]>riskRank[policy.maximumRisk]) throw new Error("recipient risk ceiling exceeded");
  assertNoSecretMaterial({safeTitle:attention.safeTitle,safeSummary:attention.safeSummary},"Telegram presentation");
  const highRisk=riskRank[attention.effectiveRisk]>=riskRank.high;
  const quiet=isQuiet(now,policy);
  const delivery=quiet && !(attention.urgency==="critical"&&policy.criticalMayBypassQuietHours) ? "defer_quiet_hours" : "deliver_now";
  const deepLink={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,attentionId:attention.attentionId,attentionDigest:attention.attentionDigest,
    path:`/attention/${attention.attentionId}`,requiresAuthenticatedDashboard:true as const,requiresStrongFactorForConsequentialApproval:true as const,
    grantsApproval:false as const,grantsExecutionAuthority:false as const};
  const plan:TelegramMessagePlanV1={schemaVersion:TELEGRAM_CONTRACT_VERSION_V1,
    messagePlanId:`tgplan:${sha256Digest({recipientId:policy.recipientId,attentionDigest:attention.attentionDigest,createdAt:input.now}).slice(7,39)}`,
    recipientId:policy.recipientId,tenantId:attention.tenantId,projectId:attention.projectId,attentionId:attention.attentionId,
    attentionDigest:attention.attentionDigest,messageClass:attention.messageClass,risk:attention.effectiveRisk,urgency:attention.urgency,delivery,
    groupingKey:`tggrp:${sha256Digest({recipientId:policy.recipientId,projectId:attention.projectId,messageClass:attention.messageClass}).slice(7,39)}`,
    safeTitle:attention.safeTitle,safeSummary:attention.safeSummary,evidenceDigests:attention.evidenceDigests,
    responseKinds:highRisk?[]:attention.allowedResponseKinds,responseOptions:highRisk?[]:attention.responseOptions,deepLink,createdAt:input.now,expiresAt:attention.expiresAt,
    grantsApproval:false,grantsExecutionAuthority:false};
  const parsed=telegramMessagePlanSchemaV1.parse(plan) as TelegramMessagePlanV1;
  assertNoSecretMaterial(parsed,"Telegram message plan");
  return parsed;
}
