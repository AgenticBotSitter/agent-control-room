import { DOMAIN_CONTRACT_VERSION, scheduleRecordSchema, type ScheduleRecord } from "../../../domain/v1";
import { actionInboxItemSchemaV1, scheduleProjectionSchemaV1, type ActionInboxItemV1, type ScheduleProjectionV1 } from "../../../operator-surfaces/v1";
import { calculateScheduleOccurrencesV1 } from "../../../services/v1";
import { assertNoSecretMaterial, sha256Digest } from "../../../security";
import { ProjectWorkspaceContractErrorV1, exactProjectWorkspaceJsonV1, parseExactProjectWorkspaceV1 } from "../../../project-workspace/v1";
import { absNewsAutomationDeclarationInputSchemaV1, absNewsAutomationDeclarationSchemaV1, absNewsAutomationRunSchemaV1 } from "./schemas";
import { ABS_NEWS_CONTRACT_V1, type AbsNewsAutomationDeclarationV1, type AbsNewsAutomationProjectionV1, type AbsNewsAutomationRunV1 } from "./types";

function unsigned<T extends Record<string, unknown>>(value: T, digestField: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[digestField];
  return copy;
}

function parseServerRecord<T>(schema: { parse(value: unknown): T }, value: unknown): T {
  try {
    const parsed = schema.parse(exactProjectWorkspaceJsonV1(value));
    assertNoSecretMaterial(parsed, "ABS automation record");
    return parsed;
  } catch (error) {
    if (error instanceof ProjectWorkspaceContractErrorV1) throw error;
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
}

function parseDeclaration(value: unknown): AbsNewsAutomationDeclarationV1 {
  const declaration = parseServerRecord(absNewsAutomationDeclarationSchemaV1, value) as AbsNewsAutomationDeclarationV1;
  if (sha256Digest(unsigned(declaration as unknown as Record<string, unknown>, "declarationDigest")) !== declaration.declarationDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return declaration;
}

export function buildAbsNewsAutomationDeclarationV1(inputValue: unknown): AbsNewsAutomationDeclarationV1 {
  const input = parseExactProjectWorkspaceV1(absNewsAutomationDeclarationInputSchemaV1, inputValue);
  try { new Intl.DateTimeFormat("en-US", { timeZone: input.timezone }).format(new Date(input.declaredAt)); } catch { throw new ProjectWorkspaceContractErrorV1("invalid_input"); }
  const oneMinuteLater = new Date(Date.parse(input.declaredAt) + 60_000).toISOString();
  const calculation = calculateScheduleOccurrencesV1({ id: input.automationId, kind: input.scheduleType, state: "active", expression: input.expression, timezone: input.timezone, anchorAt: input.declaredAt }, { startsAt: input.declaredAt, endsAt: oneMinuteLater });
  if (calculation.safeReason) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const schedule = scheduleRecordSchema.parse({
    contractVersion: DOMAIN_CONTRACT_VERSION, kind: "schedule", id: input.automationId, tenantId: input.tenantId,
    version: 0, createdAt: input.declaredAt, updatedAt: input.declaredAt, projectId: input.projectId,
    state: "disabled", scheduleType: input.scheduleType, expression: input.expression, timezone: input.timezone,
    targetType: "service_check", targetId: input.sourceId, idempotencyWindowSeconds: input.idempotencyWindowSeconds,
  }) as ScheduleRecord;
  const material: Omit<AbsNewsAutomationDeclarationV1, "declarationDigest"> = {
    contractVersion: ABS_NEWS_CONTRACT_V1, automationId: input.automationId, tenantId: input.tenantId,
    workspaceId: input.workspaceId, projectId: input.projectId, automationKind: input.automationKind,
    sourceMode: input.sourceMode, sourceId: input.sourceId, sourceKind: input.sourceKind, schedule,
    maxItemsPerRun: input.maxItemsPerRun, maxRuntimeSeconds: input.maxRuntimeSeconds, maxAttempts: input.maxAttempts,
    retryableFailureCodes: [...input.retryableFailureCodes].sort(), networkPolicy: "none", allowedNetworkDestinations: [],
    credentialRefs: [], state: "disabled", activationState: "owner_authority_required", createsBackgroundProcess: false,
    grantsNetworkAuthority: false, grantsExecutionAuthority: false,
  };
  return parseServerRecord(absNewsAutomationDeclarationSchemaV1, { ...material, declarationDigest: sha256Digest(material) }) as AbsNewsAutomationDeclarationV1;
}

export { parseDeclaration as parseAbsNewsAutomationDeclarationV1 };

export function parseAbsNewsAutomationRunV1(value: unknown): AbsNewsAutomationRunV1 {
  const run = parseExactProjectWorkspaceV1(absNewsAutomationRunSchemaV1, value) as AbsNewsAutomationRunV1;
  if (sha256Digest(unsigned(run as unknown as Record<string, unknown>, "runDigest")) !== run.runDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return run;
}

function sealRun(material: Omit<AbsNewsAutomationRunV1, "runDigest">): AbsNewsAutomationRunV1 {
  return parseExactProjectWorkspaceV1(absNewsAutomationRunSchemaV1, { ...material, runDigest: sha256Digest(material) }) as AbsNewsAutomationRunV1;
}

/** Creates simulation evidence only. A disabled schedule is never activated or dispatched here. */
export function buildAbsNewsSyntheticAutomationRunV1(input: { declaration: unknown; occurrenceKey: string; scheduledFor: string; createdAt: string; attemptNumber?: number }): AbsNewsAutomationRunV1 {
  const declaration = parseDeclaration(input.declaration);
  if (declaration.sourceMode !== "synthetic" || declaration.state !== "disabled") throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  const attemptNumber = input.attemptNumber ?? 1;
  const runId = `run:abs:${sha256Digest({ declarationDigest: declaration.declarationDigest, occurrenceKey: input.occurrenceKey, attemptNumber }).slice(7, 39)}`;
  return sealRun({
    contractVersion: ABS_NEWS_CONTRACT_V1, runId, tenantId: declaration.tenantId, workspaceId: declaration.workspaceId,
    projectId: declaration.projectId, automationId: declaration.automationId, declarationDigest: declaration.declarationDigest,
    occurrenceKey: input.occurrenceKey, scheduledFor: input.scheduledFor, attemptNumber, state: "pending",
    createdAt: input.createdAt, updatedAt: input.createdAt, retryPermitted: false, simulationOnly: true,
    scheduleActivationObserved: false, networkUsed: false, grantsNetworkAuthority: false, grantsExecutionAuthority: false,
  });
}

export function transitionAbsNewsSyntheticAutomationRunV1(input: { declaration: unknown; run: unknown; toState: "running" | "succeeded" | "failed" | "ambiguous"; updatedAt: string; safeFailureCode?: string; resultDigest?: string }): AbsNewsAutomationRunV1 {
  const declaration = parseDeclaration(input.declaration), run = parseAbsNewsAutomationRunV1(input.run);
  if (run.declarationDigest !== declaration.declarationDigest || run.automationId !== declaration.automationId || Date.parse(input.updatedAt) < Date.parse(run.updatedAt)) throw new ProjectWorkspaceContractErrorV1("replay_drift");
  const allowed = run.state === "pending" ? ["running"] : run.state === "running" ? ["succeeded", "failed", "ambiguous"] : [];
  if (!allowed.includes(input.toState)) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  if (input.toState === "succeeded" && (!input.resultDigest || input.safeFailureCode)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  if (["failed", "ambiguous"].includes(input.toState) && (!input.safeFailureCode || input.resultDigest)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const retryPermitted = input.toState === "failed" && run.attemptNumber < declaration.maxAttempts && declaration.retryableFailureCodes.includes(input.safeFailureCode!);
  const { runDigest: _digest, safeFailureCode: _failure, resultDigest: _result, ...base } = run;
  void _digest; void _failure; void _result;
  return sealRun({ ...base, state: input.toState, updatedAt: input.updatedAt, retryPermitted, ...(input.safeFailureCode ? { safeFailureCode: input.safeFailureCode } : {}), ...(input.resultDigest ? { resultDigest: input.resultDigest } : {}) });
}

/** Any run that may have crossed its start boundary becomes terminally ambiguous after restart. */
export function recoverAbsNewsAutomationRunV1(input: { declaration: unknown; run: unknown; recoveredAt: string }): AbsNewsAutomationRunV1 {
  const run = parseAbsNewsAutomationRunV1(input.run);
  if (run.state !== "running") return run;
  return transitionAbsNewsSyntheticAutomationRunV1({ declaration: input.declaration, run, toState: "ambiguous", updatedAt: input.recoveredAt, safeFailureCode: "restart_unsettled_run" });
}

export function retryAbsNewsAutomationRunV1(input: { declaration: unknown; failedRun: unknown; createdAt: string }): AbsNewsAutomationRunV1 {
  const declaration = parseDeclaration(input.declaration), failed = parseAbsNewsAutomationRunV1(input.failedRun);
  if (failed.state !== "failed" || !failed.retryPermitted || failed.declarationDigest !== declaration.declarationDigest) throw new ProjectWorkspaceContractErrorV1("unsupported_action");
  return buildAbsNewsSyntheticAutomationRunV1({ declaration, occurrenceKey: failed.occurrenceKey, scheduledFor: failed.scheduledFor, createdAt: input.createdAt, attemptNumber: failed.attemptNumber + 1 });
}

export function projectAbsNewsAutomationV1(declarationValue: unknown, latestRunValue?: unknown): AbsNewsAutomationProjectionV1 {
  const declaration = parseDeclaration(declarationValue);
  const latestRun = latestRunValue ? parseAbsNewsAutomationRunV1(latestRunValue) : undefined;
  const schedule = scheduleProjectionSchemaV1.parse({
    scheduleId: declaration.schedule.id, projectId: declaration.projectId, state: "disabled",
    scheduleType: declaration.schedule.scheduleType, targetType: declaration.schedule.targetType,
    targetId: declaration.schedule.targetId, timezone: declaration.schedule.timezone,
    idempotencyWindowSeconds: declaration.schedule.idempotencyWindowSeconds,
  }) as ScheduleProjectionV1;
  let attention: ActionInboxItemV1 | undefined;
  if (latestRun && ["failed", "ambiguous"].includes(latestRun.state)) attention = {
    id: `attention:abs:${latestRun.runId}`, tenantId: latestRun.tenantId, projectId: latestRun.projectId,
    workItemId: latestRun.runId, kind: latestRun.state === "ambiguous" ? "ambiguity" : "failure", state: "open",
    requestedAction: latestRun.state === "ambiguous" ? "Reconcile the unsettled synthetic run" : "Review the failed synthetic run",
    reasonCode: latestRun.safeFailureCode!, blockedWorkItemIds: [latestRun.runId],
    legalResponses: [{ id: "response:abs:review-run", kind: "request_review", label: "Review run evidence", requiresConfirmation: false, available: true }],
    evidence: [{ id: latestRun.runId, kind: "audit", digest: latestRun.runDigest, observedAt: latestRun.updatedAt }],
    createdAt: latestRun.updatedAt, deliveryState: "not_requested",
  };
  return { schedule, ...(attention ? { attention: actionInboxItemSchemaV1.parse(attention) as ActionInboxItemV1 } : {}) };
}
