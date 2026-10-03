import assert from "node:assert/strict";
import test from "node:test";
import { constants as osConstants } from "node:os";
import { NODE_ERRNO_SQLSTATE_NAMES_V1, isNodeErrnoSqlStateNameV1 } from
  "../src/persistence/node-errno-sqlstate.mjs";
import { databaseSqlStateV1, type DatabaseClient, type DatabaseSession } from "../src/persistence/database";
import { boundPrivateDatabase, PrivateDatabaseError } from "../src/web/v1/bounded-database";
import { createPrivatePgDriver } from "../src/web/v1/private-pg-driver";
import { recordTextCopyDerivation, type RecordDerivationRequest } from
  "../src/converter/v1/text-copy-derivation-store";
import { PostgresIntakeNeedsYouStoreV1, PostgresIntakeSuggestionStoreV1 } from
  "../src/work-intake/v1/intake-coordinator-store";
import { workBatchProposalDigestV1 } from "../src/work-intake/v1/digest";
import type { WorkBatchProposalV1 } from "../src/work-intake/v1/schemas";

// No database: inject precisely the sanitized error thrown by private-pg-driver.
const refusal = (state?: string) => new PrivateDatabaseError("database_unavailable", state);
function database(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): DatabaseClient {
  const session: DatabaseSession = { query: async <T>(sql: string, params?: unknown[]) =>
    ({ rows: (await query(sql, params)).rows as T[] }) };
  return { ...session, transaction: body => body(session),
    transactionWithPreCommitCheck: async (body, check) => { const result = await body(session); await check(); return result; } };
}
const digest = `sha256:${"a".repeat(64)}` as const;
const request: RecordDerivationRequest = {
  tenantId: "tenant:test", source: { tenantId: "tenant:test", setId: "set:test", fileId: "file:source",
    contentDigest: digest, sizeBytes: 4 },
  result: { schema: "control-room.text-copy-derivation/v1", status: "no_text_copy",
    sourceDigest: digest, converter: { id: "test-converter", version: "1.0.0" },
    diagnosticCategory: "not_supported_yet", markdownBytes: new Uint8Array() },
};

test("derivation reuses the readable row after a bounded-driver unique refusal", async () => {
  const seen: string[] = [];
  const db = database(async sql => { seen.push(sql); if (sql.includes("INSERT")) throw refusal("23505");
    return { rows: [{ derivation_id: "derivation:existing" }] }; });
  assert.deepEqual(await recordTextCopyDerivation(db, request), { derivationId: "derivation:existing", reused: true });
  assert.equal(seen.length, 2);
});

test("derivation refuses a missing row and preserves unrelated, unknown and read failures", async () => {
  await assert.rejects(recordTextCopyDerivation(database(async sql => {
    if (sql.includes("INSERT")) throw refusal("23505"); return { rows: [] };
  }), request), { code: "derivation_fence_lost" });
  for (const error of [refusal("23503"), refusal(), new PrivateDatabaseError("database_outcome_uncertain")]) {
    let calls = 0;
    await assert.rejects(recordTextCopyDerivation(database(async () => { calls++; throw error; }), request), e => e === error);
    assert.equal(calls, 1);
  }
  const readFailure = refusal();
  await assert.rejects(recordTextCopyDerivation(database(async sql => {
    throw sql.includes("INSERT") ? refusal("23505") : readFailure;
  }), request), e => e === readFailure);
});

test("50 simultaneous bounded refusals reuse one derivation; a failed read can retry", async () => {
  let calls = 0;
  const db = database(async sql => { calls++; await Promise.resolve();
    if (sql.includes("INSERT")) throw refusal("23505");
    return { rows: [{ derivation_id: "derivation:existing" }] }; });
  const results = await Promise.all(Array.from({ length: 50 }, () => recordTextCopyDerivation(db, request)));
  assert.equal(calls, 100);
  assert.ok(results.every(result => result.reused && result.derivationId === "derivation:existing"));
  let failed = false;
  const retryDb = database(async sql => {
    if (sql.includes("INSERT")) throw refusal("23505");
    if (!failed) { failed = true; throw refusal(); }
    return { rows: [{ derivation_id: "derivation:existing" }] };
  });
  await assert.rejects(recordTextCopyDerivation(retryDb, request));
  assert.equal((await recordTextCopyDerivation(retryDb, request)).reused, true);
});

