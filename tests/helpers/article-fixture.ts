import { buildAbsNewsStoryV1 } from "../../src/project-adapters/abs-news/v1/story";
export function articleStory(scope: { tenantId: string; workspaceId: string; projectId: string }) {
  const digest = `sha256:${"a".repeat(64)}`;
  return buildAbsNewsStoryV1({ ...scope, storyId: "story:fixture", clusterId: "cluster:fixture", queue: "important_now",
    title: "Synthetic article", summary: "Synthetic fixture summary", canonicalUrl: "https://example.invalid/article", sourceLabel: "Fixture",
    discoveredAt: "2026-09-04T00:00:00.000Z", lastVerifiedAt: "2026-09-04T00:00:00.000Z", verificationState: "verified",
    priorityScore: 50, coverageCount: 1, contentDigest: digest, sourceEvidence: [{ evidenceId: "evidence:fixture",
      sourceId: "source:fixture", sourceKind: "manual", sourceLabel: "Fixture", canonicalUrl: "https://example.invalid/article",
      observedAt: "2026-09-04T00:00:00.000Z", evidenceDigest: digest, containsRawNewsletterBody: false, grantsNetworkAuthority: false }] });
}
