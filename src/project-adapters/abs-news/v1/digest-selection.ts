import type { AbsNewsStoryV1 } from "./types";

export interface AbsNewsDigestSelectionOptionsV1 {
  readonly nowMs: number;
  readonly windowHours: number;
  readonly limit: number;
  readonly maxPerSource: number;
  readonly minimumScore: number;
}

export interface AbsNewsDigestSelectionV1 {
  selectedStoryIds: string[];
  deferredStoryIds: string[];
}

interface RankedStory {
  readonly story: AbsNewsStoryV1;
  readonly timestampMs: number;
}

function compareCodePoints(left: string, right: string): number {
  const leftCodePoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightCodePoints = Array.from(right, (value) => value.codePointAt(0)!);
  const sharedLength = Math.min(leftCodePoints.length, rightCodePoints.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftCodePoints[index]! - rightCodePoints[index]!;
    if (difference !== 0) return difference;
  }
  return leftCodePoints.length - rightCodePoints.length;
}

function assertValidOptions(options: AbsNewsDigestSelectionOptionsV1): void {
  if (
    options === null
    || typeof options !== "object"
    || !Number.isFinite(options.nowMs)
    || !Number.isFinite(options.windowHours)
    || options.windowHours <= 0
    || options.windowHours > 168
    || !Number.isInteger(options.limit)
    || options.limit < 1
    || options.limit > 100
    || !Number.isInteger(options.maxPerSource)
    || options.maxPerSource < 1
    || options.maxPerSource > 100
    || !Number.isFinite(options.minimumScore)
    || options.minimumScore < 0
    || options.minimumScore > 100
  ) {
    throw new Error("invalid_digest_options");
  }
}

export function selectAbsNewsDigestV1(
  stories: readonly AbsNewsStoryV1[],
  options: AbsNewsDigestSelectionOptionsV1,
): AbsNewsDigestSelectionV1 {
  assertValidOptions(options);

  const uniqueStories = new Map<string, AbsNewsStoryV1>();
  for (const story of stories) {
    const existing = uniqueStories.get(story.storyId);
    if (existing !== undefined) {
      if (existing.storyDigest !== story.storyDigest) throw new Error("conflicting_story_identity");
      continue;
    }
    uniqueStories.set(story.storyId, story);
  }

  const windowMs = options.windowHours * 60 * 60 * 1_000;
  const ranked: RankedStory[] = [];
  for (const story of uniqueStories.values()) {
    if (
      story.verificationState !== "verified"
      || story.queue === "archive"
      || !Number.isFinite(story.priorityScore)
      || story.priorityScore < options.minimumScore
    ) continue;

    const timestampMs = Date.parse(story.publishedAt ?? story.discoveredAt);
    if (!Number.isFinite(timestampMs) || timestampMs > options.nowMs || options.nowMs - timestampMs > windowMs) continue;
    ranked.push({ story, timestampMs });
  }

  ranked.sort((left, right) => (
    right.story.priorityScore - left.story.priorityScore
    || right.timestampMs - left.timestampMs
    || compareCodePoints(left.story.storyId, right.story.storyId)
  ));

  const selectedStoryIds: string[] = [];
  const selectedClusters = new Set<string>();
  const sourceCounts = new Map<string, number>();
  for (const { story } of ranked) {
    if (selectedStoryIds.length >= options.limit) break;
    if (selectedClusters.has(story.clusterId)) continue;
    const sourceCount = sourceCounts.get(story.canonicalHost) ?? 0;
    if (sourceCount >= options.maxPerSource) continue;

    selectedStoryIds.push(story.storyId);
    selectedClusters.add(story.clusterId);
    sourceCounts.set(story.canonicalHost, sourceCount + 1);
  }

  const selected = new Set(selectedStoryIds);
  const deferredStoryIds = [...uniqueStories.keys()]
    .filter((storyId) => !selected.has(storyId))
    .sort(compareCodePoints);
  return { selectedStoryIds, deferredStoryIds };
}
