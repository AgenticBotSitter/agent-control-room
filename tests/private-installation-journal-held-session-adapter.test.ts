import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planInstallationTopologyV1 } from "../src/harness/v1/installation-topology";
import { InstallationPlanFilesystemJournalV1 } from "../src/installer/v1/installation-plan-journal";
import { openInstallationPlanFilesystemStorageSessionV1 } from
  "../src/installer/v1/installation-plan-journal-storage-session";
import { createInstallationPlanV1, installationSetupStagesV1 } from "../src/installer/v1/installation-plan";
import { PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
  PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1,
  createPrivateInstallationJournalHeldSessionAdapterV1 } from
  "../src/installer/v1/private-installation-journal-held-session-adapter";
import { PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1,
  preparePrivateInstallationJournalNativeCustodyV1 } from
  "../src/installer/v1/private-installation-journal-native-custody-preparation";
import { sha256Digest } from "../src/security/canonical-digest";

const digest = (value: string) => sha256Digest(value);
const plan = () => createInstallationPlanV1({ topologyPlan: planInstallationTopologyV1({
  databaseAuthorityDigest: digest("database"), schedulerAuthorityDigest: digest("scheduler"), currentRoutes: [],
  requestedRoutes: [{ kind: "local", workerId: "worker:held", adapterId: "connector:held", adapterRevision: "0000001" }],
}), releaseDigest: digest("release"), stageInputDigests: Object.fromEntries(
  installationSetupStagesV1.map(stage => [stage, digest(stage)])) });

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "control-room-held-journal-")));
  await chmod(root, 0o700);
  const rootStat = await lstat(root, { bigint: true });
  const installationId = "local-held-installation", ownerUid = process.getuid!();
  const preparation = preparePrivateInstallationJournalNativeCustodyV1({
    schema: PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1, journalRootPath: root, installationId,
    expectedRootIdentity: { device: Number(rootStat.dev), inode: Number(rootStat.ino) }, expectedOwnerUid: ownerUid,
    operationDeadlineMs: 5_000,
  });
  return { root, installationId, ownerUid, preparation, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("held adapter gives append one bounded native session without recursively opening read history", async () => {
  const f = await fixture(); const opens: string[] = [], events: string[] = [];
  try {
    const factory = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation: f.preparation,
      nativePort: { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
        async openSession(request) {
          opens.push(request.operation); const base = await openInstallationPlanFilesystemStorageSessionV1({
            operation: request.operation, rootDirectory: request.journalRootPath, installationId: request.installationId,
            ownerUid: request.expectedOwnerUid, signal: request.signal,
          });
          const wrap = <T extends (...args: never[]) => unknown>(name: string, method: T): T =>
            ((...args: never[]) => { events.push(name); return method(...args); }) as T;
          return {
            schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
            operation: request.operation,
            listEntryNames: wrap("list", base.listEntryNames), statEntry: wrap("stat", base.statEntry),
            readEntry: wrap("read", base.readEntry), createExclusiveEntry: wrap("create", base.createExclusiveEntry),
            writeExactBounded: wrap("write", base.writeExactBounded), syncFile: wrap("sync_file", base.syncFile),
            linkNoReplace: wrap("link", base.linkNoReplace), unlinkExact: wrap("unlink", base.unlinkExact),
            syncDirectory: wrap("sync_directory", base.syncDirectory), verifyRoot: wrap("verify", base.verifyRoot),
            close: wrap("close", base.close),
          };
        } } });
    const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid }, factory);
    const result = await journal.append(plan());
    assert.equal(result.replayed, false); assert.deepEqual(opens, ["append"]);
    assert.equal(events.at(-1), "close");
    assert.ok(events.indexOf("list") < events.indexOf("create"));
    assert.ok(events.indexOf("write") < events.indexOf("sync_file"));
    assert.ok(events.indexOf("sync_file") < events.indexOf("link"));
    assert.ok(events.indexOf("link") < events.lastIndexOf("read"));
    assert.ok(events.lastIndexOf("read") < events.lastIndexOf("verify"));
  } finally { await f.cleanup(); }
});

