import { renderTelegramPresentationV1 } from "@/src/telegram/v1/presentation";
import type { TelegramMessagePlanV1, TelegramPresentationPreferencesV1, TelegramPresentationV1 } from "@/src/telegram/v1/types";

const d=(character:string)=>`sha256:${character.repeat(64)}`;
const base={schemaVersion:"control-room-telegram/v1",recipientId:"recipient:owner",tenantId:"tenant:control-room",projectId:"project.wayfarer.lazy-river",
  groupingKey:"tggrp:wayfarer",urgency:"routine",delivery:"deliver_now",evidenceDigests:[d("a")] as string[],createdAt:"2026-08-28T18:00:00.000Z",
  expiresAt:"2026-08-28T18:15:00.000Z",grantsApproval:false,grantsExecutionAuthority:false} as const;
const deep=(attentionId:string,attentionDigest:string)=>({schemaVersion:"control-room-telegram/v1" as const,attentionId,attentionDigest,
  path:`/attention/${attentionId}`,requiresAuthenticatedDashboard:true as const,requiresStrongFactorForConsequentialApproval:true as const,
  grantsApproval:false as const,grantsExecutionAuthority:false as const});

const question:TelegramMessagePlanV1={...base,messagePlanId:"tgplan:question",attentionId:"attention:question",attentionDigest:d("1"),messageClass:"question",risk:"low",
  safeTitle:"Choose the next review route",safeSummary:"Two independently reviewed options are ready for an owner preference.",
  responseKinds:["acknowledge","answer_choice","request_review"],responseOptions:[{valueDigest:d("2"),label:"Use the focused review"},{valueDigest:d("3"),label:"Use the broad review"}],
  deepLink:deep("attention:question",d("1"))};
const approval:TelegramMessagePlanV1={...base,messagePlanId:"tgplan:approval",attentionId:"attention:approval",attentionDigest:d("4"),messageClass:"approval_request",risk:"high",urgency:"urgent",
  safeTitle:"Protected operation approval requested",safeSummary:"Open Control Room to review the exact operation and complete strong-factor approval.",
  responseKinds:[],responseOptions:[],evidenceDigests:[d("b"),d("c")],deepLink:deep("attention:approval",d("4"))};
const deferred:TelegramMessagePlanV1={...base,messagePlanId:"tgplan:deferred",attentionId:"attention:deferred",attentionDigest:d("5"),messageClass:"review",risk:"medium",
  delivery:"defer_quiet_hours",safeTitle:"Independent review needs attention",safeSummary:"The review remains queued until the recipient quiet-hours window ends.",
  responseKinds:["acknowledge","decline","request_review"],responseOptions:[],deepLink:deep("attention:deferred",d("5"))};
const groupedA:TelegramMessagePlanV1={...base,messagePlanId:"tgplan:group-a",attentionId:"attention:group-a",attentionDigest:d("6"),messageClass:"informational",risk:"low",
  safeTitle:"First verification completed",safeSummary:"The named render check passed with digest-addressed evidence.",responseKinds:[],responseOptions:[],deepLink:deep("attention:group-a",d("6"))};
const groupedB:TelegramMessagePlanV1={...base,messagePlanId:"tgplan:group-b",attentionId:"attention:group-b",attentionDigest:d("7"),messageClass:"informational",risk:"low",
  safeTitle:"Second verification completed",safeSummary:"The named source check passed with digest-addressed evidence.",responseKinds:[],responseOptions:[],createdAt:"2026-08-28T18:00:30.000Z",deepLink:deep("attention:group-b",d("7"))};

export const cr8dPresentationPreferencesFixture:TelegramPresentationPreferencesV1={schemaVersion:"control-room-telegram/v1",preferencesId:"tgpreferences:owner",
  tenantId:"tenant:control-room",recipientId:"recipient:owner",verbosity:"standard",includeProjectId:true,evidenceDisplay:"count",buttonStyle:"descriptive",
  maximumGroupedItems:5,updatedAt:"2026-08-28T17:00:00.000Z",expiresAt:"2026-09-01T00:00:00.000Z",grantsApproval:false,grantsExecutionAuthority:false};

export const cr8dTelegramPresentationFixture:readonly TelegramPresentationV1[]=[question,approval,deferred,[groupedA,groupedB]].map((value)=>
  renderTelegramPresentationV1({plans:Array.isArray(value)?value:[value],preferences:cr8dPresentationPreferencesFixture,createdAt:"2026-08-28T18:01:00.000Z"}));
