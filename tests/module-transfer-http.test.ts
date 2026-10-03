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
  return { ...base, publisher, transfers, approvals, handler, clock, trustPolicy, scope };
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


test("R7L-09: metadata and skill upgrades preview and approve through the authenticated service", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const { createAccessVerifier } = await import("../src/web/v1/access-verifier");
  const { getRegisteredModuleManifestV1, MODULE_BUNDLE_SCHEMA_V1 } = await import("../src/modules/v1");
  const { sha256Digest } = await import("../src/security");
  const identity = createAccessVerifier(freshTrust)(req("/api/v1/modules/preview"), nowMs);
  let manifest = structuredClone({ ...getRegisteredModuleManifestV1("news")!, class: "declarative" as const });
  manifest.permissions.projectData[0]!.access = ["read"];
  const skill = (patch: Record<string, unknown> = {}) => {
    const content = { schema: "control-room.module-shared-skill/v1", id: "skill.summary", version: 1,
      name: "Summary", instructions: "Summarise the evidence.", ...patch };
    const { schema: _schema, ...value } = content;
    return { ...value, contentDigest: sha256Digest(content) };
  };
  const submission = () => ({ bundle: { schema: MODULE_BUNDLE_SCHEMA_V1, manifest, files: [] } });
  const approve = async (key: string, expectDiff: boolean) => {
    const preview = await f.approvals.preview(identity, submission());
    assert.equal(preview.permissionDiff.added.length + preview.permissionDiff.removed.length > 0, expectDiff, key);
    const draft = { expectedBundleDigest: preview.bundleDigest, expectedSource: preview.expectedSource,
      expectedCurrentApprovalId: preview.currentApproval?.approvalId ?? null,
      acknowledgedPermissionDiffDigest: preview.permissionDiffDigest, acknowledgedCodeWarning: preview.codeWarning };
    const approved = await f.approvals.approve(identity, submission(), draft, key);
    assert.equal((await f.approvals.current(identity, manifest.id))?.approvalId, approved.approvalId);
    return approved;
  };
  await approve("module-details-baseline-0001", true);
  const changes: Array<[string, (value: typeof manifest) => void, boolean]> = [
    ["tab-label", m => { m.ui.projectTabs[0]!.label = "Renamed news"; }, true],
    ["settings", m => { m.ui.settings = { type: "object", properties: { limit: { type: "integer", title: "Limit", default: 1 } },
      required: ["limit"], additionalProperties: false }; }, true],
    ["skills-added", m => { m.skills = [skill()]; }, true],
    ["skills-name", m => { m.skills = [skill({ name: "Revised summary" })]; }, true],
    ["skills-text", m => { m.skills = [skill({ name: "Revised summary", instructions: "Use checked evidence only." })]; }, true],
    ["skills-version", m => { m.skills = [skill({ version: 2 })]; }, true],
    ["skills-removed", m => { delete m.skills; }, true],
    ["version-only", () => {}, false],
    ["license", m => { m.license = "MIT"; }, false],
    ["read-write", m => { m.permissions.projectData[0]!.access = ["read", "write"]; }, true],
  ];
  for (const [index, [label, change, expectDiff]] of changes.entries()) {
    manifest = structuredClone(manifest); change(manifest); manifest.version = `1.0.${index + 1}`;
    await approve(`module-details-${label}-0001`, expectDiff);
  }
  manifest = structuredClone(manifest);
  manifest.ui.projectTabs[0]!.label = "Burst upgrade";
  const previews = await Promise.all(Array.from({ length: 50 }, () => f.approvals.preview(identity, submission())));
  assert.ok(previews.every(value => value.permissionDiffDigest === previews[0]!.permissionDiffDigest));
  const current = previews[0]!;
  const draft = { expectedBundleDigest: current.bundleDigest, expectedSource: current.expectedSource,
    expectedCurrentApprovalId: current.currentApproval!.approvalId,
    acknowledgedPermissionDiffDigest: current.permissionDiffDigest, acknowledgedCodeWarning: current.codeWarning };
  const receipts = await Promise.all(Array.from({ length: 50 }, () =>
    f.approvals.approve(identity, submission(), draft, "module-details-burst-upgrade-0001")));
  assert.equal(new Set(receipts.map(value => value.approvalId)).size, 1);
  assert.equal(receipts.filter(value => !value.replayed).length, 1);
  assert.equal(receipts.filter(value => value.replayed).length, 49);
  assert.equal((await f.approvals.current(identity, manifest.id))?.approvalId, receipts[0]!.approvalId);
});

