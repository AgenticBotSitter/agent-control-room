import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProjectPack } from "../src/project-packs/project-pack";
import { buildProjectPackV1, PROJECT_PACK_SCHEMA_V1 } from "../src/project-packs/v1/project-pack";
import {
  PROJECT_PACK_SCHEMA_V2,
  buildProjectPackV2,
  exportProjectPackV2,
  parseProjectPackV2,
  projectPackDigestV2,
} from "../src/project-packs/v2/project-pack";

function input() {
  return {
    title: "Research starter",
    summary: "A portable research workflow.",
    modules: [{ id: "news", version: "1.0.0" }, { id: "ideaLab", version: "1.0.0" }],
    setupGuidance: ["Review every proposal before accepting it."],
  };
}

describe("project pack v2 module references", () => {
  it("builds canonical id plus version references and round-trips", () => {
    const built = buildProjectPackV2(input());
    assert.equal(built.schema, PROJECT_PACK_SCHEMA_V2);
    assert.deepEqual(built.modules, [
      { id: "ideaLab", version: "1.0.0" },
      { id: "news", version: "1.0.0" },
    ]);
    const reparsed = parseProjectPackV2(JSON.parse(exportProjectPackV2(built)));
    assert.deepEqual(reparsed, built);
    assert.equal(Object.isFrozen(reparsed.modules), true);
    assert.equal(Object.isFrozen(reparsed.modules[0]), true);
    assert.match(projectPackDigestV2(reparsed), /^sha256:[0-9a-f]{64}$/);
  });

  it("keeps v1 parsing while dispatching v2 independently", () => {
    const v1 = buildProjectPackV1({ title: "Legacy", summary: "Still supported.", optionalModules: ["news"] });
    const v2 = buildProjectPackV2(input());
    assert.equal(parseProjectPack(v1).schema, PROJECT_PACK_SCHEMA_V1);
    assert.equal(parseProjectPack(v2).schema, PROJECT_PACK_SCHEMA_V2);
  });

  it("allows portable references not installed in the local registry", () => {
    const pack = buildProjectPackV2({
      title: "Community pack",
      summary: "References a separately installable module.",
      modules: [{ id: "community.weather", version: "2.4.1" }],
    });
    assert.deepEqual(pack.modules, [{ id: "community.weather", version: "2.4.1" }]);
  });

  it("refuses duplicate ids, non-canonical input, bad versions, and unknown keys", () => {
    assert.throws(() => buildProjectPackV2({ ...input(), modules: [
      { id: "news", version: "1.0.0" },
      { id: "news", version: "2.0.0" },
    ] }), /project_pack_duplicate_module/);
    assert.throws(() => parseProjectPackV2({ schema: PROJECT_PACK_SCHEMA_V2, ...input() }), /project_pack_non_canonical_module_order/);
    assert.throws(() => buildProjectPackV2({ ...input(), modules: [{ id: "news", version: "latest" }] }), /project_pack_module_version_invalid/);
    assert.throws(() => buildProjectPackV2({ ...input(), command: "safe" } as never), /project_pack_unknown_key/);
  });

  it("inherits inert-text and prototype-pollution refusals", () => {
    assert.throws(() => buildProjectPackV2({ ...input(), summary: "run javascript:evil()" }), /executable_content/);
    assert.throws(() => buildProjectPackV2({ ...input(), title: "api_key: abc123" }), /credential_shaped/);
    assert.throws(() => buildProjectPackV2({ ...input(), setupGuidance: ["grant access to admins"] }), /authority_shaped/);
    const polluted = JSON.parse('{"schema":"control-room.project-pack/v2","title":"T","summary":"S","modules":[],"setupGuidance":[],"__proto__":{"x":1}}');
    assert.throws(() => parseProjectPackV2(polluted), /project_pack_prototype_pollution_key/);
    assert.throws(() => parseProjectPackV2({ ...buildProjectPackV2(input()), schema: "control-room.project-pack/v3" }), /project_pack_unknown_version/);
    assert.throws(() => parseProjectPack({ ...buildProjectPackV2(input()), schema: "control-room.project-pack/v3" }), /project_pack_unknown_version/);
  });
});
