import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import React, { createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { DeliveredFilesPanel, DeliveredFilesRegion, ResultFileRow, safeDownloadHref }
  from "../private-app/app/delivered-files";
import { ProjectFilesWithCatalog } from "../private-app/app/project-files-workspace";
import {
  createInMemoryResultFilesClient,
  type ResultFileCatalog,
  type ResultFileSet,
  type ResultFilesClientPort,
} from "../src/web/v1/result-files-client-port";
import { BrowserRequestError } from "../src/web/v1/browser-client";

const projectId = "project:files-ui";
const taskId = "job:delivered";
const longName = "世界-🌎-résumé-".repeat(12) + ".html";
const at = "2026-09-29T12:00:00.000Z";
const files: ResultFileSet["files"] = [
  { fileId: `result-file:${"1".repeat(32)}`, ordinal: 1, displayName: longName,
    declaredMediaType: "text/html", detectedMediaType: "text/html", sizeBytes: 1536,
    contentDigest: `sha256:${"a".repeat(64)}`, state: "stored", receivedAt: at },
  { fileId: `result-file:${"2".repeat(32)}`, ordinal: 2, displayName: "partial-video.mp4",
    declaredMediaType: "application/octet-stream", detectedMediaType: "application/octet-stream", sizeBytes: 5000000,
    contentDigest: `sha256:${"b".repeat(64)}`, state: "missing", receivedAt: at },
  { fileId: `result-file:${"3".repeat(32)}`, ordinal: 3, displayName: "unsafe-output.zip",
    declaredMediaType: "application/zip", detectedMediaType: "application/zip", sizeBytes: 930,
    contentDigest: `sha256:${"c".repeat(64)}`, state: "quarantined", receivedAt: at },
  { fileId: `result-file:${"4".repeat(32)}`, ordinal: 4, displayName: "not-here-yet.csv",
    declaredMediaType: "text/csv", detectedMediaType: "text/csv", sizeBytes: 0,
    contentDigest: `sha256:${"d".repeat(64)}`, state: "declared", receivedAt: at },
];
const sets: readonly ResultFileSet[] = [{ setId: `result-set:${"1".repeat(32)}`, projectId, jobId: taskId,
  state: "incomplete", sourceKind: "file-store", producerKind: "native", producerId: "local-worker",
  manifestDigest: `sha256:${"e".repeat(64)}`, retentionState: "provisional", files,
  additionalFilesOmitted: false }];

function catalog(source = sets, catalogSource: ResultFileCatalog["catalogSource"] = "configured"): ResultFileCatalog {
  return { projectId, jobId: taskId, sets: source, additionalSetsOmitted: false, catalogSource,
    observedAt: at, startsWork: false, grantsExecutionAuthority: false };
}

function render(source = sets) {
  const client = createInMemoryResultFilesClient(source);
  return renderToStaticMarkup(createElement(DeliveredFilesPanel, {
    scope: { projectId, taskId }, data: { state: "ready", value: catalog(source) }, client, showTask: true,
  }));
}

test("delivered files use the cook/files catalog fields and mint downloads only on demand", () => {
  const html = render();
  for (const text of ["Delivered files", taskId, "text/html", "1.5 KB", "file-store", "local-worker (native)"])
    assert.ok(html.includes(text), text);
  assert.match(html, /Not all files arrived/);
  assert.equal((html.match(/>Download<\/button>/g) ?? []).length, 1);
  assert.doesNotMatch(html, /href=|data:application|<(?:iframe|embed|object|img|video|audio|pre)\b/i);
});

test("empty, unconfigured, and failed reads remain distinct", () => {
  const client = createInMemoryResultFilesClient([]);
  const empty = renderToStaticMarkup(<DeliveredFilesPanel scope={{ projectId }}
    data={{ state: "ready", value: catalog([]) }} client={client} />);
  assert.match(empty, /No files have been delivered yet/);
  const unconfigured = renderToStaticMarkup(<DeliveredFilesPanel scope={{ projectId }}
    data={{ state: "ready", value: catalog([], "not_configured") }} client={client} />);
  assert.match(unconfigured, /No zero count or empty file list is inferred/);
  const unavailable = renderToStaticMarkup(<DeliveredFilesPanel scope={{ projectId }}
    data={{ state: "unavailable", code: "authentication_required" }} client={client} />);
  assert.match(unavailable, /session has ended/);
  assert.doesNotMatch(unavailable, /No files have been delivered yet/);
});

test("missing, quarantined, and declared files cannot request or expose downloads", () => {
  let requests = 0;
  const permissive = { kind: "production" as const, async list() { return catalog(); },
    async requestDownload() { requests += 1; return { href: "/api/v1/unsafe", expiresAt: at }; } } satisfies ResultFilesClientPort;
  const html = renderToStaticMarkup(<DeliveredFilesPanel scope={{ projectId, taskId }}
    data={{ state: "ready", value: catalog() }} client={permissive} />);
  assert.equal(requests, 0, "rendering never mints a link");
  assert.equal((html.match(/Download unavailable/g) ?? []).length, 3);
  assert.equal((html.match(/>Download<\/button>/g) ?? []).length, 1);
  assert.match(html, /Delivery failed/); assert.match(html, /result is incomplete and needs attention/);
  assert.match(html, /Delivery refused/); assert.match(html, /No unverified bytes are offered/);
});

test("a held-back set says so and never presents its files as ready", () => {
  const held: ResultFileSet = { ...sets[0]!, state: "quarantined", files: [files[0]!] };
  const html = render([held]);
  assert.match(html, /held back.*will not be offered for download/i);
  assert.doesNotMatch(html, /Ready to download/);
  assert.match(html, /Delivery refused/);
  assert.match(html, /private-chip is-bad/);
});

test("set state copy identifies declared and incomplete sets and zero-file sets are not blank", () => {
  const declared: ResultFileSet = { ...sets[0]!, state: "declared", files: [] };
  const incomplete: ResultFileSet = { ...sets[0]!, state: "incomplete", files: [files[0]!] };
  const html = render([declared, incomplete]);
  assert.match(html, /0 files/);
  assert.match(html, /Still arriving\. These files have not landed yet/);
  assert.match(html, /Not all files arrived\. The files below did arrive and can be downloaded/);
  assert.equal((html.match(/<ul /g) ?? []).length, 1, "the zero-file set has no empty list");
});

test("production download hrefs are exact same-origin relative API paths", () => {
  assert.equal(safeDownloadHref("/api/v1/projects/p/result-files/s/f/download?token=one", "production"),
    "/api/v1/projects/p/result-files/s/f/download?token=one");
  for (const href of ["javascript:alert(1)", "//evil.example/x", "https://other.example/x",
    "https://control-room.invalid/api/v1/x", "/\\evil.example/x", "/\\/evil.example/x",
    "/\t/evil.example/x", "/\n/evil.example/x", "/downloads/file", "/api/v1/file#fragment"])
    assert.equal(safeDownloadHref(href, "production"), undefined, href);
  assert.equal(safeDownloadHref("data:application/octet-stream,", "production"), undefined);
  assert.equal(safeDownloadHref("data:application/octet-stream,", "demo"), "data:application/octet-stream,");
});

test("long Unicode names have a constrained ellipsis box and preserve their full title", () => {
  const html = render();
  assert.ok(html.includes(longName)); assert.doesNotMatch(html, /�/);
  assert.match(html, new RegExp(`title="${longName}"`));
  const css = readFileSync(new URL("../private-app/app/private.css", import.meta.url), "utf8");
  assert.match(css, /\.private-delivered-file-heading > \.private-delivered-file-name[^}]*max-width:\s*100%[^}]*flex:\s*1 1 0[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.private-delivered-file-main, \.private-delivered-file-heading\s*{\s*min-width:\s*0/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.private-delivered-file[^}]*grid-template-columns:\s*1fr/);
});

