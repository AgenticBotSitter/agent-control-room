import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1 } from "../src/completion-gate/v1";
import { projectExactPackageCodexCompletedTurnV1 } from "../src/harness/codex-v1/completed-turn";
import { CODEX_APP_SERVER_ADAPTER, CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_JOB_TYPE,
  CODEX_START_OPERATION } from "../src/harness/codex-v1/delivery-contract";
import { CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT } from "../src/harness/codex-v1/schema-contract";
import { createCodexPhysicalQualificationReceiptBodyV1, createCodexResultPublicationContractV1 } from "../src/harness/codex-v1/result-publication-contract";
import { projectCodexTerminalResultEvidenceV1 } from "../src/harness/v1/terminal-result-evidence";
import type { ArtifactReadPortV1, ArtifactStoragePortV1 } from "../src/node-executor/artifact-storage";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { signArtifact } from "../src/node-policy/v1/crypto";
import { NODE_PROTOCOL_V1, signNodeFrame } from "../src/node-protocol/v1";
import { CodexCanonicalResultPublisherV1 } from "../src/artifacts/v1/codex-results";
import { resultBytesHash } from "../src/artifacts/v1/native-results";
import { InMemoryRollbackCheckpointStoreV1, computeAuthorityDigest, hmacSha256Tag, sha256Digest } from "../src/security";
import { SecurityStore } from "../src/security";
import { codexCurrentAdmissionSchemaV1 } from "../src/web/v1/codex-activation-transmission-intent";
import { codexTaskExecutionPlanSchemaV3, TaskExecutionPlanner } from "../src/web/v1/task-execution-planner";
import { WebTaskReviewService } from "../src/web/v1/task-review-service";
import { WebTaskService } from "../src/web/v1/task-service";
import { createAccessVerifier } from "../src/web/v1/access-verifier";
import { CodexResultInspectionServiceV1 } from "../src/completion-gate/v1/codex-result-inspection";
import { NativeTaskCompletionService } from "../src/persistence/native-task-completion";
import { at, nativeTaskFixture } from "./native-task-fixture";
import { token, request as webRequest, trust } from "./helpers/web-foundation";

const resultKey = new Uint8Array(32).fill(51), harnessKey = new Uint8Array(32).fill(17);
const taskPlanKey = new Uint8Array(32).fill(53), activationKey = new Uint8Array(32).fill(54);
const reviewKey = new Uint8Array(32).fill(55);

class ControlledStorage implements ArtifactStoragePortV1, ArtifactReadPortV1 {
  readonly artifacts = new Map<string, Uint8Array>(); putCalls = 0; readCalls = 0;
  throwAfterPut = false; missingReadback = false; hangPutUntilAbort = false; hangReadUntilAbort = false;
  abortObserved = false;
  waitForRelease = false; private enteredResolve!: () => void; private releaseResolve!: () => void;
  readonly entered = new Promise<void>(resolve => { this.enteredResolve = resolve; });
  private readonly released = new Promise<void>(resolve => { this.releaseResolve = resolve; });
  release() { this.releaseResolve(); }
  private untilAbort(signal?: AbortSignal): Promise<never> {
    return new Promise((_, reject) => {
      const aborted = () => { this.abortObserved = true; reject(new Error("synthetic_storage_aborted")); };
      if (signal?.aborted) aborted(); else signal?.addEventListener("abort", aborted, { once: true });
    });
  }
  async put(input: { artifactId: string; bytes: Uint8Array; signal?: AbortSignal }) {
    input.signal?.throwIfAborted(); this.putCalls++; this.enteredResolve();
    if (this.hangPutUntilAbort) await this.untilAbort(input.signal);
    if (this.waitForRelease) await this.released;
    const bytes = Uint8Array.from(input.bytes);
    this.artifacts.set(input.artifactId, bytes);
    if (this.throwAfterPut) throw new Error("synthetic_ambiguous_put");
    return { artifactId: input.artifactId, opaqueLocator: `memory://codex/${encodeURIComponent(input.artifactId)}`,
      contentHash: resultBytesHash(bytes), sizeBytes: bytes.byteLength };
  }
  async read(artifactId: string, signal?: AbortSignal) {
    signal?.throwIfAborted(); this.readCalls++; if (this.missingReadback) return undefined;
    if (this.hangReadUntilAbort) await this.untilAbort(signal);
    const bytes = this.artifacts.get(artifactId); return bytes ? Uint8Array.from(bytes) : undefined;
  }
}

const exactPackage = () => ({ adapterId: CODEX_APP_SERVER_ADAPTER,
  packageName: CODEX_APP_SERVER_READ_CONTRACT.package, packageVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
  generatedSchemaBundleSha256: CODEX_APP_SERVER_READ_CONTRACT.generatedBundleSha256,
  threadStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.paramsSchemaSha256,
  threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
  turnStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.paramsSchemaSha256,
  turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
  threadReadResponseSchemaSha256: CODEX_APP_SERVER_RESULT_CONTRACT.threadReadResponseSchemaSha256,
  agentMessageSourceSha256: CODEX_APP_SERVER_RESULT_CONTRACT.agentMessageSourceSha256 });
const evidence = <T extends Record<string, unknown>>(material: T) => ({ ...material, evidenceDigest: sha256Digest(material) });

