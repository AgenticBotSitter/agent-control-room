import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import childProcess from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { promisify } from "node:util";
import { after, before, mock, test } from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { createPrivateInstallationJournalHeldSessionAdapterV1 } from
  "../src/installer/v1/private-installation-journal-held-session-adapter";
import { preparePrivateInstallationJournalNativeCustodyV1 } from
  "../src/installer/v1/private-installation-journal-native-custody-preparation";
import { createPrivateInstallationJournalNativeSessionPortV1 } from
  "../src/installer/v1/private-installation-journal-native-session";
import { sha256Digest } from "../src/security/canonical-digest";

const run = promisify(execFile);
const nativeTest = process.platform === "darwin" ? test : test.skip;
let root = "", executable = "", checkpointExecutable = "", digest = "";
const faultExecutables: string[] = [];
const installationId = "native-session-test";
const plan = (revision: number) => `${installationId}.installation-plan.revision-${String(revision).padStart(10, "0")}.json`;
const witness = (revision: number) => `${installationId}.installation-plan.revision-${String(revision).padStart(10, "0")}.publish.json`;
const temporary = (revision: number) => `${installationId}.installation-plan.revision-${String(revision).padStart(10, "0")}.${randomUUID()}.tmp`;
const byteDigest = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

before(async () => {
  if (process.platform !== "darwin") return;
  root = await mkdtemp("/private/tmp/acr-journal-native-test-"); await chmod(root, 0o700);
  executable = join(root, "installation-journal-session-v1");
  await run("/usr/bin/xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
    "native/installation-journal-session-v1.c", "-o", executable], { cwd: process.cwd() });
  digest = byteDigest(await readFile(executable));
  checkpointExecutable = join(root, "installation-journal-checkpoints");
  await run("/usr/bin/xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2",
    "tests/helpers/installation-journal-native-checkpoints.c", "-o", checkpointExecutable], { cwd: process.cwd() });
  for (let mode = 1; mode <= 7; mode++) {
    const output = join(root, `journal-fault-${mode}`); faultExecutables.push(output);
    await run("/usr/bin/xcrun", ["clang", "-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", `-DACR_FAULT_MODE=${mode}`,
      "tests/helpers/installation-journal-native-process-faults.c", "-o", output], { cwd: process.cwd() });
  }
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

async function operation(kind: "read_history" | "inspect_settled_history" | "append", label: string,
  controller = new AbortController(), deadline = 5_000) {
  const directory = join(root, label); await mkdir(directory, { mode: 0o700 }); const stat = await lstat(directory);
  const preparation = preparePrivateInstallationJournalNativeCustodyV1({
    schema: "control-room.private-installation-journal-native-custody-preparation/v1",
    journalRootPath: directory, installationId, expectedRootIdentity: { device: stat.dev, inode: stat.ino },
    expectedOwnerUid: process.geteuid!(), operationDeadlineMs: deadline,
  });
  return { directory, request: preparation.prepareOperation(kind, controller.signal), controller };
}
const port = () => createPrivateInstallationJournalNativeSessionPortV1({ executablePath: executable, executableSha256: digest });
const uncertain = { message: "private_installation_journal_native_session_uncertain" };
const retainedPlan = (suffix = "one") => createInstallationPlanV1({ topologyPlan: planInstallationTopologyV1({
  databaseAuthorityDigest: sha256Digest(`database:${suffix}`), schedulerAuthorityDigest: sha256Digest(`scheduler:${suffix}`),
  currentRoutes: [], requestedRoutes: [{ kind: "local", workerId: `worker:${suffix}`, adapterId: "connector:native",
    adapterRevision: "0000001" }],
}), releaseDigest: sha256Digest(`release:${suffix}`), stageInputDigests: Object.fromEntries(
  installationSetupStagesV1.map(stage => [stage, sha256Digest(`${suffix}:${stage}`)])) });

