// M6: the HTTP wiring for module/project-pack download and module upload
// (preview/approve). Runs against a real migrated schema via PGlite (fast,
// but the genuine SQL the service issues); the grant-boundary and production
// web-login SQL proof live in module-project-pack-transfer-postgres.test.ts.
//
// This uses its own real-wall-clock JWT/session rather than the shared
// fixture helper's fixed historical `now`: the module approval ledger's
// backdating guard (migration 0195) compares `approved_at` against
// PostgreSQL's own `now()`, so the clock driving these requests must track
// real time, not a fixed date baked into the shared test helper.
import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { fixture, origin, request, token, trust } from "./helpers/web-foundation.ts";
import { createModuleTransferHttpHandlerV1 } from "../src/web/v1/module-transfer-http.ts";
import { createProjectHttpHandler } from "../src/web/v1/project-http.ts";
import { ModuleInstallApprovalServiceV1, moduleKeyIdV1, type ModuleTrustPolicyV1 } from "../src/modules/v1/index.ts";
import { ModuleTransferServiceV1 } from "../src/modules/v1/transfer-service.ts";
import { loadModuleSigningKeyV1 } from "../src/modules/v1/transfer.ts";

const KEY = new Uint8Array(32).fill(52);
const nowMs = Date.now();
const jwt = token({ iat: Math.floor((nowMs - 60_000) / 1000), exp: Math.floor((nowMs + 300_000) / 1000) });
/** `request()` with this suite's own real-time-anchored JWT baked in. */
const req = (path: string, method = "GET", value?: unknown, key?: string) => request(path, method, value, key, jwt);
/** The shared helper's `trust.validUntilMs` is a fixed historical ceiling (baked in when that
 * helper was written) that real wall-clock time has since passed. This suite needs a real-time
 * clock (the module approval ledger's backdating guard checks `approved_at` against PostgreSQL's
 * own `now()`), so the verifier's own validity ceiling must be refreshed to match; the signing
 * key and claims contract are unchanged. */
const freshTrust = { ...trust, validUntilMs: nowMs + 3_600_000 };

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  return { pkcs8, spki, keyId: moduleKeyIdV1(spki) };
}

async function setup() {
  const clock = () => nowMs;
  const base = await fixture(clock);
  const publisher = keyPair();
  const signingKey = loadModuleSigningKeyV1(publisher.pkcs8);
  const scope = { tenantId: "tenant:web", workspaceId: "workspace:web" };
  const trustPolicy: ModuleTrustPolicyV1 = { trustedKeys: [{ keyId: publisher.keyId, publicKeySpki: publisher.spki,
    label: "Local owner key", moduleIds: ["*"] }], reviewedBundleDigests: [] };
  const transfers = new ModuleTransferServiceV1(base.client, scope, signingKey, clock);
  const approvals = new ModuleInstallApprovalServiceV1(base.client, scope, KEY, trustPolicy, "0.1.0", clock);
  const handler = createModuleTransferHttpHandlerV1({ origin, trust: freshTrust, transfers, approvals, projects: base.service, clock });
  return { ...base, publisher, transfers, approvals, handler, clock };
}

test("GET a registered module's bundle: signed, canonical, with a fingerprint header and a download file name", async () => {
  const { handler } = await setup();
  const response = await handler(req("/api/v1/modules/news/bundle", "GET"));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="news-1\.0\.0\.module-bundle\.json"/);
  assert.match(response.headers.get("x-control-room-bundle-digest") ?? "", /^sha256:[a-f0-9]{64}$/);
  const body = await response.json() as { bundle: { manifest: { id: string } }; signature: { keyId: string } | null };
  assert.equal(body.bundle.manifest.id, "news");
  assert.ok(body.signature, "a configured signing key signs the download");
});

test("GET an unknown module id is a plain 404, not a stack trace", async () => {
  const { handler } = await setup();
  const response = await handler(req("/api/v1/modules/doesNotExist/bundle", "GET"));
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});

test("a malformed module id or a disallowed query param is refused before any lookup", async () => {
  const { handler } = await setup();
  assert.equal((await handler(req("/api/v1/modules/Not-Valid/bundle", "GET"))).status, 400);
  assert.equal((await handler(req("/api/v1/modules/news/bundle?evil=1", "GET"))).status, 400);
  assert.equal((await handler(req("/api/v1/modules/news/bundle?version=not-a-semver", "GET"))).status, 400);
  assert.equal((await handler(req("/api/v1/modules/news/bundle", "POST"))).status, 400);
});

