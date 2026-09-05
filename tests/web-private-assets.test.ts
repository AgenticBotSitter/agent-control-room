import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPrivateClientAssets } from "../src/web/v1/private-assets.ts";

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cr14b-assets-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const client = join(root, "dist-vps/client"), chunks = join(client, "_next/static/chunks");
  await mkdir(chunks, { recursive: true });
  await writeFile(join(chunks, "app.js"), "compiled fixture");
  await writeFile(join(client, "favicon.svg"), "<svg/>");
  return { root, client, chunks };
}
test("asset startup snapshots only fixed client assets, excludes manifests/maps and never follows request paths", async t => {
  const f = await fixture(t);
  await writeFile(join(f.chunks, "app.js.map"), "not public");
  await writeFile(join(f.client, "private.txt"), "not public");
  const assets = await loadPrivateClientAssets(f.client);
  assert.equal(assets.count, 2); assert.match(assets.digest, /^sha256:[a-f0-9]{64}$/);
  await writeFile(join(f.chunks, "app.js"), "changed after startup");
  assert.equal(await assets.respond("/_next/static/chunks/app.js", "GET")?.text(), "compiled fixture");
  assert.equal(await assets.respond("/_next/static/chunks/app.js", "HEAD")?.text(), "");
  for (const path of ["/private.txt", "/_next/static/chunks/app.js.map", "/_next/static/chunks/", "/../server/index.js"])
    assert.equal(assets.respond(path, "GET"), undefined);
  assert.equal(assets.respond("/_next/static/chunks/app.js", "POST"), undefined);
});
test("asset startup refuses symbolic links and an incorrect root", async t => {
  const f = await fixture(t);
  await assert.rejects(loadPrivateClientAssets(f.root), /private_assets_invalid/);
  await symlink(join(f.client, "favicon.svg"), join(f.chunks, "alias.svg"));
  await assert.rejects(loadPrivateClientAssets(f.client), /private_assets_invalid/);
});
test("asset startup enforces file byte ceiling and sanitized failure", async t => {
  const f = await fixture(t);
  await writeFile(join(f.chunks, "large.js"), new Uint8Array(4 * 1024 * 1024 + 1));
  await assert.rejects(loadPrivateClientAssets(f.client), { message: "private_assets_invalid" });
});
