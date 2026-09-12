import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PRODUCT_CONFIGURATION_SCHEMA_V1, type ProductConfigurationV1 } from "../src/config/v1/product-configuration";
import { ProductConfigurationSummary } from "../private-app/app/product-configuration-summary";

const configuration: ProductConfigurationV1 = {
  schema: PRODUCT_CONFIGURATION_SCHEMA_V1, displayName: "Research Room", defaultTimezone: "America/Denver",
  modules: { ideaLab: true, news: false, sessionObservations: true },
  limits: { maxProjects: 24, maxTasksPerProject: 200, maxResultsPerTask: 20, maxArticleSources: 10, maxIdeaParticipants: 8 },
  projectTemplates: [{ id: "research", displayName: "Research", enabledModules: ["ideaLab"] }],
};

test("settings configuration names supplied portable values and their non-authority boundary", () => {
  const html = renderToStaticMarkup(createElement(ProductConfigurationSummary, { configuration }));
  for (const text of ["Research Room", "America/Denver", "Idea Lab", "Session observations", "Research", "Tasks per project", "200"])
    assert.match(html, new RegExp(text));
  assert.match(html, /read-only here/);
  assert.match(html, /do not grant authority/);
  assert.doesNotMatch(html, /password|api key|secret key/i);
});

test("settings does not invent configuration when the protected read is unavailable", () => {
  const html = renderToStaticMarkup(createElement(ProductConfigurationSummary));
  assert.match(html, /No portable presentation configuration is currently available/);
  assert.match(html, /never substitutes a saved, sample, or private configuration/);
  assert.doesNotMatch(html, /Research Room/);
});
