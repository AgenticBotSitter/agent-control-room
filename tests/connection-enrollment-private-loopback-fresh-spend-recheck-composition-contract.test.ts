import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import {
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1,
  CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1,
  ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1,
  connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
  connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1,
  parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
  parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1,
} from "../src/connection-registry/v1/private-loopback-fresh-spend-recheck-composition-contract";

const root = resolve(import.meta.dirname, "..");
const moduleName = "private-loopback-fresh-spend-recheck-composition-contract";
const modulePath = resolve(root, "src/connection-registry/v1", `${moduleName}.ts`);
type SafeCode = ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1["safeCode"];

function expectCode(run: () => unknown, code: SafeCode): void {
  assert.throws(run, (error: unknown) => error instanceof
    ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1
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

test("CR13A-LIVE-390 binds exact accepted LIVE-370 and LIVE-380 evidence", async () => {
  const contract = connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1;
  assert.equal(contract.live370ProductCommit, "6f908ccd1f65f48a5d874fa0da96afe301d8decf");
  assert.equal(contract.acceptedLive370ReviewSha256,
    "c1b22f9b8012328f4709c608c4a53292be279f47070aec6136ab40293618f490");
  assert.equal(contract.live380ProductCommit, "1b79bbc75dfe74ce0777bcc33cbcc801054113f0");
  assert.equal(contract.acceptedLive380ReviewSha256,
    "4a5f60f8ca2ad08ee04f1603773279aef97558edfa27acda1604592f8ae610bd");
  for (const [file, digest] of [
    ["CR13A_LIVE_370_INDEPENDENT_REVIEW.md", contract.acceptedLive370ReviewSha256],
    ["CR13A_LIVE_380_INDEPENDENT_REVIEW.md", contract.acceptedLive380ReviewSha256],
  ] as const) {
    const report = await readFile(resolve(root, "docs/reviews", file));
    assert.equal(createHash("sha256").update(report).digest("hex"), digest);
  }
  assert.match(contract.contractReference, /^fresh-spend-recheck-composition:[a-f0-9]{24}$/);
  assert.equal(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1(contract), contract);
});

test("CR13A-LIVE-390 freezes the complete rule, stage, blocker, and outcome sets", () => {
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1, [
    "keep_spend_and_recheck_in_one_private_control_flow",
    "obtain_fresh_spend_from_own_immediately_preceding_call",
    "accept_only_fresh_consumption_receipt",
    "bind_recheck_to_same_sealed_authorization_and_spend",
    "perform_exactly_one_post_transaction_database_time_recheck",
    "accept_only_recheck_from_own_immediately_preceding_call",
    "keep_spend_and_recheck_receipts_private_and_nonexported",
    "stop_immediately_before_first_source_lookup",
    "treat_precommit_failure_as_rejected_without_source_authority",
    "treat_commit_uncertainty_as_terminal_without_retry",
    "treat_recheck_failure_after_spend_as_terminal_without_retry",
    "prohibit_replay_replacement_fallback_or_second_authorization",
    "preserve_private_source_isolation",
    "publish_only_sanitized_non_authorizing_status",
  ]);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1.length, 15);
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1[6],
    "mandatory_stop_before_source_lookup");
  assert.equal(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1.length, 11);
  assert.deepEqual(CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1, [
    "not_attempted", "rejected_before_spend", "terminal_ambiguity_at_or_after_spend",
    "spent_recheck_rejected", "completed_and_stopped_before_lookup",
  ]);
  for (const value of [CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_RULES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_STAGES_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_BLOCKERS_V1,
    CONNECTION_ENROLLMENT_PRIVATE_LOOPBACK_FRESH_SPEND_RECHECK_COMPOSITION_OUTCOMES_V1]) {
    assert.equal(Object.isFrozen(value), true);
  }
});

test("CR13A-LIVE-390 requires one own fresh spend and recheck then stops before lookup", () => {
  const contract = connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1;
  for (const key of ["samePrivateControlFlowRequired", "ownFreshSpendRequired", "ownImmediateRecheckRequired",
    "sameSealedAuthorizationRequired", "stopBeforeLookupRequired", "receiptsPrivateRequired",
    "contractImplemented", "spendImplementationAccepted", "recheckImplementationAccepted",
    "repositoryContractOnly",
  ] as const) assert.equal(contract[key], true, key);
  for (const key of ["callerSuppliedReceiptAllowed", "receiptExportAllowed", "replayAllowed",
    "automaticRetryAllowed", "replacementAuthorizationAllowed", "fallbackAllowed", "compositionImplemented",
    "sourceLookupImplemented", "sourceInvoked", "runtimeWired",
  ] as const) assert.equal(contract[key], false, key);
  assert.equal(contract.maximumSpendCalls, 1);
  assert.equal(contract.maximumRecheckCalls, 1);
  assert.equal(contract.maximumSourceLookups, 0);
});

