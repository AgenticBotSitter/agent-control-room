import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { verifyBundleManifestV1 } from "../src/updater/v1/attended-flip.mjs";
import { loadInstallStepsV1 } from "../src/updater/v1/install/bootstrap.mjs";
import { buildFixedUpdaterBundleV1 } from "../scripts/updater/build-fixed-updater-bundle.mjs";

async function fixtureV1(t) {
  const root = await mkdtemp(join(tmpdir(), "updater-bundle-")), source = join(root, "source"), output = join(root, "bundle");
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(root, { recursive: true, force: true })); });
  await mkdir(join(source, "src/updater"), { recursive: true });
  await cp(join(process.cwd(), "src/updater/v1"), join(source, "src/updater/v1"), { recursive: true });
  await mkdir(join(source, "scripts/updater"), { recursive: true });
  await cp(join(process.cwd(), "scripts/updater/build-fixed-updater-bundle.mjs"),
    join(source, "scripts/updater/build-fixed-updater-bundle.mjs"));
  await cp(join(process.cwd(), "scripts/release-signing.mjs"), join(source, "scripts/release-signing.mjs"));
  // The CLUSTER LAYOUT, because the builder crosses in for it.
  //
  // MEASURED: without this the fixture failed with
  // `ENOENT … copyfile '…/source/src/pg-runtime/v1/pg-cluster-layout.ts'`. The
  // builder copies that one file out of the repository so `pg/init-database.mjs`'s
  // relative import resolves inside the bundle workspace, and a fixture that
  // stages only `src/updater/v1` does not contain the file the builder is
  // documented to require. Staging it here is also what keeps the fixture honest:
  // it stages the same set of inputs a real build has.
  await mkdir(join(source, "src/pg-runtime/v1"), { recursive: true });
  await cp(join(process.cwd(), "src/pg-runtime/v1/pg-cluster-layout.ts"),
    join(source, "src/pg-runtime/v1/pg-cluster-layout.ts"));
  await mkdir(join(source, "src/installer/shared"), { recursive: true });
  for (const name of ["is-main-module", "strict-json", "rehearsal-hostname", "file-custody", "private-process-lock", "jsonl-prefix"])
    await cp(join(process.cwd(), `src/installer/shared/${name}.mjs`),
      join(source, `src/installer/shared/${name}.mjs`));
  // The nightly backup's recency READER, because the builder crosses it in for
  // the same reason it crosses in the layout. Without this the fixture fails
  // with `ENOENT … copyfile '…/source/src/installer/v1/nightly-backup-recency.ts'`
  // — the same shape as the layout's fixture note above.
  //
  // Its NEIGHBOUR `nightly-backup.ts` is deliberately NOT staged. `backup_now`
  // spawns the built `dist-vps/server/nightlyBackup.js` instead of importing it,
  // because that module's import chain reaches
  // `deploy/postgres/migration-ledger.json` and the trusted bundle must not
  // carry release data. `the bundle carries no release data` below is what
  // holds that line.
  await mkdir(join(source, "src/installer/v1"), { recursive: true });
  await cp(join(process.cwd(), "src/installer/v1/nightly-backup-recency.ts"),
    join(source, "src/installer/v1/nightly-backup-recency.ts"));
  await mkdir(join(source, "updater-bundle")); await writeFile(join(source, "updater-bundle/evil.mjs"), "throw 'candidate';\n");
  const store = join(root, "store"), pnpm = join(root, "pnpm"), pnpmLog = join(root, "pnpm.args");
  await mkdir(store); await writeFile(pnpm, `#!/bin/sh\nprintf '%s\\n' \"$@\" > '${pnpmLog}'\n`); await chmod(pnpm, 0o500);
  // Platform-specific: pnpm installs a separate @esbuild/<platform>-<arch>
  // optional dependency per host, so a hardcoded darwin-arm64 path does not
  // exist on the Linux CI runner this suite also runs on.
  const esbuildPlatformPackage = `@esbuild+${process.platform}-${process.arch}@${JSON.parse(
    await readFile(join(process.cwd(), "node_modules/esbuild/package.json"), "utf8")).version}`;
  const esbuild = join(process.cwd(), "node_modules/.pnpm", esbuildPlatformPackage,
    `node_modules/@esbuild/${process.platform}-${process.arch}/bin/esbuild`);
  return { root, source, output, store, pnpm, pnpmLog, esbuild, testNodeModules: join(process.cwd(), "node_modules"),
    policy: join(process.cwd(), "src/updater/v1/policy/bundle.json") };
}

