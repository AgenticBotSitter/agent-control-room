import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createPrivateWebBootstrap, startPrivateWebApplication } from "../dist-vps/server/bootstrap.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup.ts";
import { now, request } from "./helpers/web-foundation.ts";

test("built bootstrap import is inert and its verified installation reaches the actual compiled routes", async () => {
  assert.equal(typeof startPrivateWebApplication, "function");
  assert.equal((await handler(request())).status, 503);
  const f = await limitedWebFixture();
  const bootstrap = createPrivateWebBootstrap({ openDatabase: () => f.pool, install: installPrivateWebProcess, clock: () => now });
  const app = await bootstrap.start(startupConfig);
  try {
    assert.equal(app.isReady(), true);
    assert.equal((await handler(request())).status, 200);
    const created = await handler(request(undefined, "POST", { title: "Built startup", summary: "Restricted disposable role" }));
    assert.equal(created.status, 201);
    assert.throws(() => installPrivateWebProcess({}), /already_configured/);
    const closing = app.close(); assert.equal(app.isReady(), false);
    assert.equal((await handler(request())).status, 503); await closing;
    assert.equal(f.closes(), 1);
  } finally { await app.close(); }
});

test("database startup, role checks and credential configuration stay out of browser assets", () => {
  const files = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(dir, entry.name)) : [join(dir, entry.name)]);
  for (const file of files("dist-vps/client").filter(path => path.endsWith(".js")))
    assert.doesNotMatch(readFileSync(file, "utf8"), /private_startup_prerequisites_failed|control_room_private_web|database_outcome_uncertain|transaction_timeout/);
});
