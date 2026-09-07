import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { createContributorDemoApplication } from "../src/contributor-demo/application.ts";
import { loadPrivateClientAssets } from "../src/web/v1/private-assets.ts";
import { nodeExchange } from "./helpers/web-node.ts";
import { resolve } from "node:path";

test("built demo assembles with authenticated backend and serves only snapshot assets", async t => {
  await assert.rejects(loadPrivateClientAssets(resolve("dist-contributor/client")), /private_assets_invalid/);
  const app = await createContributorDemoApplication(process.cwd());
  t.after(() => app.close());
  async function send(options = {}) {
    const exchange = nodeExchange(options);
    exchange.input.rawHeaders[1] = "127.0.0.1:3000";
    await app.handle(exchange.input, exchange.output);
    return exchange;
  }
  const page = await send({ path: "/local-preview" });
  assert.equal(page.output.statusCode, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const script = [...page.body().matchAll(/src="([^"]+\.js)"/g)][0][1];
  assert.equal((await send({ path: script })).output.statusCode, 200);
  assert.equal((await send({ path: "/package.json" })).output.statusCode, 404);
  assert.equal((await send({ path: "/api/v1/local-pilot/workspace?resource=projects" })).output.statusCode, 401);
  const login = await send({ path: "/api/v1/local-pilot/session", method: "POST", headers: [
    "origin", app.origin, "content-type", "application/json",
  ], body: JSON.stringify({ ownerCode: app.ownerCode }) });
  assert.equal(login.output.statusCode, 201);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  assert.equal((await send({ path: "/api/v1/local-pilot/workspace?resource=projects", headers: ["cookie", cookie] })).output.statusCode, 200);
  await app.close();
  assert.equal(app.isReady(), false);
  assert.equal((await send({ path: "/local-preview" })).output.statusCode, 503);
});

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
