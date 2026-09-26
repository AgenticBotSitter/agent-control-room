import assert from "node:assert/strict";
import test from "node:test";
import { sha256Digest } from "../src/security";
import { createMacLocalOwnerReviewProfileV1, createMacLocalTextScenarioV1,
  macLocalOwnerReviewProfileIdV1 } from "../src/web/v1/mac-local-owner-review-profile";

const input = { tenantId: "tenant:mac", projectId: "project:a", ownerIdentityId: "identity:tenant:mac:owner",
  projectCreatedAt: "2026-09-25T12:00:00.000Z" };

test("one stable owner-review profile per project, with a non-authorizing text check", () => {
  const a = createMacLocalOwnerReviewProfileV1(input);
  const b = createMacLocalOwnerReviewProfileV1({ ...input, projectId: "project:b" });
  assert.notEqual(a.id, b.id);
  assert.equal(a.id, macLocalOwnerReviewProfileIdV1(input.projectId));
  assert.deepEqual(a, createMacLocalOwnerReviewProfileV1(input));
  assert.equal(a.automaticLowRiskDisposition, false);
  assert.equal(a.reviewerSeparation.actor, true);
  assert.equal(createMacLocalTextScenarioV1(a).acceptanceProfileDigest, sha256Digest(a));
  const long = "project:" + "x".repeat(172);
  assert.match(macLocalOwnerReviewProfileIdV1(long), /^profile:mac-local-owner-review:[a-f0-9]{32}$/);
});
