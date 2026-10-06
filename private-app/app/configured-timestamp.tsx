"use client";

import { usePresentationNow } from "./presentation-clock";
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
  if (Number.isNaN(instant.getTime())) return { absolute: "Time unavailable", relative: "age unavailable", zone: "" };
  // THE ZONE IS IN THE VISIBLE TEXT, because it used to be only in a `title`
  // (R4U-12). A hover a phone never shows is not a label. The round-4 browser
  // run measured exactly that: an owner in America/Denver reading "Updated Oct 2,
  // 2026, 3:40 AM" -- correct in UTC, six hours from their own clock, with
  // nothing on screen naming it. A timestamp an owner cannot place in their own
  // day is worse than none, because it looks authoritative. The Pause panel on
  // that same page disagreed with it, calling toLocaleString() with no zone and
  // so using the browser's: one page, two conventions, neither naming itself.
  //
  // The zone NAME is returned too, so a page can name it in prose when it needs
  // to.
  // `timeZoneName` CANNOT be combined with `dateStyle`/`timeStyle` -- that
  // combination throws `Invalid option` in Intl.DateTimeFormat, which is what
  // the first attempt at this fix did and what these four failures were. So the
  // parts are requested explicitly, the same shapes the shorthand stood for:
  // numeric month, two-digit day, two-digit hour and minute.
  //
  // The parts are then asked for as a `formatToParts` list so the zone
  // abbreviation is appended where the locale puts it -- after the time in
  // en-US, before it in others -- rather than pasted into one fixed spot.
  const formatter = new Intl.DateTimeFormat(undefined, { timeZone: timezone,
    year: "numeric", month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
  const parts = formatter.formatToParts(instant);
  const zonePart = parts.find(part => part.type === "timeZoneName");
  const withoutZone = parts.filter(part => part.type !== "timeZoneName");
  return {
    absolute: `${withoutZone.map(part => part.value).join("").replace(/[  ]/gu, " ").trim()} ${zonePart?.value ?? ""}`.trim(),
    relative: relativeTimestampAge(value, now),
    zone: timezone,
  };
}

/** Shows a configured-zone instant alongside a concise relative age. */
export function ConfiguredTimestamp({ value, prefix }: { value: string; prefix?: string }) {
  const timezone = useProductConfiguration()?.defaultTimezone ?? "UTC";
  const timestamp = formatConfiguredTimestamp(value, timezone, usePresentationNow());
  return <time dateTime={value} title={`${timestamp.absolute} (${timestamp.zone})`} suppressHydrationWarning>
    {prefix ? `${prefix} ` : ""}{timestamp.absolute} · {timestamp.relative}
  </time>;
}
