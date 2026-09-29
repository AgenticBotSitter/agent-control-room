import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MODULE_MANIFEST_SCHEMA_V1,
  MODULE_REGISTRY_V1,
  REGISTERED_MODULE_IDS_V1,
  assertModuleProjectDataPermissionV1,
  getRegisteredModuleManifestV1,
  parseModuleManifestV1,
} from "../src/modules/v1/index";
import { PRODUCT_CONFIGURATION_MODULES_V1 } from "../src/config/v1/product-configuration";

function declarativeManifest(): Record<string, unknown> {
  return {
    schema: MODULE_MANIFEST_SCHEMA_V1,
    id: "garden.planner",
    version: "1.2.3",
    name: "Garden Planner",
    publisher: "Neighborhood Garden Club",
    license: "MIT",
    controlRoomCompatibility: ">=0.1.0 <1.0.0",
    class: "declarative",
    permissions: {
      projectData: [{ resource: "module_garden_plans", access: ["read", "write"] }],
      taskTemplates: ["garden.plan-bed"],
      pipelineTemplates: ["garden.season"],
      workerCapabilities: ["text.reasoning"],
      notifications: { slots: ["project.garden"], maxPerHour: 5 },
      attention: { slots: ["needs-you.garden"], maxOpenPerProject: 3 },
      scheduledJobs: { jobs: ["garden.reminder"], maxConcurrent: 1, maxRunsPerDay: 4, maxRuntimeSeconds: 60 },
    },
    data: {
      schemaNamespace: "module_garden_planner",
      tenantScoped: true,
      projectScoped: true,
      migrations: [{ version: "1.2.3", upFile: "migrations/1.2.3.sql", downFile: "down/1.2.3.sql" }],
    },
    ui: {
      projectTabs: [{ id: "garden.plan", label: "Garden" }],
      settings: {
        type: "object",
        properties: { "bed-count": { type: "integer", title: "Bed count", default: 4, minimum: 1, maximum: 100 } },
        required: ["bed-count"],
        additionalProperties: false,
      },
      navEntry: { id: "garden.plan", label: "Garden" },
      needsYou: true,
    },
    events: { subscribe: ["project.created"], emitNotifications: true },
  };
}

