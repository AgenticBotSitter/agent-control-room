import { sha256Digest } from "../../src/security";
import { computeExecutionId, SqliteExecutionStateStore, type DurableExecutionCreationV1 } from "../../src/node-policy/v1";
import { DurableBridgeJobEventRecorder, SqliteBridgeJournal } from "../../src/node-bridge";
import { InMemoryArtifactStorage, runAdmittedSyntheticExecution } from "../../src/node-executor";

const executionPath = process.argv[2];
const journalPath = process.argv[3];
if (!executionPath || !journalPath) throw new Error("recovery fixture paths are required");

const admittedAt = "2026-08-26T12:00:00.000Z";
const spec = {
  schema: "control-room.synthetic-execution/v1" as const,
  jobId: "job:recovery:1",
  attemptId: "attempt:recovery:1",
  steps: 3,
  checkpointEverySteps: 2,
  stepDelayMilliseconds: 0,
  artifactText: "restart-safe synthetic result\n",
};
const operationDigest = sha256Digest(spec);
const admissionId = "admission:recovery:1";
const executionId = computeExecutionId(admissionId, operationDigest);
const creation: DurableExecutionCreationV1 = {
  executionId,
  admissionId,
  identity: {
    tenantId: "tenant:owner",
    nodeId: "node:mac-mini",
    projectId: "project:control-room",
    jobId: spec.jobId,
    attemptId: spec.attemptId,
    operationDigest,
  },
  authorityDigest: `sha256:${"a".repeat(64)}`,
  deadlineSources: {
    admittedAt,
    ceilingDurationSeconds: 3_600,
    authorityDurationSeconds: 3_600,
    authorityExpiresAt: "2026-08-26T13:00:00.000Z",
    leaseExpiresAt: "2026-08-26T12:30:00.000Z",
  },
  leaseEpoch: 1,
  createdAt: admittedAt,
};

const authority = new SqliteExecutionStateStore(executionPath);
const journal = new SqliteBridgeJournal(journalPath);
authority.create(creation);
const result = await runAdmittedSyntheticExecution({
  executionId,
  leaseId: "lease:recovery:1",
  leaseEpoch: 1,
  spec,
  artifact: {
    artifactId: "artifact:recovery:1",
    claimId: "claim:recovery:1",
    tenantId: creation.identity.tenantId,
    projectId: creation.identity.projectId,
    jobId: creation.identity.jobId,
    attemptId: creation.identity.attemptId,
    producerId: creation.identity.nodeId,
    logicalRole: "synthetic-result",
    schemaVersion: "1.0.0",
    storageClass: "local",
    retentionClass: "test-memory",
  },
}, {
  authority,
  artifacts: new InMemoryArtifactStorage(),
  events: new DurableBridgeJobEventRecorder(journal, () => "2026-08-26T12:05:00.000Z"),
  now: () => "2026-08-26T12:05:00.000Z",
  sleep: async () => {},
});

if (result.state !== "completed") throw new Error("recovery fixture did not complete");

// Deliberately skip close/flush hooks to model process death after durable local commit
// but before the bridge creates or sends any delivery frame.
process.exit(91);
