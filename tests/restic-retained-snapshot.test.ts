import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createArtifactBackupInventoryV1 } from "../src/artifacts/v1/artifact-backup-inventory";
import { rollbackCheckpointDigestV1, type RollbackCheckpointV1 } from "../src/security/rollback-checkpoint";
import { sha256Digest } from "../src/security";
import { ResticRetainedSnapshotRunnerV1, type VerifiedDatabaseDumpBindingV1,
  type VerifiedDatabaseDumpPortV1 } from "../scripts/backup/restic-retained-snapshot";

const rawDigest = (value: Uint8Array | string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

const fakeRestic = `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
if (process.argv[2] === "version") { console.log(process.env.FAKE_BAD_VERSION ? "restic 0.18.0" : "restic 0.19.1 fake"); process.exit(0); }
const a = process.argv.slice(2), rf = a[a.indexOf("--repository-file") + 1], repo = fs.readFileSync(rf, "utf8").trim();
const command = a[4], rest = a.slice(5), statePath = path.join(repo, "state.json");
const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { snapshots: [], calls: [] };
state.calls.push(command); const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const mode = fs.existsSync(path.join(repo, "mode")) ? fs.readFileSync(path.join(repo, "mode"), "utf8").trim() : "";
if (mode === "hang" && command !== "snapshots") setInterval(() => {}, 1000);
if (command === "snapshots") { const tag = rest[rest.indexOf("--tag") + 1]; console.log(JSON.stringify(state.snapshots.filter(x => x.tags.includes(tag)))); save(); }
else if (command === "backup") {
  const tag = rest[rest.indexOf("--tag") + 1], id = String(state.snapshots.length + 1).padStart(64, "a");
  const dest = path.join(repo, "snapshots", id); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.cpSync(process.cwd(), dest, { recursive: true });
  state.snapshots.push({ id, tags: [tag] }); if (mode === "duplicate") state.snapshots.push({ id: "b".repeat(64), tags: [tag] }); save();
  if (mode === "fail-after-store") process.exit(2); console.log(JSON.stringify({ snapshot_id: id }));
} else if (command === "check") { save(); if (mode === "corrupt") process.exit(2); }
else if (command === "restore") { const id = rest[0], target = rest[rest.indexOf("--target") + 1], snap = state.snapshots.find(x => x.id === id); if (!snap) process.exit(3); fs.cpSync(path.join(repo, "snapshots", id), target, { recursive: true }); save(); }
else process.exit(4);
`;

async function privateFile(path: string, value: string | Uint8Array, mode = 0o600) {
  await writeFile(path, value, { mode }); await chmod(path, mode); return path;
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-restic-"))); await chmod(root, 0o700);
  const stateRoot = join(root, "state"), repository = join(root, "repository"), restoreParent = join(root, "restores");
  await mkdir(stateRoot, { mode: 0o700 }); await mkdir(repository, { mode: 0o700 }); await mkdir(restoreParent, { mode: 0o700 });
  const executable = await privateFile(join(root, "restic"), fakeRestic, 0o700);
  const repositoryFile = await privateFile(join(root, "repository-file"), `${repository}\n`);
  const passwordFile = await privateFile(join(root, "password-file"), "disposable-password\n");
  const bindingKeyFile = await privateFile(join(root, "binding-key"), Buffer.alloc(32, 7));
  const dumpBytes = Buffer.from("verified disposable database dump\n"), artifactBytes = Buffer.from("artifact bytes\n");
  const databaseDumpPath = await privateFile(join(root, "database.dump"), dumpBytes);
  const artifactPath = await privateFile(join(root, "artifact.bin"), artifactBytes);
  const checkpoint: RollbackCheckpointV1 = { schema: "control-room-rollback-checkpoint/v1", scope: "tenant:test",
    revision: 7, recordCount: 12, stateDigest: sha256Digest("database-state"),
    stateAuthTag: `hmac-sha256:${"1".repeat(64)}` };
  const checkpointPath = await privateFile(join(root, "checkpoint.json"), `${JSON.stringify(checkpoint)}\n`);
  const inventory = createArtifactBackupInventoryV1({ tenantId: "tenant:test", releaseId: "release:test",
    releaseDigest: sha256Digest("release"), databaseSchemaVersion: "schema:65", databaseSchemaDigest: sha256Digest("schema"),
    storageNamespace: "artifacts:test", storageNamespaceDigest: sha256Digest("namespace"), entries: [{ artifactId: "artifact:test",
      contentHash: rawDigest(artifactBytes), sizeBytes: artifactBytes.byteLength, manifestDigest: sha256Digest("manifest"),
      receiptDigest: sha256Digest("receipt") }] });
  const artifactInventoryPath = await privateFile(join(root, "inventory.json"), `${JSON.stringify(inventory)}\n`);
  const database: VerifiedDatabaseDumpBindingV1 = { tenantId: inventory.tenantId, releaseId: inventory.releaseId,
    identityDigest: sha256Digest("database-identity"), dumpDigest: rawDigest(dumpBytes), dumpSizeBytes: dumpBytes.byteLength,
    databaseSchemaVersion: inventory.databaseSchemaVersion, databaseSchemaDigest: inventory.databaseSchemaDigest,
    artifactInventoryDigest: inventory.inventoryDigest, checkpointDigest: rollbackCheckpointDigestV1(checkpoint) };
  let backupChecks = 0, restoreChecks = 0;
  const port: VerifiedDatabaseDumpPortV1 = {
    async verifyBackupInput({ identity, dumpPath }) { backupChecks++; assert.equal(identity, "db:test"); assert.equal(dumpPath, databaseDumpPath); return database; },
    async verifyRestoredDump({ identity, dumpPath, expected }) { restoreChecks++; assert.equal(identity, "db:test");
      assert.deepEqual(expected, database); assert.equal(rawDigest(await readFile(dumpPath)), database.dumpDigest);
      return { identityDigest: database.identityDigest, dumpDigest: database.dumpDigest }; },
  };
  const configuration = { resticExecutable: executable, repositoryFile, passwordFile,
    bindingKeyFile, stateRoot, timeoutMs: 1_000, outputLimitBytes: 65_536 };
  const runner = new ResticRetainedSnapshotRunnerV1(configuration, port);
  const input = { databaseIdentity: "db:test", databaseDumpPath, artifactInventoryPath,
    artifactFiles: [{ artifactId: "artifact:test", path: artifactPath }], checkpointPath,
    signal: new AbortController().signal, now: () => Date.parse("2026-09-13T12:00:00.000Z") };
  return { root, stateRoot, repository, restoreParent, executable, repositoryFile, passwordFile, bindingKeyFile,
    databaseDumpPath, artifactPath, artifactInventoryPath, checkpointPath, database, runner, input, port, configuration,
    counts: () => ({ backupChecks, restoreChecks }) };
}

async function cleanup(root: string) { await rm(root, { recursive: true, force: true }); }

test("retains one exact snapshot, reconciles a lost acknowledgement, and restores only to a new target", async () => {
  const f = await fixture(); try {
    const first = await f.runner.backup(f.input); assert.equal(first.replayed, false);
    const restarted = new ResticRetainedSnapshotRunnerV1(f.configuration, f.port);
    const replay = await restarted.backup({ ...f.input, now: () => Date.parse("2026-09-13T13:00:00.000Z") });
    assert.equal(replay.replayed, true); assert.equal(replay.binding.snapshotId, first.binding.snapshotId);
    const state = JSON.parse(await readFile(join(f.repository, "state.json"), "utf8"));
    assert.equal(state.snapshots.length, 1); assert.equal(state.calls.filter((value: string) => value === "backup").length, 1);
    assert.deepEqual(await readdir(join(f.stateRoot, "staging")), []);
    const targetPath = join(f.restoreParent, "new-target");
    const restored = await f.runner.restore({ bindingDigest: first.binding.bindingDigest, databaseIdentity: "db:test",
      targetPath, signal: new AbortController().signal, now: f.input.now });
    assert.equal(restored.exactMatch, true); assert.equal(restored.advancesCheckpoint, false); assert.equal(restored.deletesData, false);
    assert.deepEqual(f.counts(), { backupChecks: 2, restoreChecks: 1 });
    await assert.rejects(() => f.runner.restore({ bindingDigest: first.binding.bindingDigest, databaseIdentity: "db:test",
      targetPath, signal: new AbortController().signal }), /retained_backup_unavailable/);
  } finally { await cleanup(f.root); }
});

test("changed verified inputs create a distinct retained identity", async () => {
  const f = await fixture(); try {
    const first = await f.runner.backup(f.input);
    const changedBytes = Buffer.from("different verified database dump\n"); await privateFile(f.databaseDumpPath, changedBytes);
    f.database.dumpDigest = rawDigest(changedBytes); f.database.dumpSizeBytes = changedBytes.byteLength;
    const second = await f.runner.backup(f.input);
    assert.notEqual(second.binding.bindingDigest, first.binding.bindingDigest);
    const state = JSON.parse(await readFile(join(f.repository, "state.json"), "utf8")); assert.equal(state.snapshots.length, 2);
  } finally { await cleanup(f.root); }
});

test("refuses partial artifacts, insecure inputs, wrong restic versions, and missing repository selection", async () => {
  const f = await fixture(); try {
    await privateFile(f.artifactPath, "partial");
    await assert.rejects(() => f.runner.backup(f.input), /retained_backup_unavailable/);
    await privateFile(f.artifactPath, "artifact bytes\n", 0o644);
    await assert.rejects(() => f.runner.backup(f.input), /retained_backup_unavailable/);
    await chmod(f.artifactPath, 0o600); await rm(f.repositoryFile);
    await assert.rejects(() => f.runner.backup(f.input), /retained_backup_unavailable/);
    await privateFile(f.repositoryFile, `${f.repository}\n`);
    await privateFile(f.executable, fakeRestic.replace("restic 0.19.1 fake", "restic 0.18.0 fake"), 0o700);
    await assert.rejects(() => f.runner.backup(f.input), /retained_backup_unavailable/);
  } finally { await cleanup(f.root); }
});

test("refuses symlink and relative-path traversal inputs and detects authenticated binding tampering", async () => {
  const f = await fixture(); try {
    const link = join(f.root, "artifact-link"); await symlink(f.artifactPath, link);
    await assert.rejects(() => f.runner.backup({ ...f.input,
      artifactFiles: [{ artifactId: "artifact:test", path: link }] }), /retained_backup_unavailable/);
    const first = await f.runner.backup(f.input);
    await assert.rejects(() => f.runner.restore({ bindingDigest: first.binding.bindingDigest, databaseIdentity: "db:test",
      targetPath: "../relative-target", signal: new AbortController().signal }), /retained_backup_unavailable/);
    const path = join(f.stateRoot, "bindings", `${first.binding.bindingDigest.slice("sha256:".length)}.json`);
    const binding = JSON.parse(await readFile(path, "utf8")); binding.snapshotId = "f".repeat(64);
    await privateFile(path, `${JSON.stringify(binding)}\n`);
    await assert.rejects(() => f.runner.restore({ bindingDigest: first.binding.bindingDigest, databaseIdentity: "db:test",
      targetPath: join(f.restoreParent, "tampered"), signal: new AbortController().signal }), /retained_backup_unavailable/);
  } finally { await cleanup(f.root); }
});

test("timeout, cancellation, and an uncertain stored snapshot fail closed without automatic replay", async () => {
  const f = await fixture(); try {
    await privateFile(join(f.repository, "mode"), "hang");
    const short = new ResticRetainedSnapshotRunnerV1({ resticExecutable: f.executable, repositoryFile: f.repositoryFile,
      passwordFile: f.passwordFile, bindingKeyFile: f.bindingKeyFile, stateRoot: f.stateRoot,
      timeoutMs: 250, outputLimitBytes: 65_536 }, { verifyBackupInput: async () => f.database,
      verifyRestoredDump: async () => ({ identityDigest: f.database.identityDigest, dumpDigest: f.database.dumpDigest }) });
    await assert.rejects(() => short.backup(f.input), /snapshot_uncertain/);
    assert.deepEqual(await readdir(join(f.stateRoot, "staging")), []);
  } finally { await cleanup(f.root); }

  const g = await fixture(); try {
    await privateFile(join(g.repository, "mode"), "duplicate");
    await assert.rejects(() => g.runner.backup(g.input), /snapshot_uncertain/);
    const before = JSON.parse(await readFile(join(g.repository, "state.json"), "utf8")).calls.filter((x: string) => x === "backup").length;
    await assert.rejects(() => g.runner.backup(g.input), /snapshot_uncertain/);
    const after = JSON.parse(await readFile(join(g.repository, "state.json"), "utf8")).calls.filter((x: string) => x === "backup").length;
    assert.equal(after, before);
  } finally { await cleanup(g.root); }

  const lost = await fixture(); try {
    await privateFile(join(lost.repository, "mode"), "fail-after-store");
    await assert.rejects(() => lost.runner.backup(lost.input), /snapshot_uncertain/);
    const before = JSON.parse(await readFile(join(lost.repository, "state.json"), "utf8")).calls
      .filter((x: string) => x === "backup").length;
    await assert.rejects(() => lost.runner.backup(lost.input), /snapshot_uncertain/);
    const after = JSON.parse(await readFile(join(lost.repository, "state.json"), "utf8")).calls
      .filter((x: string) => x === "backup").length;
    assert.equal(after, before);
  } finally { await cleanup(lost.root); }

  const h = await fixture(); try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(() => h.runner.backup({ ...h.input, signal: controller.signal }), /retained_backup_unavailable/);
    await assert.rejects(() => h.runner.restore({ bindingDigest: sha256Digest("none"), databaseIdentity: "db:test",
      targetPath: join(h.restoreParent, "cancelled"), signal: controller.signal }), /retained_backup_unavailable/);
  } finally { await cleanup(h.root); }
});