describe("module manifest v1", () => {
  it("parses and deeply freezes a complete declarative manifest", () => {
    const input = declarativeManifest();
    const parsed = parseModuleManifestV1(input);
    assert.equal(parsed.id, "garden.planner");
    assert.equal(parsed.data?.tenantScoped, true);
    assert.equal(parsed.data?.projectScoped, true);
    assert.equal(parsed.data?.migrations[0]?.downFile, "down/1.2.3.sql");
    assert.equal(Object.isFrozen(parsed.permissions.projectData), true);
    (input.permissions as { taskTemplates: string[] }).taskTemplates.push("garden.changed");
    assert.deepEqual(parsed.permissions.taskTemplates, ["garden.plan-bed"]);
  });

  it("fails closed on unknown keys, raw role-like fields, and invalid versions", () => {
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), launchCommand: "safe" }), /unrecognized_keys/);
    const withRole = structuredClone(declarativeManifest()) as Record<string, any>;
    withRole.permissions.databaseRole = "reader";
    assert.throws(() => parseModuleManifestV1(withRole), /unrecognized_keys/);
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), version: "latest" }), /module_manifest_semver_invalid/);
    assert.throws(
      () => parseModuleManifestV1({ ...declarativeManifest(), controlRoomCompatibility: "any" }),
      /module_manifest_compatibility_invalid/,
    );
  });

  it("refuses executable, credential-shaped, authority-shaped, and polluted input", () => {
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), name: "<script>alert(1)</script>" }), /executable_content/);
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), publisher: "api_key: abc123" }), /credential_shaped/);
    const authority = structuredClone(declarativeManifest()) as Record<string, any>;
    authority.ui.projectTabs[0].label = "grant access to admins";
    assert.throws(() => parseModuleManifestV1(authority), /authority_shaped/);
    const polluted = JSON.parse(JSON.stringify(declarativeManifest()).replace(
      '"bed-count":',
      '"constructor":{"type":"string","title":"Unsafe"},"bed-count":',
    ));
    assert.throws(() => parseModuleManifestV1(polluted), /module_manifest_prototype_pollution_key/);
  });

  it("requires paired scoped migration declarations and coherent limits", () => {
    const missingDown = structuredClone(declarativeManifest()) as Record<string, any>;
    delete missingDown.data.migrations[0].downFile;
    assert.throws(() => parseModuleManifestV1(missingDown), /downFile/);
    const unscoped = structuredClone(declarativeManifest()) as Record<string, any>;
    unscoped.data.projectScoped = false;
    assert.throws(() => parseModuleManifestV1(unscoped), /projectScoped/);
    const wrongNamespace = structuredClone(declarativeManifest()) as Record<string, any>;
    wrongNamespace.data.schemaNamespace = "module_someone_else";
    assert.throws(() => parseModuleManifestV1(wrongNamespace), /module_manifest_namespace_mismatch/);
    const duplicateMigration = structuredClone(declarativeManifest()) as Record<string, any>;
    duplicateMigration.data.migrations.push(structuredClone(duplicateMigration.data.migrations[0]));
    assert.throws(() => parseModuleManifestV1(duplicateMigration), /module_manifest_duplicate_migration/);
    const phantomSchedule = structuredClone(declarativeManifest()) as Record<string, any>;
    phantomSchedule.permissions.scheduledJobs.jobs = [];
    assert.throws(() => parseModuleManifestV1(phantomSchedule), /module_manifest_schedule_limits_without_jobs/);
  });

  it("refuses incoherent settings, duplicate declarations, and excessive input", () => {
    const wrongDefault = structuredClone(declarativeManifest()) as Record<string, any>;
    wrongDefault.ui.settings.properties["bed-count"].default = "four";
    assert.throws(() => parseModuleManifestV1(wrongDefault), /module_manifest_setting_default_invalid/);
    const badBounds = structuredClone(declarativeManifest()) as Record<string, any>;
    badBounds.ui.settings.properties["bed-count"].minimum = 101;
    assert.throws(() => parseModuleManifestV1(badBounds), /module_manifest_setting_bounds_invalid/);
    const unknownRequired = structuredClone(declarativeManifest()) as Record<string, any>;
    unknownRequired.ui.settings.required = ["missing-setting"];
    assert.throws(() => parseModuleManifestV1(unknownRequired), /module_manifest_unknown_required_setting/);
    const duplicateResource = structuredClone(declarativeManifest()) as Record<string, any>;
    duplicateResource.permissions.projectData.push(structuredClone(duplicateResource.permissions.projectData[0]));
    assert.throws(() => parseModuleManifestV1(duplicateResource), /module_manifest_duplicate_resource/);
    const duplicateAccess = structuredClone(declarativeManifest()) as Record<string, any>;
    duplicateAccess.permissions.projectData[0].access = ["read", "read"];
    assert.throws(() => parseModuleManifestV1(duplicateAccess), /module_manifest_duplicate_access/);
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), name: "x".repeat(140_000) }), /module_manifest_input_oversized/);
  });

  it("refuses malformed, unknown-version, too-deep, and non-printable input", () => {
    assert.throws(() => parseModuleManifestV1(null), /module_manifest_malformed/);
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), schema: "control-room.module-manifest/v2" }), /module_manifest_unknown_version/);
    let nested: Record<string, unknown> = {};
    for (let index = 0; index < 14; index += 1) nested = { nested };
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), extra: nested }), /module_manifest_input_too_deep/);
    assert.throws(() => parseModuleManifestV1({ ...declarativeManifest(), name: "bad\u0000text" }), /not_printable/);
  });
});