async function prepared(storage = new ControlledStorage()) {
  const prompt = "Return the exact bounded result", instructions = "Use the saved task only";
  const inputDigest = sha256Digest({ prompt, instructions });
  const authority = { projectId: "project:test", allowedExecutor: "executor:codex", allowedOperations: [CODEX_START_OPERATION],
    credentialRefs: ["credential:codex"], filesystemRoots: ["/synthetic/workspace"], networkPolicy: "none" as const,
    allowedNetworkDestinations: [] as string[], effectPolicy: "approval_required" as const, maxRisk: "low" as const,
    maxDurationSeconds: 300, maxConcurrentEffects: 1, expiresAt: at(300_000), digest: sha256Digest("pending") };
  authority.digest = computeAuthorityDigest(authority);
  const f = await nativeTaskFixture({ inputDigest, authority, jobType: CODEX_APP_SERVER_JOB_TYPE,
    requiredCapability: CODEX_APP_SERVER_CAPABILITY });
  await f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Synthetic Codex result')");
  const adapterId = `adapter:manual:${sha256Digest({ tenantId: "tenant:test", workspaceId: "workspace:test" }).slice(7, 39)}`;
  await f.db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,'tenant:test','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapterId]);
  await f.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES('project:test','tenant:test','workspace:test',$2,'project:test','1','Codex result','Synthetic only',
    'planned','manual_project_active','healthy','control_room_native',$1,'{}'::jsonb,$1)`, [at(), adapterId]);
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:test','active',1,$1,$1)`, [at()]);
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true });
  const gate = new CompletionGateStoreV1(f.db, reviewKey, checkpoints, () => at(5000));
  await gate.provisionTenant("tenant:test");
  const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1",
    id: "profile:codex-result", tenantId: "tenant:test", projectId: "project:test", name: "Codex result review",
    targetKind: "document", requiredVerificationScenarioIds: ["scenario:content"], minimumIndependentReviews: 1,
    reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
    verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2,
    automaticLowRiskDisposition: false, createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at(-60_000) };
  await gate.registerProfile(profile);
  const request = await f.canonical.get("tenant:test", "request", "request:test");
  const workflow = await f.canonical.get("tenant:test", "workflow", "workflow:test");
  const currentJob = await f.canonical.get("tenant:test", "job", "job:test");
  const attempt = await f.canonical.get("tenant:test", "attempt", "attempt:test");
  const lease = await f.canonical.get("tenant:test", "lease", "lease:test");
  const node = await f.canonical.get("tenant:test", "node", "node:test");
  assert.ok(request?.kind === "request" && workflow?.kind === "workflow" && currentJob?.kind === "job"
    && attempt?.kind === "attempt" && lease?.kind === "lease" && node?.kind === "node");
  await f.canonical.create({ ...currentJob, id: "job:proposal", jobType: "task.proposal",
    requiredCapability: "control-room.task.proposal.v1", state: "proposed", version: 0,
    updatedAt: currentJob.createdAt });
  const plannedJob = { ...currentJob, state: "proposed" as const, version: 0, updatedAt: currentJob.createdAt };
  const connectorProfileDigest = sha256Digest("profile:codex"), workspaceIntentDigest = sha256Digest("workspace:intent");
  const plan = codexTaskExecutionPlanSchemaV3.parse({ schema: "control-room.task-execution-plan/v3",
    tenantId: "tenant:test", projectId: "project:test", sourceJobId: "job:proposal",
    sourceDigest: sha256Digest("source"), sourceInputDigest: inputDigest, templateDigest: sha256Digest("template"),
    plannedBy: "identity:test", plannedAt: at(-60_000), input: { prompt, instructions }, request, workflow, job: plannedJob,
    acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile), adapter: CODEX_APP_SERVER_ADAPTER,
    connectorProfileDigest, workspaceIntentDigest });
  await f.db.query(`INSERT INTO control_task_execution_plans(tenant_id,project_id,source_job_id,job_id,plan,auth_tag)
    VALUES($1,$2,$3,$4,$5::jsonb,$6)`, [plan.tenantId, plan.projectId, plan.sourceJobId, plan.job.id,
    JSON.stringify(plan), hmacSha256Tag(taskPlanKey, { purpose: "task-execution-plan/v3", plan })]);
  const keyRow = (await f.db.query<{ state: string; valid_from: string | Date; valid_until: string | Date | null }>(
    "SELECT state,valid_from,valid_until FROM control_node_keys WHERE tenant_id=$1 AND node_id=$2 AND id=$3",
    ["tenant:test", "node:test", "key:test"])).rows[0]!;
  const admission = codexCurrentAdmissionSchemaV1.parse({ schema: "control-room.codex-current-admission/v1",
    tenantId: "tenant:test", projectId: "project:test", projectVersion: 1, projectLifecycle: "active",
    jobId: currentJob.id, jobVersion: currentJob.version, jobState: currentJob.state,
    attemptId: attempt.id, attemptVersion: attempt.version, attemptState: attempt.state,
    leaseId: lease.id, leaseVersion: lease.version, leaseEpoch: lease.epoch, leaseState: lease.state,
    leaseExpiresAt: lease.expiresAt, nodeId: node.id, nodeVersion: node.version, nodeState: node.state,
    nodeKeyId: node.identityKeyId, nodeKeyState: keyRow.state, nodeKeyValidFrom: new Date(keyRow.valid_from).toISOString(),
    nodeKeyValidUntil: keyRow.valid_until ? new Date(keyRow.valid_until).toISOString() : null,
    authorityDigest: currentJob.authority.digest, authorityExpiresAt: currentJob.authority.expiresAt,
    approvalKeyId: "approval-key:test", approvalExpiresAt: at(300_000), ownerTrustRevisionDigest: sha256Digest("trust"),
    queueId: "queue:codex", dispatchMessageId: "message:dispatch", dispatchFrameDigest: sha256Digest("dispatch-frame"),
    receiptMessageId: "message:receipt", receiptFrameDigest: sha256Digest("receipt-frame"),
    permitDigest: sha256Digest("permit"), inputDigest, operationDigest: sha256Digest("operation"),
    effectClaimKey: sha256Digest("effect"), enrollmentDigest: sha256Digest("enrollment"), connectorProfileDigest,
    workspaceIntentDigest, configurationExpiresAt: at(300_000), connectionId: "connection:result",
    checkedAt: at(), admissionExpiresAt: at(300_000) });
  const activationMaterial = { schema: "control-room.codex-task-activation/v1" as const,
    tenantId: "tenant:test", projectId: "project:test", nodeId: "node:test", jobId: "job:test",
    attemptId: "attempt:test", runId: "run:codex-result", leaseId: "lease:test", leaseEpoch: lease.epoch,
    queueId: admission.queueId, connectionId: admission.connectionId, dispatchMessageId: admission.dispatchMessageId,
    dispatchFrameDigest: admission.dispatchFrameDigest, dispatchBodyDigest: sha256Digest("dispatch-body"),
    receiptMessageId: admission.receiptMessageId, receiptFrameDigest: admission.receiptFrameDigest,
    receiptBodyDigest: sha256Digest("receipt-body"), permitDigest: admission.permitDigest, inputDigest,
    operationDigest: admission.operationDigest, effectClaimKey: admission.effectClaimKey,
    enrollmentDigest: admission.enrollmentDigest, connectorProfileDigest, workspaceIntentDigest,
    currentAdmissionDigest: sha256Digest(admission), workspacePath: "/synthetic/workspace", prompt, instructions,
    receiptRecordedAt: at(100), receiptReceivedAt: at(200), activatedAt: at(300), activationExpiresAt: at(300_000),
    startsWork: false as const, authorizesExactStart: true as const, grantsExecutionAuthority: false as const,
    permitsRetry: false as const, permitsResume: false as const, permitsThreadRead: false as const };
  const activationDigest = sha256Digest(activationMaterial);
  const activation = { ...activationMaterial, activationId: `codex-activation:${activationDigest.slice(7)}`, activationDigest };
  const serverKeys = generateKeyPairSync("ed25519");
  const frame = signNodeFrame({ protocol: NODE_PROTOCOL_V1, direction: "server_to_node", senderKind: "control_room",
    tenantId: "tenant:test", actorId: "server:test", keyId: "server-key:test", connectionId: admission.connectionId,
    sequence: 10, messageId: "message:activation", correlationId: "correlation:activation",
    causationId: admission.receiptMessageId, nonce: "nonce_codex_activation_result_1234567890",
    sentAt: activation.activatedAt, expiresAt: activation.activationExpiresAt,
    type: "harness.codex.dispatch.activation", body: activation }, serverKeys.privateKey);
  const activationRecord = { schema: "control-room.codex-activation-transmission-intent/v1" as const,
    frame, currentAdmission: admission, dispatchFrameDigest: admission.dispatchFrameDigest,
    receiptFrameDigest: admission.receiptFrameDigest, reservedAt: activation.activatedAt, reservedBy: "server:test" };
  const dummyTag = `hmac-sha256:${"0".repeat(64)}`, dummyRecord = JSON.stringify({ synthetic: true });
  for (const [table] of [["control_native_approval_packets"], ["control_native_task_queue"],
    ["control_codex_delivery_envelopes"], ["control_codex_transmission_intents"], ["control_codex_delivery_receipts"]]) {
    if (table === "control_native_approval_packets" || table === "control_native_task_queue")
      await f.db.query(`INSERT INTO ${table}(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
        ["tenant:test", "project:test", "job:test", "attempt:test", dummyRecord, dummyTag]);
    else if (table === "control_codex_delivery_envelopes")
      await f.db.query(`INSERT INTO ${table}(tenant_id,project_id,job_id,attempt_id,message_id,record,auth_tag) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)`,
        ["tenant:test", "project:test", "job:test", "attempt:test", admission.dispatchMessageId, dummyRecord, dummyTag]);
    else await f.db.query(`INSERT INTO ${table}(tenant_id,project_id,job_id,attempt_id,record,auth_tag) VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
      ["tenant:test", "project:test", "job:test", "attempt:test", dummyRecord, dummyTag]);
  }
  await f.db.query(`INSERT INTO control_codex_activation_transmission_intents
    (tenant_id,project_id,job_id,attempt_id,activation_id,message_id,receipt_frame_digest,record,auth_tag)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`, ["tenant:test", "project:test", "job:test", "attempt:test",
    activation.activationId, frame.messageId, admission.receiptFrameDigest, JSON.stringify(activationRecord),
    hmacSha256Tag(activationKey, { purpose: "codex-activation-transmission-intent/v1", record: activationRecord })]);
  const qualificationKeys = generateKeyPairSync("ed25519");
  const publicKeySpki = qualificationKeys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const start = evidence({ evidenceId: "evidence:start", processAttemptId: "process:start",
    connectionAttemptId: "connection-attempt:start", initializedConnectionDigest: sha256Digest("start-initialized"),
    threadId: "thread:qualification", turnId: "turn:qualification", startObserved: true as const, cleanupVerified: true as const });
  const restartRead = evidence({ evidenceId: "evidence:restart", processAttemptId: "process:restart",
    connectionAttemptId: "connection-attempt:restart", initializedConnectionDigest: sha256Digest("restart-initialized"),
    threadId: "thread:qualification", turnId: "turn:qualification", itemId: "item:qualification",
    restartObserved: true as const, exactReadObserved: true as const, cleanupVerified: true as const });
  const qualificationBody = createCodexPhysicalQualificationReceiptBodyV1({
    schema: "control-room.codex-physical-qualification-receipt/v1", qualificationId: "qualification:synthetic",
    qualificationSignerKeyId: "qualification-key:synthetic", tenantId: "tenant:test", nodeId: "node:test",
    connectorProfileId: "profile:codex:test", connectorProfileDigest, exactPackage: exactPackage(), qualifiedAt: at(-1000),
    start, restartRead, oneFreshProcessPerAttempt: true, sameDurableThreadObserved: true, sameDurableTurnObserved: true,
    terminalCleanupVerified: true, processReuseObserved: false, retryObserved: false,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false });
  const qualificationReceipt = signArtifact(qualificationBody, qualificationKeys.privateKey);
  const text = "Exact synthetic Codex result.";
  const rawResult = JSON.stringify({ thread: { id: "thread:durable", cliVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
    turns: [{ id: "turn:durable", status: "completed", itemsView: "full",
      items: [{ type: "agentMessage", id: "item:final", phase: "final_answer", text }] }] } });
  const observation = projectExactPackageCodexCompletedTurnV1({ threadId: "thread:durable", turnId: "turn:durable", rawResult });
  const binding = { identity: { tenantId: activation.tenantId, projectId: activation.projectId, jobId: activation.jobId,
    attemptId: activation.attemptId, runId: activation.runId, nodeId: activation.nodeId, leaseId: activation.leaseId,
    leaseEpoch: activation.leaseEpoch }, delivery: { activationDigest: activation.activationDigest,
    dispatchBodyDigest: activation.dispatchBodyDigest, receiptBodyDigest: activation.receiptBodyDigest },
    connection: { connectionId: activation.connectionId, connectionAttemptId: "connection-attempt:result",
      initializedConnectionDigest: sha256Digest("result-initialized"), connectorProfileId: "profile:codex:test", connectorProfileDigest },
    result: { threadId: observation.threadId, turnId: observation.turnId, itemId: observation.itemId,
      projectionDigest: observation.projectionDigest, rawResultDigest: observation.rawResultDigest,
      rawTurnDigest: observation.matchedTurnDigest, contentHash: observation.contentHash, contentSizeBytes: observation.sizeBytes },
    physicalQualification: { qualificationId: qualificationBody.qualificationId,
      receiptBodyDigest: qualificationBody.bodyDigest, signerKeyId: qualificationBody.qualificationSignerKeyId } };
  const publication = createCodexResultPublicationContractV1({ activation, observation, observationSource: "stored_thread_read",
    connection: { connectionAttemptId: binding.connection.connectionAttemptId,
      initializedConnectionDigest: binding.connection.initializedConnectionDigest,
      connectorProfileId: binding.connection.connectorProfileId },
    binding, qualificationReceipt, qualificationPublicKeySpki: publicKeySpki });
  const terminalEvidence = projectCodexTerminalResultEvidenceV1({ lineage: {
      tenantId: publication.identity.tenantId, projectId: publication.identity.projectId,
      jobId: publication.identity.jobId, attemptId: publication.identity.attemptId,
      runId: publication.identity.runId, nodeId: publication.identity.nodeId },
    identity: { runId: publication.identity.runId, threadId: publication.result.threadId, turnId: publication.result.turnId },
    completedTurn: observation, qualificationDigest: qualificationBody.bodyDigest, observedAt: at(1000) });
  const qualificationTrust = { expectedQualificationId: qualificationBody.qualificationId,
    expectedBodyDigest: qualificationBody.bodyDigest, expectedSignerKeyId: qualificationBody.qualificationSignerKeyId, publicKeySpki };
  let clockNow = Date.parse(at(2000)), authorityCurrent = true;
  const assertCurrent = () => { if (!authorityCurrent) throw new Error("synthetic_authority_revoked"); };
  const publisher = (db: DatabaseClient = f.db, reviewDatabase: DatabaseClient = f.db,
    options: { now?: () => number; storageIoMs?: number } = {}) => {
    const service = new CodexCanonicalResultPublisherV1(db, { integrityKey: resultKey,
      harnessIntegrityKey: harnessKey, taskPlanIntegrityKey: taskPlanKey, activationIntegrityKey: activationKey,
      reviewIntegrityKey: reviewKey, reviewDatabase, checkpoints, qualificationTrust, storageClass: "local", storage,
      now: options.now ?? (() => clockNow), ...(options.storageIoMs === undefined ? {} : { storageIoMs: options.storageIoMs }) });
    return { capture(input: Omit<Parameters<typeof service.capture>[0], "assertCurrent">) {
      return service.capture({ ...input, assertCurrent });
    } };
  };
  return { f, storage, publisher, publication, terminalEvidence, qualificationReceipt, checkpoints,
    bytes: new TextEncoder().encode(text), qualificationTrust,
    setNow(value: number) { clockNow = value; }, revokeAuthority() { authorityCurrent = false; } };
}