const proposal: WorkBatchProposalV1 = { schema: "control-room.work-batch-proposal/v1", projectId: "project:test",
  tasks: [{ localId: "build", title: "Build", instructions: "Build the change", requiredCapability: "code.change",
    role: "builder", acceptanceCriteria: "Works", acceptanceTests: "Run tests" }], edges: [] };
const suggestion = { tenantId: "tenant:test", projectId: "project:test", batchId: "batch:test", requestKey: "request:test",
  baseRevision: 1, baseRevisionDigest: digest, proposerIdentityId: "identity:test", proposal,
  proposalDigest: workBatchProposalDigestV1(proposal), flagsByLocalId: {}, createdAt: "2026-10-02T12:00:00.000Z" };

test("suggestion maps bounded unique errors to replay conflicts, other states to rejection", async () => {
  for (const [state, expected] of [["23505", "intake_suggestion_replay_conflict"],
    ["P0001", "intake_suggestion_rejected"], [undefined, "intake_suggestion_rejected"]] as const) {
    let calls = 0;
    const store = new PostgresIntakeSuggestionStoreV1(database(async sql => { calls++;
      if (sql.includes("INSERT")) throw refusal(state); return { rows: [] };
    }), new Uint8Array(32));
    await assert.rejects(store.append(suggestion), { safeReasonCode: expected });
    assert.equal(calls, 2);
  }
});

const raiseInput = { tenantId: "tenant:test", projectId: "project:test", requestKey: "request:test",
  reasonCode: "orchestrator_failed_twice" as const, ownerRequest: "Build it", now: "2026-10-02T12:00:00.000Z" };
function needsYou(options: { error?: Error; stillEscalated?: boolean; item?: boolean; failRead?: Error } = {}) {
  let counterReads = 0, writes = 0;
  const db = database(async (sql, params) => {
    if (sql.includes("SELECT failure_count")) {
      counterReads++;
      if (counterReads > 1 && options.failRead) throw options.failRead;
      return { rows: counterReads === 1 || options.stillEscalated
        ? [{ failure_count: 2, scope_key: (params![2] as string[])[0] }] : [] };
    }
    if (sql.includes("INSERT INTO control_action_inbox")) { writes++; return { rows: [] }; }
    if (sql.includes("SELECT request_key")) return { rows: [{ request_key: raiseInput.requestKey }] };
    if (sql.includes("INSERT")) { writes++; throw options.error ?? refusal("P0001"); }
    if (sql.includes("count(*)")) return { rows: [{ n: options.item ? 1 : 0 }] };
    throw new Error("unexpected test query");
  });
  return { store: new PostgresIntakeNeedsYouStoreV1(db, () => ({ identityId: "identity:test" }), () => raiseInput.now),
    counts: () => ({ counterReads, writes }) };
}

test("bounded trigger refusal after counter clear reports no item, or reuses an existing item", async () => {
  const missing = needsYou();
  await assert.rejects(missing.store.raise(raiseInput), { message: "planner_needs_you_not_escalated" });
  assert.deepEqual(missing.counts(), { counterReads: 2, writes: 1 });
  await needsYou({ item: true }).store.raise(raiseInput);
});

test("Needs-you preserves refusal while escalated, other SQLSTATEs, uncertainty and failed re-read", async () => {
  const triggerError = refusal("P0001");
  await assert.rejects(needsYou({ error: triggerError, stillEscalated: true }).store.raise(raiseInput), e => e === triggerError);
  for (const error of [refusal("23503"), refusal(), new PrivateDatabaseError("database_outcome_uncertain")]) {
    const probe = needsYou({ error });
    await assert.rejects(probe.store.raise(raiseInput), e => e === error);
    assert.deepEqual(probe.counts(), { counterReads: 1, writes: 1 });
  }
  const readError = refusal();
  await assert.rejects(needsYou({ failRead: readError }).store.raise(raiseInput), e => e === readError);
});

test("50 concurrent lost escalation races never claim an absent item", async () => {
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => needsYou().store.raise(raiseInput)));
  assert.ok(results.every(result => result.status === "rejected" && result.reason.message === "planner_needs_you_not_escalated"));
});

