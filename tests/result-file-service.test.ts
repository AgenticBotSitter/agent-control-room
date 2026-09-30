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
const owner = identity("identity:owner", "owner");
const other = identity("identity:other", "other");

/** A database that answers the three reads and the three writes the service makes. */
function database(over: { fileState?: string; setState?: string; spent?: Date | null } = {}) {
  const state = { fileState: over.fileState ?? "stored", setState: over.setState ?? "stored",
    spent: over.spent ?? null, grants: [] as { grant_id: string }[], spentOnce: 0 };
  const setRow = { set_id: SET, project_id: PROJECT, job_id: "job:one", state: state.setState,
    source_kind: "file-store", producer_kind: "fleet", producer_id: `fleet-worker:${"c".repeat(32)}`,
    manifest_digest: digestOf("d"), retention_state: "provisional", created_at: new Date(NOW),
    stored_at: new Date(NOW) };
  const fileRow = { set_id: SET, file_id: FILE, ordinal: 1, display_name: "report.txt",
    declared_media_type: "text/plain", detected_media_type: "text/plain", size_bytes: String(BYTES.byteLength),
    content_digest: DIGEST, state: state.fileState, created_at: new Date(NOW) };
  const query = async <T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
    if (sql.includes("FROM control_result_file_sets WHERE tenant_id=$1 AND project_id=$2")) return { rows: [setRow] as T[] };
    if (sql.includes("FROM control_result_files WHERE tenant_id=$1 AND set_id=$2 AND file_id=$3 AND state='stored'"))
      return { rows: (state.fileState === "stored" ? [fileRow] : []) as T[] };
    if (sql.includes("FROM control_result_file_sets s WHERE")) return { rows: [setRow] as T[] };
    if (sql.includes("FROM control_result_files\n          WHERE tenant_id=$1 AND set_id=$2 AND file_id=$3 AND state='stored'"))
      return { rows: [fileRow] as T[] };
    if (sql.includes("FROM control_result_files WHERE")) return { rows: [fileRow] as T[] };
    if (sql.includes("FROM control_result_file_download_grants\n           WHERE")) return { rows: [] as T[] };
    if (sql.startsWith("INSERT INTO control_result_file_download_grants")) {
      state.grants.push({ grant_id: String(params?.[1]) }); return { rows: [] as T[] };
    }
    if (sql.includes("FROM control_result_file_download_grants g")) {
      return { rows: [{ grant_id: `result-grant:${"e".repeat(32)}`, content_digest: DIGEST,
        size_bytes: String(BYTES.byteLength), spent_at: state.spent, state: state.fileState,
        display_name: fileRow.display_name, declared_media_type: fileRow.declared_media_type,
        detected_media_type: fileRow.detected_media_type }] as T[] };
    }
    if (sql.includes("UPDATE control_result_file_download_grants SET spent_at")) {
      // The conditional UPDATE: it reports a row only when it was not spent.
      if (state.spent !== null) return { rows: [] as T[] };
      state.spent = new Date(NOW); state.spentOnce += 1;
      return { rows: [{ grant_id: "result-grant:" }] as T[] };
    }
    throw new Error(`unexpected statement: ${sql.replace(/\\s+/gu, " ").trim().slice(0, 70)}`);
  };
  const session: DatabaseSession = { query };
  const client: DatabaseClient = { query: session.query,
    transaction: work => work(session),
    transactionWithPreCommitCheck: async (work, check) => { const value = await work(session); await check(); return value; } };
  return { client, state };
}

const store = (): ResultFileStoreV1 => ({ read: async (input: { contentDigest: string }) =>
  input.contentDigest === DIGEST ? BYTES : undefined } as unknown as ResultFileStoreV1);

const authority = { readScopedResult: async <T>(_i: VerifiedWebIdentity, _p: string, _j: string,
  read: (scope: { tenantId: string; projectId: string; jobId: string }) => Promise<T>) =>
  read({ tenantId: TENANT, projectId: PROJECT, jobId: "job:one" }),
  authorizeProject: async () => {}, canRead: () => true };
const service = (over: Parameters<typeof database>[0] = {}, withStore = true, clock = () => NOW) => {
  const db = database(over);
  return { value: createResultFileServiceV1(db.client, authority, { tenantId: TENANT,
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
  assert.equal(db.state.grants.length, 1, "exactly one grant row was recorded");
  const token = new URL(`https://x${link.href}`).searchParams.get("token")!;
  const file = await value.download(owner, PROJECT, SET, FILE, token);
  assert.deepEqual(Buffer.from(file.bytes), Buffer.from(BYTES));
  assert.equal(file.displayName, "report.txt");
  assert.equal(db.state.spentOnce, 1);
  // The same link a second time is refused: the grant is spent.
  await assert.rejects(value.download(owner, PROJECT, SET, FILE, token),
    (error: unknown) => error instanceof WebAccessError && error.code === "not_found");
  assert.equal(db.state.spentOnce, 1, "a spent grant was not spent twice");
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
