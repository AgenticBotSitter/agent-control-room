import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod, copyFile, lchown, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  SERVICE_PROFILE_ROLES,
  TRUSTED_RUNTIME_MANIFEST_SCHEMA,
  XCRUN_TOOL_NAMES,
  assertT1Executable,
  assertT1Path,
  buildServiceProfileParameters,
  buildTrustedEnvironment,
  isAlwaysStrippedEnvironmentName,
  parseOtoolLibraries,
  parseOtoolRpaths,
  resolveDeveloperTools,
  resolveXcrunTools,
  spawnTrusted,
  trustedToolEnvironment,
  validateTrustedRuntimeManifest,
  verifyInstalledFileInventory,
  verifyTrustedRuntimeInstallation,
} from "../src/updater/v1/trusted-runtime.mjs";
import { CORE_SERVICE_ROLES_V1, SERVICE_BATCH_ROLES_V1,
  composeServiceBundleV1 } from "../src/updater/v1/services/bundle.mjs";
import { assertRuntimeTreeRootMetadataV1, vendorTrustedRuntime } from "../scripts/updater/vendor-trusted-runtime.mjs";

const repositoryRoot = dirname(dirname(new URL(import.meta.url).pathname));
const policyRoot = join(repositoryRoot, "src/updater/v1/policy");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const readJson = async name => JSON.parse(await readFile(join(policyRoot, name), "utf8"));

function fakeEntry({ uid = 0, mode = 0o100555, type = "file" } = {}) {
  return { uid, mode,
    isFile: () => type === "file", isDirectory: () => type === "directory", isSymbolicLink: () => type === "symlink" };
}

function fakeRuntime(overrides = {}, realpaths = {}) {
  const entries = new Map(Object.entries({
    "/": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/usr": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/usr/bin": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/usr/lib": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/usr/bin/xcrun": fakeEntry(),
    "/usr/bin/sandbox-exec": fakeEntry(),
    "/usr/bin/xcode-select": fakeEntry(),
    "/usr/lib/libSystem.B.dylib": fakeEntry({ mode: 0o100444 }),
    "/runtime": fakeEntry({ mode: 0o040555, type: "directory" }),
    "/runtime/node": fakeEntry({ mode: 0o040555, type: "directory" }),
    "/runtime/node/bin": fakeEntry({ mode: 0o040555, type: "directory" }),
    "/runtime/node/bin/node": fakeEntry(),
    "/runtime/node/lib": fakeEntry({ mode: 0o040555, type: "directory" }),
    "/runtime/node/lib/libtrusted.dylib": fakeEntry({ mode: 0o100444 }),
    "/updater": fakeEntry({ mode: 0o040555, type: "directory" }),
    "/updater/policy": fakeEntry({ mode: 0o040555, type: "directory" }),
    "/updater/policy/service-builder.sb": fakeEntry({ mode: 0o100444 }),
    ...overrides,
  }));
  return {
    realpath: async path => realpaths[path] ?? path,
    lstat: async path => entries.has(path) ? entries.get(path) : Promise.reject(Object.assign(new Error("missing"), { code: "ENOENT" })),
  };
}

async function cleanupRoot(root) {
  const entry = await lstat(root).catch(() => undefined);
  if (!entry) return;
  const makeWritable = async path => {
    const item = await lstat(path);
    if (!item.isDirectory() || item.isSymbolicLink()) return;
    await chmod(path, 0o700);
    for (const name of await readdir(path)) await makeWritable(join(path, name));
  };
  await makeWritable(root);
  await rm(root, { recursive: true, force: true });
}

