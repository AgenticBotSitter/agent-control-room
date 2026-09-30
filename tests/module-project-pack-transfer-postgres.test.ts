// M6: download/upload modules and project packs, proved on real PostgreSQL as
// the production web login (control_room_web), never as a superuser. This
// exercises the new ModuleTransferServiceV1 download gate and the new
// project-pack export against the existing, unmodified approval ledger
// (migration 0195) and project service: the full owner journey of
// download -> upload -> preview -> approve, plus oversize/tampered/unsigned
// refusals and project-pack download.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import test from "node:test";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import { ModuleInstallApprovalServiceV1, moduleKeyIdV1, type ModuleTrustPolicyV1 } from "../src/modules/v1";
import { ModuleTransferServiceV1 } from "../src/modules/v1/transfer-service";
import { loadModuleSigningKeyV1 } from "../src/modules/v1/transfer";
import { WebProjectService } from "../src/web/v1/project-service";
import { PRODUCT_CONFIGURATION_SCHEMA_V1, parseProductConfigurationV1 } from "../src/config/v1/product-configuration";
import { exportProjectAsPackV1 } from "../src/project-packs/transfer";
import { parseProjectPackV2 } from "../src/project-packs/v2/project-pack";

const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 59340), PG = requiresRealPostgres(), KEY = new Uint8Array(32).fill(91);
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };
const scope = { tenantId: "tenant:module-transfer-pg", workspaceId: "workspace:module-transfer-pg" };
const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const people = {
  owner: { id: "identity:transfer-owner", grant: "grant:transfer-owner", role: "owner", actions: '["*"]', risk: "critical" },
  // A real, narrower grant: read-only project access, no module authority at all.
  limited: { id: "identity:transfer-limited", grant: "grant:transfer-limited", role: "viewer",
    actions: '["projects.read"]', risk: "low" },
} as const;
const token = (id: string) => sha256Digest({ session: id });
const web = (id: string): VerifiedWebIdentity => ({ provider: "test", subject: id, tokenDigest: token(id), issuedAt, expiresAt,
  verificationExpiresAt: expiresAt });
const owner = web(people.owner.id), limited = web(people.limited.id);

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  return { pkcs8, spki, keyId: moduleKeyIdV1(spki) };
}

function pool(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0]) {
  const login = postgres.connection("web");
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: login.user,
    password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: (work: (tx: DatabaseSession) => unknown) => bound.client.transaction(work as never),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(work, check) };
  return { client, config, close: () => bound.close() };
}

