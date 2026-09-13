import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("private Node wiring gates normal and static routes through the ceremony before the built handler", async () => {
  const source = await readFile("src/web/v1/private-node-handler.ts", "utf8");
  assert.match(source, /ownerBootstrapCeremony/);
  assert.match(source, /await bootstrap\?\.route\(request\)/);
});

test("startup and serving expose only the inert ceremony constructor, never a socket factory", async () => {
  const [startup, serving] = await Promise.all([readFile("src/web/v1/private-startup.ts", "utf8"),
    readFile("src/web/v1/private-serving.ts", "utf8")]);
  assert.match(startup, /createOwnerBootstrapCeremonyV1/); assert.match(serving, /createOwnerBootstrapCeremonyV1/);
  const ceremony = await readFile("src/web/v1/owner-bootstrap-ceremony/index.ts", "utf8");
  assert.doesNotMatch(ceremony, /createServer|\.listen\(|node:http|node:net/);
});