function rootMetadataRuntime(overrides = {}) {
  return { inspectAcl: async () => [], inspectFlags: async () => "-", async lstat(path) {
    const entry = await lstat(path);
    return new Proxy(entry, { get(target, key) {
      if (key === "uid" || key === "gid") return 0;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }, ...overrides };
}

test("runtime inventory pins Node, pnpm, esbuild and PostgreSQL and the fixed bundle tools", async () => {
  const manifest = validateTrustedRuntimeManifest(await readJson("runtime-inventory.json"));
  assert.equal(manifest.schema, TRUSTED_RUNTIME_MANIFEST_SCHEMA);
  assert.deepEqual(manifest.artifacts.map(item => `${item.tool}@${item.version}`),
    ["node@22.23.3", "pnpm@11.19.0", "esbuild@0.28.2", "postgresql@17.11"]);
  assert.equal(new Set(manifest.artifacts.map(item => item.archiveSha256)).size, 4);
  const bundle = await readJson("bundle.json");
  assert.equal(bundle.tool, "runtime/esbuild-current/esbuild");
  assert.equal(bundle.packageManager, "runtime/pnpm-current/pnpm");
  assert.equal(bundle.candidateBuildOutputAccepted, false);
  assert.deepEqual(bundle.arguments.slice(0, 4), ["--bundle", "--platform=node", "--format=esm", "--target=node22"]);
});

test("runtime manifest rejects a duplicate, unpinned, insecure or escaping artifact", async () => {
  const base = await readJson("runtime-inventory.json");
  for (const mutate of [
    value => { value.artifacts[2].tool = "node"; },
    value => { value.artifacts[0].archiveSha256 = "0".repeat(63); },
    value => { value.artifacts[1].url = "http://example.invalid/pnpm"; },
    value => { value.artifacts[2].executableRelativePath = "../escape"; },
    value => { value.artifacts[3].unreviewed = true; },
  ]) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => validateTrustedRuntimeManifest(value), /runtime_inventory_refused/u);
  }
});

test("spawn environments start empty and strip every design-listed injection family", () => {
  const names = ["PATH", "NODE_OPTIONS", "NODE_PATH", "DYLD_INSERT_LIBRARIES", "HOME", "npm_config_registry",
    "GIT_CONFIG_GLOBAL", "DEVELOPER_DIR", "SDKROOT", "OPENSSL_CONF", "SSL_CERT_FILE", "KRB5_CONFIG",
    "PGSERVICE", "TMPDIR", "BASH_ENV", "ENV"];
  for (const name of names) {
    assert.equal(isAlwaysStrippedEnvironmentName(name), true, name);
    assert.throws(() => buildTrustedEnvironment({ [name]: "hostile" }), /trusted_spawn_environment_refused/u);
  }
  process.env.NODE_OPTIONS = "--require=/untrusted/module";
  try { assert.deepEqual(buildTrustedEnvironment({ NODE_ENV: "production" }), { LANG: "C", LC_ALL: "C", NODE_ENV: "production" }); }
  finally { delete process.env.NODE_OPTIONS; }
  assert.deepEqual(trustedToolEnvironment("git"), {
    LANG: "C", LC_ALL: "C", HOME: "/var/empty", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
  });
  assert.equal(trustedToolEnvironment("pnpm").NPM_CONFIG_USERCONFIG, "/dev/null");
});

test("T1 checks root ownership, ancestor modes, init files and the dynamic-library closure", async () => {
  const runtime = fakeRuntime();
  const result = await assertT1Executable("/runtime/node/bin/node", {
    allowedRoots: ["/runtime"], initConfigFiles: ["/dev/null"], runtime,
    inspectLibraries: async image => image.endsWith("/node")
      ? ["@loader_path/../lib/libtrusted.dylib", "/usr/lib/libSystem.B.dylib"] : ["/usr/lib/libSystem.B.dylib"],
  });
  assert.deepEqual(result.images, ["/runtime/node/bin/node", "/runtime/node/lib/libtrusted.dylib"]);

  await assert.rejects(assertT1Path("/runtime/node/bin/node", { allowedRoots: ["/runtime"], executable: true,
    runtime: fakeRuntime({ "/runtime/node": fakeEntry({ uid: 501, mode: 0o040555, type: "directory" }) }) }), /t1_path_writable/u);
  await assert.rejects(assertT1Path("/runtime/node/bin/node", { allowedRoots: ["/runtime"], executable: true,
    runtime: fakeRuntime({ "/runtime/node": fakeEntry({ mode: 0o040575, type: "directory" }) }) }), /t1_path_writable/u);
  await assert.rejects(assertT1Path("/runtime/node/bin/node", { allowedRoots: ["/runtime"], executable: true,
    runtime: { ...fakeRuntime(), inspectAcl: async path => path === "/runtime/node" ? ["0: group:staff allow write"] : [] } }),
  /t1_path_writable/u);
  for (const right of ["writesecurity", "writeattr", "writeextattr", "delete_child", "append", "add_subdirectory"]) {
    await assert.rejects(assertT1Path("/runtime/node/bin/node", { allowedRoots: ["/runtime"], executable: true,
      runtime: { ...fakeRuntime(), inspectAcl: async path => path === "/runtime/node" ? [`0: group:staff allow ${right}`] : [] } }),
    /t1_path_writable/u, right);
  }
  await assert.rejects(assertT1Path("/runtime/node/bin/node", { allowedRoots: ["/updater"], executable: true, runtime }),
    /t1_path_outside_roots/u);
  await assert.rejects(assertT1Executable("/runtime/node/bin/node", { allowedRoots: ["/runtime"], runtime,
    inspectLibraries: async () => ["@rpath/libhostile.dylib"] }), /t1_library_unresolved/u);
  await assert.rejects(assertT1Executable("/runtime/node/bin/node", { allowedRoots: ["/runtime"],
    initConfigFiles: ["/runtime/node/init.conf"],
    runtime: fakeRuntime({ "/runtime/node/init.conf": fakeEntry({ uid: 501, mode: 0o100444 }) }),
    inspectLibraries: async () => [] }), /t1_path_writable/u);
});

test("otool parser accepts exact dependency rows and refuses ambiguous output", () => {
  assert.deepEqual(parseOtoolLibraries("/runtime/node:\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n"),
    ["/usr/lib/libSystem.B.dylib"]);
  assert.throws(() => parseOtoolLibraries("image:\n  hostile\n"), /t1_otool_output_invalid/u);
  assert.deepEqual(parseOtoolRpaths("/runtime/node:\nLoad command 1\n          cmd LC_RPATH\n      cmdsize 40\n         path @executable_path/../lib (offset 12)\n"),
    ["@executable_path/../lib"]);
  assert.throws(() => parseOtoolRpaths("cmd LC_RPATH\nmissing\n"), /t1_otool_output_invalid/u);
  for (const garbage of ["", "garbage", "warning: unexpected output\n", "not a mach-o\n"]) {
    assert.throws(() => parseOtoolLibraries(garbage), /t1_otool_output_invalid/u);
    assert.throws(() => parseOtoolRpaths(garbage), /t1_otool_output_invalid/u);
  }
});

test("xcrun resolution uses a clean environment and T1-checks every resolved tool and ancestor", async () => {
  const developerEntries = {
    "/Library": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/Library/Developer": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/Library/Developer/CommandLineTools": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/Library/Developer/CommandLineTools/usr": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/Library/Developer/CommandLineTools/usr/bin": fakeEntry({ mode: 0o040755, type: "directory" }),
  };
  for (const tool of XCRUN_TOOL_NAMES) developerEntries[`/Library/Developer/CommandLineTools/usr/bin/${tool}`] = fakeEntry();
  const calls = [], runtime = { ...fakeRuntime(developerEntries), inspectLibraries: async () => [], execFile: async (file, args, options) => {
    calls.push({ file, args, options });
    return { stdout: `/Library/Developer/CommandLineTools/usr/bin/${args[1]}\n`, stderr: "" };
  } };
  const resolved = await resolveXcrunTools({ allowedRoots: ["/Library/Developer/CommandLineTools"], runtime });
  assert.deepEqual(Object.keys(resolved), XCRUN_TOOL_NAMES);
  assert.equal(calls.every(call => !Object.hasOwn(call.options.env, "DEVELOPER_DIR") && !Object.hasOwn(call.options.env, "SDKROOT")), true);

  const hostile = { ...runtime, lstat: async path => path === "/Library/Developer"
    ? fakeEntry({ uid: 501, mode: 0o040755, type: "directory" }) : runtime.lstat(path) };
  await assert.rejects(resolveXcrunTools({ allowedRoots: ["/Library/Developer/CommandLineTools"], runtime: hostile }), /t1_path_writable/u);
  for (const tool of XCRUN_TOOL_NAMES) {
    const hostileTool = { ...runtime, lstat: async path => path.endsWith(`/bin/${tool}`)
      ? fakeEntry({ uid: 501 }) : runtime.lstat(path) };
    await assert.rejects(resolveXcrunTools({ allowedRoots: ["/Library/Developer/CommandLineTools"], runtime: hostileTool }),
      /t1_path_writable/u, tool);
  }
});

test("the current Mac resolves every xcrun shim to a root-owned developer tool", { skip: process.platform === "darwin" ? false : "macOS xcrun only" }, async () => {
  const result = await resolveDeveloperTools();
  assert.equal(result.developerDirectory.startsWith("/Library/Developer/"), true);
  assert.deepEqual(Object.keys(result.tools), XCRUN_TOOL_NAMES);
  for (const path of Object.values(result.tools)) assert.equal(path.startsWith(result.developerDirectory) || path.startsWith("/usr/bin/"), true);
});

test("spawn helper drops uid before sandbox-exec and cannot inherit a hostile environment", async t => {
  const createdRoot = await mkdtemp(join(tmpdir(), "acr-trusted-spawn-"));
  const installRoot = await realpath(createdRoot); t.after(() => cleanupRoot(installRoot));
  let observed;
  const runtime = { ...fakeRuntime(), spawn: (...args) => { observed = args; return { pid: 42 }; } };
  const profileParameters = buildServiceProfileParameters("builder", { installRoot, jobId: "one" });
  process.env.DEVELOPER_DIR = "/untrusted/Xcode.app";
  try {
    const child = await spawnTrusted({ role: "builder", executable: "/runtime/node/bin/node", args: ["--version"],
      profile: "/updater/policy/service-builder.sb", allowedRoots: ["/runtime", "/updater"], uid: 301, gid: 301,
      environment: { NODE_ENV: "production" }, profileParameters, inspectLibraries: async () => [] }, runtime);
    assert.equal(child.pid, 42);
  } finally { delete process.env.DEVELOPER_DIR; }
  assert.equal(observed[0], "/usr/bin/sandbox-exec");
  assert.deepEqual(observed[1].slice(-3), ["--", "/runtime/node/bin/node", "--version"]);
  assert.equal(observed[2].uid, 301); assert.equal(observed[2].gid, 301); assert.equal(observed[2].shell, false);
  assert.deepEqual(observed[2].env, { LANG: "C", LC_ALL: "C", NODE_ENV: "production",
    TMPDIR: join(installRoot, "build/job-one/tmp") });
  await assert.rejects(spawnTrusted({ role: "builder", executable: "/runtime/node/bin/node", args: [],
    profile: "/updater/policy/service-builder.sb", allowedRoots: ["/runtime", "/updater"], uid: 301, gid: 301,
    environment: { NODE_OPTIONS: "--require=/bad" }, profileParameters, inspectLibraries: async () => [] }, runtime),
  /trusted_spawn_environment_refused/u);
  await assert.rejects(spawnTrusted({ role: "builder", executable: "/runtime/node/bin/node", args: [],
    profile: "/updater/policy/service-builder.sb", allowedRoots: ["/runtime", "/updater"], uid: 301, gid: 301,
    profileParameters: [["JOB_ROOT", "/"]], inspectLibraries: async () => [] }, runtime),
  /trusted_spawn_input_invalid/u);
  await assert.rejects(spawnTrusted({ role: "builder", executable: "/runtime/node/bin/node", args: [],
    profile: "/updater/policy/service-builder.sb", allowedRoots: ["/runtime", "/updater"], uid: 301, gid: 301,
    environment: { TMPDIR: "/untrusted" }, profileParameters, inspectLibraries: async () => [] }, runtime),
  /trusted_spawn_environment_refused/u);
  for (const invalid of [{ environment: [] }, { explicitlySet: "TMPDIR" }]) {
    await assert.rejects(spawnTrusted({ role: "builder", executable: "/runtime/node/bin/node", args: [],
      profile: "/updater/policy/service-builder.sb", allowedRoots: ["/runtime", "/updater"], uid: 301, gid: 301,
      profileParameters, inspectLibraries: async () => [], ...invalid }, runtime), /trusted_spawn_environment_invalid/u);
  }
});

test("service profile parameters are role-bound and refuse non-canonical or global roots", async t => {
  const createdRoot = await mkdtemp(join(tmpdir(), "acr-profile-root-"));
  const installRoot = await realpath(createdRoot); t.after(() => cleanupRoot(installRoot));
  assert.deepEqual(buildServiceProfileParameters("postgres", { installRoot, dataId: "blue" }), [
    ["WORKING_DIRECTORY", join(installRoot, "pg/data-blue")], ["DATA_ROOT", join(installRoot, "pg/data-blue")],
    ["SOCKET_ROOT", join(installRoot, "pg/socket")],
    ["OUT_LOG", join(installRoot, "logs/postgres/out.log")], ["ERR_LOG", join(installRoot, "logs/postgres/err.log")],
    ["RUNTIME_ROOT", join(installRoot, "runtime")], ["RELEASE_ROOT", join(installRoot, "releases")],
    ["UPDATER_ROOT", join(installRoot, "updater")],
  ]);
  for (const installRoot of ["/", "/Users/owner/runtime", "/opt/homebrew/runtime", "/usr/local/runtime"])
    assert.throws(() => buildServiceProfileParameters("builder", { installRoot, jobId: "one" }),
      /trusted_spawn_profile_parameter_invalid/u);
  for (const jobId of ["", "../escape", "UPPER", "x".repeat(65)])
    assert.throws(() => buildServiceProfileParameters("builder", { installRoot, jobId }),
      /trusted_spawn_profile_parameter_invalid/u);
  const alias = join(dirname(installRoot), `${installRoot.split("/").at(-1)}-alias`);
  await symlink(installRoot, alias); t.after(() => rm(alias, { force: true }));
  assert.throws(() => buildServiceProfileParameters("builder", { installRoot: alias, jobId: "one" }),
    /trusted_spawn_profile_parameter_invalid/u);
});

const parametersFor = (role, root, workingDirectory) => [...({
  supervisor: [["WORKING_DIRECTORY", workingDirectory], ["RUNTIME_STATE", join(root, "state")], ["OUT_LOG", join(root, "out")], ["ERR_LOG", join(root, "err")]],
  gateway: [["WORKING_DIRECTORY", workingDirectory], ["RUNTIME_STATE", join(root, "state")], ["OUT_LOG", join(root, "out")], ["ERR_LOG", join(root, "err")]],
  postgres: [["WORKING_DIRECTORY", workingDirectory], ["DATA_ROOT", join(root, "data")], ["SOCKET_ROOT", join(root, "socket")], ["OUT_LOG", join(root, "out")], ["ERR_LOG", join(root, "err")]],
  builder: [["JOB_ROOT", join(root, "job")], ["TMPDIR", join(root, "job/tmp")], ["OUT_LOG", join(root, "out")], ["ERR_LOG", join(root, "err")]],
  upgrader: [["SCRATCH_ROOT", join(root, "scratch")], ["SOCKET_ROOT", join(root, "socket")], ["OUT_LOG", join(root, "out")], ["ERR_LOG", join(root, "err")]],
})[role], ["RUNTIME_ROOT", join(root, "runtime")], ["RELEASE_ROOT", join(root, "releases")],
  ["UPDATER_ROOT", join(root, "updater")]];

function launchdWorkingDirectories(root) {
  const account = (name, id) => ({ name, uid: id, gid: id, created: true });
  const accounts = { builder: account("_crbuild", 300), database: account("_crdb", 301),
    service: account("_controlroom", 302) };
  const protectedConfig = ["host.json", "local-owner-session.json", "fleet-gateway.json", "supervisor.json", "backup.json", "mac-local.json", "database-roles.json", "release-trust.json"]
    .map(name => ({ path: join(root, "Protected/config", name), contents: "{}\n", accountName: "_controlroom",
      groupName: "_controlroom", fileMode: "0600" }))
    .concat({ path: join(root, "updater-state/updater.json"), contents: "{}\n", accountName: "root",
      groupName: "wheel", fileMode: "0600" });
  const rendered = SERVICE_BATCH_ROLES_V1.flatMap(roles => composeServiceBundleV1({ root, accounts, roles,
    protectedConfig: roles === CORE_SERVICE_ROLES_V1 ? protectedConfig : [],
    pgRuntime: join(root, "runtime/pg-current/bin/postgres"), updaterVersion: "1.2.3-test" }).resources)
    .filter(resource => resource.kind === "launchd_plist");
  return new Map(rendered.map(resource => [resource.role,
    /<key>WorkingDirectory<\/key>\s*<string>([^<]+)<\/string>/u.exec(resource.contents)?.[1]]));
}

test("every service profile denies Homebrew, local and owner-home reads and bounds writes", async () => {
  for (const role of SERVICE_PROFILE_ROLES) {
    const source = await readFile(join(policyRoot, `service-${role}.sb`), "utf8");
    assert.match(source, /\(subpath "\/opt\/homebrew"\)/u, role);
    assert.match(source, /\(subpath "\/Users"\)/u, role);
    assert.match(source, /\(subpath "\/usr\/local"\)/u, role);
    assert.match(source, /\(literal "\/usr\/local\/bin\/control-room"\)/u, role);
    assert.match(source, /\(deny file-write\*/u, role);
    assert.match(source, /\(deny process-exec\* file-map-executable\)/u, role);
  }
  const builder = await readFile(join(policyRoot, "service-builder.sb"), "utf8");
  assert.match(builder, /\(allow file-map-executable \(subpath \(param "JOB_ROOT"\)\)\)/u);
});

test("macOS loads every service profile and denied trees fail closed at run time", { skip: process.platform === "darwin" ? false : "macOS Seatbelt only" }, async t => {
  const probe = spawnSync("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)", "/usr/bin/true"],
    { encoding: "utf8", env: {} });
  const nestedProfilesBlocked = probe.status === 71 && probe.stderr.includes("sandbox_apply: Operation not permitted");
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-service-profiles-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workingDirectories = launchdWorkingDirectories(root);
  await mkdir(join(root, "releases/v1"), { recursive: true });
  await mkdir(join(root, "pg/data-blue"), { recursive: true });
  await symlink("releases/v1", join(root, "current"));
  await symlink("data-blue", join(root, "pg/current"));
  for (const role of SERVICE_PROFILE_ROLES) {
    const launchdRole = ({ postgres: "postgresql17", supervisor: "supervisor", gateway: "fleet-gateway" })[role];
    const cwd = launchdRole ? workingDirectories.get(launchdRole) : root;
    assert.equal(typeof cwd, "string", `${role} launchd WorkingDirectory`);
    const parameters = parametersFor(role, root, cwd);
    const args = parameters.flatMap(([name, value]) => ["-D", `${name}=${value}`]);
    const profile = join(policyRoot, `service-${role}.sb`);
    const okay = spawnSync("/usr/bin/sandbox-exec", [...args, "-f", profile, "/usr/bin/true"],
      { cwd, encoding: "utf8", env: {} });
    if (nestedProfilesBlocked) {
      assert.equal(okay.status, 71, `${role} did not parse before sandbox_apply`);
      assert.match(okay.stderr, /sandbox_apply: Operation not permitted/u, role);
      continue;
    }
    assert.equal(okay.status, 0, `${role}: ${okay.stderr}`);
    for (const denied of [repositoryRoot, "/usr/local", "/opt/homebrew"]) {
      const result = spawnSync("/usr/bin/sandbox-exec", [...args, "-f", profile, "/bin/ls", denied], { encoding: "utf8", env: {} });
      assert.notEqual(result.status, 0, `${role} read ${denied}`);
    }
    const writableName = ({ supervisor: "RUNTIME_STATE", gateway: "RUNTIME_STATE", postgres: "DATA_ROOT",
      builder: "JOB_ROOT", upgrader: "SCRATCH_ROOT" })[role];
    const writable = parameters.find(([name]) => name === writableName)[1];
    await mkdir(writable, { recursive: true });
    const allowed = spawnSync("/usr/bin/sandbox-exec", [...args, "-f", profile, "/usr/bin/touch", join(writable, `seatbelt-${role}`)],
      { encoding: "utf8", env: {} });
    assert.equal(allowed.status, 0, `${role} allowed write: ${allowed.stderr}`);
    const blocked = spawnSync("/usr/bin/sandbox-exec", [...args, "-f", profile, "/usr/bin/touch", join(dirname(root), `seatbelt-${role}-outside`)],
      { encoding: "utf8", env: {} });
    assert.notEqual(blocked.status, 0, `${role} outside write`);
    const untrustedExecutable = join(root, `untrusted-${role}`);
    await copyFile("/bin/echo", untrustedExecutable); await chmod(untrustedExecutable, 0o755);
    const execution = spawnSync("/usr/bin/sandbox-exec", [...args, "-f", profile, untrustedExecutable, "ran"],
      { encoding: "utf8", env: {} });
    assert.notEqual(execution.status, 0, `${role} executed from an unlisted tree`);
  }
  if (nestedProfilesBlocked) return t.skip("profiles parsed; the calling sandbox forbids their run-time application");

  const builderParameters = parametersFor("builder", root), builderArgs = builderParameters
    .flatMap(([name, value]) => ["-D", `${name}=${value}`]);
  const builderProfile = join(policyRoot, "service-builder.sb"), release = join(root, "releases/v1");
  await mkdir(release, { recursive: true });
  const binarySource = join(root, "probe.c"), binary = join(release, "probe");
  await writeFile(binarySource, "int main(void) { return 0; }\n");
  const clangPath = spawnSync("/usr/bin/xcrun", ["--find", "clang"], { encoding: "utf8", env: {} }).stdout.trim();
  const sdkRoot = spawnSync("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"],
    { encoding: "utf8", env: {} }).stdout.trim();
  assert.match(sdkRoot, /^\/[^\0\r\n]+$/u);
  const compiled = spawnSync(clangPath, ["-isysroot", sdkRoot, binarySource, "-o", binary], { encoding: "utf8", env: {} });
  assert.equal(compiled.status, 0, compiled.stderr);
  const throughPointer = spawnSync("/usr/bin/sandbox-exec", [...builderArgs, "-f", builderProfile,
    join(root, "current/probe")], { encoding: "utf8", env: {} });
  assert.equal(throughPointer.status, 0, throughPointer.stderr);

  const job = join(root, "job"), runtimeNode = join(root, "runtime/node");
  await mkdir(job, { recursive: true }); await mkdir(dirname(runtimeNode), { recursive: true });
  await copyFile(process.execPath, runtimeNode); await chmod(runtimeNode, 0o755);
  const addonSource = join(job, "addon.c"), addon = join(job, "addon.node");
  await writeFile(addonSource, [
    "typedef struct napi_env__* napi_env;", "typedef struct napi_value__* napi_value;",
    "__attribute__((visibility(\"default\"))) napi_value napi_register_module_v1(napi_env env, napi_value exports) {",
    "  (void)env; return exports;", "}", "",
  ].join("\n"));
  const addonBuild = spawnSync(clangPath, ["-isysroot", sdkRoot, "-bundle", "-undefined", "dynamic_lookup", addonSource, "-o", addon],
    { encoding: "utf8", env: {} });
  assert.equal(addonBuild.status, 0, addonBuild.stderr);
  const addonLoad = spawnSync("/usr/bin/sandbox-exec", [...builderArgs, "-f", builderProfile, runtimeNode,
    "--input-type=module", "--eval", "process.dlopen({exports:{}}, process.argv[1])", addon],
  { cwd: job, encoding: "utf8", env: {} });
  assert.equal(addonLoad.status, 0, addonLoad.stderr);
});