test("CR13A-LIVE-390 publishes 28 zero actuals, eight false grants, and no authority", () => {
  const status = connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1;
  assert.equal(parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1(status), status);
  const actuals = Object.entries(status).filter(([key]) => key.startsWith("actual")).map(([, value]) => value);
  const grants = Object.entries(status).filter(([key]) => key.startsWith("grants")).map(([, value]) => value);
  assert.equal(actuals.length, 28);
  assert.deepEqual(actuals, new Array(28).fill(0));
  assert.equal(grants.length, 8);
  assert.deepEqual(grants, new Array(8).fill(false));
  assert.equal(status.compositionState, "contract_only");
  assert.equal(status.sourceBoundaryCrossed, false);
  assert.equal(status.externalEffectOccurred, false);
});

test("CR13A-LIVE-390 rejects copies, accessors, Symbols, and Proxies without behavior", () => {
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1({
    ...connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
  }), "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1({
    ...connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1,
  }), "invalid_status");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1(Symbol("raw")),
    "invalid_contract");
  let executions = 0;
  const accessor = Object.defineProperty({}, "contractVersion", {
    get() { executions += 1; throw new Error("raw receipt accessor"); },
  });
  const proxy = new Proxy({}, {
    ownKeys() { executions += 1; throw new Error("raw receipt proxy"); },
    get() { executions += 1; throw new Error("raw receipt proxy"); },
  });
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1(accessor),
    "invalid_contract");
  expectCode(() => parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1(proxy),
    "invalid_status");
  assert.equal(executions, 0);
});

test("CR13A-LIVE-390 freezes records, parsers, arrays, and safe errors", () => {
  for (const value of [connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
    connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1,
    ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1,
    ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1.prototype,
    parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
    parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1]) {
    assert.equal(Object.isFrozen(value), true);
  }
  const error = new ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1("raw receipt");
  assert.equal(error.safeCode, "integrity_failed");
  assert.equal(error.stack, undefined);
  assert.equal(Object.isFrozen(error), true);
});

test("CR13A-LIVE-390 parsers retain captured intrinsics after ambient replacement", () => {
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
    parsedContract = parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1(
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1);
    parsedStatus = parseConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1(
      connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1);
  } finally {
    Object.isFrozen = originalIsFrozen;
    WeakSet.prototype.has = originalWeakSetHas;
    WeakMap.prototype.get = originalWeakMapGet;
    Array.prototype.some = originalArraySome;
    Reflect.apply = originalReflectApply;
  }
  assert.equal(parsedContract, connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1);
  assert.equal(parsedStatus, connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1);
  assert.deepEqual(executions, new Array(5).fill(0));
});

test("CR13A-LIVE-390 source contains no executable composition, store, database, source, or effect import", async () => {
  const source = await readFile(modulePath, "utf8");
  assert.doesNotMatch(source, /from "node:|import "node:|import\(/);
  assert.doesNotMatch(source, /private-loopback-invocation-authorization-store/);
  assert.doesNotMatch(source, /unreachable-atomic-native-observation-source/);
  assert.doesNotMatch(source, /new (?:Map|Set)|createServer|\.listen\(|fetch\(|setTimeout|setInterval/);
  assert.doesNotMatch(source, /postgres|pglite|sqlite|insert into|update .* set/i);
  assert.doesNotMatch(source, /function (?:consume|recheck|retrieve|lookup|invoke)/);
});

test("CR13A-LIVE-390 has only the safe barrel as a production consumer", async () => {
  const consumers: string[] = [];
  const barrel = resolve(root, "src/connection-registry/v1/index.ts");
  for (const file of await sourceFiles(resolve(root, "src"))) {
    if (file === modulePath) continue;
    if ((await readFile(file, "utf8")).includes(moduleName)) consumers.push(file);
  }
  assert.deepEqual(consumers, [barrel]);
});

test("CR13A-LIVE-390 public evidence contains no authorization, receipt, database, or native material", () => {
  const serialized = JSON.stringify({
    contract: connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionContractV1,
    status: connectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionStatusV1,
    error: new ConnectionEnrollmentPrivateLoopbackFreshSpendRecheckCompositionErrorV1("raw receipt"),
  });
  assert.doesNotMatch(serialized,
    /authorizationId|authorizationBody|nonceDigest|consumedAt|recheckedAt|executablePath|processIdentifier|hostname/);
  assert.doesNotMatch(serialized, /stack|raw receipt|127\.0\.0\.1|localhost/);
});

test("CR13A-LIVE-390 architecture, plan, and status preserve the source-free stop boundary", async () => {
  const architecture = await readFile(resolve(root,
    "docs/CR13A_LIVE_390_PRIVATE_FRESH_SPEND_RECHECK_COMPOSITION_CONTRACT.md"), "utf8");
  const plan = await readFile(resolve(root, "docs/CR3_BUILD_PLAN.md"), "utf8");
  const status = await readFile(resolve(root, "docs/BUILD_STATUS.md"), "utf8");
  for (const text of [architecture, plan, status]) {
    assert.match(text, /CR13A-LIVE-390/);
    assert.match(text, /fresh[- ]spend/i);
    assert.match(text, /stop\s+(?:immediately\s+)?before\s+(?:the\s+)?(?:first\s+)?source lookup/i);
  }
});
