import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats, Stats } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, symlink, unlink,
  writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { mock, type TestContext } from "node:test";
import { createPrivateInstalledConfigurationCustodyV1, PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1 } from
  "../src/installer/v1/private-installed-configuration-custody";
import { createPrivateInstalledConfigurationNativeHostV1, PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1,
  PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1 } from
  "../src/installer/v1/private-installed-configuration-native-host";
import { canonicalJson } from "../src/security/canonical-digest";

const run = promisify(execFile);
const macosTest = process.platform === "darwin" ? test : test.skip;
const digest = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const source = new URL("../native/installed-configuration-v1.c", import.meta.url);
const faultSource = new URL("helpers/installed-configuration-native-faults.c", import.meta.url);
const flags = ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-Wconversion", "-Wshadow", "-Wstrict-prototypes",
  "-fstack-protector-strong", "-D_FORTIFY_SOURCE=2", "-mmacosx-version-min=13.0"];

async function compile(output: string, input = source, additions: string[] = []) {
  const environment = { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", TMPDIR: await realpath(tmpdir()), NODE_ENV: "test" as const };
  const sdk = (await run("/usr/bin/xcrun", ["--sdk", "macosx", "--show-sdk-path"],
    { env: environment })).stdout.trim();
  await run("/usr/bin/clang", [...flags, ...additions, "-isysroot", sdk, input.pathname, "-o", output],
    { env: environment });
  await chmod(output, 0o500);
}
function baseFrame(operation: 1 | 2, deadline: number, values: { path?: string; kind?: number; device?: number;
  inode?: number; mode?: number; configuration?: Buffer; manifest?: Buffer; installation?: string } = {}) {
  const path = Buffer.from(values.path ?? ""), installation = Buffer.from(values.installation ?? "local-hermes"),
    configuration = values.configuration ?? Buffer.alloc(0), manifest = values.manifest ?? Buffer.alloc(0), header = Buffer.alloc(72);
  header.write("ACRCFG1\n", "ascii"); header[8] = operation; header[9] = values.kind ?? 0;
  header.writeUInt32BE(path.length, 16); header.writeUInt32BE(installation.length, 20);
  header.writeUInt32BE(configuration.length, 24); header.writeUInt32BE(manifest.length, 28);
  header.writeBigUInt64BE(BigInt(values.device ?? 0), 32); header.writeBigUInt64BE(BigInt(values.inode ?? 0), 40);
  header.writeBigUInt64BE(BigInt(process.geteuid!()), 48); header.writeBigUInt64BE(BigInt(deadline), 56);
  header.writeUInt32BE(values.mode ?? 0, 64);
  return Buffer.concat([header, path, installation, Buffer.from(`sha256:${"1".repeat(64)}`),
    Buffer.from(`sha256:${"2".repeat(64)}`), configuration, manifest]);
}
function invoke(executable: string, input: Buffer, descriptor?: number) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = spawn(executable, [], { shell: false, cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", NODE_ENV: "test" },
      stdio: ["pipe", "pipe", "pipe", descriptor === undefined ? "ignore" : descriptor] });
    const stdin = child.stdin, stdoutStream = child.stdout, stderrStream = child.stderr;
    if (!stdin || !stdoutStream || !stderrStream) { child.kill(); reject(new Error("native_helper_pipes_unavailable")); return; }
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    stdoutStream.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    stderrStream.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject); child.on("close", (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal,
      stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })); stdin.end(input);
  });
}
async function disposableRoot(t: TestContext) {
  const root = await realpath(await mkdtemp("/private/tmp/acr-installed-configuration-native-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const logicalProtectedRoot = "/Users/native-test/Library/Application Support/Agent Control Room/Protected";
async function preparePublicationParent(root: string) {
  const parent = join(root, "Users", "native-test", "Library", "Application Support", "Agent Control Room");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  for (let current = parent; current.startsWith(root); current = join(current, "..")) {
    await chmod(current, 0o700); if (current === root) break;
    current = await realpath(current);
  }
  return parent;
}
function hostInput(executablePath: string,
  configuration: Uint8Array = Uint8Array.from(Buffer.from("private-configuration\n")),
  manifest: Uint8Array = Uint8Array.from(Buffer.from("private-manifest\n"))) {
  const configurationBytes = Buffer.isBuffer(configuration) ? Uint8Array.from(configuration) : configuration;
  const manifestBytes = Buffer.isBuffer(manifest) ? Uint8Array.from(manifest) : manifest;
  return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_HOST_V1, executablePath,
    executableSha256: digest(requireBytes(executablePath)), installationId: "local-hermes",
    releaseDigest: `sha256:${"1".repeat(64)}`, planDigest: `sha256:${"2".repeat(64)}`,
    rootPath: logicalProtectedRoot,
    expectedOwnerUid: process.geteuid!(), configurationBytes, configurationSha256: digest(configurationBytes),
    manifestBytes, manifestSha256: digest(manifestBytes) };
}
function requireBytes(path: string): Buffer {
  const bytes = (requireBytes as unknown as { cache?: Map<string, Buffer> }).cache?.get(path);
  if (!bytes) throw new Error("test executable bytes missing"); return bytes;
}
async function rememberExecutable(path: string) {
  const holder = requireBytes as unknown as { cache?: Map<string, Buffer> };
  holder.cache ??= new Map(); holder.cache.set(path, await readFile(path));
}
function processAbsent(pid: number) {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function nativeRequest(kind: "ancestor" | "manifest" | "configuration" | "journal", descriptor: number,
  stat: Stats | BigIntStats, signal = new AbortController().signal) {
  const safeNumber = (value: number | bigint): number => {
    if (typeof value === "number") return value;
    const converted = Number(value);
    if (!Number.isSafeInteger(converted) || BigInt(converted) !== value) throw new Error("filesystem_identity_not_safely_representable");
    return converted;
  };
  return { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_CUSTODY_V1, kind, descriptor,
    identity: { device: safeNumber(stat.dev), inode: safeNumber(stat.ino), ownerUid: safeNumber(stat.uid),
      mode: safeNumber(stat.mode) & 0o7777, size: safeNumber(stat.size), linkCount: safeNumber(stat.nlink),
      modifiedMs: safeNumber(stat.mtimeMs), changedMs: safeNumber(stat.ctimeMs) }, signal };
}

macosTest("native publication makes one complete protected root visible and never replaces it", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable, source, [`-DACR_TEST_ROOT_PREFIX=\"${root}\"`]);
  const parent = await preparePublicationParent(root);
  const protectedRoot = join(parent, "Protected"), configuration = Buffer.from("private-configuration\n"),
    manifest = Buffer.from("private-manifest\n");
  for (const installation of ["ab", "a".repeat(64)]) {
    const refused = await invoke(executable, baseFrame(1, Date.now() + 5_000,
      { path: logicalProtectedRoot, installation, configuration, manifest }));
    assert.notEqual(refused.code, 0); assert.deepEqual(await readdir(parent), []);
  }
  const first = await invoke(executable, baseFrame(1, Date.now() + 5_000,
    { path: logicalProtectedRoot, installation: "7", configuration, manifest }));
  assert.equal(first.code, 0);
  assert.equal(first.signal, null); assert.equal(first.stderr.length, 0);
  assert.match(first.stdout.toString("ascii"), /^ACRCFG1 P /u);
  assert.deepEqual((await readdir(protectedRoot)).sort(), ["installation-journal", "installed-manifest.json", "operator.json"]);
  assert.deepEqual(await readFile(join(protectedRoot, "operator.json")), configuration);
  assert.deepEqual(await readFile(join(protectedRoot, "installed-manifest.json")), manifest);
  assert.equal((await lstat(protectedRoot)).mode & 0o7777, 0o700);
  assert.equal((await lstat(join(protectedRoot, "operator.json"))).mode & 0o7777, 0o600);
  assert.equal((await lstat(join(protectedRoot, "installed-manifest.json"))).mode & 0o7777, 0o600);
  assert.equal((await lstat(join(protectedRoot, "installation-journal"))).mode & 0o7777, 0o700);
  const second = await invoke(executable, baseFrame(1, Date.now() + 5_000,
    { path: logicalProtectedRoot, configuration: Buffer.from("replacement"), manifest }));
  assert.notEqual(second.code, 0); assert.deepEqual(await readFile(join(protectedRoot, "operator.json")), configuration);
  assert.equal((await readdir(parent)).includes(".Protected.acr-new"), false);
});

macosTest("native publication refuses unsafe ancestors and link substitution without a partial final root", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable, source, [`-DACR_TEST_ROOT_PREFIX=\"${root}\"`]);
  const applicationSupport = join(root, "Users", "native-test", "Library", "Application Support");
  await mkdir(applicationSupport, { recursive: true, mode: 0o700 });
  for (const path of [root, join(root, "Users"), join(root, "Users", "native-test"), join(root, "Users", "native-test", "Library"), applicationSupport])
    await chmod(path, 0o700);
  const foreign = join(root, "foreign"), agentRoot = join(applicationSupport, "Agent Control Room");
  await mkdir(foreign, { mode: 0o700 }); await symlink(foreign, agentRoot);
  const protectedRoot = join(agentRoot, "Protected");
  const result = await invoke(executable, baseFrame(1, Date.now() + 5_000,
    { path: logicalProtectedRoot, configuration: Buffer.from("configuration"), manifest: Buffer.from("manifest") }));
  assert.notEqual(result.code, 0); assert.equal(await lstat(foreign).then(stat => stat.isDirectory()), true);
  assert.deepEqual(await readdir(foreign), []);
  await unlink(agentRoot); await mkdir(agentRoot, { mode: 0o700 });
  await run("/bin/chmod", ["+a", "everyone allow readattr", agentRoot]);
  const aclResult = await invoke(executable, baseFrame(1, Date.now() + 5_000,
    { path: logicalProtectedRoot, configuration: Buffer.from("configuration"), manifest: Buffer.from("manifest") }));
  assert.notEqual(aclResult.code, 0); assert.deepEqual(await readdir(agentRoot), []);
});