async function fixtureArchives(root) {
  const source = join(root, "source"), trees = join(root, "trees");
  await mkdir(source); await mkdir(trees);
  const definitions = [
    { tool: "node", archiveName: "node.tgz", executableRelativePath: "bin/node", archiveRoot: "node-v1.2.3", archiveFile: "node-v1.2.3/bin/node" },
    { tool: "pnpm", archiveName: "pnpm.tgz", executableRelativePath: "pnpm", archiveRoot: ".", archiveFile: "pnpm" },
    { tool: "esbuild", archiveName: "esbuild.tgz", executableRelativePath: "esbuild", archiveRoot: ".", archiveFile: "package/bin/esbuild" },
  ];
  const artifacts = [];
  for (const definition of definitions) {
    const tree = join(trees, definition.tool), file = join(tree, definition.archiveFile);
    await mkdir(dirname(file), { recursive: true });
    const body = `#!/bin/sh\nprintf '${definition.tool} 1.2.3\\n'\n`;
    await writeFile(file, body, { mode: 0o755 }); await chmod(file, 0o755);
    if (definition.tool === "node") {
      await mkdir(join(tree, "node-v1.2.3/lib"), { recursive: true });
      await writeFile(join(tree, "node-v1.2.3/lib/config.json"), "{\"trusted\":true}\n");
      await symlink("config.json", join(tree, "node-v1.2.3/lib/config-link"));
    }
    const archive = join(source, definition.archiveName);
    const tarArgs = definition.archiveRoot === "." ? ["-czf", archive, "-C", tree, definition.archiveFile.split("/")[0]]
      : ["-czf", archive, "-C", tree, definition.archiveRoot];
    const packed = spawnSync("/usr/bin/tar", tarArgs, { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    artifacts.push({ tool: definition.tool, version: "1.2.3", linkBase: definition.tool,
      archiveName: definition.archiveName, url: `https://example.invalid/${definition.archiveName}`,
      archiveSha256: digest(await readFile(archive)), archiveBytes: (await lstat(archive)).size,
      extraction: definition.tool === "node" ? "tar-gz-strip-1"
        : definition.tool === "pnpm" ? "tar-gz" : "npm-tgz-bin-esbuild",
      executableRelativePath: definition.executableRelativePath, executableSha256: digest(Buffer.from(body)),
      publisherProof: { kind: "none" } });
  }
  artifacts.push({ tool: "postgresql", version: "17.11", linkBase: "pg", archiveName: "postgresql-17.11-4-osx-binaries.zip",
    url: "https://example.invalid/postgresql.zip", archiveSha256: "1".repeat(64), archiveBytes: 1,
    extraction: "edb-zip-allowlist-v1", executableRelativePath: "bin/postgres", executableSha256: "2".repeat(64),
    // Finding 9 made the Team Identifier and a developer-id proof REQUIRED for
    // PostgreSQL. The digests above are placeholders, so nothing here is a real
    // publisher check — the fields are present because the inventory validator
    // refuses an artifact without them, and this fixture must describe the
    // inventory as it is now rather than as it was before the finding.
    teamIdentifier: "26QKX55P9K",
    publisherProof: { kind: "developer-id", teamIdentifier: "26QKX55P9K",
      identifier: "com.edb.postgresql", measured: "fixture" },
    provenance: { etag: null, lastModified: null } });
  return { source, manifest: { schema: TRUSTED_RUNTIME_MANIFEST_SCHEMA, platform: "darwin", architecture: "arm64", artifacts } };
}

test("vendor step verifies bytes, emits a per-file manifest and seals the complete runtime", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-vendor-")); t.after(() => cleanupRoot(root));
  const fixture = await fixtureArchives(root), destination = join(root, "install/runtime");
  const result = await vendorTrustedRuntime({ ...fixture, sourceDirectory: fixture.source, runtimeDirectory: destination });
  assert.ok(result.fileCount > 3);
  const installed = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  assert.equal(installed.schema, "control-room.installed-trusted-runtime/v1");
  assert.deepEqual(Object.keys(installed.installed), ["node", "pnpm", "esbuild"]);
  await verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime());
  for (const tool of ["node", "pnpm", "esbuild"]) {
    const executable = join(destination, installed.installed[tool].executable);
    assert.equal((await lstat(executable)).mode & 0o777, 0o555);
    assert.equal(spawnSync(executable, [], { encoding: "utf8", env: {} }).stdout.trim(), `${tool} 1.2.3`);
  }
  assert.equal((await lstat(destination)).mode & 0o777, 0o555);
});

