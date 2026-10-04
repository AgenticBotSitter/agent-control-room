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

test("a MISSING argv[1] is an import context and answers false; a PRESENT but unresolvable one refuses", () => {
  // The two halves of the contract, and the reason they differ. A process with
  // no `argv[1]` was never started from a file, so there is no entry to be wrong
  // about. A process that WAS given one and cannot resolve it would silently skip
  // its own body and exit zero, which is the failure the guard exists to stop.
  for (const missing of [undefined, null]) assert.equal(isMainModuleV1(missing, import.meta.url), false);
  assert.throws(() => isMainModuleV1(42, import.meta.url),
    { code: "direct_entry_guard_refused" });
  for (const entry of ["", join(repoRoot, "missing-entry.mjs")]) {
    assert.throws(() => isMainModuleV1(entry, import.meta.url), error => {
      assert.equal(error.code, "direct_entry_guard_refused");
      assert.match(error.message, /process\.argv\[1\] (?:is empty|could not be resolved)/u);
      return true;
    });
  }
  assert.throws(() => isMainModuleV1(pathToFileURL(thisFile).href, import.meta.url),
    { code: "direct_entry_guard_refused" });
  assert.throws(() => isMainModuleV1(thisFile, "file:///definitely/missing-module.mjs"),
    /direct_entry_guard_refused: import\.meta\.url could not be resolved/u);
  assert.equal(isMainModuleV1(thisFile, import.meta.url), true, "failure does not poison a later retry");

  // MEASURED, and the reason the missing case is a `false` rather than a throw:
  // `--eval` with no extra argument leaves `argv` at one element, so importing
  // the helper from an `--eval` program is the ordinary import context.
  const child = runNode(["--input-type=module", "--eval",
    `import { isMainModuleV1 } from ${JSON.stringify(pathToFileURL(helperPath).href)};`
      + "process.stdout.write(String(isMainModuleV1(process.argv[1], import.meta.url)));"]);
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout, "false", "an --eval import with no argv[1] must not run a main");

  // A DANGLING argv[1] refuses loudly in a real process, not only in-process.
  const dangling = runNode(["--input-type=module", "--eval",
    `import { isMainModuleV1 } from ${JSON.stringify(pathToFileURL(helperPath).href)};`
      + "isMainModuleV1(process.argv[1], import.meta.url);", join(repoRoot, "missing-entry.mjs")]);
  assert.notEqual(dangling.status, 0);
  assert.match(dangling.stderr, /direct_entry_guard_refused: process\.argv\[1\] could not be resolved/u);
});

test("every bundled entry loads through --eval without running its main", t => {
  // The `--eval` import of each BUNDLED entry, which is the shape that broke
  // when the pre-guards were removed: the entries import one another, so a
  // refusal in any of them would abort the load.
  //
  // The URL is written INTO the program rather than passed as `argv[1]`, so
  // `argv[1]` is absent — MEASURED, `node --input-type=module --eval "<code>"`
  // with no extra argument leaves `argv` at one element — and the shared guard
  // answers `false`. The old shape, `--eval "await import(process.argv[1])" <file: URL>`,
  // put a `file:` URL in `argv[1]`; that is now a REFUSAL, because
  // `realpathSync` on a URL string is ENOENT and a `file:` URL can never be a
  // real entry. `the archived installer entry and native ports load without
  // node_modules` was rewritten to this shape for the same reason.
  for (const relative of ["src/updater/v1/cli.mjs", "src/updater/v1/build-attended-release.mjs",
    "src/updater/v1/pg/init-database.mjs", "src/updater/v1/pg/apply-release-schema.mjs"]) {
    const url = pathToFileURL(join(repoRoot, relative)).href;
    const child = runNode(["--input-type=module", "--eval", `await import(${JSON.stringify(url)});`]);
    assert.equal(child.status, 0, `${relative}: ${child.stderr}`);
    assert.doesNotMatch(`${child.stdout}${child.stderr}`, /direct_entry_guard_refused/u,
      `${relative} refused on an --eval import`);
    assert.doesNotMatch(child.stdout, /Usage: control-room|database_init_request_refused|release_schema_request_refused/u,
      `${relative} ran its main on import`);
  }
});