test("hostile metadata stays text", () => {
  const hostileName = `\"><img src=x onerror=alert(1)>🌎.svg`;
  const hostile: ResultFileSet = { ...sets[0]!, files: [{ ...files[0]!, displayName: hostileName }] };
  const html = render([hostile]);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img|javascript:/);
});

type Mounted = Readonly<{ dom: JSDOM; root: ReturnType<typeof createRoot>; restore(): Promise<void> }>;
async function mount(element: React.ReactNode): Promise<Mounted> {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://control-room.invalid/", pretendToBeVisual: true });
  const prior = { window: globalThis.window, document: globalThis.document, HTMLElement: globalThis.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT };
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  await React.act(async () => { root.render(element); await Promise.resolve(); });
  return { dom, root, async restore() {
    await React.act(async () => { root.unmount(); }); dom.window.close(); Object.assign(globalThis, prior);
  } };
}

test("unsafe minted links are refused, concurrent clicks coalesce, and a failed download can retry", async () => {
  let calls = 0, anchorClicks = 0;
  let settle!: (value: { href: string; expiresAt: string }) => void;
  let reject!: (error: Error) => void;
  const client = { kind: "production" as const, async list() { return catalog(); },
    requestDownload() { calls += 1; return new Promise<{ href: string; expiresAt: string }>((resolve, fail) => {
      settle = resolve; reject = fail;
    }); } } satisfies ResultFilesClientPort;
  const view = await mount(<ResultFileRow file={files[0]!} set={sets[0]!}
    scope={{ projectId, taskId }} client={client} />);
  const originalClick = view.dom.window.HTMLAnchorElement.prototype.click;
  view.dom.window.HTMLAnchorElement.prototype.click = () => { anchorClicks += 1; };
  try {
    const button = view.dom.window.document.querySelector("button")!;
    await React.act(async () => { button.click(); button.click(); button.click(); await Promise.resolve(); });
    assert.equal(calls, 1, "a burst starts one request");
    await React.act(async () => { reject(new BrowserRequestError("authentication_required")); await Promise.resolve(); });
    assert.match(view.dom.window.document.body.textContent ?? "", /session has ended.*Sign in again to download this file/i);
    await React.act(async () => { button.click(); await Promise.resolve(); });
    assert.equal(calls, 2, "retry starts one new request");
    await React.act(async () => { settle({ href: "https://other.example/x", expiresAt: at }); await Promise.resolve(); });
    assert.equal(anchorClicks, 0, "an unsafe result never navigates");
  } finally {
    view.dom.window.HTMLAnchorElement.prototype.click = originalClick;
    await view.restore();
  }
});

