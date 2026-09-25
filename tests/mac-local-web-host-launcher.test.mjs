import assert from "node:assert/strict";
import test from "node:test";
import { parseMacLocalWebHostArguments, readPinnedMacExecutableVersion } from "../scripts/mac-local/start-web-host.mjs";

test("Mac local web host launcher accepts only the owner-attended fixed protected root", () => {
  assert.deepEqual(parseMacLocalWebHostArguments(["--owner-attended", "--protected-root", "/Library/Application Support/Agent Control Room"]),
    { protectedRoot: "/Library/Application Support/Agent Control Room" });
  assert.deepEqual(parseMacLocalWebHostArguments(["--help"]), { help: true });
  for (const args of [[], ["--protected-root", "/tmp/x"], ["--owner-attended", "--protected-root", "relative"],
    ["--owner-attended", "--protected-root", "/tmp/x\n"]]) {
    assert.throws(() => parseMacLocalWebHostArguments(args), /mac_local_web_host_arguments_invalid/);
  }
});

test("Mac local web host reads a bounded exact executable version without shell expansion", async () => {
  const seen = [];
  const version = await readPinnedMacExecutableVersion("/usr/local/bin/example", { execFile: async (...args) => {
    seen.push(args); return { stdout: "example 1.2.3\n" };
  } });
  assert.equal(version, "example 1.2.3");
  assert.deepEqual(seen[0][0], "/usr/local/bin/example");
  assert.deepEqual(seen[0][1], ["--version"]);
  await assert.rejects(() => readPinnedMacExecutableVersion("/usr/local/bin/example", { execFile: async () => ({ stdout: "bad\nvalue" }) }),
    /mac_local_executable_version_unavailable/);
});
