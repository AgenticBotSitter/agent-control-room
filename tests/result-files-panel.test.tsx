// The "Delivered files" panel (plan v4.3 2.6).
//
// These assertions are about what the OWNER IS TOLD, which is the part of this
// feature a reviewer cannot check by reading SQL. Each one names a case where
// the honest answer and the convenient answer differ, and asserts the honest
// one: a missing file offers no button, a half-delivered set says so, a
// declared type that disagrees with the bytes is shown rather than smoothed
// over, and a catalog that could not be read never renders as an empty one.
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResultFilesView } from "../private-app/app/result-files-panel";
import { readResultFileCatalog, requestResultFileDownload } from "../src/web/v1/result-file-browser-client";
import { BrowserRequestError } from "../src/web/v1/browser-client";
import type { ResultFileCatalog, ResultFileItem, ResultFileSet } from "../src/web/v1/result-file-wire";

const PROJECT = "project:alpha";
const SET = `result-set:${"a".repeat(32)}`;
const digest = (n: string) => `sha256:${n.repeat(64)}`;

const file = (over: Partial<ResultFileItem> = {}): ResultFileItem => ({
  fileId: `result-file:${"b".repeat(32)}`, ordinal: 1, displayName: "report.txt",
  declaredMediaType: "text/plain", detectedMediaType: "text/plain", sizeBytes: 4096,
  contentDigest: digest("c"), state: "stored", receivedAt: "2026-09-29T12:00:00.000Z",
  ...over,
});
const set = (over: Partial<ResultFileSet> = {}): ResultFileSet => ({
  setId: SET, projectId: PROJECT, jobId: "job:one", state: "stored", sourceKind: "file-store",
  producerKind: "fleet", producerId: `fleet-worker:${"c".repeat(32)}`, manifestDigest: digest("d"),
  retentionState: "provisional", files: [file()], additionalFilesOmitted: false, ...over,
});
const catalog = (over: Partial<ResultFileCatalog> = {}): ResultFileCatalog => ({
  projectId: PROJECT, jobId: "job:one", sets: [set()], additionalSetsOmitted: false,
  catalogSource: "configured", observedAt: "2026-09-29T12:00:00.000Z", startsWork: false,
  grantsExecutionAuthority: false, ...over,
});
const html = (value: unknown) => renderToStaticMarkup(
  React.createElement(ResultFilesView, { projectId: PROJECT, jobId: "job:one",
    data: { state: "ready", value: value as ResultFileCatalog } }));

test("a stored file offers one obvious download and hides its details behind a toggle", () => {
  const markup = html(catalog());
  assert.match(markup, /report\.txt/);
  assert.match(markup, /4\.0 KiB/);
  // Exactly one action, and it is the download. Nothing else competes with it.
  const buttons = [...markup.matchAll(/<button[^>]*>([^<]*)</gu)].map(match => match[1]);
  assert.deepEqual(buttons, ["Download"], "one action per file, and it is the download");
  // The fingerprint and the producer are present but folded away.
  assert.match(markup, /<details><summary>File details<\/summary>/u);
  assert.match(markup, new RegExp(digest("c"), "u"));
  // The storage key, a filesystem path and the word "locator" are never rendered.
  assert.doesNotMatch(markup, /crbf1|\/Users\/|storage[_ ]?key|\.crbf/u);
});

test("a file that is not on the Mac says so in plain words and offers nothing", () => {
  for (const [state, heading] of [["missing", "Missing"], ["quarantined", "Held back"],
    ["declared", "Still arriving"]] as const) {
    const markup = html(catalog({ sets: [set({ files: [file({ state })] })] }));
    assert.match(markup, new RegExp(heading, "u"), `${state}: the status is in plain words`);
    assert.doesNotMatch(markup, />Download</u, `${state}: no download is offered`);
    // A file that is still arriving says so; it does not look like a failure.
    if (state === "declared") assert.match(markup, /bytes are not on the Mac yet/u);
    // A missing file says that reloading will not fix it, so the owner does not
    // sit refreshing a page that can never change.
    if (state === "missing") assert.match(markup, /reloading this page will not bring it back/u);
  }
});

