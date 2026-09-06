import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("package script keys are unique and posttest retains legacy and reuse checks", () => {
  const source = readFileSync(new URL("../package.json", import.meta.url), "utf8");
  const scriptSection = source.match(/"scripts":\s*\{([\s\S]*?)\n {2}\}/)?.[1];
  assert.ok(scriptSection, "scripts object must be found before parsing away duplicate keys");
  const names = [...scriptSection.matchAll(/^\s*"([^"\n]+)"\s*:/gm)].map(match => match[1]);
  assert.equal(new Set(names).size, names.length, "duplicate scripts silently discard verification");
  const command = JSON.parse(source).scripts.posttest;
  assert.ok(command.startsWith("node --import tsx --test "));
  const paths = command.slice("node --import tsx --test ".length).split(" ");
  assert.equal(new Set(paths).size, paths.length);
  for (const required of ["tests/public-release-tooling.test.ts", "tests/connection-enrollment-private-loopback-target-runtime-attestation.test.ts",
    "tests/installed-native-queue.test.ts", "tests/web-task-attention.test.tsx", "tests/web-task-approval-editor.test.ts",
    "scripts/research/pg-boss-submission-integration.test.mjs", "scripts/research/pg-boss-worker-integration.test.mjs",
    "tests/package-script-inventory.test.mjs"]) assert.ok(paths.includes(required), required);
});
