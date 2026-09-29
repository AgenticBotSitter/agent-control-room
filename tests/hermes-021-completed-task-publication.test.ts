import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
  retainHermes021MacosResultBindingV1 } from "../src/harness/hermes-021-v1";

test("local Hermes result binding is wholly derived from the prepared controller packet", () => {
  const prepared = {
    schema: "control-room.hermes-021-macos-dispatch-preparation/v1" as const,
    delivery: {
      identity: { tenantId: "tenant:test", projectId: "project:test", jobId: "job:test", attemptId: "attempt:test",
        runId: "run:test", nodeId: "node:test" },
      authorityDigest: sha256Digest("authority"), connectorProfileDigest: HERMES_021_MACOS_CONNECTOR_PROFILE_DIGEST_V1,
      acceptanceProfileId: "profile:test", acceptanceProfileDigest: sha256Digest("profile"),
    }, workflowId: "workflow:test", route: { kind: "local" as const, workerId: "worker:test" },
    executionClass: "text_review" as const,
    startsWork: false as const, grantsExecutionAuthority: false as const,
  };
  const retained = retainHermes021MacosResultBindingV1(prepared as never);
  assert.deepEqual(retained, { ...prepared.delivery.identity, workflowId: "workflow:test",
    authorityDigest: prepared.delivery.authorityDigest, acceptanceProfileId: "profile:test",
    acceptanceProfileDigest: prepared.delivery.acceptanceProfileDigest });
  assert.equal("connectorProfileDigest" in retained, false);
});

test("local Hermes result binding refuses an incomplete prepared packet", () => {
  assert.throws(() => retainHermes021MacosResultBindingV1({ schema: "wrong" } as never),
    /hermes_021_macos_completed_task_publication_unavailable/);
});
