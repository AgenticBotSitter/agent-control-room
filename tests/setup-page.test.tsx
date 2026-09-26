import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SetupPage from "../private-app/app/setup/page";

test("standalone setup page is source-only and starts conservatively", async () => {
  const html = renderToStaticMarkup(createElement(SetupPage));
  assert.match(html, /Source-only setup preview/);
  assert.match(html, /macOS bundle source exists, but a public release and live installation do not/);
  assert.match(html, /Refresh saved setup status/);
  assert.match(html, /refreshes its saved setup status while it is visible/);
  assert.match(html, /Reading saved installation proof/);
  assert.match(html, /Reading saved setup progress/);
  assert.doesNotMatch(html, /<nav|<form|<input|session|projects/i);

  const source = await readFile("private-app/app/setup/setup-workspace.tsx", "utf8");
  assert.match(source, /const readinessPath = "\/api\/v1\/installation-readiness"/);
  assert.match(source, /const planPath = "\/api\/v1\/installation-plan"/);
  assert.equal((source.match(/fetch\(/g) ?? []).length, 2);
  assert.equal((source.match(/credentials: "omit"/g) ?? []).length, 2);
  assert.match(source, /installationPlanRestart/);
  assert.match(source, /record\.restart !== expected/);
  assert.doesNotMatch(source, /credentials: "same-origin"/);
  assert.doesNotMatch(source, /PrivateHeader|ProductConfiguration|useInstallationTopology|<form|POST/);
  assert.match(source, /setState\(unavailableState\)/);
  assert.match(source, /setInterval\(refreshWhenVisible, 30_000\)/);
  assert.match(source, /Refresh saved setup status/);

  const providers = await readFile("private-app/app/layout-providers.tsx", "utf8");
  assert.match(providers, /pathname === "\/setup"/);
  assert.match(providers, /pathname\.startsWith\("\/setup\/"\)/);
  assert.ok(providers.indexOf("return children") < providers.indexOf("<ProductConfigurationProvider>"));
});