test("the fixed step builds updater and CLI from source with pinned arguments and never adopts candidate output", async t => {
  const fixture = await fixtureV1(t);
  const old = process.env.CONTROL_ROOM_BUNDLE_TESTING; process.env.CONTROL_ROOM_BUNDLE_TESTING = "1";
  t.after(() => { if (old === undefined) delete process.env.CONTROL_ROOM_BUNDLE_TESTING;
    else process.env.CONTROL_ROOM_BUNDLE_TESTING = old; });
  const result = await buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root });
  assert.equal(await verifyBundleManifestV1(fixture.output, result.manifest), result.digest);
  const verifiedSteps = await loadInstallStepsV1({ updaterTarget: fixture.output, expectedDigest: result.digest },
    { expectedUid: process.geteuid() });
  assert.equal(typeof verifiedSteps.continueInstallV1, "function");
  const broadened = structuredClone(result.manifest);
  broadened.files.find(item => item.path === "guard.sh").mode = 0o555;
  await chmod(join(fixture.output, "guard.sh"), 0o555);
  try {
    await assert.rejects(verifyBundleManifestV1(fixture.output, broadened), /updater_bundle_manifest_refused/u);
    await chmod(join(fixture.output, "manifest.json"), 0o600);
    await writeFile(join(fixture.output, "manifest.json"), JSON.stringify(broadened));
    const digest = "sha256:" + createHash("sha256").update(JSON.stringify(broadened)).digest("hex");
    await assert.rejects(loadInstallStepsV1({ updaterTarget: fixture.output, expectedDigest: digest },
      { expectedUid: process.geteuid() }), /updater_bundle_manifest_refused/u);
  } finally {
    await chmod(join(fixture.output, "guard.sh"), 0o500);
    await chmod(join(fixture.output, "manifest.json"), 0o600);
    await writeFile(join(fixture.output, "manifest.json"), JSON.stringify(result.manifest));
    await chmod(join(fixture.output, "manifest.json"), 0o400);
  }
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/u);
  const paths = result.manifest.files.map(item => item.path);
  for (const required of ["updater.mjs", "service-output.mjs", "bin/control-room.mjs", "bin/control-room", "bin/git-credential-control-room",
    "bin/build-attended-release.mjs", "bin/build-fixed-bundle.mjs", "guard.sh",
    "lib/install-steps.mjs", "ddl/0002_schema.sql", "policy/bundle.json",
    "third_party/qrcode-generator/LICENSE"]) assert.ok(paths.includes(required), required);
  assert.ok(!paths.some(path => path.includes("evil")), "candidate pnpm build output is outside the fixed input set");
  assert.equal((await lstat(join(fixture.output, "updater.mjs"))).mode & 0o777, 0o500);
  assert.equal((await lstat(join(fixture.output, "service-output.mjs"))).mode & 0o777, 0o555);
  assert.equal((await lstat(fixture.output)).mode & 0o777, 0o711);
  const collector = await import(pathToFileURL(join(fixture.output, "service-output.mjs")).href);
  assert.equal(typeof collector.collectServiceOutputV1, "function");
  assert.doesNotMatch(await readFile(join(fixture.output, "updater.mjs"), "utf8"), /from ["']pg["']/u,
    "the updater's pinned dependency is bundled, not loaded from release node_modules");
  const stageOneBytes = await readFile(join(fixture.output, "lib/install-steps.mjs"), "utf8");
  assert.doesNotMatch(stageOneBytes, /src\/pg-runtime|import\([^\n]*pg-runtime-vendor\.ts/u);
  const stageOne = await import(`${pathToFileURL(join(fixture.output, "lib/install-steps.mjs")).href}?plain-node=1`);
  assert.equal(typeof stageOne.createStageOnePortsV1, "function");
  assert.deepEqual((await readFile(fixture.pnpmLog, "utf8")).trim().split("\n").slice(0, 4),
    ["install", "--offline", "--ignore-scripts", "--frozen-lockfile"]);

  const current = join(fixture.root, "current");
  await symlink(fixture.output, current);
  const cli = await import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath,
    [join(current, "bin/control-room.mjs")], { encoding: "utf8" }));
  assert.equal(cli.status, 64, cli.stderr);
  assert.match(cli.stderr, /Usage: control-room/u,
    "the bundled updater CLI runs through a release-style current symlink");

  // A root outside /tmp and /private/tmp, so this reliably exercises the
  // refusal regardless of where the host's own tmpdir() happens to put
  // fixture.root (on a CI runner with no TMPDIR override, os.tmpdir() is
  // plain "/tmp", which updaterRootV1 accepts -- so reusing fixture.root here
  // only produced the intended refusal by accident of this machine's default
  // tmpdir, and failed with updater_configuration_refused instead on a host
  // where fixture.root itself landed under /tmp). The check is a pure string
  // prefix match with no filesystem access, so this path need not exist.
  const outsideTestRoot = join(process.cwd(), "not-a-control-room-updater-test-root");
  const updater = await import("node:child_process").then(({ spawnSync }) => spawnSync(process.execPath,
    [join(current, "updater.mjs")], { encoding: "utf8", env: { ...process.env,
      CONTROL_ROOM_UPDATER_TESTING: "1", CONTROL_ROOM_UPDATER_ROOT: outsideTestRoot } }));
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

