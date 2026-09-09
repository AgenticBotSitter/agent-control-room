import type { LiveStory } from "./types";

export const INDUSTRY_FRESHNESS_HOURS = 24;
export const INDUSTRY_FUTURE_TOLERANCE_MINUTES = 10;

export function isFreshTimestamp(
  value: string,
  hours: number,
  now = Date.now(),
  futureToleranceMinutes = INDUSTRY_FUTURE_TOLERANCE_MINUTES,
) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || hours <= 0) return false;
  const futureTolerance = Math.max(0, futureToleranceMinutes) * 60 * 1000;
  return timestamp >= now - hours * 60 * 60 * 1000 && timestamp <= now + futureTolerance;
}

export function filterFreshStories(items: LiveStory[], hours = INDUSTRY_FRESHNESS_HOURS, now = Date.now()) {
  return items.filter((item) => isFreshTimestamp(item.publishedAt, hours, now));
}

export function filterPlausiblyDatedStories(
  items: LiveStory[],
  now = Date.now(),
  futureToleranceMinutes = INDUSTRY_FUTURE_TOLERANCE_MINUTES,
) {
  const latest = now + Math.max(0, futureToleranceMinutes) * 60 * 1000;
  return items.filter((item) => {
    const timestamp = Date.parse(item.publishedAt);
    return !Number.isFinite(timestamp) || timestamp <= latest;
  });
}
