import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { isMainModuleV1 } from "../src/installer/shared/is-main-module.mjs";

const repoRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
const thisFile = fileURLToPath(import.meta.url);
const helperPath = join(repoRoot, "src/installer/shared/is-main-module.mjs");
const sourceExtensions = new Set([".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"]);

function sourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (sourceExtensions.has(extname(entry.name))) files.push(path);
  }
  return files;
}

function releaseLink(root) {
  const releases = join(root, "releases");
  mkdirSync(releases, { recursive: true });
  symlinkSync(repoRoot, join(releases, "x"));
  symlinkSync("releases/x", join(root, "current"));
  return join(root, "current");
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8",
    env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", ...options.env } });
}

function temporaryRoot(t, prefix) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function assertRepresentativeScripts(current, environment) {
  const cases = [
    { name: "database upgrade step", args: [join(current, "scripts/mac-local/database-upgrade-vps-step.mjs")],
      status: 1, output: /upgrade_input_refused/u },
    { name: "updater CLI", args: [join(current, "src/updater/v1/cli.mjs")],
      status: 64, output: /Usage: control-room/u },
    { name: "Mac-local completion CLI", args: ["--import", "tsx",
      join(current, "scripts/mac-local/complete-first-owner.mjs")], status: 2,
      output: /Usage: pnpm mac:complete-first-owner/u },
  ];
  for (const scenario of cases) {
    const result = runNode(scenario.args, { env: environment });
    assert.equal(result.status, scenario.status, `${scenario.name}: ${result.stderr}`);
    assert.match(`${result.stdout}${result.stderr}`, scenario.output,
      `${scenario.name} reached main instead of silently exiting 0`);
  }
}

test("recognises the real entry point and an equivalent symlink, but not another module", t => {
  assert.equal(isMainModuleV1(process.argv[1], import.meta.url), true);
  assert.equal(isMainModuleV1(join(repoRoot, "scripts/mac-local/upgrade.mjs"), import.meta.url), false);

  const root = temporaryRoot(t, "entry-guard-path-");
  const link = join(root, "linked-tests");
  symlinkSync(dirname(thisFile), link);
  const throughLink = join(link, thisFile.slice(dirname(thisFile).length + 1));
  assert.notEqual(throughLink, thisFile);
  assert.equal(isMainModuleV1(throughLink, import.meta.url), true);
});

test("missing and unresolvable paths refuse loudly, and a valid retry still works", () => {
  for (const entry of [undefined, "", join(repoRoot, "missing-entry.mjs")]) {
    assert.throws(() => isMainModuleV1(entry, import.meta.url), error => {
      assert.equal(error.code, "direct_entry_guard_refused");
      assert.match(error.message, /process\.argv\[1\] (?:is missing|could not be resolved)/u);
      return true;
    });
  }
  assert.throws(() => isMainModuleV1(thisFile, "file:///definitely/missing-module.mjs"),
    /direct_entry_guard_refused: import\.meta\.url could not be resolved/u);
  assert.equal(isMainModuleV1(thisFile, import.meta.url), true, "failure does not poison a later retry");

  const child = runNode(["--input-type=module", "--eval",
    `import { isMainModuleV1 } from ${JSON.stringify(pathToFileURL(helperPath).href)};`
      + "isMainModuleV1(undefined, import.meta.url);"]);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /direct_entry_guard_refused: process\.argv\[1\] is missing/u);
});

test("three production entries run through current and through a symlinked TMPDIR", t => {
  const root = temporaryRoot(t, "entry-guard-release-");
  assertRepresentativeScripts(releaseLink(root), { TMPDIR: root });

  const tempReal = join(root, "tmp-real");
  mkdirSync(tempReal);
  const tempLink = join(root, "tmp-link");
  symlinkSync(tempReal, tempLink);
  const staged = join(tempLink, "staged-release");
  mkdirSync(staged);
  assertRepresentativeScripts(releaseLink(staged), { TMPDIR: tempLink });
});