describe("module registry and runtime permission gate", () => {
  it("derives the legacy configuration order from registered manifests", () => {
    assert.deepEqual([...REGISTERED_MODULE_IDS_V1], ["ideaLab", "news", "sessionObservations"]);
    assert.equal(PRODUCT_CONFIGURATION_MODULES_V1, REGISTERED_MODULE_IDS_V1);
    assert.equal(MODULE_REGISTRY_V1.news.name, "News");
    assert.equal(MODULE_REGISTRY_V1.ideaLab.name, "Idea Lab");
    assert.equal(MODULE_REGISTRY_V1.news.class, "code");
    assert.equal(Object.isFrozen(MODULE_REGISTRY_V1.news), true);
    assert.ok(MODULE_REGISTRY_V1.news.permissions.projectData.some(({ resource }) => resource === "control_news_discovery_baselines"));
    assert.ok(MODULE_REGISTRY_V1.ideaLab.permissions.projectData.some(({ resource }) => resource === "control_idea_bot_run_events"));
    assert.deepEqual(MODULE_REGISTRY_V1.sessionObservations.permissions.projectData, []);
  });

  it("requires exact installed id and version", () => {
    assert.equal(getRegisteredModuleManifestV1("news", "1.0.0").id, "news");
    assert.throws(() => getRegisteredModuleManifestV1("news", "2.0.0"), /module_registry_version_unavailable/);
    assert.throws(() => getRegisteredModuleManifestV1("missing", "1.0.0"), /module_registry_unknown_module/);
  });

  it("returns a narrow scope-bound receipt for a declared resource", () => {
    const permission = assertModuleProjectDataPermissionV1({
      moduleId: "news",
      moduleVersion: "1.0.0",
      tenantId: "tenant-1",
      projectId: "project-1",
      resource: "control_news_story_versions",
      access: "read",
    });
    assert.deepEqual(permission, {
      moduleId: "news",
      moduleVersion: "1.0.0",
      tenantId: "tenant-1",
      projectId: "project-1",
      resource: "control_news_story_versions",
      access: "read",
      authorized: true,
    });
    assert.equal(Object.isFrozen(permission), true);
  });

  it("denies undeclared scopes, malformed scope, extra authority, and retries", () => {
    const base = {
      moduleId: "news",
      moduleVersion: "1.0.0",
      tenantId: "tenant-1",
      projectId: "project-1",
      resource: "control_idea_sessions",
      access: "read" as const,
    };
    assert.throws(() => assertModuleProjectDataPermissionV1(base), /module_permission_denied/);
    assert.throws(() => assertModuleProjectDataPermissionV1(base), /module_permission_denied/);
    assert.throws(() => assertModuleProjectDataPermissionV1({ ...base, tenantId: "" }), /module_permission_invalid_scope/);
    assert.throws(() => assertModuleProjectDataPermissionV1({ ...base, databaseRole: "anything" } as never), /module_permission_unknown_key/);
    assert.throws(() => assertModuleProjectDataPermissionV1({ ...base, access: "delete" } as never), /module_permission_invalid_access/);
    assert.throws(() => assertModuleProjectDataPermissionV1({ ...base, moduleVersion: "9.0.0" }), /module_registry_version_unavailable/);
    assert.throws(() => assertModuleProjectDataPermissionV1(null as never), /module_permission_malformed/);
    const missingVersion = { ...base } as Record<string, unknown>;
    delete missingVersion.moduleVersion;
    assert.throws(() => assertModuleProjectDataPermissionV1(missingVersion as never), /module_permission_malformed/);
    const missingTenant = { ...base } as Record<string, unknown>;
    delete missingTenant.tenantId;
    assert.throws(() => assertModuleProjectDataPermissionV1(missingTenant as never), /module_permission_invalid_scope/);
  });

  it("keeps concurrent callers scoped to their own immutable receipts", async () => {
    const request = (projectId: string) => ({
      moduleId: "ideaLab",
      moduleVersion: "1.0.0",
      tenantId: "tenant-1",
      projectId,
      resource: "control_idea_sessions",
      access: "write" as const,
    });
    const [first, second] = await Promise.all([
      Promise.resolve().then(() => assertModuleProjectDataPermissionV1(request("project-1"))),
      Promise.resolve().then(() => assertModuleProjectDataPermissionV1(request("project-2"))),
    ]);
    assert.equal(first.projectId, "project-1");
    assert.equal(second.projectId, "project-2");
    assert.notEqual(first, second);
  });
});
