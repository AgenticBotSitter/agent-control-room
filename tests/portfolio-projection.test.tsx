import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PortfolioProjection } from "../app/components/portfolio-projection";

test("CR6E portfolio projection reports canonical counts without a progress or dispatch claim", () => {
  const html = renderToStaticMarkup(<PortfolioProjection projects={[{ projectId: "project:1", workflowCount: 2, activeJobCount: 1, waitingApprovalJobCount: 1, failedJobCount: 0, lastActivityAt: "2026-08-27T12:00:00.000Z" }]} />);
  assert.match(html, /Protected project/); assert.match(html, /Waiting approval/); assert.match(html, /Read-only observation/); assert.doesNotMatch(html, /<button/);
});
