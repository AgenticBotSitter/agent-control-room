import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, link, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { openPrivateRecoveryToolPreflightV1, privateRecoveryReviewedToolPathsV1,
  privateRecoveryToolModeAllowedV1 } from "../src/installer/v1/private-recovery-tool-preflight";

const sha = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const refusal = { message: "private_recovery_tool_preflight_refused" };
async function fixture(t: TestContext) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "acr-recovery-preflight-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseRoot = join(root, "release");
  await mkdir(releaseRoot, { mode: 0o700 });
  const reviewedFiles = {} as Record<typeof privateRecoveryReviewedToolPathsV1[number], string>;
  for (const name of privateRecoveryReviewedToolPathsV1) {
    await mkdir(dirname(join(releaseRoot, name)), { recursive: true, mode: 0o700 });
    const bytes = `throw new Error("fixture must never execute: ${name}");\n`;
    await writeFile(join(releaseRoot, name), bytes, { mode: 0o600 }); reviewedFiles[name] = sha(bytes);
  }
  const executables = {} as Record<"node" | "pg_dump" | "pg_restore", { path: string; sha256: string }>;
  for (const name of ["node", "pg_dump", "pg_restore"] as const) {
    const path = join(root, name), bytes = "#!/bin/sh\nexit 79\n";
    await writeFile(path, bytes, { mode: 0o700 }); executables[name] = { path, sha256: sha(bytes) };
  }
  const controller = new AbortController();
  return { root, controller, input: { releaseRoot, releaseDigest: sha("release"), requestDigest: sha("request"),
    expectedOwnerUid: process.geteuid!(), reviewedFiles, executables, signal: controller.signal, deadlineMs: 30_000 } };
}

test("holds exact inert release and tool bytes and retires read handles without claiming runnable recovery", async t => {
  const f = await fixture(t), session = await openPrivateRecoveryToolPreflightV1(f.input);
  try {
    const result = await session.inspect();
    assert.equal(result.releaseFilesMatchingSuppliedPins, 8); assert.equal(result.executableFilesMatchingSuppliedPins, 3);
    assert.equal(result.readyForExecution, false); assert.equal(result.dependencyContentsVerified, false);
    assert.equal(result.extendedAclVerified, false); assert.equal(result.observedDatabase, false);
    assert.equal(result.grantsRecoveryAuthority, false); assert.equal(result.pinProvenanceVerified, false);
    assert.ok(result.remainingBlockers.includes("pin_provenance_missing"));
    assert.ok(result.remainingBlockers.includes("private_source_credentials_required"));
    assert.ok(result.remainingBlockers.includes("protected_backup_destination_required"));
    assert.equal(result.remainingBlockers.length, 8);
    assert.equal(Object.hasOwn(result, "releaseDigest"), false); assert.equal(Object.hasOwn(result, "requestDigest"), false);
    assert.doesNotMatch(JSON.stringify(result), /acr-recovery-preflight-|\/release|pg_dump|password/u);
    assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.remainingBlockers));
  } finally { assert.deepEqual(await session.close(), { retired: true, modifiedFiles: false, startedProcesses: false }); }
  await assert.rejects(session.inspect(), refusal);
  assert.equal((await session.close()).retired, true);
});

test("captures pin values before awaits and rejects accessors, unknown configuration and callable proxies", async t => {
  const f = await fixture(t), pending = openPrivateRecoveryToolPreflightV1(f.input);
  f.input.reviewedFiles[privateRecoveryReviewedToolPathsV1[0]] = sha("caller drift");
  const session = await pending;
  try { assert.equal((await session.inspect()).readyForExecution, false); } finally { await session.close(); }
  let reads = 0;
  const getter = { ...f.input }; Object.defineProperty(getter, "releaseRoot", { enumerable: true, get() { reads++; return f.input.releaseRoot; } });
  await assert.rejects(openPrivateRecoveryToolPreflightV1(getter), refusal); assert.equal(reads, 0);
  await assert.rejects(openPrivateRecoveryToolPreflightV1({ ...f.input, extra: true } as never), refusal);
  await assert.rejects(openPrivateRecoveryToolPreflightV1(new Proxy(f.input, { ownKeys() { reads++; return []; } })), refusal);
  assert.equal(reads, 0);
});

test("refuses non-protected release mode, hard links, executable writable by others and wrong pins", async t => {
  const f = await fixture(t), file = join(f.input.releaseRoot, privateRecoveryReviewedToolPathsV1[0]);
  await chmod(file, 0o644); await assert.rejects(openPrivateRecoveryToolPreflightV1(f.input), refusal);
  await chmod(file, 0o600); await link(file, join(f.root, "alias"));
  await assert.rejects(openPrivateRecoveryToolPreflightV1(f.input), refusal);
  await rm(join(f.root, "alias")); await chmod(f.input.executables.pg_dump.path, 0o777);
  await assert.rejects(openPrivateRecoveryToolPreflightV1(f.input), refusal);
  await chmod(f.input.executables.pg_dump.path, 0o700); f.input.executables.pg_dump.sha256 = sha("wrong");
  await assert.rejects(openPrivateRecoveryToolPreflightV1(f.input), refusal);
});

