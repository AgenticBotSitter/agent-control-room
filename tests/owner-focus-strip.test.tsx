import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OwnerFocusStrip } from "../app/components/owner-focus-strip";
import type { OwnerFocusPinV1 } from "../src/operator-surfaces/v1";

const pins: OwnerFocusPinV1[] = [{ id: "focus:1", tenantId: "tenant:1", projectId: "project:1", level: "p0", reason: "Keep the critical project visible", createdAt: "2026-08-27T12:00:00.000Z" }];
function render(items = pins): string { return renderToStaticMarkup(createElement(OwnerFocusStrip, { pins: items, projects: [{ id: "project:1", label: "Project One" }], onPrepare: () => {} })); }

test("renders P0 intent with explicit non-bypass authority language", () => {
  const html = render();
  assert.match(html, />P0</);
  assert.match(html, /Project One/);
  assert.match(html, /Keep the critical project visible/);
  assert.match(html, /cannot change fairness, authority, capacity, or dispatch/);
  assert.match(html, /Nothing has been saved or scheduled/);
  assert.match(html, /Prepare P0/);
  assert.match(html, /Prepare Today/);
  assert.ok(!html.toLowerCase().includes("priority override"));
});

test("renders clear preparation and an empty state without claiming a saved change", () => {
  assert.match(render(), /Prepare clear/);
  assert.match(render([]), /No P0 or Today focus is recorded/);
});

test("escapes hostile focus text", () => {
  const html = render([{ ...pins[0], reason: '<img src=x onerror=alert(1)>' }]);
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
});
