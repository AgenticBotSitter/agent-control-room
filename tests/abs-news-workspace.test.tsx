import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AbsNewsWorkspace } from "../app/components/abs-news-workspace.tsx";
import { buildAbsNewsSyntheticWorkspaceV1 } from "../src/project-adapters/abs-news/v1/index.ts";

test("CR9D ABS workspace renders interactive queue controls, source status, evidence, and proposal editor", () => {
  const html = renderToStaticMarkup(<AbsNewsWorkspace fixture={buildAbsNewsSyntheticWorkspaceV1()} />);
  assert.match(html, /Daily Brief/);
  assert.match(html, /AI and Tech News/);
  assert.match(html, /Research Queue/);
  assert.match(html, /What matters in AI and tech today/);
  assert.match(html, /Synthetic RSS/);
  assert.match(html, /Live collection/);
  assert.match(html, /Owner Authority Required/);
  assert.match(html, /Research this/);
  assert.match(html, /Write a setup guide/);
  assert.match(html, /Draft an ABS article/);
  assert.match(html, /Monitor for updates/);
  assert.match(html, /News queue filters/);
  assert.match(html, /View evidence/);
  assert.match(html, /Archive locally/);
  assert.match(html, /Proposal editor/);
  assert.match(html, /Choose an article action/);
  assert.match(html, /authenticated SQLite store/);
  assert.doesNotMatch(html, /disabled=""/);
  assert.match(html, /Raw newsletter bodies and credentials are never shown/);
  assert.doesNotMatch(html, /grantsExecutionAuthority/);
});
