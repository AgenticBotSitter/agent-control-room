import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceIncidentList } from "../app/components/service-incident-list";

test("CR6E incident list renders safe reason and remedy codes without a repair claim", () => {
  const html = renderToStaticMarkup(<ServiceIncidentList incidents={[{ id: "incident:1", serviceId: "service:backup", severity: "critical", state: "open", reasonCode: "backup_stale", remedyCode: "inspect_backup", openedAt: "2026-08-27T12:00:00.000Z", lastObservedAt: "2026-08-27T12:01:00.000Z" }]} />);
  assert.match(html, /Backup Stale/);
  assert.match(html, /Inspect Backup/);
  assert.match(html, /cannot make the repair/);
});

test("CR6E incident list has an explicit empty protected state", () => {
  assert.match(renderToStaticMarkup(<ServiceIncidentList incidents={[]} />), /No protected service incidents/);
});