test("stop during a slow re-read rejects; malformed input never reaches the database", async () => {
  let entered!: () => void, stop!: (error: Error) => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const db = database(async sql => {
    if (sql.includes("INSERT")) throw refusal("23505");
    entered(); return await new Promise<{ rows: unknown[] }>((_resolve, reject) => { stop = reject; });
  });
  const error = new PrivateDatabaseError("database_outcome_uncertain");
  const rejected = assert.rejects(recordTextCopyDerivation(db, request), e => e === error);
  await reading;
  stop(error);
  await rejected;
  let calls = 0;
  await assert.rejects(recordTextCopyDerivation(database(async () => { calls++; return { rows: [] }; }),
    { ...request, tenantId: "" }), { code: "derivation_tenant_missing" });
  assert.equal(calls, 0);
});

test("50 concurrent bounded suggestion conflicts are typed refusals, with no follow-up write", async () => {
  let inserts = 0, reads = 0;
  const db = database(async sql => {
    await Promise.resolve();
    if (sql.includes("INSERT")) { inserts++; throw refusal("23505"); }
    reads++; return { rows: [] };
  });
  const store = new PostgresIntakeSuggestionStoreV1(db, new Uint8Array(32));
  const results = await Promise.allSettled(Array.from({ length: 50 }, () => store.append(suggestion)));
  assert.ok(results.every(result => result.status === "rejected"
    && result.reason.safeReasonCode === "intake_suggestion_replay_conflict"));
  assert.equal(inserts, 50); assert.equal(reads, 50);
});

test("driver keeps five-letter Node failures uncertain rather than inventing SQLSTATEs", async () => {
  // Every name in the frozen errno set, not the four this suite used to name:
  // the set is derived from os.constants.errno, so a partial list here would
  // leave a whole class of five-letter transport failures untested. Each is
  // measured to be the shape the driver must refuse to call a SQLSTATE.
  for (const code of [...NODE_ERRNO_SQLSTATE_NAMES_V1, "database_unavailable", "235050", "23505", "40003"]) {
    let releases = 0, ends = 0;
    const driver = createPrivatePgDriver({ async connect() { return {
      async query() { throw Object.assign(new Error("private connection detail"), { code }); },
      release() { releases++; },
    }; }, async end() { ends++; } });
    const lease = await driver.acquire();
    try {
      await assert.rejects(lease.query("SELECT fixture"), error => {
        assert.ok(error instanceof PrivateDatabaseError);
        assert.equal(error.code, code === "23505" ? "database_unavailable" : "database_outcome_uncertain");
        assert.equal(error.sqlState, code === "23505" ? code : undefined);
        assert.equal(error.message.includes("private connection detail"), false);
        return true;
      });
    } finally { lease.release(); await driver.terminate(); }
    assert.equal(releases, 1); assert.equal(ends, 1);
  }
  // A real Node system error carries errno+syscall and no severity; a real
  // server error carries severity and no errno. That is why the driver can
  // refuse the errno BY NAME without ever having to inspect the object: the
  // production reader sees only a string field on a sanitized error.
  for (const name of ["EPIPE", "ESRCH"]) {
    const systemError = Object.assign(new Error("socket"), { code: name, errno: -32,
      syscall: "write" });
    assert.equal(Object.hasOwn(systemError, "severity"), false);
    assert.equal(databaseSqlStateV1(systemError), undefined);
  }
  let ends = 0;
  const db = boundPrivateDatabase(createPrivatePgDriver({ async connect() { return {
    async query() { throw Object.assign(new Error("dropped connection"), { code: "EPIPE" }); },
    release() {},
  }; }, async end() { ends++; } }));
  try {
    await assert.rejects(db.client.query("SELECT fixture"), { code: "database_outcome_uncertain" });
    assert.equal(db.isAvailable(), false);
    assert.equal(ends, 1);
    await assert.rejects(db.client.query("SELECT retry"), { code: "database_unavailable" });
  } finally { await db.close(); }
});

test("raw upgrade diagnostics distinguish Node errno from server SQLSTATE, including causes", async () => {
  const { sanitizedMacDatabaseUpgradeFailureV1 } = await import("../scripts/mac-local/database-upgrade-remote.mjs");
  for (const code of [...NODE_ERRNO_SQLSTATE_NAMES_V1]) {
    const error = Object.assign(new Error("private connection detail"), { code });
    for (const candidate of [error, new Error("upgrade wrapper", { cause: error })]) {
      const message = sanitizedMacDatabaseUpgradeFailureV1(candidate, "migrate");
      assert.match(message, /sqlstate=none class=Error/u);
      assert.doesNotMatch(message, /private connection detail|SQLSTATE_E/u);
      if (code === "EPIPE") assert.match(message, /system=EPIPE$/u);
    }
  }
  assert.match(sanitizedMacDatabaseUpgradeFailureV1(
    new Error("upgrade wrapper", { cause: { code: "42501" } }), "verify"), /sqlstate=42501 class=SQLSTATE_42/u);
  // The operator log is diagnostics only, but a real refusal it DID receive is
  // the diagnosis an operator needs: an author-chosen E-prefixed ERRCODE prints
  // its state and class instead of reading as "no state" and a generic Error.
  assert.match(sanitizedMacDatabaseUpgradeFailureV1(
    new Error("upgrade wrapper", { cause: { code: "E1234" } }), "migrate"),
    /sqlstate=E1234 class=SQLSTATE_E1/u);
});