test("native identities, entries, and bytes are validated and retained only as frozen snapshots", async () => {
  const f = await fixture();
  const createdNative = { device: 31n, inode: 41n };
  const statNative = { identity: { device: 51n, inode: 61n }, kind: "file" as const,
    ownerUid: f.ownerUid, mode: 0o600, linkCount: 1, size: 3, canonical: true };
  const readNative = { entry: { identity: { device: 71n, inode: 81n }, kind: "file" as const,
    ownerUid: f.ownerUid, mode: 0o600, linkCount: 1, size: 3, canonical: true },
    bytes: new Uint8Array([1, 2, 3]) };
  const targetName = `${f.installationId}.installation-plan.revision-0000000000.json`;
  const namesNative = [targetName];
  let forwardedIdentity: Readonly<{ device: bigint; inode: bigint }> | undefined;
  try {
    const adapter = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation: f.preparation,
      nativePort: { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
        async openSession(request) {
          return { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
            operation: request.operation, async listEntryNames() { return namesNative; }, async statEntry() { return statNative; },
            async readEntry() { return readNative; }, async createExclusiveEntry() { return createdNative; },
            async writeExactBounded(_name, identity) { forwardedIdentity = identity; }, async syncFile() {},
            async linkNoReplace() {}, async unlinkExact() {}, async syncDirectory() {}, async verifyRoot() {},
            async close() {} };
        } } });
    const session = await adapter({ operation: "append", rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid });
    const names = await session.listEntryNames();
    const stat = await session.statEntry(targetName);
    const read = await session.readEntry(targetName, 65_536);
    assert.ok(stat); assert.equal(Object.isFrozen(stat), true); assert.equal(Object.isFrozen(stat.identity), true);
    assert.equal(Object.isFrozen(read), true); assert.equal(Object.isFrozen(read.entry), true);
    assert.equal(Object.isFrozen(read.entry.identity), true);
    statNative.identity.device = 500n; statNative.size = 99;
    readNative.entry.identity.device = 700n; readNative.entry.size = 99; readNative.bytes[0] = 9;
    namesNative[0] = "mutated";
    assert.deepEqual(names, [targetName]); assert.equal(Object.isFrozen(names), true);
    assert.deepEqual(stat, { identity: { device: 51n, inode: 61n }, kind: "file", ownerUid: f.ownerUid,
      mode: 0o600, linkCount: 1, size: 3, canonical: true });
    assert.equal(read.entry.identity.device, 71n); assert.equal(read.entry.size, 3);
    assert.deepEqual([...read.bytes], [1, 2, 3]);

    const tempName = `${f.installationId}.installation-plan.revision-0000000000.bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.tmp`;
    const created = await session.createExclusiveEntry(tempName);
    assert.equal(Object.isFrozen(created), true); createdNative.device = 999n;
    await session.writeExactBounded(tempName, created, new Uint8Array([1]), 65_536);
    assert.deepEqual(forwardedIdentity, { device: 31n, inode: 41n });
    assert.equal(Object.isFrozen(forwardedIdentity), true);
    await session.unlinkExact(tempName, created); await session.close();
  } finally { await f.cleanup(); }
});

test("native proxy and accessor identities fail closed without invoking accessors", async () => {
  const f = await fixture(); let opens = 0, getterCalls = 0;
  try {
    const accessor: Record<string, unknown> = { inode: 2n };
    Object.defineProperty(accessor, "device", { enumerable: true, get() { getterCalls += 1; return 1n; } });
    const adapter = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation: f.preparation,
      nativePort: { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
        async openSession(request) {
          opens += 1;
          const identity = opens === 1 ? new Proxy({ device: 1n, inode: 2n }, {}) : accessor;
          return { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
            operation: request.operation, async listEntryNames() { return []; }, async statEntry() { return undefined; },
            async readEntry() { throw new Error("unused"); }, async createExclusiveEntry() { return identity; },
            async writeExactBounded() {}, async syncFile() {}, async linkNoReplace() {}, async unlinkExact() {},
            async syncDirectory() {}, async verifyRoot() {}, async close() {} };
        } } });
    const name = `${f.installationId}.installation-plan.revision-0000000000.cccccccc-cccc-4ccc-8ccc-cccccccccccc.tmp`;
    const proxySession = await adapter({ operation: "append", rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid });
    await assert.rejects(() => proxySession.createExclusiveEntry(name),
      /private_installation_journal_held_session_uncertain/u);
    await proxySession.close();
    const accessorSession = await adapter({ operation: "append", rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid });
    await assert.rejects(() => accessorSession.createExclusiveEntry(name),
      /private_installation_journal_held_session_uncertain/u);
    assert.equal(getterCalls, 0); await accessorSession.close();
  } finally { await f.cleanup(); }
});

