import assert from "node:assert/strict";
import test from "node:test";
import { selectAbsNewsDigestV1, type AbsNewsDigestSelectionOptionsV1 } from "../src/project-adapters/abs-news/v1/digest-selection.ts";
import { buildAbsNewsStoryV1 } from "../src/project-adapters/abs-news/v1/story.ts";
import type { AbsNewsStoryV1 } from "../src/project-adapters/abs-news/v1/types.ts";
import { sha256Digest } from "../src/security/index.ts";

const now = "2026-09-05T18:00:00.000Z";
const nowMs = Date.parse(now);
const options: AbsNewsDigestSelectionOptionsV1 = {
  nowMs,
  windowHours: 24,
  limit: 10,
  maxPerSource: 10,
  minimumScore: 50,
};

function story(
  storyId: string,
  overrides: Partial<{
    clusterId: string;
    queue: AbsNewsStoryV1["queue"];
    canonicalHost: string;
    sourceLabel: string;
    publishedAt: string | undefined;
    discoveredAt: string;
    verificationState: AbsNewsStoryV1["verificationState"];
    priorityScore: number;
  }> = {},
): AbsNewsStoryV1 {
  const canonicalHost = overrides.canonicalHost ?? `${storyId.replaceAll(".", "-")}.example.com`;
  const publishedAt = Object.hasOwn(overrides, "publishedAt") ? overrides.publishedAt : "2026-09-05T17:00:00.000Z";
  return buildAbsNewsStoryV1({
    storyId,
    tenantId: "tenant.owner",
    workspaceId: "workspace.abs.news",
    projectId: "project.abs.ai-tech-news",
    clusterId: overrides.clusterId ?? `cluster.${storyId}`,
    queue: overrides.queue ?? "important_now",
    title: `Story ${storyId}`,
    summary: "A normalized story for digest selection tests.",
    canonicalUrl: `https://${canonicalHost}/story`,
    sourceLabel: overrides.sourceLabel ?? `Source ${storyId}`,
    ...(publishedAt === undefined ? {} : { publishedAt }),
    discoveredAt: overrides.discoveredAt ?? "2026-09-05T17:01:00.000Z",
    lastVerifiedAt: "2026-09-05T17:02:00.000Z",
    verificationState: overrides.verificationState ?? "verified",
    priorityScore: overrides.priorityScore ?? 80,
    coverageCount: 1,
    sourceEvidence: [{
      evidenceId: `evidence.${storyId}`,
      sourceId: `source.${storyId}`,
      sourceKind: "rss",
      sourceLabel: `Evidence ${storyId}`,
      canonicalUrl: `https://${canonicalHost}/story`,
      observedAt: "2026-09-05T17:02:00.000Z",
      evidenceDigest: sha256Digest({ storyId, evidence: true }),
      containsRawNewsletterBody: false,
      grantsNetworkAuthority: false,
    }],
    contentDigest: sha256Digest({ storyId, content: true }),
  });
}

function expectInvalidOptions(overrides: Partial<AbsNewsDigestSelectionOptionsV1>): void {
  assert.throws(
    () => selectAbsNewsDigestV1([], { ...options, ...overrides }),
    (error: unknown) => error instanceof Error && error.message === "invalid_digest_options",
  );
}

test("CR14F-NEWS-CORE-001 rejects every invalid digest option boundary with the fixed error", () => {
  for (const value of [null, undefined, {}]) {
    assert.throws(
      () => selectAbsNewsDigestV1([], value as unknown as AbsNewsDigestSelectionOptionsV1),
      (error: unknown) => error instanceof Error && error.message === "invalid_digest_options",
    );
  }
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY]) expectInvalidOptions({ nowMs: value });
  for (const value of [Number.NaN, 0, -1, 168.000_001]) expectInvalidOptions({ windowHours: value });
  for (const value of [0, 1.5, 101]) expectInvalidOptions({ limit: value });
  for (const value of [0, 1.5, 101]) expectInvalidOptions({ maxPerSource: value });
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, -0.001, 100.001]) expectInvalidOptions({ minimumScore: value });
  assert.deepEqual(selectAbsNewsDigestV1([], { ...options, windowHours: 168, limit: 100, maxPerSource: 100, minimumScore: 100 }), {
    selectedStoryIds: [],
    deferredStoryIds: [],
  });
});

test("CR14F-NEWS-CORE-001 includes the exact time boundary and excludes older, future, and invalid chosen dates", () => {
  const boundary = story("story.boundary", { publishedAt: "2026-09-04T18:00:00.000Z" });
  const tooOld = story("story.old", { publishedAt: "2026-09-04T17:59:59.999Z" });
  const future = story("story.future", { publishedAt: "2026-09-05T18:00:00.001Z" });
  const invalidPublished = { ...story("story.invalid-published"), publishedAt: "not-a-date" };
  const discoveredFallback = story("story.discovered", {
    publishedAt: undefined,
    discoveredAt: "2026-09-05T16:00:00.000Z",
  });
  assert.deepEqual(selectAbsNewsDigestV1(
    [tooOld, future, invalidPublished, discoveredFallback, boundary],
    options,
  ), {
    selectedStoryIds: ["story.discovered", "story.boundary"],
    deferredStoryIds: ["story.future", "story.invalid-published", "story.old"],
  });
});

