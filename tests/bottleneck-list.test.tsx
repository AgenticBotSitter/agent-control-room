import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BottleneckList } from "../app/components/bottleneck-list";

test("CR6E bottleneck list renders declared pressure without an operational control", () => {
  const html = renderToStaticMarkup(<BottleneckList bottlenecks={[{ resourceKey: "gpu:local", utilizationPercent: 100, blockedWorkItemIds: ["work:1", "work:2"], explanation: "Declared GPU capacity is fully reserved." }]} />);
  assert.match(html, /100% utilized/);
  assert.match(html, /2 blocked work items/);
  assert.match(html, /Capacity is not changed here/);
});

test("CR6E bottleneck list has a protected empty state", () => {
  assert.match(renderToStaticMarkup(<BottleneckList bottlenecks={[]} />), /No protected bottleneck facts/);
});
