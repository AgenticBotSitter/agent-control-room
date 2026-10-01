import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFixedUpdaterBundleV1 } from "../scripts/updater/build-fixed-updater-bundle.mjs";

async function fixtureV1(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-bundle-")), source = join(root, "source"), output = join(root, "bundle");
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  await mkdir(join(source, "src/updater"), { recursive: true });
  await cp(join(process.cwd(), "src/updater/v1"), join(source, "src/updater/v1"), { recursive: true });
  await mkdir(join(source, "src/installer/shared"), { recursive: true });
  await cp(join(process.cwd(), "src/installer/shared/is-main-module.mjs"),
    join(source, "src/installer/shared/is-main-module.mjs"));
  await mkdir(join(source, "updater-bundle")); await writeFile(join(source, "updater-bundle/evil.mjs"), "throw 'candidate';\n");
  const store = join(root, "store"), pnpm = join(root, "pnpm"), pnpmLog = join(root, "pnpm.args");
  await mkdir(store); await writeFile(pnpm, `#!/bin/sh\nprintf '%s\\n' \"$@\" > '${pnpmLog}'\n`); await chmod(pnpm, 0o500);
  const esbuild = join(process.cwd(), "node_modules/.pnpm/@esbuild+darwin-arm64@0.28.2/node_modules/@esbuild/darwin-arm64/bin/esbuild");
  return { root, source, output, store, pnpm, pnpmLog, esbuild, testNodeModules: join(process.cwd(), "node_modules"),
    policy: join(process.cwd(), "src/updater/v1/policy/bundle.json") };
}

test("the fixed step builds updater and CLI from source with pinned arguments and never adopts candidate output", async t => {
  const fixture = await fixtureV1(t);
  const old = process.env.CONTROL_ROOM_BUNDLE_TESTING; process.env.CONTROL_ROOM_BUNDLE_TESTING = "1";
  t.after(() => { if (old === undefined) delete process.env.CONTROL_ROOM_BUNDLE_TESTING;
    else process.env.CONTROL_ROOM_BUNDLE_TESTING = old; });
  const result = await buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root });
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/u);
  const paths = result.manifest.files.map(item => item.path);
  for (const required of ["updater.mjs", "bin/control-room.mjs", "bin/control-room", "guard.sh",
    "ddl/0002_schema.sql", "policy/bundle.json"]) assert.ok(paths.includes(required), required);
  assert.ok(!paths.some(path => path.includes("evil")), "candidate pnpm build output is outside the fixed input set");
  assert.equal((await lstat(join(fixture.output, "updater.mjs"))).mode & 0o777, 0o500);
  assert.doesNotMatch(await readFile(join(fixture.output, "updater.mjs"), "utf8"), /from ["']pg["']/u,
    "the updater's pinned dependency is bundled, not loaded from release node_modules");
  assert.deepEqual((await readFile(fixture.pnpmLog, "utf8")).trim().split("\n").slice(0, 4),
    ["install", "--offline", "--ignore-scripts", "--frozen-lockfile"]);

  const current = join(fixture.root, "current");
  await symlink(fixture.output, current);
  const cli = await import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath,
    [join(current, "bin/control-room.mjs")], { encoding: "utf8" }));
  assert.equal(cli.status, 64, cli.stderr);
  assert.match(cli.stderr, /Usage: control-room/u,
    "the bundled updater CLI runs through a release-style current symlink");

  const updater = await import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath,
    [join(current, "updater.mjs")], { encoding: "utf8", env: { ...process.env,
      CONTROL_ROOM_UPDATER_TESTING: "1", CONTROL_ROOM_UPDATER_ROOT: fixture.root } }));
  assert.equal(updater.status, 1, updater.stderr);
  assert.match(updater.stderr, /updater_test_root_refused/u,
    "the bundled updater service entry runs through a release-style current symlink");
});

test("the fixed step refuses policy drift, a tool override outside rehearsal, and a retry over an existing output", async t => {
  const fixture = await fixtureV1(t), policy = JSON.parse(await readFile(fixture.policy, "utf8"));
  policy.candidateBuildOutputAccepted = true;
  const badPolicy = join(fixture.root, "bad-policy.json"); await writeFile(badPolicy, JSON.stringify(policy));
  const old = process.env.CONTROL_ROOM_BUNDLE_TESTING; process.env.CONTROL_ROOM_BUNDLE_TESTING = "1";
  await assert.rejects(buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root, policy: badPolicy }),
    /updater_bundle_policy_refused/u);
  await buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root });
  await assert.rejects(buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root }), /ENOTEMPTY|EEXIST/u,
    "a concurrent or retried publication never replaces an existing bundle");
  if (old === undefined) delete process.env.CONTROL_ROOM_BUNDLE_TESTING; else process.env.CONTROL_ROOM_BUNDLE_TESTING = old;
  await assert.rejects(buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root }),
    /updater_bundle_owner_home_refused|updater_bundle_source_refused|updater_bundle_tool_override_refused/u);
});

test("the fixed step refuses candidate-supplied installed dependencies", async t => {
  const fixture = await fixtureV1(t), old = process.env.CONTROL_ROOM_BUNDLE_TESTING;
  process.env.CONTROL_ROOM_BUNDLE_TESTING = "1";
  t.after(() => { if (old === undefined) delete process.env.CONTROL_ROOM_BUNDLE_TESTING;
    else process.env.CONTROL_ROOM_BUNDLE_TESTING = old; });
  await mkdir(join(fixture.source, "src/updater/v1/node_modules"));
  await assert.rejects(buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root }),
    /updater_bundle_source_modules_refused/u);
});
