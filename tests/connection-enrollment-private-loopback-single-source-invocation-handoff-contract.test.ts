import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1,
  connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1,
  connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1,
  parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1,
  parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1,
} from "../src/connection-registry/v1/private-loopback-single-source-invocation-handoff-contract";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-single-source-invocation-handoff-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1
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

test("CR13A-LIVE-430 binds exact accepted LIVE-340 and LIVE-420 evidence", async () => {
  const contract = connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1;
  assert.equal(contract.live340ProductCommit, "3108a8759863c4692ade2d5532e88cd28f259779");
  assert.equal(contract.acceptedLive340ReviewSha256,
    "bbe5b2bc027ad0d71838ab1784ed1081750ffb96eba9ae1b26fd162b6a9234af");
  assert.equal(contract.live420ProductCommit, "c1287817079e6951ab5d1fbe24829cccc517687d");
  assert.equal(contract.acceptedLive420ReviewSha256,
    "6b472475d1e8d8bb9193b1b1df133316b8a939fbdec8c52e1e5b63bfd2308119");
  const live340Review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_340_INDEPENDENT_REVIEW.md"));
  const live420Review = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_420_INDEPENDENT_REVIEW.md"));
  assert.equal(createHash("sha256").update(live340Review).digest("hex"), contract.acceptedLive340ReviewSha256);
  assert.equal(createHash("sha256").update(live420Review).digest("hex"), contract.acceptedLive420ReviewSha256);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1(contract), contract);
});

test("CR13A-LIVE-430 freezes complete property, rule, stage, blocker, and outcome sets", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1, [
    "platform", "architecture", "release", "uptimeSeconds", "runtimeVersion", "executablePath",
    "processIdentifier", "parentProcessIdentifier",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1.length, 19);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1.length, 13);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1.length, 12);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1, [
    "not_attempted", "rejected_before_invocation", "terminal_source_invocation_failed",
    "terminal_raw_observation_invalid", "terminal_private_handoff_unavailable",
    "completed_private_handoff_and_stopped_before_attestation",
  ]);
  for (const value of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_PROPERTIES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_STAGES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_BLOCKERS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_OUTCOMES_V1]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("CR13A-LIVE-430 permits only one future direct private synchronous source call", () => {
  const contract = connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1;
  assert.equal(contract.maximumFutureSourceInvocations, 1);
  assert.equal(contract.maximumCurrentSourceInvocations, 0);
  assert.equal(contract.maximumFutureNativeOperations, 8);
  assert.equal(contract.maximumCurrentNativeOperations, 0);
  for (const key of ["sameSourceOwningModuleRequired", "unbrokenPrivateControlFlowRequired",
    "exactModuleMintedSourceRequired", "synchronousInvocationRequired", "noReceiverRequired", "noArgumentsRequired",
    "exactFrozenOwnDataObservationRequired", "directPrivateAttestationHandoffRequired",
    "sourceAndRawReferenceErasureRequired",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["publicLookupResultAuthorizesInvocation", "callerSourceAllowed", "callerRawObservationAllowed",
    "callerNativeBindingAllowed", "callbackOrContinuationAllowed", "asynchronousBoundaryAllowed",
    "rawObservationExportAllowed", "rawObservationDigestAllowed", "rawObservationPersistenceAllowed",
    "secondLookupAllowed", "secondInvocationAllowed",
  ] as const) assert.equal(contract[key], false, key);
});

test("CR13A-LIVE-430 makes every post-spend failure terminal without another authority path", () => {
  const contract = connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1;
  for (const key of ["retryAllowed", "replacementAuthorizationAllowed", "refundOrUnconsumeAllowed", "fallbackAllowed",
    "sourceInvocationImplemented", "rawObservationValidationImplemented", "rawObservationHandoffImplemented",
    "attestationImplemented", "signerImplemented", "replayCheckpointImplemented", "candidateAssemblerImplemented",
    "ownerAuthorizationPresent", "physicalAttemptPerformed", "runtimeWired",
  ] as const) assert.equal(contract[key], false, key);
  for (const rule of ["treat_invocation_validation_handoff_or_uncertainty_failure_as_terminal_spent",
    "prohibit_retry_replacement_refund_unconsume_fallback_second_lookup_or_second_invocation",
    "erase_lexical_source_and_raw_references_on_settlement"]) {
    assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_SINGLE_SOURCE_INVOCATION_HANDOFF_RULES_V1.includes(
      rule as never), true, rule);
  }
});

test("CR13A-LIVE-430 publishes 44 zero actuals, eight false grants, and no authority", () => {
  const status = connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 44);
  assert.deepEqual(actuals, new Array(44).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.lookupState, "accepted_guarded_private_uninvoked");
  assert.equal(status.invocationState, "contract_only_not_attempted");
  assert.equal(status.rawObservationState, "not_created");
  assert.equal(status.externalEffectOccurred, false);
});

test("CR13A-LIVE-430 rejects copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1({
    ...connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1({
    ...connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1(Symbol("source")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw native accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw native proxy"); },
    get() { executions += 1; throw new Error("raw native proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-430 freezes all public records, callables, arrays, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1,
    connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1,
    ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1,
    ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1,
    parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1("raw host value");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-430 parsers retain captured intrinsics after ambient replacement", () => {
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
    parsedContract = parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1(
      connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1(
      connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-430 source contains no invocation, raw observation, native, database, or effect path", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:|import "node:|import\(/);
  assert.doesNotMatch(source,
    /private-loopback-(?:unreachable-atomic-native-observation-source|invocation-authorization-store)/);
  assert.doesNotMatch(source, /new (?:Map|Set)|createServer|\.listen\(|fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(source, /postgres|pglite|sqlite|insert into|update .* set/i);
  assert.doesNotMatch(source, /function (?:invoke|observe|handoff|attest|sign|persist)/);
  assert.doesNotMatch(source, /=>\s*(?:observe|invoke|handoff|attest|sign)/);
});

test("CR13A-LIVE-430 has only the safe connection-registry barrel as a source consumer", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers, [barrel]);
});

test("CR13A-LIVE-430 public evidence is sanitized and durable docs preserve the zero-use boundary", async () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffContractV1,
    status: connectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackSingleSourceInvocationHandoffErrorV1("raw host value"),
  });
  assert.doesNotMatch(serialized, /\/Users\/|node:owner|127\.0\.0\.1|localhost|raw host value|stack/);
  assert.doesNotMatch(serialized, /authorizationId|nonceDigest|consumedAt|recheckedAt|platformResult|releaseResult/);

  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_430_PRIVATE_SINGLE_SOURCE_INVOCATION_HANDOFF_CONTRACT.md"), "utf8");
  const plan = await readFile(resolve(root, "docs/CR3_BUILD_PLAN.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, plan, status]) {
    assert.match(text, /CR13A-LIVE-430/);
    assert.match(text, /same[- ]module|source-owning module/i);
    assert.match(text, /zero (?:current )?(?:source )?invocation|zero native read|no source invocation/i);
  }
});