test("R7L-09: signed historical approval rows remain readable but a forged digest does not", async t => {
  const f = await setup(); t.after(() => f.db.close());
  const { createAccessVerifier } = await import("../src/web/v1/access-verifier");
  const { previousModulePermissionsDigestV1, legacyModulePermissionsDigestV1 } = await import("../src/modules/v1/bundle");
  const { sha256Digest, hmacSha256Tag } = await import("../src/security");
  const { parseModuleManifestV1 } = await import("../src/modules/v1/manifest");
  const identity = createAccessVerifier(freshTrust)(req("/api/v1/modules/preview"), nowMs);
  const submission = await (await f.handler(req("/api/v1/modules/news/bundle"))).json();
  const preview = await f.approvals.preview(identity, submission);
  const approved = await f.approvals.approve(identity, submission, { expectedBundleDigest: preview.bundleDigest,
    expectedSource: preview.expectedSource, expectedCurrentApprovalId: null,
    acknowledgedPermissionDiffDigest: preview.permissionDiffDigest, acknowledgedCodeWarning: true }, "historical-approval-baseline-0001");
  for (const digestFor of [previousModulePermissionsDigestV1, legacyModulePermissionsDigestV1, () => `sha256:${"0".repeat(64)}`]) {
    // The recording port presents an authenticated old-format row without altering the real stored row.
    const session = (tx: import("../src/persistence/database").DatabaseSession): import("../src/persistence/database").DatabaseSession => ({
      query: async <T>(statement: string, params?: unknown[]) => {
        const result = await tx.query<T>(statement, params);
        if (!statement.startsWith("SELECT") || !statement.includes("control_module_install_approvals")) return result;
        return { ...result, rows: result.rows.map(value => {
          const row = value as Record<string, unknown>;
          const permissionsDigest = digestFor(parseModuleManifestV1(row.manifest));
          const material = { id: row.id, tenantId: f.scope.tenantId, moduleId: row.module_id, moduleVersion: row.module_version,
            moduleClass: row.module_class, bundleDigest: row.bundle_digest, permissionsDigest, manifest: row.manifest,
            sourceKind: row.source_kind, signerKeyId: row.signer_key_id, codeWarningAcknowledged: row.code_warning_acknowledged,
            supersedesApprovalId: row.supersedes_approval_id, permissionDiff: row.permission_diff,
            permissionDiffDigest: row.permission_diff_digest, ownerIdentityId: row.owner_identity_id,
            idempotencyKey: row.idempotency_key, requestDigest: row.request_digest, approvedAt: row.approved_at instanceof Date ? row.approved_at.toISOString() : new Date(String(row.approved_at)).toISOString() };
          return { ...row, permissions_digest: permissionsDigest, record_digest: sha256Digest(material),
            auth_tag: hmacSha256Tag(KEY, { purpose: "module-install-approval/v1", record: material }) } as T;
        }) };
      } });
    const client: import("../src/persistence/database").DatabaseClient = {
      query: session(f.client).query,
      transaction: work => f.client.transaction(tx => work(session(tx))),
      transactionWithPreCommitCheck: (work, check) => f.client.transactionWithPreCommitCheck(tx => work(session(tx)), check),
    };
    const historical = new ModuleInstallApprovalServiceV1(client, f.scope, KEY, f.trustPolicy, "0.1.0", f.clock);
    if (digestFor === previousModulePermissionsDigestV1 || digestFor === legacyModulePermissionsDigestV1) {
      assert.equal((await historical.current(identity, "news"))?.approvalId, approved.approvalId);
      assert.equal((await historical.preview(identity, submission)).approvalRequired, false);
    } else await assert.rejects(historical.current(identity, "news"), /module_install_approval_integrity_failed/);
  }
});
