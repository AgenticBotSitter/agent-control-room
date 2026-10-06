// The owner website: request bodies and headers on the module/pack transfer routes, the result-file
// download route, the shared bounded JSON body reader, and the loopback owner session (cookie,
// origin, forwarded headers, owner-code sign-in body).
import { safeStringify } from "../lib/rng.mjs";
import { generateKeyPairSync } from "node:crypto";
import { createModuleTransferHttpHandlerV1 } from "../../../src/web/v1/module-transfer-http.ts";
import { createResultFileHttpHandlerV1 } from "../../../src/web/v1/result-file-http.ts";
import { readBoundedJson } from "../../../src/web/v1/http-common.ts";
import { LocalOwnerSessionServiceV1, readLocalOwnerCodeV1 } from "../../../src/web/v1/local-owner-session.ts";
import { WebAccessError } from "../../../src/web/v1/access-verifier.ts";
import { sha256Digest } from "../../../src/security/canonical-digest.ts";
import { verifyModuleBundleV1, moduleKeyIdV1 } from "../../../src/modules/v1/bundle.ts";
import { exportModuleBundleV1 } from "../../../src/modules/v1/transfer.ts";
import { REGISTERED_MODULE_IDS_V1 } from "../../../src/modules/v1/registry.ts";

const enc = v => { try { return encodeURIComponent(v); } catch { return encodeURIComponent(v.replace(/[\ud800-\udfff]/gu, "?")); } };
const ORIGIN = "http://127.0.0.1:3310", OWNER_CODE = "owner-code-abcdefghijklmnopqrstuvwxyz";
const profile = { schema: "control-room.local-owner-session/v1", origin: ORIGIN, tenantId: "tenant:1", provider: "local-owner", subject: "owner", ownerCodeDigest: sha256Digest({ ownerCode: OWNER_CODE }), sessionSeconds: 3600 };
const keys = generateKeyPairSync("ed25519");
const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const trust = { trustedKeys: [{ keyId: moduleKeyIdV1(spki), publicKeySpki: spki, label: "k", moduleIds: ["*"] }], reviewedBundleDigests: [] };
let sessions, cookie, transferHandler, resultHandler, calls = [];
const record = (method, args) => calls.push({ method, args });
const approvals = {
  async preview(identity, submission) { record("preview", { identity: identity?.subject }); const v = verifyModuleBundleV1(submission?.bundle, submission?.signature, { trust, hostVersion: "1.0.0" }); return { bundleDigest: v.bundleDigest, moduleId: v.moduleId }; },
  async approve(identity, submission, draft, idempotencyKey) { record("approve", { identity: identity?.subject, idempotencyKey, draft }); const v = verifyModuleBundleV1(submission?.bundle, submission?.signature, { trust, hostVersion: "1.0.0" }); return { approvalId: "approval:1", bundleDigest: v.bundleDigest, replayed: false }; },
};
const transfers = { async downloadModule(identity, moduleId, version) { record("download", { moduleId, version }); return exportModuleBundleV1(moduleId, version, null); } };
const projects = { async getView(identity, projectId) { record("getView", { projectId }); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u.test(projectId)) throw new WebAccessError("not_found"); return { title: "Research", summary: "Collect things.", presentation: { enabledModules: [] } }; } };
const resultService = {
  async catalog(identity, projectId, jobId) { record("catalog", { projectId, jobId }); return { projectId, jobId, sets: [], additionalSetsOmitted: false, catalogSource: "configured", observedAt: new Date(0).toISOString(), startsWork: false, grantsExecutionAuthority: false }; },
  async issueDownload(identity, projectId, setId, fileId) { record("issueDownload", { projectId, setId, fileId }); return { href: `/api/v1/projects/${projectId}/result-files/${setId}/${fileId}/download?token=t` }; },
  async download(identity, projectId, setId, fileId, token) { record("download", { projectId, setId, fileId, token }); if (token !== "good-token") throw new WebAccessError("not_found"); return { displayName: "report.txt", mediaType: "text/plain", sizeBytes: 2, bytes: new Uint8Array([104, 105]), grantId: `result-grant:${"0".repeat(32)}` }; },
};
const validBundle = () => exportModuleBundleV1(REGISTERED_MODULE_IDS_V1[0], undefined, null);
const baseHeaders = () => ({ origin: ORIGIN, "sec-fetch-site": "same-origin", cookie });

