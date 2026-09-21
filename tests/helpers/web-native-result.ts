import { nativeTaskFixture, at, observation, registration, inputDigest } from "../native-task-fixture";
import { instant, binding } from "../hermes-native-fixture";
import { createHash } from "node:crypto";
import { SecurityStore, sha256Digest, InMemoryRollbackCheckpointStoreV1 } from "../../src/security";
import { createAccessVerifier } from "../../src/web/v1/access-verifier";
import { WebTaskService, type WebTaskKeys } from "../../src/web/v1/task-service";
import { NativeResultStore } from "../../src/artifacts/v1/native-results";
import { NativeTaskResultService } from "../../src/node-control/native-task-result-service";
import { InMemoryArtifactStorage } from "../../src/node-executor/artifact-storage";
import { CompletionGateStoreV1, type CompletionAcceptanceProfileV1, type CompletionReviewTargetV1 } from "../../src/completion-gate/v1";
import { token, request, trust } from "./web-foundation";

const digest = (seed = "a") => `sha256:${createHash("sha256").update(`durable-test:${seed}`).digest("hex")}`;

function runRunKey(runId: string): string {
  let h = 0;
  for (const ch of runId) h = ((h * 31) + ch.charCodeAt(0)) >>> 0;
  const hex = h.toString(16).padStart(8, "0").repeat(8);
  return `sha256:${hex}`;
}
function runRunDigest(runId: string, tag: string, prefix: "sha256" | "hmac-sha256"): string {
  let h = 5381;
  for (const ch of runId + tag) h = (((h << 5) + h) ^ ch.charCodeAt(0)) >>> 0;
  const hex = h.toString(16).padStart(8, "0").repeat(8);
  return `${prefix}:${hex}`;
}

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
  async function provisionRun(runId: string, jobId: string, attemptId: string, authorityDigest = digest("s")) {
    const keyDigest = runRunKey(runId), runDigest = runRunDigest(runId, "run-digest-", "sha256"),
      runTag = runRunDigest(runId, "run-tag-", "hmac-sha256");
    await f.db.query(`INSERT INTO control_jobs(id,tenant_id,workflow_id,project_id,state,version,priority,required_capability,authority_digest,payload,created_at,updated_at)
      VALUES ($1,'tenant:test','workflow:test',$2,'leased',2,50,'capability:fixture',$3,$4,$5,$5)`,
      [jobId, binding.projectId, authorityDigest, JSON.stringify({
        id: jobId, kind: "job", state: "leased", jobType: "hermes-native-evidence-fixture", version: 2,
        priority: 50, tenantId: binding.tenantId, authority: { digest: authorityDigest, maxRisk: "low",
          expiresAt: at(600_000), projectId: binding.projectId, effectPolicy: "none", networkPolicy: "none",
          credentialRefs: [], allowedExecutor: "executor:fixture", filesystemRoots: [], allowedOperations: ["operation:fixture"],
          maxDurationSeconds: 600, maxConcurrentEffects: 0, allowedNetworkDestinations: [] },
        createdAt: at(-60_000), projectId: binding.projectId, updatedAt: at(-60_000), workflowId: "workflow:test",
        inputDigest: inputDigest, retryPolicy: { maxAttempts: 1, backoffSeconds: 1, retryAfterOrphan: false,
          ambiguousEffectPolicy: "attention", retryableFailureCodes: [] }, specVersion: "1.0.0",
        contractVersion: "control-room-domain/v1", dependsOnJobIds: [], requiredCapability: "capability:fixture"
      }), at(-60_000)]);
    await f.db.query(`INSERT INTO control_attempts(id,tenant_id,job_id,attempt_number,state,version,worker_id,node_id,lease_epoch,payload,created_at,updated_at)
      VALUES ($1,'tenant:test',$2,1,'leased',1,NULL,'node:test',1,$3,$4,$4)`,
      [attemptId, jobId, JSON.stringify({
        id: attemptId, kind: "attempt", jobId, state: "leased", nodeId: binding.nodeId, version: 1,
        tenantId: binding.tenantId, createdAt: at(-60_000), offeredAt: at(-60_000), updatedAt: at(-60_000),
        leaseEpoch: 1, attemptNumber: 1, contractVersion: "control-room-domain/v1"
      }), at(-60_000)]);
    await f.db.query(`INSERT INTO control_harness_runs(id,tenant_id,project_id,job_id,attempt_id,node_id,adapter_id,harness,native_session_key_digest,parent_run_id,revision_of_run_id,state,last_sequence,run_digest,run_auth_tag,payload,created_at,updated_at,last_observed_at)
      VALUES ($1,'tenant:test',$2,$3,$4,'node:test',$6,'hermes',$5,NULL,NULL,'discovered',0,$7,$8,$9,$10,$10,$10)`,
      [runId, binding.projectId, jobId, attemptId, keyDigest, adapterId, runDigest, runTag, JSON.stringify({
        id: runId, jobId, state: "discovered", nodeId: binding.nodeId, harness: "hermes",
        tenantId: binding.tenantId, adapterId, attemptId,
        createdAt: at(-60_000), projectId: binding.projectId, resumable: false, updatedAt: at(-60_000),
        cancelState: "not_requested", schemaVersion: "control-room-harness/v1", adapterVersion: "1.0.0",
        harnessVersion: "2026.8.31", lastObservedAt: at(-60_000), nativeSessionKeyDigest: keyDigest,
        connectorProfileDigest: digest("c"), authorityDigest
      }), at(-60_000)]);
  }
  async function provisionRuns(runIds: string[]) { for (const r of runIds) await provisionRun(r, `job:${r}`, `attempt:${r}`); }
  return { ...f, storage, results, resultService, config, harnessKey, resultKey, taskKeys, tasks, scope, identity, jwt,
    accessTrust, checkpoints, reviewKey, reviewStore, complete, reviewTarget, provisionRun, provisionRuns };
}