test("proxy-wrapped native read bytes fail closed without invoking proxy traps", async () => {
  const f = await fixture(); let trapCalls = 0;
  try {
    const targetName = `${f.installationId}.installation-plan.revision-0000000000.json`;
    const bytes = new Proxy(new Uint8Array([1, 2, 3]), {
      getPrototypeOf(target) { trapCalls += 1; return Reflect.getPrototypeOf(target); },
      get(target, property, receiver) { trapCalls += 1; return Reflect.get(target, property, receiver); },
    });
    const adapter = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation: f.preparation,
      nativePort: { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
        async openSession(request) {
          return { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
            operation: request.operation, async listEntryNames() { return []; }, async statEntry() { return undefined; },
            async readEntry() { return { entry: { identity: { device: 1n, inode: 2n }, kind: "file" as const,
              ownerUid: f.ownerUid, mode: 0o600, linkCount: 1, size: 3, canonical: true }, bytes }; },
            async createExclusiveEntry() { throw new Error("unused"); }, async writeExactBounded() {}, async syncFile() {},
            async linkNoReplace() {}, async unlinkExact() {}, async syncDirectory() {}, async verifyRoot() {},
            async close() {} };
        } } });
    const session = await adapter({ operation: "inspect_settled_history", rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid });
    await assert.rejects(() => session.readEntry(targetName, 65_536),
      /private_installation_journal_held_session_uncertain/u);
    assert.equal(trapCalls, 0); await session.close();
  } finally { await f.cleanup(); }
});

test("proxy-wrapped caller write bytes fail closed without invoking proxy traps", async () => {
  const f = await fixture(); let trapCalls = 0, nativeWriteCalls = 0;
  try {
    const identity = { device: 1n, inode: 2n };
    const bytes = new Proxy(new Uint8Array([1]), {
      getPrototypeOf(target) { trapCalls += 1; return Reflect.getPrototypeOf(target); },
      get(target, property, receiver) { trapCalls += 1; return Reflect.get(target, property, receiver); },
    });
    const adapter = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation: f.preparation,
      nativePort: { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
        async openSession(request) {
          return { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
            operation: request.operation, async listEntryNames() { return []; }, async statEntry() { return undefined; },
            async readEntry() { throw new Error("unused"); }, async createExclusiveEntry() { return identity; },
            async writeExactBounded() { nativeWriteCalls += 1; }, async syncFile() {}, async linkNoReplace() {},
            async unlinkExact() {}, async syncDirectory() {}, async verifyRoot() {}, async close() {} };
        } } });
    const session = await adapter({ operation: "append", rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid });
    const tempName = `${f.installationId}.installation-plan.revision-0000000000.dddddddd-dddd-4ddd-8ddd-dddddddddddd.tmp`;
    const created = await session.createExclusiveEntry(tempName);
    await assert.rejects(() => session.writeExactBounded(tempName, created, bytes, 65_536),
      /private_installation_journal_held_session_uncertain/u);
    assert.equal(trapCalls, 0); assert.equal(nativeWriteCalls, 0);
    await session.unlinkExact(tempName, created); await session.close();
  } finally { await f.cleanup(); }
});

