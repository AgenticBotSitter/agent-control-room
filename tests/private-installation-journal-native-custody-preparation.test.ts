import assert from "node:assert/strict";
import test from "node:test";
import { PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1,
  PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1,
  preparePrivateInstallationJournalNativeCustodyV1,
  privateInstallationJournalNativeAppendPrimitivesV1,
  privateInstallationJournalNativeGuaranteesV1,
  privateInstallationJournalNativeInspectionPrimitivesV1,
  privateInstallationJournalNativeRecoveryPrimitivesV1 } from
  "../src/installer/v1/private-installation-journal-native-custody-preparation";

const base = () => ({ schema: PRIVATE_INSTALLATION_JOURNAL_NATIVE_CUSTODY_PREPARATION_V1,
  journalRootPath: "/private/var/lib/agent-control-room/installation-journal",
  installationId: "local-hermes", expectedRootIdentity: { device: 42, inode: 99 },
  expectedOwnerUid: 501, operationDeadlineMs: 5_000 });

test("prepares one held descriptor-relative native boundary without constructing another journal", () => {
  const prepared = preparePrivateInstallationJournalNativeCustodyV1(base());
  assert.equal(prepared.status, "prepared");
  assert.equal(prepared.retainsInstallationPlanJournal, true);
  assert.equal(prepared.constructsJournal, false); assert.equal(prepared.createsStore, false);
  assert.equal(prepared.performsNativeOperation, false); assert.equal(prepared.readyForOperatorComposition, false);
  assert.equal(prepared.remainingBlocker, "native_held_journal_session_and_adapter_missing");
  const signal = new AbortController().signal;
  const request = prepared.prepareOperation("append", signal);
  assert.equal(request.schema, PRIVATE_INSTALLATION_JOURNAL_NATIVE_OPERATION_V1);
  assert.match(request.operationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(request.operation, "append"); assert.equal(request.signal, signal);
  assert.equal(request.expectedRootMode, 0o700); assert.equal(request.maximumPlanBytes, 64 * 1024);
  assert.equal(request.maximumWitnessBytes, 1_024);
  assert.equal(request.maximumRevisions, 10_000); assert.equal(request.mayAppend, true);
  assert.equal(request.mayMutateForRecovery, true);
  assert.equal(request.recoveryScope, "retained_publication_only");
  assert.deepEqual(request.requiredPrimitives, privateInstallationJournalNativeAppendPrimitivesV1);
  assert.equal(request.capabilities.recoversRetainedPublication, true);
  assert.equal(request.capabilities.createsExclusiveEntry, true);
  assert.equal(request.capabilities.writesExactBoundedEntry, true);
  assert.equal(request.capabilities.publishesNoReplaceHardLink, true);
  assert.equal(request.capabilities.unlinksExactIdentity, true);
  assert.equal(request.capabilities.syncsFile, true);
  assert.equal(request.capabilities.syncsDirectory, true);
  assert.ok(request.requiredPrimitives.includes("openat_create_exclusive"));
  assert.ok(request.requiredPrimitives.includes("write_exact_bounded"));
  assert.ok(request.requiredPrimitives.includes("fsync_file"));
  assert.deepEqual(request.requiredGuarantees, privateInstallationJournalNativeGuaranteesV1);
  assert.equal(request.requiredGuarantees.holdsJournalRootUntilOperationClose, true);
  assert.equal(request.requiredGuarantees.holdsAncestorChainUntilOperationClose, true);
  assert.equal(request.requiredGuarantees.performsEveryEntryOperationRelativeToHeldRoot, true);
  assert.equal(request.requiredGuarantees.permitsPathBasedEntryOperation, false);
  assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(request.expectedRootIdentity), true);
});

test("settled inspection receives no mutation capability while read and append permit only retained recovery", () => {
  const prepared = preparePrivateInstallationJournalNativeCustodyV1(base());
  const inspect = prepared.prepareOperation("inspect_settled_history", new AbortController().signal);
  const recovery = prepared.prepareOperation("read_history", new AbortController().signal);
  assert.equal(inspect.mayMutateForRecovery, false); assert.equal(inspect.mayAppend, false);
  assert.equal(inspect.recoveryScope, "none");
  assert.deepEqual(inspect.requiredPrimitives, privateInstallationJournalNativeInspectionPrimitivesV1);
  assert.deepEqual(inspect.capabilities, { recoversRetainedPublication: false, createsExclusiveEntry: false,
    writesExactBoundedEntry: false, publishesNoReplaceHardLink: false, unlinksExactIdentity: false,
    syncsFile: false, syncsDirectory: false });
  for (const primitive of ["openat_create_exclusive", "write_exact_bounded", "fsync_file",
    "linkat_no_replace", "unlinkat_exact_identity", "fsync_directory"])
    assert.equal(inspect.requiredPrimitives.includes(primitive as never), false);
  assert.equal(recovery.mayMutateForRecovery, true); assert.equal(recovery.mayAppend, false);
  assert.equal(recovery.recoveryScope, "retained_publication_only");
  assert.deepEqual(recovery.requiredPrimitives, privateInstallationJournalNativeRecoveryPrimitivesV1);
  assert.deepEqual(recovery.capabilities, { recoversRetainedPublication: true, createsExclusiveEntry: false,
    writesExactBoundedEntry: false, publishesNoReplaceHardLink: false, unlinksExactIdentity: true,
    syncsFile: false, syncsDirectory: true });
  assert.equal(recovery.requiredPrimitives.includes("unlinkat_exact_identity"), true);
  assert.equal(recovery.requiredPrimitives.includes("fsync_directory"), true);
  for (const primitive of ["openat_create_exclusive", "write_exact_bounded", "fsync_file", "linkat_no_replace"])
    assert.equal(recovery.requiredPrimitives.includes(primitive as never), false);
  assert.notEqual(inspect.operationId, recovery.operationId);
  assert.equal(inspect.journalBindingDigest, recovery.journalBindingDigest);
});

