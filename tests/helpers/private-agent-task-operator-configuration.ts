import { generateKeyPairSync } from "node:crypto";
import { HERMES_NATIVE_ADAPTER, HERMES_NATIVE_REVISION } from "../../src/harness/v1/native-run-contracts";
import { CODEX_APP_SERVER_CAPABILITY, CODEX_APP_SERVER_ADAPTER, CODEX_DELIVERY_FEATURE } from "../../src/harness/codex-v1/delivery-contract";
import { CODEX_RESULT_RETURN_FEATURE_V1 } from "../../src/harness/codex-v1/result-return";
import { createCodexPhysicalQualificationReceiptBodyV1 } from "../../src/harness/codex-v1/result-publication-contract";
import {
  CODEX_APP_SERVER_READ_CONTRACT, CODEX_APP_SERVER_RESULT_CONTRACT,
  CODEX_APP_SERVER_START_CONTRACT,
} from "../../src/harness/codex-v1/schema-contract";
import { NATIVE_DELIVERY_FEATURE } from "../../src/harness/v1/native-delivery";
import { signArtifact } from "../../src/node-policy/v1/crypto";
import { computeAuthorityDigest, sha256Digest } from "../../src/security";
import { privateArtifactStorageNamespaceDigestV1 } from "../../src/web/v1/private-artifact-storage";
import type {
  AgentTaskOperatorSettingsV1, AgentTaskOperatorTrustedInputs,
} from "../../src/web/v1/private-agent-task-operator-configuration";
import type { ManagedNativeSessionSettings } from "../../src/web/v1/managed-native-sessions";
import { instant } from "../hermes-native-fixture";

const TENANT = "tenant:operator-synthetic";
const NODE = "node:operator-synthetic";
const CODEX_NODE = "node:operator-codex";

const key32 = (byte: number) => new Uint8Array(32).fill(byte);
const inertStorage = () => ({
  async put() { throw new Error("inert"); },
  async read() { return undefined; },
});
const inertReadStorage = () => ({ async read() { return undefined; } });
const checkpoints = () => ({
  async read() { return undefined; },
  async advance() {},
  async initialize() {},
});
const role = (username: string) => ({
  host: "127.0.0.1", port: 5433, database: "controlroomtest", username, password: "synthetic-operator-password", majorVersion: 17,
});

