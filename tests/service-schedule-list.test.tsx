import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ServiceScheduleList } from "../app/components/service-schedule-list";

test("CR6E service and schedule list renders safe status without a control or schedule expression", () => {
  const html = renderToStaticMarkup(<ServiceScheduleList
    services={[{ serviceId: "service:backup", projectId: "project:1", serviceType: "service:backup", state: "degraded", statusCode: "backup_stale", lastObservedAt: "2026-08-27T12:00:00.000Z" }]}
    schedules={[{ scheduleId: "schedule:backup", projectId: "project:1", state: "active", scheduleType: "cron", targetType: "service_check", targetId: "service:backup", timezone: "UTC", idempotencyWindowSeconds: 60 }]}
  />);
  assert.match(html, /Services/);
  assert.match(html, /Backup Stale/);
  assert.match(html, /No next run recorded/);
  assert.match(html, /status, not a dispatch control/);
  assert.doesNotMatch(html, /\* \* \*/);
  assert.doesNotMatch(html, /<button/);
});

test("CR6E service and schedule list gives both protected empty states", () => {
  const html = renderToStaticMarkup(<ServiceScheduleList services={[]} schedules={[]} />);
  assert.match(html, /No protected services/);
  assert.match(html, /No protected schedules/);
});