test("the installation checker verifies every inventoried byte, size, mode and path before runtime use", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-inventory-")); t.after(() => cleanupRoot(root));
  const fixture = await fixtureArchives(root), destination = join(root, "install/runtime");
  await vendorTrustedRuntime({ ...fixture, sourceDirectory: fixture.source, runtimeDirectory: destination });
  const installed = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  const config = join(destination, "node-1.2.3/lib/config.json");
  const wrongSize = structuredClone(installed.files);
  wrongSize.find(entry => entry.path === "node-1.2.3/lib/config.json").bytes += 1;
  await assert.rejects(verifyInstalledFileInventory(destination, wrongSize, rootMetadataRuntime()), /trusted_runtime_inventory_mismatch/u);

  await chmod(config, 0o644);
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime()), /trusted_runtime_inventory_mismatch/u);
  await writeFile(config, "{\"trusted\":null}\n"); await chmod(config, 0o444);
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime()), /trusted_runtime_inventory_mismatch/u);
  await assert.rejects(verifyTrustedRuntimeInstallation({ runtimeDirectory: destination,
    manifestPolicy: fixture.manifest,
    initPolicy: { schema: "control-room.trusted-runtime-init-config/v1", tools: {
      node: { files: [] }, pnpm: { files: [] }, esbuild: { files: [] },
    } },
  }), /trusted_runtime_inventory_mismatch/u);

  await chmod(config, 0o644); await writeFile(config, "larger attacker-controlled content\n"); await chmod(config, 0o444);
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime()), /trusted_runtime_inventory_mismatch/u);
  await chmod(config, 0o644); await writeFile(config, "{\"trusted\":true}\n"); await chmod(config, 0o444);
  const library = dirname(config); await chmod(library, 0o755);
  const configLink = join(library, "config-link"); await rm(configLink); await symlink("../bin/node", configLink);
  await chmod(library, 0o555);
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime()), /trusted_runtime_inventory_mismatch/u);
  await chmod(library, 0o755); await rm(configLink); await symlink("config.json", configLink);
  await writeFile(join(library, "unlisted.js"), "untrusted\n", { mode: 0o444 }); await chmod(library, 0o555);
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime()), /trusted_runtime_inventory_mismatch/u);
});

