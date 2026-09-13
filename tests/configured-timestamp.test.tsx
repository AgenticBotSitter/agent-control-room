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
  assert.match(denver.absolute, /Sep.*13/);
  assert.match(denver.relative, /2/);
  assert.equal(relativeTimestampAge(timestamp, Date.parse("2026-09-13T12:00:20.000Z")), "just now");
});

test("configured timestamp is semantic and has a safe invalid-time fallback", () => {
  const html = renderToStaticMarkup(createElement(ConfiguredTimestamp, { value: "2026-09-13T12:00:00.000Z", prefix: "Updated" }));
  assert.match(html, /<time dateTime="2026-09-13T12:00:00.000Z"/);
  assert.match(html, /Updated/);
  assert.deepEqual(formatConfiguredTimestamp("not-a-time", "UTC"), { absolute: "Time unavailable", relative: "age unavailable" });
});
