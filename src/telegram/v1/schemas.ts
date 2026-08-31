import { z } from "zod";
import { TELEGRAM_CONTRACT_VERSION_V1 } from "./types";

const id=z.string().min(3).max(160).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const digest=z.string().regex(/^sha256:[a-f0-9]{64}$/);
const time=z.string().datetime({offset:true});
const risk=z.enum(["low","medium","high","critical"]);
const urgency=z.enum(["routine","urgent","critical"]);
const messageClass=z.enum(["informational","question","review","approval_request","incident"]);
const responseKind=z.enum(["acknowledge","answer_choice","request_review","request_retry","decline"]);
export const TELEGRAM_CALLBACK_ID_PATTERN_V1=/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,29}$/;
export const TELEGRAM_CALLBACK_TOKEN_PATTERN_V1=/^([a-zA-Z0-9][a-zA-Z0-9_-]{2,29})\.([a-zA-Z0-9_-]{22})$/;
export const telegramCallbackIdSchemaV1=z.string().regex(TELEGRAM_CALLBACK_ID_PATTERN_V1);
export const telegramCallbackTokenSchemaV1=z.string().min(26).max(53).regex(TELEGRAM_CALLBACK_TOKEN_PATTERN_V1);
const isSafeLine=(value:string)=>![...value].some((character)=>{const code=character.codePointAt(0)??0; return code<32||code===127;});
const safeText=z.string().min(1).max(500).refine(isSafeLine,"display text must be one safe line");
const safeTitle=z.string().min(1).max(120).refine(isSafeLine,"display text must be one safe line");
const safeButtonLabel=z.string().min(1).max(64).refine(isSafeLine,"button label must be one safe line");
const responseOption=z.object({valueDigest:digest,label:safeButtonLabel}).strict();
const responseOptions=z.array(responseOption).max(8).superRefine((values,ctx)=>{
  const digests=values.map((value)=>value.valueDigest);
  if(new Set(digests).size!==digests.length) ctx.addIssue({code:"custom",message:"response option digests must be unique"});
  if(digests.join("|")!==[...digests].sort().join("|")) ctx.addIssue({code:"custom",message:"response options must be sorted by digest"});
});
const uniqueSorted=<T extends z.ZodType<string>>(item:T,min:number,max:number)=>z.array(item).min(min).max(max).superRefine((values,ctx)=>{
  if(new Set(values).size!==values.length) ctx.addIssue({code:"custom",message:"values must be unique"});
  if(values.join("|")!==[...values].sort().join("|")) ctx.addIssue({code:"custom",message:"values must be sorted"});
});

export const telegramQuietHoursSchemaV1=z.object({timeZone:z.string().min(1).max(80),startMinute:z.number().int().min(0).max(1439),
  endMinute:z.number().int().min(0).max(1439)}).strict().superRefine((value,ctx)=>{
    if(value.startMinute===value.endMinute) ctx.addIssue({code:"custom",message:"quiet-hours interval cannot be empty"});
    try { new Intl.DateTimeFormat("en-US",{timeZone:value.timeZone}).format(new Date(0)); }
    catch { ctx.addIssue({code:"custom",message:"time zone invalid",path:["timeZone"]}); }
  });

export const telegramRecipientPolicySchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),recipientId:id,tenantId:id,
  chatIdDigest:digest,enabled:z.boolean(),verifiedAt:time,allowedProjectIds:uniqueSorted(id,1,100),
  allowedMessageClasses:uniqueSorted(messageClass,1,5),maximumRisk:risk,quietHours:telegramQuietHoursSchemaV1.nullable(),
  criticalMayBypassQuietHours:z.boolean(),groupingWindowSeconds:z.number().int().min(0).max(3600),policyExpiresAt:time}).strict()
  .refine((value)=>Date.parse(value.policyExpiresAt)>Date.parse(value.verifiedAt),{message:"recipient policy must expire after verification",path:["policyExpiresAt"]});

export const telegramAttentionBindingSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),attentionId:id,attentionDigest:digest,
  tenantId:id,projectId:id,messageClass,deterministicRisk:risk,assessedRisk:risk,effectiveRisk:risk,urgency,
  safeTitle,safeSummary:safeText,evidenceDigests:uniqueSorted(digest,0,20),allowedResponseKinds:uniqueSorted(responseKind,0,5),responseOptions,
  createdAt:time,expiresAt:time,grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict()
  .superRefine((value,ctx)=>{
    if(Date.parse(value.expiresAt)<=Date.parse(value.createdAt)) ctx.addIssue({code:"custom",message:"attention must expire after creation",path:["expiresAt"]});
    if(value.allowedResponseKinds.includes("answer_choice")!== (value.responseOptions.length>=2)) ctx.addIssue({code:"custom",message:"answer choice requires at least two bound options",path:["responseOptions"]});
  });

const deepLinkPath=z.string().min(12).max(220).refine((value)=>/^\/attention\/[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value),
  "deep link must be a query-free relative attention route");
export const telegramDeepLinkSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),attentionId:id,attentionDigest:digest,
  path:deepLinkPath,requiresAuthenticatedDashboard:z.literal(true),requiresStrongFactorForConsequentialApproval:z.literal(true),
  grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict();

