import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  buildCompletionFlowReceiptV1,
  buildEffectFreeExecutionObservationV1,
  CompletionFlowErrorV1,
  parseCompletionFlowReceiptV1,
} from "../src/completion-flow/v1";
import {
  COMPLETION_GATE_SCHEMA_VERSION_V1,
  CompletionGateStoreV1,
  type CompletionAcceptanceProfileV1,
  type CompletionFindingV1,
  type CompletionPreferenceV1,
  type CompletionPrincipalV1,
  type CompletionReviewTargetV1,
  type CompletionReviewV1,
  type CompletionRevisionV1,
  type CompletionVerificationV1,
  type ConsequentialApprovalDecisionV1,
  type ConsequentialApprovalRequestV1,
} from "../src/completion-gate/v1";
import type { AuthorityEnvelope, EffectIntentRecord, JobRecord } from "../src/domain/v1";
import {
  NODE_POLICY_CONTRACT_V1,
  computeNormalizedOperationDigest,
  type LocalPolicyDecisionV1,
  type NormalizedLocalPolicyRequestV1,
} from "../src/node-policy/v1";
import { buildArtifactLineageRecord, buildTextArtifactBundle, runSyntheticExecution } from "../src/node-executor";
import type { SyntheticExecutionEventV1 } from "../src/node-executor/synthetic-executor";
import { OperatorSurfaceStoreV1, type ActionInboxItemV1 } from "../src/operator-surfaces/v1";
import { adaptPglite } from "../src/persistence/database";
import {
  FixedConsumerSecretBrokerV1,
  NodeLocalSecretBrokerV1,
  SECRET_BROKER_CONTRACT_V1,
  SafeCredentialCatalogV1,
  SqliteSecretInvocationLedgerV1,
  SyntheticSecretProviderV1,
  buildCredentialCatalogEntryV1,
  type CredentialCatalogEntryV1,
} from "../src/secret-broker/v1";
import {
  InMemoryRollbackCheckpointStoreV1,
  SecurityStore,
  computeAuthorityDigest,
  computeEffectOperationDigest,
  sha256Digest,
} from "../src/security";
import {
  TELEGRAM_CONTRACT_VERSION_V1,
  TelegramDurableStoreV1,
  buildTelegramMessagePlanV1,
  issueTelegramCallbackTokenV1,
  renderTelegramPresentationV1,
  type TelegramAttentionBindingV1,
  type TelegramCallbackRecordV1,
  type TelegramPresentationPreferencesV1,
  type TelegramRecipientPolicyV1,
} from "../src/telegram/v1";
import { observedProxy } from "./proxy-test-helper";

const tenantId = "tenant:cr8i";
const projectId = "project:cr8i";
const nodeId = "node:cr8i";
const workflowId = "workflow:cr8i";
const jobId = "job:cr8i";
const attemptId = "attempt:cr8i";
const executorId = "executor:cr8i";
const credentialRef = "credential:cr8i:scratch";
const purposeId = "purpose:cr8i:prepare";
const externalOperationId = "operation:cr8i:publish";
const initialOperationId = "operation:cr8i:prepare";
const revisionOperationId = "operation:cr8i:revise";
const recipientId = "recipient:cr8i:owner";

const tQuestion = "2026-08-29T12:00:00.000Z";
const tMessage = "2026-08-29T12:00:01.000Z";
const tProposal = "2026-08-29T12:00:02.000Z";
const tPreference = "2026-08-29T12:00:03.000Z";
const tApprovalRequest = "2026-08-29T12:00:04.000Z";
const tApprovalDecision = "2026-08-29T12:00:05.000Z";
const tLocalDecision = "2026-08-29T12:00:06.000Z";
const tSecretReceipt = "2026-08-29T12:00:07.000Z";
const tInitialExecution = "2026-08-29T12:00:08.000Z";
const tInitialTarget = "2026-08-29T12:00:09.000Z";
const tInitialReview = "2026-08-29T12:00:10.000Z";
const tRevisionDecision = "2026-08-29T12:00:11.000Z";
const tRevisionExecution = "2026-08-29T12:00:12.000Z";
const tRevisedTarget = "2026-08-29T12:00:13.000Z";
const tVerificationContent = "2026-08-29T12:00:14.000Z";
const tVerificationSecurity = "2026-08-29T12:00:15.000Z";
const tFinalReview = "2026-08-29T12:00:16.000Z";
const tCompleted = "2026-08-29T12:00:17.000Z";

const completionIntegrityKey = new Uint8Array(32).fill(0x81);
const telegramIntegrityKey = new Uint8Array(32).fill(0x82);
const telegramCallbackKey = new Uint8Array(32).fill(0x83);
const secretLedgerKey = new Uint8Array(32).fill(0x84);
const digest = (label: string) => sha256Digest({ label });

