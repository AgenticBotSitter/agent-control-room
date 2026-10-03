#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { chmod, copyFile, cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const refuse = code => { throw Object.assign(new Error(code), { code }); };
const sha256 = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function argumentsV1(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) refuse("updater_bundle_arguments_refused");
    result[key.slice(2)] = value;
  }
  for (const required of ["source", "policy", "runtime", "store", "output"])
    if (!result[required]) refuse("updater_bundle_arguments_refused");
  return result;
}

async function run(executable, args, cwd) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, stdio: "inherit", env: { PATH: "/usr/bin:/bin", HOME: "/var/empty" } });
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 ? resolveRun() : reject(Object.assign(
      new Error(`updater_bundle_tool_failed:${code ?? signal}`), { code: "updater_bundle_tool_failed" })));
  });
}

async function copyTree(source, destination) {
  const entry = await lstat(source);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || (entry.isFile() && entry.nlink !== 1))
    refuse("updater_bundle_input_refused");
  if (entry.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    for (const name of (await readdir(source)).sort()) await copyTree(join(source, name), join(destination, name));
  } else { await cp(source, destination, { dereference: false }); await chmod(destination, entry.mode & 0o111 ? 0o500 : 0o400); }
}

async function manifestFiles(root, current = root) {
  const files = [];
  for (const name of (await readdir(current)).sort()) {
    if (name === "manifest.json") continue;
    const path = join(current, name), entry = await lstat(path);
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()) || (entry.isFile() && entry.nlink !== 1))
      refuse("updater_bundle_output_refused");
    if (entry.isDirectory()) files.push(...await manifestFiles(root, path));
    else files.push({ path: relative(root, path), sha256: sha256(await readFile(path)), mode: entry.mode & 0o777,
      type: "file" });
  }
  return files;
}

/**
 * The bundle's ENTRIES, exactly, and the reason they are a constant here rather
 * than read from the policy file.
 *
 * `policy/bundle.json` already declares these; comparing the two is the point.
 * A builder that trusted the policy file's own `entries` would build whatever
 * the file said, and a policy file is a reviewable artifact precisely because the
 * builder holds an independent copy of what it is allowed to build. So the
 * policy file says what is intended and this says what is permitted, and adding
 * an entry is a two-place change that fails loudly until both are made.
 *
 * The two database-phase entries are there because `initializeDatabaseV1` in
 * `src/updater/v1/cli/control-room-native-ports.mjs` spawns
 * `updater/current/bin/init-database.mjs` and
 * `updater/current/bin/apply-release-schema.mjs`. Without them the port's two
 * `assertPath` checks pass and the spawn fails at run time, on install night,
 * with a refusal that names a path nothing built.
 *
 * The stage-one entry is there because the verified bundle's consumer,
 * `bootstrap.mjs`, imports `lib/install-steps.mjs` from the bundle it was handed
 * and calls `createStageOnePortsV1` on it. It arrived from the installer stream
 * and this constant is the merge's union, in the order both sides declared:
 * the four shared entries, then stage one, then the two phases.
 */
const EXACT_ENTRIES_V1 = Object.freeze([
  Object.freeze({ input: "updater.mjs", output: "updater.mjs" }),
  Object.freeze({ input: "service-output.mjs", output: "service-output.mjs" }),
  Object.freeze({ input: "cli.mjs", output: "bin/control-room.mjs" }),
  Object.freeze({ input: "build-attended-release.mjs", output: "bin/build-attended-release.mjs" }),
  Object.freeze({ input: "fixed-bundle.mjs", output: "bin/build-fixed-bundle.mjs" }),
  Object.freeze({ input: "install/install-steps.mjs", output: "lib/install-steps.mjs" }),
  Object.freeze({ input: "pg/init-database.mjs", output: "bin/init-database.mjs" }),
  Object.freeze({ input: "pg/apply-release-schema.mjs", output: "bin/apply-release-schema.mjs" }),
]);

