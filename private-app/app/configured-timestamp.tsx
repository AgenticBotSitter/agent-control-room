"use client";

import { useProductConfiguration } from "./product-configuration";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function relativeTimestampAge(value: string, now = Date.now()) {
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return "age unavailable";
  const difference = instant - now;
  const magnitude = Math.abs(difference);
  if (magnitude < MINUTE) return difference >= 0 ? "now" : "just now";
  const [unit, milliseconds]: [Intl.RelativeTimeFormatUnit, number] = magnitude < HOUR ? ["minute", MINUTE]
    : magnitude < DAY ? ["hour", HOUR] : ["day", DAY];
  const amount = Math.round(difference / milliseconds);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" })
    .format(amount, unit);
}

export function formatConfiguredTimestamp(value: string, timezone: string, now = Date.now()) {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return { absolute: "Time unavailable", relative: "age unavailable" };
  return {
    absolute: new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(instant),
    relative: relativeTimestampAge(value, now),
  };
}

/** Shows a configured-zone instant alongside a concise relative age. */
export function ConfiguredTimestamp({ value, prefix }: { value: string; prefix?: string }) {
  const timezone = useProductConfiguration()?.defaultTimezone ?? "UTC";
  const timestamp = formatConfiguredTimestamp(value, timezone);
  return <time dateTime={value} title={`${timestamp.absolute} (${timezone})`} suppressHydrationWarning>
    {prefix ? `${prefix} ` : ""}{timestamp.absolute} · {timestamp.relative}
  </time>;
}
