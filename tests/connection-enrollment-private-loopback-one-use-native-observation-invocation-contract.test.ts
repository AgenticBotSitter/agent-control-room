import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1,
  connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1,
  connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1,
  parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1,
  parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1,
} from "../src/connection-registry/v1/private-loopback-one-use-native-observation-invocation-contract";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-one-use-native-observation-invocation-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1
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

test("CR13A-LIVE-340 binds the exact accepted LIVE-330 evidence", async () => {
  const contract = connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1;
  assert.equal(contract.live330ProductCommit, "06be655d188c45902c015f85225673dfc31c445d");
  assert.equal(contract.acceptedLive330ReviewSha256,
    "da2c7529b8a5e023b706df8e6ab912e2096c2742edfda0e74758991721031f85");
  const report = await readFile(resolve(root, "docs/reviews/CR13A_LIVE_330_INDEPENDENT_REVIEW.md"));
  assert.equal(createHash("sha256").update(report).digest("hex"), contract.acceptedLive330ReviewSha256);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1(contract),
    contract);
});

test("CR13A-LIVE-340 freezes exact operation, binding, rule, stage, blocker, and outcome sets", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1,
    ["observe_target_runtime_once"]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1.length, 15);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1.length, 15);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1.length, 16);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1.length, 15);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1.length, 5);
  for (const value of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OPERATIONS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BINDINGS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_STAGES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_BLOCKERS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_OUTCOMES_V1]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("CR13A-LIVE-340 requires atomic one-use consumption before lookup and terminal ambiguity", () => {
  const contract = connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1;
  for (const key of ["authenticatedAuthorizationRequired", "trustedBrokerTimeRequired", "freshNonceRequired",
    "independentReplayCheckpointRequired", "atomicConsumeBeforeLookupRequired",
    "postTransactionTimeRecheckRequired", "sameModuleRequired", "rawObservationPrivateRequired",
    "contractImplemented", "repositoryContractOnly",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["retryAfterCommitUncertaintyAllowed", "retryAfterSourceFailureAllowed",
    "callerNativeBindingAllowed", "callerCallableAllowed", "callbackAllowed", "replacementBindingAllowed",
    "fallbackAllowed", "partialObservationAllowed", "authorizationStoreImplemented", "authorizationCreated",
    "authorizationConsumed", "replayCheckpointImplemented", "lookupBridgeImplemented", "sourceLookedUp",
    "sourceInvoked", "rawObservationCreated", "attestationImplemented", "candidateAssemblerImplemented",
    "ownerAuthorizationPresent", "physicalAttemptPerformed", "runtimeWired", "activationEligible",
  ] as const) assert.equal(contract[key], false, key);
  assert.equal(contract.maximumAuthorizations, 1);
  assert.equal(contract.maximumSourceLookups, 1);
  assert.equal(contract.maximumSourceInvocations, 1);
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1
    .includes("consume_atomically_before_lookup"));
  assert.ok(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_ONE_USE_NATIVE_OBSERVATION_RULES_V1
    .includes("treat_commit_uncertainty_as_terminal"));
});

test("CR13A-LIVE-340 publishes 39 zero actuals and eight false grants", () => {
  const status = connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 39);
  assert.deepEqual(actuals, new Array(39).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.invocationState, "not_attempted");
  assert.equal(status.externalEffectOccurred, false);
});

test("CR13A-LIVE-340 rejects copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1({
    ...connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1({
    ...connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1(Symbol("raw")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw invocation accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw invocation proxy"); },
    get() { executions += 1; throw new Error("raw invocation proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-340 freezes records, parsers, arrays, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1,
    connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1,
    ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1,
    ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1,
    parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1("raw token");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-340 parsers retain captured intrinsics after ambient replacement", () => {
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
    parsedContract = parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1(
      connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1(
      connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-340 source contains no native import, store, token, lookup, invocation, or persistence", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:|import "node:|import\(/);
  assert.doesNotMatch(source, /unreachable-atomic-native-observation-source/);
  assert.doesNotMatch(source, /new (?:Map|Set)|createServer|\.listen\(|fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(source, /function (?:create|consume|retrieve|lookup|invoke).*Authorization/);
  assert.doesNotMatch(source, /function (?:retrieve|lookup|invoke).*NativeObservation/);
  assert.doesNotMatch(source, /postgres|pglite|sqlite|insert into|update .* set/i);
});

test("CR13A-LIVE-340 has only the safe barrel as a production consumer", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers, [barrel]);
});

test("CR13A-LIVE-340 public evidence contains no authorization or native material", () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationContractV1,
    status: connectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackOneUseNativeObservationInvocationErrorV1("raw token"),
  });
  assert.doesNotMatch(serialized,
    /executablePath|processIdentifier|parentProcessIdentifier|runtimeVersion|osRelease|uptimeSeconds|hostname|username/);
  assert.doesNotMatch(serialized, /stack|raw token|127\.0\.0\.1|localhost/);
});

test("CR13A-LIVE-340 architecture, plan, and status preserve the zero-effect boundary", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_340_PRIVATE_ONE_USE_NATIVE_OBSERVATION_INVOCATION_CONTRACT.md"), "utf8");
  const plan = await readFile(resolve(root, "docs/CR3_BUILD_PLAN.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, plan, status]) {
    assert.match(text, /CR13A-LIVE-340/);
    assert.match(text, /one-use|one use/i);
    assert.match(text, /no (?:private-map |source )?lookup|no lookup, invocation/i);
  }
});