test("append requires separate exclusive create, exact bounded write, and file sync mechanics", () => {
  const request = preparePrivateInstallationJournalNativeCustodyV1(base())
    .prepareOperation("append", new AbortController().signal);
  const create = request.requiredPrimitives.indexOf("openat_create_exclusive");
  const write = request.requiredPrimitives.indexOf("write_exact_bounded");
  const sync = request.requiredPrimitives.indexOf("fsync_file");
  const publish = request.requiredPrimitives.indexOf("linkat_no_replace");
  assert.ok(create >= 0 && write > create && sync > write && publish > sync);
  assert.equal(request.requiredGuarantees.writesExactBoundedBytesOnlyToNewlyCreatedHeldFile, true);
  assert.equal(request.maximumPlanBytes, 65_536); assert.equal(request.maximumWitnessBytes, 1_024);
});

test("binding digest binds the private pathname, identity, owner, and installation without exposing them", () => {
  const first = preparePrivateInstallationJournalNativeCustodyV1(base());
  const renamed = preparePrivateInstallationJournalNativeCustodyV1({ ...base(),
    journalRootPath: "/private/var/lib/agent-control-room/renamed-journal" });
  const replaced = preparePrivateInstallationJournalNativeCustodyV1({ ...base(),
    expectedRootIdentity: { device: 42, inode: 100 } });
  assert.notEqual(first.journalBindingDigest, renamed.journalBindingDigest);
  assert.notEqual(first.journalBindingDigest, replaced.journalBindingDigest);
  assert.doesNotMatch(first.journalBindingDigest, /private|journal/u);
});

test("rejects aliases, malformed identities, extra fields, proxies, accessors, and aborted operations", () => {
  for (const value of [
    { ...base(), journalRootPath: "/private/var/../tmp/journal" },
    { ...base(), journalRootPath: "/" },
    { ...base(), installationId: "LOCAL" },
    { ...base(), expectedRootIdentity: { device: -1, inode: 99 } },
    { ...base(), expectedOwnerUid: -1 },
    { ...base(), operationDeadlineMs: 0 },
    { ...base(), operationDeadlineMs: 30_001 },
    { ...base(), extra: true },
    new Proxy(base(), {}),
  ]) assert.throws(() => preparePrivateInstallationJournalNativeCustodyV1(value),
    /private_installation_journal_native_custody_preparation_refused/u);

  let getterCalls = 0;
  const accessor = base() as Record<string, unknown>;
  Object.defineProperty(accessor, "journalRootPath", { enumerable: true, get() { getterCalls += 1; return "/private/journal"; } });
  assert.throws(() => preparePrivateInstallationJournalNativeCustodyV1(accessor),
    /private_installation_journal_native_custody_preparation_refused/u);
  assert.equal(getterCalls, 0);

  const prepared = preparePrivateInstallationJournalNativeCustodyV1(base());
  assert.throws(() => prepared.prepareOperation("other" as never, new AbortController().signal),
    /private_installation_journal_native_custody_preparation_refused/u);
  const controller = new AbortController(); controller.abort();
  assert.throws(() => prepared.prepareOperation("append", controller.signal),
    /private_installation_journal_native_custody_preparation_refused/u);
});

test("caller mutation after construction cannot change the captured root binding", () => {
  const input = base(), prepared = preparePrivateInstallationJournalNativeCustodyV1(input);
  input.journalRootPath = "/private/replacement";
  input.expectedRootIdentity.device = 77;
  const request = prepared.prepareOperation("inspect_settled_history", new AbortController().signal);
  assert.equal(request.journalRootPath, "/private/var/lib/agent-control-room/installation-journal");
  assert.deepEqual(request.expectedRootIdentity, { device: 42, inode: 99 });
});