test("CR14F-NEWS-CORE-001 admits only verified non-archive stories at or above the score threshold", () => {
  const atThreshold = story("story.at-threshold", { priorityScore: 50 });
  const below = story("story.below", { priorityScore: 49 });
  const archived = story("story.archived", { queue: "archive", priorityScore: 100 });
  const unverified = story("story.unverified", { verificationState: "review_only", priorityScore: 100 });
  assert.deepEqual(selectAbsNewsDigestV1([unverified, below, atThreshold, archived], options), {
    selectedStoryIds: ["story.at-threshold"],
    deferredStoryIds: ["story.archived", "story.below", "story.unverified"],
  });
});

test("CR14F-NEWS-CORE-001 ranks by score, then chosen time, then ascending story ID", () => {
  const lowerScore = story("story.a-lower-score", { priorityScore: 89, publishedAt: "2026-09-05T17:59:00.000Z" });
  const older = story("story.z-older", { priorityScore: 90, publishedAt: "2026-09-05T16:00:00.000Z" });
  const tiedB = story("story.b-tied", { priorityScore: 90, publishedAt: "2026-09-05T17:00:00.000Z" });
  const tiedA = story("story.a-tied", { priorityScore: 90, publishedAt: "2026-09-05T17:00:00.000Z" });
  assert.deepEqual(selectAbsNewsDigestV1([lowerScore, tiedB, older, tiedA], options).selectedStoryIds, [
    "story.a-tied",
    "story.b-tied",
    "story.z-older",
    "story.a-lower-score",
  ]);
});

test("CR14F-NEWS-CORE-001 keeps one story per cluster and applies diversity by canonical host", () => {
  const clusterWinner = story("story.cluster-winner", { clusterId: "cluster.shared", canonicalHost: "one.example.com", sourceLabel: "Shared label", priorityScore: 99 });
  const clusterDuplicate = story("story.cluster-duplicate", { clusterId: "cluster.shared", canonicalHost: "two.example.com", priorityScore: 98 });
  const sameHost = story("story.same-host", { canonicalHost: "one.example.com", sourceLabel: "Different display label", priorityScore: 97 });
  const otherHost = story("story.other-host", { canonicalHost: "two.example.com", sourceLabel: "Shared label", priorityScore: 96 });
  assert.deepEqual(selectAbsNewsDigestV1(
    [otherHost, sameHost, clusterDuplicate, clusterWinner],
    { ...options, maxPerSource: 1 },
  ), {
    selectedStoryIds: ["story.cluster-winner", "story.other-host"],
    deferredStoryIds: ["story.cluster-duplicate", "story.same-host"],
  });
});

test("CR14F-NEWS-CORE-001 enforces the overall cap and deterministically defers every unselected ID once", () => {
  const inputs = [
    story("story.c", { priorityScore: 80 }),
    story("story.a", { priorityScore: 100 }),
    story("story.b", { priorityScore: 90 }),
    story("story.d", { verificationState: "review_only" }),
  ];
  assert.deepEqual(selectAbsNewsDigestV1([inputs[0]!, inputs[3]!, inputs[2]!, inputs[1]!, inputs[3]!], {
    ...options,
    limit: 2,
  }), {
    selectedStoryIds: ["story.a", "story.b"],
    deferredStoryIds: ["story.c", "story.d"],
  });
});

test("CR14F-NEWS-CORE-001 is permutation-stable across deterministic ties and policy caps", () => {
  const a = story("story.a", { priorityScore: 90, canonicalHost: "shared.example.com" });
  const b = story("story.b", { priorityScore: 90, canonicalHost: "shared.example.com" });
  const c = story("story.c", { priorityScore: 90, canonicalHost: "other.example.com" });
  const expected = {
    selectedStoryIds: ["story.a", "story.c"],
    deferredStoryIds: ["story.b"],
  };
  for (const permutation of [[a, b, c], [a, c, b], [b, a, c], [b, c, a], [c, a, b], [c, b, a]]) {
    assert.deepEqual(selectAbsNewsDigestV1(permutation, { ...options, maxPerSource: 1 }), expected);
  }
});

test("CR14F-NEWS-CORE-001 coalesces identical IDs and rejects different digests for one story ID", () => {
  const original = story("story.identity");
  const replay = { ...original };
  assert.deepEqual(selectAbsNewsDigestV1([original, replay, original], options), {
    selectedStoryIds: ["story.identity"],
    deferredStoryIds: [],
  });

  const conflict = story("story.identity", { priorityScore: 81 });
  assert.throws(
    () => selectAbsNewsDigestV1([original, conflict], options),
    (error: unknown) => error instanceof Error && error.message === "conflicting_story_identity",
  );
});

test("CR14F-NEWS-CORE-001 does not mutate frozen stories, nested evidence, or digest fields", () => {
  const first = story("story.frozen-a", { priorityScore: 90 });
  const second = story("story.frozen-b", { priorityScore: 80 });
  for (const value of [first, second]) {
    Object.freeze(value.sourceEvidence[0]);
    Object.freeze(value.sourceEvidence);
    Object.freeze(value);
  }
  const inputs = Object.freeze([second, first]);
  const before = JSON.stringify(inputs);
  const digests = inputs.map(({ contentDigest, storyDigest, sourceEvidence }) => ({
    contentDigest,
    storyDigest,
    evidenceDigest: sourceEvidence[0]!.evidenceDigest,
  }));

  assert.deepEqual(selectAbsNewsDigestV1(inputs, options).selectedStoryIds, ["story.frozen-a", "story.frozen-b"]);
  assert.equal(JSON.stringify(inputs), before);
  assert.deepEqual(inputs.map(({ contentDigest, storyDigest, sourceEvidence }) => ({
    contentDigest,
    storyDigest,
    evidenceDigest: sourceEvidence[0]!.evidenceDigest,
  })), digests);
});
