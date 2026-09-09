import { freshIndustryDiscoveries, sortIndustryItems, splitIndustryLibrary,
  type IndustrySortOrder } from "../../vendor/control-center/industry";
import type { LiveStory } from "../../vendor/control-center/types";
import type { NewsPage } from "./news-wire";

export type NewsReadingView = "fresh" | "history" | "archive";
/** Translate presentation fields only. Never merge canonical identities or alter evidence. */
export function newsReadingView(stories: NewsPage["stories"], view: NewsReadingView,
  order: IndustrySortOrder, observedAt: string) {
  const upstream: LiveStory[] = stories.map(story => ({ id: story.storyId, title: story.title,
    summary: story.summary, url: story.canonicalUrl, source: story.sourceLabel ?? new URL(story.canonicalUrl).hostname,
    publishedAt: story.publishedAt ?? story.discoveredAt ?? "", importanceScore: story.priorityScore,
    ...(story.queue === "archive" ? { workflow: { archiveReason: "user" as const, restoreEligible: false } } : {}) }));
  const { historyItems, archivedItems } = splitIndustryLibrary(upstream);
  const fresh = freshIndustryDiscoveries(historyItems, [], Date.parse(observedAt));
  const selected = view === "archive" ? archivedItems : view === "fresh" ? fresh : historyItems;
  const byId = new Map(stories.map(story => [story.storyId, story]));
  return { stories: sortIndustryItems(selected, order).map(story => byId.get(story.id)!),
    counts: { fresh: fresh.length, history: historyItems.length, archive: archivedItems.length } };
}