export async function buildFixedUpdaterBundleV1(input) {
  const source = resolve(input.source), policyPath = resolve(input.policy), runtime = resolve(input.runtime);
  const store = resolve(input.store), output = resolve(input.output);
  if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") {
    if (source.startsWith(`/Users${sep}`)) refuse("updater_bundle_owner_home_refused");
    if (!source.split(sep).some(part => /^job-[A-Za-z0-9._-]{1,80}$/u.test(part)))
      refuse("updater_bundle_source_refused");
  }
  const sourceUpdater = join(source, "src/updater/v1");
  try {
    await lstat(join(sourceUpdater, "node_modules"));
    refuse("updater_bundle_source_modules_refused");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const updaterPackage = JSON.parse(await readFile(join(sourceUpdater, "package.json"), "utf8"));
  const updaterLock = await readFile(join(sourceUpdater, "pnpm-lock.yaml"), "utf8");
  if (updaterPackage.name !== "@control-room/updater-v1" || updaterPackage.private !== true
      || updaterPackage.scripts !== undefined
      // BOTH runtime dependencies are pinned, and both are load-bearing: the
      // installer's `terminal/qr.mjs` imports `qrcode-generator` for the owner
      // passkey QR, and the updater's own `alerts.mjs` imports `web-push` to
      // drain `push_queue`. A pin naming one and not the other would build a
      // bundle that fails at RUN time rather than at build time, which is the
      // direction this whole assertion exists to prevent.
      || JSON.stringify(updaterPackage.dependencies) !== JSON.stringify({ "@simplewebauthn/server": "14.0.3",
        pg: "8.23.0", "qrcode-generator": "1.4.4", "web-push": "3.6.7" })
      || !/^lockfileVersion: '9\.0'/mu.test(updaterLock)
      || !/^ {6}'@simplewebauthn\/server':\n {8}specifier: 14\.0\.3\n {8}version: 14\.0\.3$/mu.test(updaterLock)
      || !/^ {6}pg:\n {8}specifier: 8\.23\.0\n {8}version: 8\.23\.0$/mu.test(updaterLock)
      || !/^ {6}qrcode-generator:\n {8}specifier: 1\.4\.4\n {8}version: 1\.4\.4$/mu.test(updaterLock)
      || !/^ {6}web-push:\n {8}specifier: 3\.6\.7\n {8}version: 3\.6\.7$/mu.test(updaterLock))
    refuse("updater_bundle_lock_refused");
  const policy = JSON.parse(await readFile(policyPath, "utf8"));
  // `--loader:.ts=ts` is in this list for ONE file: `pg-cluster-layout.ts`, which
  // `pg/init-database.mjs` and `pg/apply-release-schema.mjs` import and which the
  // builder copies into the workspace so the relative path resolves. esbuild
  // TRANSPILES it, so what lands in the bundle is JavaScript — the loader reaches
  // the build, not the shipped artifact. MEASURED: without it esbuild fails with
  // `Could not resolve "../../../pg-runtime/v1/pg-cluster-layout.ts"`, which is the
  // same failure as without the copied file, and both are needed.
  //
  // The `--banner` defines `require` for the bundled CommonJS packages. esbuild's ESM
  // output turns their `require("events")` (and every other Node built-in) into a
  // `__require` that throws "Dynamic require of … is not supported" when no
  // `require` is in scope. MEASURED (cl-hard5, atk-fa F2): `pg` died that way inside
  // the bundle, so neither the updater daemon's database connection nor the
  // install-night Face ID port could ever open a session from the fixed bundle.
  const exactArguments = ["--bundle", "--platform=node", "--format=esm", "--target=node22", "--packages=bundle",
    "--log-level=warning", "--loader:.ts=ts",
    "--banner:js=import { createRequire as __controlRoomCreateRequire } from \"node:module\"; const require = __controlRoomCreateRequire(import.meta.url);"];
  if (policy.schema !== "control-room.updater-bundle-policy/v1" || policy.candidateBuildOutputAccepted !== false
      || policy.packageManager !== "runtime/pnpm-current/pnpm"
      || JSON.stringify(policy.arguments) !== JSON.stringify(exactArguments)
      || JSON.stringify(policy.entries) !== JSON.stringify(EXACT_ENTRIES_V1)) refuse("updater_bundle_policy_refused");
  let tool = join(runtime, policy.tool);
  let packageManager = join(runtime, policy.packageManager);
  if (input.esbuild) {
    if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") refuse("updater_bundle_tool_override_refused");
    tool = resolve(input.esbuild);
  }
  if (input.pnpm) {
    if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") refuse("updater_bundle_tool_override_refused");
    packageManager = resolve(input.pnpm);
  }
  for (const executable of [tool, packageManager]) {
    const toolEntry = await lstat(executable);
    if (!toolEntry.isFile() || toolEntry.isSymbolicLink()) refuse("updater_bundle_tool_refused");
  }
  const storeEntry = await lstat(store);
  if (!storeEntry.isDirectory() || storeEntry.isSymbolicLink()) refuse("updater_bundle_store_refused");

  const staging = join(dirname(output), `.${basename(output)}.${process.pid}.${randomBytes(8).toString("hex")}.staging`);
  await mkdir(staging, { recursive: false, mode: 0o700 });
  try {
    const workspaceRoot = join(staging, ".build");
    const workspace = join(workspaceRoot, "src/updater/v1");
    await mkdir(dirname(workspace), { recursive: true, mode: 0o700 });
    await copyTree(sourceUpdater, workspace);
    // Installer key custody reuses the signing contract; stage its node-only module.
    const signingTarget = join(workspaceRoot, "scripts/release-signing.mjs");
    await mkdir(dirname(signingTarget), { recursive: true, mode: 0o700 });
    await copyFile(join(source, "scripts/release-signing.mjs"), signingTarget);
    // The CLUSTER LAYOUT, and why it is copied rather than imported from source.
    //
    // MEASURED: `pg/init-database.mjs` imports
    // `../../../pg-runtime/v1/pg-cluster-layout.ts`, and esbuild failed the build
    // with `Could not resolve "../../../pg-runtime/v1/pg-cluster-layout.ts"`. The
    // reason is the workspace's SHAPE, not the extension: `.build` is a copy of
    // `src/updater/v1` alone, so the relative path climbs out of the workspace to
    // a file that is not there.
    //
    // So the file is placed where that relative path ACTUALLY LANDS. MEASURED: from
    // `pg/init-database.mjs` the import `../../../pg-runtime/v1/pg-cluster-layout.ts`
    // resolves three levels up from `pg/` — out of `.build`, out of `staging`,
    // and then down again. The first attempt put the file at
    // `staging/pg-runtime/v1/pg-cluster-layout.ts` and esbuild still answered
    // `Could not resolve`, because that path is two levels up, not three.
    //
    // The two consequences, both deliberate:
    //
    //   - TypeScript reaches the BUNDLE BUILD, not the shipped bundle. esbuild
    //     transpiles it, so `manifest.json` records JavaScript. The trust rule
    //     (`--packages=bundle`, and the phase scripts carrying no release code)
    //     is about what is INSTALLED, and what is installed here is a `.js` file.
    //     That is why the policy arguments gain `--loader:.ts=ts` rather than the
    //     module being duplicated as JavaScript: a hand-maintained second copy of
    //     a layout that decides the peer map would be a second source of truth for
    //     the one thing a wrong copy makes reachable.
    //   - the layout is the ONLY file crossed in from outside `src/updater/v1`.
    //     Anything else would have to be listed here too, which is the point: the
    //     updater's dependency on the rest of the repository is exactly this file
    //     and the manifest's role attributes, both reviewable in one place.
    //
    // It is placed BESIDE the workspace, inside the staging tree, and it is
    // removed with the staging tree's own cleanup on the failure path — a
    // leftover `pg-runtime/` in the build root would be a stray artifact nobody
    // owns.
    //
    // MEASURED, and the ANCHOR is the part that matters: `cook/v1` moved the
    // workspace from `<staging>/` to `<staging>/.build/src/updater/v1`, so the
    // relative import `../../../pg-runtime/v1/pg-cluster-layout.ts` — correct for
    // the old shape — now lands somewhere else entirely. Writing the file at
    // `dirname(staging)/pg-runtime` (the old anchor) produced `Could not resolve
    // "../../../pg-runtime/v1/pg-cluster-layout.ts"`. So the target is RESOLVED
    // FROM THE IMPORT below, which is what keeps this correct when the workspace
    // shape changes again.
    const workspaceParent = dirname(staging);
    const layoutSource = join(source, "src/pg-runtime/v1/pg-cluster-layout.ts");
    // `pg/init-database.mjs` sits at `<workspace>/pg/`, and its
    // `../../../pg-runtime/...` is anchored to THAT directory — not to the
    // staging tree and not to the repository.
    const layoutRoot = resolve(join(workspace, "pg", "../../../pg-runtime"));
    const layoutTarget = join(layoutRoot, "v1", "pg-cluster-layout.ts");
    await mkdir(dirname(layoutTarget), { recursive: true, mode: 0o700 });
    await copyFile(layoutSource, layoutTarget);
    // THE BACKUP-RECENCY READER, crossed in exactly the way the layout is, and
    // for the same reason: it is a zero-dependency module `updater.mjs` reaches
    // across a directory boundary for.
    //
    // R5B-01 gave the updater an owner-visible answer to "how old is the newest
    // good backup", read from the directory the nightly writes
    // (`nightly-backup-recency.ts`). MEASURED: with only the layout crossed in,
    // the bundle build refused with esbuild `Could not resolve
    // "../../installer/v1/nightly-backup-recency.ts"` — a BUILD failure, not a
    // runtime one, which is the direction that matters, because
    // `buildFixedUpdaterBundleV1` is what produces every self-update bundle and
    // `updater.mjs` is entry #1 in `EXACT_ENTRIES_V1`.
    //
    // WHY THIS FILE AND NOT `nightly-backup.ts`. Its own imports are
    // `node:fs`, `node:fs/promises` and `node:path` and nothing else, so
    // crossing it in carries no release code into the trusted component — which
    // is the whole rule the crossed-in list exists to keep. Its neighbour
    // `nightly-backup.ts` imports `./nightly-backup-configuration`, which imports
    // `deploy/postgres/migration-ledger.json`: RELEASE DATA, which must never
    // enter this bundle. So the reader crosses in and the runner is SPAWNED
    // instead; see `defaultBackupNowV1` in `src/updater/v1/updater.mjs`.
    //
    // It is TypeScript for the same reason the layout is: esbuild transpiles it,
    // so what lands in the bundle is JavaScript, and the trust rule is about what
    // is INSTALLED.
    const recencyRoot = resolve(join(workspace, "../../installer/v1"));
    const recencyTarget = join(recencyRoot, "nightly-backup-recency.ts");
    await mkdir(recencyRoot, { recursive: true, mode: 0o700 });
    await copyFile(join(source, "src/installer/v1/nightly-backup-recency.ts"), recencyTarget);
    // Shared modules cross in from outside the copied updater tree. Keep this
    // list aligned with the attended source inputs so isolated bundles can load.
    const guardRoot = resolve(join(workspace, "../../installer/shared"));
    await mkdir(guardRoot, { recursive: true, mode: 0o700 });
    for (const name of ["is-main-module", "strict-json", "rehearsal-hostname", "file-custody", "private-process-lock", "jsonl-prefix"])
      await copyFile(join(source, `src/installer/shared/${name}.mjs`), join(guardRoot, `${name}.mjs`));
    // And the staged copy of THIS file is itself a bundle entry (`policy/bundle.json`
    // lists it). It carries its entry guard INLINE (rv-9b B3: the seed runs it
    // unbundled), so it is staged byte for byte, and it must stay dependency-free:
    // a relative import here would resolve nowhere from the seed or a job copy.
    const stagedBuilder = join(workspace, "fixed-bundle.mjs");
    const builderSource = join(source, "scripts/updater/build-fixed-updater-bundle.mjs");
    const builderText = await readFile(builderSource, "utf8");
    if (/^import[^;]*from\s*"\.{1,2}\//mu.test(builderText)) refuse("updater_bundle_builder_entry_guard_refused");
    await writeFile(stagedBuilder, builderText, { mode: 0o500 });
    await run(packageManager, ["install", "--offline", "--ignore-scripts", "--frozen-lockfile",
      `--store-dir=${store}`, `--dir=${workspace}`], workspace);
    if (input.testNodeModules) {
      if (process.env.CONTROL_ROOM_BUNDLE_TESTING !== "1") refuse("updater_bundle_test_modules_refused");
      await import("node:fs/promises").then(fs => fs.symlink(resolve(input.testNodeModules), join(workspace, "node_modules")));
    }
    for (const entry of policy.entries) {
      const target = join(staging, entry.output); await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await run(tool, [...policy.arguments, `--outfile=${target}`, join(workspace, entry.input)], workspace);
    }
    // `third_party` came from the installer stream: the bundle's
    // `lib/install-steps.mjs` imports `qrcode-generator`, whose pinned licence
    // evidence must travel with the bundle for the licence gates to hold on
    // install night.
    for (const name of ["ddl", "policy", "third_party"]) await copyTree(join(workspace, name), join(staging, name));
    // The release schema digest query, and ONLY that file, out of `pg/`.
    //
    // `pg/` is not copied wholesale because it holds the phase's own source, and
    // the bundle's trust rule is that the updater carries no release code and no
    // TypeScript - shipping the directory would ship both. The one file the
    // installed phase actually reads at run time is the digest query, and it is
    // an artifact rather than a module: no import, no TypeScript, and its
    // equivalence to the release's own copy is asserted by a test (see
    // `src/updater/v1/pg/release-schema-digest.mjs`).
    //
    // The path is the one `RELEASE_SCHEMA_DIGEST_SQL_RELATIVE_PATH_V1` names, and
    // a rename there without a rename here is caught by the phase's own refusal
    // `release_schema_digest_sql_refused` at install time, not at merge time.
    const digestSql = join(workspace, "pg/release-schema-digest.sql");
    await mkdir(join(staging, "pg"), { recursive: true, mode: 0o700 });
    await copyFile(digestSql, join(staging, "pg/release-schema-digest.sql"));
    await chmod(join(staging, "pg/release-schema-digest.sql"), 0o500);
    await copyTree(join(workspace, "guard/guard.sh"), join(staging, "guard.sh"));
    await copyTree(join(workspace, "bin/control-room"), join(staging, "bin/control-room"));
    await copyTree(join(workspace, "bin/git-credential-control-room"), join(staging, "bin/git-credential-control-room"));
    // The workspace root, not the updater subtree: `cook/v1` moved the copy one
    // level down (`.build/src/updater/v1`), so removing only `workspace` would
    // leave `.build` and the crossed-in `pg-runtime/` beside the staging tree —
    // strays in the build root that no manifest lists. Both crossed-in files live
    // inside `workspaceRoot`, so this one removal takes them with it.
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(layoutRoot, { recursive: true, force: true });
    await chmod(join(staging, "service-output.mjs"), 0o555);
    await chmod(join(staging, "updater.mjs"), 0o500); await chmod(join(staging, "bin/control-room.mjs"), 0o500);
    await chmod(join(staging, "bin/build-attended-release.mjs"), 0o500);
    await chmod(join(staging, "bin/build-fixed-bundle.mjs"), 0o500);
    await chmod(join(staging, "lib/install-steps.mjs"), 0o500);
    // The database-phase scripts are BUNDLE ENTRIES (see `policy/bundle.json`),
    // so they arrive here already built, and they are read-only for the same
    // reason every other bin is: the installer's own copy must not be editable
    // by the account that runs it.
    for (const name of ["bin/init-database.mjs", "bin/apply-release-schema.mjs"]) {
      await chmod(join(staging, name), 0o500);
    }
    await chmod(join(staging, "guard.sh"), 0o500); await chmod(join(staging, "bin/control-room"), 0o500);
    await chmod(join(staging, "bin/git-credential-control-room"), 0o500);
    for (const name of (await readdir(join(staging, "policy"))).filter(name => /^service-[a-z-]+\.sb$/u.test(name))) {
      await chmod(join(staging, "policy", name), 0o440);
    }
    const manifest = { schema: "control-room.updater-bundle-manifest/v1", files: await manifestFiles(staging) };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o400 });
    await chmod(staging, 0o711);
    await rename(staging, output);
    return { manifest, digest: sha256(Buffer.from(JSON.stringify(manifest))) };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    // Same reason as the success path: the layout was written outside the staging
    // tree, so leaving it would leak a directory into the caller's build root on
    // every failed build.
    await rm(join(dirname(staging), "pg-runtime"), { recursive: true, force: true });
    throw error;
  }
}