async function prepareDatabase(): Promise<PGlite> {
  const raw = new PGlite();
  for (const file of (await readdir(resolve("db/migrations"))).filter((entry) => entry.endsWith(".sql")).sort()) {
    await raw.exec(await readFile(resolve("db/migrations", file), "utf8"));
  }
  await raw.query(`INSERT INTO tenants(id,display_name) VALUES ($1,'CR8I')`, [tenantId]);
  await raw.query(`INSERT INTO workspaces(id,tenant_id,display_name) VALUES ('workspace:cr8i',$1,'CR8I')`, [tenantId]);
  await raw.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,redaction_policy_version,cursor_retention_days)
    VALUES ('adapter:cr8i',$1,'fixture','v1','advisory','v1',30)`, [tenantId]);
  await raw.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,normalized_state,domain_state,health,authority_mode,observed_at,payload)
    VALUES ($1,$2,'workspace:cr8i','adapter:cr8i','source:cr8i','v1','CR8I','ready','ready','healthy','advisory',$3,'{}'::jsonb)`,
  [projectId, tenantId, tQuestion]);
  return raw;
}

async function seedCanonicalWork(raw: PGlite): Promise<{ job: JobRecord; effect: EffectIntentRecord }> {
  await raw.query(`INSERT INTO control_nodes(id,tenant_id,state,version,identity_key_id,payload,created_at,updated_at)
    VALUES ($1,$2,'active',1,'key:cr8i',$3::jsonb,$4,$4)`, [
    nodeId, tenantId, JSON.stringify({ id: nodeId, tenantId, state: "active", version: 1, identityKeyId: "key:cr8i" }), tQuestion,
  ]);
  await raw.query(`INSERT INTO control_requests(id,tenant_id,state,version,idempotency_key,payload,created_at,updated_at)
    VALUES ('request:cr8i',$1,'draft',0,'request-cr8i-key',$2::jsonb,$3,$3)`, [
    tenantId, JSON.stringify({ id: "request:cr8i", tenantId, state: "draft", version: 0, idempotencyKey: "request-cr8i-key" }), tQuestion,
  ]);
  const workflowDigest = digest("cr8i-workflow");
  await raw.query(`INSERT INTO control_workflows(id,tenant_id,request_id,project_id,definition_digest,state,version,payload,created_at,updated_at)
    VALUES ($1,$2,'request:cr8i',$3,$4,'active',1,$5::jsonb,$6,$6)`, [
    workflowId, tenantId, projectId, workflowDigest,
    JSON.stringify({ id: workflowId, tenantId, requestId: "request:cr8i", projectId, definitionDigest: workflowDigest, state: "active", version: 1 }),
    tQuestion,
  ]);
  const authority: AuthorityEnvelope = {
    projectId,
    allowedExecutor: executorId,
    allowedOperations: [externalOperationId, initialOperationId, revisionOperationId].sort(),
    credentialRefs: [credentialRef],
    filesystemRoots: [],
    networkPolicy: "none",
    allowedNetworkDestinations: [],
    effectPolicy: "approval_required",
    maxRisk: "medium",
    maxDurationSeconds: 300,
    maxConcurrentEffects: 1,
    expiresAt: "2026-08-29T12:30:00.000Z",
    digest: "",
  };
  authority.digest = computeAuthorityDigest(authority);
  const job: JobRecord = {
    contractVersion: "control-room-domain/v1",
    id: jobId,
    tenantId,
    version: 1,
    createdAt: tQuestion,
    updatedAt: tQuestion,
    kind: "job",
    workflowId,
    projectId,
    jobType: "synthetic:cr8i",
    specVersion: "v1",
    inputDigest: digest("cr8i-input"),
    state: "running",
    priority: 80,
    requiredCapability: "capability:synthetic",
    dependsOnJobIds: [],
    authority,
    retryPolicy: { maxAttempts: 1, backoffSeconds: 0, retryableFailureCodes: [], retryAfterOrphan: false, ambiguousEffectPolicy: "attention" },
  };
  await raw.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
    VALUES ($1,$2,$3,$4,'running',1,80,'capability:synthetic',$5,$6::jsonb,$7,$7)`,
  [job.id, tenantId, workflowId, projectId, authority.digest, JSON.stringify(job), tQuestion]);
  await raw.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,node_id,lease_epoch,payload,created_at,updated_at)
    VALUES ($1,$2,$3,1,'running',1,$4,1,$5::jsonb,$6,$6)`, [
    attemptId, tenantId, jobId, nodeId,
    JSON.stringify({ id: attemptId, tenantId, jobId, attemptNumber: 1, state: "running", version: 1, nodeId, leaseEpoch: 1 }),
    tQuestion,
  ]);
  const effectBase = {
    tenantId,
    jobId,
    attemptId,
    operation: externalOperationId,
    destination: "destination:cr8i:reviewed",
    idempotencyKey: "effect-cr8i-idempotency",
    risk: "medium" as const,
  };
  const effect: EffectIntentRecord = {
    contractVersion: "control-room-domain/v1",
    id: "effect:cr8i:publish",
    version: 0,
    createdAt: tApprovalRequest,
    updatedAt: tApprovalRequest,
    kind: "effect_intent",
    ...effectBase,
    operationDigest: computeEffectOperationDigest(effectBase, projectId),
    state: "proposed",
  };
  await raw.query(`INSERT INTO control_effect_intents(id,tenant_id,job_id,attempt_id,operation_digest,destination,idempotency_key,state,version,payload,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'proposed',0,$8::jsonb,$9,$9)`, [
    effect.id, tenantId, jobId, attemptId, effect.operationDigest, effect.destination, effect.idempotencyKey, JSON.stringify(effect), effect.createdAt,
  ]);
  return { job, effect };
}