test("the mounted region aborts replaced and stopped reads without painting stale data", async () => {
  const pending: Array<{ scope: { projectId: string; taskId?: string }; signal?: AbortSignal;
    resolve(value: ResultFileCatalog): void }> = [];
  const client = { kind: "production" as const,
    list(scope: { projectId: string; taskId?: string }, signal?: AbortSignal) {
      return new Promise<ResultFileCatalog>((resolve) => {
        pending.push({ scope, signal, resolve });
      });
    },
    async requestDownload() { throw new BrowserRequestError("unavailable"); },
  } satisfies ResultFilesClientPort;
  const view = await mount(<DeliveredFilesRegion scope={{ projectId, taskId: "job:first" }} client={client} />);
  try {
    await React.act(async () => { view.root.render(<DeliveredFilesRegion
      scope={{ projectId, taskId: "job:second" }} client={client} />); await Promise.resolve(); });
    assert.equal(pending.length, 2); assert.equal(pending[0]!.signal?.aborted, true);
    const staleSet = { ...sets[0]!, jobId: "job:first", files: [{ ...files[0]!, displayName: "stale.txt" }] };
    await React.act(async () => { pending[0]!.resolve({ ...catalog([staleSet]), jobId: "job:first" }); await Promise.resolve(); });
    assert.doesNotMatch(view.dom.window.document.body.textContent ?? "", /stale\.txt/);
    const secondSet = { ...sets[0]!, jobId: "job:second", files: [{ ...files[0]!, displayName: "second.txt" }] };
    await React.act(async () => { pending[1]!.resolve({ ...catalog([secondSet]), jobId: "job:second" }); await Promise.resolve(); });
    assert.match(view.dom.window.document.body.textContent ?? "", /second\.txt/);
    assert.doesNotMatch(view.dom.window.document.body.textContent ?? "", /job:first/);
    await React.act(async () => { view.root.render(<DeliveredFilesRegion
      scope={{ projectId, taskId: "job:third" }} client={client} />); await Promise.resolve(); });
    assert.equal(pending.length, 3);
  } finally {
    await view.restore();
  }
  assert.equal(pending[2]!.signal?.aborted, true, "unmount stops the in-flight read");
});