function failOnce(base: DatabaseClient, fragment: string): DatabaseClient {
  let fail = true;
  const intercepted = (tx: DatabaseSession): DatabaseSession => ({ query<T>(sql: string, params?: unknown[]) {
    if (fail && sql.includes(fragment)) { fail = false; throw new Error("synthetic_transaction_failure"); }
    return tx.query<T>(sql, params);
  } });
  return { query: base.query.bind(base), transaction: work => base.transaction(tx => work(intercepted(tx))),
    transactionWithPreCommitCheck: (work, check) => base.transactionWithPreCommitCheck(tx => work(intercepted(tx)), check) };
}

function loseCommitAcknowledgementOnce(base: DatabaseClient,
  match: (sql: string, params: unknown[] | undefined) => boolean): DatabaseClient {
  let lost = false;
  const run = async <T>(operation: () => Promise<T>, matched: { value: boolean }): Promise<T> => {
    const result = await operation();
    if (!lost && matched.value) { lost = true; throw new Error("synthetic_commit_ack_lost"); }
    return result;
  };
  const intercepted = (tx: DatabaseSession, matched: { value: boolean }): DatabaseSession => ({ query<T>(sql: string, params?: unknown[]) {
    if (match(sql, params)) matched.value = true;
    return tx.query<T>(sql, params);
  } });
  return {
    query: base.query.bind(base),
    transaction<T>(work: (session: DatabaseSession) => Promise<T>) {
      const matched = { value: false };
      return run(() => base.transaction(tx => work(intercepted(tx, matched))), matched);
    },
    transactionWithPreCommitCheck<T>(work: (session: DatabaseSession) => Promise<T>, check: () => void | Promise<void>) {
      const matched = { value: false };
      return run(() => base.transactionWithPreCommitCheck(tx => work(intercepted(tx, matched)), check), matched);
    },
  };
}

