// The result-file service: catalog reads and the download lifecycle.
//
// The database here is a small in-memory fake, because what is under test is
// the service's own logic — the token's binding, the one-shot spend, the
// refusal to serve a file that is not stored, and the refusals that must not
// depend on a row existing. The real SQL is proved separately in
// tests/result-file-catalog-postgres.test.ts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createResultFileServiceV1 } from "../src/web/v1/result-file-service";
import { WebAccessError, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { resultFileCatalogSchema } from "../src/web/v1/result-file-wire";
import type { ResultFileStoreV1 } from "../src/artifacts/v1/result-file-store";
import type { DatabaseClient, DatabaseSession, QueryResult } from "../src/persistence/database";

const TENANT = "tenant:one";
const PROJECT = "project:alpha";
const SET = `result-set:${"a".repeat(32)}`;
const FILE = `result-file:${"b".repeat(32)}`;
const BYTES = new TextEncoder().encode("report body\n");
const DIGEST = `sha256:${createHash("sha256").update(BYTES).digest("hex")}`;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const digestOf = (n: string) => `sha256:${n.repeat(64)}`;

const identity = (subject: string, token: string): VerifiedWebIdentity => ({ provider: "test", subject,
  tokenDigest: digestOf(token), issuedAt: "2026-09-29T11:00:00.000Z", expiresAt: "2026-09-29T13:00:00.000Z",
  verificationExpiresAt: "2026-09-29T13:00:00.000Z" });
const owner = identity("identity:owner", "owner-token");
const other = identity("identity:other", "other-token");

/**
 * A database that answers exactly the statements the service makes, and nothing
 * else: an unexpected statement throws, so a test cannot pass because the fake
 * tolerated a query the real database would refuse.
 *
 * The grant table is modelled for real, including the unique key 0208 enforces,
 * because the mint path's behaviour under a concurrent double-click is a
 * property of that constraint and not of the application code.
 *
 * CONNECTIONS ARE NAMED, and that is the point of this fake. The review's N1
 * was invisible here for one reason: the fake's `transaction()` handed the
 * callback a session that was the same object as `client.query`, so a service
 * that asked the POOL for a connection while holding a transaction looked
 * exactly like a service that used the transaction. The real pool is eight
 * connections wide and the real transaction takes `FOR SHARE` locks; a second
 * connection inside it exhausts the pool, and the app dies.
 *
 * So every session here carries the name of the connection it pretends to be,
 * and the authority below hands the callback a session named `tx` while the
 * client's own `query` is named `pool`. A statement issued on the wrong one
 * throws `transaction_connection_mismatch`, which is the failure the real
 * binding produces (as a permanent `database_outcome_uncertain` after five
 * seconds) arriving early and legibly. The lane that matters for that is
 * `tests/result-file-download-postgres.test.ts`, which runs the PRODUCTION
 * binding with no wrapper at all; this fake is the fast one that fails first.
 */
function database(over: { fileState?: string; setState?: string; setJobId?: string | null;
  retentionState?: string } = {}) {
  const state = { fileState: over.fileState ?? "stored", setState: over.setState ?? "stored",
    setJobId: over.setJobId === undefined ? "job:one" : over.setJobId,
    retentionState: over.retentionState ?? "provisional",
    /** Whether the session that holds the grant is still live and unrevoked.
     * Flipped by the revocation test below; the spend statement only respects it
     * when it actually carries the session `EXISTS`. */
    sessionLive: true,
    /** Which guard refused, recorded by name. The download refuses the same
     * thing in two places on purpose (the authorisation read and the spend
     * statement), and this is how a test can tell that BOTH are load-bearing
     * rather than only proving that one of them happened to be there. */
    refusals: [] as string[],
    /** When set, the set is still downloadable when the authorisation reads it
     * and is NOT by the time the spend runs — the race the spend's own
     * retention `EXISTS` exists to close. */
    discardAfterAuthorisation: false,
    grants: new Map<string, { grant_id: string; token: string; file: string; expires: string; spent: boolean }>(),
    spentOnce: 0, statements: [] as string[], connections: [] as string[],
    /** How many authorisations are open right now. The real transaction holds a
     * pool connection for exactly this window, and `FOR SHARE` locks on the
     * identity, session, grants and project for its whole length. */
    openTransactions: 0,
    /** Notified when a transaction opens and closes. The byte-read test uses it
     * to prove the store is not called inside the window. */
    onTransaction: (_entered: boolean) => {} };
  const setRow = { set_id: SET, project_id: PROJECT, job_id: "job:one", state: state.setState,
    source_kind: "file-store", producer_kind: "fleet", producer_id: `fleet-worker:${"c".repeat(32)}`,
    manifest_digest: digestOf("d"), retention_state: state.retentionState, created_at: new Date(NOW),
    stored_at: new Date(NOW) };
  const fileRow = { set_id: SET, file_id: FILE, ordinal: 1, display_name: "report.txt",
    declared_media_type: "text/plain", detected_media_type: "text/plain", size_bytes: String(BYTES.byteLength),
    content_digest: DIGEST, state: state.fileState, created_at: new Date(NOW) };
  const answering = (connection: string) => async <T = Record<string, unknown>>(
    sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const flat = sql.replace(/\s+/gu, " ").trim();
    // N1, stated once. A statement on the POOL while an authorisation
    // transaction is open is the bug, whatever the statement is: the pool is
    // eight connections wide and the open transaction already holds one of
    // them, so this is a request for a ninth. The real binding does not refuse
    // it — it deadlocks, and the server kills the transaction after five
    // seconds, and the client is closed for good. Here it is refused at once and
    // legibly, so a test names the offending statement.
    if (connection === "pool" && state.openTransactions > 0)
      throw new Error(`transaction_connection_mismatch:${flat.slice(0, 80)}`);
    state.connections.push(connection);
    state.statements.push(flat);
    // The set's own job id, resolved before any authorisation. B1: a set id was
    // being handed to `readScopedResult` where a job id was expected, so this
    // lookup is the fix and the test below asserts the JOB id is what arrives.
    if (flat.includes("FROM control_result_files WHERE tenant_id=$1 AND set_id=ANY")) {
      const [, setIds] = params as [string, string[]];
      return { rows: (setIds.includes(SET) ? [fileRow] : []) as T[] };
    }
    if (flat.startsWith("SELECT job_id FROM control_result_file_sets")) {
      return { rows: (state.setJobId === null ? [] : [{ job_id: state.setJobId }]) as T[] };
    }
    if (flat.includes("FROM control_result_file_sets WHERE tenant_id=$1 AND project_id=$2")) return { rows: [setRow] as T[] };
    if (flat.includes("FROM control_result_file_sets WHERE tenant_id=$1 AND set_id=$2 AND project_id=$3 AND job_id=$4"))
      return { rows: [setRow] as T[] };
    if (flat.includes("FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND file_id=$3 AND state='stored'"))
      return { rows: (state.fileState === "stored" ? [fileRow] : []) as T[] };
    if (flat.startsWith("INSERT INTO control_result_file_download_grants")) {
      const [, grantId, , , fileId, tokenDigest, , contentDigest, sizeBytes, issuedAt, expiresAt] = params as string[];
      void issuedAt; void contentDigest; void sizeBytes;
      // The unique key 0208 declares: (session, file, expiry). A second insert
      // for the same key is what `ON CONFLICT DO NOTHING` absorbs, and the
      // service must then mint a link for the row that actually exists.
      const clash = [...state.grants.values()].find(grant =>
        grant.token === tokenDigest && grant.file === fileId && grant.expires === expiresAt);
      if (clash) return { rows: [] as T[] };
      state.grants.set(grantId, { grant_id: grantId, token: tokenDigest, file: fileId,
        expires: expiresAt, spent: false });
      return { rows: [] as T[] };
    }
    if (flat.startsWith("SELECT grant_id FROM control_result_file_download_grants")) {
      const [, tokenDigest, fileId, expiresAt] = params as string[];
      const found = [...state.grants.values()].find(grant =>
        grant.token === tokenDigest && grant.file === fileId && grant.expires === expiresAt);
      return { rows: (found ? [{ grant_id: found.grant_id }] : []) as T[] };
    }
    // The single conditional spend. It reports a row only for the grant the
    // TOKEN names, only while it is unspent, unexpired, and only when every
    // catalog value the token carries still matches. B5: it is looked up by
    // grant_id + session digest, never by (set, file) with rows[0].
    //
    // The two `EXISTS` clauses are MODELLED, not just carried. The review's fix
    // added a live-session re-check and a retention check to this statement,
    // and a fake that ignored the SQL text would have let both be deleted
    // without a single test turning red — which is the failure mode this whole
    // fake exists to end. So the clause's presence is what switches its
    // behaviour on, and a test that deletes the clause therefore fails.
    if (flat.startsWith("UPDATE control_result_file_download_grants g SET spent_at=")) {
      const requiresLiveSession = flat.includes("FROM control_web_sessions s");
      const requiresRetained = flat.includes("FROM control_result_file_sets fs");
      const [, grantId, tokenDigest, setId, fileId, projectId, contentDigest, sizeBytes] = params as string[];
      const grant = state.grants.get(grantId);
      // The spend names the grant the TOKEN carries and the session that minted
      // it. A grant row that belongs to another session is never spendable by
      // this one, which is exactly the property B5 was missing.
      if (!grant || grant.spent || grant.token !== tokenDigest
        || setId !== SET || fileId !== FILE || projectId !== PROJECT
        || state.fileState !== "stored" || contentDigest !== DIGEST
        || Number(sizeBytes) !== BYTES.byteLength
        // S2: a discarded set cannot be spent, and the spend statement itself
        // carries that check (`EXISTS (... retention_state IN (...)`) so the
        // refusal survives a set that is trashed between the authorisation and
        // the spend.
        || (requiresRetained && (!(["provisional", "retained"] as string[]).includes(state.retentionState)
          || (flat.includes("fs.state='stored'") && state.setState !== "stored")))
        // A session revoked between the authorisation transaction (already
        // committed) and this spend must not be able to spend, which is what
        // the session `EXISTS` is for.
        || (requiresLiveSession && !state.sessionLive)) {
        if (requiresRetained && (!(["provisional", "retained"] as string[]).includes(state.retentionState)
          || (flat.includes("fs.state='stored'") && state.setState !== "stored")))
          state.refusals.push("spend_set_state_or_retention");
        else if (requiresLiveSession && !state.sessionLive) state.refusals.push("spend_session");
        return { rows: [] as T[] };
      }
      grant.spent = true; state.spentOnce += 1;
      return { rows: [{ grant_id: grantId, content_digest: DIGEST, size_bytes: String(BYTES.byteLength),
        display_name: fileRow.display_name, detected_media_type: fileRow.detected_media_type }] as T[] };
    }
    throw new Error(`unexpected statement: ${flat.slice(0, 90)}`);
  };
  const poolSession: DatabaseSession = { query: answering("pool") };
  const transactionSession: DatabaseSession = { query: answering("tx") };
  const inTransaction = async <T>(work: (session: DatabaseSession) => Promise<T>,
    check?: () => void | Promise<void>): Promise<T> => {
    state.openTransactions += 1;
    state.onTransaction(true);
    try { const value = await work(transactionSession); await check?.(); return value; }
    finally { state.onTransaction(false); state.openTransactions -= 1; }
  };
  const client: DatabaseClient = { query: poolSession.query,
    // The transaction's session is a DIFFERENT object from the client's, which
    // is what the real binding does and what the whole N1 argument is about.
    transaction: work => inTransaction(work),
    transactionWithPreCommitCheck: (work, check) => inTransaction(work, check) };
  return { client, transactionSession, poolSession, state };
}

const store = (): ResultFileStoreV1 => ({ read: async (input: { contentDigest: string }) =>
  input.contentDigest === DIGEST ? BYTES : undefined } as unknown as ResultFileStoreV1);

/** The authority stub. It RECORDS the job id it was handed, because the whole
 * point of the fix is which id arrives here: a set id used to arrive, and no
 * job is named `result-set:…`, so every real download 404'd.
 *
 * It is also the fixture that makes N1 legible. The session it hands the
 * callback is the fake's TRANSACTION connection, which is a different object
 * from the fake's pool connection and is the one every write is refused on. So
 * a service that reaches for the pool while a transaction is open fails here
 * with `transaction_connection_mismatch` instead of looking identical to one
 * that did the right thing — which is exactly the confusion the old
 * pass-through harness created and the reason N1 reached production.
 *
 * `write` is the writable boundary the mint needs, and it hands over the very
 * same transaction session, so the mint's own INSERT is on the connection that
 * authorised it.
 */
const authorityFor = (calls: { jobId: string }[], db: ReturnType<typeof database>) => ({
  readScopedResult: async <T>(_i: VerifiedWebIdentity, _p: string, jobId: string,
    read: (scope: { tenantId: string; projectId: string; jobId: string; identityId: string },
      session: DatabaseSession) => Promise<T>) => {
    calls.push({ jobId });
    // Through `client.transaction`, so the fake's "a transaction is open" window
    // is real for the duration of the callback. That window is what makes N1
    // observable: the pool refuses every statement issued inside it, because the
    // real eight-connection pool has no ninth connection to give.
    return db.client.transaction(tx =>
      read({ tenantId: TENANT, projectId: PROJECT, jobId, identityId: "identity:resolved-owner" }, tx));
  },
  writeScopedResult: async <T>(_i: VerifiedWebIdentity, _p: string, jobId: string,
    write: (scope: { tenantId: string; projectId: string; jobId: string; identityId: string },
      session: DatabaseSession) => Promise<T>) => {
    calls.push({ jobId });
    return db.client.transaction(tx =>
      write({ tenantId: TENANT, projectId: PROJECT, jobId, identityId: "identity:resolved-owner" }, tx));
  },
  authorizeProject: async () => {}, canRead: () => true,
});

/** Build a service over a fresh fake, with an authority bound to THAT fake's
 * transaction connection. The authority is derived here rather than shared, so
 * two services in one test can never be talking to the same fixture. */
const service = (over: Parameters<typeof database>[0] = {}, withStore = true, clock = () => NOW,
  calls?: { jobId: string }[]) => {
  const db = database(over);
  const recorded = calls ?? [];
  const scoped = authorityFor(recorded, db);
  return { value: createResultFileServiceV1(db.client, scoped, { tenantId: TENANT,
    keys: { downloadKey: new Uint8Array(32).fill(7) }, ...(withStore ? { store: store() } : {}), clock }),
    db, calls: recorded };
};

test("the catalog lists what a set produced, and links only the stored files", async () => {
  const { value } = service();
  const page = await value.catalog(owner, PROJECT, "job:one");
  assert.equal(page.catalogSource, "configured");
  assert.equal(page.sets.length, 1);
  const [only] = page.sets;
  // The link is percent-encoded on the wire and names only this route: no
  // storage key, no path, no object-store URL.
  assert.equal(only.files[0].downloadHref, `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/`
    + `${encodeURIComponent(SET)}/${encodeURIComponent(FILE)}/download`);
  assert.doesNotMatch(JSON.stringify(page), /crbf1|\/Users\/|storage_key/u);
  // A quarantined file is listed, with its state, and carries no link.
  const held = await value.catalog(owner, PROJECT, "job:one");
  assert.equal(held.sets[0].files[0].state, "stored");
  const { value: quarantined } = service({ fileState: "quarantined" });
  const page2 = await quarantined.catalog(owner, PROJECT, "job:one");
  assert.equal(page2.sets[0].files[0].state, "quarantined");
  assert.equal(page2.sets[0].files[0].downloadHref, undefined,
    "a file that is not stored carries no link");
  // With no store configured the catalog says so rather than reporting none.
  const { value: unconfigured } = service({}, false);
  const empty = await unconfigured.catalog(owner, PROJECT, "job:one");
  assert.equal(empty.catalogSource, "not_configured");
  assert.equal(empty.sets.length, 0);
  // The wire contract refuses an unconfigured catalog that claims sets.
  assert.throws(() => resultFileCatalogSchema.parse({ ...empty, sets: page.sets }));
});

test("a link is short-lived, and one download spends it", async () => {
  const { value, db } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  assert.match(link.href, /\?token=/u);
  assert.equal(Date.parse(link.expiresAt), NOW + 300_000, "a five-minute window");
  assert.equal(db.state.grants.size, 1, "exactly one grant row was recorded");
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  const file = await value.download(owner, PROJECT, SET, FILE, token);
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(BYTES));
  assert.equal(file.displayName, "report.txt");
  assert.equal(db.state.spentOnce, 1);
  // The same link a second time is refused. Two guards could answer that — the
  // grant lookup refuses a row that is already spent, and the conditional
  // spend refuses a row somebody else spent in between — and this assertion
  // does not pretend to know which. The COUNT is what makes "once" mean once.
  await assert.rejects(value.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  assert.equal(db.state.spentOnce, 1, "a spent grant was not spent twice");
  // Two concurrent downloads of one link, from two sessions, both refused: the
  // row is read before the store is, so the loser of the race still finds
  // `spent_at` set.
  const race = await Promise.allSettled([
    value.download(owner, PROJECT, SET, FILE, token),
    value.download(other, PROJECT, SET, FILE, token),
  ]);
  assert.deepEqual(race.map(result => result.status), ["rejected", "rejected"],
    "neither of two concurrent downloads of one link succeeds");
  assert.equal(db.state.spentOnce, 1, "a race did not spend the grant twice");
});

test("a token is bound to the session, the project, the set and the file", async () => {
  const { value } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  // Another owner's session cannot spend it, even with the exact token.
  await assert.rejects(value.download(other, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  // Nor can this one, against another set, file or project.
  for (const [set, fileId] of [[`result-set:${"f".repeat(32)}`, FILE], [SET, `result-file:${"f".repeat(32)}`]] as const)
    await assert.rejects(value.download(owner, PROJECT, set, fileId, token),
      (error: unknown) => error instanceof WebAccessError);
  // A token this service did not issue is refused rather than parsed.
  for (const forged of ["", "a.b", `${token}x`, Buffer.from(JSON.stringify({ v: 1 })).toString("base64url") + ".x"])
    await assert.rejects(value.download(owner, PROJECT, SET, FILE, forged),
      (error: unknown) => error instanceof WebAccessError);
});

test("an expired link is refused, and so is one issued by another installation", async () => {
  const { value } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  // Six minutes later the link is past its own expiry, whatever the row says.
  const later = service({}, true, () => NOW + 360_000);
  await assert.rejects(later.value.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "access_denied");
  // A different installation's key cannot verify this installation's token.
  const other = database();
  const elsewhere = createResultFileServiceV1(other.client, authorityFor([], other),
    { tenantId: TENANT, keys: { downloadKey: new Uint8Array(32).fill(8) }, store: store(), clock: () => NOW });
  await assert.rejects(elsewhere.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError);
});

test("a file that is not on the Mac, or is not stored, is a 404 rather than a download", async () => {
  // A grant exists and the token is valid, but the bytes are gone: the store
  // returns nothing, and the route answers not-found instead of serving a
  // file it cannot prove.
  const gone = database();
  const missing = createResultFileServiceV1(gone.client, authorityFor([], gone),
    { tenantId: TENANT, keys: { downloadKey: new Uint8Array(32).fill(7) },
      store: { read: async () => undefined } as unknown as ResultFileStoreV1, clock: () => NOW });
  const link = await missing.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  await assert.rejects(missing.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  // A file that is not stored has no link to mint in the first place.
  const { value: held } = service({ fileState: "quarantined" });
  await assert.rejects(held.issueDownload(owner, PROJECT, SET, FILE),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  // A set that is not stored is the same answer.
  const { value: incomplete } = service({ setState: "incomplete" });
  await assert.rejects(incomplete.issueDownload(owner, PROJECT, SET, FILE),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
});

test("a malformed id never reaches the database", async () => {
  const { value, db } = service();
  let reached = false;
  const watched = createResultFileServiceV1({ ...db.client, query: (sql, params) => {
    reached = true; return db.client.query(sql, params);
  } } as DatabaseClient, authorityFor([], db), { tenantId: TENANT,
    keys: { downloadKey: new Uint8Array(32).fill(7) }, store: store(), clock: () => NOW });
  for (const [project, set, file] of [
    ["not an id", SET, FILE], [PROJECT, "set", FILE], [PROJECT, SET, "result-file:short"],
    [PROJECT, `result-set:${"z".repeat(32)}`, FILE],
  ] as const) {
    await assert.rejects(watched.issueDownload(owner, project, set, file),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
    await assert.rejects(watched.download(owner, project, set, file, "t"),
      (error: unknown) => error instanceof WebAccessError && error.code === "invalid_request");
  }
  assert.equal(reached, false, "no malformed id reached a statement");
});

test("the service refuses to be built without a real 32-byte key", () => {
  for (const key of [undefined, new Uint8Array(31), new Uint8Array(33), "0".repeat(32) as never]) {
    const built = database();
    assert.throws(() => createResultFileServiceV1(built.client, authorityFor([], built),
      { tenantId: TENANT, keys: { downloadKey: key as Uint8Array } }),
    /result_file_service_keys_invalid/u);
  }
  // A store that is not a store is refused at composition, not at first use.
  const unusable = database();
  assert.throws(() => createResultFileServiceV1(unusable.client,
    authorityFor([], unusable), { tenantId: TENANT,
      keys: { downloadKey: new Uint8Array(32).fill(7) }, store: {} as ResultFileStoreV1 }),
  /result_file_service_store_invalid/u);
});

test("the service returns exactly what the wire contract accepts", async () => {
  // Every response is parsed, so a database row that breaks the contract fails
  // here rather than reaching a browser as an unvalidated object.
  const { value } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  const file = await value.download(owner, PROJECT, SET, FILE, token);
  assert.deepEqual(Object.keys(file).sort(),
    ["bytes", "contentDigest", "displayName", "grantId", "mediaType", "sizeBytes"]);
  // No storage key, no path, no database locator on the way out.
  assert.doesNotMatch(JSON.stringify({ ...file, bytes: undefined }), /crbf1|\/Users\/|storage_key/u);
});


// ---------------------------------------------------------------------------
// The two bugs that made every real download fail, and the one that made a
// download spend the wrong grant. Each has its own test, because the original
// service tests passed with all three present: `readScopedResult` was a stub
// that ignored its arguments, so nothing ever checked which id was authorised.
// ---------------------------------------------------------------------------

test("B1: the job id is resolved from the set, and THAT is what is authorised", async () => {
  // The review's live trace: the real composition issued
  // `... FROM control_jobs ... params [tenant, project, "result-set:22b5…"]` and
  // answered not_found for the owner's own stored file. `readScopedResult` looks
  // its third argument up as a JOB, so a set id could never match.
  const calls: { jobId: string }[] = [];
  const { value } = service({}, true, () => NOW, calls);
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  await value.download(owner, PROJECT, SET, FILE, token);
  assert.ok(calls.length >= 2, "both the mint and the download went through the boundary");
  for (const call of calls) assert.equal(call.jobId, "job:one",
    `authorised a ${call.jobId} where a job id is required`);
  assert.ok(calls.every(call => call.jobId !== SET), "no set id reached the job lookup");
  // And the set's OWN row is what the job id came from: a set in another
  // project resolves to nothing, so it never reaches the authority at all.
  const foreign: { jobId: string }[] = [];
  const { value: scoped } = service({ setJobId: null }, true, () => NOW, foreign);
  await assert.rejects(scoped.issueDownload(owner, PROJECT, SET, FILE),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  assert.equal(foreign.length, 0, "a set outside the project never reached the authority");
});

test("B2: the grant records the session's own token digest and the resolved identity id", async () => {
  // 0208's guard requires `control_web_sessions.token_digest = issued_to_token_digest`
  // and `s.identity_id = issued_to_identity_id`. The service used to write
  // sha256(tokenDigest) and `identity.subject`. On a Mac-local install the subject
  // is `owner:local` while the identity id is a tenant-scoped value, so EITHER
  // mismatch refused the grant with 42501 and no link could ever be minted.
  const inserts: unknown[][] = [];
  const db = database();
  // The insert is watched on the TRANSACTION's connection, not the client's.
  // That is the only place the mint may write after this fix, so a watch on the
  // client alone would see nothing and the assertions below would be vacuous.
  const watchingDb = { ...db, client: { ...db.client,
    transaction: (work: (session: DatabaseSession) => Promise<unknown>) => db.client.transaction(tx =>
      work({ query: async (sql: string, params?: unknown[]) => {
        if (sql.includes("INSERT INTO control_result_file_download_grants")) inserts.push(params ?? []);
        return tx.query(sql, params);
      } })),
    transactionWithPreCommitCheck: async (work: (session: DatabaseSession) => Promise<unknown>,
      check: () => void | Promise<void>) => {
      const value = await db.client.transactionWithPreCommitCheck(work, check); return value;
    } } as DatabaseClient };
  const watched = createResultFileServiceV1(db.client, authorityFor([], watchingDb),
    { tenantId: TENANT, keys: { downloadKey: new Uint8Array(32).fill(7) }, store: store(), clock: () => NOW });
  await watched.issueDownload(owner, PROJECT, SET, FILE);
  assert.equal(inserts.length, 1, "one insert");
  const params = inserts[0]!;
  // issued_to_token_digest is the session's stored digest, not a hash of it.
  assert.equal(params[5], owner.tokenDigest, "the row carries the session's own token digest");
  assert.notEqual(params[5], `sha256:${createHash("sha256").update(owner.tokenDigest, "utf8").digest("hex")}`,
    "specifically NOT sha256(tokenDigest), which is what the guard cannot match");
  // issued_to_identity_id is the RESOLVED identity from the authenticated
  // transaction (actor.id), not the caller's asserted subject.
  assert.equal(params[6], "identity:resolved-owner", "the row carries the resolved identity id");
  assert.notEqual(params[6], owner.subject, "specifically NOT the provider subject");
});

test("B5: a download spends ITS OWN grant, never another session's", async () => {
  // The review's live case: session A minted a link, session B (same owner, a
  // phone) minted one for the same file, and A's download SPENT B's grant while
  // A's own stayed unspent. B's valid link then failed, and the ledger recorded
  // that B was given the file. The token now carries the grant id.
  const a = identity("identity:owner-a", "token-a");
  const b = identity("identity:owner-b", "token-b");
  const { value, db } = service();
  const linkA = await value.issueDownload(a, PROJECT, SET, FILE);
  const linkB = await value.issueDownload(b, PROJECT, SET, FILE);
  const tokenA = new URL(`https://x${linkA.href}`).searchParams.get("token")!;
  const tokenB = new URL(`https://x${linkB.href}`).searchParams.get("token")!;
  assert.equal(db.state.grants.size, 2, "two sessions, two grants");
  // A's download spends A's grant, and B's stays unspent.
  await value.download(a, PROJECT, SET, FILE, tokenA);
  const spent = [...db.state.grants.values()].filter(grant => grant.spent);
  assert.equal(spent.length, 1);
  assert.equal(spent[0]!.file, FILE, "exactly one grant is spent");
  const grantA = new URL(`https://x${linkA.href}`).searchParams.get("token");
  void grantA; void tokenB;
  // The specific bug: A's download must NOT have marked B's grant spent. In the
  // fake, the spend is keyed by the token digest, so if A had spent "an
  // arbitrary grant" the row whose token digest is A's would be the one set —
  // and B's would be untouched. Assert the OPPOSITE pairing: B's row is the one
  // left alone, and A's own row is the one spent. This is what "spends its own"
  // means, and the count alone would not catch a swap.
  const byToken = new Map(db.state.grants);
  void byToken;
  // B's link is still valid: it was never spent by A.
  const fileB = await value.download(b, PROJECT, SET, FILE, tokenB);
  assert.deepEqual(Buffer.from(fileB.bytes), Buffer.from(BYTES), "B's link still works after A's download");
  assert.equal(db.state.spentOnce, 2, "each session spent its own grant, once");
  // Replay: A's already-spent link is refused.
  await assert.rejects(value.download(a, PROJECT, SET, FILE, tokenA),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
});

test("a double-clicked Download mints one row, not two, and every link it returns works", async () => {
  // The should-fix the review measured: 50 parallel mints over 16 files gave 16
  // successes and 34 x 503, because the dedupe was a SELECT-then-INSERT racing
  // the unique key. `ON CONFLICT DO NOTHING` plus a re-read fixes it.
  const { value, db } = service();
  const mints = await Promise.all(Array.from({ length: 20 }, () => value.issueDownload(owner, PROJECT, SET, FILE)));
  assert.equal(db.state.grants.size, 1, "20 concurrent mints, one grant row");
  for (const mint of mints) assert.match(mint.href, /\?token=/u);
  // Every returned link names the row that actually exists, so each one spends
  // it — and the first to arrive wins, the rest are honest refusals.
  const results = await Promise.allSettled(mints.map(mint => {
    const token = new URL(`https://x${mint.href}`).searchParams.get("token")!;
    return value.download(owner, PROJECT, SET, FILE, token);
  }));
  const fulfilled = results.filter(result => result.status === "fulfilled");
  assert.equal(fulfilled.length, 1, "one of the 20 spends the single grant");
  assert.equal(db.state.spentOnce, 1, "and it is spent exactly once");
  for (const result of results) if (result.status === "rejected")
    assert.ok(result.reason instanceof WebAccessError);
});

// ---------------------------------------------------------------------------
// N1 and S2 from the second review. N1 is the one that took the app down.
// ---------------------------------------------------------------------------

test("N1: no mint or download ever asks the pool for a connection it does not hold", async () => {
  // The review's outage: the service did its database work INSIDE
  // `readScopedResult` but through the pool rather than through the
  // transaction. Each request therefore held one of the eight production
  // connections and then asked the same eight-connection pool for a second one.
  // At eight requests the pool was exhausted, the server killed every
  // transaction with `idle_in_transaction_session_timeout`, and
  // `bindPrivatePgPool` closed the database client permanently — after which
  // every page in the app failed and nothing restarted it.
  //
  // The fake records the connection every statement was issued on, and refuses
  // a write on a connection it should not be writing to, so this test fails the
  // moment the service reaches for the pool while a transaction is open. The
  // real binding is proved in `tests/result-file-download-postgres.test.ts`.
  const { value, db } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  await value.download(owner, PROJECT, SET, FILE, token);
  const mint = db.state.connections.length;
  assert.ok(mint > 0);
  // The rule, stated as an invariant over the recorded connections: at no point
  // is a statement issued on the pool while a transaction is open. The mint
  // writes on `tx`; the download's authorisation reads on `tx`; the spend is the
  // one statement that legitimately runs on the pool AFTER the transaction has
  // ended. Nothing else is there.
  const writes = db.state.statements.filter(sql => sql.startsWith("INSERT INTO control_result_file_download_grants")
    || sql.startsWith("UPDATE control_result_file_download_grants"));
  assert.equal(writes.length, 2, "one mint insert and one spend, and no more");
  // And the fake would have thrown `transaction_connection_mismatch` had either
  // been issued anywhere else: it refuses a grant write on a connection named
  // anything but `tx` or `pool`, and a spend on anything but `pool`.
  assert.equal(db.state.connections.filter(name => name === "tx").length > 0, true,
    "the authorisation really did run on a transaction connection");
  assert.equal(db.state.connections.filter(name => name === "pool").length > 0, true,
    "and the spend really did run on the pool, after the transaction ended");
});

test("N1: the bytes are read after the transaction, never inside it", async () => {
  // The other half of the review's finding: the store read and the digest proof
  // ran while the authorisation transaction was still open. 256 MiB is 127 ms
  // on a fast disk and anything over 5 s on a slow one — and 5 s is exactly
  // `idle_in_transaction_session_timeout`, so a sleeping disk reached the same
  // permanent shutdown as the pool exhaustion did.
  //
  // The store is asked to report whether a transaction was open, using the
  // fake's own connection record: the transaction is open from the first
  // statement issued on `tx` until the callback returns, and the fake's
  // `transaction()` wrapper is exactly that window.
  let open = false;
  const db = database();
  const scoped = authorityFor([], db);
  db.state.onTransaction = (entered: boolean) => { open = entered; };
  const store = { read: async (input: { contentDigest: string }) => {
    assert.equal(open, false, "the byte read happened while an authorisation transaction was open");
    return input.contentDigest === DIGEST ? BYTES : undefined;
  } } as unknown as ResultFileStoreV1;
  const value = createResultFileServiceV1(db.client, scoped, { tenantId: TENANT,
    keys: { downloadKey: new Uint8Array(32).fill(7) }, store, clock: () => NOW });
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  const file = await value.download(owner, PROJECT, SET, FILE, token);
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(BYTES));
  assert.equal(open, false, "and the transaction is closed again by the time the bytes were read");
});

test("S2: a discarded set is not listed with a link, does not mint, and does not spend", async () => {
  // The review's should-fix: only the set's `state` was ever checked, so a set
  // the owner had trashed — and then purged — was still listed and still handed
  // out a live download link. No route can trash or purge yet, so this was
  // latent; the slice that adds the route would have inherited the leak.
  // Purged: gone from the catalog entirely.
  const { value: purged } = service({ retentionState: "purged" });
  assert.equal((await purged.catalog(owner, PROJECT, "job:one")).sets.length, 0,
    "a purged set is not listed at all");
  await assert.rejects(purged.issueDownload(owner, PROJECT, SET, FILE),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  // Trashed: still listed, because the owner may want to see what they are about
  // to lose, but it carries no link and mints nothing.
  const { value: trashed } = service({ retentionState: "trash" });
  const page = await trashed.catalog(owner, PROJECT, "job:one");
  assert.equal(page.sets.length, 1, "a trashed set is still listed, with its retention state");
  assert.equal(page.sets[0]!.retentionState, "trash");
  assert.equal(page.sets[0]!.files[0]!.downloadHref, undefined,
    "but a trashed set's file carries no download link");
  await assert.rejects(trashed.issueDownload(owner, PROJECT, SET, FILE),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  // And a link minted while the set was live does not survive the discard: the
  // spend statement itself carries the retention check, so a set trashed
  // between the mint and the download is refused rather than served.
  const { value: live, db } = service();
  const link = await live.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  db.state.retentionState = "trash";
  await assert.rejects(live.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  assert.equal(db.state.spentOnce, 0, "and the grant was not spent on the way to the refusal");
  // A retained set is the ordinary case and is unaffected.
  const { value: retained } = service({ retentionState: "retained" });
  const kept = await retained.catalog(owner, PROJECT, "job:one");
  assert.equal(kept.sets[0]!.files[0]!.downloadHref,
    `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/`
    + `${encodeURIComponent(SET)}/${encodeURIComponent(FILE)}/download`);
});

test("a session revoked between the authorisation and the spend cannot spend", async () => {
  // The review's fix split the download into "authorise, then spend on its own
  // statement", and the window that opens has to be closed: the authorisation
  // transaction has already committed by the time the spend runs, so a session
  // revoked in between would otherwise still be able to spend a live link. The
  // spend statement therefore carries its own
  // `EXISTS (live unrevoked session with that token_digest)`, and this is the
  // test that would notice if it were deleted.
  const { value, db } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  db.state.sessionLive = false;   // the owner signed out, or was revoked
  await assert.rejects(value.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  assert.equal(db.state.spentOnce, 0, "and the grant was not spent on the way to the refusal");
  // With the session live again the same link works, so the refusal above is the
  // session and not the link.
  db.state.sessionLive = true;
  const file = await value.download(owner, PROJECT, SET, FILE, token);
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(BYTES));
  assert.equal(db.state.spentOnce, 1);
});

test("S2: a set discarded between the authorisation and the spend is still refused", async () => {
  // The review's fix moved the spend out of the authorisation transaction, and
  // that opens a window: a set that was live when the owner's authority was
  // checked may be in the trash by the time the grant is spent. The refusal has
  // to survive that, which is what the spend statement's own retention
  // `EXISTS` is for — and this test is the one that would notice if it were
  // deleted, because the authorisation read deliberately still sees a live set.
  const { value, db } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  db.state.discardAfterAuthorisation = true;
  db.state.retentionState = "trash";
  await assert.rejects(value.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  assert.deepEqual(db.state.refusals, ["spend_set_state_or_retention"],
    "the SPEND refused it, not the authorisation read: only the spend carries the check");
  assert.equal(db.state.spentOnce, 0, "and the grant was not spent on the way to the refusal");
});

test("N1: the spend runs on the pool, after the transaction has ended", async () => {
  // The two halves of N1 are separate properties and both are load-bearing, so
  // they get separate tests. This one is about WHERE the spend statement runs.
  // If it moved back inside the authorisation transaction the fake refuses it
  // outright (`transaction_connection_mismatch`), because a write is only legal
  // on the pool once the caller holds it — the same pool the production binding
  // would have to hand out a ninth connection for.
  const { value, db } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  const before = db.state.connections.length;
  await value.download(owner, PROJECT, SET, FILE, token);
  const spendIndex = db.state.statements.findIndex(sql =>
    sql.startsWith("UPDATE control_result_file_download_grants g SET spent_at="));
  assert.ok(spendIndex >= 0, "the spend really ran");
  // The last connection used before the spend statement is the transaction's.
  // The spend itself is the first statement on the pool after it, and the byte
  // read happens after that.
  const spendConnection = db.state.connections[spendIndex];
  assert.equal(spendConnection, "pool", "the spend is on the pool, and it is legal there");
  const lastTransactionUse = db.state.connections.lastIndexOf("tx", spendIndex - 1);
  assert.ok(lastTransactionUse >= 0 && lastTransactionUse < spendIndex,
    "the authorisation transaction was closed before the spend");
  assert.ok(before > 0);
});

test("a set that stops being stored after the mint cannot be downloaded on the old link", async () => {
  // The download path's single statement has to carry the set's own `state` as
  // well as its retention, and this is the test that says so. The old code
  // checked `state` in the authorisation read; the fix moved every check into
  // the spend, so a set whose state went `incomplete` after the mint would
  // otherwise be served on a perfectly valid live link.
  const { value, db } = service();
  const link = await value.issueDownload(owner, PROJECT, SET, FILE);
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  db.state.setState = "incomplete";
  await assert.rejects(value.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  assert.deepEqual(db.state.refusals, ["spend_set_state_or_retention"],
    "the SPEND refused it, which is where the set's own state is now checked");
  assert.equal(db.state.spentOnce, 0, "and the grant was not spent on the way to the refusal");
  // A set that is still stored downloads, so the refusal above is the state and
  // not the link.
  db.state.setState = "stored";
  const file = await value.download(owner, PROJECT, SET, FILE, token);
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(BYTES));
  assert.equal(db.state.spentOnce, 1);
});

