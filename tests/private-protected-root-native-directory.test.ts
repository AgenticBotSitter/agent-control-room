import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, mock, test } from "node:test";
import type { Duplex } from "node:stream";
import { createPrivateProtectedRootNativeDirectoryV1 } from "../src/installer/v1/private-protected-root-native-directory";
import { PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1, type PrivateProtectedRootNativeCreateRequestV1 } from
  "../src/installer/v1/private-protected-root-owner-adapter";
import { buildProtectedDirectoryNativeArtifactV1, PROTECTED_DIRECTORY_NATIVE_CFLAGS_V1 } from
  "../scripts/build-protected-directory-native.mjs";

const run = promisify(execFile), repository = dirname(dirname(fileURLToPath(import.meta.url)));
const supported = process.platform === "darwin" && process.getuid?.() !== 0;
const nativeTest = (name: string, fn: () => Promise<void>) => test(name,
  { skip: supported ? false : "Requires non-root macOS and the installed Apple compiler; no platform qualification claimed." }, fn);
let root: string, executable: string, checkpoints: string, digest: string, malicious: string, fragmented: string;
const faultExecutables: string[] = [];
const byteDigest = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
before(async () => {
  if (!supported) return;
  root = await realpath(await mkdtemp(join(tmpdir(), "acr-directory-native-test-")));
  executable = join(root, "primitive"); checkpoints = join(root, "checkpoints");
  malicious = join(root, "malicious"); fragmented = join(root, "fragmented");
  for (const [source, output, extra] of [
    ["native/protected-directory-v1.c", executable, []],
    ["tests/helpers/protected-directory-checkpoints.c", checkpoints, []],
    ["tests/helpers/protected-directory-process-faults.c", malicious, ["-DFAULT=5"]],
    ["tests/helpers/protected-directory-fragmented-output.c", fragmented, []],
    ...[1, 2, 3, 4, 6].map(fault => {
      const output = join(root, `fault-${fault}`); faultExecutables.push(output);
      return ["tests/helpers/protected-directory-process-faults.c", output, [`-DFAULT=${fault}`]];
    }),
  ] as [string, string, string[]][]) {
    await run("/usr/bin/clang", [...PROTECTED_DIRECTORY_NATIVE_CFLAGS_V1, ...extra, join(repository, source), "-o", output],
      { timeout: 30_000, maxBuffer: 16_384, env: { PATH: "/usr/bin:/bin", TMPDIR: root } });
  }
  digest = byteDigest(await readFile(executable));
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function request(name: string, overrides: Partial<PrivateProtectedRootNativeCreateRequestV1> = {}) {
  const parentPath = join(root, name); await mkdir(parentPath, { mode: 0o700 });
  const stat = await lstat(parentPath);
  return { schema: PRIVATE_PROTECTED_ROOT_NATIVE_DIRECTORY_V1, operation: "create_one_private_child" as const,
    parentPath, childName: "data", expectedParentIdentity: { device: stat.dev, inode: stat.ino },
    expectedOwnerUid: process.geteuid!(), mode: 0o700 as const, deadlineUnixMs: Date.now() + 10_000,
    signal: new AbortController().signal, ...overrides };
}
function encode(value: PrivateProtectedRootNativeCreateRequestV1) {
  const parent = Buffer.from(value.parentPath), child = Buffer.from(value.childName), header = Buffer.alloc(48);
  header.write("ACRDIR1\n"); header.writeUInt32BE(parent.length, 8); header.writeUInt32BE(child.length, 12);
  [value.expectedParentIdentity.device, value.expectedParentIdentity.inode, value.expectedOwnerUid, value.deadlineUnixMs]
    .forEach((value, index) => header.writeBigUInt64BE(BigInt(value), 16 + index * 8));
  return Buffer.concat([header, parent, child]);
}
async function raw(binary: string, bytes: Buffer, onCheckpoint?: (phase: number, child: ReturnType<typeof spawn>) => Promise<void>, fragmentedInput = false) {
  const child = spawn(binary, [], { stdio: onCheckpoint ? ["pipe", "pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"], env: {} });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout!.on("data", (bytes: Buffer) => output.push(bytes));
  child.stderr!.on("data", (bytes: Buffer) => errors.push(bytes));
  child.stdin!.on("error", () => undefined);
  let checkpointFailure: unknown;
  if (onCheckpoint) (child.stdio[3] as Duplex).on("data", (phases: Buffer) => {
    void (async () => {
      try {
        for (const phase of phases) await onCheckpoint(phase, child);
        (child.stdio[4] as Duplex).write(Buffer.from([1]));
      } catch (error) { checkpointFailure = error; child.kill("SIGKILL"); }
    })();
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 12_000);
  if (fragmentedInput) void (async () => {
    for (let offset = 0; offset < bytes.length; offset += 7) {
      child.stdin!.write(bytes.subarray(offset, offset + 7));
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    child.stdin!.end();
  })();
  else child.stdin!.end(bytes);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject); child.once("close", resolve);
    });
    if (checkpointFailure) throw checkpointFailure;
    assert.equal(Buffer.concat(errors).length, 0, Buffer.concat(errors).toString("utf8"));
    assert.throws(() => process.kill(child.pid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
    return { code, output: Buffer.concat(output) };
  } finally { clearTimeout(timer); }
}
const port = () => createPrivateProtectedRootNativeDirectoryV1({ executablePath: executable, executableSha256: digest });
const uncertain = { message: "private_protected_root_native_directory_uncertain" };

nativeTest("real native primitive produces only exact identities, private mode and one child", async () => {
  const input = await request("success"), result = await port().createOnePrivateChild(input);
  const child = await lstat(join(input.parentPath, "data"));
  assert.deepEqual(result.rootIdentity, { device: child.dev, inode: child.ino });
  assert.deepEqual(result.parentIdentity, input.expectedParentIdentity);
  assert.equal(result.mode, 0o700); assert.equal(child.mode & 0o7777, 0o700);
  assert.equal(result.parentOpenedNoFollow, true); assert.equal(result.childInspectedNoFollow, true);
  assert.equal(result.ownerUid, process.geteuid!());
  assert.deepEqual(await readdir(input.parentPath), ["data"]);
  assert.equal(JSON.stringify(result).includes(input.parentPath), false);
});

nativeTest("native input refuses malformed frames, traversal, trailing bytes and unsafe identities without writing", async () => {
  const input = await request("malformed"), valid = encode(input);
  const malformed = [Buffer.alloc(0), valid.subarray(0, 24), Buffer.concat([valid, Buffer.from("extra")]),
    encode({ ...input, childName: "../escape" }), encode({ ...input, childName: "." }),
    encode({ ...input, childName: "a\0b" }), encode({ ...input, parentPath: `${input.parentPath}/../malformed` }),
    encode({ ...input, parentPath: `${input.parentPath}/` }),
    encode({ ...input, expectedParentIdentity: { device: Number.MAX_SAFE_INTEGER + 1, inode: 0 } })];
  for (const bytes of malformed) {
    const result = await raw(executable, bytes); assert.equal(result.code, 1); assert.equal(result.output.length, 0);
  }
  assert.deepEqual(await readdir(input.parentPath), []);
});

nativeTest("no-follow traversal rejects intermediate and final parent symlinks", async () => {
  const input = await request("symlink-parent"), alias = join(root, "parent-alias");
  await symlink(input.parentPath, alias);
  await assert.rejects(port().createOnePrivateChild({ ...input, parentPath: alias }), uncertain);
  await mkdir(join(input.parentPath, "nested"), { mode: 0o700 });
  const nested = await lstat(join(input.parentPath, "nested"));
  await assert.rejects(port().createOnePrivateChild({ ...input, parentPath: join(alias, "nested"),
    expectedParentIdentity: { device: nested.dev, inode: nested.ino } }), uncertain);
  assert.deepEqual(await readdir(join(input.parentPath, "nested")), []);
});

nativeTest("existing directory, symlink, regular file, hard link and FIFO are preserved", async () => {
  for (const kind of ["directory", "symlink", "file", "hardlink", "fifo"]) {
    const input = await request(`existing-${kind}`), target = join(input.parentPath, "data");
    if (kind === "directory") await mkdir(target, { mode: 0o700 });
    if (kind === "file") await writeFile(target, "preserve");
    if (kind === "symlink") await symlink("missing", target);
    if (kind === "hardlink") { const outside = join(root, "hardlink-source"); await writeFile(outside, "preserve"); await link(outside, target); }
    if (kind === "fifo") await run("/usr/bin/mkfifo", [target]);
    const before = await lstat(target);
    await assert.rejects(port().createOnePrivateChild(input), uncertain);
    const after = await lstat(target);
    assert.equal(before.ino, after.ino); assert.equal(before.mode, after.mode); assert.equal(before.nlink, after.nlink);
  }
});

nativeTest("wrong owner, identity, private mode and extended ACL all refuse", async () => {
  const wrongUid = await request("wrong-uid");
  const result = await raw(executable, encode({ ...wrongUid, expectedOwnerUid: wrongUid.expectedOwnerUid + 1 }));
  assert.equal(result.code, 1); assert.deepEqual(await readdir(wrongUid.parentPath), []);
  const wrongId = await request("wrong-identity");
  await assert.rejects(port().createOnePrivateChild({ ...wrongId, expectedParentIdentity: { device: 0, inode: 0 } }), uncertain);
  const broad = await request("wrong-mode"); await chmod(broad.parentPath, 0o755);
  await assert.rejects(port().createOnePrivateChild(broad), uncertain);
  assert.equal((await lstat(broad.parentPath)).mode & 0o777, 0o755);
  const acl = await request("extended-acl");
  await run("/bin/chmod", ["+a", "everyone allow readattr", acl.parentPath]);
  assert.equal((await lstat(acl.parentPath)).mode & 0o777, 0o700);
  await assert.rejects(port().createOnePrivateChild(acl), uncertain);
  assert.deepEqual(await readdir(acl.parentPath), []);
});

nativeTest("parent substitution cannot redirect mkdirat and leaves any created directory for inspection", async () => {
  const input = await request("parent-race"), moved = `${input.parentPath}-moved`;
  const result = await raw(checkpoints, encode(input), async phase => {
    if (phase === 1) { await rename(input.parentPath, moved); await mkdir(input.parentPath, { mode: 0o700 }); }
  });
  assert.equal(result.code, 1); assert.equal(result.output.length, 0);
  assert.deepEqual(await readdir(input.parentPath), []);
  assert.equal((await lstat(join(moved, "data"))).isDirectory(), true);
});

nativeTest("child substitution and post-create ACL drift fail without deleting either object", async () => {
  for (const kind of ["symlink", "acl"]) {
    const input = await request(`child-race-${kind}`), target = join(input.parentPath, "data");
    const result = await raw(checkpoints, encode(input), async phase => {
      if (phase === 2 && kind === "symlink") { await rename(target, `${target}-retained`); await symlink("foreign", target); }
      if (phase === 2 && kind === "acl") await run("/bin/chmod", ["+a", "everyone allow readattr", target]);
    });
    assert.equal(result.code, 1); assert.equal(result.output.length, 0);
    if (kind === "symlink") assert.equal((await lstat(`${target}-retained`)).isDirectory(), true);
    else assert.equal((await lstat(target)).isDirectory(), true);
  }
});

nativeTest("native cancellation and expired deadline preserve created directories and never claim success", async () => {
  const expired = await request("expired", { deadlineUnixMs: Date.now() - 1 });
  assert.equal((await raw(executable, encode(expired))).code, 1);
  assert.deepEqual(await readdir(expired.parentPath), []);
  for (const phaseToCancel of [1, 2, 3]) {
    const input = await request(`cancel-at-${phaseToCancel}`);
    const result = await raw(checkpoints, encode(input), async (phase, child) => {
      if (phase === phaseToCancel) child.kill("SIGTERM");
    });
    assert.notEqual(result.code, 0); assert.equal(result.output.length, 0);
    assert.deepEqual(await readdir(input.parentPath), phaseToCancel === 1 ? [] : ["data"]);
  }
  const deadlineInput = await request("deadline-after-create", { deadlineUnixMs: Date.now() + 250 });
  const deadlineResult = await raw(checkpoints, encode(deadlineInput), async phase => {
    if (phase === 2) await new Promise(resolve => setTimeout(resolve, 300));
  });
  assert.equal(deadlineResult.code, 1); assert.equal(deadlineResult.output.length, 0);
  assert.deepEqual(await readdir(deadlineInput.parentPath), ["data"]);
});

nativeTest("wrapper is single-use, captures inputs, and refuses pre-abort, digest drift and unsafe executable types", async () => {
  const input = await request("single-use");
  const configuration = { executablePath: executable, executableSha256: digest };
  const native = createPrivateProtectedRootNativeDirectoryV1(configuration);
  configuration.executablePath = "/private/unreviewed";
  const first = native.createOnePrivateChild(input);
  await assert.rejects(native.createOnePrivateChild(input), uncertain);
  input.childName = "mutated-after-entry";
  (input.expectedParentIdentity as { inode: number }).inode = 0;
  await first;
  assert.deepEqual(await readdir(input.parentPath), ["data"]);
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(port().createOnePrivateChild(await request("pre-abort", { signal: cancelled.signal })), uncertain);
  const badDigest = createPrivateProtectedRootNativeDirectoryV1({ executablePath: executable, executableSha256: `sha256:${"0".repeat(64)}` });
  await assert.rejects(badDigest.createOnePrivateChild(await request("digest-drift")), uncertain);
  const fifo = join(root, "executable-fifo"); await run("/usr/bin/mkfifo", [fifo]);
  await assert.rejects(createPrivateProtectedRootNativeDirectoryV1({ executablePath: fifo, executableSha256: digest })
    .createOnePrivateChild(await request("fifo-executable")), uncertain);
});

nativeTest("wrapper bounds output and cancellation, reaps helpers, and redacts private failures", async () => {
  const resourcesBefore = process.getActiveResourcesInfo().filter(item => /ProcessWrap/u.test(item)).length;
  const descriptorsBefore = (await readdir("/dev/fd")).length;
  for (let index = 0; index < faultExecutables.length; index++) {
    const binary = faultExecutables[index], controller = new AbortController();
    const native = createPrivateProtectedRootNativeDirectoryV1({ executablePath: binary, executableSha256: byteDigest(await readFile(binary)) });
    const input = await request(`process-fault-${index}`, { signal: controller.signal,
      deadlineUnixMs: Date.now() + (index === 1 ? 100 : 5_000) });
    const start = performance.now();
    await assert.rejects(native.createOnePrivateChild(input), error => {
      assert.equal((error as Error).message, uncertain.message); assert.equal((error as Error).stack, undefined); return true;
    });
    assert.ok(performance.now() - start < 3_000);
    assert.deepEqual(await readdir(input.parentPath), []);
  }
  const binary = faultExecutables[1], controller = new AbortController();
  const native = createPrivateProtectedRootNativeDirectoryV1({ executablePath: binary, executableSha256: byteDigest(await readFile(binary)) });
  const input = await request("wrapper-abort", { signal: controller.signal });
  const attempt = native.createOnePrivateChild(input), timer = setTimeout(() => controller.abort(), 100);
  try { await assert.rejects(attempt, uncertain); } finally { clearTimeout(timer); }
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(process.getActiveResourcesInfo().filter(item => /ProcessWrap/u.test(item)).length, resourcesBefore);
  assert.equal((await readdir("/dev/fd")).length, descriptorsBefore);
});

nativeTest("cancellation after the private staged helper starts confirms that exact child was reaped", async () => {
  const controller = new AbortController(), binary = faultExecutables[1], original = childProcess.spawn;
  const input = await request("confirmed-staged-child-cancel", { signal: controller.signal });
  let helperPid: number | undefined;
  const hook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    const child = original(...args);
    if (args[0].startsWith("/private/tmp/acr-protected-native-")) {
      helperPid = child.pid; setTimeout(() => controller.abort(), 20);
    }
    return child;
  });
  syncBuiltinESMExports();
  try {
    const native = createPrivateProtectedRootNativeDirectoryV1({ executablePath: binary,
      executableSha256: byteDigest(await readFile(binary)) });
    await assert.rejects(native.createOnePrivateChild(input), uncertain);
    assert.ok(helperPid);
    assert.throws(() => process.kill(helperPid!, 0), (error: NodeJS.ErrnoException) => error.code === "ESRCH");
    assert.deepEqual(await readdir(input.parentPath), []);
  } finally { hook.mock.restore(); syncBuiltinESMExports(); }
});

