// Proves `invokedDirectlyV1` (scripts/dev/invoked-directly.mjs) agrees with the
// process about whether a script is the entry point, including through the
// symlinked paths macOS hands out by default.
//
// Why this exists: the two real-kill database upgrade tests spawn the staged
// upgrade step from a checkout under the temporary directory, and that child
// exited 0 without applying anything. The cause was the entry-point guard
// `process.argv[1] === fileURLToPath(import.meta.url)`: Node resolves the entry
// specifier to its REAL path before setting `import.meta.url`, while argv keeps
// the spelling the caller used, so any symlinked component makes the two strings
// differ. The guard then reads as false, the script's body never runs, and the
// caller sees a silent success. `/tmp` -> `/private/tmp` on macOS is enough.
//
// These tests drive the real function against real paths, and separately spawn a
// real script through a symlinked parent to prove the process-level behaviour
// the arithmetic only predicts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { invokedDirectlyV1 } from "../scripts/dev/invoked-directly.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const thisFile = fileURLToPath(import.meta.url);
const thisUrl = import.meta.url;

test("recognises this very test file as the entry point, and rejects everything else", () => {
  assert.equal(invokedDirectlyV1(thisFile, thisUrl), true,
    "the process was started with this file, so the guard must fire");
  assert.equal(invokedDirectlyV1(process.argv[1], thisUrl), true,
    "argv[1] is what the runner actually passed");
  assert.equal(invokedDirectlyV1(undefined, thisUrl), false, "no entry path means imported, not run");
  assert.equal(invokedDirectlyV1("", thisUrl), false, "an empty entry path is not an entry point");
  assert.equal(invokedDirectlyV1(join(repoRoot, "scripts", "mac-local", "upgrade.mjs"), thisUrl), false,
    "a different file in the same repo is not this module");
});

test("refuses a path that does not resolve, rather than throwing", () => {
  assert.equal(invokedDirectlyV1(join(repoRoot, "no-such-file-here.mjs"), thisUrl), false,
    "an unresolvable argv path must be treated as imported, so nothing runs by surprise");
  assert.equal(invokedDirectlyV1("relative/not/absolute.mjs", thisUrl), false,
    "a relative path resolves against the cwd and will not match");
  assert.equal(invokedDirectlyV1(thisFile, "file:///definitely/not/a/module.mjs"), false,
    "an unresolvable module URL must also be false");
});

test("a symlinked parent is the same file, and must still be recognised", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "invoked-directly-"));
  const link = join(root, "link-to-tests");
  symlinkSync(dirname(thisFile), link);
  const throughLink = join(link, thisFile.slice(dirname(thisFile).length + 1));
  assert.equal(realpathSync(throughLink), realpathSync(thisFile), "the two spellings name one file");
  assert.notEqual(throughLink, thisFile, "and they are genuinely different strings, which is the bug's whole cause");
  assert.equal(invokedDirectlyV1(throughLink, thisUrl), true,
    "the old exact-string guard returned false here and silently skipped the script");
});

test("a real script spawned through a symlinked directory runs, instead of exiting 0 in silence", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "invoked-directly-run-"));
  const real = join(root, "real");
  mkdirSync(real);
  symlinkSync(real, join(root, "link"));
  // The fixture imports the REAL helper from this repo, so this drives the
  // shipped code rather than a copy of it that could drift.
  const helper = join(real, "helper.mjs");
  writeFileSync(helper, `export { invokedDirectlyV1 } from ${JSON.stringify(
    pathToFileURL(join(repoRoot, "scripts/dev/invoked-directly.mjs")).href)};\n`);
  const script = join(real, "script.mjs");
  writeFileSync(script,
    'import { invokedDirectlyV1 } from "./helper.mjs";\n'
    + "if (invokedDirectlyV1(process.argv[1], import.meta.url)) process.stdout.write(\"RAN\\n\");\n");

  const direct = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(direct.stdout, "RAN\n", "a direct spawn has always worked");

  const viaLink = spawnSync(process.execPath, [join(root, "link", "script.mjs")], { encoding: "utf8" });
  assert.equal(viaLink.stdout, "RAN\n",
    "reached through a symlinked directory the script must still run; the failure mode was an empty stdout and exit 0");
  assert.equal(viaLink.status, direct.status);

  // The other node flag, and the reason the helper resolves BOTH sides. With
  // --preserve-symlinks-main the module URL KEEPS the symlink spelling, so
  // resolving only argv would compare a real path against a linked one and
  // return false. Resolving both sides is the only version that is right under
  // both flags, so this case is what keeps that half of the fix from being
  // quietly dropped later.
  const preserved = spawnSync(process.execPath, ["--preserve-symlinks-main", join(root, "link", "script.mjs")],
    { encoding: "utf8" });
  assert.equal(preserved.stdout, "RAN\n",
    "under --preserve-symlinks-main the symlinked spelling is kept on both sides and must still match");
});

test("the production upgrade step still refuses bad input when run through a symlinked checkout", () => {
  // The real module, reached through a symlink, must reach its own argument
  // validation rather than exiting 0 having done nothing. This is the exact
  // shape the two kill tests used, and the exact thing that went wrong.
  const step = join(repoRoot, "scripts/mac-local/database-upgrade-vps-step.mjs");
  assert.ok(existsSync(step), "the production step module is where the failing tests pointed");
  const root = mkdtempSync(join(realpathSync(tmpdir()), "invoked-directly-step-"));
  const link = join(root, "checkout");
  symlinkSync(repoRoot, link);
  const throughLink = join(link, "scripts", "mac-local", "database-upgrade-vps-step.mjs");

  const direct = spawnSync(process.execPath, [step], { encoding: "utf8" });
  const viaLink = spawnSync(process.execPath, [throughLink], { encoding: "utf8" });
  assert.equal(direct.status, 1, "no arguments is refused, from a direct path");
  assert.match(direct.stderr, /upgrade_input_refused/u);
  assert.equal(viaLink.status, direct.status,
    "through a symlink the same refusal must happen; exit 0 here is the silent-skip bug");
  assert.match(viaLink.stderr, /upgrade_input_refused/u,
    "the refusal line is the evidence that the module body actually ran");
  assert.equal(viaLink.stdout, direct.stdout);
});

test("the module under test is importable without running any guard", async () => {
  // Importing must never be execution: the same file, loaded as a dependency,
  // prints nothing. This is why every entry guard exists at all.
  const url = pathToFileURL(join(repoRoot, "scripts/dev/invoked-directly.mjs")).href;
  const module = await import(url);
  assert.equal(typeof module.invokedDirectlyV1, "function");
});
