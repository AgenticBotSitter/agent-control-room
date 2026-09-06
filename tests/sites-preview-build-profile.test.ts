import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("private preview preserves hosting bindings and delegates its explicit Node target", () => {
  assert.equal(readFileSync("app/globals.css", "utf8").trim(), '@import "../styles/control-room.css";');
  assert.deepEqual(JSON.parse(readFileSync(".openai/hosting.json", "utf8")), { d1: null, r2: null });
  assert.match(readFileSync("vite.config.ts", "utf8"), /if \(nodeTarget\) return \(await import\("\.\/vite\.vps\.config"\)\)\.default/);
});
