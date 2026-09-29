import assert from "node:assert/strict";
import test from "node:test";
import handler from "../dist-vps/server/index.js";
import { createLocalSetupHostV1 } from "../dist-vps/server/localSetupHost.js";

test("compiled setup page renders only through the transport marker before private application installation", async () => {
  assert.equal(typeof createLocalSetupHostV1, "function");
  const accepted = await handler(new Request("http://127.0.0.1:3210/setup", {
    headers: { "x-control-room-local-setup": "v1" },
  }));
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /Set up Control Room|Loading/);

  for (const request of [
    new Request("https://private.example.invalid/setup", { headers: { "x-control-room-local-setup": "v1" } }),
    new Request("http://127.0.0.1:3210/projects", { headers: { "x-control-room-local-setup": "v1" } }),
    new Request("http://127.0.0.1:3210/setup?x=1", { headers: { "x-control-room-local-setup": "v1" } }),
    new Request("http://127.0.0.1:3210/setup", { method: "POST", headers: { "x-control-room-local-setup": "v1" } }),
    new Request("http://127.0.0.1:3210/setup"),
  ]) assert.equal((await handler(request)).status, 503);
});
