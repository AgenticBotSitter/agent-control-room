import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const testFile = /\.test\.(?:ts|tsx|mjs|js)$/u;
// Built from fragments so this guard does not match its own assertion source.
const dynamicTestImport = new RegExp(["\\bimport", "\\s*\\(", "\\s*[\"']", "[^\"']*",
  "\\.test\\.(?:ts|tsx|mjs|js)", "[\"']", "\\s*\\)"].join(""), "gu");

function testSources(directory = join(repositoryRoot, "tests")) {
  const sources = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) sources.push(...testSources(path));
    else if (entry.isFile() && testFile.test(entry.name)) sources.push([path, readFileSync(path, "utf8")]);
  }
  return sources;
}

export function dynamicTestImports(sources) {
  return sources.flatMap(([path, source]) => [...source.matchAll(dynamicTestImport)]
    .map(match => `${relative(repositoryRoot, path)}:${match.index}`));
}

test("test files never dynamically import another test file", () => {
  assert.deepEqual(dynamicTestImports(testSources()), [],
    "dynamic test-module imports register tests in the active runner and can cancel another lane");
});

test("dynamic test-file imports are refused", () => {
  const forbidden = ["import", "(", "\"./other.test.ts\"", ")"].join("");
  assert.deepEqual(dynamicTestImports([[join(repositoryRoot, "tests", "fixture.test.ts"), forbidden]]),
    ["tests/fixture.test.ts:0"]);
});