// The shared entry guard's contract (`src/installer/shared/is-main-module.mjs`),
// carried INLINE because this file runs UNBUNDLED from `updater/seed-<c12>/bin/`
// and from each job's per-phase `builder-tools/bin/` copy (rv-9b B3). From there
// the shared module's relative import resolves outside the copy, so every fresh
// install failed at `ERR_MODULE_NOT_FOUND` before building. The seed's contract is
// "dependency-free builder entry points" (`install/bootstrap.mjs`), and
// `tests/invoked-directly.test.mjs` holds this copy equal to the shared guard case
// by case and allows it in exactly the two seed-run builders.
export function seedEntryIsMainV1(entryPath, moduleUrl) {
  if (entryPath === undefined || entryPath === null) return false;
  const refuse = reason => {
    throw Object.assign(new Error(`direct_entry_guard_refused: ${reason}`), { code: "direct_entry_guard_refused" });
  };
  if (typeof entryPath !== "string") refuse("process.argv[1] is not a string");
  if (entryPath.length === 0) refuse("process.argv[1] is empty");
  if (entryPath.startsWith("file:")) refuse("process.argv[1] is a file: URL, not a path this process was started with");
  let canonicalEntry, canonicalModule;
  try { canonicalEntry = realpathSync(entryPath); } catch { refuse("process.argv[1] could not be resolved"); }
  try { canonicalModule = realpathSync(fileURLToPath(moduleUrl)); } catch { refuse("import.meta.url could not be resolved"); }
  return canonicalEntry === canonicalModule;
}

if (seedEntryIsMainV1(process.argv[1], import.meta.url)) {
  const args = argumentsV1(process.argv.slice(2));
  buildFixedUpdaterBundleV1(args).then(result => process.stdout.write(`${result.digest}\n`)).catch(error => {
    process.stderr.write(`${error?.code ?? "updater_bundle_failed"}\n`); process.exitCode = 1;
  });
}