test("download -> upload -> preview -> approve round-trips on the production web login; oversize/tampered/unsigned CODE bundles refuse", async t => {
  const skip = needsPg(); if (skip) { t.skip(skip.skip); return; } ran += 1;
  await withRealPostgres(async postgres => {
    const asAdmin = async (sql: string, params: unknown[] = []) => {
      const client = new Client(postgres.admin({ database: postgres.database })); await client.connect();
      try { return await client.query(sql, params); } finally { await client.end(); }
    };
    await asAdmin("INSERT INTO tenants(id,display_name) VALUES($1,$1)", [scope.tenantId]);
    await asAdmin("INSERT INTO workspaces(id,tenant_id,display_name) VALUES($1,$2,$1)", [scope.workspaceId, scope.tenantId]);
    for (const person of Object.values(people)) {
      await asAdmin(`INSERT INTO control_identities(id,tenant_id,actor_type,display_name,auth_provider,auth_subject_digest,state,
        created_at,updated_at) VALUES($1,$2,'human',$1,'test',$3,'active',$4,$4)`,
      [person.id, scope.tenantId, sha256Digest({ provider: "test", subject: person.id }), issuedAt]);
      await asAdmin(`INSERT INTO control_role_grants(id,tenant_id,identity_id,role_key,allowed_actions,project_ids,risk_ceiling,
        allow_external_effects,require_strong_factor,created_at,updated_at) VALUES($1,$2,$3,$4,$5::jsonb,'["*"]',$6,true,false,$7,$7)`,
      [person.grant, scope.tenantId, person.id, person.role, person.actions, person.risk, issuedAt]);
      await asAdmin("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
        [scope.tenantId, token(person.id), person.id, issuedAt, expiresAt]);
    }

    const connection = pool(postgres);
    try {
      await verifyPrivateDatabase(connection.client, connection.config, { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        ownerIdentityId: people.owner.id, issuer: "test" }, Date.now(), { nativeQueue: true });

      // --- Module download is gated by the exact same modules.read grant as the rest of the module surface. ---
      const publisher = keyPair();
      const signingKey = loadModuleSigningKeyV1(publisher.pkcs8);
      const transfers = new ModuleTransferServiceV1(connection.client, scope, signingKey);
      await assert.rejects(transfers.downloadModule(limited, "news"), /access_denied/u, "no modules.read grant");
      await assert.rejects(transfers.downloadModule(owner, "doesNotExist"), /not_found/u);
      const download = await transfers.downloadModule(owner, "news");
      assert.equal((download.bundle.manifest as { id: string }).id, "news");
      assert.deepEqual(download.bundle.files, []);
      assert.ok(download.signature, "a configured local signing key signs the download");

      // The download is a plain JSON envelope: round-trip it through JSON exactly as a saved file would be.
      const savedFile = JSON.stringify({ bundle: download.bundle, signature: download.signature });
      const submission = JSON.parse(savedFile) as { bundle: unknown; signature: unknown };

      const trust: ModuleTrustPolicyV1 = { trustedKeys: [{ keyId: publisher.keyId, publicKeySpki: publisher.spki,
        label: "Local owner key", moduleIds: ["*"] }], reviewedBundleDigests: [] };
      const approvals = new ModuleInstallApprovalServiceV1(connection.client, scope, KEY, trust, "0.1.0");

      // Unsigned-CODE upload (the signature dropped before "upload") is refused, not silently accepted.
      await assert.rejects(approvals.preview(owner, { bundle: submission.bundle }), /module_bundle_code_source_untrusted/u);

      // A tampered upload (one byte of the saved file changed) is refused: the digest no longer matches the signature.
      const tampered = { bundle: { ...submission.bundle as object, manifest: { ...(submission.bundle as { manifest: object }).manifest, publisher: "Someone else" } },
        signature: submission.signature };
      await assert.rejects(approvals.preview(owner, tampered), /module_signature_digest_mismatch/u);

      // An oversized upload is refused by the verifier's own per-file byte ceiling (1 MiB): one byte over it.
      const oversized = { bundle: { ...submission.bundle as object,
        files: [{ path: "prompts/too-big.txt", contentBase64: Buffer.alloc(1_048_578, 65).toString("base64") }] },
        signature: null };
      await assert.rejects(approvals.preview(owner, oversized), /module_bundle_file_oversized/u);

      // The exact saved file previews cleanly and approves end to end.
      const preview = await approvals.preview(owner, submission);
      assert.equal(preview.codeWarning, true);
      assert.equal(preview.bundleDigest, download.bundleDigest);
      const draft = { expectedBundleDigest: preview.bundleDigest, expectedSource: preview.expectedSource,
        expectedCurrentApprovalId: preview.currentApproval?.approvalId ?? null,
        acknowledgedPermissionDiffDigest: preview.permissionDiffDigest, acknowledgedCodeWarning: true };
      const approved = await approvals.approve(owner, submission, draft, `module-transfer-approve-${randomUUID()}`);
      assert.equal(approved.replayed, false); assert.equal(approved.current, true);
      const asserted = await approvals.assertApproved(submission);
      assert.equal(asserted.approvalId, approved.approvalId);

      // --- Project pack download: an owner-authorized project, exported and round-tripped through the parser. ---
      const productConfiguration = parseProductConfigurationV1({ schema: PRODUCT_CONFIGURATION_SCHEMA_V1,
        displayName: "Test install", defaultTimezone: "UTC",
        modules: { ideaLab: false, news: true, sessionObservations: false },
        limits: { maxProjects: 10, maxTasksPerProject: 10, maxResultsPerTask: 10, maxArticleSources: 10, maxIdeaParticipants: 10 },
        projectTemplates: [{ id: "news-desk", displayName: "News desk", enabledModules: ["news"] }] });
      const projects = new WebProjectService(connection.client, scope, Date.now, undefined, undefined, productConfiguration);
      const created = await projects.create(owner, { title: "My News Desk", summary: "Tracks AI news for the team.",
        templateSelection: { templateId: "news-desk", configurationDigest: sha256Digest(productConfiguration) } },
      `module-transfer-project-${randomUUID()}`);
      const view = await projects.getView(owner, created.project.projectId);
      assert.deepEqual(view.presentation?.enabledModules, ["news"]);
      const packDownload = exportProjectAsPackV1({ title: view.title, summary: view.summary,
        enabledModules: view.presentation?.enabledModules ?? [] });
      assert.deepEqual(packDownload.pack.modules, [{ id: "news", version: "1.0.0" }]);
      const roundTripped = parseProjectPackV2(JSON.parse(JSON.stringify(packDownload.pack)));
      assert.deepEqual(roundTripped, packDownload.pack);
    } finally { await connection.close(); }
  }, { port: PORT, allowedPorts: [PORT], boundMs: 180_000 });
});

test("the module/pack transfer real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1); assert.equal(ran, required);
});