// The set is DERIVED from os.constants.errno, so it is pinned against that live
// table in both directions. Forward (a new platform errno must be added here or
// the pin fails) is the direction that matters for safety; backward (a name that
// is no longer errno-shaped must be removed) keeps the reader from refusing a
// real code forever.
test("the errno exclusion set is exactly the five-letter names in os.constants.errno", () => {
  const fiveLetter = Object.keys(osConstants.errno).filter(name => name.length === 5).sort();
  assert.ok(fiveLetter.length >= 15,
    `expected a real errno table to classify, found ${fiveLetter.length}: ${JSON.stringify(fiveLetter)}`);
  assert.deepEqual([...NODE_ERRNO_SQLSTATE_NAMES_V1].sort(), fiveLetter,
    "src/persistence/node-errno-sqlstate.mjs must equal the five-letter os.constants.errno names");
  // Every entry is a name the table really has, in the shape, so nothing else
  // can be smuggled in behind a comment.
  for (const name of NODE_ERRNO_SQLSTATE_NAMES_V1) {
    assert.ok(Object.hasOwn(osConstants.errno, name), `${name} is not an os.constants.errno name`);
    assert.match(name, /^[0-9A-Z]{5}$/u);
    assert.equal(isNodeErrnoSqlStateNameV1(name), true);
  }
  // The set is frozen: a caller cannot push a name into the reader's decision.
  assert.equal(Object.isFrozen(NODE_ERRNO_SQLSTATE_NAMES_V1), true);
  assert.throws(() => { "use strict"; (NODE_ERRNO_SQLSTATE_NAMES_V1 as string[]).push("E1234"); });
  // And nothing outside the table is refused by name.
  for (const serverCode of ["E1234", "EZZZZ", "EXX99", "23505", "P0001", "40P01", "55P03", "57014"])
    assert.equal(isNodeErrnoSqlStateNameV1(serverCode), false, `${serverCode} is a server code, not errno`);
});

// The bug this fixes, at the reader. A server author chooses the ERRCODE, and
// PostgreSQL transmits it verbatim: measured on real PostgreSQL 17.11,
// `RAISE EXCEPTION ... USING ERRCODE = 'E1234'` arrives as .code "E1234".
// A prefix rule called that "unknown", which the driver then turned into a
// pool-wide quarantine for what is the most definite refusal there is.
test("an E-prefixed ERRCODE the server chose is a SQLSTATE, on either field", () => {
  for (const code of ["E1234", "E0001", "EXX99", "EZZZZ"]) {
    assert.equal(databaseSqlStateV1({ code }), code, `raw pg carries ${code} on code`);
    assert.equal(databaseSqlStateV1({ sqlState: code }), code, `the sanitized driver carries ${code} on sqlState`);
    // A real errno name still wins over a name that merely looks like a server
    // code, on BOTH fields: sqlState is read first, so a sanitized error whose
    // code is EPIPE must not borrow a usable state from some other field.
    assert.equal(databaseSqlStateV1({ code: "EPERM" }), undefined);
    assert.equal(databaseSqlStateV1({ sqlState: "EPERM" }), undefined);
    assert.equal(databaseSqlStateV1({ sqlState: "EPERM", code: "E1234" }), "E1234",
      "a readable server state on the other field is still read");
  }
  // The two refusals a caller must keep telling apart, side by side.
  assert.equal(databaseSqlStateV1({ code: "23505" }), "23505");
  assert.equal(databaseSqlStateV1({ code: "EPIPE" }), undefined);
  // Not a prefix rule any more: any five-character code that is not one of the
  // fifteen names is read, which is the general form of the fix.
  for (const code of ["E00A1", "E0000", "EZZZZ", "X1234", "F0001", "HV000"])
    assert.equal(databaseSqlStateV1({ code }), code, `${code} is a five-character server code`);
});
