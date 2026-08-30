import assert from "node:assert/strict";
import test from "node:test";

async function render(pathname = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${pathname}`, { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the Control Room portfolio", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Control Room<\/title>/i);
  assert.match(html, /Everything moving, in one room\./);
  assert.match(html, /Wayfarer Studio/);
  assert.match(html, /Content Blooms/);
  assert.match(html, /Website Operations/);
  assert.match(html, /Simulation only/);
  assert.match(html, /No protected data is being claimed/);
  assert.match(html, /Needs Me/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders project and worker drill-down routes", async () => {
  const project = await render("/projects/project.wayfarer.lazy-river");
  assert.equal(project.status, 200);
  const projectHtml = await project.text();
  assert.match(projectHtml, /Lazy River Pilot/);
  assert.match(projectHtml, /Skip to project details/);
  assert.match(projectHtml, /synthetic fixture/i);
  assert.match(projectHtml, /Episode control surface/);
  assert.match(projectHtml, /Unreal remains blocked/);
  assert.match(projectHtml, /Unreal scene\/render readiness/);
  assert.match(projectHtml, /Disabled · no attempt/);
  assert.match(projectHtml, /Native benchmark gate/);
  assert.match(projectHtml, /prerequisites evidenced/);
  assert.match(projectHtml, /Frozen native boundary/);
  assert.match(projectHtml, /Unreal executor/);
  assert.match(projectHtml, /Disabled before start/);
  assert.match(projectHtml, /Upload and publication boundaries/);
  assert.match(projectHtml, /Private distribution upload/);
  assert.match(projectHtml, /Public episode publication/);
  assert.match(projectHtml, /Six-stage production pipeline/);
  assert.match(projectHtml, /Independent review queue/);
  assert.match(projectHtml, /fake metadata only/);
  assert.match(projectHtml, /GPU and scratch simulations/);
  assert.match(projectHtml, /presentation-only/);
  assert.match(projectHtml, /Your agent team, in one room/);
  assert.match(projectHtml, /Conversation ceiling/);
  assert.match(projectHtml, /Compare durable War Room persistence options/);
  assert.match(projectHtml, /Not requested/);
  assert.doesNotMatch(projectHtml, /Start render|Publish now|No approval controls<\/button>/i);

  const absProject = await render("/projects/project.abs.ai-tech-news");
  assert.equal(absProject.status, 200);
  const absProjectHtml = await absProject.text();
  assert.match(absProjectHtml, /AI and Tech Intelligence/);
  assert.match(absProjectHtml, /project workspace/i);
  assert.match(absProjectHtml, /Daily brief/);
  assert.match(absProjectHtml, /Research this/);
  assert.match(absProjectHtml, /Live collection/);
  assert.match(absProjectHtml, /Owner Authority Required/);
  assert.match(absProjectHtml, /News queue filters/i);
  assert.match(absProjectHtml, /View evidence/);
  assert.match(absProjectHtml, /Proposal editor/);
  assert.match(absProjectHtml, /authenticated SQLite store/);
  assert.match(absProjectHtml, /Your agent team, in one room/);
  assert.match(absProjectHtml, /Hermes-style team visibility, Control Room authority/);

  const worker = await render("/workers/worker.mac-m4");
  assert.equal(worker.status, 200);
  const workerHtml = await worker.text();
  assert.match(workerHtml, /M4 Wayfarer/);
  assert.match(workerHtml, /Request drain/);
  assert.match(workerHtml, /node\.mac-m4/);
  assert.match(workerHtml, /CR-5D execution evidence/);
  assert.match(workerHtml, /Synthetic execution timeline/);
  assert.match(workerHtml, /Independent verification has not been performed/);
  assert.match(workerHtml, /Skip to worker details/);
  assert.match(workerHtml, /Protected fleet status is available/);
});
