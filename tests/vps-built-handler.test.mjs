import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import test from "node:test";
import handler from "../dist-vps/server/index.js";

test("compiled Node entry protects pages, APIs and streams before application composition", async () => {
  assert.equal(typeof handler, "function");
  for (const path of ["/", "/ideas", "/api/v1/projects", "/api/v1/operator-surface", "/api/v1/projects/project:test/events"]) {
    const response = await handler(new Request(`https://private.example.invalid${path}`));
    assert.equal(response.status, 503, path);
    assert.deepEqual(await response.json(), { error: "private_app_not_configured" });
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});
test("Node client/SSR artifacts are separate from Sites metadata", () => {
  assert.equal(existsSync("dist-vps/server/ssr/index.js"), true);
  assert.ok(readdirSync("dist-vps/client/_next/static").length > 0);
  assert.equal(existsSync("dist-vps/.openai/hosting.json"), false);
});
