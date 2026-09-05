import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskResultsPanel, PrivateTaskResults } from "../private-app/app/task-results";
import { createTaskBrowserClient } from "../src/web/v1/task-browser-client";
import { createTaskHttpHandler } from "../src/web/v1/task-http";
import { taskResultContentSchema, taskResultsPageSchema } from "../src/web/v1/task-result-wire";
import { webNativeResultFixture } from "./helpers/web-native-result";
import { request, origin } from "./helpers/web-foundation";
import { binding, instant } from "./hermes-native-fixture";
import { at } from "./native-task-fixture";
import { sha256Digest } from "../src/security";

test("browser reads exact bytes through the real authenticated handler; metadata refresh never fetches content or writes", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("A readable result <b>as text</b>.");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const handler = createTaskHttpHandler({ origin, trust: f.accessTrust, service: f.tasks, clock: () => instant + 6000 });
  const calls: string[] = [];
  const client = createTaskBrowserClient(async (url, init) => {
    assert.equal(init?.method, "GET"); assert.equal(init?.cache, "no-store"); assert.equal(init?.redirect, "error");
    calls.push(String(url)); return handler(request(String(url), "GET", undefined, undefined, f.jwt));
  });
  await client.results(binding.projectId, binding.jobId); await client.results(binding.projectId, binding.jobId);
  assert.equal(calls.every(path => path.endsWith("/results")), true);
  const content = await client.resultContent(binding.projectId, binding.jobId, receipt.artifactId);
  assert.equal(content.text, "A readable result <b>as text</b>."); assert.equal(calls.length, 3);
});

test("browser rejects changed result bytes, wrong scope and invalid matching-review claims", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("Exact result");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const content = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  for (const changed of [{ ...content, text: "Altered result" }, { ...content, jobId: "job:other" },
    { ...content, artifact: { ...content.artifact, artifactId: "artifact:other" } }]) {
    const client = createTaskBrowserClient(async () => Response.json(changed));
    await assert.rejects(client.resultContent(binding.projectId, binding.jobId, receipt.artifactId), { code: "unavailable" });
  }
  await f.reviewTarget(sha256Digest("different bytes"));
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  page.reviews[0].matchingArtifactIds = [receipt.artifactId];
  await assert.rejects(createTaskBrowserClient(async () => Response.json(page)).results(binding.projectId, binding.jobId), { code: "unavailable" });
});

test("result panel displays escaped selectable content and truthful independent review boundaries", async t => {
  const f = await webNativeResultFixture(); t.after(f.close); const input = f.complete("A document <b>not rendered HTML</b>.");
  const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  await f.reviewTarget(sha256Digest("different result"));
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const content = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  const html = renderToStaticMarkup(createElement(TaskResultsPanel, { page, content, pending: false, onOpen() {}, onClose() {} }));
  assert.match(html, /Read result/); assert.match(html, /readOnly=""/); assert.match(html, /&lt;b&gt;not rendered HTML&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<b>not rendered HTML<\/b>|memory:\/\/|node:test|<button[^>]*>Accept/);
  assert.match(html, /does not match any result file/); assert.match(html, /Review and revision commands are not connected/);
  assert.match(html, /not instructions for Control Room/);
});

test("empty, unconfigured and pending results stay separate and server shell contains no records or action callbacks", async t => {
  const f = await webNativeResultFixture(); t.after(f.close);
  const page = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const render = (value = page) => renderToStaticMarkup(createElement(TaskResultsPanel, { page: value, pending: true, onOpen() {}, onClose() {} }));
  assert.match(render(), /No result files have been received/);
  assert.match(render({ ...page, resultSource: "not_configured", reviewSource: "not_configured" }), /Result storage is not configured/);
  const input = f.complete(""); const { receipt } = await f.resultService.ingest(input.raw, input.bytes, f.options(at(2000)));
  const next = taskResultsPageSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId));
  const content = taskResultContentSchema.parse(await f.tasks.results(f.identity, binding.projectId, binding.jobId, receipt.artifactId));
  const html = renderToStaticMarkup(createElement(TaskResultsPanel, { page: next, content, pending: true, onOpen() {}, onClose() {} }));
  assert.match(html, /empty result file \(0 bytes\)/); assert.match(html, /button[^>]*disabled/);
  const shell = renderToStaticMarkup(createElement(PrivateTaskResults, { projectId: binding.projectId, jobId: binding.jobId }));
  assert.match(shell, /Loading protected results and review/); assert.doesNotMatch(shell, /<button|artifact:native|Native task results/);
});