test("a set that is missing files says so and still offers the ones that arrived", () => {
  const markup = html(catalog({ sets: [set({ state: "incomplete", files: [file({ ordinal: 1 })] })] }));
  assert.match(markup, /Not all files arrived/u);
  assert.match(markup, /did arrive and can be downloaded/u);
  assert.match(markup, />Download</u, "the file that did arrive is still downloadable");
});

test("a declared type that disagrees with the bytes is shown, not smoothed over", () => {
  const markup = html(catalog({ sets: [set({ files: [file({ displayName: "chart.png",
    declaredMediaType: "image/png", detectedMediaType: "text/html" })] })] }));
  assert.match(markup, /Sent as image\/png/u);
  assert.match(markup, /bytes look like\s*text\/html/u);
  assert.match(markup, /gives you the original bytes unchanged/u);
  // The download is still offered: the owner asked for the original, and the
  // original is what they get. The warning is information, not a refusal.
  assert.match(markup, />Download</u);
});

test("an unavailable or unconfigured catalog never renders as an empty one", () => {
  const failed = renderToStaticMarkup(React.createElement(ResultFilesView, { projectId: PROJECT,
    data: { state: "unavailable", code: "unavailable" } }));
  assert.match(failed, /could not be read/u);
  assert.match(failed, /No count is inferred/u);
  assert.doesNotMatch(failed, /No files have been saved/u, "a failed read is not an empty list");
  const signedOut = renderToStaticMarkup(React.createElement(ResultFilesView, { projectId: PROJECT,
    data: { state: "unavailable", code: "authentication_required" } }));
  assert.match(signedOut, /Sign in again/u);
  const unconfigured = html({ ...catalog(), catalogSource: "not_configured", sets: [] });
  assert.match(unconfigured, /not configured for this Control Room/u);
  assert.match(unconfigured, /No zero count or empty file list is inferred/u);
  assert.doesNotMatch(unconfigured, /No files have been saved/u);
  // An honest empty IS allowed, and it says what would put something there.
  const empty = html({ ...catalog(), sets: [] });
  assert.match(empty, /No files have been saved to the Mac/u);
  assert.match(empty, /once an approved job has produced it/u);
});

test("the panel is one column and the action is reachable at phone width", () => {
  const markup = html(catalog());
  // No table, no grid and no horizontal scroll: the layout is a list, so it
  // reflows to one column without a media query.
  assert.doesNotMatch(markup, /<table|<div[^>]*display:\s*grid|overflow-x/u);
  // The viewport declaration the rest of the shell already sets is not undone.
  assert.doesNotMatch(markup, /user-scalable=no|maximum-scale=1/u);
  // The action is a real button, so it works by keyboard and on a phone.
  assert.match(markup, /<button[^>]*class="private-action-link"[^>]*>Download<\/button>/u);
});

test("the browser client reads the catalog and refuses a cross-project answer", async () => {
  let requested = "", method = "";
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested = String(input); method = init?.method ?? "";
    return Response.json(catalog());
  }) as typeof fetch;
  const value = await readResultFileCatalog(PROJECT, "job:one", transport);
  assert.equal(value.sets.length, 1);
  assert.equal(requested, "/api/v1/projects/project%3Aalpha/result-files?job=job%3Aone");
  assert.equal(method, "GET");
  // A response for a different project is refused rather than shown here.
  await assert.rejects(readResultFileCatalog(PROJECT, "job:one", async () =>
    Response.json(catalog({ projectId: "project:other" }))), /unavailable/u);
  // A project or job that is not an id is refused before any request is made.
  let reached = false;
  const never = (async () => { reached = true; return Response.json(catalog()); }) as typeof fetch;
  for (const [project, job] of [["not an id", "job:one"], [PROJECT, "../other"]] as const)
    await assert.rejects(readResultFileCatalog(project, job, never), /unavailable|invalid_request/u);
  assert.equal(reached, false, "an invalid id never reached the network");
});