export const telegramCallbackRecordSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),callbackId:telegramCallbackIdSchemaV1,tenantId:id,
  projectId:id,recipientId:id,chatIdDigest:digest,attentionId:id,attentionDigest:digest,messageClass,risk,responseKind,responseValueDigest:digest.optional(),messagePlanDigest:digest,issuedAt:time,expiresAt:time,
  grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict().superRefine((value,ctx)=>{
    const ttl=Date.parse(value.expiresAt)-Date.parse(value.issuedAt);
    if(ttl<=0||ttl>15*60_000) ctx.addIssue({code:"custom",message:"callback lifetime must be positive and at most 15 minutes",path:["expiresAt"]});
    if((value.responseKind==="answer_choice")!==Boolean(value.responseValueDigest)) ctx.addIssue({code:"custom",message:"answer choice requires one bound value digest",path:["responseValueDigest"]});
  });

export const telegramMessagePlanSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),messagePlanId:id,recipientId:id,tenantId:id,
  projectId:id,attentionId:id,attentionDigest:digest,messageClass,risk,urgency,delivery:z.enum(["deliver_now","defer_quiet_hours"]),groupingKey:id,
  safeTitle,safeSummary:safeText,evidenceDigests:uniqueSorted(digest,0,20),responseKinds:uniqueSorted(responseKind,0,5),responseOptions,
  deepLink:telegramDeepLinkSchemaV1,createdAt:time,expiresAt:time,grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict()
  .superRefine((value,ctx)=>{
    if(Date.parse(value.expiresAt)<=Date.parse(value.createdAt)) ctx.addIssue({code:"custom",message:"message plan expired",path:["expiresAt"]});
    if(value.deepLink.attentionId!==value.attentionId || value.deepLink.attentionDigest!==value.attentionDigest) ctx.addIssue({code:"custom",message:"deep-link lineage mismatch",path:["deepLink"]});
    if((["high","critical"] as string[]).includes(value.risk) && value.responseKinds.length) ctx.addIssue({code:"custom",message:"high-risk messages are deep-link only",path:["responseKinds"]});
    if(value.responseKinds.includes("answer_choice")!== (value.responseOptions.length>=2)) ctx.addIssue({code:"custom",message:"answer choice requires at least two bound options",path:["responseOptions"]});
    if((["high","critical"] as string[]).includes(value.risk) && value.responseOptions.length) ctx.addIssue({code:"custom",message:"high-risk messages cannot carry response options",path:["responseOptions"]});
  });

export const telegramPresentationPreferencesSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),preferencesId:id,tenantId:id,
  recipientId:id,verbosity:z.enum(["compact","standard"]),includeProjectId:z.boolean(),evidenceDisplay:z.enum(["none","count","digests"]),
  buttonStyle:z.enum(["compact","descriptive"]),maximumGroupedItems:z.number().int().min(1).max(5),updatedAt:time,expiresAt:time,
  grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict().refine((value)=>Date.parse(value.expiresAt)>Date.parse(value.updatedAt),
  {message:"presentation preferences must expire after update",path:["expiresAt"]});

const callbackIntent=z.object({kind:z.literal("callback_intent"),attentionId:id,attentionDigest:digest,responseKind,responseValueDigest:digest.optional(),
  label:safeButtonLabel,grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict().superRefine((value,ctx)=>{
    if((value.responseKind==="answer_choice")!==Boolean(value.responseValueDigest)) ctx.addIssue({code:"custom",message:"choice callback intent requires one value digest",path:["responseValueDigest"]});
  });
const dashboardLinkIntent=z.object({kind:z.literal("dashboard_link"),attentionId:id,attentionDigest:digest,path:deepLinkPath,label:safeButtonLabel,
  requiresAuthentication:z.literal(true),grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict();
export const telegramPresentationSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),presentationId:id,tenantId:id,recipientId:id,
  projectId:id,groupingKey:id,sourceMessagePlanIds:uniqueSorted(id,1,5),risk,urgency,delivery:z.enum(["deliver_now","defer_quiet_hours"]),
  messageClasses:uniqueSorted(messageClass,1,5),
  plainText:z.string().min(1).max(4096).refine((value)=>![...value].some((character)=>{const code=character.codePointAt(0)??0;return (code<32&&code!==10)||code===127;}),"message text contains unsafe control characters"),
  parseMode:z.literal("none"),buttons:z.array(z.discriminatedUnion("kind",[callbackIntent,dashboardLinkIntent])).min(1).max(10),createdAt:time,expiresAt:time,
  grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false)}).strict().superRefine((value,ctx)=>{
    if(Date.parse(value.expiresAt)<=Date.parse(value.createdAt)) ctx.addIssue({code:"custom",message:"presentation must expire after creation",path:["expiresAt"]});
    if((["high","critical"] as string[]).includes(value.risk)&&value.buttons.some((button)=>button.kind==="callback_intent")) ctx.addIssue({code:"custom",message:"high-risk presentation cannot carry callback intents",path:["buttons"]});
  });

export const telegramWebhookObservationSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),updateId:z.number().int().nonnegative(),
  bodyDigest:digest,chatIdDigest:digest,callbackQueryIdDigest:digest,callbackToken:telegramCallbackTokenSchemaV1,observedAt:time}).strict();

export const telegramResponseProposalSchemaV1=z.object({schemaVersion:z.literal(TELEGRAM_CONTRACT_VERSION_V1),proposalId:id,tenantId:id,projectId:id,
  recipientId:id,attentionId:id,attentionDigest:digest,responseKind,responseValueDigest:digest.optional(),callbackId:telegramCallbackIdSchemaV1,updateId:z.number().int().nonnegative(),callbackQueryIdDigest:digest,
  observedAt:time,grantsApproval:z.literal(false),grantsExecutionAuthority:z.literal(false),requiresIndependentPolicyEvaluation:z.literal(true)}).strict();