test("a file: URL in argv[1] refuses, because node cannot start an entry as one", () => {
  // The shape the pre-guards used to absorb. It is a refusal now, and the test
  // names WHY rather than asserting the code: `node <a file: URL>` fails with
  // `Cannot find module '<cwd>/file:/…'`, so no real entry is ever spelled this way.
  const url = pathToFileURL(thisFile).href;
  assert.throws(() => isMainModuleV1(url, import.meta.url), {
    code: "direct_entry_guard_refused", message: /is a file: URL/u,
  });
  const child = runNode(["--input-type=module", "--eval",
    `import { isMainModuleV1 } from ${JSON.stringify(pathToFileURL(helperPath).href)};`
      + "isMainModuleV1(process.argv[1], import.meta.url);", url]);
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /direct_entry_guard_refused: process\.argv\[1\] is a file: URL/u);
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

test("there is exactly ONE entry guard: the contract re-exports the shared function", async () => {
  // The lead's decision is ONE helper, and a re-export that quietly became a
  // second implementation would be the whole failure it is meant to prevent.
  // MEASURED: replacing the contract's `export { isMainModuleV1 } from …` with a
  // local `export function isMainModuleV1(moduleUrl) { return true; }` passed
  // every other test in this file — nothing else asked the contract for its
  // answer — so this is the only assertion standing between the tree and two
  // guards that can disagree.
  const contract = await import("../src/updater/v1/pg/database-phase-contract.mjs");
  const shared = await import(pathToFileURL(helperPath).href);
  assert.equal(contract.isMainModuleV1, shared.isMainModuleV1,
    "database-phase-contract must RE-EXPORT the shared guard, not define its own");

  // And no file outside the helper may define a function of that name.
  const definitions = [];
  for (const root of ["src", "scripts", "deploy"]) for (const path of sourceFiles(join(repoRoot, root))) {
    if (path === helperPath) continue;
    if (/(?:export\s+)?(?:async\s+)?function\s+isMainModuleV1\b/u.test(readFileSync(path, "utf8")))
      definitions.push(relative(repoRoot, path));
  }
  assert.deepEqual(definitions, [],
    `isMainModuleV1 must be defined in exactly one place: ${definitions.join(", ")}`);
});

test("a real phase entry still refuses a dangling argv[1] rather than exiting zero", () => {
  // The guard's reason for existing, on a REAL entry rather than on the helper in
  // isolation: an entry that was genuinely started under a path which cannot be
  // resolved would skip its own body, exit 0 and print nothing, and the port
  // above it would then refuse with `database_phase_result_refused` naming
  // neither the script nor the reason. That is the shape
  // `database-phase_result_refused` exists to catch, so the refusal has to fire
  // first. The production default path here is the entry itself: no injected
  // port, no fake module.
  const entry = join(repoRoot, "src/updater/v1/pg/init-database.mjs");
  const dangling = runNode(["--input-type=module", "--eval", `await import(${JSON.stringify(
    pathToFileURL(entry).href)});`, join(repoRoot, "definitely-missing-entry.mjs")]);
  assert.notEqual(dangling.status, 0, "a dangling argv[1] must not exit zero");
  assert.match(dangling.stderr, /direct_entry_guard_refused: process\.argv\[1\] could not be resolved/u);
});

test("the two seed-run builders carry the shared guard inline, answer as it does, and nothing else does", async t => {
  // rv-9b B3: these two run UNBUNDLED from `updater/seed-<c12>/bin/` and from each
  // job's `builder-tools/bin/` copy, where the shared module's relative import does not
  // resolve, so they hold its contract inline. ONE guard still holds as a contract:
  // each inline copy must answer exactly as the shared helper for every case it
  // decides, and no third file may grow one.
  const seedRun = ["src/updater/v1/build-attended-release.mjs", "scripts/updater/build-fixed-updater-bundle.mjs"];
  const holders = [];
  for (const root of ["src", "scripts", "deploy"]) for (const path of sourceFiles(join(repoRoot, root))) {
    if (/function\s+seedEntryIsMainV1\b/u.test(readFileSync(path, "utf8"))) holders.push(relative(repoRoot, path));
  }
  assert.deepEqual(holders.sort(), [...seedRun].sort());
  const root = temporaryRoot(t, "entry-guard-seed-");
  const linked = join(root, "linked-entry.mjs");
  symlinkSync(thisFile, linked);
  const cases = [undefined, null, 7, "", pathToFileURL(thisFile).href, join(root, "missing.mjs"), thisFile, linked,
    helperPath];
  const answer = (guard, entry) => { try { return guard(entry, import.meta.url); } catch (error) {
    return `${error.code}|${error.message}`; } };
  for (const relativePath of seedRun) {
    const { seedEntryIsMainV1 } = await import(pathToFileURL(join(repoRoot, relativePath)).href);
    for (const entry of cases) {
      assert.equal(answer(seedEntryIsMainV1, entry), answer(isMainModuleV1, entry), `${relativePath}: ${String(entry)}`);
    }
    assert.equal(seedEntryIsMainV1(linked, import.meta.url), true, `${relativePath} must see through a symlinked entry`);
  }
});
