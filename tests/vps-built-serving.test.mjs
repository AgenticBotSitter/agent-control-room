import assert from "node:assert/strict";
import { realpath, access, readFile } from "node:fs/promises";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createPrivateWebBootstrap } from "../dist-vps/server/bootstrap.js";
import { installPrivateWebProcess } from "../dist-vps/server/runtime.js";
import { loadPrivateClientAssets, createPrivateNodeHandler, createPrivateNodeService } from "../dist-vps/server/serving.js";
import { limitedWebFixture, startupConfig } from "./helpers/web-startup.ts";
import { now, request } from "./helpers/web-foundation.ts";
import { nodeExchange } from "./helpers/web-node.ts";

test("compiled serving entry stays inert and snapshots only the built browser assets", async () => {
  assert.equal(typeof createPrivateNodeService, "function");
  const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
  assert.ok(assets.count > 2); assert.match(assets.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(assets.respond("/vinext-client-entry-manifest.json", "GET"), undefined);
  assert.equal(assets.respond("/control-room-preview.png", "GET"), undefined);
  await assert.rejects(access("dist-vps/client/control-room-preview.png"), { code: "ENOENT" });
  assert.deepEqual(await readFile("dist-vps/client/favicon.svg"), await readFile("public/favicon.svg"));
  assert.equal(assets.respond("/../server/bootstrap.js", "GET"), undefined);
  assert.equal(assets.respond("/favicon.svg", "GET").status, 200);
  assert.equal((await handler(request())).status, 503);
});

test("compiled Node bridge reaches authenticated SQL routes without a physical listener", async () => {
  const f = await limitedWebFixture();
  const bootstrap = createPrivateWebBootstrap({ openDatabase: () => f.pool, install: installPrivateWebProcess, clock: () => now });
  const app = await bootstrap.start(startupConfig);
  const assets = await loadPrivateClientAssets(await realpath("dist-vps/client"));
  const bridge = createPrivateNodeHandler({ origin: startupConfig.origin, application: app, assets, handler });
  async function send(webRequest) {
    const x = nodeExchange({ path: new URL(webRequest.url).pathname, method: webRequest.method,
      headers: [...webRequest.headers].flat(), body: webRequest.body ? await webRequest.text() : undefined });
    await bridge.handle(x.input, x.output); return x;
  }
  try {
    const denied = await send(new Request(`${startupConfig.origin}/projects`)); assert.equal(denied.output.statusCode, 401);
    const created = await send(request(undefined, "POST", { title: "Node bridge project", summary: "Compiled restricted SQL" }));
    assert.equal(created.output.statusCode, 201);
    const catalog = await send(request()); assert.equal(catalog.output.statusCode, 200);
    assert.ok(JSON.parse(catalog.body()).projects.some(project => project.title === "Node bridge project"));
    const page = await send(request("/projects")); assert.equal(page.output.statusCode, 200);
    assert.match(page.body(), /Loading projects/);
    const references = [...page.body().matchAll(/(?:src|href)="(\/_next\/static\/[^"?#]+)"/g)].map(match => match[1]);
    assert.ok(references.some(path => path.endsWith(".js"))); assert.ok(references.some(path => path.endsWith(".css")));
    for (const path of references) assert.equal(assets.respond(path, "GET")?.status, 200, path);
    const css = (await Promise.all(references.filter(path => path.endsWith(".css"))
      .map(path => assets.respond(path, "GET").text()))).join("\n");
    const labelRules = [...css.matchAll(/([^{}]*\.(?:simulation-only|prototype-badge)[^{}]*)\{([^{}]*)\}/g)];
    assert.ok(labelRules.length > 0, "served CSS includes the action-boundary label rules");
    assert.ok(labelRules.some(rule => /font-size:\s*\.875rem/.test(rule[2]) && /overflow-wrap:\s*anywhere/.test(rule[2])));
    for (const rule of labelRules) assert.doesNotMatch(rule[2], /display:\s*none|visibility:\s*hidden/);
    const head = await send(new Request(request("/projects"), { method: "HEAD" }));
    assert.equal(head.output.statusCode, 200); assert.equal(head.body(), "");
    const logout = await send(request("/api/v1/session/logout", "POST")); assert.equal(logout.output.statusCode, 204);
    assert.equal((await send(request())).output.statusCode, 401);
  } finally { await bridge.close(); }
  assert.equal(bridge.isReady(), false); assert.equal(f.closes(), 1);
});