function beforePreCommit(base: DatabaseClient, before: () => void): DatabaseClient {
  return {
    query: base.query.bind(base), transaction: base.transaction.bind(base),
    transactionWithPreCommitCheck: (work, check) => base.transactionWithPreCommitCheck(work, async () => {
      before(); await check();
    }),
  };
}

async function restrictedPublisherDatabases(x: Awaited<ReturnType<typeof prepared>>) {
  await x.f.raw.exec(await readFile("db/roles/native_evidence_roles.sql", "utf8"));
  await x.f.raw.exec(await readFile("db/roles/native_results_roles.sql", "utf8"));
  await x.f.raw.exec(`CREATE ROLE codex_evidence_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    CREATE ROLE codex_review_test LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
    GRANT control_room_native_evidence TO codex_evidence_test;
    GRANT control_room_native_results TO codex_review_test`);
  const pool = (login: "codex_evidence_test" | "codex_review_test"): DatabaseClient => {
    const db: DatabaseClient = {
      query: (sql, params) => db.transaction(tx => tx.query(sql, params)),
      transaction: work => db.transactionWithPreCommitCheck(work, () => {}),
      transactionWithPreCommitCheck: (work, check) => x.f.db.transactionWithPreCommitCheck(async tx => {
        await tx.query(`SET LOCAL SESSION AUTHORIZATION ${login}`);
        return work({ async query<T>(sql: string, params?: unknown[]) {
          try { return await tx.query<T>(sql, params); }
          catch (error) { throw new Error(`${login}:${sql.trim().split(/\s+/).slice(0, 8).join(" ")}`, { cause: error }); }
        } });
      }, check),
    };
    return db;
  };
  return { evidence: pool("codex_evidence_test"), review: pool("codex_review_test") };
}

