import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { HomeDashboard, type HomeDashboardState } from "../private-app/app/home-workspace";

const allUnavailable: HomeDashboardState = { activity: { state: "unavailable" }, projects: { state: "unavailable" },
  attention: { state: "unavailable" }, connections: { state: "unavailable" } };

// R7-05: assert each pill itself, not the separate pagination note below it.
for (const panel of ["home-active", "home-results", "home-projects"] as const) {
  test(`R7-05 ${panel} count distinguishes a bounded page from an exact total`, () => {
    const at = "2026-10-02T09:00:00.000Z";
    for (const omitted of [false, true]) {
      const task = (index: number) => ({ projectId: "project:test", requestId: `request:${index}`, jobId: `job:${index}`,
        title: `Task ${index}`, state: "running" as const, version: 1, createdAt: at, updatedAt: at });
      const data: HomeDashboardState = { ...allUnavailable,
        activity: { state: "ready", value: { active: Array.from({ length: 10 }, (_, i) => task(i)),
          recentResults: Array.from({ length: 10 }, (_, i) => ({ task: { ...task(i), state: "succeeded" as const },
            artifact: { artifactId: `artifact:${i}`, attemptId: `attempt:${i}`, runId: `run:${i}`,
              contentHash: `sha256:${"a".repeat(64)}`, sizeBytes: 42, receivedAt: at,
              byteCheck: "matched_recorded_claim" as const, qualityAccepted: false } })),
          additionalActiveOmitted: panel === "home-active" && omitted,
          additionalResultsOmitted: panel === "home-results" && omitted,
          resultSource: "configured", observedAt: at, startsWork: false } },
        projects: { state: "ready", value: { projects: Array.from({ length: 50 }, (_, i) => ({ projectId: `project:${i}`,
          title: `Project ${i}`, summary: "Saved project", origin: "ordinary" as const, lifecycle: "active" as const,
          version: 1, createdAt: at, updatedAt: at, lifecycleEditable: true })),
          nextCursor: panel === "home-projects" && omitted ? "project:49" : null, canCreate: false,
          sources: { ordinary: "included", ideas: "not_configured" } } } };
      const dom = new JSDOM(renderToStaticMarkup(createElement(HomeDashboard, { data })));
      const document = dom.window.document;
      try {
        for (const id of ["home-active", "home-results", "home-projects"]) {
          const count = id === "home-projects" ? 50 : 10;
          assert.equal(document.querySelector(`[aria-labelledby="${id}"] .private-count`)?.textContent,
            `${count}${id === panel && omitted ? "+" : ""}`, `${id} must use its own pagination evidence`);
        }
      } finally { dom.window.close(); }
    }
  });
}