function request(rng, path, init = {}, mutations = 0) {
  const headers = { ...baseHeaders(), ...(init.headers ?? {}) };
  let url = ORIGIN + path, method = init.method ?? "GET", body = init.body;
  for (let i = 0; i < mutations; i++) {
    const op = rng.int(0, 11);
    if (op === 0) delete headers.cookie;
    else if (op === 1) headers.cookie = rng.pick([cookie + "x", cookie.replace(/=./u, "=!"), `${cookie}; ${cookie}`, "control_room_local_owner=" + rng.ascii(43, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-"), "control_room_local_owner=", "other=1", rng.nasty(60), cookie.replace("control_room_local_owner", "Control_Room_Local_Owner"), ` ${cookie} `]);
    else if (op === 2) headers.origin = rng.pick(["http://localhost:3310", "http://127.0.0.1:3311", "https://127.0.0.1:3310", "null", "", ORIGIN + "/", ORIGIN.toUpperCase(), "http://127.0.0.1:3310.evil.invalid", rng.nasty(20)]);
    else if (op === 3) delete headers.origin;
    else if (op === 4) headers["sec-fetch-site"] = rng.pick(["cross-site", "same-site", "none", "", "SAME-ORIGIN", rng.nasty(8)]);
    else if (op === 5) headers[rng.pick(["forwarded", "x-forwarded-for", "x-forwarded-host", "X-Forwarded-Proto", "x-real-ip"])] = rng.pick(["1.2.3.4", "for=1.2.3.4", "", rng.nasty(12)]);
    else if (op === 6) url = rng.pick([url.replace("127.0.0.1", "localhost"), url.replace("http://", "https://"), url + "?x=1", url + "#f", url + "/", url.replace("/api/v1/", "/api/v1//"), url.replace("/api/v1/", "/API/v1/"), ORIGIN + "/" + rng.nasty(20).replace(/[\u0000-\u001f]/gu, "")]);
    else if (op === 7) method = rng.pick(["GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"]);
    else if (op === 8) headers["content-type"] = rng.pick(["application/json", "application/json; charset=utf-8", "text/plain", "", "APPLICATION/JSON", "application/json;x", "multipart/form-data"]);
    else if (op === 9 && typeof body === "string") body = rng.mutateText(body, rng.int(1, 3));
    else if (op === 10 && typeof body === "string") { try { body = safeStringify(rng.mutate(JSON.parse(body), rng.int(1, 3))); } catch { /* keep */ } }
    else headers["idempotency-key"] = rng.pick(["k".repeat(16), "k".repeat(15), "k".repeat(101), "", "a:b_c-0123456789", rng.nasty(20), "k".repeat(16) + "\n"]);
  }
  let req;
  try { req = new Request(url, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : body }); }
  catch (error) { return { error: `Request ctor: ${error?.message}` }; }
  return { req, method, url, headers, bodyLength: typeof body === "string" ? Buffer.byteLength(body) : 0 };
}

function streamFrom(chunks, delayMs = 0) {
  return new ReadableStream({ async pull(controller) { const next = chunks.shift(); if (next === undefined) { controller.close(); return; } if (delayMs) await new Promise(r => setTimeout(r, delayMs)); if (next?.$error) controller.error(new Error("boom")); else controller.enqueue(next); } });
}

const expected = e => e instanceof WebAccessError || (e instanceof Error && /^module_|^project_pack_|^web_|^invalid_request|^authentication_required|^access_denied|^not_found|^local_owner|ZodError/u.test(e.message + e.name)) || (e instanceof TypeError && /Request|header|Headers|URL|body/iu.test(e.message));

export const targets = [
  {
    name: "website:module-transfer",
    minimize: false,
    async setup() {
      sessions = new LocalOwnerSessionServiceV1(profile);
      const issued = await sessions.issue(new Request(ORIGIN + "/api/v1/local-owner-session", { method: "POST", headers: { origin: ORIGIN } }), OWNER_CODE, Date.now());
      cookie = issued.cookie.split(";")[0];
      transferHandler = createModuleTransferHttpHandlerV1({ origin: ORIGIN, localOwnerSession: sessions, transfers, approvals, projects, clock: Date.now });
      resultHandler = createResultFileHttpHandlerV1({ origin: ORIGIN, localOwnerSession: sessions, service: resultService, clock: Date.now });
    },
    corpusMustPass: false,
    corpus: ["preview", "approve", "download", "pack", "catalog", "link", "fetch"],
    generate(rng, names) {
      const name = rng.pick(names); const mutations = rng.weighted([[1, 0], [3, 1], [3, 2], [2, 3]]);
      const bundle = validBundle();
      if (name === "preview") { const body = rng.bool(0.5) ? safeStringify({ bundle: rng.mutate(bundle.bundle, rng.int(0, 3)), signature: null }) : rng.bool(0.5) ? safeStringify(rng.jsonValue(0, 4)) : rng.mutateText(JSON.stringify({ bundle: bundle.bundle, signature: null }), rng.int(1, 3)); return { $label: `${name}+${mutations}`, $input: { name, ...request(rng, "/api/v1/modules/preview", { method: "POST", headers: { "content-type": "application/json" }, body }, mutations) } }; }
      if (name === "approve") { const body = safeStringify({ submission: { bundle: rng.bool(0.7) ? bundle.bundle : rng.mutate(bundle.bundle, 1), signature: null }, draft: rng.jsonValue(0, 2), ...(rng.bool(0.2) ? { extra: 1 } : {}) }); return { $label: `${name}+${mutations}`, $input: { name, ...request(rng, "/api/v1/modules/approvals", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": "approval-0123456789" }, body }, mutations) } }; }
      if (name === "download") { const id = rng.bool(0.6) ? REGISTERED_MODULE_IDS_V1[0] : rng.pick([enc(rng.nasty(12)), "..", "%2e%2e", "a".repeat(70), "News", "news%00"]); const v = rng.pick(["", "?version=1.0.0", "?version=x", "?version=1.0.0&version=2.0.0", "?other=1", "?version=" + enc(rng.nasty(10))]); return { $label: `${name}+${mutations}`, $input: { name, ...request(rng, `/api/v1/modules/${id}/bundle${v}`, {}, mutations) } }; }
      if (name === "pack") { const id = rng.bool(0.6) ? "project%3Aa" : enc(rng.nasty(16)); return { $label: `${name}+${mutations}`, $input: { name, ...request(rng, `/api/v1/projects/${id}/pack`, {}, mutations) } }; }
      if (name === "catalog") { const q = rng.pick(["", "?job=job-1", "?job=a&job=b", "?token=x", "?job=", "?job=" + enc(rng.nasty(10))]); return { $label: `${name}+${mutations}`, $input: { name, ...request(rng, `/api/v1/projects/project%3Aa/result-files${q}`, {}, mutations) } }; }
      const setId = rng.bool(0.7) ? `result-set:${"a".repeat(32)}` : rng.pick([`result-set:${"A".repeat(32)}`, "result-set:" + rng.hex(31), "x", enc(rng.nasty(10))]);
      const fileId = rng.bool(0.7) ? `result-file:${"b".repeat(32)}` : rng.pick(["result-file:" + rng.hex(33), "..", "%2e%2e%2f"]);
      if (name === "link") return { $label: `${name}+${mutations}`, $input: { name, ...request(rng, `/api/v1/projects/project%3Aa/result-files/${setId}/${fileId}/download`, { method: "POST", body: rng.bool(0.3) ? "{}" : undefined }, mutations) } };
      const q = rng.pick(["?token=good-token", "?token=bad", "?token=good-token&token=good-token", "?token=good-token&x=1", "", "?token=" + enc(rng.nasty(16))]);
      return { $label: `${name}+${mutations}`, $input: { name, ...request(rng, `/api/v1/projects/project%3Aa/result-files/${setId}/${fileId}/download${q}`, {}, mutations) } };
    },
    async invoke(input) {
      if (input.error) return { outcome: "refused", value: { ctorError: input.error, calls: [] } };
      calls = [];
      const handler = ["catalog", "link", "fetch"].includes(input.name) ? resultHandler : transferHandler;
      const response = await handler(input.req);
      const text = await response.text();
      let body; try { body = JSON.parse(text); } catch { body = undefined; }
      return { outcome: response.status < 300 ? "accepted" : "refused", value: { status: response.status, headers: Object.fromEntries(response.headers), body, text: text.slice(0, 300), calls } };
    },
    expectedErrors: () => false,
    oracle(input, result) {
      const v = result.value; if (v.ctorError) return undefined;
      if (![200, 201, 204, 400, 401, 403, 404, 409, 503].includes(v.status)) return `unexpected status ${v.status}`;
      if (/\n\s+at\s+\S+\s+\(|\/Users\/|node_modules\//u.test(v.text)) return "response leaks a stack frame or path";
      if (v.status >= 400) { if (!v.body || typeof v.body.error !== "string") return `error without a JSON error code: ${v.text.slice(0, 60)}`; const keys = Object.keys(v.body).sort().join(","); if (keys !== "error" && keys !== "error,reason") return `error body with extra keys ${keys}`; if (v.body.reason !== undefined && !/^module_(bundle|signature|manifest|permission)_/u.test(v.body.reason)) return `non-module reason leaked: ${v.body.reason}`; }
      const cookieParts = (input.headers.cookie ?? "").split(";").map(v => v.trim()).filter(v => v.startsWith("control_room_local_owner=")); const validCookie = cookieParts.length === 1 && cookieParts[0] === cookie, sameOrigin = (input.headers.origin === undefined || input.headers.origin === ORIGIN) && new URL(input.url).origin === ORIGIN && !Object.keys(input.headers).some(h => /^(forwarded|x-forwarded-)/iu.test(h)) && (input.headers["sec-fetch-site"] === undefined || ["same-origin", "none"].includes(input.headers["sec-fetch-site"]));
      if (v.calls.length && !(validCookie && sameOrigin)) return `service call ${v.calls[0].method} without a valid same-origin owner session`;
      if (v.status < 300 && !(validCookie && sameOrigin)) return "2xx without a valid same-origin owner session";
      if (["preview", "approve"].includes(input.name) && v.status < 300 && input.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") return "JSON route accepted a non-JSON content type";
      if (input.name === "approve") { const approve = v.calls.find(c => c.method === "approve"); if (approve && !/^[A-Za-z0-9:_-]{16,100}$/u.test(approve.args.idempotencyKey)) return "approve reached with malformed idempotency key"; if (approve && (input.method !== "POST")) return "approve reached by non-POST"; }
      if (input.name === "preview" && v.status < 300 && input.bodyLength > 12_000_000) return "preview accepted a body over the ceiling";
      if (["link", "fetch"].includes(input.name)) { const d = v.calls.find(c => c.method === "download" || c.method === "issueDownload"); if (d && (!/^result-set:[a-f0-9]{32}$/u.test(d.args.setId) || !/^result-file:[a-f0-9]{32}$/u.test(d.args.fileId))) return "result-file service reached with malformed ids"; if (v.status === 200 && input.name === "fetch") { if (v.headers["content-disposition"] !== 'attachment; filename="report.txt"' || v.headers["content-type"] !== "application/octet-stream" || v.headers["x-content-type-options"] !== "nosniff") return "download without attachment/nosniff headers"; } }
      if (input.name === "catalog") { const c = v.calls.find(x => x.method === "catalog"); if (c && new URL(input.url).searchParams.getAll("job").length > 1) return "catalog reached with repeated job filter"; if (c && input.method !== "GET") return "catalog reached by non-GET"; }
    },
  },
  {
    name: "website:bounded-json-body",
    corpus: ['{"a":1}'],
    corpusInput: text => ({ chunks: [new Uint8Array(Buffer.from(text))], limit: 512, delayMs: 0, timeoutMs: 5000, text }),
    generate(rng, c) {
      const r = rng.float();
      const text = r < 0.5 ? rng.mutateText(c[0], rng.int(1, 3)) : safeStringify(rng.jsonValue(0, 4));
      const bytes = Buffer.from(text, "utf8");
      const chunks = []; let at = 0;
      while (at < bytes.length) { const n = rng.int(1, Math.max(1, bytes.length)); chunks.push(new Uint8Array(bytes.subarray(at, at + n))); at += n; }
      const op = rng.int(0, 7);
      if (op === 0) chunks.push({ $error: true });
      if (op === 1) chunks.splice(rng.int(0, chunks.length), 0, Buffer.from(rng.bytes(rng.int(1, 4))));
      if (op === 2) chunks.push(new Uint8Array(rng.int(0, 600)));
      if (op === 3) chunks.length = 0;
      const limit = rng.pick([512, 256, 20_000, bytes.length, Math.max(1, bytes.length - 1), 1]);
      return { $label: `op${op}`, $input: { chunks, limit, delayMs: rng.bool(0.03) ? 25 : 0, timeoutMs: rng.bool(0.05) ? 10 : 5000, text } };
    },
    async invoke(input) { const value = await readBoundedJson(streamFrom([...input.chunks], input.delayMs), input.limit, input.timeoutMs); return { outcome: "accepted", value }; },
    expectedErrors: e => e instanceof WebAccessError && e.code === "invalid_request",
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const total = input.chunks.reduce((n, c) => n + (c?.byteLength ?? 0), 0);
      if (total > input.limit) return "accepted a body over the byte limit";
      if (input.chunks.some(c => c?.$error)) return "accepted an errored stream";
      const joined = Buffer.concat(input.chunks.filter(c => c instanceof Uint8Array).map(c => Buffer.from(c))).toString("utf8");
      let native; try { native = JSON.parse(joined); } catch { return "accepted non-JSON"; }
      if (JSON.stringify(native) !== JSON.stringify(result.value)) return "value differs from JSON.parse";
      if (/"(\w+)"\s*:[^{}]*"\1"\s*:/u.test(joined) && new Set(Object.keys(native)).size !== (joined.match(/"[^"]*"\s*:/gu) ?? []).length && typeof native === "object" && !Array.isArray(native) && Object.keys(native).length === 1) return "possible duplicate key accepted";
    },
  },
  {
    name: "website:owner-session",
    corpus: ["issue", "verify"],
    corpusMustPass: false,
    async setup() { sessions = new LocalOwnerSessionServiceV1(profile); const issued = await sessions.issue(new Request(ORIGIN + "/api/v1/local-owner-session", { method: "POST", headers: { origin: ORIGIN } }), OWNER_CODE, Date.now()); cookie = issued.cookie.split(";")[0]; },
    generate(rng, names) {
      const name = rng.pick(names);
      if (name === "issue") { const code = rng.weighted([[2, OWNER_CODE], [3, rng.mutateString(OWNER_CODE)], [1, rng.jsonValue(0, 2)], [1, OWNER_CODE.repeat(10)], [1, rng.nasty(30)]]); const r = request(rng, "/api/v1/local-owner-session", { method: "POST", headers: { "content-type": "application/json" }, body: safeStringify({ ownerCode: code }) }, rng.int(0, 2)); return { $label: "issue", $input: { name, code, ...r } }; }
      return { $label: "verify", $input: { name, ...request(rng, "/projects", {}, rng.int(1, 3)) } };
    },
    async invoke(input) {
      if (input.error) return { outcome: "refused", value: { ctorError: input.error } };
      if (input.name === "issue") { const ownerCode = await readLocalOwnerCodeV1(input.req.clone()); const issued = await sessions.issue(input.req, ownerCode, Date.now()); return { outcome: "accepted", value: { issued: true, cookie: issued.cookie } }; }
      const identity = sessions.verify(input.req, Date.now());
      return { outcome: "accepted", value: { identity } };
    },
    expectedErrors: expected,
    oracle(input, result) {
      if (result.outcome !== "accepted" || result.value.ctorError) return undefined;
      const sameOrigin = (input.headers.origin === undefined || input.headers.origin === ORIGIN) && new URL(input.url).origin === ORIGIN && !Object.keys(input.headers).some(h => /^(forwarded|x-forwarded-)/iu.test(h));
      if (!sameOrigin) return "session accepted a cross-origin or forwarded request";
      if (input.name === "issue") { if (input.code !== OWNER_CODE) return "session issued for a wrong owner code"; if (input.headers.origin !== ORIGIN) return "session issued without exact Origin"; if (!/; HttpOnly; SameSite=Strict; Path=\//u.test(result.value.cookie)) return "cookie without HttpOnly/SameSite"; }
      if (input.name === "verify") { const values = (input.headers.cookie ?? "").split(";").map(s => s.trim()).filter(s => s.startsWith("control_room_local_owner=")); if (values.length !== 1 || values[0] !== cookie) return "verify accepted a cookie header that is not exactly the issued one"; }
    },
  },
];