function hermesTemplate(projectId: string) {
  const authority = {
    projectId,
    allowedExecutor: "executor:synthetic-operator",
    allowedOperations: ["harness.hermes.native.start"],
    credentialRefs: ["credential:synthetic-operator"],
    filesystemRoots: [],
    networkPolicy: "allowlist" as const,
    allowedNetworkDestinations: ["https://node.example.test:443"],
    effectPolicy: "approval_required" as const,
    maxRisk: "low" as const,
    maxDurationSeconds: 300,
    maxConcurrentEffects: 1,
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
  return {
    id: "template:operator-synthetic",
    adapter: HERMES_NATIVE_ADAPTER as typeof HERMES_NATIVE_ADAPTER,
    instructions: "synthetic operator template",
    authority: { ...authority, digest: computeAuthorityDigest({ ...authority, digest: sha256Digest("operator-authority-placeholder") }) },
    acceptanceProfileId: "profile:operator-synthetic",
    acceptanceProfileDigest: sha256Digest("operator-acceptance-profile"),
  };
}

function enrollment(nodeId: string) {
  return {
    adapter: HERMES_NATIVE_ADAPTER as typeof HERMES_NATIVE_ADAPTER,
    revision: HERMES_NATIVE_REVISION as typeof HERMES_NATIVE_REVISION,
    tenantId: TENANT,
    nodeId,
    connectionId: "connection:operator-synthetic",
    canonicalDestination: "https://node.example.test:443",
    profile: "personal-compute",
    credentialRef: "credential:synthetic-operator",
    profilePolicyDigest: sha256Digest("operator-profile-policy"),
    qualificationDigest: sha256Digest("operator-qualification"),
    validUntil: instant + 300_000,
    model: "synthetic/operator-1",
    provider: "synthetic-provider",
  };
}

function sessionNode(nodeId: string, features: string[]) {
  return {
    tenantId: TENANT,
    nodeId,
    nodeKeyId: "key:operator-synthetic",
    serverId: "server:operator-synthetic",
    serverKeyId: "key:server:operator-synthetic",
    serverPublicKeySpki: "synthetic-operator-server-public-key-spki",
    transportIdentity: "transport:operator-synthetic",
    features,
    maxFrameBytes: 131_072,
    heartbeatIntervalSeconds: 30,
  };
}

function codexQualification(nodeId: string) {
  const keys = generateKeyPairSync("ed25519");
  const publicKeySpki = keys.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const connectorProfileDigest = sha256Digest("operator-result-return-profile");
  const withDigest = <T extends object>(value: T) => ({ ...value, evidenceDigest: sha256Digest(value) });
  const body = createCodexPhysicalQualificationReceiptBodyV1({
    schema: "control-room.codex-physical-qualification-receipt/v1", qualificationId: "qualification:operator-result",
    qualificationSignerKeyId: "qualification-key:operator-result", tenantId: TENANT, nodeId,
    connectorProfileId: "profile:operator-result", connectorProfileDigest,
    exactPackage: {
      adapterId: CODEX_APP_SERVER_ADAPTER, packageName: CODEX_APP_SERVER_READ_CONTRACT.package,
      packageVersion: CODEX_APP_SERVER_READ_CONTRACT.version,
      generatedSchemaBundleSha256: CODEX_APP_SERVER_READ_CONTRACT.generatedBundleSha256,
      threadStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.paramsSchemaSha256,
      threadStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.threadStart.responseSchemaSha256,
      turnStartParamsSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.paramsSchemaSha256,
      turnStartResponseSchemaSha256: CODEX_APP_SERVER_START_CONTRACT.turnStart.responseSchemaSha256,
      threadReadResponseSchemaSha256: CODEX_APP_SERVER_RESULT_CONTRACT.threadReadResponseSchemaSha256,
      agentMessageSourceSha256: CODEX_APP_SERVER_RESULT_CONTRACT.agentMessageSourceSha256,
    },
    qualifiedAt: new Date(instant - 1_000).toISOString(),
    start: withDigest({
      evidenceId: "evidence:operator-result:start", processAttemptId: "process:operator-result:start",
      connectionAttemptId: "connection:operator-result:start", initializedConnectionDigest: sha256Digest("start"),
      threadId: "thread:operator-result", turnId: "turn:operator-result", startObserved: true as const,
      cleanupVerified: true as const,
    }),
    restartRead: withDigest({
      evidenceId: "evidence:operator-result:restart", processAttemptId: "process:operator-result:restart",
      connectionAttemptId: "connection:operator-result:restart", initializedConnectionDigest: sha256Digest("restart"),
      threadId: "thread:operator-result", turnId: "turn:operator-result", itemId: "item:operator-result",
      restartObserved: true as const, exactReadObserved: true as const, cleanupVerified: true as const,
    }),
    oneFreshProcessPerAttempt: true, sameDurableThreadObserved: true, sameDurableTurnObserved: true,
    terminalCleanupVerified: true, processReuseObserved: false, retryObserved: false,
    canonicalPublicationAllowed: false, completionVerified: false, grantsExecutionAuthority: false,
    permitsRetry: false, permitsResume: false, permitsThreadRead: false,
  });
  return {
    connectorProfileDigest,
    settings: {
      qualificationReceipt: signArtifact(body, keys.privateKey),
      qualificationPublicKeySpki: publicKeySpki, qualificationMaximumAgeMs: 300_000,
    },
  };
}

export type OperatorScenario = { settings: AgentTaskOperatorSettingsV1; trusted: AgentTaskOperatorTrustedInputs };

/** Pure synthetic operator inputs. No database, listener, provider or filesystem use. */
export function operatorConfigurationScenario(kind: "minimal" | "full"): OperatorScenario {
  const full = kind === "full";
  const reviewKey = key32(11), harnessKey = key32(12), resultKey = key32(13);
  const web = {
    origin: "https://control.example.test",
    issuer: "https://control.example.test",
    audience: "control-room-operator-synthetic",
    tenantId: TENANT,
    workspaceId: "workspace:operator-synthetic",
    ownerIdentityId: "owner:operator-synthetic",
    maxSessionSeconds: 3600,
    loadKeys: async () => ({}) as never,
    database: role("web_test"),
    tasks: {
      harnessIntegrityKey: harnessKey,
      results: { integrityKey: resultKey, storageClass: "local" as const, storage: inertReadStorage() },
      reviews: { integrityKey: reviewKey, checkpoints: checkpoints() },
    },
  };
  const evidenceStorage = { integrityKey: resultKey, storageClass: "local" as const, storage: inertStorage() };
  const qualityStorage = { integrityKey: resultKey, storageClass: "local" as const, storage: inertStorage() };
  const trusted: AgentTaskOperatorTrustedInputs = {
    web: web as unknown as AgentTaskOperatorTrustedInputs["web"],
    planning: {
      template: hermesTemplate("project:operator-synthetic") as unknown as AgentTaskOperatorTrustedInputs["planning"]["template"],
      integrityKey: key32(21), reviewIntegrityKey: reviewKey, checkpoints: checkpoints(),
    },
    routes: [{
      nodeId: NODE, executorId: "executor:synthetic-operator", capabilityProbeId: "harness.hermes.native.runs.v1",
      maxConcurrentTasks: 2, requiredScratchBytes: 1024, leaseSeconds: 60,
    },
    ...(full ? [{
      nodeId: CODEX_NODE, executorId: "executor:synthetic-operator", capabilityProbeId: CODEX_APP_SERVER_CAPABILITY,
      maxConcurrentTasks: 2, requiredScratchBytes: 1024, leaseSeconds: 60,
    } as const] : [])],
    approvalEnrollments: [
      { enrollment: enrollment(NODE), nodeClass: "personal-compute" },
      ...(full ? [{ enrollment: enrollment(CODEX_NODE), nodeClass: "personal-compute" } as const] : []),
    ],
    approvalStore: {
      acceptInSession: async () => undefined,
      readInSession: async () => undefined,
      receiveDeliveryReceipt: async () => undefined,
    },
    quality: {
      integrityKey: reviewKey, harnessIntegrityKey: harnessKey, scenarios: [],
      results: qualityStorage, checkpoints: checkpoints(),
    },
    evidence: {
      integrityKey: key32(31),
      enrollments: [enrollment(NODE), ...(full ? [enrollment(CODEX_NODE)] : [])],
      storage: evidenceStorage,
    },
    sessions: {
      nodes: [sessionNode(NODE, [NATIVE_DELIVERY_FEATURE]),
        ...(full ? [sessionNode(CODEX_NODE, [NATIVE_DELIVERY_FEATURE, CODEX_DELIVERY_FEATURE, CODEX_RESULT_RETURN_FEATURE_V1])] : [])],
      // Receiver-dependent sign: the function reads `this.signKey` so that
      // the production bind to the trusted receiver is structurally required.
      // An arrow function would never read `this` and the bind would be a
      // no-op; a non-arrow function that reads `this.signKey` cannot produce
      // the captured signature after post-assembly mutation of the receiver.
      // The trusted-inputs type does not name a `signKey` field, so the receiver
      // is widened with a structural cast and the field lives only in the test.
      sign: function (this: { signKey: Uint8Array }, frame: unknown) {
        return { ...(frame as object), signature: `synthetic:${this.signKey[0]}` };
      } as unknown as ManagedNativeSessionSettings["sign"],
    } as unknown as ManagedNativeSessionSettings,
  };
  const databaseRoles: AgentTaskOperatorSettingsV1["databaseRoles"] = {
    coordinator: role("coordinator_test"),
    results: role("result_test"),
    evidence: role("evidence_test"),
    sessions: role("session_test"),
  };
  const settings: AgentTaskOperatorSettingsV1 = {
    schema: "control-room.agent-task-operator-settings/v1",
    port: 3210,
    tenantId: TENANT,
    databaseRoles,
    features: {
      nativeQueue: true,
      ...(full ? {
        nativeQueueRecovery: true, revisionPlanning: true, quality: true, evidence: true, sessions: true,
        queueWorker: true, codex: true, codexResultReturn: true, nativeHttp: true, artifactStorage: true,
      } : { quality: true, evidence: true, sessions: true }),
    },
  };
  if (!full) return { settings, trusted };
  const qualification = codexQualification(CODEX_NODE);
  const rootPath = "/synthetic/operator-result-storage", storageNamespace = "operator-result-storage";
  const storage = inertStorage();
  trusted.sessions = {
    nodes: trusted.sessions!.nodes,
    sign: trusted.sessions!.sign,
  };
  trusted.codex = {
    integrityKey: key32(41),
    enrollments: [{
      tenantId: TENANT, nodeId: CODEX_NODE, nodeClass: "personal-compute",
      enrollmentDigest: sha256Digest("operator-codex-enrollment"),
      connectorProfileDigest: qualification.connectorProfileDigest,
      workspaceIntentDigest: sha256Digest("operator-codex-workspace"),
      credentialRef: "credential:operator-codex",
      filesystemRoot: "/synthetic", workspacePath: "/synthetic/workspace", validUntil: instant + 300_000,
      approvalKeyId: "approval-key:operator-codex",
      approvals: {
        binding: () => ({ tenantId: TENANT, nodeId: CODEX_NODE, nodeClass: "personal-compute" }),
        assertAvailable() {},
        async resolveApprovalKey() { return new Uint8Array(32); },
      },
      security: { currentServerTrustRevision: () => "trust-revision:operator-codex" },
    }],
  } as unknown as AgentTaskOperatorTrustedInputs["codex"];
  trusted.codexResultReturn = qualification.settings;
  trusted.nativeHttp = {
    origin: "https://machine.example.test",
    peers: [{
      nodeId: NODE, certificateDigest: sha256Digest("operator-peer"),
      task: {
        projectId: "project:operator-synthetic", jobId: "job:operator-synthetic",
        attemptId: "attempt:operator-synthetic", inputDigest: sha256Digest("operator-input"),
      },
    }],
    isPeerCurrent: () => true,
  };
  trusted.artifactStorage = {
    local: {
      rootPath, maximumArtifacts: 100, maximumFileBytes: 65_536,
      maximumTotalBytes: 6_553_600, operationTimeoutMs: 1_000,
    },
    inventory: {
      releaseId: "release:operator-result", releaseDigest: sha256Digest("release:operator-result"),
      databaseSchemaVersion: "schema:operator-result", databaseSchemaDigest: sha256Digest("schema:operator-result"),
      storageNamespace, storageNamespaceDigest: privateArtifactStorageNamespaceDigestV1(storageNamespace, rootPath),
    },
  } as unknown as AgentTaskOperatorTrustedInputs["artifactStorage"];
  // Full composition serves local results through the one storage port.
  const webTasks = (trusted.web as unknown as { tasks: { results: object } }).tasks;
  (trusted.web as unknown as { tasks: object }).tasks = {
    ...(trusted.web as unknown as { tasks: object }).tasks, results: { ...webTasks.results, storageClass: "local", storage },
  };
  const quality = trusted.quality!;
  trusted.quality = { ...quality, results: { ...quality.results, storageClass: "local", storage } };
  trusted.evidence = { ...trusted.evidence!, storage: { ...evidenceStorage, storageClass: "local", storage } };
  databaseRoles.queueWorker = role("worker_test");
  settings.queueWorkerConcurrency = 2;
  return { settings, trusted };
}
