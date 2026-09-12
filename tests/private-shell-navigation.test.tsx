import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../private-app/app/page";
import SettingsPage from "../private-app/app/settings/page";

test("home gives honest navigation to existing private workspace surfaces", () => {
  const html = renderToStaticMarkup(createElement(Home));
  for (const href of ["/projects", "/workers", "/needs-me", "/settings"]) assert.match(html, new RegExp(`href="${href}"`));
  assert.doesNotMatch(html, /href="\/ideas"/);
  assert.match(html, /aria-controls="private-workspace-navigation"/);
  assert.match(html, /<nav id="private-workspace-navigation" class="private-navigation"/);
  assert.doesNotMatch(html, /<details/);
  assert.match(html, /does not infer activity, worker availability, or review status/);
  assert.doesNotMatch(html, /Idea Lab is optional/);
  assert.doesNotMatch(html, /live workers|running now|0 tasks/i);
});

test("settings links to the real session surface without credential controls", () => {
  const html = renderToStaticMarkup(createElement(SettingsPage));
  assert.match(html, /href="\/session"/);
  assert.match(html, /does not expose credentials/);
  assert.doesNotMatch(html, /password|api key|secret key/i);
});