test("the bundle carries no release data, and backup_now spawns the shipped nightly artifact", async t => {
  // THE TRUST RULE, ASSERTED RATHER THAN DESCRIBED. `backup_now` used to
  // `await import("../../installer/v1/nightly-backup")`, whose import chain reaches
  // `deploy/postgres/migration-ledger.json` through
  // `nightly-backup-configuration.ts`. Two failures follow from that, and the
  // second is the worse one:
  //
  //   1. esbuild cannot resolve the file inside the isolated workspace, so
  //      `buildFixedUpdaterBundleV1` REFUSES and there is no self-update bundle at
  //      all — the owner's installed updater can never receive R5B-01's alert or
  //      R5B-02's button, even though every other test here is green.
  //   2. If it had resolved, the trusted component would now carry the migration
  //      ledger, which `src/updater/v1/pg/apply-release-schema.mjs` documents as
  //      forbidden for exactly this dependency.
  //
  // So this asserts the second directly on the built bytes: the ledger's real
  // content and the pg-boss package are absent from every entry, and `backup_now`
  // is wired to the SPAWN, not the import.
  const fixture = await fixtureV1(t);
  const old = process.env.CONTROL_ROOM_BUNDLE_TESTING; process.env.CONTROL_ROOM_BUNDLE_TESTING = "1";
  t.after(() => { if (old === undefined) delete process.env.CONTROL_ROOM_BUNDLE_TESTING;
    else process.env.CONTROL_ROOM_BUNDLE_TESTING = old; });
  const result = await buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root });
  const paths = result.manifest.files.map(item => item.path);

  // Read the ledger as DATA, exactly as `tests/updater-ledger-pin.test.mjs` does,
  // so the assertion cannot be satisfied by a matching filename.
  const ledger = JSON.parse(await readFile(join(process.cwd(), "deploy/postgres/migration-ledger.json"), "utf8"));
  assert.ok(typeof ledger.digest === "string" && ledger.digest.length > 32,
    "the fixture read a real ledger, so a digest-shaped string is not a vacuous pattern");
  // A distinctive value from INSIDE the ledger's rows, long enough that no
  // transpiled string in the bundle could contain it by accident. This is the
  // content marker, not the digest: see the pin note below.
  const ledgerRow = (ledger.entries ?? ledger.migrations ?? [])[0];
  assert.ok(typeof ledgerRow?.file === "string" && ledgerRow.file.length > 10,
    "the fixture read real ledger rows, so the content marker names a real file");
  const ledgerContentMarker = `${ledgerRow.file}:${ledgerRow.sha256 ?? ledgerRow.digest}`;

  // THE CHECKS, NAMED, and named because of what MEASURED: written inline, the
  // pg-boss and ledger-row assertions could be DELETED and the test still passed
  // (the negative control below had its own copy of the same expressions, so
  // deleting one copy left the other). One definition, used by both the loop over
  // the real bundle and the negative control over a planted file, is what makes
  // deleting the loop's call fatal — and it is the only way one expression can be
  // shown capable of failing at all.
  const escapes = value => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const ledgerRowBytesV1 = text => new RegExp(escapes(ledgerContentMarker), "u").test(text);
  const referencesPgBossV1 = text => /pg-boss/u.test(text);

  const assertNoReleaseDataV1 = async (label) => {
  for (const entry of paths.filter(path => path.endsWith(".mjs") || path.endsWith(".js"))) {
    const bytes = await readFile(join(fixture.output, entry), "utf8");
    // THE LEDGER'S CONTENT, which is what "no release data" means.
    //
    // Not the ledger's PATH: `bin/apply-release-schema.mjs` legitimately NAMES
    // `deploy/postgres/migration-ledger.json`, because the release phase reads the
    // ledger FROM THE RELEASE it has just staged (`apply-release-schema.mjs:117`,
    // `join(releaseRoot, …)`) rather than carrying its own copy. That is the design
    // working — the trusted bundle holds no ledger and reads the release's.
    //
    // Not the ledger's DIGEST either, and this one is worth stating because it looks
    // like a counterexample until you read it: `protected-config.mjs` pins
    // `RELEASE_MIGRATION_LEDGER_DIGEST_V1` as a LITERAL, and its own comment says why
    // — "the fixed updater cannot import release code, so this pin is a LITERAL
    // rather than an import". A pin is a verification constant (28 bytes of hex),
    // not release data; refusing it would mean deleting the guard that makes
    // `parseNightlyBackupConfigurationV1` refuse a tampered ledger. So the rule is
    // content and dependency, not the presence of a hash.
    assert.equal(ledgerRowBytesV1(bytes), false, `${entry} must not carry a migration-ledger row`);
    // `pg-boss` is the release queue package the rule names, and a substring test
    // on the module specifier is what catches an import of it under any alias.
    assert.equal(referencesPgBossV1(bytes), false, `${entry} must not reference pg-boss`);
  }
  return label;
  };
  await assertNoReleaseDataV1("the built bundle");
  // And no ledger FILE is shipped: the trust rule is about installed artifacts,
  // not only about compiled bytes.
  assert.deepEqual(paths.filter(path => path.includes("migration-ledger")), [],
    "the bundle ships no migration ledger");
  // And the bundle holds no `installer/v1` module beyond the one the crossed-in
  // list names, so the reader is the only thing that crossed.
  assert.deepEqual(paths.filter(path => path.includes("nightly-backup")), [],
    "the crossed-in reader is transpiled into updater.mjs, not shipped as a loose module");

  // THE PORT, on the production composition's own wiring: the default is the spawn,
  // with the trusted-path check injected only because this lane has no root — the
  // same injection `tests/install-database-phase-real-postgres.test.mjs` uses.
  const { BACKUP_NOW_TIMEOUT_MS_V1, defaultBackupNowV1, nightlyBackupSpawnPathsV1,
    parseNightlyBackupOutcomeV1 } = await import("../src/updater/v1/updater.mjs");
  const installRoot = join(fixture.root, "install-root");
  const seen = [];
  const port = defaultBackupNowV1(installRoot, {
    assertPath: async (path, options) => { seen.push({ path, options }); return path; },
    timeoutMs: 60_000,
  });
  assert.deepEqual(seen, [], "nothing is checked or spawned before the port is called");
  const pathsUnderTest = nightlyBackupSpawnPathsV1(installRoot);
  // The SAME three paths the nightly launchd service runs
  // (`src/updater/v1/services/bundle.mjs`: `<runtime>/node-current/bin/node
  // <root>/current/dist-vps/server/nightlyBackup.js --configuration
  // <root>/Protected/config/backup.json`). "Back up now" and tonight's backup are
  // one operation only if these cannot drift.
  assert.deepEqual(pathsUnderTest, {
    executable: join(installRoot, "runtime", "node-current", "bin", "node"),
    script: join(installRoot, "current", "dist-vps", "server", "nightlyBackup.js"),
    configuration: join(installRoot, "Protected", "config", "backup.json"),
  }, "backup_now runs the artifact and the configuration the launchd service runs");
  assert.equal(typeof port, "function", "and it is a port the owner-request handler can call");

  // ---- THE NEGATIVE CONTROL, and it is the half that makes the rest honest ----
  // MEASURED, twice, and both are why this block exists. Written inline, the
  // pg-boss and ledger-row assertions could be DELETED and the test still passed:
  // the assertions were properties of a build that does not contain the offending
  // thing, so nothing could ever fail them. Stubbing `backup_now`'s spawn out
  // (`parseNightlyBackupOutcomeV1({ code: 0 })`) also left it green, for the same
  // reason. An assertion nothing can fail is not an assertion — this is the
  // project's mutation discipline applied INSIDE a test.
  //
  // So each forbidden shape is PLANTED in a built entry, and the SAME named
  // expressions the loop above uses are required to catch it.
  const planted = [];
  // The bundle's entries are published 0o400 BY DESIGN (the installer must not be
  // able to edit what it installs), so planting one means taking the write bit
  // back and restoring the published mode in a `finally` — leaving a bundle entry
  // writable after a test would be the exact state this suite exists to prevent.
  const plant = async (file, text) => {
    const target = join(fixture.output, file);
    const original = await readFile(target, "utf8");
    const published = (await lstat(target)).mode & 0o777;
    await chmod(target, 0o600);
    await writeFile(target, `${original}\n// planted: ${text}\n`, { mode: 0o600 });
    planted.push(async () => {
      await chmod(target, 0o600);
      await writeFile(target, original, { mode: 0o600 });
      await chmod(target, published);
    });
  };
  try {
    // MEASURED, and this is why the control calls the SAME FUNCTION rather than
    // re-expressing its two predicates: with the control holding its own copies,
    // deleting the loop's two assertions left the test green — the control still
    // exercised an equivalent expression. Re-running the loop's own function over
    // a planted bundle is what makes deleting an assertion inside it fatal.
    // (1) RELEASE DATA: a ledger ROW in the shipped bytes.
    await plant("updater.mjs", `const ledgerRow = ${JSON.stringify(ledgerContentMarker)};`);
    await assert.rejects(assertNoReleaseDataV1("a bundle carrying a ledger row"),
      /must not carry a migration-ledger row/u,
      "the loop must CATCH a planted ledger row — measured, a separate control did not");
    // (2) pg-boss.
    await plant("bin/control-room.mjs", 'import pgBoss from "pg-boss";');
    await assert.rejects(assertNoReleaseDataV1("a bundle referencing pg-boss"),
      /must not reference pg-boss/u,
      "the loop must CATCH a planted pg-boss reference — measured, a separate control did not");
    // (3) THE SPAWN, observed. MEASURED: with the spawn inline, three mutations
    // left this file green — replacing the spawn with a hardcoded success,
    // deleting the timeout, and dropping the trusted-path checks — because each
    // was a property of a spawn that was never made. So the spawn is observed
    // here, through the port's own parameter, and the four things that matter are
    // asserted on it: WHAT runs, WITH what argv, UNDER what bound, and only
    // AFTER what trust checks.
    const spawned = [];
    const spawnBackup = async (executable, args, timeoutMs) => {
      spawned.push({ executable, args, timeoutMs });
      return { code: 0, signal: null, stdout: "nightly database backup completed\n", stderr: "" };
    };
    const installRootV1 = join(fixture.root, "spawn-root");
    const okPort = defaultBackupNowV1(installRootV1, { assertPath: async path => path, spawnBackup });
    await okPort();
    assert.equal(spawned.length, 1, "exactly one child, for one control press");
    assert.deepEqual(spawned[0], {
      executable: join(installRootV1, "runtime", "node-current", "bin", "node"),
      args: [join(installRootV1, "current", "dist-vps", "server", "nightlyBackup.js"),
        "--configuration", join(installRootV1, "Protected", "config", "backup.json")],
      timeoutMs: BACKUP_NOW_TIMEOUT_MS_V1,
    }, "the shipped interpreter, the shipped artifact, the protected configuration, and the shipped bound");
    // The bound is BETWEEN the dump's own 120 s and the owner-request loop's 300 s:
    // above the first or a slow dump is killed mid-run, below the second or the
    // loop times out first and returns WITHOUT finishing the request row, so the
    // control retries forever with no refusal stored.
    assert.ok(BACKUP_NOW_TIMEOUT_MS_V1 > 120_000 && BACKUP_NOW_TIMEOUT_MS_V1 < 300_000,
      `the child's bound must sit between the dump's 120s and the loop's 300s, got ${BACKUP_NOW_TIMEOUT_MS_V1}`);

    // THE TRUST HALF, and its ORDER: both checks run before the spawn, and the
    // spawn does not happen at all when one of them refuses. A substituted
    // `current/dist-vps` must never be run by the trusted updater.
    const refused = [];
    const refusingPort = defaultBackupNowV1(installRootV1, {
      assertPath: async (path, options) => {
        refused.push({ path, executable: options?.executable === true });
        if (path.endsWith("nightlyBackup.js")) throw new Error("t1_path_writable");
        return path;
      },
      spawnBackup: async () => { throw new Error("the spawn must not be reached"); },
    });
    await assert.rejects(refusingPort(), /t1_path_writable/u,
      "an untrusted script path refuses before anything is spawned");
    assert.deepEqual(refused.map(entry => entry.executable), [true, false],
      "the interpreter is checked AS AN EXECUTABLE and the script as a plain path, before the spawn");
    assert.equal(spawned.length, 1, "and no child was spawned for the refused attempt");

    // THE REAL SPAWN, end to end, with a real child process — the DEFAULT
    // `spawnBackup`, not the parameter. Everything above observes a seam; this
    // proves the seam's real implementation speaks the contract it claims, and it
    // is the only place the timeout, the output cap and the signal handling are
    // exercised against an actual OS process.
    const real = mkdtempSync(join(tmpdir(), "backup-now-real-"));
    t.after(() => rmSync(real, { recursive: true, force: true }));
    // `mode.txt` sits BESIDE THE COPIED SCRIPT, because the fixture resolves it
    // relative to `import.meta.url` — and the script that runs is the copy under
    // `<root>/current/dist-vps/server/`, not the source in `real/`. MEASURED twice:
    // one directory up, and in `real/`, both made every case fail with
    // `nightly_backup_execution_failed`, because the child could not read its own
    // mode and fell through every branch. A getter, because the install root is
    // created after this line.
    const modeFile = () => join(rootV1, "current", "dist-vps", "server", "mode.txt");
    // The install root is built to the SHAPE the port spawns, with THIS lane's
    // own child standing in for the built artifact — so the REAL spawn runs, with
    // the real `env: { LANG, LC_ALL }`, the real timeout, the real 64 KiB output
    // cap and the real signal handling, and only the shipped script's CONTENT is
    // this fixture's. `assertPath` is injected for the reason the port takes it:
    // `assertT1Path` requires root ownership and this lane has none.
    const rootV1 = join(real, "install");
    await mkdir(join(rootV1, "runtime", "node-current", "bin"), { recursive: true });
    await mkdir(join(rootV1, "current", "dist-vps", "server"), { recursive: true });
    // A SYMLINK to the real node, not a copy of its bytes: `process.execPath` is a
    // Mach-O binary, and writing it as a text file gives a file with no exec
    // format — MEASURED, the real spawn answered `spawn ENOEXEC`. A symlink is
    // also closer to production, where `runtime/node-current/bin/node` is the
    // vendored tree the installer stages.
    await symlink(process.execPath, join(rootV1, "runtime", "node-current", "bin", "node"));
    // The fixture is written FIRST and copied into the install root after: MEASURED,
    // the other order read a file that did not exist yet (ENOENT) — the copy is
    // what makes this fixture's CONTENT the shipped script's content, and it has
    // to happen after the source exists.
    await writeFile(join(real, "child.mjs"), [
      // The real port always passes --configuration <path>; this fixture reads its
      // behaviour from a sibling file so one artifact serves every case.
      'import { readFileSync } from "node:fs";',
      'const mode = readFileSync(new URL("./mode.txt", import.meta.url), "utf8").trim();',
      'if (mode === "ok") process.stdout.write("nightly database backup completed\\n");',
      'if (mode === "fail") process.stderr.write("nightly database backup failed: nightly_backup_output_refused\\n");',
      // Reports its own pid before blocking, so the lane can ask whether it is still
      // alive WITHOUT discovering it by searching `ps` for a pattern — this job's
      // own child, by the pid it named itself.
      'if (mode === "hang") { process.stderr.write(`PID=${process.pid}\\n`); setInterval(() => {}, 1000); }',
      // 40000 x 64 bytes is 2.5 MB against the spawn's 64 KiB cap — a child that
      // ignores the cap rather than one that brushes it.
      'if (mode === "flood") for (let i = 0; i < 40000; i += 1) process.stdout.write("x".repeat(64));',
      // THE ENVIRONMENT, reported by the child itself. MEASURED: with the spawn's
      // `env` replaced by `process.env` this case still passed, because nothing
      // asserted it — the trusted base is what keeps a PG*, DYLD_* or NODE_OPTIONS
      // variable in the updater's own environment from reaching the dump, and that
      // is a claim about a process boundary, so it is checked from the other side.
      'if (mode === "env") {',
      '  process.stdout.write(`ENVKEYS=${Object.keys(process.env).sort().join(",")}\\n`);',
      '  process.stdout.write(`LEAKED=${["PGHOST","PGPORT","PGUSER","PGDATABASE","PGOPTIONS","PGSSLMODE","NODE_OPTIONS","NODE_PATH","DYLD_INSERT_LIBRARIES","HOME","PATH"].filter(n => process.env[n] !== undefined).join(",")}\\n`);',
      '}',
      'process.exitCode = mode === "fail" ? 1 : 0;',
    ].join("\n"), "utf8");
    await writeFile(join(rootV1, "current", "dist-vps", "server", "nightlyBackup.js"),
      await readFile(join(real, "child.mjs"), "utf8"), { mode: 0o700 });
    const port = (timeoutMs) => defaultBackupNowV1(rootV1, { assertPath: async path => path, timeoutMs });
    const asMode = () => defaultBackupNowV1(rootV1, { assertPath: async path => path, timeoutMs: 2_000 });
    const mode = async value => writeFile(modeFile(), value, "utf8");
    let seenStdout = "";
    await mode("ok");
    await asMode()();
    await mode("fail");
    await assert.rejects(asMode(), error => error.code === "nightly_backup_output_refused",
      "a real child that fails surfaces its own named reason through the real spawn");
    // THE ENVIRONMENT, measured from the child's side. MEASURED: replacing the
    // spawn's `env: buildTrustedEnvironment()` with `env: process.env` left every
    // lane green, because nothing asserted it — and the trusted base is the whole
    // reason a `PG*`, `NODE_OPTIONS` or `DYLD_*` variable in the updater's own
    // environment cannot reach the dump. That is a claim about a process boundary,
    // so it is checked from the other side of it: the child prints what it was
    // given, with those variables deliberately SET in this process.
    // The hostile variables are set in THIS process, so the spawn has something to
    // strip. `buildTrustedEnvironment` reads from nothing, so nothing here can
    // reach the child — that is the property under test.
    for (const [name, value] of Object.entries({ PGOPTIONS: "-c search_path=pg_catalog",
      PGHOST: "/tmp/elsewhere", NODE_OPTIONS: "--no-warnings", DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      PATH: "/tmp/evil-bin" })) {
      process.env[name] = value;
      t.after(() => { delete process.env[name]; });
    }
    assert.ok(process.env.PGOPTIONS && process.env.NODE_OPTIONS,
      "the hostile variables really are set in this process, so the spawn had something to strip");
    await mode("env");
    // The PORT, with its REAL spawn — `spawnBackup` is not passed, so
    // `spawnNightlyBackupV1` runs. The child's stdout, which the spawn already
    // buffers, is what reports the environment.
    const outcome = await defaultBackupNowV1(rootV1, {
      assertPath: async path => path,
      readOutcome: result => { seenStdout = result.stdout; return { ok: true }; },
    })();
    void outcome;
    const report = seenStdout;
    assert.match(report, /ENVKEYS=/u, `the child reported its environment: ${report.slice(0, 200)}`);
    const keys = /ENVKEYS=([^\n]*)/u.exec(report)?.[1]?.split(",").filter(Boolean) ?? [];
    assert.ok(keys.includes("LANG") && keys.includes("LC_ALL"),
      `the trusted base is present, got ${keys.join(",")}`);
    for (const stripped of ["PGOPTIONS", "PGHOST", "NODE_OPTIONS", "DYLD_INSERT_LIBRARIES", "PATH", "HOME"]) {
      assert.equal(keys.includes(stripped), false,
        `${stripped} is set in the updater's own environment and must NOT reach the dump child`);
    }

    await mode("hang");
    // THE TIMEOUT, against a real child that never exits. This is the assertion
    // that matters most: a control that hangs holds the owner-request loop's slot
    // and is retried forever with nothing stored, so the bound must actually fire.
    const startedAt = Date.now();
    await assert.rejects(asMode(), error => error.code === "nightly_backup_execution_failed",
      "a child that never exits is killed at the bound and reported as a refusal");
    assert.ok(Date.now() - startedAt < 20_000, "and the bound fires promptly rather than at the loop's own 300s");

    // NOBODY IS LEFT BEHIND, and this is the assertion the port was missing.
    //
    // MEASURED, and this is how it was found: the lane PASSED and `ps` afterwards
    // still showed the hung child — running, holding the install root, long after
    // the test had exited and its parent was gone. `child.kill("SIGKILL")` killed the
    // thing the port spawned and not the thing that thing spawned, and the shipped
    // child is `node`, whose `pg_dump` is the process that actually holds the
    // SERIALIZABLE snapshot and the output file open. The port now signals the
    // child's PROCESS GROUP (`updater.mjs`, `detached: false` plus a negative pid),
    // which reaches the dump and nothing else.
    //
    // The pid has to come from the child the PORT abandoned, not from a spawn this
    // lane makes itself — MEASURED, an earlier version of this assertion ran its own
    // `spawn` and therefore checked a child it had killed itself, and killing only
    // the direct pid in `updater.mjs` left it green. `readOutcome` is where it is
    // read: the port hands it the real result, and that result carries the child's
    // stderr, which carries the pid.
    await mode("hang");
    let abandonedStderr = "";
    await defaultBackupNowV1(rootV1, {
      assertPath: async path => path,
      timeoutMs: 1_500,
      readOutcome: result => {
        abandonedStderr = String(result.stderr ?? "");
        return { ok: true };
      },
    })();
    const abandonedPid = Number(/PID=(\d+)/u.exec(abandonedStderr)?.[1] ?? 0);
    assert.ok(abandonedPid > 0, `the abandoned child reported its pid, got ${abandonedPid} from ${abandonedStderr.slice(0, 120)}`);
    // `kill(pid, 0)` probes liveness without delivering a signal, and this asks about
    // exactly the pid the port spawned — no pgrep, no pkill, and nothing addressed to
    // a process this job did not start.
    const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; } };
    for (let attempt = 0; attempt < 40 && alive(abandonedPid); attempt += 1) {
      await new Promise(done => { setTimeout(done, 50); });
    }
    assert.equal(alive(abandonedPid), false,
      `the abandoned child (pid ${abandonedPid}) must be GONE, not merely unreported — one that survives keeps the dump's snapshot and output open`);

    await mode("flood");
    await assert.rejects(asMode(), error => error.code === "nightly_backup_execution_failed",
      "a child that floods stdout past the cap is abandoned, not buffered without limit");
    await mode("ok");
    // CONCURRENT CALLERS: twenty presses at once, twenty real children. Asserted
    // on completion and on none being refused — the failure mode that matters is a
    // hung child or a shared descriptor, not a refusal.
    const twenty = await Promise.all(Array.from({ length: 20 }, () => asMode()()
      .then(() => "acted", (error) => String(error.code))));
    assert.deepEqual([...new Set(twenty)], ["acted"],
      `twenty concurrent callers each completed and none interfered: ${[...new Set(twenty)].join(",")}`);
    // And the port still refuses a root it cannot trust, which is the check the
    // REAL assertPath performs in production.
    assert.equal(typeof port(2_000), "function");

    // A NONZERO EXIT SURFACES AS THE OWNER'S NAMED REFUSAL, through the same port.
    const failingPort = defaultBackupNowV1(installRootV1, {
      assertPath: async path => path,
      spawnBackup: async () => ({ code: 1, signal: null, stdout: "",
        stderr: "nightly database backup failed: nightly_backup_configuration_refused\n" }),
    });
    await assert.rejects(failingPort(), error => error.code === "nightly_backup_configuration_refused",
      "the child's own named reason reaches the owner through the port");

    // (4) The OUTCOME MAPPING: a child that exits 0 must be success, and a child
    // that exits nonzero with an UNKNOWN reason must NOT be able to name its own.
    // This one is a pure function, so it needs no plant: its states are
    // asserted directly and either can be flipped by editing one branch.
    assert.deepEqual(parseNightlyBackupOutcomeV1({ code: 0, signal: null, stderr: "" }), { ok: true },
      "exit 0 is success, whatever the child printed");
    assert.deepEqual(parseNightlyBackupOutcomeV1({ code: 1, signal: null,
      stderr: "nightly database backup failed: nightly_backup_configuration_refused\n" }),
    { ok: false, reason: "nightly_backup_configuration_refused" },
    "the child's OWN named reason reaches the owner");
    assert.deepEqual(parseNightlyBackupOutcomeV1({ code: 1, signal: null,
      stderr: "nightly database backup failed: something_a_child_invented\n" }),
    { ok: false, reason: "nightly_backup_execution_failed" },
    "and a reason outside the closed set is replaced, never believed");
    assert.deepEqual(parseNightlyBackupOutcomeV1({ code: null, signal: "SIGKILL", stderr: "" }),
      { ok: false, reason: "nightly_backup_execution_failed" },
      "a killed child (the timeout) is a refusal, not a silent success");
    assert.deepEqual(parseNightlyBackupOutcomeV1({ code: 1, signal: null,
      stderr: "nightly database backup completed\n" }), { ok: false, reason: "nightly_backup_execution_failed" },
      "a nonzero exit is never success, whatever the child printed on stdout");
  } finally {
    for (const restoreFile of planted) await restoreFile().catch(() => {});
  }
});

