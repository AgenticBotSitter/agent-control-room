import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectPackV1,
  exportProjectPackV1,
  parseProjectPackV1,
  previewProjectPackV1,
  projectPackDigestV1,
} from "../src/project-packs/v1/project-pack";

const FULL_LOCAL = { modules: { ideaLab: true, news: true, sessionObservations: true } };
const PARTIAL_LOCAL = { modules: { ideaLab: true, news: false, sessionObservations: false } };

describe("project-pack roundtrip", () => {
  it("build, serialize, parse and preview share one digest", () => {
    const built = buildProjectPackV1({
      title: "Book club kit",
      summary: "Everything a new chapter needs to start reading together.",
      optionalModules: ["sessionObservations", "ideaLab"],
      setupGuidance: ["Pick a first book.", "Schedule the first meeting."],
    });
    const digest = projectPackDigestV1(built);
    const reparsed = parseProjectPackV1(JSON.parse(exportProjectPackV1(built)));
    assert.equal(projectPackDigestV1(reparsed), digest);
    assert.deepEqual(JSON.parse(exportProjectPackV1(reparsed)), JSON.parse(exportProjectPackV1(built)));
  });

  it("canonical JSON is stable across key ordering", () => {
    const built = buildProjectPackV1({ title: "T", summary: "S", optionalModules: [], setupGuidance: [] });
    const shuffled = { setupGuidance: [], optionalModules: [], summary: "S", title: "T", schema: built.schema };
    assert.equal(exportProjectPackV1(parseProjectPackV1(shuffled)), exportProjectPackV1(built));
  });

  it("two local configurations produce truthful previews without modifying the pack", () => {
    const pack = buildProjectPackV1({
      title: "T",
      summary: "S",
      optionalModules: ["ideaLab", "news"],
      setupGuidance: ["Read the preview first."],
    });
    const before = exportProjectPackV1(pack);
    const full = previewProjectPackV1(pack, FULL_LOCAL.modules);
    const partial = previewProjectPackV1(pack, PARTIAL_LOCAL.modules);
    assert.deepEqual([...full.supportedModules], ["ideaLab", "news"]);
    assert.deepEqual([...full.unsupportedModules], []);
    assert.deepEqual([...full.warnings], []);
    assert.deepEqual([...partial.supportedModules], ["ideaLab"]);
    assert.deepEqual([...partial.unsupportedModules], ["news"]);
    assert.deepEqual([...partial.warnings], ["module_not_supported_locally:news"]);
    assert.equal(exportProjectPackV1(pack), before);
    assert.equal(partial.title, "T");
  });

  it("preview rejects a malformed local configuration", () => {
    const pack = buildProjectPackV1({ title: "T", summary: "S" });
    assert.throws(() => previewProjectPackV1(pack, { modules: { ideaLab: true } }), /./);
    assert.throws(() => previewProjectPackV1(pack, { modules: { ideaLab: true, news: false, sessionObservations: false, extra: true } }), /./);
  });
});