macosTest("Node host rejects proxied byte arrays and accessors without invoking getters", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable); await rememberExecutable(executable);
  const valid = hostInput(executable), proxied = new Proxy(new Uint8Array([1]), {});
  assert.throws(() => createPrivateInstalledConfigurationNativeHostV1({ ...valid,
    configurationBytes: proxied, configurationSha256: digest(new Uint8Array([1])) }),
  { message: "private_installed_configuration_native_host_refused" });
  let getterCalls = 0; const accessor = { ...valid } as Record<string, unknown>;
  Object.defineProperty(accessor, "manifestBytes", { enumerable: true, get() { getterCalls++; return valid.manifestBytes; } });
  assert.throws(() => createPrivateInstalledConfigurationNativeHostV1(accessor),
    { message: "private_installed_configuration_native_host_refused" });
  assert.equal(getterCalls, 0);
});

macosTest("Node host publishes through the real helper and custody rereads the complete root", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable, source, [`-DACR_TEST_ROOT_PREFIX=\"${root}\"`]); await rememberExecutable(executable);
  const parent = await preparePublicationParent(root), protectedRoot = join(parent, "Protected");
  await run("/bin/chmod", ["+a", "everyone deny delete", parent]);
  t.after(() => run("/bin/chmod", ["-N", parent]).catch(() => undefined));
  const configurationOriginal = Buffer.from(`${canonicalJson({ nested: { permitted: true }, value: "private-data" })}\n`);
  const manifestOriginal = Buffer.from(`${canonicalJson({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
    installationId: "local-hermes", ownerUid: process.geteuid!(),
    configuration: { name: "operator.json", bytes: configurationOriginal.length, sha256: digest(configurationOriginal) },
    journal: { directoryName: "installation-journal" } })}\n`);
  const configurationInput = Uint8Array.from(configurationOriginal), manifestInput = Uint8Array.from(manifestOriginal);
  const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable, configurationInput, manifestInput));
  configurationInput.fill(0x78); manifestInput.fill(0x79);
  assert.deepEqual(host.inspectReadiness(), { state: "ready", staged: false, publicationAvailable: true,
    unresolvedHelperProcesses: 0, unresolvedProcessGroups: 0 });
  const originalSpawn = childProcess.spawn, pids: number[] = [];
  const hook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = originalSpawn(...args);
    if (args[0].startsWith("/private/tmp/acr-installed-configuration-native-") && child.pid) pids.push(child.pid);
    return child;
  });
  syncBuiltinESMExports();
  try {
    const receipt = await host.publish({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
      deadlineUnixMs: Date.now() + 5_000, signal: new AbortController().signal });
    assert.equal(receipt.outcome, "published");
    assert.deepEqual(await readFile(join(protectedRoot, "operator.json")), configurationOriginal);
    assert.deepEqual(await readFile(join(protectedRoot, "installed-manifest.json")), manifestOriginal);
    const parentHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const parentStat = await parentHandle.stat();
      const verified = await host.verifyProtectedPath(nativeRequest("ancestor", parentHandle.fd, parentStat)) as any;
      assert.equal(verified.extendedAcl, true);
    } finally { await parentHandle.close(); }
    const rootHandle = await open(protectedRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const rootStat = await rootHandle.stat();
      const verified = await host.verifyProtectedPath(nativeRequest("ancestor", rootHandle.fd, rootStat)) as any;
      assert.equal(verified.extendedAcl, false);
    } finally { await rootHandle.close(); }
    const native = Object.freeze({ verifyProtectedPath: (request: any) => host.verifyProtectedPath(request) });
    const custody = await createPrivateInstalledConfigurationCustodyV1({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
      manifestPath: join(protectedRoot, "installed-manifest.json"), manifestBytes: manifestOriginal.length,
      manifestSha256: digest(manifestOriginal), expectedOwnerUid: process.geteuid!(), verificationDeadlineMs: 2_000, native });
    assert.equal(custody.status, "configuration_ready");
    if (custody.status === "configuration_ready") assert.deepEqual(await custody.custody.loadPrivateConfigurationData(),
      { nested: { permitted: true }, value: "private-data" });
    assert.deepEqual(host.inspectReadiness(), { state: "ready", staged: true, publicationAvailable: false,
      unresolvedHelperProcesses: 0, unresolvedProcessGroups: 0 });
    for (const pid of pids) {
      assert.throws(() => process.kill(pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
      assert.throws(() => process.kill(-pid, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
    }
    assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
    await run("/bin/chmod", ["-N", parent]);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

macosTest("Node host verifies the exact held descriptor and refuses mode, link and ACL drift", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable); await rememberExecutable(executable);
  const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable));
  const file = join(root, "operator.json"); await import("node:fs/promises").then(fs => fs.writeFile(file, "data\n", { mode: 0o600 }));
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat(), verified = await host.verifyProtectedPath(nativeRequest("configuration", handle.fd, stat)) as any;
    assert.equal(verified.outcome, "verified"); assert.equal(verified.device, stat.dev); assert.equal(verified.inode, stat.ino);
    await chmod(file, 0o644);
    await assert.rejects(host.verifyProtectedPath(nativeRequest("configuration", handle.fd, await handle.stat())),
      { message: "private_installed_configuration_native_host_refused" });
    await chmod(file, 0o600); const other = join(root, "hard-link"); await link(file, other);
    await assert.rejects(host.verifyProtectedPath(nativeRequest("configuration", handle.fd, await handle.stat())),
      { message: "private_installed_configuration_native_host_refused" });
    await unlink(other); await run("/bin/chmod", ["+a", "everyone allow readattr", file]);
    await assert.rejects(host.verifyProtectedPath(nativeRequest("configuration", handle.fd, await handle.stat())),
      { message: "private_installed_configuration_native_host_uncertain" });
    await run("/bin/chmod", ["-N", file]);
  } finally { await handle.close(); }
  const controller = new AbortController(); assert.deepEqual(await host.cleanup(controller.signal), { outcome: "confirmed" });
});