function rawOpenFrame(request: Awaited<ReturnType<typeof operation>>["request"]) {
  const path = Buffer.from(request.journalRootPath), id = Buffer.from(request.installationId), header = Buffer.alloc(64);
  header.write("ACRJNL1\n"); header.writeUInt32BE(request.operation === "read_history" ? 1 : request.operation === "inspect_settled_history" ? 2 : 3, 8);
  header.writeUInt32BE(path.length, 12); header.writeUInt32BE(id.length, 16);
  header.writeBigUInt64BE(BigInt(request.expectedRootIdentity.device), 24); header.writeBigUInt64BE(BigInt(request.expectedRootIdentity.inode), 32);
  header.writeBigUInt64BE(BigInt(request.expectedOwnerUid), 40); header.writeBigUInt64BE(BigInt(request.deadlineUnixMs), 48);
  return Buffer.concat([header, path, id]);
}
function rawCommand(opcode: number, ordinal: number, name = "", maximum = 0) {
  const bytes = Buffer.from(name), header = Buffer.alloc(44); header.write("ACRC"); header[4] = opcode;
  header.writeUInt16BE(bytes.length, 6); header.writeUInt32BE(ordinal, 12); header.writeUInt32BE(maximum, 36);
  return Buffer.concat([header, bytes]);
}
function byteReader(stream: NodeJS.ReadableStream) {
  let buffered = Buffer.alloc(0); const pending: Array<{ count: number; resolve(value: Buffer): void }> = [];
  const drain = () => { while (pending[0] && buffered.length >= pending[0].count) { const item = pending.shift()!;
    const value = buffered.subarray(0, item.count); buffered = buffered.subarray(item.count); item.resolve(value); } };
  stream.on("data", (chunk: Buffer) => { buffered = Buffer.concat([buffered, chunk]); drain(); });
  return (count: number) => new Promise<Buffer>(resolve => { pending.push({ count, resolve }); drain(); });
}

nativeTest("one real held native session performs exact descriptor-bound publication and close", async () => {
  const input = await operation("append", "publish"), session = await port().openSession(input.request);
  const temp = temporary(1), target = plan(1), mark = witness(1), bytes = Buffer.from("canonical-plan");
  assert.deepEqual(await session.listEntryNames(), []);
  const tempIdentity = await session.createExclusiveEntry(temp);
  await session.writeExactBounded(temp, tempIdentity, bytes, 65_536); await session.syncFile(temp, tempIdentity);
  const witnessIdentity = await session.createExclusiveEntry(mark);
  await session.writeExactBounded(mark, witnessIdentity, Buffer.from("witness"), 1_024);
  await session.syncFile(mark, witnessIdentity); await session.syncDirectory();
  await session.linkNoReplace(temp, tempIdentity, target); await session.syncDirectory();
  const read = await session.readEntry(target, 65_536); assert.deepEqual(Buffer.from(read.bytes), bytes);
  await session.unlinkExact(temp, tempIdentity); await session.unlinkExact(mark, witnessIdentity); await session.syncDirectory();
  await session.verifyRoot(); await session.close();
  assert.deepEqual((await readdir(input.directory)).sort(), [target]);
});

nativeTest("two sequential non-empty listings each start from an independent directory offset", async () => {
  const input = await operation("inspect_settled_history", "repeated-listing");
  await writeFile(join(input.directory, plan(1)), "one", { mode: 0o600 });
  await writeFile(join(input.directory, plan(2)), "two", { mode: 0o600 });
  const session = await port().openSession(input.request), expected = [plan(1), plan(2)].sort();
  assert.deepEqual([...(await session.listEntryNames())].sort(), expected);
  assert.deepEqual([...(await session.listEntryNames())].sort(), expected);
  await session.close();
});