test("the in-memory demo scopes reads, survives load, retries, and aborts slow work", async () => {
  const client = createInMemoryResultFilesClient(sets);
  const burst = await Promise.all(Array.from({ length: 50 }, () => client.list({ projectId, taskId })));
  assert.ok(burst.every(result => result.sets.length === 1 && result.sets[0]?.jobId === taskId));
  assert.deepEqual((await client.list({ projectId: "project:missing" })).sets, []);
  await assert.rejects(client.requestDownload(projectId, sets[0]!.setId, files[1]!.fileId), /not_found/);
  const downloads = await Promise.all(Array.from({ length: 20 }, () =>
    client.requestDownload(projectId, sets[0]!.setId, files[0]!.fileId)));
  assert.ok(downloads.every(value => value.href === "data:application/octet-stream,"));

  const retry = createInMemoryResultFilesClient(sets, { failFirstReads: 1, failFirstDownloads: 1 });
  await assert.rejects(retry.list({ projectId }), BrowserRequestError);
  assert.equal((await retry.list({ projectId })).sets.length, 1);
  await assert.rejects(retry.requestDownload(projectId, sets[0]!.setId, files[0]!.fileId), BrowserRequestError);
  assert.match((await retry.requestDownload(projectId, sets[0]!.setId, files[0]!.fileId)).href, /^data:/);

  const slow = createInMemoryResultFilesClient(sets, { delayMs: 50 });
  const controller = new AbortController();
  const stopped = slow.requestDownload(projectId, sets[0]!.setId, files[0]!.fileId, controller.signal);
  controller.abort();
  await assert.rejects(stopped, error => error instanceof DOMException && error.name === "AbortError");
});

test("shared browser request failures preserve owner sign-in copy", async () => {
  const client = { kind: "production" as const,
    async list() { throw new BrowserRequestError("authentication_required"); },
    async requestDownload() { throw new BrowserRequestError("authentication_required"); },
  } satisfies ResultFilesClientPort;
  const view = await mount(<DeliveredFilesRegion scope={{ projectId, taskId }} client={client} />);
  try {
    await React.act(async () => { await Promise.resolve(); });
    assert.match(view.dom.window.document.body.textContent ?? "", /session has ended.*Sign in again to see delivered files/i);
  } finally {
    await view.restore();
  }
});

test("Project Files keeps the existing saved receipt view below the catalog", () => {
  const html = renderToStaticMarkup(<ProjectFilesWithCatalog projectId={projectId} data={{ state: "ready", value: {
    projectId, items: [], additionalItemsOmitted: false, resultSource: "configured", observedAt: at, startsWork: false,
  } }} />);
  assert.ok(html.indexOf("Delivered files") < html.indexOf("Saved result files"));
  assert.match(html, /No verified result files have been received/);
});