for (const kind of ["executable", "release_file", "directory"] as const) {
  for (const [name, bit] of [["setuid", 0o4000], ["setgid", 0o2000], ["sticky", 0o1000]] as const) {
    test(`mode policy refuses ${name} on ${kind} with both ordinary bits and full stat type bits`, () => {
      const ordinary = kind === "release_file" ? 0o600 : 0o700;
      const type = kind === "directory" ? 0o040000 : 0o100000;
      assert.equal(privateRecoveryToolModeAllowedV1(ordinary, kind), true);
      assert.equal(privateRecoveryToolModeAllowedV1(type | ordinary, kind), true);
      assert.equal(privateRecoveryToolModeAllowedV1(ordinary | bit, kind), false);
      assert.equal(privateRecoveryToolModeAllowedV1(type | ordinary | bit, kind), false);
    });
    test(`filesystem acquisition refuses retained ${name} mode on ${kind}`, async t => {
      const f = await fixture(t);
      const target = kind === "executable" ? f.input.executables.pg_dump.path
        : kind === "release_file" ? join(f.input.releaseRoot, privateRecoveryReviewedToolPathsV1[0]) : f.input.releaseRoot;
      const mode = (kind === "release_file" ? 0o600 : 0o700) | bit;
      await chmod(target, mode);
      if (((await stat(target)).mode & 0o7777) !== mode) {
        t.skip("host filesystem strips this special bit; exact production mode predicate tested separately"); return;
      }
      await assert.rejects(openPrivateRecoveryToolPreflightV1(f.input), refusal);
    });
  }
}

test("different syntactically valid release/request pins cannot appear as authenticated authority", async t => {
  const f = await fixture(t);
  f.input.releaseDigest = sha("untrusted release assertion"); f.input.requestDigest = sha("untrusted request assertion");
  const session = await openPrivateRecoveryToolPreflightV1(f.input);
  try {
    const observation = await session.inspect();
    assert.equal(observation.pinProvenanceVerified, false); assert.equal(observation.readyForExecution, false);
    assert.ok(observation.remainingBlockers.includes("pin_provenance_missing"));
    assert.equal(JSON.stringify(observation).includes(f.input.releaseDigest), false);
    assert.equal(JSON.stringify(observation).includes(f.input.requestDigest), false);
  } finally { await session.close(); }
});

test("refuses changed bytes, exact-byte replacement and a changed release directory after acquisition", async t => {
  for (const mode of ["contents", "inode", "directory"] as const) {
    const f = await fixture(t), session = await openPrivateRecoveryToolPreflightV1(f.input);
    try {
      const file = join(f.input.releaseRoot, privateRecoveryReviewedToolPathsV1[0]);
      if (mode === "contents") await writeFile(file, "altered tool", { mode: 0o600 });
      if (mode === "inode") {
        const bytes = await readFile(file); await rename(file, `${file}.old`); await writeFile(file, bytes, { mode: 0o600 });
      }
      if (mode === "directory") {
        const dir = join(f.input.releaseRoot, "deploy"); await rename(dir, `${dir}-old`); await symlink(`${dir}-old`, dir);
      }
      await assert.rejects(session.inspect(), refusal);
    } finally { assert.equal((await session.close()).retired, true); }
  }
});

test("refuses executable symlinks and release-root symlinks before reporting pinned files", async t => {
  const f = await fixture(t), executable = f.input.executables.pg_dump.path;
  await rename(executable, `${executable}-target`); await symlink(`${executable}-target`, executable);
  await assert.rejects(openPrivateRecoveryToolPreflightV1(f.input), refusal);
  const g = await fixture(t), root = g.input.releaseRoot;
  await rename(root, `${root}-target`); await symlink(`${root}-target`, root);
  await assert.rejects(openPrivateRecoveryToolPreflightV1(g.input), refusal);
});

test("cancellation does not turn a previous successful inspection into fresh evidence; cleanup remains available", async t => {
  const f = await fixture(t);
  let signalGetterReads = 0;
  Object.defineProperty(f.input.signal, "aborted", { get() { signalGetterReads++; return false; } });
  const session = await openPrivateRecoveryToolPreflightV1(f.input);
  f.controller.abort(); await assert.rejects(session.inspect(), refusal);
  assert.equal((await session.close()).retired, true);
  await assert.rejects(openPrivateRecoveryToolPreflightV1(f.input), refusal);
  assert.equal(signalGetterReads, 0);
});

test("rejects concurrent inspection or retirement rather than releasing a handle while hashing", async t => {
  const f = await fixture(t), session = await openPrivateRecoveryToolPreflightV1(f.input);
  const pending = session.inspect();
  await assert.rejects(session.inspect(), refusal); await assert.rejects(session.close(), refusal);
  assert.equal((await pending).readyForExecution, false);
  assert.equal((await session.close()).retired, true);
});
