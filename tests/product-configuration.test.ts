import assert from "node:assert/strict";
import test from "node:test";
import { exportProductConfigurationV1, parseProductConfigurationV1, PRODUCT_CONFIGURATION_SCHEMA_V1 } from "../src/config/v1/product-configuration";

const configuration = () => ({
  schema: PRODUCT_CONFIGURATION_SCHEMA_V1,
  displayName: "Control Room",
  defaultTimezone: "America/Denver",
  modules: { ideaLab: true, news: false, sessionObservations: true },
  limits: { maxProjects: 24, maxTasksPerProject: 200, maxResultsPerTask: 20, maxArticleSources: 10, maxIdeaParticipants: 8 },
  projectTemplates: [
    { id: "research", displayName: "Research", enabledModules: ["ideaLab"] },
    { id: "operations", displayName: "Operations", enabledModules: ["sessionObservations"] },
  ],
});

test("one artifact accepts isolated product configurations without rebuild", () => {
  const first = parseProductConfigurationV1(configuration());
  const secondInput = configuration(); secondInput.displayName = "Other Control Room"; secondInput.defaultTimezone = "UTC";
  const second = parseProductConfigurationV1(secondInput);
  assert.equal(first.displayName, "Control Room");
  assert.equal(second.displayName, "Other Control Room");
  assert.equal(second.defaultTimezone, "UTC");
});

test("parse isolates input, freezes its result, and exports exact canonical JSON", () => {
  const input = configuration(), parsed = parseProductConfigurationV1(input);
  input.projectTemplates[0]!.displayName = "Mutated";
  assert.equal(parsed.projectTemplates[0]!.displayName, "Operations");
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.projectTemplates), true);
  const exported = exportProductConfigurationV1(configuration());
  assert.equal(exported, '{"schema":"control-room.product-configuration/v1","displayName":"Control Room","defaultTimezone":"America/Denver","modules":{"ideaLab":true,"news":false,"sessionObservations":true},"limits":{"maxProjects":24,"maxTasksPerProject":200,"maxResultsPerTask":20,"maxArticleSources":10,"maxIdeaParticipants":8},"projectTemplates":[{"id":"operations","displayName":"Operations","enabledModules":["sessionObservations"]},{"id":"research","displayName":"Research","enabledModules":["ideaLab"]}]}');
  assert.equal(exportProductConfigurationV1(JSON.parse(exported)), exported);
});

test("rejects secret and private runtime fields, unknown fields, invalid timezones, and invalid bounds", () => {
  for (const patch of [
    { credential: "secret" }, { origin: "https://private.example" }, { database: { url: "private" } }, { runtimeFactory: "unsafe" },
    { defaultTimezone: "Mars/Olympus" }, { limits: { ...configuration().limits, maxProjects: 1_001 } },
  ]) assert.throws(() => parseProductConfigurationV1({ ...configuration(), ...patch }));
});

test("rejects duplicate templates and modules disabled by the portable configuration", () => {
  const duplicate = configuration(); duplicate.projectTemplates.push({ ...duplicate.projectTemplates[0]! });
  assert.throws(() => parseProductConfigurationV1(duplicate), /duplicate_template_id/);
  const disabled = configuration(); disabled.projectTemplates[0]!.enabledModules = ["news"];
  assert.throws(() => parseProductConfigurationV1(disabled), /template_module_not_enabled/);
  const repeatedModule = configuration(); repeatedModule.projectTemplates[0]!.enabledModules = ["ideaLab", "ideaLab"];
  assert.throws(() => parseProductConfigurationV1(repeatedModule), /duplicate_template_module/);
});
