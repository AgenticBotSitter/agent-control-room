import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DeliveredFilesPanel } from "../private-app/app/delivered-files";
import {
  ResultFilesUnavailableError,
  createInMemoryResultFilesClient,
  type ResultFileSet,
} from "../src/web/v1/result-files-client-port";

const projectId = "project:files-ui";
const taskId = "job:delivered";
const longName = "世界-🌎-résumé-".repeat(24) + ".html";
const sets: readonly ResultFileSet[] = [{
  id: "result-set:one", projectId, task: { id: taskId, title: "Prepare launch package" }, files: [
    { id: "file:ready", displayName: longName, type: "text/html", size: 1536,
      sha256: `sha256:${"a".repeat(64)}`, producerMachine: "Studio Mac", state: "available", textCopy: { status: "available" } },
    { id: "file:failed", displayName: "partial-video.mp4", type: "video/mp4", size: 5000000,
      sha256: `sha256:${"b".repeat(64)}`, producerMachine: "GPU worker", state: "failed", textCopy: { status: "failed" } },
    { id: "file:refused", displayName: "unsafe-output.zip", type: "application/zip", size: 930,
      sha256: `sha256:${"c".repeat(64)}`, producerMachine: "Remote worker", state: "refused" },
  ],
}];

function render(source = sets) {
  const client = createInMemoryResultFilesClient(source);
  return renderToStaticMarkup(createElement(DeliveredFilesPanel, {
    scope: { projectId, taskId }, data: { state: "ready", sets: source }, client, showTask: true,
  }));
}

test("delivered files lists exact metadata with attachment-only download links", () => {
  const html = render();
  for (const text of ["Delivered files", "Prepare launch package", "text/html", "1.5 KB", "Made by Studio Mac", "Text copy"])
    assert.match(html, new RegExp(text));
  assert.match(html, /href="data:application\/octet-stream," download=""/);
  assert.match(html, /href="data:text\/plain;charset=utf-8," download=""/);
  assert.doesNotMatch(html, /<(?:iframe|embed|object|img|video|audio|pre)\b/i);
});

test("empty delivered files is distinct from an unavailable catalog", () => {
  const client = createInMemoryResultFilesClient([]);
  const empty = renderToStaticMarkup(createElement(DeliveredFilesPanel,
    { scope: { projectId }, data: { state: "ready", sets: [] }, client }));
  assert.match(empty, /No files have been delivered yet/);
  const unavailable = renderToStaticMarkup(createElement(DeliveredFilesPanel,
    { scope: { projectId }, data: { state: "unavailable" }, client }));
  assert.match(unavailable, /No empty list or successful delivery is inferred/);
  assert.doesNotMatch(unavailable, /No files have been delivered yet/);
});

test("failed and refused files are shown first and cannot produce download links", () => {
  const html = render();
  assert.ok(html.indexOf("partial-video.mp4") < html.indexOf(longName));
  assert.ok(html.indexOf("unsafe-output.zip") < html.indexOf(longName));
  assert.match(html, /Delivery failed/); assert.match(html, /result is incomplete and needs attention/);
  assert.match(html, /Delivery refused/); assert.match(html, /No unverified bytes are offered/);
  assert.equal((html.match(/>Download<\/a>/g) ?? []).length, 1);
  assert.equal((html.match(/Download unavailable/g) ?? []).length, 2);
});

test("long Unicode names use CSS truncation without slicing or corrupting the download name", () => {
  const html = render();
  assert.ok(html.includes(longName));
  assert.doesNotMatch(html, /�/);
  assert.match(html, new RegExp(`title="${longName}"`));
  const css = readFileSync(new URL("../private-app/app/private.css", import.meta.url), "utf8");
  assert.match(css, /\.private-delivered-file-name[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.private-delivered-file[^}]*grid-template-columns:\s*1fr/);
});

test("untrusted metadata stays text and an unsafe download URL is refused", () => {
  const hostileName = `\"><img src=x onerror=alert(1)>🌎.svg`;
  const hostile: ResultFileSet = { ...sets[0]!, files: [{ ...sets[0]!.files[0]!, displayName: hostileName,
    producerMachine: "<script>bad()</script>" }] };
  const unsafeClient = { ...createInMemoryResultFilesClient([hostile]), downloadUrl: () => "javascript:alert(1)" };
  const html = renderToStaticMarkup(createElement(DeliveredFilesPanel, { scope: { projectId, taskId },
    data: { state: "ready", sets: [hostile] }, client: unsafeClient }));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /javascript:|<img|<script/);
  assert.match(html, /Download unavailable/);
  assert.match(html, /Text copy unavailable/);
});

test("the in-memory port scopes reads, survives load, retries, and aborts a slow read", async () => {
  const client = createInMemoryResultFilesClient(sets);
  const burst = await Promise.all(Array.from({ length: 50 }, () => client.list({ projectId, taskId })));
  assert.ok(burst.every(result => result.length === 1 && result[0]?.task.id === taskId));
  assert.deepEqual(await client.list({ projectId: "project:missing" }), []);
  assert.deepEqual(await client.list({ projectId, taskId: "job:missing" }), []);
  assert.equal(client.downloadUrl({ projectId, taskId }, "result-set:one", "file:failed", "original"), undefined);
  assert.equal(client.downloadUrl({ projectId: "project:other" }, "result-set:one", "file:ready", "original"), undefined);
  const pendingText = createInMemoryResultFilesClient([{ ...sets[0]!, files: [{ ...sets[0]!.files[0]!, textCopy: { status: "pending" } }] }]);
  assert.equal(pendingText.downloadUrl({ projectId, taskId }, "result-set:one", "file:ready", "text-copy"), undefined);

  const retry = createInMemoryResultFilesClient(sets, { failFirstReads: 1 });
  await assert.rejects(retry.list({ projectId }), ResultFilesUnavailableError);
  assert.equal((await retry.list({ projectId })).length, 1);

  const slow = createInMemoryResultFilesClient(sets, { delayMs: 50 });
  const controller = new AbortController();
  const stopped = slow.list({ projectId }, controller.signal);
  controller.abort();
  await assert.rejects(stopped, error => error instanceof DOMException && error.name === "AbortError");
});