function admittedLocalRequest(job: JobRecord, input: {
  requestId: string;
  operationId: string;
  credentialRefs: string[];
  occurredAt: string;
}): NormalizedLocalPolicyRequestV1 {
  const base: NormalizedLocalPolicyRequestV1 = {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    requestId: input.requestId,
    tenantId,
    nodeId,
    nodeClass: "node-class:cr8i",
    projectId,
    jobId,
    attemptId,
    leaseId: "lease:cr8i",
    leaseEpoch: 1,
    executorId,
    operationId: input.operationId,
    operationDigest: digest("placeholder"),
    authorityDigest: job.authority.digest,
    credentialRefs: [...input.credentialRefs].sort(),
    target: { kind: "none" },
    risk: "medium",
    externalEffect: false,
    estimatedDurationSeconds: 30,
    occurredAt: input.occurredAt,
  };
  return { ...base, operationDigest: computeNormalizedOperationDigest(base) };
}

function localDecision(request: NormalizedLocalPolicyRequestV1, decidedAt: string): LocalPolicyDecisionV1 {
  return {
    contractVersion: NODE_POLICY_CONTRACT_V1,
    requestId: request.requestId,
    requestDigest: sha256Digest(request),
    ceilingDigest: digest("cr8i-local-ceiling"),
    authorityDigest: request.authorityDigest,
    decidedAt,
    accepted: true,
  };
}

const producer: CompletionPrincipalV1 = {
  actorId: "agent:cr8i:producer",
  actorType: "agent",
  workerId: "worker:cr8i:producer",
  agentProfileId: "profile:cr8i:producer",
  harness: "harness:hermes",
  modelFamily: "model:producer",
};
const reviewerOne: CompletionPrincipalV1 = {
  actorId: "agent:cr8i:reviewer:one",
  actorType: "agent",
  workerId: "worker:cr8i:reviewer:one",
  agentProfileId: "profile:cr8i:reviewer:one",
  harness: "harness:codex",
  modelFamily: "model:reviewer:one",
};
const reviewerTwo: CompletionPrincipalV1 = {
  actorId: "agent:cr8i:reviewer:two",
  actorType: "agent",
  workerId: "worker:cr8i:reviewer:two",
  agentProfileId: "profile:cr8i:reviewer:two",
  harness: "harness:independent",
  modelFamily: "model:reviewer:two",
};