test("the browser client only accepts a link to this project's own route", async () => {
  const FILE = `result-file:${"b".repeat(32)}`;
  const transport = (async (input: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(init?.method, "POST");
    // `encodeURIComponent` escapes the colons, so the path the browser sends is
    // the percent-encoded form of the same route.
    assert.equal(String(input), `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/`
      + `${encodeURIComponent(SET)}/${encodeURIComponent(FILE)}/download`);
    return Response.json({ href: `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/${SET}/${FILE}`
      + `/download?token=t`, expiresAt: "2026-09-29T12:05:00.000Z" });
  }) as typeof fetch;
  const link = await requestResultFileDownload(PROJECT, SET, `result-file:${"b".repeat(32)}`, transport);
  assert.match(link.href, /^\/api\/v1\//u);
  // A storage path, an object-store URL or another origin is refused, because a
  // link the browser would navigate to must never point outside this route.
  for (const href of ["https://files.example/object", "/Users/owner/store/x.crbf", "crbf1-" + "a".repeat(64),
    "/api/v2/projects/x/result-files", ""]) {
    await assert.rejects(requestResultFileDownload(PROJECT, SET, `result-file:${"b".repeat(32)}`,
      async () => Response.json({ href, expiresAt: "2026-09-29T12:05:00.000Z" })),
    (error: unknown) => error instanceof BrowserRequestError && error.code === "unavailable",
    `refused: ${href}`);
  }
  // A set or file id that is not the exact shape never reaches the network.
  let reached = false;
  const never = (async () => { reached = true; return Response.json({ href: "/api/v1/x", expiresAt: "z" }); }) as typeof fetch;
  for (const [setId, fileId] of [[SET, "result-file:short"], ["set", `result-file:${"b".repeat(32)}`],
    [`result-set:${"z".repeat(32)}`, `result-file:${"b".repeat(32)}`]] as const)
    await assert.rejects(requestResultFileDownload(PROJECT, setId, fileId, never),
      (error: unknown) => error instanceof BrowserRequestError);
  assert.equal(reached, false);
});

test("a trashed set is listed, says why, and offers no button", () => {
  // The review's S2, in the place a reviewer can actually check: what the owner
  // is told. A trashed set is still LISTED — the owner may want to see what they
  // are about to lose — but the service refuses both the mint and the spend, so
  // a Download button here would be a promise the server cannot keep. And
  // "No download available" alone would read as a fault rather than a decision,
  // which is why the panel says which it is.
  const markup = html(catalog({ sets: [set({ retentionState: "trash" })] }));
  assert.match(markup, /report\.txt/, "a trashed set is still listed");
  assert.match(markup, /In the trash\./, "and the panel says so in plain words");
  assert.match(markup, /no longer downloadable/u, "including that the bytes are out of reach");
  const buttons = [...markup.matchAll(/<button[^>]*>([^<]*)</gu)].map(match => match[1]);
  assert.deepEqual(buttons, [], "no action at all: there is nothing the server would let it do");
  // A retained set is the ordinary case and is unaffected.
  const kept = html(catalog({ sets: [set({ retentionState: "retained" })] }));
  assert.deepEqual([...kept.matchAll(/<button[^>]*>([^<]*)</gu)].map(match => match[1]), ["Download"],
    "an accepted set still offers its download");
  assert.doesNotMatch(kept, /In the trash/u);
  // And a provisional set — the common case — is untouched.
  assert.deepEqual([...html(catalog()).matchAll(/<button[^>]*>([^<]*)</gu)].map(match => match[1]), ["Download"],
    "a provisional set still offers its download");
});

test("a purged set is not in the catalog at all, so the panel never mentions it", () => {
  // The service filters purged sets out before they reach the wire, so this
  // asserts the two agree: if a purged set ever DID arrive, the panel must not
  // offer a download for it either. The service-side filter is proved in
  // `tests/result-file-service.test.ts`; this is the defence in depth.
  const markup = html(catalog({ sets: [set({ retentionState: "purged" })] }));
  const buttons = [...markup.matchAll(/<button[^>]*>([^<]*)</gu)].map(match => match[1]);
  assert.deepEqual(buttons, [], "a purged set never offers a download, however it arrived");
});