test("persists one exact synthetic Codex result and review target without claiming completion", async t => {
  const x = await prepared(); t.after(x.f.close);
  const first = await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  assert.equal(first.replayed, false); assert.equal(first.receipt.completionVerified, false);
  assert.equal(first.receipt.releasesCapacity, false); assert.equal(first.target.subjectDigest, first.receipt.contentHash);
  assert.equal(x.storage.putCalls, 1);
  const inspected = await x.f.runs.inspect("tenant:test", x.publication.identity.runId);
  assert.equal(inspected?.run.harness, "codex"); assert.equal(inspected?.run.state, "discovered");
  assert.equal(inspected?.run.resumable, false); assert.equal(inspected?.run.startedAt, undefined);
  assert.equal(inspected?.run.finishedAt, undefined); assert.deepEqual(inspected?.events, []);
  const [job, attempt, lease] = await Promise.all([x.f.canonical.get("tenant:test", "job", "job:test"),
    x.f.canonical.get("tenant:test", "attempt", "attempt:test"), x.f.canonical.get("tenant:test", "lease", "lease:test")]);
  assert.equal(job?.state, "leased"); assert.equal(attempt?.state, "leased"); assert.equal(lease?.state, "active");
  const replay = await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt); assert.equal(x.storage.putCalls, 1);
  const racingReplays = await Promise.all([x.publisher().capture({ publication: x.publication,
    terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes }), x.publisher().capture({ publication: x.publication,
    terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes })]);
  assert.deepEqual(racingReplays.map(value => value.replayed), [true, true]);
  assert.equal(x.storage.putCalls, 1);
  assert.equal((await x.f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_codex_result_publications")).rows[0]?.count, "1");
  assert.equal((await x.f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_completion_gate_records WHERE kind='target'")).rows[0]?.count, "1");
});

async function ownerReview(x: Awaited<ReturnType<typeof prepared>>, clockOffset = 6000) {
  await new SecurityStore(x.f.db).bootstrapOwner({ tenantId: "tenant:test", provider: trust.issuer, subject: "test-owner",
    identityId: "identity:test", grantId: "grant:test", displayName: "Synthetic owner",
    verifiedAt: at(-60_000), expiresAt: at(600_000), now: at() });
  const jwt = token({ iat: Date.parse(at()) / 1000 - 60, exp: Date.parse(at()) / 1000 + 600 });
  const identity = createAccessVerifier({ ...trust, validUntilMs: Date.parse(at()) + 3_600_000 })(
    webRequest(undefined, undefined, undefined, undefined, jwt), Date.parse(at(clockOffset)));
  const resultConfig = { integrityKey: resultKey, storageClass: "local" as const, storage: x.storage };
  const reviewConfig = { integrityKey: reviewKey, checkpoints: x.checkpoints,
    harnessIntegrityKey: harnessKey, results: resultConfig };
  return { identity, resultConfig, reviewConfig,
    tasks: new WebTaskService(x.f.db, { tenantId: "tenant:test", workspaceId: "workspace:test" },
      () => Date.parse(at(clockOffset)), { harnessIntegrityKey: harnessKey, results: resultConfig,
        reviews: { integrityKey: reviewKey, checkpoints: x.checkpoints },
        ownerReviews: { integrityKey: reviewKey, checkpoints: x.checkpoints } }),
    reviews: new WebTaskReviewService(x.f.db, { tenantId: "tenant:test", workspaceId: "workspace:test" },
      reviewConfig, () => Date.parse(at(clockOffset))) };
}

test("the existing owner review and result page accept an authenticated Codex target across restart", async t => {
  const x = await prepared(); t.after(x.f.close);
  const saved = await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  const first = await ownerReview(x);
  const page = await first.tasks.results(first.identity, "project:test", "job:test");
  if (!("items" in page)) assert.fail("expected result page");
  assert.equal(page.items.length, 1); assert.equal(page.items[0]?.artifactId, saved.receipt.artifactId);
  assert.equal(page.reviews.length, 1); assert.equal(page.reviews[0]?.targetId, saved.target.id);
  assert.deepEqual(page.reviews[0]?.matchingArtifactIds, [saved.receipt.artifactId]);
  const content = await first.tasks.results(first.identity, "project:test", "job:test", saved.receipt.artifactId);
  if (!("text" in content)) assert.fail("expected result content");
  assert.equal(content.text, "Exact synthetic Codex result.");

  // Reconstruct the services to model an application restart; no in-memory receipt is reused.
  const restartedTasks = new WebTaskService(x.f.db, { tenantId: "tenant:test", workspaceId: "workspace:test" },
    () => Date.parse(at(7000)), { harnessIntegrityKey: harnessKey, results: first.resultConfig,
      reviews: { integrityKey: reviewKey, checkpoints: x.checkpoints },
      ownerReviews: { integrityKey: reviewKey, checkpoints: x.checkpoints } });
  const restartedPage = await restartedTasks.results(first.identity, "project:test", "job:test");
  if (!("reviews" in restartedPage)) assert.fail("expected restarted result page");
  assert.equal(restartedPage.reviews[0]?.targetId, saved.target.id);

  const draft = { artifactId: saved.receipt.artifactId, targetId: saved.target.id, targetDigest: sha256Digest(saved.target),
    contentHash: saved.receipt.contentHash, decision: "accepted" as const, feedback: "" };
  const recorded = await first.reviews.record(first.identity, "project:test", "job:test", draft, "codex-owner-review-accepted");
  assert.equal(recorded.replayed, false);
  const snapshot = await new CompletionGateStoreV1(x.f.db, reviewKey, x.checkpoints).snapshot("tenant:test", saved.target.id);
  assert.equal(snapshot.status, "pending");
  assert.deepEqual(snapshot.missingVerificationScenarioIds, ["scenario:content"]);
});

test("Codex owner review preserves changes requested, lost acknowledgement, and tamper refusal", async t => {
  const x = await prepared(); t.after(x.f.close);
  const saved = await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  const owner = await ownerReview(x);
  const draft = { artifactId: saved.receipt.artifactId, targetId: saved.target.id, targetDigest: sha256Digest(saved.target),
    contentHash: saved.receipt.contentHash, decision: "changes_requested" as const, feedback: "Add the missing acceptance detail." };
  const uncertain = new WebTaskReviewService(loseCommitAcknowledgementOnce(x.f.db,
    sql => sql.includes("INSERT INTO control_web_task_review_commands")),
    { tenantId: "tenant:test", workspaceId: "workspace:test" }, owner.reviewConfig, () => Date.parse(at(6000)));
  await assert.rejects(() => uncertain.record(owner.identity, "project:test", "job:test", draft,
    "codex-owner-review-changes"), /synthetic_commit_ack_lost/);
  const replay = await owner.reviews.record(owner.identity, "project:test", "job:test", draft, "codex-owner-review-changes");
  assert.equal(replay.replayed, true); assert.equal(replay.receipt.decision, "changes_requested");
  assert.equal((await new CompletionGateStoreV1(x.f.db, reviewKey, x.checkpoints)
    .snapshot("tenant:test", saved.target.id)).status, "changes_requested");

  await x.f.raw.exec(`ALTER TABLE control_native_review_plans DISABLE TRIGGER control_native_review_plans_immutable;
    UPDATE control_native_review_plans SET auth_tag='hmac-sha256:${"0".repeat(64)}';
    ALTER TABLE control_native_review_plans ENABLE TRIGGER control_native_review_plans_immutable;`);
  await assert.rejects(() => owner.reviews.options(owner.identity, "project:test", "job:test",
    saved.receipt.artifactId, saved.target.id), /codex_review_plan_unavailable/);
});

test("a Codex change request produces one inert authenticated Codex revision plan", async t => {
  const x = await prepared(); t.after(x.f.close);
  const saved = await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  const owner = await ownerReview(x);
  const feedback = "Add the missing acceptance detail.";
  const reviewed = await owner.reviews.record(owner.identity, "project:test", "job:test", {
    artifactId: saved.receipt.artifactId, targetId: saved.target.id, targetDigest: sha256Digest(saved.target),
    contentHash: saved.receipt.contentHash, decision: "changes_requested", feedback }, "codex-revision-plan");
  const currentJob = await x.f.canonical.get("tenant:test", "job", "job:test");
  assert.ok(currentJob?.kind === "job");
  const revisionAuthority = { ...currentJob.authority, expiresAt: at(600_000), digest: sha256Digest("pending") };
  revisionAuthority.digest = computeAuthorityDigest(revisionAuthority);
  const template = { id: "template:codex-revision", adapter: CODEX_APP_SERVER_ADAPTER,
    instructions: "Use the saved task only", authority: revisionAuthority,
    acceptanceProfileId: saved.target.acceptanceProfileId, acceptanceProfileDigest: saved.target.acceptanceProfileDigest,
    connectorProfileDigest: x.publication.connection.connectorProfileDigest,
    workspaceIntentDigest: sha256Digest("workspace:intent") } as const;
  const inspection = codexInspection(x);
  const planner = new TaskExecutionPlanner(x.f.db, { tenantId: "tenant:test", workspaceId: "workspace:test" },
    { template, integrityKey: taskPlanKey, reviewIntegrityKey: reviewKey, checkpoints: x.checkpoints },
    () => Date.parse(at(8000)), undefined, inspection.source);
  const request = { runId: saved.receipt.runId, targetId: saved.target.id, targetDigest: sha256Digest(saved.target),
    contentHash: saved.receipt.contentHash, reviewId: reviewed.receipt.reviewId, feedback };
  const first = await planner.revise(owner.identity, "project:test", "job:test", request, new AbortController().signal);
  assert.equal(first.replayed, false); assert.equal(first.receipt.startsWork, false);
  const plan = await planner.read(first.receipt.jobId);
  assert.equal(plan?.schema, "control-room.task-execution-plan/v4");
  if (plan?.schema !== "control-room.task-execution-plan/v4") assert.fail("missing Codex revision plan");
  assert.equal(plan.revision.fromRunId, saved.receipt.runId);
  assert.equal(plan.revision.reviewId, reviewed.receipt.reviewId);
  assert.equal(plan.job.jobType, CODEX_APP_SERVER_JOB_TYPE);
  assert.equal(plan.job.state, "proposed");
  const replay = await planner.revise(owner.identity, "project:test", "job:test", request, new AbortController().signal);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, first.receipt);
});

function codexInspection(x: Awaited<ReturnType<typeof prepared>>) {
  const results = { integrityKey: resultKey, storageClass: "local" as const, storage: x.storage };
  const configuration = { integrityKey: reviewKey, harnessIntegrityKey: harnessKey, checkpoints: x.checkpoints, results };
  const source = new CodexResultInspectionServiceV1(x.f.db, { ...configuration, integrityKey: resultKey,
    taskPlanIntegrityKey: taskPlanKey, activationIntegrityKey: activationKey, reviewIntegrityKey: reviewKey });
  return { configuration, source };
}

test("Codex changes requested releases only capacity and accepted verified work completes exactly once", async t => {
  const changed = await prepared(); t.after(changed.f.close);
  const changedSaved = await changed.publisher().capture({ publication: changed.publication,
    terminalEvidence: changed.terminalEvidence, qualificationReceipt: changed.qualificationReceipt, bytes: changed.bytes });
  const changedOwner = await ownerReview(changed);
  await changedOwner.reviews.record(changedOwner.identity, "project:test", "job:test", {
    artifactId: changedSaved.receipt.artifactId, targetId: changedSaved.target.id,
    targetDigest: sha256Digest(changedSaved.target), contentHash: changedSaved.receipt.contentHash,
    decision: "changes_requested", feedback: "Add the missing acceptance detail." }, "codex-capacity-changes");
  const changedInspection = codexInspection(changed);
  const request = { tenantId: "tenant:test", runId: changedSaved.receipt.runId,
    targetDigest: sha256Digest(changedSaved.target), contentHash: changedSaved.receipt.contentHash };
  const changedLifecycle = new NativeTaskCompletionService(changed.f.db, changedInspection.configuration,
    () => Date.parse(at(8000)), changedInspection.source);
  const released = await changedLifecycle.releaseCapacity(request, () => {});
  assert.equal(released.replayed, false); assert.equal(released.receipt.qualityAccepted, false);
  const [changedJob, changedAttempt, changedLease] = await Promise.all([
    changed.f.canonical.get("tenant:test", "job", "job:test"), changed.f.canonical.get("tenant:test", "attempt", "attempt:test"),
    changed.f.canonical.get("tenant:test", "lease", "lease:test")]);
  assert.equal(changedJob?.state, "leased"); assert.equal(changedAttempt?.state, "leased"); assert.equal(changedLease?.state, "released");
  assert.equal((await new NativeTaskCompletionService(changed.f.db, changedInspection.configuration,
    () => Date.parse(at(9000)), new CodexResultInspectionServiceV1(changed.f.db, {
      integrityKey: resultKey, harnessIntegrityKey: harnessKey, taskPlanIntegrityKey: taskPlanKey,
      activationIntegrityKey: activationKey, reviewIntegrityKey: reviewKey, checkpoints: changed.checkpoints,
      results: changedInspection.configuration.results })).releaseCapacity(request, () => {})).replayed, true);

  const accepted = await prepared(); t.after(accepted.f.close);
  const acceptedSaved = await accepted.publisher().capture({ publication: accepted.publication,
    terminalEvidence: accepted.terminalEvidence, qualificationReceipt: accepted.qualificationReceipt, bytes: accepted.bytes });
  const acceptedOwner = await ownerReview(accepted);
  await acceptedOwner.reviews.record(acceptedOwner.identity, "project:test", "job:test", {
    artifactId: acceptedSaved.receipt.artifactId, targetId: acceptedSaved.target.id,
    targetDigest: sha256Digest(acceptedSaved.target), contentHash: acceptedSaved.receipt.contentHash,
    decision: "accepted", feedback: "" }, "codex-completion-accepted");
  const gate = new CompletionGateStoreV1(accepted.f.db, reviewKey, accepted.checkpoints, () => at(7000));
  await gate.recordVerification({ schemaVersion: "control-room-completion-gate/v1", id: "verification:codex-content",
    tenantId: "tenant:test", projectId: "project:test", targetId: acceptedSaved.target.id,
    targetDigest: sha256Digest(acceptedSaved.target), acceptanceProfileId: "profile:codex-result",
    acceptanceProfileDigest: acceptedSaved.target.acceptanceProfileDigest, scenarioId: "scenario:content", outcome: "passed",
    verifier: { actorId: "service:codex-content-verifier", actorType: "service" }, evidenceDigests: [acceptedSaved.receipt.contentHash],
    verifiedAt: at(7000), grantsApproval: false, grantsExecutionAuthority: false });
  assert.equal((await gate.snapshot("tenant:test", acceptedSaved.target.id)).status, "ready");
  const acceptedInspection = codexInspection(accepted), acceptedRequest = { tenantId: "tenant:test",
    runId: acceptedSaved.receipt.runId, targetDigest: sha256Digest(acceptedSaved.target), contentHash: acceptedSaved.receipt.contentHash };
  const completed = await new NativeTaskCompletionService(accepted.f.db, acceptedInspection.configuration,
    () => Date.parse(at(8000)), acceptedInspection.source).complete(acceptedRequest, () => {});
  assert.equal(completed.replayed, false);
  const [job, attempt, lease] = await Promise.all([accepted.f.canonical.get("tenant:test", "job", "job:test"),
    accepted.f.canonical.get("tenant:test", "attempt", "attempt:test"), accepted.f.canonical.get("tenant:test", "lease", "lease:test")]);
  assert.equal(job?.state, "succeeded"); assert.equal(attempt?.state, "succeeded"); assert.equal(lease?.state, "released");
  const replay = await new NativeTaskCompletionService(accepted.f.db, acceptedInspection.configuration,
    () => Date.parse(at(9000)), acceptedInspection.source).complete(acceptedRequest, () => {});
  assert.equal(replay.replayed, true); assert.deepEqual(replay.receipt, completed.receipt);
});

test("Codex completion refuses a current job whose authority no longer matches its authenticated plan", async t => {
  const x = await prepared(); t.after(x.f.close);
  const saved = await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  const current = await x.f.canonical.get("tenant:test", "job", "job:test");
  assert.ok(current?.kind === "job");
  const authority = { ...current.authority, expiresAt: at(600_000), digest: sha256Digest("pending") };
  authority.digest = computeAuthorityDigest(authority);
  const tampered = { ...current, authority };
  await x.f.db.query("UPDATE control_jobs SET payload=$1::jsonb,authority_digest=$2 WHERE tenant_id=$3 AND id=$4",
    [JSON.stringify(tampered), authority.digest, "tenant:test", "job:test"]);
  const inspection = codexInspection(x), request = { tenantId: "tenant:test", runId: saved.receipt.runId,
    targetDigest: sha256Digest(saved.target), contentHash: saved.receipt.contentHash };
  await assert.rejects(() => new NativeTaskCompletionService(x.f.db, inspection.configuration,
    () => Date.parse(at(8000)), inspection.source).releaseCapacity(request, () => {}),
  /codex_result_inspection_unavailable/);
  assert.equal((await x.f.canonical.get("tenant:test", "lease", "lease:test"))?.state, "active");
});

test("persists through separate least-privilege evidence and review database roles", async t => {
  const x = await prepared(); t.after(x.f.close);
  const db = await restrictedPublisherDatabases(x);
  const privileges = await x.f.db.query<{ evidence_select: boolean; evidence_insert: boolean; review_select: boolean }>(`SELECT
    has_table_privilege('codex_evidence_test','control_codex_result_publications','SELECT') AS evidence_select,
    has_table_privilege('codex_evidence_test','control_codex_result_publications','INSERT') AS evidence_insert,
    has_table_privilege('codex_review_test','control_codex_result_publications','SELECT') AS review_select`);
  assert.deepEqual(privileges.rows[0], { evidence_select: true, evidence_insert: true, review_select: true });
  const saved = await x.publisher(db.evidence, db.review).capture({ publication: x.publication,
    terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes });
  assert.equal(saved.replayed, false);
  assert.equal(saved.receipt.completionVerified, false);
  assert.equal(saved.target.subjectDigest, saved.receipt.contentHash);
  assert.equal(x.storage.putCalls, 1);
});

test("rejects untrusted synthetic qualification before reservation or storage", async t => {
  const x = await prepared(); t.after(x.f.close);
  const other = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const publisher = new CodexCanonicalResultPublisherV1(x.f.db, { integrityKey: resultKey, harnessIntegrityKey: harnessKey,
    taskPlanIntegrityKey: taskPlanKey, activationIntegrityKey: activationKey, reviewIntegrityKey: reviewKey,
    reviewDatabase: x.f.db,
    checkpoints: new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), qualificationTrust: { ...x.qualificationTrust,
      publicKeySpki: other }, storageClass: "local", storage: x.storage, now: () => Date.parse(at(2000)) });
  await assert.rejects(() => publisher.capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes, assertCurrent: () => {} }),
  /codex_canonical_result_record_unavailable/);
  assert.equal(x.storage.putCalls, 0);
  assert.equal((await x.f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_native_result_write_reservations")).rows[0]?.count, "0");
});

test("rechecks the current canonical admission before reserving or storing", async t => {
  const x = await prepared(); t.after(x.f.close);
  await x.f.db.query("UPDATE control_node_keys SET state='revoked',revoked_at=$1 WHERE tenant_id='tenant:test' AND id='key:test'", [at(1500)]);
  await assert.rejects(() => x.publisher().capture({ publication: x.publication,
    terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes }), /codex_activation_transmission_intent_unavailable/);
  assert.equal(x.storage.putCalls, 0);
  assert.equal((await x.f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_native_result_write_reservations")).rows[0]?.count, "0");
});

test("trusted clock rejects caller backdating and fences expiry before reservation commit", async t => {
  const expired = await prepared(); t.after(expired.f.close);
  expired.setNow(Date.parse(at(300_000)));
  const backdated = { publication: expired.publication, terminalEvidence: expired.terminalEvidence,
    qualificationReceipt: expired.qualificationReceipt, bytes: expired.bytes, receivedAt: at(2000) };
  await assert.rejects(() => expired.publisher().capture(backdated), /codex_canonical_result_unavailable/);
  assert.equal(expired.storage.putCalls, 0);
  assert.equal((await expired.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_native_result_write_reservations")).rows[0]?.count, "0");

  const fenced = await prepared(); t.after(fenced.f.close);
  const deadline = Date.parse(at(300_000));
  const ticks = [Date.parse(at(2000)), deadline - 1, deadline];
  const publisher = fenced.publisher(fenced.f.db, fenced.f.db, { now: () => ticks.shift() ?? deadline });
  await assert.rejects(() => publisher.capture({ publication: fenced.publication, terminalEvidence: fenced.terminalEvidence,
    qualificationReceipt: fenced.qualificationReceipt, bytes: fenced.bytes }), /codex_canonical_result_unavailable/);
  assert.equal(fenced.storage.putCalls, 0);
  assert.equal((await fenced.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_native_result_write_reservations")).rows[0]?.count, "0");
});

test("trusted expiry at the review precommit boundary rolls back target, audit, and checkpoint", async t => {
  const x = await prepared(); t.after(x.f.close);
  const checkpointBefore = x.checkpoints.read("tenant:test");
  const deadline = Date.parse(at(300_000));
  const reviewDb = beforePreCommit(x.f.db, () => x.setNow(deadline));
  await assert.rejects(() => x.publisher(x.f.db, reviewDb).capture({ publication: x.publication,
    terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes }), /codex_canonical_result_unavailable/);
  assert.equal((await x.f.db.query<{ state: string }>(
    "SELECT state FROM control_native_result_write_reservations")).rows[0]?.state, "metadata_committed");
  assert.equal((await x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_native_review_plans")).rows[0]?.count, "0");
  assert.equal((await x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_completion_gate_records WHERE kind='target'")).rows[0]?.count, "0");
  assert.equal((await x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_events WHERE action='task.result.submitted_for_review'")).rows[0]?.count, "0");
  assert.deepEqual(x.checkpoints.read("tenant:test"), checkpointBefore);
});

test("authority revocation at the review precommit boundary rolls back the submission", async t => {
  const x = await prepared(); t.after(x.f.close);
  const checkpointBefore = x.checkpoints.read("tenant:test");
  const reviewDb = beforePreCommit(x.f.db, x.revokeAuthority);
  await assert.rejects(() => x.publisher(x.f.db, reviewDb).capture({ publication: x.publication,
    terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes }), /synthetic_authority_revoked/);
  assert.equal((await x.f.db.query<{ state: string }>(
    "SELECT state FROM control_native_result_write_reservations")).rows[0]?.state, "metadata_committed");
  assert.equal((await x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_native_review_plans")).rows[0]?.count, "0");
  assert.equal((await x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_completion_gate_records WHERE kind='target'")).rows[0]?.count, "0");
  assert.equal((await x.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM audit_events WHERE action='task.result.submitted_for_review'")).rows[0]?.count, "0");
  assert.deepEqual(x.checkpoints.read("tenant:test"), checkpointBefore);
});

test("an ambiguous Codex artifact write becomes terminal uncertainty and is never retried", async t => {
  const storage = new ControlledStorage(); storage.throwAfterPut = true;
  const x = await prepared(storage); t.after(x.f.close);
  await assert.rejects(() => x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes }), /codex_result_storage_uncertain/);
  assert.equal(storage.putCalls, 1);
  const state = (await x.f.db.query<{ state: string }>("SELECT state FROM control_native_result_write_reservations")).rows[0]?.state;
  assert.equal(state, "storage_uncertain");
  await assert.rejects(() => x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes }), /codex_result_manual_reconciliation_required/);
  assert.equal(storage.putCalls, 1);
});

test("a racing replay cannot produce a second Codex artifact write", async t => {
  const storage = new ControlledStorage(); storage.waitForRelease = true;
  const x = await prepared(storage); t.after(x.f.close);
  const first = x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  await storage.entered;
  await assert.rejects(() => x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes }),
  /codex_result_manual_reconciliation_required/);
  assert.equal(storage.putCalls, 1); storage.release(); await first; assert.equal(storage.putCalls, 1);
});

test("a metadata crash leaves verified bytes for manual reconciliation without a second write", async t => {
  const x = await prepared(); t.after(x.f.close);
  await assert.rejects(() => x.publisher(failOnce(x.f.db, "INSERT INTO control_artifact_manifests")).capture({
    publication: x.publication, terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes }), /synthetic_transaction_failure/);
  assert.equal((await x.f.db.query<{ state: string }>("SELECT state FROM control_native_result_write_reservations")).rows[0]?.state,
    "bytes_verified");
  await assert.rejects(() => x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes }),
  /codex_result_manual_reconciliation_required/);
  assert.equal(x.storage.putCalls, 1);
});

test("a post-metadata review failure replays only the deterministic target", async t => {
  const x = await prepared(); t.after(x.f.close);
  await assert.rejects(() => x.publisher(x.f.db, failOnce(x.f.db, "INSERT INTO control_completion_gate_records")).capture({
    publication: x.publication, terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
    bytes: x.bytes }), /synthetic_transaction_failure/);
  assert.equal((await x.f.db.query<{ state: string }>("SELECT state FROM control_native_result_write_reservations")).rows[0]?.state,
    "metadata_committed");
  assert.equal(x.storage.putCalls, 1);
  const replay = await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  assert.equal(replay.replayed, true); assert.equal(x.storage.putCalls, 1);
  assert.equal((await x.f.db.query<{ count: string }>("SELECT count(*)::text AS count FROM control_completion_gate_records WHERE kind='target'")).rows[0]?.count, "1");
});

test("database commit acknowledgement loss is fail-closed at every persistence boundary", async t => {
  const reservation = await prepared(); t.after(reservation.f.close);
  const reservationDb = loseCommitAcknowledgementOnce(reservation.f.db,
    sql => sql.includes("INSERT INTO control_native_result_write_reservations"));
  await assert.rejects(() => reservation.publisher(reservationDb).capture({ publication: reservation.publication,
    terminalEvidence: reservation.terminalEvidence, qualificationReceipt: reservation.qualificationReceipt,
    bytes: reservation.bytes }), /synthetic_commit_ack_lost/);
  assert.equal(reservation.storage.putCalls, 0);
  assert.equal((await reservation.f.db.query<{ state: string }>(
    "SELECT state FROM control_native_result_write_reservations")).rows[0]?.state, "reserved");
  await assert.rejects(() => reservation.publisher().capture({ publication: reservation.publication,
    terminalEvidence: reservation.terminalEvidence, qualificationReceipt: reservation.qualificationReceipt,
    bytes: reservation.bytes }), /codex_result_manual_reconciliation_required/);
  assert.equal(reservation.storage.putCalls, 0);

  const verification = await prepared(); t.after(verification.f.close);
  const verificationDb = loseCommitAcknowledgementOnce(verification.f.db,
    (sql, params) => sql.includes("UPDATE control_native_result_write_reservations") && params?.[0] === "bytes_verified");
  await assert.rejects(() => verification.publisher(verificationDb).capture({ publication: verification.publication,
    terminalEvidence: verification.terminalEvidence, qualificationReceipt: verification.qualificationReceipt,
    bytes: verification.bytes }), /codex_result_storage_uncertain/);
  assert.equal(verification.storage.putCalls, 1);
  assert.equal((await verification.f.db.query<{ state: string }>(
    "SELECT state FROM control_native_result_write_reservations")).rows[0]?.state, "storage_uncertain");

  const metadata = await prepared(); t.after(metadata.f.close);
  const metadataDb = loseCommitAcknowledgementOnce(metadata.f.db,
    (sql, params) => sql.includes("UPDATE control_native_result_write_reservations") && params?.[0] === "metadata_committed");
  await assert.rejects(() => metadata.publisher(metadataDb).capture({ publication: metadata.publication,
    terminalEvidence: metadata.terminalEvidence, qualificationReceipt: metadata.qualificationReceipt,
    bytes: metadata.bytes }), /synthetic_commit_ack_lost/);
  assert.equal(metadata.storage.putCalls, 1);
  assert.equal((await metadata.f.db.query<{ state: string }>(
    "SELECT state FROM control_native_result_write_reservations")).rows[0]?.state, "metadata_committed");
  assert.equal((await metadata.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_completion_gate_records WHERE kind='target'")).rows[0]?.count, "0");
  assert.equal((await metadata.publisher().capture({ publication: metadata.publication,
    terminalEvidence: metadata.terminalEvidence, qualificationReceipt: metadata.qualificationReceipt,
    bytes: metadata.bytes })).replayed, true);

  const review = await prepared(); t.after(review.f.close);
  const reviewDb = loseCommitAcknowledgementOnce(review.f.db,
    sql => sql.includes("INSERT INTO control_completion_gate_records"));
  await assert.rejects(() => review.publisher(review.f.db, reviewDb).capture({ publication: review.publication,
    terminalEvidence: review.terminalEvidence, qualificationReceipt: review.qualificationReceipt,
    bytes: review.bytes }), /synthetic_commit_ack_lost/);
  assert.equal(review.storage.putCalls, 1);
  assert.equal((await review.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_completion_gate_records WHERE kind='target'")).rows[0]?.count, "1");
  assert.equal((await review.publisher().capture({ publication: review.publication,
    terminalEvidence: review.terminalEvidence, qualificationReceipt: review.qualificationReceipt,
    bytes: review.bytes })).replayed, true);
  assert.equal((await review.f.db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM control_completion_gate_records WHERE kind='target'")).rows[0]?.count, "1");
});

test("persisted authentication-tag tampering is rejected before replay", async t => {
  const x = await prepared(); t.after(x.f.close);
  await x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes });
  await x.f.raw.exec(`ALTER TABLE control_codex_result_publications DISABLE TRIGGER control_codex_result_publications_immutable;
    UPDATE control_codex_result_publications SET auth_tag='hmac-sha256:${"0".repeat(64)}';
    ALTER TABLE control_codex_result_publications ENABLE TRIGGER control_codex_result_publications_immutable;`);
  await assert.rejects(() => x.publisher().capture({ publication: x.publication, terminalEvidence: x.terminalEvidence,
    qualificationReceipt: x.qualificationReceipt, bytes: x.bytes }), /codex_canonical_result_unavailable/);
  assert.equal(x.storage.putCalls, 1);
});

test("bounded storage timeout aborts the port and records terminal uncertainty", async t => {
  for (const stage of ["put", "read"] as const) {
    const storage = new ControlledStorage();
    if (stage === "put") storage.hangPutUntilAbort = true; else storage.hangReadUntilAbort = true;
    const x = await prepared(storage); t.after(x.f.close);
    await assert.rejects(() => x.publisher(x.f.db, x.f.db, { storageIoMs: 5 }).capture({ publication: x.publication,
      terminalEvidence: x.terminalEvidence, qualificationReceipt: x.qualificationReceipt,
      bytes: x.bytes }), /codex_result_storage_uncertain/);
    assert.equal(storage.abortObserved, true);
    assert.equal(storage.putCalls, 1);
    assert.equal((await x.f.db.query<{ state: string }>(
      "SELECT state FROM control_native_result_write_reservations")).rows[0]?.state, "storage_uncertain");
  }
});

test("operator role scripts upgrade existing roles and retain least-privilege grants", async t => {
  const x = await prepared(); t.after(x.f.close);
  await x.f.raw.exec(`CREATE ROLE control_room_native_evidence NOLOGIN;
    CREATE ROLE control_room_native_results NOLOGIN`);
  const evidenceSql = await readFile("db/roles/native_evidence_roles.sql", "utf8");
  const resultsSql = await readFile("db/roles/native_results_roles.sql", "utf8");
  await x.f.raw.exec(evidenceSql); await x.f.raw.exec(resultsSql);
  await x.f.raw.exec(evidenceSql); await x.f.raw.exec(resultsSql);
  const grants = await x.f.db.query<{ evidence_insert: boolean; evidence_update: boolean; review_select: boolean }>(`SELECT
    has_table_privilege('control_room_native_evidence','control_codex_result_publications','INSERT') AS evidence_insert,
    has_column_privilege('control_room_native_evidence','control_native_result_write_reservations','state','UPDATE') AS evidence_update,
    has_table_privilege('control_room_native_results','control_codex_result_publications','SELECT') AS review_select`);
  assert.deepEqual(grants.rows[0], { evidence_insert: true, evidence_update: true, review_select: true });
});

test("test qualification evidence is explicitly synthetic and grants no physical-qualification claim", async t => {
  const x = await prepared(); t.after(x.f.close);
  assert.equal(x.qualificationReceipt.body.qualificationId, "qualification:synthetic");
  assert.equal(x.qualificationReceipt.body.canonicalPublicationAllowed, false);
  assert.equal(x.qualificationReceipt.body.completionVerified, false);
  assert.equal(x.terminalEvidence.canonicalPublicationAllowed, false);
});
