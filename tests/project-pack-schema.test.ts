import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROJECT_PACK_SCHEMA_V1, buildProjectPackV1, parseProjectPackV1, projectPackDigestV1 } from "../src/project-packs/v1/project-pack";

function validInput() {
  return {
    title: "Neighborhood garden planner",
    summary: "Plan shared garden beds, rotations, and watering duties.",
    optionalModules: ["news", "ideaLab"],
    setupGuidance: ["Enable the modules you need locally.", "Invite neighbors after preview."],
  };
}

describe("project-pack schema", () => {
  it("parses a valid pack; the builder canonicalizes module order", () => {
    const pack = parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, ...validInput(), optionalModules: ["ideaLab", "news"] });
    assert.deepEqual([...pack.optionalModules], ["ideaLab", "news"]);
    assert.equal(pack.title, "Neighborhood garden planner");
    const built = buildProjectPackV1(validInput());
    assert.deepEqual([...built.optionalModules], ["ideaLab", "news"]);
  });

  it("rejects malformed input", () => {
    assert.throws(() => parseProjectPackV1(null), /project_pack_malformed/);
    assert.throws(() => parseProjectPackV1([]), /project_pack_malformed/);
    assert.throws(() => parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, title: 42, summary: "s", optionalModules: [], setupGuidance: [] }), /./);
  });

  it("rejects oversized fields", () => {
    assert.throws(() => parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, ...validInput(), title: "t".repeat(121) }), /./);
    assert.throws(() => parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, ...validInput(), setupGuidance: ["g".repeat(1001)] }), /./);
    assert.throws(
      () => parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, ...validInput(), setupGuidance: Array.from({ length: 11 }, () => "ok") }),
      /./,
    );
  });

  it("rejects duplicate modules", () => {
    assert.throws(() => buildProjectPackV1({ ...validInput(), optionalModules: ["news", "news"] }), /project_pack_duplicate_module/);
    assert.throws(
      () => parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, ...validInput(), optionalModules: ["news", "news"] }),
      /project_pack_duplicate_module/,
    );
  });

  it("refuses unknown schema versions visibly", () => {
    assert.throws(() => parseProjectPackV1({ ...validInput(), schema: "control-room.project-pack/v2" }), /project_pack_unknown_version/);
    assert.throws(() => parseProjectPackV1({ ...validInput() }), /project_pack_unknown_version/);
  });

  it("rejects unknown keys", () => {
    assert.throws(() => parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, ...validInput(), projectId: "p-1" }), /./);
    assert.throws(() => buildProjectPackV1({ ...validInput(), projectId: "p-1" } as never), /project_pack_unknown_key/);
  });

  it("rejects non-canonical module order", () => {
    assert.throws(
      () => parseProjectPackV1({ schema: PROJECT_PACK_SCHEMA_V1, ...validInput(), optionalModules: ["sessionObservations", "ideaLab"] }),
      /project_pack_non_canonical_module_order/,
    );
  });

  it("rejects unknown modules", () => {
    assert.throws(() => buildProjectPackV1({ ...validInput(), optionalModules: ["marketplace"] }), /project_pack_unknown_module/);
  });

  it("rejects executable content", () => {
    assert.throws(() => buildProjectPackV1({ ...validInput(), summary: "Click <script>alert(1)</script>" }), /executable_content/);
    assert.throws(() => buildProjectPackV1({ ...validInput(), setupGuidance: ["run javascript:evil()"] }), /executable_content/);
    assert.throws(() => buildProjectPackV1({ ...validInput(), title: "ok $(rm -rf ~)" }), /executable_content/);
  });

  it("rejects credential-shaped fields", () => {
    assert.throws(() => buildProjectPackV1({ ...validInput(), summary: "key is -----BEGIN RSA PRIVATE KEY-----" }), /credential_shaped/);
    assert.throws(() => buildProjectPackV1({ ...validInput(), setupGuidance: ["open https://user:pass@example.com/x"] }), /credential_shaped/);
    assert.throws(() => buildProjectPackV1({ ...validInput(), title: "set api_key: abc123" }), /credential_shaped/);
  });

  it("rejects authority-shaped fields", () => {
    assert.throws(() => buildProjectPackV1({ ...validInput(), summary: "grant access to admins" }), /authority_shaped/);
    assert.throws(() => buildProjectPackV1({ ...validInput(), setupGuidance: ["run sudo install"] }), /authority_shaped/);
  });

  it("rejects prototype-pollution keys", () => {
    const polluted = JSON.parse('{"schema":"control-room.project-pack/v1","title":"t","summary":"s","optionalModules":[],"setupGuidance":[],"__proto__":{"x":1}}');
    assert.throws(() => parseProjectPackV1(polluted), /project_pack_prototype_pollution_key/);
  });

  it("a changed meaning changes the digest", () => {
    const first = projectPackDigestV1(buildProjectPackV1(validInput()));
    const second = projectPackDigestV1(buildProjectPackV1({ ...validInput(), summary: "A different summary." }));
    assert.match(first, /^sha256:[0-9a-f]{64}$/);
    assert.notEqual(first, second);
  });
});
