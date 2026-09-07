import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

test("standalone browser output references only its emitted assets and excludes server implementations", () => {
  const root = "dist-contributor/client";
  const html = readFileSync(`${root}/index.html`, "utf8");
  assert.match(html, /Agent Control Room/);
  const assets = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]);
  assert.ok(assets.some(path => path.endsWith(".js")));
  assert.ok(assets.some(path => path.endsWith(".css")));
  for (const path of assets) {
    assert.match(path, /^\/(?:favicon\.svg|_next\/static\/[A-Za-z0-9_.-]+)$/);
    assert.ok(readFileSync(`${root}${path}`).length > 0);
  }
  for (const file of readdirSync(`${root}/_next/static`)) {
    assert.equal(file.endsWith(".map"), false);
    if (!file.endsWith(".js")) continue;
    const code = readFileSync(`${root}/_next/static/${file}`, "utf8");
    assert.doesNotMatch(code, /createControlRoomLocalPilotRuntimeV1|createContributorDemoRuntime|createContributorSimulations|node:crypto|node:fs|@electric-sql\/pglite|control_local_pilot_owner_sessions/);
    assert.match(code, /simulate_task/);
  }
});
