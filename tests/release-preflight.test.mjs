// Preflight tests: version gates, loopback binding, config trust boundary.
// Fixture files and ephemeral ports only — no system changes.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkArtifact, checkConfiguration, checkLoopbackBind, checkNodeVersion, checkPnpmVersion, compareVersions, runPreflight } from "../scripts/release/preflight.mjs";

test("version comparison gates minimums exactly", () => {
  assert.equal(compareVersions("22.13.0", "22.13.0"), 0);
  assert.equal(compareVersions("22.14.0", "22.13.0"), 1);
  assert.equal(compareVersions("22.12.9", "22.13.0"), -1);
  assert.equal(compareVersions("v22.13.0", "22.13.0"), 0);
  assert.equal(checkNodeVersion("22.13.0").ok, true);
  assert.equal(checkNodeVersion("20.0.0").ok, false);
  assert.equal(checkPnpmVersion(() => "11.19.0\n").ok, true);
  assert.equal(checkPnpmVersion(() => "10.0.0").ok, false);
  assert.equal(checkPnpmVersion(() => { throw new Error("nope"); }).ok, false);
});

test("loopback bind proves 127.0.0.1 works; occupied port fails honestly", async () => {
  const free = await checkLoopbackBind(0);
  assert.equal(free.ok, true);
  const holder = createServer();
  await new Promise(resolve => holder.listen(0, "127.0.0.1", resolve));
  const port = holder.address().port;
  const busy = await checkLoopbackBind(port);
  assert.equal(busy.ok, false);
  assert.match(busy.detail, new RegExp(`port ${port} unavailable`));
  await new Promise(resolve => holder.close(resolve));
});

test("configuration trust mirrors the private-VPS boundary", async () => {
  if (typeof process.getuid !== "function") return; // boundary is POSIX-only
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  try {
    const good = join(dir, "operator.mjs");
    writeFileSync(good, "export {};\n");
    chmodSync(good, 0o600);
    const ok = await checkConfiguration(good);
    assert.equal(ok.ok, true);

    const groupReadable = join(dir, "group.mjs");
    writeFileSync(groupReadable, "export {};\n");
    chmodSync(groupReadable, 0o640);
    assert.equal((await checkConfiguration(groupReadable)).ok, false);

    const link = join(dir, "link.mjs");
    symlinkSync(good, link);
    assert.equal((await checkConfiguration(link)).ok, false);

    assert.equal((await checkConfiguration(join(dir, "absent.mjs"))).ok, false);
    assert.equal((await checkConfiguration("relative/path.mjs")).ok, false);
    assert.equal((await checkConfiguration("")).ok, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("full preflight passes on valid inputs, fails closed on bad ones", async () => {
  if (typeof process.getuid !== "function") return;
  const dir = mkdtempSync(join(tmpdir(), "preflight-test-"));
  try {
    const good = join(dir, "operator.mjs");
    writeFileSync(good, "export {};\n");
    chmodSync(good, 0o600);
    const pass = await runPreflight({ configuration: good });
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.failures, []);
    const bad = await runPreflight({ configuration: join(dir, "absent.mjs") });
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.failures, ["configuration"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("artifact check verifies integrity, skips cleanly when absent", () => {
  const skipped = checkArtifact(".", "");
  assert.equal(skipped.ok, true);
  const missing = checkArtifact(".", "dist-nope");
  assert.equal(missing.ok, false);
});
