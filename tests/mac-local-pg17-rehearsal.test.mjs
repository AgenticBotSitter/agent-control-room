import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";

test("PG17 rehearsal rejects extra application membership and a missing queue grant", {
  skip: !process.env.CONTROL_ROOM_MAC_REHEARSAL_ROOT,
}, () => {
  const root = process.env.CONTROL_ROOM_MAC_REHEARSAL_ROOT;
  assert.ok(isAbsolute(root), "rehearsal root must be absolute");
  const result = spawnSync(process.execPath, ["--import", "tsx",
    "scripts/mac-local/rehearsal/negative-probes.ts", resolve(root)], {
    encoding: "utf8", timeout: 120_000,
    env: { ...process.env, CONTROL_ROOM_PROTECTED_ROOT: resolve(root, "protected") },
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /PG17 queue-worker preflight and both least-privilege negative probes: PASS/u);
});
