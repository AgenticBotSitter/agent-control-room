import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfiguredTimestamp, formatConfiguredTimestamp, relativeTimestampAge } from "../private-app/app/configured-timestamp";

test("configured timestamps keep the absolute instant in the configured timezone and add a concise age", () => {
  const timestamp = "2026-09-13T12:00:00.000Z";
  const denver = formatConfiguredTimestamp(timestamp, "America/Denver", Date.parse("2026-09-13T12:02:00.000Z"));
  const utc = formatConfiguredTimestamp(timestamp, "UTC", Date.parse("2026-09-13T12:02:00.000Z"));
  assert.notEqual(denver.absolute, utc.absolute);
  // The month/day assertion reads the locale-independent parts, because the
  // parts are now requested explicitly (R4U-12) and this locale formats as
  // "9/13/2026" rather than "Sep 13, 2026". The date is still there; asserting
  // on en-US's month NAME would have pinned a locale, not the behaviour.
  assert.match(denver.absolute, /\b13\b/);
  assert.match(denver.relative, /2/);
  assert.equal(relativeTimestampAge(timestamp, Date.parse("2026-09-13T12:00:20.000Z")), "just now");
});

test("configured timestamp is semantic and has a safe invalid-time fallback", () => {
  const html = renderToStaticMarkup(createElement(ConfiguredTimestamp, { value: "2026-09-13T12:00:00.000Z", prefix: "Updated" }));
  assert.match(html, /<time dateTime="2026-09-13T12:00:00.000Z"/);
  assert.match(html, /Updated/);
  assert.deepEqual(formatConfiguredTimestamp("not-a-time", "UTC"),
    { absolute: "Time unavailable", relative: "age unavailable", zone: "" });
});

// R4U-12: "all times are shown in UTC with no label".
//
// The measurement: browser zone America/Denver, real time Oct 1 9:47 PM, and
// the page said "Updated Oct 2, 2026, 3:40 AM" -- correct in UTC, six hours
// from the owner's clock, with nothing on screen saying which. The zone WAS
// there, in a `title` attribute, which is a hover a phone never shows; the Pause
// panel on the same Home page said "Set 10/1/2026, 9:39:44 PM" because it
// called toLocaleString() with no zone and therefore used the browser's.
//
// So there were two different conventions on one screen, and neither named its
// zone. The fix is to print the zone in the visible text, always, and to use one
// formatter for both -- a timestamp an owner cannot place in their own day is
// worse than no timestamp, because it looks authoritative.
test("the visible time always names its zone, and the zone is the one the owner reads in", () => {
  const timestamp = "2026-10-02T03:40:00.000Z";
  const denver = formatConfiguredTimestamp(timestamp, "America/Denver");
  // The zone appears in the FORMATTED TEXT, not only in the hover title. A
  // `title` is invisible on a phone, which is where this defect was measured,
  // so a fix that only set `title` would pass a test reading `title`.
  assert.match(denver.absolute, /\b(MDT|MST)\b/,
    `the zone abbreviation must be in the visible text, not only a hover title: ${denver.absolute}`);
  // The SAME instant in two zones must differ in BOTH the clock time and the
  // zone. Asserting only "differs" would pass if the label were the only thing
  // that changed, which is exactly the decorative case: a "9:40 PM MDT" that is
  // really 9:40 PM UTC is worse than no label, because it looks right.
  const utc = formatConfiguredTimestamp(timestamp, "UTC");
  assert.match(utc.absolute, /\bUTC\b/, `the UTC rendering must name UTC: ${utc.absolute}`);
  const denverClock = /\d{1,2}:\d{2}/.exec(denver.absolute)?.[0];
  const utcClock = /\d{1,2}:\d{2}/.exec(utc.absolute)?.[0];
  assert.notEqual(denverClock, utcClock,
    "both zones printed the same clock time, so the conversion is not happening");
  // The zone NAME is carried, so a page can name it in prose.
  assert.equal(denver.zone, "America/Denver");
  assert.equal(utc.zone, "UTC");
  // And an unparsable instant says so and claims no zone.
  const broken = formatConfiguredTimestamp("not-a-time", "America/Denver");
  assert.match(broken.absolute, /unavailable/i);
  assert.equal(broken.zone, "", "a time that could not be read must not name a zone it was never converted into");
});

test("the rendered element carries the zone in its text, not only in a hover title", () => {
  const html = renderToStaticMarkup(createElement(ConfiguredTimestamp,
    { value: "2026-10-02T03:40:00.000Z", prefix: "Updated" }));
  // Strip the attributes and look at what a phone actually paints.
  const visible = html.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ");
  assert.match(visible, /\b(MDT|MST|UTC)\b/,
    `the zone must be in the text a phone shows; the rendered text was: ${visible}`);
  assert.match(html, /<time dateTime="2026-10-02T03:40:00.000Z"/,
    "the machine-readable instant stays exactly as sent");
});