test("vendor step is fail-closed for corruption, interruption, retry and concurrent callers", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-vendor-stress-")); t.after(() => cleanupRoot(root));
  const fixture = await fixtureArchives(root);
  const missing = structuredClone(fixture.manifest);
  missing.artifacts[0].archiveName = "missing.tgz";
  await assert.rejects(vendorTrustedRuntime({ sourceDirectory: fixture.source, manifest: missing,
    runtimeDirectory: join(root, "missing") }), /runtime_vendor_archive_missing/u);
  const wrongExecutable = structuredClone(fixture.manifest);
  wrongExecutable.artifacts[0].executableSha256 = "0".repeat(64);
  await assert.rejects(vendorTrustedRuntime({ sourceDirectory: fixture.source, manifest: wrongExecutable,
    runtimeDirectory: join(root, "wrong-executable") }), /trusted_runtime_digest_mismatch/u);
  await writeFile(join(fixture.source, "node.tgz"), "corrupt");
  await assert.rejects(vendorTrustedRuntime({ ...fixture, sourceDirectory: fixture.source, runtimeDirectory: join(root, "bad") }),
    /trusted_runtime_digest_mismatch/u);
  await rm(fixture.source, { recursive: true });
  await mkdir(join(root, "retry"));
  const restored = await fixtureArchives(join(root, "retry"));
  const halfway = join(root, "halfway");
  await assert.rejects(vendorTrustedRuntime({ ...restored, sourceDirectory: restored.source, runtimeDirectory: halfway }, {
    afterArtifact: tool => { if (tool === "node") throw new Error("injected_stop"); },
  }), /injected_stop/u);
  await assert.rejects(lstat(halfway), error => error?.code === "ENOENT");
  await vendorTrustedRuntime({ ...restored, sourceDirectory: restored.source, runtimeDirectory: halfway });
  let existingDestinationWork = false;
  await assert.rejects(vendorTrustedRuntime({ ...restored, sourceDirectory: restored.source, runtimeDirectory: halfway }, {
    afterArtifact: () => { existingDestinationWork = true; },
  }),
    /runtime_vendor_destination_exists/u);
  assert.equal(existingDestinationWork, false);

  const destinations = Array.from({ length: 20 }, (_, index) => join(root, `parallel-${index}`));
  await Promise.all(destinations.map(runtimeDirectory => vendorTrustedRuntime({ ...restored,
    sourceDirectory: restored.source, runtimeDirectory })));
  const one = join(root, "one-winner");
  const burst = await Promise.allSettled(Array.from({ length: 20 }, () => vendorTrustedRuntime({ ...restored,
    sourceDirectory: restored.source, runtimeDirectory: one })));
  assert.equal(burst.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(burst.filter(result => result.status === "rejected").length, 19);
  for (const result of burst.filter(result => result.status === "rejected")) {
    assert.match(String(result.reason), /runtime_vendor_destination_exists/u);
  }
  assert.deepEqual((await readdir(root)).filter(name => name.startsWith(".runtime-stage-")), []);
});

