import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1,
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
  connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
  parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1,
} from "../src/connection-registry/v1/private-loopback-atomic-source-lookup-bridge-contract";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-atomic-source-lookup-bridge-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1
    && error.safeCode === code && error.message === code && error.stack === undefined);
}

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && /\.(?:ts|tsx|mjs)$/.test(entry.name)) files.push(path);
  }
  return files;
}

test("CR13A-LIVE-410 binds exact accepted LIVE-330 and LIVE-400 evidence", async () => {
  const contract = connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1;
  assert.equal(contract.live330ProductCommit, "06be655d188c45902c015f85225673dfc31c445d");
  assert.equal(contract.acceptedLive330ReviewSha256,
    "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85");
  assert.equal(contract.live400ProductCommit, "ccce7c84ebfbf955f05fb7b150c1ccf9b80535b3");
  assert.equal(contract.acceptedLive400ReviewSha256,
    "fab7088cf3bcfbcd8a9a14de6af9d58e8ca3471057230ea8cc73acb6660f86ce");
  for (const [file, digest] of [
    ["CR13A_LIVE_330_INDEPENDENT_REVIEW.md", contract.acceptedLive330ReviewSha256],
    ["CR13A_LIVE_400_INDEPENDENT_REVIEW.md", contract.acceptedLive400ReviewSha256],
  ] as const) {
    const report = await readFile(resolve(root, "docs/reviews", file));
    assert.equal(createHash("sha256").update(report).digest("hex"), digest);
  }
  assert.match(contract.contractReference, /^atomic-source-lookup-bridge:[a-f0-9]{24}$/);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1(contract), contract);
});

test("CR13A-LIVE-410 freezes complete rule, stage, blocker, and outcome sets", () => {
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1.length, 16);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1.slice(3, 8), [
    "use_unbroken_private_control_flow_as_authority",
    "reject_public_success_result_as_lookup_authority",
    "reject_receipt_boolean_digest_identity_or_caller_assertion_as_authority",
    "consolidate_final_success_branch_and_source_storage_in_one_private_module",
    "prohibit_exported_map_key_source_getter_callback_token_or_bridge",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1.length, 14);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1[7],
    "single_same_module_private_source_lookup");
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1.slice(0, 4), [
    "live400_private_success_not_exposed_and_must_remain_unexported",
    "live330_private_source_has_no_lookup",
    "same_module_consolidation_not_implemented",
    "private_source_lookup_bridge_not_implemented",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1.length, 13);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1, [
    "not_attempted", "rejected_before_spend", "terminal_spend_uncertain", "terminal_already_consumed",
    "terminal_recheck_failed", "terminal_private_provenance_failed", "terminal_source_lookup_failed",
  ]);
  for (const value of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_RULES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_STAGES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_BLOCKERS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ATOMIC_SOURCE_LOOKUP_BRIDGE_OUTCOMES_V1]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("CR13A-LIVE-410 makes private control-flow provenance the only future lookup authority", () => {
  const contract = connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1;
  for (const key of ["sameModuleConsolidationRequired", "unbrokenPrivateControlFlowRequired",
    "exactFreshSpendRequired", "exactImmediateRecheckRequired", "exactStoredSourceRequired",
    "directPrivateInvocationHandoffRequired", "rawObservationPrivateRequired", "contractImplemented",
    "live330DependencyAccepted", "live400DependencyAccepted", "repositoryContractOnly",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["publicSuccessResultAuthorizesLookup", "callerSuppliedSuccessAllowed",
    "callerSuppliedReceiptAllowed", "publicObjectIdentityAuthorizesLookup", "exportedBridgeAllowed",
    "callbackAllowed",
  ] as const) assert.equal(contract[key], false, key);
  assert.equal(contract.maximumFutureSourceLookups, 1);
  assert.equal(contract.maximumCurrentSourceLookups, 0);
  assert.equal(contract.maximumFutureSourceInvocations, 1);
});

test("CR13A-LIVE-410 makes every failure terminal without a second authority path", () => {
  const contract = connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1;
  for (const key of ["retryAllowed", "replacementAuthorizationAllowed", "refundOrUnconsumeAllowed",
    "fallbackAllowed", "secondLookupAllowed", "sameModuleConsolidationImplemented",
    "privateSuccessStateImplemented", "lookupBridgeImplemented", "sourceLookedUp", "sourceInvoked",
    "rawObservationCreated", "attestationImplemented", "candidateAssemblerImplemented",
    "ownerAuthorizationPresent", "physicalAttemptPerformed", "runtimeWired",
  ] as const) assert.equal(contract[key], false, key);
});

test("CR13A-LIVE-410 publishes 32 zero actuals, eight false grants, and no authority", () => {
  const status = connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 32);
  assert.deepEqual(actuals, new Array(32).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.sourceState, "accepted_stored_unreachable_uninvoked");
  assert.equal(status.compositionState, "accepted_stopped_before_lookup");
  assert.equal(status.bridgeState, "contract_only");
  assert.equal(status.sourceBoundaryCrossed, false);
  assert.equal(status.externalEffectOccurred, false);
});