macosTest("existing custody reader loads exact canonical data through the real descriptor host", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable); await rememberExecutable(executable);
  const custodyRoot = join(root, "custody"); await mkdir(custodyRoot, { mode: 0o700 });
  const configuration = Buffer.from(`${canonicalJson({ nested: { permitted: true }, value: "private-data" })}\n`);
  await import("node:fs/promises").then(fs => fs.writeFile(join(custodyRoot, "operator.json"), configuration, { mode: 0o600 }));
  await mkdir(join(custodyRoot, "installation-journal"), { mode: 0o700 });
  const manifest = Buffer.from(`${canonicalJson({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
    installationId: "local-hermes", ownerUid: process.geteuid!(),
    configuration: { name: "operator.json", bytes: configuration.length, sha256: digest(configuration) },
    journal: { directoryName: "installation-journal" } })}\n`);
  const manifestPath = join(custodyRoot, "installed-manifest.json");
  await import("node:fs/promises").then(fs => fs.writeFile(manifestPath, manifest, { mode: 0o600 }));
  const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable, configuration, manifest));
  const native = Object.freeze({ verifyProtectedPath: (request: any) => host.verifyProtectedPath(request) });
  const custody = await createPrivateInstalledConfigurationCustodyV1({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
    manifestPath, manifestBytes: manifest.length, manifestSha256: digest(manifest), expectedOwnerUid: process.geteuid!(),
    verificationDeadlineMs: 2_000, native });
  assert.equal(custody.status, "configuration_ready");
  if (custody.status === "configuration_ready") assert.deepEqual(await custody.custody.loadPrivateConfigurationData(),
    { nested: { permitted: true }, value: "private-data" });
  assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
});

