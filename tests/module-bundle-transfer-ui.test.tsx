// M6: download links and the module upload panel. Static-render tests prove
// escaping and refusal rendering; one interactive test drives the full
// preview -> approve flow through a fake client (never a real network call).
import assert from "node:assert/strict";
import test from "node:test";
import React, { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { JSDOM } from "jsdom";
import { createRoot } from "react-dom/client";
import { ModuleBundleDownloadLink, ProjectPackDownloadLink } from "../private-app/app/module-bundle-download";
import { ModuleBundleUploadPanel, ModulePreviewPanel, type ModulePreview } from "../private-app/app/module-bundle-upload";
import { BrowserRequestError } from "../src/web/v1/browser-client";

// --- Download links ---

test("a module bundle download link points at the exact download route", () => {
  const html = renderToStaticMarkup(createElement(ModuleBundleDownloadLink, { moduleId: "news", moduleName: "News" }));
  assert.match(html, /href="\/api\/v1\/modules\/news\/bundle"/);
  assert.match(html, />Download News module bundle</);
});

test("an invalid module id renders no download link at all", () => {
  const html = renderToStaticMarkup(createElement(ModuleBundleDownloadLink, { moduleId: "Not Valid!", moduleName: "x" }));
  assert.equal(html, "");
});

test("a project pack download link points at the exact download route and escapes the title", () => {
  const html = renderToStaticMarkup(createElement(ProjectPackDownloadLink,
    { projectId: "project:abc-123", projectTitle: "<script>alert(1)</script>" }));
  assert.match(html, /href="\/api\/v1\/projects\/project%3Aabc-123\/pack"/);
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("an invalid project id renders no download link at all", () => {
  const html = renderToStaticMarkup(createElement(ProjectPackDownloadLink, { projectId: "not-a-project-id", projectTitle: "x" }));
  assert.equal(html, "");
});

// --- Preview panel: escaping, trust line, code warning, permission diff ---

const basePreview: ModulePreview = {
  moduleId: "news", moduleVersion: "1.0.0", moduleClass: "code",
  name: "<b>News</b>", publisher: "<img src=x onerror=alert(1)>Example Publisher",
  bundleDigest: `sha256:${"a".repeat(64)}`,
  source: { kind: "signed", keyId: `sha256:${"b".repeat(64)}`, keyLabel: "Local owner key" },
  expectedSource: { kind: "signed", keyId: `sha256:${"b".repeat(64)}` },
  codeWarning: true, currentApproval: null,
  permissionDiff: { added: ["projectData:module_x:read"], removed: [] },
  permissionDiffDigest: `sha256:${"c".repeat(64)}`,
};

test("the preview panel escapes a manifest name and publisher that carry HTML-shaped text", () => {
  const html = renderToStaticMarkup(createElement(ModulePreviewPanel,
    { preview: basePreview, ackCode: false, approving: false }));
  assert.doesNotMatch(html, /<b>News<\/b>/);
  assert.match(html, /&lt;b&gt;News&lt;\/b&gt;/);
  assert.doesNotMatch(html, /<img src=x onerror=alert\(1\)>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("the preview panel shows the CODE warning and the exact signer trust line", () => {
  const html = renderToStaticMarkup(createElement(ModulePreviewPanel,
    { preview: basePreview, ackCode: false, approving: false }));
  assert.match(html, /This module can run code/);
  assert.match(html, /Signed by Local owner key\./);
});

test("an unsigned declarative preview states the shareable trust line, not a signer", () => {
  const declarative: ModulePreview = { ...basePreview, moduleClass: "declarative", codeWarning: false,
    source: { kind: "declarative-unsigned" }, expectedSource: { kind: "declarative-unsigned", keyId: null } };
  const html = renderToStaticMarkup(createElement(ModulePreviewPanel, { preview: declarative, ackCode: false, approving: false }));
  assert.doesNotMatch(html, /This module can run code/);
  assert.match(html, /Shared unsigned \(declarative only/);
});

test("the permission diff renders added and removed lines distinctly, or 'no change' when empty", () => {
  const withRemoval: ModulePreview = { ...basePreview,
    permissionDiff: { added: ["projectData:module_x:write"], removed: ["projectData:module_x:read"] } };
  const html = renderToStaticMarkup(createElement(ModulePreviewPanel, { preview: withRemoval, ackCode: true, approving: false }));
  assert.match(html, /Newly requested:/); assert.match(html, /projectData:module_x:write/);
  assert.match(html, /No longer requested:/); assert.match(html, /projectData:module_x:read/);

  const noChange: ModulePreview = { ...basePreview, permissionDiff: { added: [], removed: [] } };
  const noChangeHtml = renderToStaticMarkup(createElement(ModulePreviewPanel, { preview: noChange, ackCode: true, approving: false }));
  assert.match(noChangeHtml, /No change from the current approval\./);
});

test("approve is never rendered enabled for a CODE bundle until the warning is acknowledged", () => {
  const withoutAck = renderToStaticMarkup(createElement(ModulePreviewPanel,
    { preview: basePreview, ackCode: false, onApprove: () => {}, approving: false }));
  assert.match(withoutAck, /<button[^>]*disabled=""[^>]*>Approve<\/button>/);
  const withAck = renderToStaticMarkup(createElement(ModulePreviewPanel,
    { preview: basePreview, ackCode: true, onApprove: () => {}, approving: false }));
  assert.doesNotMatch(withAck, /<button[^>]*disabled=""[^>]*>Approve<\/button>/);
});

test("the idle upload panel renders with no bundle chosen yet, and no network client call happens", () => {
  const calls: string[] = [];
  const client = { preview: async () => { calls.push("preview"); return {}; }, approve: async () => { calls.push("approve"); return {}; } };
  const html = renderToStaticMarkup(createElement(ModuleBundleUploadPanel, { client }));
  assert.match(html, /No bundle chosen yet\./);
  assert.deepEqual(calls, []);
});

// --- Interactive: the full preview -> approve flow, driven by a fake client ---

async function withMountedPanel(client: { preview: (submission: unknown) => Promise<unknown>;
  approve: (submission: unknown, draft: unknown, key: string) => Promise<unknown> }, run: (dom: JSDOM) => Promise<void>) {
  const dom = new JSDOM("<div id='root'></div>", { url: "https://control.invalid/settings" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"].map(key =>
    [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await React.act(async () => { root.render(createElement(ModuleBundleUploadPanel, { client })); });
    await run(dom);
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

async function chooseFile(dom: JSDOM, text: string, name = "bundle.json") {
  const input = dom.window.document.querySelector<HTMLInputElement>("#module-bundle-file-input")!;
  // jsdom's own File has no `.text()`; the component only calls `.size`/`.text()` (never `instanceof
  // File`), so Node's real global File (Blob-backed, `.text()` included) stands in here.
  const file = new File([text], name, { type: "application/json" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  await React.act(async () => { input.dispatchEvent(new dom.window.Event("change", { bubbles: true })); });
}

test("choosing a valid bundle file previews it, and approving shows 'Approved, not installed yet.'", async () => {
  const previewed: unknown[] = [], approved: [unknown, unknown, string][] = [];
  const client = {
    async preview(submission: unknown) { previewed.push(submission); return basePreview; },
    async approve(submission: unknown, draft: unknown, key: string) { approved.push([submission, draft, key]); return { approvalId: "x" }; },
  };
  await withMountedPanel(client, async dom => {
    await chooseFile(dom, JSON.stringify({ bundle: { schema: "x" }, signature: null }));
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.equal(previewed.length, 1);
    assert.match(dom.window.document.body.textContent ?? "", /What this bundle asks for/);
    assert.match(dom.window.document.body.textContent ?? "", /This module can run code/);

    const approveButton = [...dom.window.document.querySelectorAll("button")].find(b => b.textContent === "Approve")!;
    assert.equal(approveButton.disabled, true, "disabled until the CODE warning is acknowledged");
    const ack = dom.window.document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await React.act(async () => { ack.click(); });
    assert.equal(approveButton.disabled, false);

    await React.act(async () => { approveButton.click(); });
    assert.equal(approved.length, 1);
    assert.equal((approved[0]![1] as { acknowledgedCodeWarning: boolean }).acknowledgedCodeWarning, true);
    assert.match(dom.window.document.body.textContent ?? "", /Approved, not installed yet/);
  });
});

test("an oversized file is refused before the client is ever called", async () => {
  const calls: string[] = [];
  const client = { preview: async () => { calls.push("preview"); return basePreview; }, approve: async () => { calls.push("approve"); return {}; } };
  // Valid, parseable JSON that is still over the ceiling: this isolates the size check from the
  // (separately tested) JSON-parse-failure path, so a removed size check would truly go uncaught.
  const oversizedValidJson = JSON.stringify({ bundle: { schema: "x", padding: "a".repeat(12_000_000) }, signature: null });
  await withMountedPanel(client, async dom => {
    await chooseFile(dom, oversizedValidJson);
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    assert.deepEqual(calls, []);
    assert.match(dom.window.document.body.textContent ?? "", /invalid_request/);
  });
});

test("a refused preview (bad JSON) shows the reason distinctly, not a raw crash", async () => {
  const client = { preview: async () => { throw new BrowserRequestError("invalid_request"); }, approve: async () => { throw new Error("not_expected"); } };
  await withMountedPanel(client, async dom => {
    await chooseFile(dom, "not valid json{{{");
    await React.act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const alert = dom.window.document.querySelector('[role="alert"]');
    assert.ok(alert);
    assert.match(alert!.textContent ?? "", /invalid_request/);
  });
});
