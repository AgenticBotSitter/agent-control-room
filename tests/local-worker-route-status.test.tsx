import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalWorkerRouteStatus } from "../private-app/app/local-worker-route-status";
import { localHarnessCapabilitiesV1 } from "../src/harness/v1/local-harness-capabilities";

test("local worker status is explicit about missing or unavailable saved setup", () => {
  const loading = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "loading" }));
  assert.match(loading, /Checking saved local worker setup/);
  const unavailable = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "unavailable" }));
  assert.match(unavailable, /Local worker routes are unavailable/);
  assert.match(unavailable, /does not guess/);
  const absent = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "available" }));
  assert.match(absent, /Not configured/);
  for (const html of [loading, unavailable, absent]) assert.match(html, /href="\/setup"/);
  assert.doesNotMatch(`${loading}${unavailable}${absent}`, /<button|<form|<input|running now/i);
});

test("local worker status maps proof states without claiming a running worker", () => {
  const capabilities = [
    { ...localHarnessCapabilitiesV1[0]!, state: "setup_required" as const },
    { ...localHarnessCapabilitiesV1[1]!, state: "setup_needs_attention" as const },
    { ...localHarnessCapabilitiesV1[2]!, state: "not_available" as const },
  ];
  const html = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "available", setup: {
    localCapabilities: capabilities,
  } as never }));
  for (const label of ["Hermes Agent", "Claude Code", "Codex", "Qualification required", "Needs owner attention", "Not available on this computer"])
    assert.match(html, new RegExp(label));
  assert.match(html, /never called running here without a current task record/);
  assert.match(html, /This panel has no current route-bound task observation/);
  assert.match(html, /href="\/setup"/);
  assert.doesNotMatch(html, /worker:|sha256:|token|password|provider|model|<button|<form|<input/);
  const enablement = renderToStaticMarkup(createElement(LocalWorkerRouteStatus, { state: "available", setup: {
    localCapabilities: [{ ...localHarnessCapabilitiesV1[0]!, state: "owner_enablement_required" as const }],
  } as never }));
  assert.match(enablement, /Ready for owner enablement/);
  assert.match(enablement, /does not mean this worker is running/);
});
