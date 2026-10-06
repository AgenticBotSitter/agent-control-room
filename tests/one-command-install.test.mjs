import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
const source = await readFile(script, "utf8");
const attempt = async (...args) => run("/bin/sh", ["-c", source, "install", ...args], { stdio: "pipe" })
  .then(result => ({ code: 0, ...result }), error => ({ code: error.code, stderr: error.stderr }));

test("one-command install refuses a missing or malformed commit before any download or sudo", async () => {
  for (const args of [[], [""], ["abc"], ["g".repeat(40)], ["A".repeat(40)], ["a".repeat(39)], ["a".repeat(41)]]) {
    const result = await attempt(...args);
    assert.notEqual(result.code, 0, JSON.stringify(args));
    assert.match(result.stderr, /Control Room install stopped: (give the 40-character release commit|this installer is for Apple silicon Macs)/u);
  }
});

test("one-command install needs a Terminal for the phone code and is not run with sudo", async () => {
  // execFile gives no terminal on stdin, so a correct commit stops at the terminal check
  // (or, on a non-Apple-silicon host, at the platform check) and never reaches the network.
  const result = await attempt("a".repeat(40));
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /run it in a Terminal window|this installer is for Apple silicon Macs|not with sudo/u);
});

test("one-command install downloads the bootstrap pinned to that commit as root, into a root-only folder, and confirms by command", () => {
  // Everything privileged is one fixed root command: no file the login can write is ever run as root.
  const root = /exec \/usr\/bin\/sudo \/bin\/sh -c '([^']+)' control-room-install "\$commit"\n$/u.exec(source);
  assert.ok(root, "the install ends in one fixed sudo command");
  const inner = root[1];
  assert.match(inner, /root=\$\(\/usr\/bin\/mktemp -d \/var\/root\/cr-boot\.XXXXXX\)/u);
  assert.match(inner, /-o "\$root\/bootstrap\.sh"/u);
  assert.match(inner, /"https:\/\/raw\.githubusercontent\.com\/AgenticBotSitter\/agent-control-room\/\$commit\/scripts\/install-night\/bootstrap\.sh"/u);
  assert.match(inner, /--proto "=https"/u);
  assert.match(inner, /exec \/bin\/sh "\$root\/bootstrap\.sh" "\$commit" "\$root" --confirmed-by-command yes$/u);
  assert.doesNotMatch(source, /\/private\/tmp|\$work/u, "no download into a folder the login can write");
  assert.doesNotMatch(source, /\| *(ba|z)?sh/u, "never pipes a download into a shell");
});

test("one-command install checks for Apple's Command Line Tools before asking for anything", () => {
  const tools = source.indexOf("/usr/bin/xcode-select -p"), sudo = source.indexOf("/usr/bin/sudo");
  assert.ok(tools > 0 && tools < sudo);
  assert.match(source, /xcode-select --install/u);
});