nativeTest("the retained TypeScript journal keeps transition, replay, conflict and settled-inspection authority", async () => {
  const directory = join(root, "retained-journal"); await mkdir(directory, { mode: 0o700 }); const stat = await lstat(directory);
  const preparation = preparePrivateInstallationJournalNativeCustodyV1({
    schema: "control-room.private-installation-journal-native-custody-preparation/v1", journalRootPath: directory,
    installationId, expectedRootIdentity: { device: stat.dev, inode: stat.ino }, expectedOwnerUid: process.geteuid!(), operationDeadlineMs: 5_000,
  });
  const storage = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation,
    nativePort: createPrivateInstallationJournalNativeSessionPortV1({ executablePath: executable, executableSha256: digest }) });
  const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: directory, installationId,
    ownerUid: process.geteuid!() }, storage), first = retainedPlan();
  assert.equal((await journal.append(first)).replayed, false); assert.equal((await journal.append(first)).replayed, true);
  await assert.rejects(journal.append(retainedPlan("changed")), /installation_plan_journal_conflict/u);
  assert.equal((await journal.readHistory()).length, 1); assert.equal((await journal.inspectSettledHistory()).length, 1);
  assert.deepEqual(await readdir(directory), [plan(0)]);
});

nativeTest("inspection is non-mutating, operation capabilities are enforced natively, and a port refuses concurrent sessions", async () => {
  const input = await operation("inspect_settled_history", "inspect"), native = port();
  await writeFile(join(input.directory, plan(1)), "one", { mode: 0o600 });
  const session = await native.openSession(input.request), second = await operation("append", "concurrent");
  await assert.rejects(native.openSession(second.request), uncertain);
  assert.deepEqual(await session.listEntryNames(), [plan(1)]); assert.equal((await session.statEntry(plan(1)))?.kind, "file");
  await assert.rejects(session.createExclusiveEntry(temporary(2)), uncertain);
  assert.equal((await readFile(join(input.directory, plan(1)), "utf8")), "one");
  await assert.rejects(session.close(), uncertain);
});

nativeTest("read sessions retire only the exact supplied regular-file identity", async () => {
  const input = await operation("read_history", "retire"), name = temporary(1), path = join(input.directory, name);
  await writeFile(path, "recover", { mode: 0o600 }); const before = await lstat(path);
  const session = await port().openSession(input.request);
  await assert.rejects(session.unlinkExact(name, { device: BigInt(before.dev), inode: BigInt(before.ino + 1) }), uncertain);
  assert.equal(await readFile(path, "utf8"), "recover");
});

nativeTest("confirmed no-replace collisions preserve EEXIST and keep the held session usable", async () => {
  const input = await operation("append", "exists"), name = temporary(1); await writeFile(join(input.directory, name), "held", { mode: 0o600 });
  const session = await port().openSession(input.request);
  await assert.rejects(session.createExclusiveEntry(name), (error: NodeJS.ErrnoException) => error.code === "EEXIST");
  await session.verifyRoot(); await session.close(); assert.equal(await readFile(join(input.directory, name), "utf8"), "held");
});

nativeTest("links, special entries, mode and extended ACL drift fail closed without replacement or cleanup", async () => {
  const symlinkInput = await operation("inspect_settled_history", "links");
  await symlink("missing", join(symlinkInput.directory, plan(1)));
  const outside = join(root, "hard-link-source"); await writeFile(outside, "linked", { mode: 0o600 });
  await link(outside, join(symlinkInput.directory, plan(2)));
  await run("/usr/bin/mkfifo", [join(symlinkInput.directory, plan(3))]);
  const links = await port().openSession(symlinkInput.request);
  assert.equal((await links.statEntry(plan(1)))?.kind, "other");
  assert.equal((await links.statEntry(plan(2)))?.linkCount, 2); assert.equal((await links.statEntry(plan(3)))?.kind, "other");
  await assert.rejects(links.readEntry(plan(1), 65_536), uncertain);

  const modeInput = await operation("inspect_settled_history", "mode"); await chmod(modeInput.directory, 0o755);
  await assert.rejects(port().openSession(modeInput.request), uncertain);

  const aclInput = await operation("inspect_settled_history", "acl");
  await run("/bin/chmod", ["+a", "everyone allow readattr", aclInput.directory]);
  await assert.rejects(port().openSession(aclInput.request), uncertain);
});