test("vendor snapshots an owner archive once and ignores a later source swap", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-vendor-snapshot-")); t.after(() => cleanupRoot(root));
  const fixture = await fixtureArchives(root), destination = join(root, "runtime");
  await vendorTrustedRuntime({ ...fixture, sourceDirectory: fixture.source, runtimeDirectory: destination }, {
    afterArchiveSnapshot: async tool => { if (tool === "node") await writeFile(join(fixture.source, "node.tgz"), "swapped"); },
  });
  const installed = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  await verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime());
});

test("vendor extraction normalizes ownership, ACLs and flags before sealing", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-vendor-metadata-")); t.after(() => cleanupRoot(root));
  const fixture = await fixtureArchives(root), destination = join(root, "runtime"), commands = [], ownership = [];
  await vendorTrustedRuntime({ ...fixture, sourceDirectory: fixture.source, runtimeDirectory: destination }, {
    observeCommand: async (file, args) => { commands.push([file, args]); },
    lchown: async (...args) => { ownership.push(args); await lchown(...args); },
  });
  const extractions = commands.filter(([file, args]) => file === "/usr/bin/tar" && args[0] === "-xzf");
  assert.equal(extractions.length, 3);
  for (const [, args] of extractions) {
    assert(args.includes("--no-same-owner"));
    assert(args.includes("--no-same-permissions"));
  }
  if (process.platform === "darwin") {
    assert(commands.some(([file, args]) => file === "/usr/bin/chflags" && args[0] === "-R" && args[1] === "0"));
    assert(commands.some(([file, args]) => file === "/bin/chmod" && args[0] === "-RN"));
  }
  assert(ownership.some(([path]) => path.endsWith("/node-1.2.3/lib/config-link")));
  assert(ownership.some(([path]) => path.endsWith("/manifest.json")));
});