macosTest("Node host bounds malformed output, stderr, crash, hang and surviving process groups", async t => {
  const root = await disposableRoot(t);
  for (const mode of [1, 2, 3, 4, 5]) {
    const executable = join(root, `fault-${mode}`); await compile(executable, faultSource, [`-DFAULT_MODE=${mode}`]);
    await rememberExecutable(executable); const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable));
    const controller = new AbortController(), started = performance.now();
    await assert.rejects(host.publish({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
      deadlineUnixMs: Date.now() + 100, signal: controller.signal }), error => {
      assert.equal((error as Error).message, "private_installed_configuration_native_host_uncertain");
      assert.equal((error as Error).stack, undefined); assert.equal((error as Error).message.includes("private-material"), false); return true;
    });
    assert.ok(performance.now() - started < 3_000);
    assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
  }
});

macosTest("owner cancellation after stubborn leader and descendant readiness proves both PIDs and their group absent", async t => {
  const root = await disposableRoot(t), executable = join(root, "stubborn-group");
  await compile(executable, faultSource, ["-DFAULT_MODE=6"]); await rememberExecutable(executable);
  const originalSpawn = childProcess.spawn; let spawnedPid: number | undefined;
  let resolveReady!: (value: { leader: number; descendant: number; group: number }) => void;
  const ready = new Promise<{ leader: number; descendant: number; group: number }>(resolve => { resolveReady = resolve; });
  const hook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = originalSpawn(...args);
    if (typeof args[0] === "string" && args[0].startsWith("/private/tmp/acr-installed-configuration-native-")) {
      spawnedPid = child.pid; let output = "";
      child.stdout?.on("data", chunk => {
        output += Buffer.from(chunk).toString("ascii");
        const match = /^READY (\d+) (\d+) (\d+)\n$/u.exec(output);
        if (match) resolveReady({ leader: Number(match[1]), descendant: Number(match[2]), group: Number(match[3]) });
      });
    }
    return child;
  });
  syncBuiltinESMExports(); const controller = new AbortController();
  const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable));
  try {
    const active = host.publish({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
      deadlineUnixMs: Date.now() + 5_000, signal: controller.signal });
    const identities = await ready; assert.equal(identities.leader, spawnedPid); assert.equal(identities.group, identities.leader);
    assert.equal(processAbsent(identities.leader), false); assert.equal(processAbsent(identities.descendant), false);
    assert.equal(processAbsent(-identities.group), false); controller.abort();
    await assert.rejects(active, { message: "private_installed_configuration_native_host_uncertain" });
    assert.equal(processAbsent(identities.leader), true); assert.equal(processAbsent(identities.descendant), true);
    assert.equal(processAbsent(-identities.group), true);
    assert.deepEqual(host.inspectReadiness(), { state: "ready", staged: true, publicationAvailable: false,
      unresolvedHelperProcesses: 0, unresolvedProcessGroups: 0 });
    assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

macosTest("publication is burned before a native attempt and never retries an uncertain write", async t => {
  const root = await disposableRoot(t), executable = join(root, "crash");
  await compile(executable, faultSource, ["-DFAULT_MODE=5"]); await rememberExecutable(executable);
  const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable)), request = {
    schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1, deadlineUnixMs: Date.now() + 1_000,
    signal: new AbortController().signal } as const;
  await assert.rejects(host.publish(request), { message: "private_installed_configuration_native_host_uncertain" });
  await assert.rejects(host.publish({ ...request, deadlineUnixMs: Date.now() + 1_000 }),
    { message: "private_installed_configuration_native_host_refused" });
  assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
});