nativeTest("source ACL writes and writable-ancestor replacement cannot change the launched bytes", async () => {
  for (const attack of ["source-acl", "ancestor"]) {
    const sourceDirectory = join(root, `hostile-source-${attack}`); await mkdir(sourceDirectory, { mode: 0o777 });
    const source = join(sourceDirectory, "primitive"); await writeFile(source, await readFile(executable), { mode: 0o700 });
    if (attack === "source-acl") await run("/bin/chmod", ["+a", "everyone allow write,append", source]);
    else await chmod(sourceDirectory, 0o777);
    const input = await request(`source-custody-${attack}`), native = createPrivateProtectedRootNativeDirectoryV1({
      executablePath: source, executableSha256: digest });
    let attacked = false, staging: string | undefined;
    const original = fsPromises.mkdtemp;
    const hook = mock.method(fsPromises, "mkdtemp", async (...args: Parameters<typeof mkdtemp>) => {
      const directory = await original(...args);
      if (args[0] === "/private/tmp/acr-protected-native-") {
        staging = directory.toString(); attacked = true;
        // mkdtemp runs only after the exact source bytes have been captured.
        if (attack === "ancestor") {
          await rename(sourceDirectory, `${sourceDirectory}-original`);
          await mkdir(sourceDirectory, { mode: 0o777 });
        }
        await writeFile(source, await readFile(malicious), { mode: 0o700 });
      }
      return directory;
    });
    syncBuiltinESMExports();
    try {
      await native.createOnePrivateChild(input);
      assert.equal(attacked, true);
      assert.deepEqual(await readdir(input.parentPath), ["data"]);
      assert.equal(byteDigest(await readFile(source)), byteDigest(await readFile(malicious)));
      await assert.rejects(lstat(staging!), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    } finally { hook.mock.restore(); syncBuiltinESMExports(); }
  }
});

nativeTest("staging clears inherited ACLs before exclusive executable creation and cleans only owned files", async () => {
  const input = await request("inherited-stage-acl"), original = fsPromises.mkdtemp;
  let staging: string | undefined, checked = false;
  const stageHook = mock.method(fsPromises, "mkdtemp", async (...args: Parameters<typeof mkdtemp>) => {
    const directory = await original(...args);
    if (args[0] === "/private/tmp/acr-protected-native-") {
      staging = directory.toString();
      await run("/bin/chmod", ["+a", "everyone allow add_file,add_subdirectory,delete_child,file_inherit,directory_inherit", staging]);
    }
    return directory;
  });
  const originalOpen = fsPromises.open;
  const openHook = mock.method(fsPromises, "open", async (...args: Parameters<typeof open>) => {
    if (staging && args[0] === join(staging, "protected-directory-v1")) {
      const listing = await run("/bin/ls", ["-ldne", staging]);
      assert.equal(listing.stdout.trimEnd().split("\n").length, 1);
      assert.equal((await lstat(staging)).mode & 0o7777, 0o700); checked = true;
    }
    return originalOpen(...args);
  });
  syncBuiltinESMExports();
  try {
    await port().createOnePrivateChild(input); assert.equal(checked, true);
    await assert.rejects(lstat(staging!), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
  } finally { stageHook.mock.restore(); openHook.mock.restore(); syncBuiltinESMExports(); }
});

nativeTest("uncertain cleanup preserves foreign staging content and cannot report successful creation", async () => {
  const input = await request("staging-cleanup-uncertain"), original = fsPromises.rmdir;
  let staging: string | undefined;
  const hook = mock.method(fsPromises, "rmdir", async (...args: Parameters<typeof fsPromises.rmdir>) => {
    if (typeof args[0] === "string" && args[0].startsWith("/private/tmp/acr-protected-native-")) {
      staging = args[0]; await writeFile(join(staging, "foreign-content"), "preserve");
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(port().createOnePrivateChild(input), uncertain);
    assert.deepEqual(await readdir(input.parentPath), ["data"]);
    assert.equal(await readFile(join(staging!, "foreign-content"), "utf8"), "preserve");
  } finally {
    hook.mock.restore(); syncBuiltinESMExports();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
});

nativeTest("abort during delayed staging returns uncertainty and cleans late-created staging without launching", async () => {
  const controller = new AbortController(), input = await request("late-staging-abort", { signal: controller.signal });
  const original = fsPromises.mkdtemp;
  let staging: string | undefined, release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const hook = mock.method(fsPromises, "mkdtemp", async (...args: Parameters<typeof mkdtemp>) => {
    const directory = await original(...args);
    if (args[0] === "/private/tmp/acr-protected-native-") { staging = directory.toString(); entered(); await gate; }
    return directory;
  });
  syncBuiltinESMExports();
  try {
    const attempt = port().createOnePrivateChild(input);
    await reached; controller.abort();
    await assert.rejects(attempt, uncertain);
    assert.deepEqual(await readdir(input.parentPath), []);
    release();
    for (let tries = 0; tries < 100; tries++) {
      try { await lstat(staging!); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("late staging was not cleaned");
  } finally {
    release(); hook.mock.restore(); syncBuiltinESMExports();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
});

nativeTest("fragmented native input and output work while partial success output refuses", async () => {
  const rawInput = await request("fragmented-input");
  const response = await raw(executable, encode(rawInput), undefined, true);
  assert.equal(response.code, 0); assert.match(response.output.toString(), /^ACRDIR1 /u);
  const native = createPrivateProtectedRootNativeDirectoryV1({ executablePath: fragmented,
    executableSha256: byteDigest(await readFile(fragmented)) });
  const input = await request("fragmented-output");
  await native.createOnePrivateChild(input);
  assert.deepEqual(await readdir(input.parentPath), ["data"]);
});

nativeTest("native release artifact is deterministic and preserves executable mode without a runtime compiler", async () => {
  const first = await buildProtectedDirectoryNativeArtifactV1({ outputDirectory: join(root, "artifact-one") });
  const second = await buildProtectedDirectoryNativeArtifactV1({ outputDirectory: join(root, "artifact-two") });
  assert.deepEqual(first, second);
  assert.deepEqual(await readFile(join(root, "artifact-one", first.archiveName)), await readFile(join(root, "artifact-two", second.archiveName)));
  assert.equal(first.ownerQualified, false); assert.equal(first.installs, false);
  const extract = join(root, "extract"); await mkdir(extract);
  await run("/usr/bin/tar", ["-xzf", join(root, "artifact-one", first.archiveName), "-C", extract]);
  const artifact = join(extract, `agent-control-room-protected-directory-darwin-${process.arch}`);
  const installed = join(artifact, "protected-directory-v1");
  assert.equal((await lstat(installed)).mode & 0o777, 0o755);
  assert.equal(byteDigest(await readFile(installed)), first.executableSha256);
  await assert.rejects(buildProtectedDirectoryNativeArtifactV1({ outputDirectory: join(root, "artifact-one") }));
  const manifest = JSON.parse(await readFile(join(artifact, "PROTECTED_DIRECTORY_MANIFEST.json"), "utf8"));
  assert.equal(JSON.stringify(manifest).includes(root), false);
  const input = await request("artifact-executable");
  await createPrivateProtectedRootNativeDirectoryV1({ executablePath: installed, executableSha256: first.executableSha256 })
    .createOnePrivateChild(input);
});
