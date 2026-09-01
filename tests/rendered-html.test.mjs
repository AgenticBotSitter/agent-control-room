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
  assert.match(projectHtml, /Skip to project workspace/);
  assert.match(projectHtml, /synthetic.*fixture/i);
  assert.match(projectHtml, /Project Workspace/);
  assert.match(projectHtml, /Shared project view/);
  assert.match(projectHtml, /presentation-only/i);
  assert.match(projectHtml, /Development fixture mode/);
  assert.match(projectHtml, /Protected project read is loading/);

  const wayfarerExtension = await render("/projects/project.wayfarer.lazy-river/media-graph");
  assert.equal(wayfarerExtension.status, 200);
  const wayfarerHtml = await wayfarerExtension.text();
  assert.match(wayfarerHtml, /Media graph/);
  assert.match(wayfarerHtml, /Project-specific view/);
  assert.match(wayfarerHtml, /Episode control surface/);
  assert.match(wayfarerHtml, /Unreal remains blocked/);
  assert.match(wayfarerHtml, /Unreal scene\/render readiness/);
  assert.match(wayfarerHtml, /Disabled · no attempt/);
  assert.match(wayfarerHtml, /Native benchmark gate/);
  assert.match(wayfarerHtml, /prerequisites evidenced/);
  assert.match(wayfarerHtml, /Frozen native boundary/);
  assert.match(wayfarerHtml, /Unreal executor/);
  assert.match(wayfarerHtml, /Disabled before start/);
  assert.match(wayfarerHtml, /Upload and publication boundaries/);
  assert.match(wayfarerHtml, /Private distribution upload/);
  assert.match(wayfarerHtml, /Public episode publication/);
  assert.match(wayfarerHtml, /Six-stage production pipeline/);
  assert.match(wayfarerHtml, /Independent review queue/);
  assert.match(wayfarerHtml, /fake metadata only/);
  assert.match(wayfarerHtml, /GPU and scratch simulations/);
  assert.doesNotMatch(wayfarerHtml, /Start render|Publish now|No approval controls<\/button>/i);

  const wayfarerAgents = await render("/projects/project.wayfarer.lazy-river/agents");
  assert.equal(wayfarerAgents.status, 200);
  const wayfarerAgentsHtml = await wayfarerAgents.text();
  assert.match(wayfarerAgentsHtml, /Your agent team, in one room/);
  assert.match(wayfarerAgentsHtml, /Conversation ceiling/);
  assert.match(wayfarerAgentsHtml, /Compare durable War Room persistence options/);
  assert.match(wayfarerAgentsHtml, /Not requested/);

  const absProject = await render("/projects/project.abs.ai-tech-news");
  assert.equal(absProject.status, 200);
  const absProjectHtml = await absProject.text();
  assert.match(absProjectHtml, /AI and Tech Intelligence/);
  assert.match(absProjectHtml, /project workspace/i);
  assert.match(absProjectHtml, /href="\/projects\/project\.abs\.ai-tech-news\/ai-tech-news"/);

  const absNews = await render("/projects/project.abs.ai-tech-news/ai-tech-news");
  assert.equal(absNews.status, 200);
  const absNewsHtml = await absNews.text();
  assert.match(absNewsHtml, /Daily brief/);
  assert.match(absNewsHtml, /Research this/);
  assert.match(absNewsHtml, /Live collection/);
  assert.match(absNewsHtml, /Owner Authority Required/);
  assert.match(absNewsHtml, /News queue filters/i);
  assert.match(absNewsHtml, /View evidence/);
  assert.match(absNewsHtml, /Proposal editor/);
  assert.match(absNewsHtml, /authenticated SQLite store/);

  const absAgents = await render("/projects/project.abs.ai-tech-news/agents");
  assert.equal(absAgents.status, 200);
  const absAgentsHtml = await absAgents.text();
  assert.match(absAgentsHtml, /Your agent team, in one room/);
  assert.match(absAgentsHtml, /Hermes-style team visibility, Control Room authority/);

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

test("server-renders Idea Lab and its promoted project workspace", async () => {
  const ideas = await render("/ideas");
  assert.equal(ideas.status, 200);
  const ideaHtml = await ideas.text();
  assert.match(ideaHtml, /Idea Lab/);
  assert.match(ideaHtml, /Turn a rough business idea into a monitored project/);
  assert.match(ideaHtml, /Customer Lens/);
  assert.match(ideaHtml, /Red Team/);
  assert.match(ideaHtml, /Advisory score/);
  assert.match(ideaHtml, /No Hermes, Codex, or local-model provider was contacted/);
  assert.match(ideaHtml, /Protected runtime not configured\. Controls are safely disabled\./);
  assert.match(ideaHtml, /<button type="submit" disabled="">Create session<\/button>/);
  assert.doesNotMatch(ideaHtml, /Dispatch now/i);

  const project = await render("/projects/project%3Alocal-trades-ai-desk");
  assert.equal(project.status, 200);
  const projectHtml = await project.text();
  assert.match(projectHtml, /Local Trades AI Desk/);
  assert.match(projectHtml, /Owner-promoted Idea Lab session/);
  assert.match(projectHtml, /Lifecycle version .*1/);
  assert.match(projectHtml, /Idea origin/);
  assert.match(projectHtml, /presentation-only/i);
});

test("server-renders the protected Connection Center shell without inventing live state", async () => {
  const response = await render("/connections");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Connection Center/);
  assert.match(html, /which Hermes version they match/);
  assert.match(html, /Loading protected connection inventory/);
  assert.match(html, /Protected read/);
  assert.doesNotMatch(html, /Connect now|Start Hermes|Run qualification/i);
});
