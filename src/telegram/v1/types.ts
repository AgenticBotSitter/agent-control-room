export const TELEGRAM_CONTRACT_VERSION_V1 = "control-room-telegram/v1" as const;

export type TelegramRiskV1 = "low" | "medium" | "high" | "critical";
export type TelegramUrgencyV1 = "routine" | "urgent" | "critical";
export type TelegramMessageClassV1 = "informational" | "question" | "review" | "approval_request" | "incident";
export type TelegramResponseKindV1 = "acknowledge" | "answer_choice" | "request_review" | "request_retry" | "decline";

export interface TelegramResponseOptionV1 {
  valueDigest: string;
  label: string;
}

export interface TelegramQuietHoursV1 {
  timeZone: string;
  startMinute: number;
  endMinute: number;
}

export interface TelegramRecipientPolicyV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  recipientId: string;
  tenantId: string;
  chatIdDigest: string;
  enabled: boolean;
  verifiedAt: string;
  allowedProjectIds: string[];
  allowedMessageClasses: TelegramMessageClassV1[];
  maximumRisk: TelegramRiskV1;
  quietHours: TelegramQuietHoursV1 | null;
  criticalMayBypassQuietHours: boolean;
  groupingWindowSeconds: number;
  policyExpiresAt: string;
}

export interface TelegramAttentionBindingV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  attentionId: string;
  attentionDigest: string;
  tenantId: string;
  projectId: string;
  messageClass: TelegramMessageClassV1;
  deterministicRisk: TelegramRiskV1;
  assessedRisk: TelegramRiskV1;
  effectiveRisk: TelegramRiskV1;
  urgency: TelegramUrgencyV1;
  safeTitle: string;
  safeSummary: string;
  evidenceDigests: string[];
  allowedResponseKinds: TelegramResponseKindV1[];
  responseOptions: TelegramResponseOptionV1[];
  createdAt: string;
  expiresAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface TelegramDeepLinkV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  attentionId: string;
  attentionDigest: string;
  path: string;
  requiresAuthenticatedDashboard: true;
  requiresStrongFactorForConsequentialApproval: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface TelegramCallbackRecordV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  callbackId: string;
  tenantId: string;
  projectId: string;
  recipientId: string;
  chatIdDigest: string;
  attentionId: string;
  attentionDigest: string;
  messageClass: TelegramMessageClassV1;
  risk: TelegramRiskV1;
  responseKind: TelegramResponseKindV1;
  responseValueDigest?: string;
  messagePlanDigest: string;
  issuedAt: string;
  expiresAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface TelegramMessagePlanV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  messagePlanId: string;
  recipientId: string;
  tenantId: string;
  projectId: string;
  attentionId: string;
  attentionDigest: string;
  messageClass: TelegramMessageClassV1;
  risk: TelegramRiskV1;
  urgency: TelegramUrgencyV1;
  delivery: "deliver_now" | "defer_quiet_hours";
  groupingKey: string;
  safeTitle: string;
  safeSummary: string;
  evidenceDigests: string[];
  responseKinds: TelegramResponseKindV1[];
  responseOptions: TelegramResponseOptionV1[];
  deepLink: TelegramDeepLinkV1;
  createdAt: string;
  expiresAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface TelegramWebhookObservationV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  updateId: number;
  bodyDigest: string;
  chatIdDigest: string;
  callbackQueryIdDigest: string;
  callbackToken: string;
  observedAt: string;
}

export interface TelegramResponseProposalV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  proposalId: string;
  tenantId: string;
  projectId: string;
  recipientId: string;
  attentionId: string;
  attentionDigest: string;
  responseKind: TelegramResponseKindV1;
  responseValueDigest?: string;
  callbackId: string;
  updateId: number;
  callbackQueryIdDigest: string;
  observedAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
  requiresIndependentPolicyEvaluation: true;
}

export interface TelegramCallbackReceiptV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  status: "recorded" | "replayed";
  proposal: TelegramResponseProposalV1;
}

export interface TelegramPresentationPreferencesV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  preferencesId: string;
  tenantId: string;
  recipientId: string;
  verbosity: "compact" | "standard";
  includeProjectId: boolean;
  evidenceDisplay: "none" | "count" | "digests";
  buttonStyle: "compact" | "descriptive";
  maximumGroupedItems: number;
  updatedAt: string;
  expiresAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface TelegramCallbackIntentV1 {
  kind: "callback_intent";
  attentionId: string;
  attentionDigest: string;
  responseKind: TelegramResponseKindV1;
  responseValueDigest?: string;
  label: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface TelegramDashboardLinkIntentV1 {
  kind: "dashboard_link";
  attentionId: string;
  attentionDigest: string;
  path: string;
  label: string;
  requiresAuthentication: true;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}

export interface TelegramPresentationV1 {
  schemaVersion: typeof TELEGRAM_CONTRACT_VERSION_V1;
  presentationId: string;
  tenantId: string;
  recipientId: string;
  projectId: string;
  groupingKey: string;
  sourceMessagePlanIds: string[];
  messageClasses: TelegramMessageClassV1[];
  risk: TelegramRiskV1;
  urgency: TelegramUrgencyV1;
  delivery: "deliver_now" | "defer_quiet_hours";
  plainText: string;
  parseMode: "none";
  buttons: Array<TelegramCallbackIntentV1 | TelegramDashboardLinkIntentV1>;
  createdAt: string;
  expiresAt: string;
  grantsApproval: false;
  grantsExecutionAuthority: false;
}
