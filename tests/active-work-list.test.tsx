import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ActiveWorkList } from "../app/components/active-work-list";

test("CR6E active work list describes observed job state without a dispatch claim", () => {
  const html = renderToStaticMarkup(<ActiveWorkList work={[{ jobId: "job:1", projectId: "project:1", state: "running", jobType: "synthetic:render", priority: 80, requiredCapability: "capability:render", updatedAt: "2026-08-27T12:00:00.000Z" }]} />);
  assert.match(html, /Running/);
  assert.match(html, /Priority 80/);
  assert.match(html, /observation, not dispatch authority/);
});

test("CR6E active work list has a protected empty state", () => {
  assert.match(renderToStaticMarkup(<ActiveWorkList work={[]} />), /No protected active work/);
});