test("download -> upload -> preview -> approve round-trips over real HTTP requests", async () => {
  const { handler } = await setup();
  const downloadResponse = await handler(req("/api/v1/modules/news/bundle", "GET"));
  const submission = await downloadResponse.json();

  const previewResponse = await handler(req("/api/v1/modules/preview", "POST", submission));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json() as { bundleDigest: string; expectedSource: unknown;
    currentApproval: { approvalId: string } | null; permissionDiffDigest: string; codeWarning: boolean };
  assert.equal(preview.codeWarning, true);

  const draft = { expectedBundleDigest: preview.bundleDigest, expectedSource: preview.expectedSource,
    expectedCurrentApprovalId: preview.currentApproval?.approvalId ?? null,
    acknowledgedPermissionDiffDigest: preview.permissionDiffDigest, acknowledgedCodeWarning: true };
  const approveResponse = await handler(req("/api/v1/modules/approvals", "POST", { submission, draft },
    "http-transfer-approve-0001"));
  assert.equal(approveResponse.status, 201);
  const approved = await approveResponse.json() as { replayed: boolean; current: boolean };
  assert.equal(approved.replayed, false); assert.equal(approved.current, true);

  // A double-submit with the same idempotency key replays the same receipt (200, not a second row).
  const replay = await handler(req("/api/v1/modules/approvals", "POST", { submission, draft },
    "http-transfer-approve-0001"));
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { ...approved, replayed: true });
});

test("a tampered bundle refuses preview and approve with 400 and the exact verifier reason, not 503", async () => {
  const { handler } = await setup();
  const submission = await (await handler(req("/api/v1/modules/news/bundle", "GET"))).json() as
    { bundle: { manifest: Record<string, unknown> }; signature: unknown };
  // The signature is bound to the exact bundle digest; touching the manifest after the fact
  // (without re-signing) moves the bytes out from under the signature.
  const tampered = { ...submission,
    bundle: { ...submission.bundle, manifest: { ...submission.bundle.manifest, name: "Tampered" } } };

  const previewResponse = await handler(req("/api/v1/modules/preview", "POST", tampered));
  assert.equal(previewResponse.status, 400);
  assert.deepEqual(await previewResponse.json(), { error: "invalid_request", reason: "module_signature_digest_mismatch" });

  const filler = `sha256:${"0".repeat(64)}`;
  const approveResponse = await handler(req("/api/v1/modules/approvals", "POST", { submission: tampered,
    draft: { expectedBundleDigest: filler, expectedSource: { kind: "declarative-unsigned", keyId: null },
      expectedCurrentApprovalId: null, acknowledgedPermissionDiffDigest: filler, acknowledgedCodeWarning: true } },
    "http-tampered-approve-0001"));
  assert.equal(approveResponse.status, 400);
  assert.deepEqual(await approveResponse.json(), { error: "invalid_request", reason: "module_signature_digest_mismatch" });
});

test("a manifest that fails its own schema (not just the outer bundle shape) also refuses with 400, not 503", async () => {
  const { handler } = await setup();
  const submission = await (await handler(req("/api/v1/modules/news/bundle", "GET"))).json() as
    { bundle: { manifest: Record<string, unknown> } };
  // Manifest parsing runs before the signature check, so a schema-shape violation is caught first,
  // regardless of the signature. This is the module_manifest_* family, not module_bundle_/signature_.
  const invalidManifest = { bundle: { ...submission.bundle,
    manifest: { ...submission.bundle.manifest, controlRoomCompatibility: "not-a-range" } } };
  const previewResponse = await handler(req("/api/v1/modules/preview", "POST", invalidManifest));
  assert.equal(previewResponse.status, 400);
  assert.deepEqual(await previewResponse.json(), { error: "invalid_request", reason: "module_manifest_compatibility_invalid" });
});

test("an unsigned CODE bundle refuses preview with 400 module_bundle_code_source_untrusted, not 503", async () => {
  const { handler } = await setup();
  const submission = await (await handler(req("/api/v1/modules/news/bundle", "GET"))).json() as { bundle: unknown };
  const previewResponse = await handler(req("/api/v1/modules/preview", "POST", { bundle: submission.bundle }));
  assert.equal(previewResponse.status, 400);
  assert.deepEqual(await previewResponse.json(), { error: "invalid_request", reason: "module_bundle_code_source_untrusted" });
});