test("otool is T1-checked before it can inspect another executable", async () => {
  const toolRoot = "/Library/Developer/CommandLineTools", entries = {
    "/Library": fakeEntry({ mode: 0o040755, type: "directory" }),
    "/Library/Developer": fakeEntry({ mode: 0o040755, type: "directory" }),
    [toolRoot]: fakeEntry({ mode: 0o040755, type: "directory" }),
    [`${toolRoot}/usr`]: fakeEntry({ mode: 0o040755, type: "directory" }),
    [`${toolRoot}/usr/bin`]: fakeEntry({ mode: 0o040755, type: "directory" }),
  };
  for (const tool of XCRUN_TOOL_NAMES) entries[`${toolRoot}/usr/bin/${tool}`] = fakeEntry({ uid: tool === "otool" ? 501 : 0 });
  const inspections = [], runtime = { ...fakeRuntime(entries), execFile: async (file, args) => {
    if (file === "/usr/bin/xcrun") return { stdout: `${toolRoot}/usr/bin/${args[1]}\n`, stderr: "" };
    inspections.push([file, args]);
    return { stdout: `${args[1]}:\n`, stderr: "" };
  } };
  await assert.rejects(resolveXcrunTools({ allowedRoots: [toolRoot], runtime }), /t1_path_writable/u);
  assert.deepEqual(inspections, []);
});

