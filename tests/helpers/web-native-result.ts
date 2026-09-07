import { nativeTaskFixture, at, observation, registration } from "../native-task-fixture";
import { instant, binding } from "../hermes-native-fixture";
import { SecurityStore, sha256Digest, InMemoryRollbackCheckpointStoreV1 } from "../../src/security";
import { createAccessVerifier } from "../../src/web/v1/access-verifier";
import { WebTaskService, type WebTaskKeys } from "../../src/web/v1/task-service";
import { NativeResultStore } from "../../src/artifacts/v1/native-results";
import { NativeTaskResultService } from "../../src/node-control/native-task-result-service";
import { InMemoryArtifactStorage } from "../../src/node-executor/artifact-storage";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1, type CompletionReviewTargetV1 } from "../../src/completion-gate/v1";
import { token, request, trust } from "./web-foundation";

export async function webNativeResultFixture() {
  const f = await nativeTaskFixture(), scope = { tenantId: binding.tenantId, workspaceId: "workspace:test" };
  await f.db.query("INSERT INTO workspaces(id,tenant_id,display_name) VALUES('workspace:test','tenant:test','Result fixture')");
  await new SecurityStore(f.db).bootstrapOwner({ tenantId: scope.tenantId, provider: trust.issuer, subject: "test-owner",
    identityId: "identity:test", grantId: "grant:test", displayName: "Synthetic owner", verifiedAt: at(-60_000), expiresAt: at(600_000), now: at() });
  const adapterId = `adapter:manual:${sha256Digest(scope).slice(7, 39)}`;
  await f.db.query(`INSERT INTO adapter_registry(id,tenant_id,source_system,contract_version,authority_mode,status,redaction_policy_version,cursor_retention_days)
    VALUES($1,'tenant:test','control-room-manual','1.0.0','control_room_native','disabled','v1',30)`, [adapterId]);
  await f.db.query(`INSERT INTO projects(id,tenant_id,workspace_id,adapter_id,source_record_id,source_version,title,description,
    normalized_state,domain_state,health,authority_mode,observed_at,payload,updated_at)
    VALUES('project:test','tenant:test','workspace:test',$1,'project:test','1','Native task results','Synthetic evidence',
    'planned','manual_project_active','healthy','control_room_native',$2,'{}'::jsonb,$2)`, [adapterId, at()]);
  await f.db.query(`INSERT INTO control_manual_project_heads(tenant_id,project_id,lifecycle,version,created_at,updated_at)
    VALUES('tenant:test','project:test','active',1,$1,$1)`, [at()]);
  const jwt = token({ iat: instant / 1000 - 60, exp: instant / 1000 + 600 });
  const accessTrust = { ...trust, validUntilMs: instant + 3600_000 };
  const identity = createAccessVerifier(accessTrust)(request(undefined, undefined, undefined, undefined, jwt), instant + 6000);
  const storage = new InMemoryArtifactStorage(), resultKey = new Uint8Array(32).fill(33), harnessKey = new Uint8Array(32).fill(17);
  const checkpoints = new InMemoryRollbackCheckpointStoreV1({ testOnly: true }), reviewKey = new Uint8Array(32).fill(44);
  const reviewStore = new CompletionGateStoreV1(f.db, reviewKey, checkpoints, () => at(6000));
  await reviewStore.provisionTenant(scope.tenantId); await f.runs.create(registration);
  const config = { integrityKey: resultKey, storageClass: "local" as const, storage };
  const results = new NativeResultStore(f.db, harnessKey, config), resultService = new NativeTaskResultService(f.auth, f.runs, results);
  const taskKeys: WebTaskKeys = { harnessIntegrityKey: harnessKey, results: config, reviews: { integrityKey: reviewKey, checkpoints } };
  const tasks = new WebTaskService(f.db, scope, () => instant + 6000, taskKeys);
  const complete = (text: string) => {
    const body = observation({ state: "completed", version: 5, observedAt: instant + 2000, resultText: text });
    return { body, raw: JSON.stringify(f.frame(body)), bytes: new TextEncoder().encode(text) };
  };
  async function reviewTarget(contentHash: string, overrides: { profile?: Partial<CompletionAcceptanceProfileV1>;
    producer?: CompletionReviewTargetV1["producer"] } = {}) {
    const profile: CompletionAcceptanceProfileV1 = { schemaVersion: "control-room-completion-gate/v1", id: "profile:result-review",
      tenantId: scope.tenantId, projectId: binding.projectId, name: "Private result quality", targetKind: "document",
      requiredVerificationScenarioIds: ["scenario:content"], minimumIndependentReviews: 1,
      reviewerSeparation: { actor: true, worker: false, agentProfile: false, harness: false, modelFamily: false },
      verificationRequiresProducerSeparation: true, minimumRisk: "low", maximumRevisionRounds: 2, automaticLowRiskDisposition: false,
      createdBy: { actorId: "identity:test", actorType: "human" }, createdAt: at(), ...overrides.profile };
    const target: CompletionReviewTargetV1 = { schemaVersion: "control-room-completion-gate/v1", id: "target:result:0",
      tenantId: scope.tenantId, projectId: binding.projectId, kind: "document", subjectId: binding.jobId, subjectDigest: contentHash,
      acceptanceProfileId: profile.id, acceptanceProfileDigest: sha256Digest(profile), producer: { actorId: binding.nodeId, actorType: "agent" },
      rootTargetId: "target:result:0", revisionNumber: 0, submittedAt: at(2000), ...(overrides.producer ? { producer: overrides.producer } : {}) };
    await reviewStore.registerProfile(profile); await reviewStore.registerTarget(target);
    return { profile, target };
  }
  return { ...f, storage, results, resultService, config, harnessKey, resultKey, taskKeys, tasks, scope, identity, jwt,
    accessTrust, checkpoints, reviewKey, reviewStore, complete, reviewTarget };
}