test("CR13A-LIVE-410 rejects copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1({
    ...connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1({
    ...connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1(Symbol("source")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw source accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw source proxy"); },
    get() { executions += 1; throw new Error("raw source proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-410 freezes records, parsers, arrays, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
    connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1,
    ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1,
    ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
    parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1("raw source");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-410 parsers retain captured intrinsics after ambient replacement", () => {
  const originalIsFrozen = Object.isFrozen;
  const originalWeakSetHas = WeakSet.prototype.has;
  const originalWeakMapGet = WeakMap.prototype.get;
  const originalArraySome = Array.prototype.some;
  const originalReflectApply = Reflect.apply;
  const executions = new Array(5).fill(0);
  let parsedContract: unknown;
  let parsedStatus: unknown;
  try {
    Object.isFrozen = () => { executions[0] += 1; return false; };
    WeakSet.prototype.has = function () { executions[1] += 1; return false; };
    WeakMap.prototype.get = function () { executions[2] += 1; return undefined; };
    Array.prototype.some = function () { executions[3] += 1; throw new Error("raw ambient"); };
    Reflect.apply = () => { executions[4] += 1; throw new Error("raw ambient"); };
    parsedContract = parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1(
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1(
      connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-410 source contains no executable composition, source, database, native, or effect path", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:|import "node:|import\(/);
  assert.doesNotMatch(source, /private-loopback-(?:invocation-authorization-store|fresh-spend-recheck-composition|unreachable-atomic-native-observation-source)/);
  assert.doesNotMatch(source, /new (?:Map|Set)|createServer|\.listen\(|fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(source, /postgres|pglite|sqlite|insert into|update .* set/i);
  assert.doesNotMatch(source, /function (?:consume|recheck|retrieve|lookup|invoke|observe)/);
});

test("CR13A-LIVE-410 has only the safe connection-registry barrel as a source consumer", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers, [barrel]);
});

test("CR13A-LIVE-410 public evidence is sanitized and durable docs preserve the inert boundary", async () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeContractV1,
    status: connectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackAtomicSourceLookupBridgeErrorV1("raw source"),
  });
  assert.doesNotMatch(serialized,
    /authorizationId|authorizationBody|nonceDigest|consumedAt|recheckedAt|executablePath|processIdentifier|hostname/);
  assert.doesNotMatch(serialized, /stack|raw source|127\.0\.0\.1|localhost/);

  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_410_PRIVATE_ATOMIC_SOURCE_LOOKUP_BRIDGE_CONTRACT.md"), "utf8");
  const plan = await readFile(resolve(root, "docs/CR3_BUILD_PLAN.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, plan, status]) {
    assert.match(text, /CR13A-LIVE-410/);
    assert.match(text, /public (?:LIVE-400 )?(?:success )?(?:result|outcome)/i);
    assert.match(text, /inert/i);
  }
});
