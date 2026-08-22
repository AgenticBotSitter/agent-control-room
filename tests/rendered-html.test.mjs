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
  assert.match(html, /No live connections/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/i);
});

test("server-renders project and worker drill-down routes", async () => {
  const project = await render("/projects/project.wayfarer.lazy-river");
  assert.equal(project.status, 200);
  assert.match(await project.text(), /Lazy River Pilot/);

  const worker = await render("/workers/worker.mac-m4");
  assert.equal(worker.status, 200);
  assert.match(await worker.text(), /M4 Wayfarer/);
});
