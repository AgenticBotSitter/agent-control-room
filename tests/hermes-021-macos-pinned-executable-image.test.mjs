import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

const run = promisify(execFile), nativeTest = process.platform === "darwin" ? test : test.skip;
let root, probe, original, alternate;

before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-hermes-pinned-image-");
  probe = join(root, "probe"); original = join(root, "target-original");
  alternate = join(root, "target-alternate");
  const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror"];
  await run("/usr/bin/clang", [...flags,
    "tests/helpers/macos-pinned-executable-image-probe.c", "-o", probe]);
  await run("/usr/bin/clang", [...flags,
    "tests/helpers/macos-pinned-executable-image-target.c", "-o", original]);
  await run("/usr/bin/clang", [...flags, "-DACR_ALTERNATE=1",
    "tests/helpers/macos-pinned-executable-image-target.c", "-o", alternate]);
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function absent(path) { await assert.rejects(access(path), { code: "ENOENT" }); }

nativeTest("mapped-vnode observation sees the held native inode while suspended", async () => {
  const executable = join(root, "exact-target"), marker = join(root, "exact-ran");
  await copyFile(original, executable); await chmod(executable, 0o700);
  const result = await run(probe, [executable, marker]);
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  await absent(marker);
});

nativeTest("mapped-vnode observation detects a post-review pathname replacement", async () => {
  const executable = join(root, "reviewed-target"), replacement = join(root, "replacement-target");
  const marker = join(root, "replacement-ran");
  await copyFile(original, executable); await copyFile(original, replacement);
  await chmod(executable, 0o700); await chmod(replacement, 0o700);
  await assert.rejects(run(probe, [executable, replacement, marker]), error => {
    assert.equal(error.code, 10); return true;
  });
  await absent(marker);
});

nativeTest("same-inode byte substitution defeats mapped-vnode observation and keeps qualification blocked", async () => {
  const executable = join(root, "mutable-target"), substitute = alternate;
  const marker = join(root, "mutable-ran");
  await copyFile(original, executable); await chmod(executable, 0o700);
  const result = await run(probe, [executable, substitute, "same-inode", marker]);
  assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  await absent(marker);
});

nativeTest("a reviewed shebang launcher is refused because its mapped image is the interpreter", async () => {
  const script = join(root, "script-target"), marker = join(root, "script-ran");
  await writeFile(script, `#!/bin/sh\nprintf ran > "${marker}"\n`, { mode: 0o700, flag: "wx" });
  await assert.rejects(run(probe, [script, marker]), error => {
    assert.equal(error.code, 10); return true;
  });
  await absent(marker);
});
