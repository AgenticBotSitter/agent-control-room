import type { IndustrySourceStatus, LiveStory } from "./types";
import { filterFreshStories, INDUSTRY_FRESHNESS_HOURS } from "./freshness";

export type IndustrySortOrder = "important" | "newest" | "oldest" | "watched";

function storyTimestamp(item: LiveStory) {
  const timestamp = Date.parse(item.publishedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function sortIndustryItems(items: LiveStory[], order: IndustrySortOrder) {
  const sorted = [...items];
  sorted.sort((left, right) => {
    if (order === "important") {
      const importance = (right.importanceScore || 0) - (left.importanceScore || 0);
      if (importance) return importance;
    }
    if (order === "watched") {
      const sourcePriority =
        Number(left.kind === "topic") - Number(right.kind === "topic");
      if (sourcePriority) return sourcePriority;
    }
    const dateOrder = storyTimestamp(right) - storyTimestamp(left);
    if (dateOrder) return order === "oldest" ? -dateOrder : dateOrder;
    return left.id.localeCompare(right.id);
  });
  return sorted;
}

export function splitIndustryLibrary(items: LiveStory[]) {
  const archivedItems: LiveStory[] = [];
  const historyItems: LiveStory[] = [];
  for (const item of items) {
    if (item.workflow?.archiveReason === "user") archivedItems.push(item);
    else historyItems.push(item);
  }
  return { archivedItems, historyItems };
}

export function combineIndustryDiscoveries(siteItems: LiveStory[], topicItems: LiveStory[]) {
  const combined = [...new Map(
    [...siteItems, ...topicItems].map((item) => [item.url || item.id, item]),
  ).values()];
  combined.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
  return combined;
}

export function freshIndustryDiscoveries(
  siteItems: LiveStory[],
  topicItems: LiveStory[],
  now = Date.now(),
) {
  return filterFreshStories(
    combineIndustryDiscoveries(siteItems, topicItems),
    INDUSTRY_FRESHNESS_HOURS,
    now,
  );
}

export function topicDiscoveryStatus(options: {
  endpoint: string;
  itemCount: number;
  keywordCount: number;
  successfulQueries: number;
}): IndustrySourceStatus | null {
  if (options.successfulQueries <= 0) return null;
  return {
    sourceId: "topic-discovery",
    source: "Topic discovery",
    mode: "topics",
    endpoint: options.endpoint,
    state: "live",
    message: `${options.itemCount} current stories across ${options.keywordCount} configured topic${options.keywordCount === 1 ? "" : "s"}`,
  };
}