macosTest("failed partial staging remains in custody and cleanup can be retried after the obstruction clears", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable); await rememberExecutable(executable);
  const originalChmod = fsPromises.chmod, originalRmdir = fsPromises.rmdir;
  let stagedDirectory: string | undefined, blockRemoval = true;
  const chmodHook = mock.method(fsPromises, "chmod", async (...args: Parameters<typeof fsPromises.chmod>) => {
    if (typeof args[0] === "string" && args[0].startsWith("/private/tmp/acr-installed-configuration-native-")) {
      stagedDirectory = args[0]; const error = new Error("test staging chmod obstruction") as NodeJS.ErrnoException;
      error.code = "EACCES"; throw error;
    }
    return originalChmod(...args);
  });
  const rmdirHook = mock.method(fsPromises, "rmdir", async (...args: Parameters<typeof fsPromises.rmdir>) => {
    if (blockRemoval && args[0] === stagedDirectory) {
      const error = new Error("test staging removal obstruction") as NodeJS.ErrnoException;
      error.code = "EACCES"; throw error;
    }
    return originalRmdir(...args);
  });
  syncBuiltinESMExports(); const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable));
  try {
    await assert.rejects(host.publish({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
      deadlineUnixMs: Date.now() + 2_000, signal: new AbortController().signal }),
    { message: "private_installed_configuration_native_host_uncertain" });
    assert.ok(stagedDirectory);
    assert.deepEqual(host.inspectReadiness(), { state: "unresolved", staged: true, publicationAvailable: false,
      unresolvedHelperProcesses: 0, unresolvedProcessGroups: 0 });
    await assert.rejects(host.cleanup(new AbortController().signal),
      { message: "private_installed_configuration_native_host_uncertain" });
    blockRemoval = false;
    assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
    await assert.rejects(lstat(stagedDirectory!), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally {
    blockRemoval = false; chmodHook.mock.restore(); rmdirHook.mock.restore(); syncBuiltinESMExports();
    if (stagedDirectory) await rm(stagedDirectory, { recursive: true, force: true });
  }
});