test("every guarded production module remains importable without running its main", t => {
  const files = ["src", "scripts", "deploy"].flatMap(root => sourceFiles(join(repoRoot, root)))
    .filter(path => path !== helperPath
      && readFileSync(path, "utf8").includes("isMainModuleV1(process.argv[1], import.meta.url)"));
  assert.ok(files.length >= 90, `expected the repository-wide sweep, found only ${files.length} guarded modules`);

  const root = temporaryRoot(t, "entry-guard-import-");
  const runner = join(root, "import-runner.mjs");
  writeFileSync(runner, `${files.map(path => `await import(${JSON.stringify(pathToFileURL(path).href)});`).join("\n")}\n`
    + `process.stdout.write(${JSON.stringify(`IMPORTED ${files.length}\n`)});\n`);
  const result = runNode(["--import", "tsx", runner]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `IMPORTED ${files.length}\n`, "importing modules must not run their CLI bodies");
});

test("source guard policy rejects direct comparisons outside the helper", () => {
  const violations = [];
  const forbidden = [
    /process\.argv\s*\[\s*1\s*\]\s*(?:===|!==)/u,
    /(?:===|!==)\s*process\.argv\s*\[\s*1\s*\]/u,
    /pathToFileURL\(\s*(?:resolve\()?\s*process\.argv\s*\[\s*1\s*\]/u,
    /fileURLToPath\(\s*import\.meta\.url\s*\)\s*(?:===|!==)/u,
    /process\.argv\s*\[\s*1\s*\]\.endsWith\(/u,
    /require\.main\s*===\s*module|module\s*===\s*require\.main/u,
    /const\s+\w*(?:invoked|direct|main)\w*\s*=\s*[^;]{0,400}process\.argv\s*\[\s*1\s*\]/iu,
  ];
  for (const root of ["src", "scripts", "deploy"]) for (const path of sourceFiles(join(repoRoot, root))) {
    if (path === helperPath) continue;
    const source = readFileSync(path, "utf8")
      .replaceAll("isMainModuleV1(process.argv[1], import.meta.url)", "approvedMainGuardV1");
    if (forbidden.some(pattern => pattern.test(source))) violations.push(relative(repoRoot, path));
  }
  assert.deepEqual(violations, [],
    `direct entry guards must use src/installer/shared/is-main-module.mjs: ${violations.join(", ")}`);
});

test("thirty concurrent symlinked entry processes all run exactly once", async t => {
  const root = temporaryRoot(t, "entry-guard-load-");
  const real = join(root, "real");
  mkdirSync(real);
  const link = join(root, "link");
  symlinkSync(real, link);
  const fixture = join(real, "entry.mjs");
  writeFileSync(fixture, `import { isMainModuleV1 } from ${JSON.stringify(pathToFileURL(helperPath).href)};\n`
    + "if (isMainModuleV1(process.argv[1], import.meta.url)) process.stdout.write('RAN\\n');\n");

  const results = await Promise.all(Array.from({ length: 30 }, () => new Promise((resolveChild, reject) => {
    const child = spawn(process.execPath, [join(link, "entry.mjs")], { cwd: repoRoot,
      env: { ...process.env, CONTROL_ROOM_TEST_BLOCK_AGENT_CLI: "1", TMPDIR: link } });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (status, signal) => resolveChild({ status, signal, stdout, stderr }));
  })));
  for (const result of results) assert.deepEqual(result,
    { status: 0, signal: null, stdout: "RAN\n", stderr: "" });

  const preserved = runNode(["--preserve-symlinks-main", join(link, "entry.mjs")], { env: { TMPDIR: link } });
  assert.equal(preserved.status, 0, preserved.stderr);
  assert.equal(preserved.stdout, "RAN\n",
    "realpathing the module URL is required when Node preserves the symlinked main spelling");
});

test("the helper itself is a side-effect-free module", async () => {
  const module = await import(pathToFileURL(helperPath).href);
  assert.equal(typeof module.isMainModuleV1, "function");
});