test("CR8I composes one disposable question, bounded response, exact approval, scratch secret, evidence, and independent revision without an effect", async () => {
  const raw = await prepareDatabase();
  const directory = await mkdtemp(join(tmpdir(), "cr8i-acceptance-"));
  await chmod(directory, 0o700);
  const secretLedgerPath = join(directory, "secret-ledger.sqlite");
  try {
    const { job, effect } = await seedCanonicalWork(raw);
    const database = adaptPglite(raw);
    const operatorStore = new OperatorSurfaceStoreV1(database);
    const completionCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
    const completionStore = new CompletionGateStoreV1(database, completionIntegrityKey, completionCheckpoints, () => tApprovalDecision);
    await completionStore.provisionTenant(tenantId);

    const conciseDigest = sha256Digest({ option: "concise_local_result" });
    const detailedDigest = sha256Digest({ option: "detailed_local_result" });
    const responseOptions = [
      { valueDigest: conciseDigest, label: "Concise result" },
      { valueDigest: detailedDigest, label: "Detailed result" },
    ].sort((left, right) => left.valueDigest.localeCompare(right.valueDigest));
    const question: ActionInboxItemV1 = {
      id: "attention:cr8i:question",
      tenantId,
      projectId,
      workItemId: jobId,
      kind: "question",
      state: "open",
      requestedAction: "Choose the bounded local result format",
      reasonCode: "result_format_required",
      blockedWorkItemIds: [jobId],
      legalResponses: [
        { id: "response:cr8i:choose", kind: "record_decision", label: "Record a format choice", requiresConfirmation: false, available: true },
        { id: "response:cr8i:inspect", kind: "open_source", label: "Open safe evidence", requiresConfirmation: false, available: true },
        { id: "response:cr8i:approve", kind: "approve_exact_operation", label: "Use protected approval", requiresConfirmation: true, available: false, unavailableReasonCode: "strong_factor_required" },
      ],
      evidence: [{ id: "audit:cr8i:question", kind: "audit", digest: digest("question-audit"), observedAt: tQuestion }],
      createdAt: tQuestion,
      expiresAt: "2026-08-29T12:10:00.000Z",
      deliveryState: "delivered",
    };
    assert.deepEqual(await operatorStore.upsertInbox(question), { replayed: false });

    const recipientPolicy: TelegramRecipientPolicyV1 = {
      schemaVersion: TELEGRAM_CONTRACT_VERSION_V1,
      recipientId,
      tenantId,
      chatIdDigest: digest("cr8i-chat"),
      enabled: true,
      verifiedAt: "2026-08-29T11:59:00.000Z",
      allowedProjectIds: [projectId],
      allowedMessageClasses: ["question"],
      maximumRisk: "medium",
      quietHours: null,
      criticalMayBypassQuietHours: false,
      groupingWindowSeconds: 120,
      policyExpiresAt: "2026-08-29T13:00:00.000Z",
    };
    const telegramCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
    const telegramStore = new TelegramDurableStoreV1(database, telegramIntegrityKey, telegramCallbackKey, telegramCheckpoints);
    await telegramStore.provisionTenant(tenantId);
    await telegramStore.registerRecipient(recipientPolicy);
    const attentionBinding: TelegramAttentionBindingV1 = {
      schemaVersion: TELEGRAM_CONTRACT_VERSION_V1,
      attentionId: question.id,
      attentionDigest: sha256Digest(question),
      tenantId,
      projectId,
      messageClass: "question",
      deterministicRisk: "medium",
      assessedRisk: "low",
      effectiveRisk: "medium",
      urgency: "urgent",
      safeTitle: "Control Room needs one local choice",
      safeSummary: "Choose one digest-bound format. This answer cannot approve or execute work.",
      evidenceDigests: [digest("question-audit")],
      allowedResponseKinds: ["answer_choice", "decline"],
      responseOptions,
      createdAt: tQuestion,
      expiresAt: "2026-08-29T12:10:00.000Z",
      grantsApproval: false,
      grantsExecutionAuthority: false,
    };
    const messagePlan = buildTelegramMessagePlanV1({ policy: recipientPolicy, attention: attentionBinding, now: tMessage });
    const presentationPreferences: TelegramPresentationPreferencesV1 = {
      schemaVersion: TELEGRAM_CONTRACT_VERSION_V1,
      preferencesId: "preferences:cr8i",
      tenantId,
      recipientId,
      verbosity: "standard",
      includeProjectId: true,
      evidenceDisplay: "count",
      buttonStyle: "descriptive",
      maximumGroupedItems: 1,
      updatedAt: "2026-08-29T11:59:00.000Z",
      expiresAt: "2026-08-29T13:00:00.000Z",
      grantsApproval: false,
      grantsExecutionAuthority: false,
    };
    const presentation = renderTelegramPresentationV1({ plans: [messagePlan], preferences: presentationPreferences, createdAt: tMessage });
    assert.match(presentation.plainText, /cannot approve or run this work/i);
    const callbackRecord: TelegramCallbackRecordV1 = {
      schemaVersion: TELEGRAM_CONTRACT_VERSION_V1,
      callbackId: "cb_cr8i_choice_001",
      tenantId,
      projectId,
      recipientId,
      chatIdDigest: recipientPolicy.chatIdDigest,
      attentionId: question.id,
      attentionDigest: sha256Digest(question),
      messageClass: "question",
      risk: "medium",
      responseKind: "answer_choice",
      responseValueDigest: detailedDigest,
      messagePlanDigest: sha256Digest(messagePlan),
      issuedAt: tMessage,
      expiresAt: "2026-08-29T12:10:00.000Z",
      grantsApproval: false,
      grantsExecutionAuthority: false,
    };
    await telegramStore.registerCallback({ record: callbackRecord, messagePlan });
    const callbackToken = issueTelegramCallbackTokenV1(callbackRecord, telegramCallbackKey);
    const callbackReceipt = await telegramStore.consumeCallback({
      tenantId,
      recipientId,
      now: tProposal,
      observation: {
        schemaVersion: TELEGRAM_CONTRACT_VERSION_V1,
        updateId: 8_001,
        bodyDigest: digest("cr8i-callback-body"),
        chatIdDigest: recipientPolicy.chatIdDigest,
        callbackQueryIdDigest: digest("cr8i-callback-query"),
        callbackToken,
        observedAt: tProposal,
      },
    });
    assert.equal(callbackReceipt.status, "recorded");
    assert.equal(callbackReceipt.proposal.requiresIndependentPolicyEvaluation, true);
    const storedTelegramObservation = (await raw.query<{ body: string }>(`SELECT observation::text AS body FROM control_telegram_updates WHERE tenant_id=$1`, [tenantId])).rows[0]?.body;
    assert.ok(storedTelegramObservation);
    assert.doesNotMatch(storedTelegramObservation, new RegExp(callbackToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const preference: CompletionPreferenceV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "preference:cr8i:format",
      tenantId,
      projectId,
      subjectId: question.id,
      subjectDigest: sha256Digest(question),
      optionDigests: responseOptions.map((item) => item.valueDigest).sort(),
      selectedOptionDigest: callbackReceipt.proposal.responseValueDigest!,
      selectedBy: { actorId: "service:cr8i:response-policy", actorType: "service" },
      selectedAt: tPreference,
      grantsApproval: false,
      grantsExecutionAuthority: false,
    };
    await completionStore.recordPreference(preference);
    const resolvedQuestion: ActionInboxItemV1 = { ...question, state: "resolved" };
    await operatorStore.upsertInbox(resolvedQuestion);
    assert.equal((await operatorStore.listInbox({ tenantId, limit: 10 }))[0]?.state, "resolved");

    const approvalRequest: ConsequentialApprovalRequestV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "approval-request:cr8i:publish",
      tenantId,
      projectId,
      jobId,
      attemptId,
      effectIntentId: effect.id,
      operationDigest: effect.operationDigest,
      risk: effect.risk,
      requestedBy: { actorId: "agent:cr8i:requester", actorType: "agent" },
      requiredFactor: "strong",
      requestedAt: tApprovalRequest,
      expiresAt: "2026-08-29T12:10:00.000Z",
      grantsExecutionAuthority: false,
    };
    await completionStore.requestApproval(approvalRequest);
    const approvalDecision: ConsequentialApprovalDecisionV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "approval-decision:cr8i:publish",
      tenantId,
      projectId,
      requestId: approvalRequest.id,
      requestDigest: sha256Digest(approvalRequest),
      operationDigest: approvalRequest.operationDigest,
      policyDecisionId: "policy-decision:cr8i:publish",
      decision: "approved",
      decidedBy: { actorId: "human:cr8i:owner", actorType: "human" },
      factor: "strong",
      authenticationEventDigest: sha256Digest({ evidenceId: "factor:cr8i:passkey" }),
      decidedAt: tApprovalDecision,
      expiresAt: "2026-08-29T12:05:00.000Z",
      safeReasonCode: "owner_confirmed_exact_operation",
      grantsExecutionAuthority: false,
      requiresSeparateNodeAttestation: true,
    };
    const securityStore = new SecurityStore(database);
    const authentication = {
      tenantId,
      provider: "fixture",
      subject: "owner:cr8i",
      verifiedAt: tApprovalRequest,
      expiresAt: "2026-08-29T13:00:00.000Z",
      strongFactor: {
        evidenceId: "factor:cr8i:passkey",
        method: "passkey" as const,
        verifiedAt: tApprovalRequest,
        expiresAt: "2026-08-29T12:10:00.000Z",
      },
    };
    await securityStore.bootstrapOwner({
      ...authentication,
      identityId: approvalDecision.decidedBy.actorId,
      grantId: "grant:cr8i:owner",
      displayName: "CR8I owner",
      now: tApprovalRequest,
    });
    await securityStore.authorize({
      decisionId: approvalDecision.policyDecisionId,
      authentication,
      request: {
        tenantId,
        action: "approval.decide",
        resourceType: "effect_intent",
        resourceId: effect.id,
        projectId,
        risk: effect.risk,
        externalEffect: true,
        occurredAt: approvalDecision.decidedAt,
      },
    });
    const storedApproval = await completionStore.decideApproval(approvalDecision);
    assert.deepEqual({
      grantsExecutionAuthority: storedApproval.decision.grantsExecutionAuthority,
      requiresSeparateNodeAttestation: storedApproval.decision.requiresSeparateNodeAttestation,
    }, { grantsExecutionAuthority: false, requiresSeparateNodeAttestation: true });
    assert.equal((await raw.query<{ state: string }>(`SELECT state FROM control_effect_intents WHERE tenant_id=$1 AND id=$2`, [tenantId, effect.id])).rows[0]?.state, "proposed");

    const initialPolicyRequest = admittedLocalRequest(job, {
      requestId: "local-policy:cr8i:initial",
      operationId: initialOperationId,
      credentialRefs: [credentialRef],
      occurredAt: tLocalDecision,
    });
    const initialPolicyDecision = localDecision(initialPolicyRequest, tLocalDecision);
    const providerReferenceDigest = digest("cr8i-synthetic-provider-reference");
    const catalogEntry: CredentialCatalogEntryV1 = buildCredentialCatalogEntryV1({
      contractVersion: SECRET_BROKER_CONTRACT_V1,
      credentialRef,
      tenantId,
      nodeId,
      revision: 1,
      projectIds: [projectId],
      executorIds: [executorId],
      operationIds: [initialOperationId],
      purposeIds: [purposeId],
      providerKind: "synthetic_test",
      providerReferenceDigest,
      materialKind: "opaque",
      state: "active",
      maxLeaseSeconds: 60,
      singleUseOnly: true,
      createdAt: tLocalDecision,
      rotatedAt: tLocalDecision,
    });
    const catalog = new SafeCredentialCatalogV1();
    catalog.register(catalogEntry);
    const scratchCanary = "cr8i-synthetic-scratch-material-never-persist";
    const provider = new SyntheticSecretProviderV1([{
      credentialRef,
      providerReferenceDigest,
      material: new TextEncoder().encode(scratchCanary),
    }]);
    const secretCheckpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
    const secretLedger = new SqliteSecretInvocationLedgerV1(secretLedgerPath, digest("cr8i-secret-ledger"), {
      integrityKey: secretLedgerKey,
      checkpointStore: secretCheckpoints,
      mode: "create",
      testOnlyAllowEphemeral: true,
      clock: () => tSecretReceipt,
    });
    const secretBroker = new NodeLocalSecretBrokerV1(catalog, [provider], secretLedger, { clock: () => tSecretReceipt });
    let consumerBuffer: Uint8Array | undefined;
    const fixedSecretBroker = new FixedConsumerSecretBrokerV1(secretBroker, [{
      executorId,
      operationId: initialOperationId,
      purposeId,
      consumer: {
        async consume(material, _context, result) {
          consumerBuffer = material;
          assert.equal(new TextDecoder().decode(material), scratchCanary);
          result.submit({ outcome: "succeeded", outputDigest: sha256Digest({ selectedOptionDigest: preference.selectedOptionDigest, scratch: "prepared" }) });
        },
      },
    }]);
    const secretGrant = secretBroker.authorize({
      request: initialPolicyRequest,
      decision: initialPolicyDecision,
      credentialRef,
      purposeId,
      invocationId: "secret-invocation:cr8i:initial",
      nonce: "cr8i-synthetic-nonce-0001",
      expiresAt: "2026-08-29T12:00:36.000Z",
    });
    const secretReceipt = await fixedSecretBroker.invoke({ grant: secretGrant, now: tSecretReceipt });
    assert.equal(secretReceipt.state, "succeeded");
    assert.ok(consumerBuffer?.every((byte) => byte === 0));
    assert.deepEqual(provider.safeMetrics(), { acquires: 1, releases: 1 });
    secretLedger.close();
    assert.doesNotMatch((await readFile(secretLedgerPath)).toString("utf8"), new RegExp(scratchCanary));

    const initialArtifactText = `CR8I local result\nformat=${preference.selectedOptionDigest}\nscratch=${secretReceipt.outputDigest}\n`;
    const initialSpec = {
      schema: "control-room.synthetic-execution/v1" as const,
      jobId,
      attemptId,
      steps: 2,
      checkpointEverySteps: 1,
      stepDelayMilliseconds: 0,
      artifactText: initialArtifactText,
    };
    const initialProgress: SyntheticExecutionEventV1[] = [];
    const initialResult = await runSyntheticExecution(initialSpec, {
      signal: new AbortController().signal,
      now: () => tInitialExecution,
      sleep: async () => {},
      emit: event => { initialProgress.push(event); },
    });
    assert.deepEqual(initialProgress.map(event => event.event),
      ["started", "progress", "checkpointed", "progress", "checkpointed", "completed"]);
    assert.deepEqual(initialProgress.filter(event => event.event === "progress").map(event => event.progressPercent), [50, 100]);
    assert.ok(initialProgress.every((event, index) => event.sequence === index + 1
      && event.schema === "control-room.synthetic-execution-event/v1" && event.jobId === jobId && event.attemptId === attemptId));
    assert.equal(initialResult.state, "succeeded");
    if (initialResult.state !== "succeeded") throw new Error("initial synthetic execution failed");
    const initialBundle = buildTextArtifactBundle({
      artifactId: "artifact:cr8i:result",
      claimId: "claim:cr8i:initial",
      tenantId,
      projectId,
      workflowId,
      jobId,
      attemptId,
      producerId: producer.actorId,
      logicalRole: "completion_candidate",
      schemaVersion: "cr8i-result/v1",
      storageClass: "local",
      retentionClass: "disposable",
      text: initialArtifactText,
      createdAt: tInitialExecution,
    });
    assert.equal(Buffer.compare(Buffer.from(initialBundle.bytes), Buffer.from(initialResult.artifactBytes)), 0);
    const initialLineage = buildArtifactLineageRecord(initialBundle);
    const initialExecution = buildEffectFreeExecutionObservationV1({
      phase: "initial",
      executionId: "execution:cr8i:initial",
      policyRequest: initialPolicyRequest,
      policyDecision: initialPolicyDecision,
      artifactLineage: initialLineage,
      artifactBytes: initialBundle.bytes,
      secretReceipt,
      completedAt: tInitialExecution,
    });
    assert.equal(initialExecution.externalEffect, false);

    const acceptanceProfile: CompletionAcceptanceProfileV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "completion-profile:cr8i",
      tenantId,
      projectId,
      name: "CR8I document acceptance",
      targetKind: "document",
      requiredVerificationScenarioIds: ["scenario:content", "scenario:security"],
      minimumIndependentReviews: 1,
      reviewerSeparation: { actor: true, worker: true, agentProfile: true, harness: true, modelFamily: true },
      verificationRequiresProducerSeparation: true,
      minimumRisk: "medium",
      maximumRevisionRounds: 1,
      automaticLowRiskDisposition: false,
      createdBy: { actorId: "human:cr8i:owner", actorType: "human" },
      createdAt: "2026-08-29T11:59:00.000Z",
    };
    const initialTarget: CompletionReviewTargetV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "target:cr8i:result:0",
      tenantId,
      projectId,
      kind: "document",
      subjectId: initialExecution.artifactId,
      subjectDigest: initialExecution.artifactManifestDigest,
      acceptanceProfileId: acceptanceProfile.id,
      acceptanceProfileDigest: sha256Digest(acceptanceProfile),
      producer,
      rootTargetId: "target:cr8i:result:0",
      revisionNumber: 0,
      submittedAt: tInitialTarget,
    };
    await completionStore.registerProfile(acceptanceProfile);
    await completionStore.registerTarget(initialTarget);
    const finding: CompletionFindingV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "finding:cr8i:authority-statement",
      tenantId,
      projectId,
      targetId: initialTarget.id,
      targetDigest: sha256Digest(initialTarget),
      reviewId: "review:cr8i:changes",
      code: "authority_statement_missing",
      severity: "medium",
      statementDigest: digest("must-state-approved-effect-unexecuted"),
      evidenceDigests: [initialExecution.observationDigest],
      raisedAt: tInitialReview,
    };
    const initialReview: CompletionReviewV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: finding.reviewId,
      tenantId,
      projectId,
      targetId: initialTarget.id,
      targetDigest: sha256Digest(initialTarget),
      acceptanceProfileId: acceptanceProfile.id,
      acceptanceProfileDigest: sha256Digest(acceptanceProfile),
      reviewer: reviewerOne,
      authority: "completion_gate",
      decision: "changes_requested",
      assessedRisk: "low",
      effectiveRisk: "medium",
      evidenceDigests: [initialExecution.observationDigest],
      findingIds: [finding.id],
      reviewedAt: tInitialReview,
      grantsApproval: false,
      grantsExecutionAuthority: false,
    };
    await completionStore.recordReview(initialReview, [finding]);
    assert.equal((await completionStore.snapshot(tenantId, initialTarget.id)).status, "changes_requested");

    const revisionPolicyRequest = admittedLocalRequest(job, {
      requestId: "local-policy:cr8i:revision",
      operationId: revisionOperationId,
      credentialRefs: [],
      occurredAt: tRevisionDecision,
    });
    const revisionPolicyDecision = localDecision(revisionPolicyRequest, tRevisionDecision);
    const revisionArtifactText = `${initialArtifactText}approved_external_operation=${approvalDecision.operationDigest}\napproved_operation_executed=false\nnode_attestation_present=false\n`;
    const revisionSpec = {
      schema: "control-room.synthetic-execution/v1" as const,
      jobId,
      attemptId,
      steps: 2,
      checkpointEverySteps: 1,
      stepDelayMilliseconds: 0,
      artifactText: revisionArtifactText,
    };
    const revisionProgress: SyntheticExecutionEventV1[] = [];
    const revisionResult = await runSyntheticExecution(revisionSpec, {
      signal: new AbortController().signal,
      now: () => tRevisionExecution,
      sleep: async () => {},
      emit: async event => {
        // Until the new result is registered, the original review must stay open.
        assert.equal((await completionStore.snapshot(tenantId, initialTarget.id)).status, "changes_requested");
        revisionProgress.push(event);
      },
    });
    assert.deepEqual(revisionProgress.map(event => event.event), initialProgress.map(event => event.event));
    assert.deepEqual(revisionProgress.filter(event => event.event === "progress").map(event => event.progressPercent), [50, 100]);
    assert.ok(revisionProgress.every((event, index) => event.sequence === index + 1
      && event.schema === "control-room.synthetic-execution-event/v1" && event.jobId === jobId && event.attemptId === attemptId));
    assert.equal(revisionResult.state, "succeeded");
    if (revisionResult.state !== "succeeded") throw new Error("revision synthetic execution failed");
    const revisionBundle = buildTextArtifactBundle({
      artifactId: initialExecution.artifactId,
      claimId: "claim:cr8i:revision",
      tenantId,
      projectId,
      workflowId,
      jobId,
      attemptId,
      producerId: producer.actorId,
      logicalRole: "completion_candidate_revision",
      schemaVersion: "cr8i-result/v1",
      storageClass: "local",
      retentionClass: "disposable",
      text: revisionArtifactText,
      createdAt: tRevisionExecution,
    });
    assert.equal(Buffer.compare(Buffer.from(revisionBundle.bytes), Buffer.from(revisionResult.artifactBytes)), 0);
    const revisionLineage = buildArtifactLineageRecord(revisionBundle);
    const revisionExecution = buildEffectFreeExecutionObservationV1({
      phase: "revision",
      executionId: "execution:cr8i:revision",
      policyRequest: revisionPolicyRequest,
      policyDecision: revisionPolicyDecision,
      artifactLineage: revisionLineage,
      artifactBytes: revisionBundle.bytes,
      completedAt: tRevisionExecution,
    });
    assert.notEqual(revisionExecution.artifactManifestDigest, initialExecution.artifactManifestDigest);

    const revisedTarget: CompletionReviewTargetV1 = {
      ...initialTarget,
      id: "target:cr8i:result:1",
      subjectDigest: revisionExecution.artifactManifestDigest,
      rootTargetId: initialTarget.id,
      revisionNumber: 1,
      supersedesTargetId: initialTarget.id,
      submittedAt: tRevisedTarget,
    };
    const revision: CompletionRevisionV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "revision:cr8i:result:1",
      tenantId,
      projectId,
      rootTargetId: initialTarget.id,
      fromTargetId: initialTarget.id,
      fromTargetDigest: sha256Digest(initialTarget),
      toTargetId: revisedTarget.id,
      toTargetDigest: sha256Digest(revisedTarget),
      revisionNumber: 1,
      resolvedFindingIds: [finding.id],
      revisedBy: producer,
      revisedAt: tRevisedTarget,
      grantsApproval: false,
      grantsExecutionAuthority: false,
    };
    await completionStore.recordRevision(revision, revisedTarget);
    assert.equal((await completionStore.snapshot(tenantId, initialTarget.id)).status, "superseded");

    const revisedVerifications: CompletionVerificationV1[] = [
      {
        schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
        id: "verification:cr8i:content",
        tenantId,
        projectId,
        targetId: revisedTarget.id,
        targetDigest: sha256Digest(revisedTarget),
        acceptanceProfileId: acceptanceProfile.id,
        acceptanceProfileDigest: sha256Digest(acceptanceProfile),
        scenarioId: "scenario:content",
        outcome: "passed",
        verifier: { actorId: "service:cr8i:content-verifier", actorType: "service" },
        evidenceDigests: [revisionExecution.artifactLineageDigest],
        verifiedAt: tVerificationContent,
        grantsApproval: false,
        grantsExecutionAuthority: false,
      },
      {
        schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
        id: "verification:cr8i:security",
        tenantId,
        projectId,
        targetId: revisedTarget.id,
        targetDigest: sha256Digest(revisedTarget),
        acceptanceProfileId: acceptanceProfile.id,
        acceptanceProfileDigest: sha256Digest(acceptanceProfile),
        scenarioId: "scenario:security",
        outcome: "passed",
        verifier: { actorId: "service:cr8i:security-verifier", actorType: "service" },
        evidenceDigests: [secretReceipt.outputDigest!, revisionExecution.observationDigest].sort(),
        verifiedAt: tVerificationSecurity,
        grantsApproval: false,
        grantsExecutionAuthority: false,
      },
    ];
    for (const verification of revisedVerifications) await completionStore.recordVerification(verification);
    const finalReview: CompletionReviewV1 = {
      schemaVersion: COMPLETION_GATE_SCHEMA_VERSION_V1,
      id: "review:cr8i:accepted",
      tenantId,
      projectId,
      targetId: revisedTarget.id,
      targetDigest: sha256Digest(revisedTarget),
      acceptanceProfileId: acceptanceProfile.id,
      acceptanceProfileDigest: sha256Digest(acceptanceProfile),
      reviewer: reviewerTwo,
      authority: "completion_gate",
      decision: "accepted",
      assessedRisk: "low",
      effectiveRisk: "medium",
      evidenceDigests: [revisionExecution.observationDigest],
      findingIds: [],
      reviewedAt: tFinalReview,
      grantsApproval: false,
      grantsExecutionAuthority: false,
    };
    await completionStore.recordReview(finalReview);
    const finalSnapshot = await completionStore.snapshot(tenantId, revisedTarget.id);
    assert.equal(finalSnapshot.status, "ready");

    const completionInput = {
      workflowId,
      question,
      resolvedQuestion,
      messagePlan,
      presentation,
      callbackRecord,
      responseProposal: callbackReceipt.proposal,
      preference,
      approvalRequest,
      approvalDecision,
      catalogEntry,
      secretGrant,
      secretReceipt,
      initialExecution,
      revisionExecution,
      acceptanceProfile,
      initialTarget,
      initialReview,
      initialFindings: [finding],
      revision,
      revisedTarget,
      revisedVerifications,
      finalReview,
      finalSnapshot,
      completedAt: tCompleted,
    };
    const receipt = buildCompletionFlowReceiptV1(completionInput);
    assert.deepEqual({
      status: receipt.finalStatus,
      approvedOperationDisposition: receipt.approvedOperationDisposition,
      approvedOperationExecuted: receipt.approvedOperationExecuted,
      liveEffectsPerformed: receipt.liveEffectsPerformed,
      productionCredentialMaterialPersisted: receipt.productionCredentialMaterialPersisted,
      nodeApprovalAttestationPresent: receipt.nodeApprovalAttestationPresent,
      grantsApproval: receipt.grantsApproval,
      grantsExecutionAuthority: receipt.grantsExecutionAuthority,
    }, {
      status: "ready",
      approvedOperationDisposition: "approved_not_executed",
      approvedOperationExecuted: false,
      liveEffectsPerformed: false,
      productionCredentialMaterialPersisted: false,
      nodeApprovalAttestationPresent: false,
      grantsApproval: false,
      grantsExecutionAuthority: false,
    });
    assert.deepEqual(parseCompletionFlowReceiptV1(receipt), receipt);
    assert.doesNotMatch(JSON.stringify(receipt), new RegExp(scratchCanary));
    assert.notEqual(receipt.approvedOperationDigest, initialExecution.operationDigest);
    assert.notEqual(receipt.approvedOperationDigest, revisionExecution.operationDigest);
    assert.throws(() => parseCompletionFlowReceiptV1({ ...receipt, approvedOperationExecuted: true }),
      (error: unknown) => error instanceof CompletionFlowErrorV1 && error.safeCode === "invalid_input");
    assert.throws(() => buildEffectFreeExecutionObservationV1({
      phase: "revision",
      executionId: "execution:cr8i:bad-bytes",
      policyRequest: revisionPolicyRequest,
      policyDecision: revisionPolicyDecision,
      artifactLineage: revisionLineage,
      artifactBytes: new TextEncoder().encode("different bytes"),
      completedAt: tRevisionExecution,
    }), (error: unknown) => error instanceof CompletionFlowErrorV1 && error.safeCode === "lineage_mismatch");
    const proxy = observedProxy(receipt, "throwing");
    assert.throws(() => parseCompletionFlowReceiptV1(proxy.value),
      (error: unknown) => error instanceof CompletionFlowErrorV1 && error.safeCode === "invalid_input");
    assert.equal(proxy.trapCount(), 0);
    assert.throws(() => buildCompletionFlowReceiptV1({
      ...completionInput,
      catalogEntry: { ...catalogEntry, entryDigest: `sha256:${"0".repeat(64)}` },
    }), (error: unknown) => error instanceof CompletionFlowErrorV1 && error.safeCode === "invalid_input");
  } finally {
    await raw.close();
    await rm(directory, { recursive: true, force: true });
  }
});