macosTest("cleanup fences new native work before staged-helper removal settles", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable); await rememberExecutable(executable);
  const originalRmdir = fsPromises.rmdir, originalSpawn = childProcess.spawn;
  let releaseRemoval!: () => void, removalStarted!: () => void, spawns = 0;
  const removalEntered = new Promise<void>(resolve => { removalStarted = resolve; });
  const removalReleased = new Promise<void>(resolve => { releaseRemoval = resolve; });
  const rmdirHook = mock.method(fsPromises, "rmdir", async (...args: Parameters<typeof fsPromises.rmdir>) => {
    if (typeof args[0] === "string" && args[0].startsWith("/private/tmp/acr-installed-configuration-native-")) {
      removalStarted(); await removalReleased;
    }
    return originalRmdir(...args);
  });
  const spawnHook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (typeof args[0] === "string" && args[0].startsWith("/private/tmp/acr-installed-configuration-native-")) spawns += 1;
    return originalSpawn(...args);
  });
  syncBuiltinESMExports(); const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable));
  const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const stat = await handle.stat();
    await host.verifyProtectedPath(nativeRequest("ancestor", handle.fd, stat));
    assert.equal(spawns, 1);
    const cleanup = host.cleanup(new AbortController().signal);
    await removalEntered;
    const request = { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
      deadlineUnixMs: Date.now() + 1_000, signal: new AbortController().signal } as const;
    await assert.rejects(host.publish(request), { message: "private_installed_configuration_native_host_refused" });
    await assert.rejects(host.verifyProtectedPath(nativeRequest("ancestor", handle.fd, stat)),
      { message: "private_installed_configuration_native_host_refused" });
    await assert.rejects(host.cleanup(new AbortController().signal),
      { message: "private_installed_configuration_native_host_uncertain" });
    assert.equal(spawns, 1, "cleanup admits no replacement helper");
    releaseRemoval();
    assert.deepEqual(await cleanup, { outcome: "confirmed" });
  } finally {
    releaseRemoval?.(); await handle.close(); rmdirHook.mock.restore(); spawnHook.mock.restore(); syncBuiltinESMExports();
  }
});

