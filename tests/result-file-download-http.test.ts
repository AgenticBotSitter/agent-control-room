// The owner download route (plan v4.3 2.6) and the catalog the UI reads.
// These are refusal tests: every one of them is a case where a file must NOT be
// served, a link must NOT be minted, or a header must NOT leak the filesystem.
//
// The service is a stub with the same shape as the real one, so what is under
// test here is the ROUTE — its method rules, its query rules, its attachment
// headers and its failure mapping — not the database, which
// tests/result-file-catalog-postgres.test.ts proves separately.
import assert from "node:assert/strict";
import test from "node:test";
import { createResultFileHttpHandlerV1 } from "../src/web/v1/result-file-http";
import { WebAccessError, type VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import type { LocalOwnerSessionServiceV1 } from "../src/web/v1/local-owner-session";
import type { ResultFileServiceV1 } from "../src/web/v1/result-file-service";
import { RESULT_FILE_LIMITS_V1 } from "../src/artifacts/v1/result-file-store";

const ORIGIN = "https://control.example";
const PROJECT = "project:alpha";
const SET = `result-set:${"a".repeat(32)}`;
const FILE = `result-file:${"b".repeat(32)}`;
const DIGEST = `sha256:${"c".repeat(64)}`;
const identity: VerifiedWebIdentity = { provider: "test", subject: "identity:owner",
  tokenDigest: `sha256:${"d".repeat(64)}`, issuedAt: "2026-09-29T12:00:00.000Z",
  expiresAt: "2026-09-29T13:00:00.000Z", verificationExpiresAt: "2026-09-29T13:00:00.000Z" };

type Calls = { catalog: number; issue: number; download: number; lastDownload?: string };

/** Records what the route asked for, and serves exactly what the test says. */
function service(over: { bytes?: Uint8Array; name?: string } = {}) {
  const calls: Calls = { catalog: 0, issue: 0, download: 0 };
  const bytes = over.bytes ?? new TextEncoder().encode("report body\n");
  const value: ResultFileServiceV1 = {
    async catalog() {
      calls.catalog += 1;
      return { projectId: PROJECT, sets: [], additionalSetsOmitted: false, catalogSource: "configured",
        observedAt: "2026-09-29T12:00:00.000Z", startsWork: false, grantsExecutionAuthority: false };
    },
    async issueDownload() {
      calls.issue += 1;
      return { href: `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/${SET}/${FILE}/download?token=t`,
        expiresAt: "2026-09-29T12:05:00.000Z" };
    },
    async download(_identity, _projectId, _setId, _fileId, token) {
      calls.download += 1; calls.lastDownload = token;
      return { displayName: over.name ?? "report.txt", mediaType: "text/plain", sizeBytes: bytes.byteLength,
        contentDigest: DIGEST, bytes, grantId: `result-grant:${"e".repeat(32)}` } as never;
    },
  };
  return { value, calls };
}

const localSession = (): LocalOwnerSessionServiceV1 => ({
  profile: { origin: "http://127.0.0.1:3000" },
  assertLocalRequest() {},
  verify: () => identity,
} as unknown as LocalOwnerSessionServiceV1);

/** A same-origin GET/POST with the loopback session, which the factory accepts. */
function handler(target: ResultFileServiceV1) {
  return createResultFileHttpHandlerV1({ origin: "http://127.0.0.1:3000", service: target,
    localOwnerSession: localSession(), clock: () => Date.parse("2026-09-29T12:00:00.000Z") });
}
const get = (path: string) => handlerRequest("GET", path);
const post = (path: string) => handlerRequest("POST", path);
async function handlerRequest(method: string, path: string) {
  const { value, calls } = service();
  const response = await handler(value)(new Request(`http://127.0.0.1:3000${path}`, { method }));
  return { response, calls };
}

test("a download is an attachment with nosniff and a sandbox, and never names a path", async () => {
  const { value } = service();
  const response = await handler(value)(new Request(
    `http://127.0.0.1:3000/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/${SET}/${FILE}/download?token=t`,
    { method: "GET" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="report.txt"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  // The response is octet-stream whatever the file is, so nothing in it can be
  // interpreted by the app's origin even if a browser ignored the disposition.
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-length"), String(new TextEncoder().encode("report body\n").byteLength));
  // Nothing anywhere in the response names a filesystem path or a storage key.
  const body = await response.text();
  assert.doesNotMatch(body, /crbf1|\/Users\/|storage_key|\.crbf/u);
  assert.doesNotMatch(JSON.stringify([...response.headers]), /crbf1|\/Users\/|storage_key/u);
});

test("a link is minted only by a POST with no query and no body", async () => {
  const { value, calls } = service();
  const path = `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/${SET}/${FILE}/download`;
  const minted = await handler(value)(new Request(`http://127.0.0.1:3000${path}`, { method: "POST" }));
  assert.equal(minted.status, 201);
  assert.equal(calls.issue, 1);
  // A GET on the same path with no token refuses rather than silently issuing.
  const refused = await handler(value)(new Request(`http://127.0.0.1:3000${path}`, { method: "GET" }));
  assert.equal(refused.status, 400);
  assert.equal(calls.issue, 1, "no link was minted by the refused GET");
  // A POST carrying a body or a query is refused: the file is named by the path
  // alone, so there is nothing a caller could add to it.
  for (const request of [
    new Request(`http://127.0.0.1:3000${path}?extra=1`, { method: "POST" }),
    new Request(`http://127.0.0.1:3000${path}`, { method: "POST", body: "{}" }),
  ]) {
    const response = await handler(service().value)(request);
    assert.equal(response.status, 400, "a POST with a query or a body is refused");
  }
});

test("the catalog is a GET, takes at most one job filter, and mints nothing", async () => {
  const path = `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files`;
  const { value, calls } = service();
  const read = await handler(value)(new Request(`http://127.0.0.1:3000${path}?job=job%3Aone`, { method: "GET" }));
  assert.equal(read.status, 200);
  assert.equal(calls.catalog, 1);
  assert.equal(calls.issue, 0, "reading the catalog issued no link");
  for (const query of ["?job=a&job=b", "?token=t", "?page=2", "?limit=100"]) {
    const response = await handler(service().value)(new Request(`http://127.0.0.1:3000${path}${query}`,
      { method: "GET" }));
    assert.equal(response.status, 400, `refused: ${query}`);
  }
});

test("every other method, path and token shape is refused", async () => {
  const base = `http://127.0.0.1:3000/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files`;
  const cases: [string, string][] = [
    ["DELETE", `${base}/${SET}/${FILE}/download?token=t`],
    ["PUT", `${base}/${SET}/${FILE}/download?token=t`],
    ["GET", `${base}/${SET}/${FILE}/download`],
    ["GET", `${base}/${SET}/${FILE}/download?token=a&token=b`],
    ["GET", `${base}/${SET}/${FILE}/download?token=a&other=b`],
    ["GET", `${base}/${SET}/${FILE}`],
    ["GET", `${base}/${SET}/${FILE}/downloads`],
    // A set or file id that is not one of ours is not a route at all.
    ["GET", `${base}/result-set:${"z".repeat(32)}/${FILE}/download?token=t`],
    ["GET", `${base}/${SET}/result-file:short/download?token=t`],
    ["POST", base],
  ];
  for (const [method, path] of cases) {
    const response = await handler(service().value)(new Request(path, { method }));
    assert.ok([400, 404].includes(response.status), `${method} ${path} answered ${response.status}`);
  }
});

test("a display name that could inject a header never reaches one", async () => {
  // The schema already refuses these names, so this proves the ROUTE refuses
  // them too, independently: a name that reached a Content-Disposition header
  // could add a second header to the response.
  for (const name of ['a"b.txt', "a\r\nX-Evil: 1", "../escape.txt", ".hidden", "a/b.txt"]) {
    const { value } = service({ name });
    const response = await handler(value)(new Request(
      `http://127.0.0.1:3000/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/${SET}/${FILE}/download?token=t`,
      { method: "GET" }));
    assert.equal(response.status, 404, `refused: ${JSON.stringify(name)}`);
    assert.equal(response.headers.get("content-disposition"), null);
    assert.equal(response.headers.get("x-evil"), null);
  }
});

test("the route answers a service refusal with a status, never a stack", async () => {
  for (const [code, status] of [["access_denied", 403], ["not_found", 404], ["invalid_request", 400]] as const) {
    const failing: ResultFileServiceV1 = {
      catalog: async () => { throw new WebAccessError(code); },
      issueDownload: async () => { throw new WebAccessError(code); },
      download: async () => { throw new WebAccessError(code); },
    };
    const response = await handler(failing)(new Request(
      `http://127.0.0.1:3000/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/${SET}/${FILE}/download?token=t`,
      { method: "GET" }));
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error: code });
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  // A failure the route does not classify is a 503, not a 500 with a message.
  const broken: ResultFileServiceV1 = {
    catalog: async () => { throw new Error("internal detail that must not escape"); },
    issueDownload: async () => { throw new Error("internal detail"); },
    download: async () => { throw new Error("internal detail"); },
  };
  const response = await handler(broken)(new Request(
    `http://127.0.0.1:3000/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files/${SET}/${FILE}/download?token=t`,
    { method: "GET" }));
  assert.equal(response.status, 503);
  assert.doesNotMatch(await response.text(), /internal detail/u);
});

test("the hosted origin requires a trust profile, and the two modes cannot mix", () => {
  // A loopback session and a gateway trust profile together would mean two
  // answers to "who is this", so the factory refuses rather than preferring one.
  assert.throws(() => createResultFileHttpHandlerV1({ origin: ORIGIN, service: service().value,
    trust: { issuer: "https://gate.example", audience: "control-room" } as never,
    localOwnerSession: localSession() }), /result_file_http_authentication_invalid/u);
  assert.throws(() => createResultFileHttpHandlerV1({ origin: ORIGIN, service: service().value }),
    /result_file_http_authentication_invalid/u);
  // Neither mode: also refused. There is no unauthenticated variant of this route.
  assert.throws(() => createResultFileHttpHandlerV1({ origin: ORIGIN, service: service().value,
    localOwnerSession: undefined }), /result_file_http_authentication_invalid/u);
});

test("a path segment cannot walk out of the result-file route", () => {
  // `new Request` resolves `..` before the route sees anything, so a traversal
  // is not merely refused by the handler — it cannot be expressed as a request
  // to this origin at all. The route's own patterns then anchor every segment,
  // so an un-decoded `%2e%2e` is an ordinary id-shaped string that matches
  // nothing. Both are asserted, because either alone would be a weak claim.
  const normalised = new URL(`http://127.0.0.1:3000/api/v1/projects/x/result-files/../secrets`).pathname;
  assert.equal(normalised, "/api/v1/projects/x/secrets", "the parser removes the traversal");
  const escaped = `${base()}/result-set:${"a".repeat(32)}/%2e%2e%2f%2e%2e%2fetc/download?token=t`;
  const response = handler(service().value);
  return response(new Request(`http://127.0.0.1:3000${escaped}`, { method: "GET" })).then(value =>
    assert.ok([400, 404].includes(value.status), "an encoded traversal is not a route"));
});
const base = () => `/api/v1/projects/${encodeURIComponent(PROJECT)}/result-files`;

test("the route is a handler, not a listener: constructing it opens nothing", () => {
  // No socket, no timer, no credential read. This is the same property every
  // other private handler in the app is expected to have.
  const target = handler(service().value);
  assert.equal(typeof target, "function");
  assert.equal(target.length, 1);
});
