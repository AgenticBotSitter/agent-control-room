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

test("recent checkpoint and host tests remain in standard verification commands", () => {
  const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
  const main = scripts.test.split(" ");
  for (const path of ["tests/completion-bounded-checkpoint-call.test.ts", "tests/completion-etcd-checkpoint-record.test.ts",
    "tests/web-private-host-shutdown.test.ts", "tests/web-private-host-lifecycle.test.ts", "tests/private-vps-launcher.test.mjs"]) {
    assert.equal(main.filter(value => value === path).length, 1, path);
  }
  assert.equal(scripts["test:build:vps"].split(" ").filter(value => value === "tests/vps-built-launcher.test.mjs").length, 1);
  assert.ok(!scripts.test.includes("etcd-grpc-evaluation"), "external retained packages remain explicit research only");
});