nativeTest("entry ACL drift is rejected on reads and retained-file mutations", async () => {
  const readInput = await operation("inspect_settled_history", "entry-acl-read"), target = join(readInput.directory, plan(1));
  await writeFile(target, "entry", { mode: 0o600 }); await run("/bin/chmod", ["+a", "everyone allow readattr", target]);
  const readSession = await port().openSession(readInput.request);
  await assert.rejects(readSession.statEntry(plan(1)), uncertain);

  const mutationInput = await operation("append", "entry-acl-mutation"), mutationSession = await port().openSession(mutationInput.request);
  const name = temporary(1), identity = await mutationSession.createExclusiveEntry(name), path = join(mutationInput.directory, name);
  await run("/bin/chmod", ["+a", "everyone allow readattr", path]);
  await assert.rejects(mutationSession.writeExactBounded(name, identity, Buffer.from("refuse"), 65_536), uncertain);
  assert.equal((await lstat(path)).size, 0);
});

nativeTest("protected ancestor mode and ACL drift are rechecked before verification and close", async () => {
  const initialMode = await operation("inspect_settled_history", "ancestor-mode-initial"); await chmod(root, 0o755);
  try { await assert.rejects(port().openSession(initialMode.request), uncertain); }
  finally { await chmod(root, 0o700); }
  const initialAcl = await operation("inspect_settled_history", "ancestor-acl-initial");
  await run("/bin/chmod", ["+a", "everyone allow readattr", root]);
  try { await assert.rejects(port().openSession(initialAcl.request), uncertain); }
  finally { await run("/bin/chmod", ["-N", root]); await chmod(root, 0o700); }

  const modeInput = await operation("inspect_settled_history", "ancestor-mode-drift"), modeSession = await port().openSession(modeInput.request);
  await chmod(root, 0o755);
  try { await assert.rejects(modeSession.verifyRoot(), uncertain); }
  finally { await chmod(root, 0o700); }

  const aclInput = await operation("inspect_settled_history", "ancestor-acl-drift"), aclSession = await port().openSession(aclInput.request);
  await run("/bin/chmod", ["+a", "everyone allow readattr", root]);
  try { await assert.rejects(aclSession.close(), uncertain); }
  finally { await run("/bin/chmod", ["-N", root]); await chmod(root, 0o700); }
});