test("held adapter bounds capabilities, basenames, bytes, abort, and confirmed close", async () => {
  const f = await fixture(); let closeCalls = 0;
  try {
    const adapter = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation: f.preparation,
      nativePort: { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
        async openSession(request) {
          const base = await openInstallationPlanFilesystemStorageSessionV1({ operation: request.operation,
            rootDirectory: request.journalRootPath, installationId: request.installationId,
            ownerUid: request.expectedOwnerUid, signal: request.signal });
          return { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
            operation: request.operation, listEntryNames: base.listEntryNames, statEntry: base.statEntry,
            readEntry: base.readEntry, createExclusiveEntry: base.createExclusiveEntry,
            writeExactBounded: base.writeExactBounded, syncFile: base.syncFile, linkNoReplace: base.linkNoReplace,
            unlinkExact: base.unlinkExact, syncDirectory: base.syncDirectory, verifyRoot: base.verifyRoot,
            async close() { closeCalls += 1; await base.close(); } };
        } } });
    const inspect = await adapter({ operation: "inspect_settled_history", rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid });
    await assert.rejects(() => inspect.createExclusiveEntry(
      `${f.installationId}.installation-plan.revision-0000000000.publish.json`),
    /private_installation_journal_held_session_uncertain/u);
    await inspect.close(); assert.equal(closeCalls, 1);

    const bounded = await adapter({ operation: "append", rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid });
    await assert.rejects(() => bounded.statEntry("../escape"),
      /private_installation_journal_held_session_uncertain/u);
    const tempName = `${f.installationId}.installation-plan.revision-0000000000.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.tmp`;
    await assert.rejects(() => bounded.writeExactBounded(tempName, { device: 1n, inode: 1n },
      new Uint8Array([1]), 65_536), /private_installation_journal_held_session_uncertain/u);
    const tempIdentity = await bounded.createExclusiveEntry(tempName);
    await assert.rejects(() => bounded.writeExactBounded(tempName, tempIdentity,
      new Uint8Array(65_537), 65_536), /private_installation_journal_held_session_uncertain/u);
    await bounded.unlinkExact(tempName, tempIdentity); await bounded.close();

    const controller = new AbortController();
    const append = await adapter({ operation: "append", rootDirectory: f.root, installationId: f.installationId,
      ownerUid: f.ownerUid, signal: controller.signal });
    controller.abort();
    await assert.rejects(() => append.verifyRoot(), /private_installation_journal_held_session_uncertain/u);
    await assert.rejects(() => append.close(), /private_installation_journal_held_session_uncertain/u);
    assert.equal(closeCalls, 3, "native close is still attempted after abort and must confirm before success");
  } finally { await f.cleanup(); }
});

test("unconfirmed native close fails the journal operation closed", async () => {
  const f = await fixture();
  try {
    const adapter = createPrivateInstallationJournalHeldSessionAdapterV1({ preparation: f.preparation,
      nativePort: { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_PORT_V1,
        async openSession(request) {
          const base = await openInstallationPlanFilesystemStorageSessionV1({ operation: request.operation,
            rootDirectory: request.journalRootPath, installationId: request.installationId,
            ownerUid: request.expectedOwnerUid, signal: request.signal });
          return { schema: PRIVATE_INSTALLATION_JOURNAL_HELD_SESSION_V1, operationId: request.operationId,
            operation: request.operation, listEntryNames: base.listEntryNames, statEntry: base.statEntry,
            readEntry: base.readEntry, createExclusiveEntry: base.createExclusiveEntry,
            writeExactBounded: base.writeExactBounded, syncFile: base.syncFile, linkNoReplace: base.linkNoReplace,
            unlinkExact: base.unlinkExact, syncDirectory: base.syncDirectory, verifyRoot: base.verifyRoot,
            async close() { await base.close(); throw new Error("lost close reply"); } };
        } } });
    const journal = new InstallationPlanFilesystemJournalV1({ rootDirectory: f.root,
      installationId: f.installationId, ownerUid: f.ownerUid }, adapter);
    await assert.rejects(() => journal.append(plan()), /installation_plan_journal_unavailable/u);
  } finally { await f.cleanup(); }
});