test("a bundle file with a path-traversal name refuses preview with 400, not 503", async () => {
  const { handler } = await setup();
  const submission = await (await handler(req("/api/v1/modules/news/bundle", "GET"))).json() as
    { bundle: { files: unknown[] } };
  const malicious = { bundle: { ...submission.bundle,
    files: [...submission.bundle.files, { path: "../../etc/passwd", contentBase64: Buffer.from("x").toString("base64") }] } };
  const previewResponse = await handler(req("/api/v1/modules/preview", "POST", malicious));
  assert.equal(previewResponse.status, 400);
  const body = await previewResponse.json() as { error: string; reason: string };
  assert.equal(body.error, "invalid_request");
  assert.match(body.reason, /^module_bundle_path_invalid$/);
});

test("approve requires exactly {submission, draft} and a well-formed idempotency key", async () => {
  const { handler } = await setup();
  const submission = await (await handler(req("/api/v1/modules/news/bundle", "GET"))).json();
  const preview = await (await handler(req("/api/v1/modules/preview", "POST", submission))).json() as
    { bundleDigest: string; expectedSource: unknown; currentApproval: unknown; permissionDiffDigest: string };
  const draft = { expectedBundleDigest: preview.bundleDigest, expectedSource: preview.expectedSource,
    expectedCurrentApprovalId: null, acknowledgedPermissionDiffDigest: preview.permissionDiffDigest, acknowledgedCodeWarning: true };
  assert.equal((await handler(req("/api/v1/modules/approvals", "POST", { submission }, "http-bad-shape-0001"))).status, 400);
  assert.equal((await handler(req("/api/v1/modules/approvals", "POST", { submission, draft, extra: 1 }, "http-bad-shape-0002"))).status, 400);
  assert.equal((await handler(req("/api/v1/modules/approvals", "POST", { submission, draft }, "short"))).status, 400);
});

test("an oversized upload body is refused by the byte ceiling before JSON is even parsed", async () => {
  const { handler } = await setup();
  const huge = "x".repeat(12_000_001);
  const response = await handler(new Request(`${origin}/api/v1/modules/preview`, { method: "POST",
    headers: { origin, "content-type": "application/json", "cf-access-jwt-assertion": jwt }, body: `{"bundle":"${huge}"}` }));
  assert.equal(response.status, 400);
});

test("preview and approve refuse a non-JSON content type", async () => {
  const { handler } = await setup();
  const response = await handler(new Request(`${origin}/api/v1/modules/preview`, { method: "POST",
    headers: { origin, "content-type": "text/plain", "cf-access-jwt-assertion": jwt }, body: "{}" }));
  assert.equal(response.status, 400);
});

test("GET a project's pack: descriptive fields only, a fingerprint header, and canonical module order", async () => {
  const { handler, service, clock } = await setup();
  // Create the project the same way project-http.test.ts does: through its own handler.
  const projectHandler = createProjectHttpHandler({ origin, trust: freshTrust, service, clock });
  const projectResponse = await projectHandler(req("/api/v1/projects", "POST", { title: "Http Pack Test", summary: "Check." }));
  assert.equal(projectResponse.status, 201);
  const { project } = await projectResponse.json() as { project: { projectId: string } };

  const packResponse = await handler(req(`/api/v1/projects/${encodeURIComponent(project.projectId)}/pack`, "GET"));
  assert.equal(packResponse.status, 200);
  assert.match(packResponse.headers.get("content-disposition") ?? "", /attachment; filename="http-pack-test\.project-pack\.json"/);
  assert.match(packResponse.headers.get("x-control-room-pack-digest") ?? "", /^sha256:[a-f0-9]{64}$/);
  const pack = await packResponse.json() as { schema: string; title: string; summary: string; modules: unknown[] };
  assert.equal(pack.title, "Http Pack Test");
  assert.equal(pack.summary, "Check.");
  assert.deepEqual(pack.modules, [], "a project created without a template selection has no enabled modules");
});

test("GET a pack for an unknown project id surfaces the project service's own not_found", async () => {
  const { handler } = await setup();
  const response = await handler(req("/api/v1/projects/project%3Adoes-not-exist/pack", "GET"));
  assert.equal(response.status, 404);
});