test("the fixed updater accepts exactly the four reviewed direct dependencies", async t => {
  const fixture = await fixtureV1(t), old = process.env.CONTROL_ROOM_BUNDLE_TESTING;
  process.env.CONTROL_ROOM_BUNDLE_TESTING = "1";
  t.after(() => { if (old === undefined) delete process.env.CONTROL_ROOM_BUNDLE_TESTING;
    else process.env.CONTROL_ROOM_BUNDLE_TESTING = old; });
  const manifestPath = join(fixture.source, "src/updater/v1/package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  // FOUR, and each is load-bearing: the passkey server, the pg driver, the
  // installer's QR generator, and the updater's own web-push drain. A dependency
  // that goes missing is the failure this whole assertion exists to catch, and it
  // is caught at BUILD time or not at all.
  assert.deepEqual(manifest.dependencies, { "@simplewebauthn/server": "14.0.3", pg: "8.23.0",
    "qrcode-generator": "1.4.4", "web-push": "3.6.7" });
  // One mutation per dependency: an extra one, and a drop plus a version change
  // for each of the two that arrived from the installer's side of the merge.
  for (const mutate of [value => { value.dependencies.extra = "1.0.0"; },
    value => { delete value.dependencies["qrcode-generator"]; },
    value => { value.dependencies["qrcode-generator"] = "1.4.3"; },
    value => { delete value.dependencies["web-push"]; },
    value => { value.dependencies["web-push"] = "3.6.6"; }]) {
    const changed = structuredClone(manifest); mutate(changed); await writeFile(manifestPath, JSON.stringify(changed));
    await assert.rejects(buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root }), /updater_bundle_lock_refused/u);
  }
  await writeFile(manifestPath, JSON.stringify(manifest));
});

