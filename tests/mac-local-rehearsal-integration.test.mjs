import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const sources = ["setup.ts", "journey.ts", "section13.ts"];

test("rehearsal entrypoints use registered asynchronous children and shared cleanup", async () => {
  for (const name of sources) {
    const source = await readFile(new URL(`../scripts/mac-local/rehearsal/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(?:spawnSync|execFileSync)\b/u, name);
    assert.match(source, /runBoundedChild/u, name);
    assert.match(source, /cleanupRehearsalRoot/u, name);
    assert.match(source, /installRehearsalSignalCleanup/u, name);
    assert.match(source, /processUpdate\.catch\(\(\) => \{\}\)/u, name);
    if (name !== "setup.ts") assert.doesNotMatch(source, /scripts\/mac-local\/down\.mjs/u, name);
  }
});

test("setup binds the PostgreSQL marker to the exact rehearsal run", async () => {
  const source = await readFile(new URL("../scripts/mac-local/rehearsal/setup.ts", import.meta.url), "utf8");
  assert.match(source, /runId:\s*ownership\.runId/u);
  assert.match(source, /await psql\("control_room", "\.\.\/\.\.\/\.\.\/db\/roles\/private_web_database\.sql"\)/u);
});

test("the public cleanup command targets only the ownership registry", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(packageJson.scripts["rehearsal:cleanup"], "node scripts/mac-local/rehearsal/cleanup.mjs");
  const source = await readFile(new URL("../scripts/mac-local/rehearsal/cleanup.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /mac:down|launchctl/u);
  assert.match(source, /runtime\.pgCtl\(ownership\.databaseDirectory/u);
  assert.match(source, /cleanupRegisteredRehearsals/u);
});
