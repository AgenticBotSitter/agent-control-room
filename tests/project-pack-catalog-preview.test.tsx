// Issue #318: local pack browse-and-preview surface.
// The canonical parser is exercised unmodified (with Buffer absent — the
// browser reality) end-to-end: one valid pack and one refused pack, plus the
// panel's distinct rendering of every refusal class and its inert preview.
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The browser prerequisite: no Node Buffer global while the canonical parser
// and this module are exercised. A real browser provides no Buffer global.
const savedBuffer = Object.getOwnPropertyDescriptor(globalThis, "Buffer")!;
Object.defineProperty(globalThis, "Buffer", { configurable: true, value: undefined });

import { parseProjectPackV1, previewProjectPackV1 } from "../src/project-packs/v1/project-pack";
import {
  browseProjectPackV1,
  refusalTextV1,
  PROJECT_PACK_SCHEMA_V1,
} from "../src/project-packs/v1/browse-preview";
import {
  ProjectPackCatalogPreview,
  ProjectPackCatalogPreviewPanel,
} from "../private-app/app/project-pack-catalog-preview";

const LOCAL_CONFIG = { ideaLab: true, news: false, sessionObservations: false };

const VALID_PACK_TEXT = JSON.stringify({
  schema: PROJECT_PACK_SCHEMA_V1,
  title: "Book club kit",
  summary: "A monthly reading pack with discussion prompts.",
  optionalModules: ["ideaLab"],
  setupGuidance: ["Pick one book per month.", "Rotate discussion leads."],
  attribution: "Friday street book club",
  license: "CC-BY-4.0",
});

test("valid pack: canonical parser runs unmodified without Buffer, end to end", () => {
  const outcome = browseProjectPackV1({ rawText: VALID_PACK_TEXT }, LOCAL_CONFIG);
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") return;
  assert.equal(outcome.preview.title, "Book club kit");
  assert.equal(outcome.preview.attribution, "Friday street book club");
  assert.equal(outcome.preview.license, "CC-BY-4.0");
  assert.deepEqual(outcome.preview.supportedModules, ["ideaLab"]);
  assert.deepEqual(outcome.preview.unsupportedModules, []);
  assert.deepEqual(outcome.preview.warnings, []);
  // Canonical functions used directly, unmodified, under the same Buffer-free
  // global: the bridge is transparent to the parser's own contract.
  const pack = parseProjectPackV1(JSON.parse(VALID_PACK_TEXT));
  const preview = previewProjectPackV1(pack, LOCAL_CONFIG);
  assert.equal(preview.title, "Book club kit");
});

test("oversized input is refused with the canonical byte-ceiling reason", () => {
  const big = JSON.stringify({
    schema: PROJECT_PACK_SCHEMA_V1,
    title: "x".repeat(70000),
    summary: "s",
    optionalModules: [],
    setupGuidance: [],
  });
  const outcome = browseProjectPackV1({ rawText: big }, LOCAL_CONFIG);
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") return;
  assert.equal(outcome.reason, "project_pack_input_oversized");
  assert.match(refusalTextV1(outcome.reason), /65536-byte/);
});

test("refused pack: executable content is caught end to end and rendered distinctly", () => {
  const hostile = JSON.stringify({
    schema: PROJECT_PACK_SCHEMA_V1,
    title: "<script>alert(1)</script>",
    summary: "s",
    optionalModules: [],
    setupGuidance: [],
  });
  const outcome = browseProjectPackV1({ rawText: hostile }, LOCAL_CONFIG);
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") return;
  assert.equal(outcome.reason, "project_pack_title_executable_content");
  const html = renderToStaticMarkup(createElement(ProjectPackCatalogPreviewPanel, { outcome }));
  assert.match(html, /data-field="pack-refusal-reason"/);
  assert.match(html, /data-reason="project_pack_title_executable_content"/);
  assert.match(html, /executable-content markers/);
  assert.match(html, /Reason code/);
});

test("every refusal reason renders a distinct human sentence, never a raw error", () => {
  const refusalCases: Array<[string, RegExp]> = [
    ["project_pack_malformed", /not a project pack object/],
    ["project_pack_input_oversized", /65536-byte/],
    ["project_pack_unknown_version", /Unknown pack schema version/],
    ["project_pack_prototype_pollution_key", /__proto__|constructor|prototype/],
    ["project_pack_title_not_printable", /title.*non-printable control characters/],
    ["project_pack_summary_credential_shaped", /summary.*credential/],
    ["project_pack_guidance_authority_shaped", /setup guidance.*authority-shaped/],
    ["project_pack_license_executable_content", /license.*executable-content/],
  ];
  for (const [reason, expected] of refusalCases) {
    const text = refusalTextV1(reason);
    assert.match(text, expected, `refusal text for ${reason} should be distinct and human-readable`);
  }
  // Unknown codes still produce a visible, non-empty sentence (never thrown away).
  assert.match(refusalTextV1("project_pack_something_new"), /refused: project_pack_something_new/);
});

test("unsupported local modules surface canonical warnings in the preview panel", () => {
  const packText = JSON.stringify({
    schema: PROJECT_PACK_SCHEMA_V1,
    title: "News pack",
    summary: "Uses the news module.",
    optionalModules: ["news"],
    setupGuidance: [],
  });
  const outcome = browseProjectPackV1({ rawText: packText }, LOCAL_CONFIG);
  assert.equal(outcome.status, "ready");
  if (outcome.status !== "ready") return;
  assert.deepEqual(outcome.preview.unsupportedModules, ["news"]);
  assert.deepEqual(outcome.preview.warnings, ["module_not_supported_locally:news"]);
  const html = renderToStaticMarkup(createElement(ProjectPackCatalogPreviewPanel, { outcome }));
  assert.match(html, /module_not_supported_locally:news/);
  assert.match(html, /Not supported locally: news/);
});

test("the full surface renders keyboard/text-only controls and never auto-submits", () => {
  const html = renderToStaticMarkup(createElement(ProjectPackCatalogPreview, { localConfiguration: LOCAL_CONFIG }));
  assert.match(html, /<textarea[^>]*id="pack-raw-text"/);
  assert.match(html, /<label[^>]*for="pack-raw-text"/);
  assert.match(html, /<input[^>]*type="file"/);
  assert.match(html, /id="pack-file-input"/);
  assert.match(html, /id="pack-browse-heading"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /nothing is uploaded/);
  assert.match(html, /data-field="pack-idle"/);
  // No form element anywhere: nothing can auto-submit, there is no action
  // URL, and therefore no network request path from this markup.
  assert.doesNotMatch(html, /<form\b/);
  assert.doesNotMatch(html, /action="/);
});

test("empty input is refused visibly before any parse", () => {
  const outcome = browseProjectPackV1({ rawText: "" }, LOCAL_CONFIG);
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") return;
  assert.equal(outcome.reason, "project_pack_empty");
});

test("the global Buffer restoration survives a refusal path exactly", () => {
  // Refuse (throws inside the bridge) and confirm the descriptor is the
  // undefined-valued property this file installed, not a leaked bridge.
  const refused = browseProjectPackV1({ rawText: "{not json" }, LOCAL_CONFIG);
  assert.equal(refused.status, "refused");
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  assert.ok(descriptor !== undefined);
  assert.equal(descriptor!.value, undefined);
  assert.equal(descriptor!.configurable, true);
});

// Restore the real Node Buffer for any subsequent test file in this lane.
Object.defineProperty(globalThis, "Buffer", savedBuffer);