test("the bundle's stage one runs the Face ID port with pg inlined, from a copy with no node_modules", async t => {
  // atk-fa F2: install night runs the installer from the git-archive copy, which has no
  // node_modules, so its own Face ID port died on `import("pg")` and the step always
  // stopped `passkey_registration_failed`. The installer now calls stage one's port,
  // and stage one comes from this bundle: prove its copy loads pg and the passkey
  // modules from a lone copied file (no node_modules anywhere above it).
  const fixture = await fixtureV1(t);
  const old = process.env.CONTROL_ROOM_BUNDLE_TESTING; process.env.CONTROL_ROOM_BUNDLE_TESTING = "1";
  t.after(() => { if (old === undefined) delete process.env.CONTROL_ROOM_BUNDLE_TESTING;
    else process.env.CONTROL_ROOM_BUNDLE_TESTING = old; });
  await buildFixedUpdaterBundleV1({ ...fixture, runtime: fixture.root });
  const lone = await mkdtemp(join(tmpdir(), "stage-one-lone-")), root = join(lone, "install-root");
  t.after(async () => { await import("node:fs/promises").then(fs => fs.rm(lone, { recursive: true, force: true })); });
  await cp(join(fixture.output, "lib/install-steps.mjs"), join(lone, "install-steps.mjs"));
  await mkdir(join(root, "updater-state"), { recursive: true, mode: 0o700 });
  // Every entry defines `require` for its inlined CommonJS packages (pg needs Node's built-ins).
  for (const entry of ["updater.mjs", "bin/control-room.mjs", "lib/install-steps.mjs", "bin/init-database.mjs"]) {
    const head = (await readFile(join(fixture.output, entry), "utf8")).split("\n").slice(0, 2).join("\n");
    assert.match(head, /^import \{ createRequire as __controlRoomCreateRequire \} from "node:module"; const require = /mu, entry);
  }
  const bytes = await readFile(join(lone, "install-steps.mjs"), "utf8");
  assert.doesNotMatch(bytes, /(?:from|import\()\s*["'](?:pg|@simplewebauthn\/server)["']/u, "pg and webauthn are inlined");
  const program = `const m = await import(${JSON.stringify(pathToFileURL(join(lone, "install-steps.mjs")).href)});
    const unavailable = async () => { throw new Error("system_port_used"); };
    const system = Object.fromEntries(["installServices","uninstallServices","recoverServices","restartServices",
      "startPostHealthServices","readTailscaleRpId","captureTailscaleServe","activateTailscaleServe","inspectTailscaleServe",
      "restoreTailscaleServe","moveLiveDatabase","randomBytes","initializeDatabase","retireDatabase","firstOwner",
      "writeDatabaseLogins","removeDatabaseLogins","recordPasskeyStatus","checkDatabaseHealth"].map(n => [n, unavailable]));
    const terminal = { isTTY: true, write() {}, setRawMode() {}, readLine: async () => { throw new Error("asked"); } };
    try {
      await m.createStageOnePortsV1(system).registerInitialPasskey({ root: ${JSON.stringify(root)},
        config: { rpId: "control.example.ts.net" }, ownerCode: "o".repeat(43), terminal,
        qr: { ownerCodePolicy: "every-unconsumed-attempt" }, maxAttempts: 5 });
      process.stdout.write("registered?");
    } catch (error) { process.stdout.write(String(error?.code ?? error?.message)); }`;
  const { spawnSync } = await import("node:child_process");
  const child = spawnSync(process.execPath, ["--input-type=module", "--eval", program],
    { cwd: lone, env: { LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 60_000 });
  assert.equal(child.status, 0, child.stderr);
  // pg, the passkey store and authority all loaded; it stopped at the updater's own
  // configuration loader, the first thing that needs the install (no updater.json).
  assert.equal(child.stdout, "updater_configuration_refused", child.stderr);
});