macosTest("before-rename and after-rename-before-reply faults leave the final root absent or complete and never retry", async t => {
  for (const fault of ["ACR_TEST_FAULT_BEFORE_RENAME", "ACR_TEST_FAULT_AFTER_RENAME_BEFORE_REPLY"] as const) {
    const root = await disposableRoot(t), executable = join(root, `installed-configuration-${fault}`);
    await compile(executable, source, [`-DACR_TEST_ROOT_PREFIX=\"${root}\"`, `-D${fault}=1`]);
    await rememberExecutable(executable); const parent = await preparePublicationParent(root);
    const configuration = Buffer.from(`${canonicalJson({ value: fault })}\n`);
    const manifest = Buffer.from(`${canonicalJson({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
      installationId: "local-hermes", ownerUid: process.geteuid!(),
      configuration: { name: "operator.json", bytes: configuration.length, sha256: digest(configuration) },
      journal: { directoryName: "installation-journal" } })}\n`);
    const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable, configuration, manifest));
    const request = { schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
      deadlineUnixMs: Date.now() + 5_000, signal: new AbortController().signal } as const;
    await assert.rejects(host.publish(request), { message: "private_installed_configuration_native_host_uncertain" });
    await assert.rejects(host.publish({ ...request, deadlineUnixMs: Date.now() + 5_000 }),
      { message: "private_installed_configuration_native_host_refused" });
    const protectedRoot = join(parent, "Protected");
    if (fault === "ACR_TEST_FAULT_BEFORE_RENAME") {
      await assert.rejects(lstat(protectedRoot), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
      assert.equal((await readdir(parent)).includes(".Protected.acr-new"), false,
        "a fully identity-verified pre-rename partial tree is rolled back");
    } else {
      assert.deepEqual((await readdir(protectedRoot)).sort(),
        ["installation-journal", "installed-manifest.json", "operator.json"]);
      assert.deepEqual(await readFile(join(protectedRoot, "operator.json")), configuration);
      assert.deepEqual(await readFile(join(protectedRoot, "installed-manifest.json")), manifest);
      const native = Object.freeze({ verifyProtectedPath: (value: any) => host.verifyProtectedPath(value) });
      const custody = await createPrivateInstalledConfigurationCustodyV1({ schema: PRIVATE_INSTALLED_CONFIGURATION_CUSTODY_V1,
        manifestPath: join(protectedRoot, "installed-manifest.json"), manifestBytes: manifest.length,
        manifestSha256: digest(manifest), expectedOwnerUid: process.geteuid!(), verificationDeadlineMs: 2_000, native });
      assert.equal(custody.status, "configuration_ready");
    }
    assert.deepEqual(host.inspectReadiness(), { state: "ready", staged: true, publicationAvailable: false,
      unresolvedHelperProcesses: 0, unresolvedProcessGroups: 0 });
    assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
  }
});

macosTest("cleanup refuses while helper close custody is unresolved and succeeds only after absence is proved", async t => {
  const root = await disposableRoot(t), executable = join(root, "installed-configuration-v1");
  await compile(executable); await rememberExecutable(executable);
  const originalSpawn = childProcess.spawn; let actualPid: number | undefined;
  const hook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (typeof args[0] === "string" && args[0].startsWith("/private/tmp/acr-installed-configuration-native-")) {
      const child = originalSpawn("/bin/sleep", ["30"], { ...args[2], detached: false }); actualPid = child.pid;
      Object.defineProperty(child, "pid", { configurable: true, value: 999_999 });
      child.kill = (() => true) as typeof child.kill; return child;
    }
    return originalSpawn(...args);
  });
  syncBuiltinESMExports(); const host = createPrivateInstalledConfigurationNativeHostV1(hostInput(executable));
  try {
    await assert.rejects(host.publish({ schema: PRIVATE_INSTALLED_CONFIGURATION_NATIVE_PUBLISH_REQUEST_V1,
      deadlineUnixMs: Date.now() + 50, signal: new AbortController().signal }),
    { message: "private_installed_configuration_native_host_uncertain" });
    assert.deepEqual(host.inspectReadiness(), { state: "unresolved", staged: true, publicationAvailable: false,
      unresolvedHelperProcesses: 1, unresolvedProcessGroups: 1 });
    await assert.rejects(host.cleanup(new AbortController().signal),
      { message: "private_installed_configuration_native_host_uncertain" });
    assert.ok(actualPid); process.kill(actualPid!, "SIGKILL");
    for (let tries = 0; tries < 100 && host.inspectReadiness().state === "unresolved"; tries++)
      await new Promise(resolve => setTimeout(resolve, 10));
    // A failed cleanup permanently withholds new native work, even after the
    // formerly unresolved helper is gone. Only exact cleanup retry remains.
    assert.deepEqual(host.inspectReadiness(), { state: "unresolved", staged: true, publicationAvailable: false,
      unresolvedHelperProcesses: 0, unresolvedProcessGroups: 0 });
    assert.deepEqual(await host.cleanup(new AbortController().signal), { outcome: "confirmed" });
  } finally {
    if (actualPid) try { process.kill(actualPid, "SIGKILL"); } catch {}
    hook.mock.restore(); syncBuiltinESMExports();
  }
});