test("inventory verification refuses non-root ownership, ACLs and flags on any entry", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-metadata-")); t.after(() => cleanupRoot(root));
  const fixture = await fixtureArchives(root), destination = join(root, "runtime");
  await vendorTrustedRuntime({ ...fixture, sourceDirectory: fixture.source, runtimeDirectory: destination });
  const installed = JSON.parse(await readFile(join(destination, "manifest.json"), "utf8"));
  const actual = await lstat(destination);
  const fakeStat = { uid: 12345, gid: 12345, mode: actual.mode, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false };
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime({
    lstat: async path => path === destination ? fakeStat : rootMetadataRuntime().lstat(path),
  })), /trusted_runtime_inventory_mismatch/u);
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime({
    inspectAcl: async path => path.endsWith("config.json") ? ["0: group:staff allow writesecurity"] : [],
  })), /trusted_runtime_inventory_mismatch/u);
  await assert.rejects(verifyInstalledFileInventory(destination, installed.files, rootMetadataRuntime({
    inspectFlags: async path => path.endsWith("config.json") ? "uchg" : "-",
  })), /trusted_runtime_inventory_mismatch/u);
});

test("real-root rehearsal asserts uid 0 gid 0 with no ACLs or flags", {
  skip: (process.geteuid?.() ?? -1) === 0 ? false : "real root only",
}, async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-runtime-root-rehearsal-")); t.after(() => cleanupRoot(root));
  const fixture = await fixtureArchives(root), destination = join(root, "runtime");
  await vendorTrustedRuntime({ ...fixture, sourceDirectory: fixture.source, runtimeDirectory: destination }, { realRootRehearsal: true });
  const result = await assertRuntimeTreeRootMetadataV1(destination);
  assert(result.entries > 3);
});

test("the owner-home audit lists every production source that reads an owner home", async () => {
  const roots = ["src", "scripts"], productionFiles = [];
  const visit = async localDirectory => {
    for (const entry of await readdir(join(repositoryRoot, localDirectory), { withFileTypes: true })) {
      const local = `${localDirectory}/${entry.name}`;
      if (entry.isDirectory()) await visit(local);
      else if (/\.(?:[cm]?[jt]sx?|mjs)$/u.test(entry.name)) {
        const source = await readFile(join(repositoryRoot, local), "utf8");
        if (/process\.env\.HOME|\bhomedir\s*\(|\bos\.homedir\s*\(/u.test(source)) productionFiles.push(local);
      }
    }
  };
  for (const root of roots) await visit(root);
  const audit = await readFile(join(repositoryRoot, "docs/UPDATER_TRUSTED_RUNTIME_OWNER_HOME_AUDIT.md"), "utf8");
  const missing = productionFiles.sort().filter(path => !audit.includes(`\`${path}\``));
  assert.deepEqual(missing, [], `owner-home audit is missing: ${missing.join(", ")}`);
});
