import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import {
  computeExecutionId,
  SqliteExecutionStateStore,
  type DurableExecutionCreationV1,
} from "../src/node-policy/v1";
import type { JobEventBody } from "../src/node-protocol/v1";
import { DurableBridgeJobEventRecorder, SqliteBridgeJournal } from "../src/node-bridge/index.ts";
import {
  ArtifactStorageError,
  InMemoryArtifactStorage,
  SyntheticCoordinatorError,
  runAdmittedSyntheticExecution,
  type ArtifactStoragePortV1,
  type ArtifactLineageRecordV1,
  type SyntheticCoordinatorInputV1,
} from "../src/node-executor";

const admittedAt = "2026-08-26T12:00:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;

function fixture(overrides: { leaseExpiresAt?: string; crashAfterStep?: number } = {}): {
  store: SqliteExecutionStateStore;
  input: SyntheticCoordinatorInputV1;
  creation: DurableExecutionCreationV1;
} {
  const spec = {
    schema: "control-room.synthetic-execution/v1" as const,
    jobId: "job:synthetic:1",
    attemptId: "attempt:synthetic:1",
    steps: 3,
    checkpointEverySteps: 2,
    stepDelayMilliseconds: 0,
    artifactText: "synthetic result\n",
    ...(overrides.crashAfterStep === undefined ? {} : { crashAfterStep: overrides.crashAfterStep }),
  };
  const operationDigest = sha256Digest(spec);
  const admissionId = "admission:synthetic:1";
  const executionId = computeExecutionId(admissionId, operationDigest);
  const creation: DurableExecutionCreationV1 = {
    executionId,
    admissionId,
    identity: {
      tenantId: "tenant:owner",
      nodeId: "node:test",
      projectId: "project:control-room",
      jobId: spec.jobId,
      attemptId: spec.attemptId,
      operationDigest,
    },
    authorityDigest: digest("a"),
    deadlineSources: {
      admittedAt,
      ceilingDurationSeconds: 3_600,
      authorityDurationSeconds: 3_600,
      authorityExpiresAt: "2026-08-26T13:00:00.000Z",
      leaseExpiresAt: overrides.leaseExpiresAt ?? "2026-08-26T12:30:00.000Z",
    },
    leaseEpoch: 1,
    createdAt: admittedAt,
  };
  const store = new SqliteExecutionStateStore(":memory:", { testOnlyAllowEphemeral: true });
  store.create(creation);
  return {
    store,
    creation,
    input: {
      executionId,
      leaseId: "lease:synthetic:1",
      leaseEpoch: 1,
      spec,
      artifact: {
        artifactId: "artifact:synthetic:1",
        claimId: "claim:synthetic:1",
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
    },
  };
}

function clock(startSeconds = 1): { now(): string; set(seconds: number): void } {
  let seconds = startSeconds;
  return {
    now: () => new Date(Date.parse(admittedAt) + seconds * 1_000).toISOString(),
    set: (value) => {
      seconds = value;
    },
  };
}

test("an exact admitted operation completes with stored bytes, manifest, claim, and one terminal event", async () => {
  const { store, input } = fixture();
  const artifacts = new InMemoryArtifactStorage();
  const journal = new SqliteBridgeJournal(":memory:");
  const events: JobEventBody[] = [];
  const lineages: ArtifactLineageRecordV1[] = [];
  const time = clock();
  const recorder = new DurableBridgeJobEventRecorder(journal, time.now);
  try {
    const result = await runAdmittedSyntheticExecution(input, {
      authority: store,
      artifacts,
      events: { append: (event, lineage) => {
        events.push(event);
        if (lineage) lineages.push(lineage);
        recorder.append(event, lineage);
      } },
      now: time.now,
      sleep: async () => {},
    });

    assert.equal(result.state, "completed");
    assert.equal(store.load(input.executionId)?.state, "completed");
    assert.deepEqual(events.map((event) => event.event), [
      "started",
      "progress",
      "progress",
      "checkpointed",
      "progress",
      "checkpointed",
      "completed",
    ]);
    assert.equal(events.filter((event) => ["completed", "failed", "cancelled"].includes(event.event)).length, 1);
    assert.deepEqual(events.at(-1)?.artifactManifestIds, ["artifact:synthetic:1"]);
    assert.ok(events.slice(0, -1).every((event) => event.artifactManifestIds.length === 0));
    assert.equal(Buffer.from(artifacts.get("artifact:synthetic:1") ?? []).toString("utf8"), "synthetic result\n");
    if (result.state !== "completed") throw new Error("expected completion");
    assert.equal(result.bundle.manifest.opaqueLocator, "memory://artifact/artifact%3Asynthetic%3A1");
    assert.equal(result.bundle.manifest.createdAt, events.at(-1)?.occurredAt);
    assert.equal(result.bundle.verificationClaim.artifactId, result.bundle.manifest.id);
    assert.equal("verified" in result.bundle.verificationClaim, false);
    assert.equal(lineages.length, 1);
    assert.equal(lineages[0].artifactId, result.bundle.manifest.id);
    assert.deepEqual(lineages[0].independentVerification, { status: "not_run" });
    assert.deepEqual(journal.artifactLineage(result.bundle.manifest.id), lineages[0]);
    assert.deepEqual(journal.unresolvedAttempts(), []);
    assert.deepEqual(journal.pendingJobEvents().map((row) => row.event.sequence), [1, 2, 3, 4, 5, 6, 7]);
  } finally {
    journal.close();
    store.close();
  }
});

test("server cancellation is durably recorded before one cancelled terminal event", async () => {
  const { store, input } = fixture();
  const events: JobEventBody[] = [];
  let cancellation: "server" | undefined;
  try {
    const result = await runAdmittedSyntheticExecution(input, {
      authority: store,
      artifacts: new InMemoryArtifactStorage(),
      events: { append: (event) => { events.push(event); } },
      now: clock().now,
      sleep: async () => {
        cancellation = "server";
      },
      cancellationReason: () => cancellation,
    });

    assert.equal(result.state, "cancelled");
    assert.equal(store.load(input.executionId)?.state, "cancelled");
    assert.equal(events.filter((event) => event.event === "cancelled").length, 1);
    assert.equal(events.at(-1)?.event, "cancelled");
    assert.deepEqual(events.at(-1)?.artifactManifestIds, []);
  } finally {
    store.close();
  }
});

test("lease deadline crossing cancels without publishing an artifact", async () => {
  const { store, input } = fixture({ leaseExpiresAt: "2026-08-26T12:00:05.000Z" });
  const artifacts = new InMemoryArtifactStorage();
  const events: JobEventBody[] = [];
  const time = clock(1);
  try {
    const result = await runAdmittedSyntheticExecution(input, {
      authority: store,
      artifacts,
      events: { append: (event) => { events.push(event); } },
      now: time.now,
      sleep: async () => {
        time.set(5);
      },
    });

    assert.equal(result.state, "cancelled");
    assert.equal(store.load(input.executionId)?.state, "cancelled");
    assert.equal(artifacts.count(), 0);
    assert.equal(events.at(-1)?.event, "cancelled");
  } finally {
    store.close();
  }
});

test("executor crash and storage failure use fixed safe failure codes", async () => {
  const crashFixture = fixture({ crashAfterStep: 1 });
  const crashEvents: JobEventBody[] = [];
  try {
    const crashResult = await runAdmittedSyntheticExecution(crashFixture.input, {
      authority: crashFixture.store,
      artifacts: new InMemoryArtifactStorage(),
      events: { append: (event) => { crashEvents.push(event); } },
      now: clock().now,
      sleep: async () => {},
    });
    assert.equal(crashResult.state, "failed");
    if (crashResult.state === "failed") assert.equal(crashResult.safeFailureCode, "synthetic_crash");
    assert.equal(crashEvents.at(-1)?.safeReasonCode, "synthetic_crash");
  } finally {
    crashFixture.store.close();
  }

  const storageFixture = fixture();
  const storageEvents: JobEventBody[] = [];
  const unavailable: ArtifactStoragePortV1 = {
    put: async () => {
      throw new Error("private storage diagnostic must not escape");
    },
  };
  try {
    const storageResult = await runAdmittedSyntheticExecution(storageFixture.input, {
      authority: storageFixture.store,
      artifacts: unavailable,
      events: { append: (event) => { storageEvents.push(event); } },
      now: clock().now,
      sleep: async () => {},
    });
    assert.equal(storageResult.state, "failed");
    if (storageResult.state === "failed") assert.equal(storageResult.safeFailureCode, "storage_unavailable");
    assert.equal(storageEvents.at(-1)?.safeReasonCode, "storage_unavailable");
  } finally {
    storageFixture.store.close();
  }
});

test("operation, lease, identity, and admission-state mismatches fail before execution", async () => {
  for (const mutate of [
    (input: SyntheticCoordinatorInputV1) => ({ ...input, leaseEpoch: 2 }),
    (input: SyntheticCoordinatorInputV1) => ({ ...input, leaseId: "" }),
    (input: SyntheticCoordinatorInputV1) => ({ ...input, spec: { ...input.spec, artifactText: "changed" } }),
    (input: SyntheticCoordinatorInputV1) => ({ ...input, artifact: { ...input.artifact, projectId: "project:other" } }),
  ]) {
    const { store, input } = fixture();
    let portCalls = 0;
    try {
      await assert.rejects(
        runAdmittedSyntheticExecution(mutate(input), {
          authority: store,
          artifacts: new InMemoryArtifactStorage(),
          events: { append: () => { portCalls += 1; } },
          now: () => { portCalls += 1; return admittedAt; },
          sleep: async () => { portCalls += 1; },
        }),
        SyntheticCoordinatorError,
      );
      assert.equal(portCalls, 0);
      assert.equal(store.load(input.executionId)?.state, "admitted");
    } finally {
      store.close();
    }
  }
});

test("in-memory storage is bounded, idempotent, conflict-safe, and clones bytes", async () => {
  const storage = new InMemoryArtifactStorage(1, 4);
  const source = Uint8Array.from([1, 2, 3]);
  const first = await storage.put({ artifactId: "artifact:1", bytes: source });
  source[0] = 9;
  assert.deepEqual(storage.get("artifact:1"), Uint8Array.from([1, 2, 3]));
  const read = storage.get("artifact:1");
  if (read) read[1] = 9;
  assert.deepEqual(storage.get("artifact:1"), Uint8Array.from([1, 2, 3]));
  assert.deepEqual(await storage.put({ artifactId: "artifact:1", bytes: Uint8Array.from([1, 2, 3]) }), first);
  await assert.rejects(
    storage.put({ artifactId: "artifact:1", bytes: Uint8Array.from([3, 2, 1]) }),
    (error: unknown) => error instanceof ArtifactStorageError && error.safeFailureCode === "storage_conflict",
  );
  await assert.rejects(
    storage.put({ artifactId: "artifact:2", bytes: Uint8Array.from([4]) }),
    (error: unknown) => error instanceof ArtifactStorageError && error.safeFailureCode === "storage_capacity",
  );
  assert.equal(storage.count(), 1);
  assert.equal(storage.sizeBytes(), 3);
});

test("an unresolved execution remains cancellation-only after restart", () => {
  const { store, input } = fixture();
  try {
    store.apply(input.executionId, {
      eventId: "execution:start",
      kind: "start",
      occurredAt: "2026-08-26T12:00:01.000Z",
    });
    assert.equal(store.recoveryAction(input.executionId), "request_cancellation");
  } finally {
    store.close();
  }
});
