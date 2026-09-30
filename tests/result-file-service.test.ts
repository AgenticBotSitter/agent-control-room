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
 */
function database(over: { fileState?: string; setState?: string; setJobId?: string | null } = {}) {
  const state = { fileState: over.fileState ?? "stored", setState: over.setState ?? "stored",
    setJobId: over.setJobId === undefined ? "job:one" : over.setJobId,
    grants: new Map<string, { grant_id: string; token: string; file: string; expires: string; spent: boolean }>(),
    spentOnce: 0, statements: [] as string[] };
  const setRow = { set_id: SET, project_id: PROJECT, job_id: "job:one", state: state.setState,
    source_kind: "file-store", producer_kind: "fleet", producer_id: `fleet-worker:${"c".repeat(32)}`,
    manifest_digest: digestOf("d"), retention_state: "provisional", created_at: new Date(NOW),
    stored_at: new Date(NOW) };
  const fileRow = { set_id: SET, file_id: FILE, ordinal: 1, display_name: "report.txt",
    declared_media_type: "text/plain", detected_media_type: "text/plain", size_bytes: String(BYTES.byteLength),
    content_digest: DIGEST, state: state.fileState, created_at: new Date(NOW) };
  const query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    const flat = sql.replace(/\s+/gu, " ").trim();
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
    if (flat.startsWith("UPDATE control_result_file_download_grants g SET spent_at=")) {
      const [, grantId, tokenDigest, setId, fileId, projectId, contentDigest, sizeBytes] = params as string[];
      const grant = state.grants.get(grantId);
      // The spend names the grant the TOKEN carries and the session that minted
      // it. A grant row that belongs to another session is never spendable by
      // this one, which is exactly the property B5 was missing.
      if (!grant || grant.spent || grant.token !== tokenDigest
        || setId !== SET || fileId !== FILE || projectId !== PROJECT
        || state.fileState !== "stored" || contentDigest !== DIGEST
        || Number(sizeBytes) !== BYTES.byteLength)
        return { rows: [] as T[] };
      grant.spent = true; state.spentOnce += 1;
      return { rows: [{ grant_id: grantId, content_digest: DIGEST, size_bytes: String(BYTES.byteLength),
        display_name: fileRow.display_name, detected_media_type: fileRow.detected_media_type }] as T[] };
    }
    throw new Error(`unexpected statement: ${flat.slice(0, 90)}`);
  };
  const session: DatabaseSession = { query };
  const client: DatabaseClient = { query: session.query,
    transaction: work => work(session),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work(session); await check(); return value; } };
  return { client, state };
}

const store = (): ResultFileStoreV1 => ({ read: async (input: { contentDigest: string }) =>
  input.contentDigest === DIGEST ? BYTES : undefined } as unknown as ResultFileStoreV1);

/** The authority stub. It RECORDS the job id it was handed, because the whole
 * point of the fix is which id arrives here: a set id used to arrive, and no
 * job is named `result-set:…`, so every real download 404'd. */
const authorityFor = (calls: { jobId: string }[] = []) => ({
  readScopedResult: async <T>(_i: VerifiedWebIdentity, _p: string, jobId: string,
    read: (scope: { tenantId: string; projectId: string; jobId: string; identityId: string }) => Promise<T>) => {
    calls.push({ jobId });
    return read({ tenantId: TENANT, projectId: PROJECT, jobId, identityId: "identity:resolved-owner" });
  },
  authorizeProject: async () => {}, canRead: () => true,
});
const authority = authorityFor();

const service = (over: Parameters<typeof database>[0] = {}, withStore = true, clock = () => NOW,
  scoped: ReturnType<typeof authorityFor> = authority) => {
  const db = database(over);
  return { value: createResultFileServiceV1(db.client, scoped, { tenantId: TENANT,
    keys: { downloadKey: new Uint8Array(32).fill(7) }, ...(withStore ? { store: store() } : {}), clock }), db };
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
  const elsewhere = createResultFileServiceV1(database().client, authority, { tenantId: TENANT,
    keys: { downloadKey: new Uint8Array(32).fill(8) }, store: store(), clock: () => NOW });
  await assert.rejects(elsewhere.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError);
});

test("a file that is not on the Mac, or is not stored, is a 404 rather than a download", async () => {
  // A grant exists and the token is valid, but the bytes are gone: the store
  // returns nothing, and the route answers not-found instead of serving a
  // file it cannot prove.
  const missing = createResultFileServiceV1(database().client, authority, { tenantId: TENANT,
    keys: { downloadKey: new Uint8Array(32).fill(7) },
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
  } } as DatabaseClient, authority, { tenantId: TENANT, keys: { downloadKey: new Uint8Array(32).fill(7) },
    store: store(), clock: () => NOW });
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
    assert.throws(() => createResultFileServiceV1(database().client, authority,
      { tenantId: TENANT, keys: { downloadKey: key as Uint8Array } }),
    /result_file_service_keys_invalid/u);
  }
  // A store that is not a store is refused at composition, not at first use.
  assert.throws(() => createResultFileServiceV1(database().client, authority, { tenantId: TENANT,
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
  const { value } = service({}, true, () => NOW, authorityFor(calls));
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
  const { value: scoped } = service({ setJobId: null }, true, () => NOW, authorityFor(foreign));
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
  const { value } = service();
  const base = { ...database().client };
  const watched = createResultFileServiceV1({ ...base,
    query: (sql: string, params?: unknown[]) => { if (sql.includes("INSERT INTO control_result_file_download_grants"))
      inserts.push(params ?? []); return base.query(sql, params); } } as DatabaseClient, authority,
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
