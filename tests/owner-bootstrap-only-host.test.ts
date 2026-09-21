import assert from "node:assert/strict";
import test from "node:test";
import { createOwnerBootstrapOnlyHostV1 } from "../src/web/v1/owner-bootstrap-only-host";

const ceremony = (bootstrapOnly = true) => {
  let closed = 0;
  return { value: {
    isBootstrapOnly: () => bootstrapOnly,
    async arm() { throw new Error("owner_bootstrap_unavailable"); },
    async route() { return Response.json({ error: "owner_bootstrap_unavailable" }, { status: 503 }); },
    async close() { closed++; },
  }, closed: () => closed };
};

test("bootstrap-only host refuses construction without the complete ceremony boundary", () => {
  assert.throws(() => createOwnerBootstrapOnlyHostV1({ origin: "https://private.example.invalid", port: 3210,
    ceremony: {} as never }), /owner_bootstrap_host_invalid/);
});

test("bootstrap-only host never starts after owner creation and closes the ceremony", async () => {
  const x = ceremony(false);
  const host = createOwnerBootstrapOnlyHostV1({ origin: "https://private.example.invalid", port: 3210, ceremony: x.value });
  await assert.rejects(host.start(), /owner_bootstrap_host_unavailable/);
  await host.close();
  assert.equal(x.closed(), 1);
});