nativeTest("ancestor and root substitution cannot redirect an established session and makes verification fail", async () => {
  const parent = join(root, "substitution-parent"); await mkdir(parent, { mode: 0o700 });
  const directory = join(parent, "journal"); await mkdir(directory, { mode: 0o700 }); const initial = await lstat(directory);
  const preparation = preparePrivateInstallationJournalNativeCustodyV1({
    schema: "control-room.private-installation-journal-native-custody-preparation/v1", journalRootPath: directory,
    installationId, expectedRootIdentity: { device: initial.dev, inode: initial.ino }, expectedOwnerUid: process.geteuid!(), operationDeadlineMs: 5_000,
  });
  const session = await port().openSession(preparation.prepareOperation("append", new AbortController().signal));
  const moved = `${parent}-held`; await rename(parent, moved); await mkdir(parent, { mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const name = temporary(1), identity = await session.createExclusiveEntry(name);
  await session.writeExactBounded(name, identity, Buffer.from("held"), 65_536);
  assert.equal(await readFile(join(moved, "journal", name), "utf8"), "held"); assert.deepEqual(await readdir(directory), []);
  await assert.rejects(session.verifyRoot(), uncertain);
});

nativeTest("native checkpoints reject root and read-target substitution while fragmented input remains bounded", async () => {
  const rootInput = await operation("inspect_settled_history", "checkpoint-root"), held = `${rootInput.directory}-held`;
  const first = spawn(checkpointExecutable, [], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
  const phase = byteReader(first.stdio[3] as Readable), acknowledgement = first.stdio[4] as Writable;
  const opening = rawOpenFrame(rootInput.request);
  for (const byte of opening) first.stdin.write(Buffer.of(byte));
  assert.equal((await phase(4)).readUInt32BE(0), 1);
  await rename(rootInput.directory, held); await mkdir(rootInput.directory, { mode: 0o700 }); acknowledgement.write(Buffer.of(1));
  const firstExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    first.once("close", (code, signal) => resolve({ code, signal })));
  assert.equal(firstExit.code, 1); assert.equal(firstExit.signal, null); assert.equal(first.stdout.readableLength, 0);

  const readInput = await operation("inspect_settled_history", "checkpoint-read"), target = plan(1), targetPath = join(readInput.directory, target);
  await writeFile(targetPath, "original", { mode: 0o600 });
  const second = spawn(checkpointExecutable, [], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
  const secondPhase = byteReader(second.stdio[3] as Readable), secondAcknowledgement = second.stdio[4] as Writable;
  const secondOutput = byteReader(second.stdout);
  second.stdin.write(rawOpenFrame(readInput.request)); assert.equal((await secondPhase(4)).readUInt32BE(0), 1);
  secondAcknowledgement.write(Buffer.of(1)); assert.equal((await secondOutput(16)).subarray(0, 4).toString(), "ACRS");
  const readCommand = rawCommand(3, 1, target, 65_536);
  for (let offset = 0; offset < readCommand.length; offset += 3) second.stdin.write(readCommand.subarray(offset, offset + 3));
  assert.equal((await secondPhase(4)).readUInt32BE(0), 300); secondAcknowledgement.write(Buffer.of(1));
  assert.equal((await secondPhase(4)).readUInt32BE(0), 301);
  await rename(targetPath, `${targetPath}-held`); await symlink("foreign", targetPath); secondAcknowledgement.write(Buffer.of(1));
  const secondExit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    second.once("close", (code, signal) => resolve({ code, signal })));
  assert.equal(secondExit.code, 1); assert.equal(await readFile(`${targetPath}-held`, "utf8"), "original");
  assert.equal((await lstat(targetPath)).isSymbolicLink(), true);
});

nativeTest("a crash after exclusive creation but before its reply preserves uncertainty and the exact created file", async () => {
  const input = await operation("append", "lost-create-reply"), name = temporary(1);
  const child = spawn(checkpointExecutable, [], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
  const phases = byteReader(child.stdio[3] as Readable), acknowledgement = child.stdio[4] as Writable;
  const output = byteReader(child.stdout); child.stdin.write(rawOpenFrame(input.request));
  assert.equal((await phases(4)).readUInt32BE(0), 1); acknowledgement.write(Buffer.of(1)); await output(16);
  child.stdin.write(rawCommand(4, 1, name));
  assert.equal((await phases(4)).readUInt32BE(0), 400); acknowledgement.write(Buffer.of(1));
  assert.equal((await phases(4)).readUInt32BE(0), 401); acknowledgement.write(Buffer.of(1));
  assert.equal((await phases(4)).readUInt32BE(0), 402); child.kill("SIGKILL");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.once("close", (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, null); assert.equal(exit.signal, "SIGKILL");
  const created = await lstat(join(input.directory, name)); assert.equal(created.isFile(), true);
  assert.equal(created.size, 0); assert.equal(created.mode & 0o7777, 0o600);
});

nativeTest("exclusive-create substitution at the post-effect checkpoint cannot authenticate a replacement", async () => {
  const input = await operation("append", "create-substitution"), name = temporary(1), path = join(input.directory, name);
  const child = spawn(checkpointExecutable, [], { stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"] });
  const phases = byteReader(child.stdio[3] as Readable), acknowledgement = child.stdio[4] as Writable;
  const output = byteReader(child.stdout); child.stdin.write(rawOpenFrame(input.request));
  assert.equal((await phases(4)).readUInt32BE(0), 1); acknowledgement.write(Buffer.of(1)); await output(16);
  child.stdin.write(rawCommand(4, 1, name));
  assert.equal((await phases(4)).readUInt32BE(0), 400); acknowledgement.write(Buffer.of(1));
  assert.equal((await phases(4)).readUInt32BE(0), 401); acknowledgement.write(Buffer.of(1));
  assert.equal((await phases(4)).readUInt32BE(0), 402);
  await rename(path, `${path}-held`); await symlink("foreign", path); acknowledgement.write(Buffer.of(1));
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve =>
    child.once("close", (code, signal) => resolve({ code, signal })));
  assert.equal(exit.code, 1); assert.equal((await lstat(`${path}-held`)).isFile(), true);
  assert.equal((await lstat(path)).isSymbolicLink(), true);
});

nativeTest("abort and deadline kill and reap the exact child and leave the port fail closed", async () => {
  const controller = new AbortController(), input = await operation("append", "abort", controller, 5_000);
  const session = await port().openSession(input.request); controller.abort();
  await assert.rejects(session.listEntryNames(), uncertain);
  const expired = await operation("append", "deadline", new AbortController(), 30);
  await new Promise(resolve => setTimeout(resolve, 40));
  await assert.rejects(port().openSession(expired.request), uncertain);
  const idlePort = port(), idle = await operation("inspect_settled_history", "idle-deadline", new AbortController(), 300);
  const idleSession = await idlePort.openSession(idle.request); await new Promise(resolve => setTimeout(resolve, 450));
  await assert.rejects(idleSession.listEntryNames(), uncertain);
  const afterIdle = await operation("inspect_settled_history", "after-idle-deadline");
  const nextSession = await idlePort.openSession(afterIdle.request); await nextSession.close();
});

nativeTest("aborted executable capture settles bounded and can never launch after returning", async () => {
  const controller = new AbortController(), input = await operation("inspect_settled_history", "stalled-capture", controller, 5_000);
  const originalRealpath = fsPromises.realpath, originalSpawn = childProcess.spawn;
  let entered!: () => void, release!: () => void, launches = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const realpathHook = mock.method(fsPromises, "realpath", async (...args: Parameters<typeof fsPromises.realpath>) => {
    if (args[0] === executable) { entered(); await gate; }
    return originalRealpath(...args);
  });
  const spawnHook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (typeof args[0] === "string" && args[0].includes("/acr-journal-native-")) launches += 1;
    return originalSpawn(...args);
  });
  syncBuiltinESMExports();
  try {
    const started = performance.now(), attempt = port().openSession(input.request); await reached; controller.abort();
    await assert.rejects(attempt, uncertain); assert.ok(performance.now() - started < 1_000); assert.equal(launches, 0);
    release(); await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(launches, 0);
  } finally { release(); realpathHook.mock.restore(); spawnHook.mock.restore(); syncBuiltinESMExports(); }
});

nativeTest("abandoned staging cannot launch late and cleans only its captured staging identity", async () => {
  const input = await operation("inspect_settled_history", "stalled-stage", new AbortController(), 150);
  const originalMkdtemp = fsPromises.mkdtemp, originalSpawn = childProcess.spawn;
  let entered!: () => void, release!: () => void, staging: string | undefined, launches = 0;
  const reached = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const stageHook = mock.method(fsPromises, "mkdtemp", async (...args: Parameters<typeof fsPromises.mkdtemp>) => {
    const directory = await originalMkdtemp(...args);
    if (args[0] === "/private/tmp/acr-journal-native-") { staging = directory.toString(); entered(); await gate; }
    return directory;
  });
  const spawnHook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (typeof args[0] === "string" && args[0].includes("/acr-journal-native-")) launches += 1;
    return originalSpawn(...args);
  });
  syncBuiltinESMExports();
  try {
    const attempt = port().openSession(input.request); await reached; await assert.rejects(attempt, uncertain); assert.equal(launches, 0);
    release();
    for (let tries = 0; tries < 100; tries++) {
      try { await lstat(staging!); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") { assert.equal(launches, 0); return; }
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("late staging was not identity-cleaned");
  } finally {
    release(); stageHook.mock.restore(); spawnHook.mock.restore(); syncBuiltinESMExports();
    if (staging) await rm(staging, { recursive: true, force: true });
  }
});

nativeTest("a preparation child withholding close after SIGKILL rejects bounded and poisons uncertain custody", async () => {
  const input = await operation("inspect_settled_history", "withheld-prep-close", new AbortController(), 150);
  const originalSpawn = childProcess.spawn; let withheldPid: number | undefined;
  const hook = mock.method(childProcess, "spawn", (...args: Parameters<typeof spawn>) => {
    if (args[0] === "/bin/ls") {
      const child = originalSpawn("/bin/sleep", ["30"], args[2]); withheldPid = child.pid;
      child.kill = (() => true) as typeof child.kill; return child;
    }
    return originalSpawn(...args);
  });
  syncBuiltinESMExports(); const native = port();
  try {
    const started = performance.now(); await assert.rejects(native.openSession(input.request), uncertain);
    assert.ok(performance.now() - started < 1_000); assert.ok(withheldPid);
    const second = await operation("inspect_settled_history", "withheld-prep-close-second");
    await assert.rejects(native.openSession(second.request), uncertain);
    await new Promise(resolve => setTimeout(resolve, 2_100));
    assert.doesNotThrow(() => process.kill(withheldPid!, 0));
  } finally {
    if (withheldPid) { try { process.kill(withheldPid, "SIGKILL"); } catch {} }
    hook.mock.restore(); syncBuiltinESMExports();
  }
});

nativeTest("digest drift and executable symlink substitution are refused before any journal operation", async () => {
  const input = await operation("append", "executable-refusal");
  await assert.rejects(createPrivateInstallationJournalNativeSessionPortV1({ executablePath: executable,
    executableSha256: `sha256:${"0".repeat(64)}` }).openSession(input.request), uncertain);
  const alias = join(root, "helper-alias"); await symlink(executable, alias);
  await assert.rejects(createPrivateInstallationJournalNativeSessionPortV1({ executablePath: alias,
    executableSha256: digest }).openSession(input.request), uncertain);
});

nativeTest("partial, oversized and crashed replies refuse; deadlines reap; fragmented replies and exact close are enforced", async () => {
  for (const mode of [1, 3, 4]) {
    const input = await operation("inspect_settled_history", `fault-${mode}`), binary = faultExecutables[mode - 1]!;
    await assert.rejects(createPrivateInstallationJournalNativeSessionPortV1({ executablePath: binary,
      executableSha256: byteDigest(await readFile(binary)) }).openSession(input.request), uncertain);
  }
  const hanging = await operation("inspect_settled_history", "fault-hang", new AbortController(), 500), hang = faultExecutables[1]!;
  await assert.rejects(createPrivateInstallationJournalNativeSessionPortV1({ executablePath: hang,
    executableSha256: byteDigest(await readFile(hang)) }).openSession(hanging.request), uncertain);

  const fragmented = await operation("inspect_settled_history", "fragmented"), fragment = faultExecutables[4]!;
  const fragmentedSession = await createPrivateInstallationJournalNativeSessionPortV1({ executablePath: fragment,
    executableSha256: byteDigest(await readFile(fragment)) }).openSession(fragmented.request);
  await fragmentedSession.close();

  const badClose = await operation("inspect_settled_history", "bad-close"), bad = faultExecutables[5]!;
  const badSession = await createPrivateInstallationJournalNativeSessionPortV1({ executablePath: bad,
    executableSha256: byteDigest(await readFile(bad)) }).openSession(badClose.request);
  await assert.rejects(badSession.close(), uncertain);

  const trailingClose = await operation("inspect_settled_history", "trailing-close"), trailing = faultExecutables[6]!;
  const trailingSession = await createPrivateInstallationJournalNativeSessionPortV1({ executablePath: trailing,
    executableSha256: byteDigest(await readFile(trailing)) }).openSession(trailingClose.request);
  await assert.rejects(trailingSession.close(), uncertain);
});
