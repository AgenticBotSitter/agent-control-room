import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const lanes = ["test:updater", "test:updater-schema", "test:updater-passkey-postgres",
  "test:pg-runtime-postgres", "test:pg-runtime-stress", "test:test-runner"];
// Synthetic fault injection at the package-runner boundary. The real shell
// block executes unchanged; no database or installed updater is launched.
const prelude = `set -euo pipefail
pnpm() { printf 'LANE %s\\n' "$2"; if [ "$2" = "$FAIL_LANE" ]; then return 17; fi; }
node() {
  if [ "$1" = scripts/ci/run-scripts-keep-going.mjs ]; then
    shift; status=0
    for lane in "$@"; do pnpm run "$lane" || status=$?; done
    return "$status"
  fi
  printf 'DARWIN\\n'
  return "$DARWIN_STATUS"
}
`;
for (const job of ["test-updater", "full-gate"]) {
  const block = workflow.split(`\n  ${job}:\n`)[1].split(/\n  [a-z][a-z-]+:/u)[0];
  const start = block.indexOf("          darwin_pg_status=0");
  const end = block.indexOf('          exit "${darwin_pg_status}"', start);
  assert.ok(start >= 0 && end > start, `${job} shell tail exists`);
  const shell = block.slice(start, end + '          exit "${darwin_pg_status}"'.length)
    .replace(/^          /gmu, "");
  for (const failed of ["none", "darwin", ...lanes]) {
    test(`${job} aggregates ${failed} and completes every lane`, () => {
      const root = mkdtempSync(join(tmpdir(), "acr-lane-status-"));
      try {
        const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", prelude + shell], {
          encoding: "utf8", timeout: 10_000,
          env: { ...process.env, HOME: root, FAIL_LANE: failed, DARWIN_STATUS: failed === "darwin" ? "19" : "0" },
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, failed === "none" ? 0 : failed === "darwin" ? 19 : 17, result.stderr);
        assert.deepEqual(result.stdout.trim().split("\n"), ["DARWIN", ...lanes.map(lane => `LANE ${lane}`)]);
        assert.deepEqual(readdirSync(root), [], "private PostgreSQL scratch cleanup reached");
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
}
