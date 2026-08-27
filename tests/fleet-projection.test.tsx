import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { FleetProjection } from "../app/components/fleet-projection";

test("CR6E fleet projection distinguishes reported capacity from unavailable capacity", () => {
  const html = renderToStaticMarkup(<FleetProjection workers={[
    { workerId: "node:mac", platform: "macos", state: "online", lastObservedAt: "2026-08-27T12:00:00.000Z", capacityState: "reported", availableSlots: 1, totalSlots: 2, capabilityState: "verified", telemetryState: "fresh" },
    { workerId: "node:linux", platform: "linux", state: "degraded", stateReasonCode: "telemetry_stale", lastObservedAt: "2026-08-27T11:00:00.000Z", capacityState: "unavailable", capabilityState: "unavailable", telemetryState: "stale" },
  ]} />);
  assert.match(html, /1\/2 slots available/);
  assert.match(html, /Capacity is unavailable/);
  assert.match(html, /No route or dispatch decision implied/);
});

test("CR6E fleet projection handles an empty protected projection", () => {
  assert.match(renderToStaticMarkup(<FleetProjection workers={[]} />), /No protected worker facts are currently recorded/);
});
