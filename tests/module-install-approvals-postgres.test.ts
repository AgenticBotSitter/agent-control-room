// Real-PostgreSQL proof for migration 0195 and the owner's module install
// approval ledger, run as the production web login (control_room_web, a member
// of control_room_private_web) — never as a superuser. The superuser connection
// only seeds fixtures and proves the append-only trigger holds even for it.
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, Pool } from "pg";
import { realPostgresSkipMessage, requiresRealPostgres, withRealPostgres } from "./support/attack-kit/index";
import { bindPrivatePgPool } from "../src/web/v1/private-pg-database";
import { privatePgOptions } from "../src/web/v1/private-pg-options";
import type { VerifiedWebIdentity } from "../src/web/v1/access-verifier";
import { sha256Digest } from "../src/security";
import { verifyPrivateDatabase } from "../src/web/v1/private-database-preflight";
import type { DatabaseClient, DatabaseSession } from "../src/persistence/database";
import {
  MODULE_BUNDLE_SCHEMA_V1, MODULE_MANIFEST_SCHEMA_V1, ModuleInstallApprovalServiceV1, canonicalModuleBundleV1,
  moduleKeyIdV1, signModuleBundleV1, type ModuleBundleInputV1, type ModuleTrustPolicyV1,
} from "../src/modules/v1";

// CONTROL_ROOM_PG_TEST_PORT_BASE moves the disposable cluster, as in the desk proof.
const PORT = Number(process.env.CONTROL_ROOM_PG_TEST_PORT_BASE ?? 58395), PG = requiresRealPostgres(), KEY = new Uint8Array(32).fill(77);
let required = 0, ran = 0;
const needsPg = () => { if (PG) { required += 1; return undefined; } return { skip: realPostgresSkipMessage() }; };
const scope = { tenantId: "tenant:module-pg", workspaceId: "workspace:module-pg" };
const issuedAt = new Date(Date.now() - 60_000).toISOString(), expiresAt = new Date(Date.now() + 3_600_000).toISOString();
const people = {
  owner: { id: "identity:module-owner", grant: "grant:module-owner", role: "owner", risk: "critical" },
  limited: { id: "identity:module-limited", grant: "grant:module-limited", role: "owner", risk: "high" },
  operator: { id: "identity:module-operator", grant: "grant:module-operator", role: "operator", risk: "critical" },
} as const;
const token = (id: string) => sha256Digest({ session: id });
const web = (id: string): VerifiedWebIdentity => ({ provider: "test", subject: id, tokenDigest: token(id), issuedAt, expiresAt,
  verificationExpiresAt: expiresAt });
const owner = web(people.owner.id), limited = web(people.limited.id), operator = web(people.operator.id);

const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
function keyPair(): { privateKey: KeyObject; spki: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return { privateKey, spki, keyId: moduleKeyIdV1(spki) };
}
const publisher = keyPair(), secondPublisher = keyPair();
// Two trusted keys, so the proof can show the owner approves the signer they were shown, not any trusted one.
const trusting: ModuleTrustPolicyV1 = { trustedKeys: [
  { keyId: publisher.keyId, publicKeySpki: publisher.spki, label: "Test publisher", moduleIds: ["*"] },
  { keyId: secondPublisher.keyId, publicKeySpki: secondPublisher.spki, label: "Second publisher", moduleIds: ["*"] },
], reviewedBundleDigests: [] };
const permissions = (access: ("read" | "write")[] = ["read"]) => ({
  projectData: [{ resource: "module_weekly_digest_notes", access }], taskTemplates: ["digest.weekly"], pipelineTemplates: [],
  workerCapabilities: [], notifications: { slots: ["project.digest"], maxPerHour: 2 }, attention: { slots: [], maxOpenPerProject: 0 },
  scheduledJobs: { jobs: [], maxConcurrent: 0, maxRunsPerDay: 0, maxRuntimeSeconds: 0 } });
const manifest = (overrides: Record<string, unknown> = {}) => ({ schema: MODULE_MANIFEST_SCHEMA_V1, id: "weeklyDigest",
  version: "1.0.0", name: "Weekly digest", publisher: "Example Publisher", license: "Apache-2.0",
  controlRoomCompatibility: "^0.1.0", class: "declarative", permissions: permissions(),
  ui: { projectTabs: [{ id: "digest.tab", label: "Digest" }], needsYou: false },
  events: { subscribe: ["project.created"], emitNotifications: false }, ...overrides });
const declarative = (overrides: Record<string, unknown> = {}): ModuleBundleInputV1 => ({ schema: MODULE_BUNDLE_SCHEMA_V1,
  manifest: manifest(overrides), files: [{ path: "prompts/weekly.md", contentBase64: b64("Summarise the week.\n") }] });
const code = (overrides: Record<string, unknown> = {}): ModuleBundleInputV1 => ({ schema: MODULE_BUNDLE_SCHEMA_V1,
  manifest: manifest({ id: "sourceTools", name: "Source tools", class: "code",
    permissions: { ...permissions(), projectData: [{ resource: "module_source_tools_notes", access: ["read", "write"] }] },
    data: { schemaNamespace: "module_source_tools", tenantScoped: true, projectScoped: true,
      migrations: [{ version: "1.0.0", upFile: "migrations/0001.up.sql", downFile: "migrations/0001.down.sql" }] }, ...overrides }),
  files: [{ path: "dist/index.js", contentBase64: b64("export const answer = 42;\n") },
    { path: "migrations/0001.up.sql", contentBase64: b64("CREATE TABLE module_source_tools.notes(id text);\n") },
    { path: "migrations/0001.down.sql", contentBase64: b64("DROP TABLE module_source_tools.notes;\n") }] });
const signed = (bundle: ModuleBundleInputV1) => ({ bundle, signature: signModuleBundleV1(bundle, publisher.privateKey, publisher.spki) });
const digestOf = (bundle: ModuleBundleInputV1) => canonicalModuleBundleV1(bundle).bundleDigest;
const DIGEST = `sha256:${"e".repeat(64)}`, TAG = `hmac-sha256:${"e".repeat(64)}`;

/** A direct approval INSERT, bypassing the service, as whichever login runs it. */
const rawApproval = (o: { moduleId: string; ownerId: string; key: string; supersedes?: string | null; moduleClass?: string;
  source?: string; signer?: string | null; ack?: boolean; id?: string }) => {
  const moduleClass = o.moduleClass ?? "declarative";
  return [`INSERT INTO control_module_install_approvals(tenant_id,id,module_id,module_version,module_class,bundle_digest,
    permissions_digest,manifest,source_kind,signer_key_id,code_warning_acknowledged,supersedes_approval_id,permission_diff,
    permission_diff_digest,owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,approved_at)
    VALUES($1,$2,$3,'1.0.0',$4,$5,$5,$6::jsonb,$7,$8,$9,$10,'{"added":[],"removed":[]}',$5,$11,$12,$5,$5,$13,now())`,
  [scope.tenantId, o.id ?? `module-approval:${randomUUID()}`, o.moduleId, moduleClass, DIGEST,
    JSON.stringify({ id: o.moduleId, version: "1.0.0", class: moduleClass }), o.source ?? "declarative-unsigned",
    o.signer ?? null, o.ack ?? false, o.supersedes ?? null, o.ownerId, o.key, TAG]] as [string, unknown[]];
};

const refused: string[] = [];
let onQuery: ((sql: string) => void) | undefined;
function pool(postgres: Parameters<Parameters<typeof withRealPostgres>[0]>[0]) {
  const login = postgres.connection("web");
  const config = { host: "127.0.0.1", port: postgres.port, database: postgres.database, username: login.user,
    password: login.password, majorVersion: 17 as const };
  const bound = bindPrivatePgPool(new Pool({ ...privatePgOptions(config), host: login.host }));
  const traced = (session: DatabaseSession): DatabaseSession => ({ query: async (sql, params) => {
    onQuery?.(sql);
    try { return await session.query(sql, params); }
    catch (error) { refused.push(`${String((error as { sqlState?: unknown }).sqlState)} ${sql.replace(/\s+/g, " ").trim()}`); throw error; }
  } });
  const client: DatabaseClient = { query: (sql, params) => bound.client.query(sql, params),
    transaction: work => bound.client.transaction(tx => work(traced(tx))),
    transactionWithPreCommitCheck: (work, check) => bound.client.transactionWithPreCommitCheck(tx => work(traced(tx)), check) };
  return { client, config, close: () => bound.close() };
}

test("the production web login keeps an owner-only, append-only, replay-proof module approval chain", async t => {
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
        allow_external_effects,require_strong_factor,created_at,updated_at) VALUES($1,$2,$3,$4,'["*"]','["*"]',$5,true,false,$6,$6)`,
      [person.grant, scope.tenantId, person.id, person.role, person.risk, issuedAt]);
      await asAdmin("INSERT INTO control_web_sessions(tenant_id,token_digest,identity_id,issued_at,expires_at) VALUES($1,$2,$3,$4,$5)",
        [scope.tenantId, token(person.id), person.id, issuedAt, expiresAt]);
    }
    const count = async (moduleId?: string) => Number((await asAdmin(
      `SELECT count(*)::int AS n FROM control_module_install_approvals${moduleId ? " WHERE module_id=$1" : ""}`,
      moduleId ? [moduleId] : [])).rows[0]!.n);

    const connection = pool(postgres);
    let expireSessions = false;
    const clock = () => expireSessions ? Date.parse(expiresAt) + 1 : Date.now();
    try {
      // The web startup preflight checks the live grant inventory and schema digest, 0195 included.
      await verifyPrivateDatabase(connection.client, connection.config, { tenantId: scope.tenantId, workspaceId: scope.workspaceId,
        ownerIdentityId: people.owner.id, issuer: "test" }, Date.now(), { nativeQueue: true });
      const service = new ModuleInstallApprovalServiceV1(connection.client, scope, KEY, trusting, "0.1.0", clock);
      const draftFor = (preview: Awaited<ReturnType<typeof service.preview>>, overrides: Record<string, unknown> = {}) => ({
        expectedBundleDigest: preview.bundleDigest, expectedSource: preview.expectedSource,
        expectedCurrentApprovalId: preview.currentApproval?.approvalId ?? null,
        acknowledgedPermissionDiffDigest: preview.permissionDiffDigest, acknowledgedCodeWarning: preview.codeWarning, ...overrides });

      // --- First install of a DECLARATIVE module, shared unsigned. ---
      const v1 = { bundle: declarative() };
      await assert.rejects(service.assertApproved(v1), /module_install_approval_required/u, "nothing is approved yet");
      const preview1 = await service.preview(owner, v1);
      assert.equal(preview1.approvalRequired, true); assert.equal(preview1.currentApproval, null);
      assert.equal(preview1.source.kind, "declarative-unsigned"); assert.equal(preview1.codeWarning, false);
      assert.ok(preview1.permissionDiff.added.includes("projectData:module_weekly_digest_notes:read"));
      assert.equal(preview1.installsNow, false); assert.equal(preview1.executesCode, false); assert.equal(preview1.runsMigrations, false);
      await assert.rejects(service.preview(operator, v1), /access_denied/u, "an operator is not the owner");
      // A double-clicked Approve: one row, the second caller replays it.
      const [a, b] = await Promise.all([service.approve(owner, v1, draftFor(preview1), "module-approve-v1-0001"),
        service.approve(owner, v1, draftFor(preview1), "module-approve-v1-0001")]);
      assert.equal(a.approvalId, b.approvalId);
      assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
      assert.equal(a.current, true); assert.equal(a.installsNow, false); assert.equal(a.executesCode, false);
      assert.equal(await count("weeklyDigest"), 1);
      const approvedV1 = await service.assertApproved(v1);
      assert.equal(approvedV1.approvalId, a.approvalId); assert.equal(approvedV1.executesCode, false);
      assert.equal((await service.current(operator, "weeklyDigest"))?.approvalId, a.approvalId, "an operator may read the approval");
      // Approving what is already current is refused rather than extending the chain.
      const again = await service.preview(owner, v1);
      assert.equal(again.approvalRequired, false);
      await assert.rejects(service.approve(owner, v1, draftFor(again), "module-approve-v1-0002"), /conflict/u);

      // --- A permission diff forces a fresh approval. ---
      const v2 = { bundle: declarative({ version: "1.1.0", permissions: permissions(["read", "write"]) }) };
      await assert.rejects(service.assertApproved(v2), /module_install_approval_required/u, "v1's approval does not cover v2");
      const preview2 = await service.preview(owner, v2);
      assert.deepEqual(preview2.permissionDiff, { added: ["projectData:module_weekly_digest_notes:write"], removed: [] });
      assert.equal(preview2.currentApproval?.approvalId, a.approvalId);
      // The diff the owner acknowledged must be this one: v1's first-install diff does not transfer.
      await assert.rejects(service.approve(owner, v2, draftFor(preview2, { acknowledgedPermissionDiffDigest: preview1.permissionDiffDigest }),
        "module-approve-v2-stale"), /conflict/u);
      // Digest substitution between preview and approve: the owner saw v1's bytes, v2's arrive.
      await assert.rejects(service.approve(owner, v2, draftFor(preview2, { expectedBundleDigest: preview1.bundleDigest }),
        "module-approve-v2-swap"), /conflict/u);
      // A preview taken before v1 was approved names the wrong current approval.
      await assert.rejects(service.approve(owner, v2, draftFor(preview2, { expectedCurrentApprovalId: null }),
        "module-approve-v2-stale-head"), /conflict/u);
      assert.equal(await count("weeklyDigest"), 1, "no refused approval left a row");

      // A stop halfway: the session expires after the row is written, before commit. Nothing lands.
      onQuery = sql => { if (/INSERT INTO control_module_install_approvals/u.test(sql)) expireSessions = true; };
      await assert.rejects(service.approve(owner, v2, draftFor(preview2), "module-approve-v2-0001"), /authentication_required/u);
      onQuery = undefined; expireSessions = false;
      assert.equal(await count("weeklyDigest"), 1, "the interrupted approval rolled back");
      // The retry after the failure is a fresh approval, not a replay of a phantom one.
      const approvedV2 = await service.approve(owner, v2, draftFor(preview2), "module-approve-v2-0001");
      assert.equal(approvedV2.replayed, false); assert.equal(approvedV2.supersedesApprovalId, a.approvalId);
      assert.deepEqual(approvedV2.permissionDiff.added, ["projectData:module_weekly_digest_notes:write"]);
      assert.equal((await service.assertApproved(v2)).approvalId, approvedV2.approvalId);

      // --- Replay of an old approval never makes it current again. ---
      await assert.rejects(service.assertApproved(v1), /module_install_approval_required/u, "v1 is superseded");
      const replayed = await service.approve(owner, v1, draftFor(preview1), "module-approve-v1-0001");
      assert.deepEqual({ id: replayed.approvalId, replayed: replayed.replayed, current: replayed.current },
        { id: a.approvalId, replayed: true, current: false });
      await assert.rejects(service.assertApproved(v1), /module_install_approval_required/u, "the replayed receipt changed nothing");
      // The same key with a different request is a conflict, not a replay.
      await assert.rejects(service.approve(owner, v2, draftFor(preview2), "module-approve-v1-0001"), /conflict/u);
      // Even by direct SQL, the web login cannot fork the chain from the superseded approval or start a second chain.
      await assert.rejects(postgres.query("web", ...rawApproval({ moduleId: "weeklyDigest", ownerId: people.owner.id,
        key: "raw-fork-superseded-0001", supersedes: a.approvalId })), /duplicate key/u);
      await assert.rejects(postgres.query("web", ...rawApproval({ moduleId: "weeklyDigest", ownerId: people.owner.id,
        key: "raw-second-root-0001" })), /duplicate key/u);
      // Going back to v1 is possible only as a NEW owner approval of the (now narrower) diff.
      const back = await service.preview(owner, v1);
      assert.deepEqual(back.permissionDiff, { added: [], removed: ["projectData:module_weekly_digest_notes:write"] });
      const downgraded = await service.approve(owner, v1, draftFor(back), "module-approve-v1-back-0001");
      assert.equal(downgraded.supersedesApprovalId, approvedV2.approvalId);
      assert.equal((await service.assertApproved(v1)).approvalId, downgraded.approvalId);
      await assert.rejects(service.assertApproved(v2), /module_install_approval_required/u);

      // --- Concurrent approvals of the same head from two tabs: exactly one lands. ---
      const left = { bundle: declarative({ version: "1.2.0", name: "Weekly digest left" }) };
      const right = { bundle: declarative({ version: "1.2.0", name: "Weekly digest right" }) };
      const [previewLeft, previewRight] = [await service.preview(owner, left), await service.preview(owner, right)];
      const raced = await Promise.allSettled([service.approve(owner, left, draftFor(previewLeft), "module-approve-left-0001"),
        service.approve(owner, right, draftFor(previewRight), "module-approve-right-0001")]);
      const won = raced.filter(value => value.status === "fulfilled");
      assert.equal(won.length, 1, JSON.stringify(raced.map(value => value.status === "rejected" ? String(value.reason) : "ok")));
      assert.match(String((raced.find(value => value.status === "rejected") as PromiseRejectedResult).reason), /conflict/u);
      const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof service.approve>>>).value;
      assert.equal((await service.current(owner, "weeklyDigest"))?.approvalId, winner.approvalId);
      const loser = winner.bundleDigest === previewLeft.bundleDigest ? right : left;
      await assert.rejects(service.assertApproved(loser), /module_install_approval_required/u,
        "same version and permissions, different bytes: the losing tab's bundle is not approved");
      assert.equal(await count("weeklyDigest"), 4);

      // --- The trust source the owner was shown is part of what they approve. ---
      const sourced = declarative({ version: "1.3.0" });
      const previewSigned = await service.preview(owner, signed(sourced));
      assert.equal(previewSigned.source.kind, "signed");
      await assert.rejects(service.approve(owner, { bundle: sourced }, draftFor(previewSigned), "module-approve-drop-signature"),
        /conflict/u, "shown as signed, the same bytes arrive unsigned");
      const previewUnsigned = await service.preview(owner, { bundle: sourced });
      await assert.rejects(service.approve(owner, signed(sourced), draftFor(previewUnsigned), "module-approve-add-signature"),
        /conflict/u, "shown as unsigned, the same bytes arrive signed");
      const bySecond = { bundle: sourced, signature: signModuleBundleV1(sourced, secondPublisher.privateKey, secondPublisher.spki) };
      await assert.rejects(service.approve(owner, bySecond, draftFor(previewSigned), "module-approve-swap-signer"),
        /conflict/u, "shown as signed by one trusted key, the same bytes arrive signed by another");
      // A reviewed pin and an unsigned share both name no key: the source kind itself is bound.
      const pinned = new ModuleInstallApprovalServiceV1(connection.client, scope, KEY,
        { ...trusting, reviewedBundleDigests: [digestOf(sourced)] }, "0.1.0", clock);
      const previewReviewed = await pinned.preview(owner, { bundle: sourced });
      assert.deepEqual(previewReviewed.expectedSource, { kind: "reviewed", keyId: null });
      await assert.rejects(service.approve(owner, { bundle: sourced }, draftFor(previewReviewed), "module-approve-reviewed-to-unsigned"),
        /conflict/u, "shown as reviewed, approved as an unsigned share");
      await assert.rejects(pinned.approve(owner, { bundle: sourced }, draftFor(previewUnsigned), "module-approve-unsigned-to-reviewed"),
        /conflict/u, "shown as an unsigned share, approved as reviewed");
      // A draft whose source is malformed is refused before anything is read.
      for (const expectedSource of [{ kind: "signed", keyId: null }, { kind: "declarative-unsigned", keyId: publisher.keyId },
        { kind: "trusted", keyId: null }, { kind: "signed", keyId: "key" }, { kind: "reviewed" },
        { kind: "reviewed", keyId: null, keyLabel: "x" }, null, "signed"]) {
        await assert.rejects(service.approve(owner, { bundle: sourced }, draftFor(previewUnsigned, { expectedSource }),
          "module-approve-bad-source"), /invalid_request/u, JSON.stringify(expectedSource));
      }
      const { expectedSource: _omitted, ...withoutSource } = draftFor(previewUnsigned);
      await assert.rejects(service.approve(owner, { bundle: sourced }, withoutSource, "module-approve-no-source"), /invalid_request/u);
      assert.equal(await count("weeklyDigest"), 4, "no source swap left a row");
      // The source the owner was shown is what the row records.
      const approvedSigned = await service.approve(owner, signed(sourced), draftFor(previewSigned), "module-approve-signed-0001");
      assert.deepEqual({ kind: approvedSigned.sourceKind, key: approvedSigned.signerKeyId }, { kind: "signed", key: publisher.keyId });
      await assert.rejects(service.assertApproved(bySecond), /module_install_approval_required/u, "another signer is not approved");
      await assert.rejects(service.assertApproved({ bundle: sourced }), /module_install_approval_required/u);
      assert.equal(await count("weeklyDigest"), 5);

      // --- A CODE module: trusted signature, plain warning, critical owner grant. ---
      const codeBundle = code(), codeSubmission = signed(codeBundle);
      await assert.rejects(service.preview(owner, { bundle: codeBundle }), /module_bundle_code_source_untrusted/u);
      const previewCode = await service.preview(owner, codeSubmission);
      assert.equal(previewCode.codeWarning, true); assert.equal(previewCode.source.kind, "signed");
      await assert.rejects(service.approve(owner, codeSubmission, draftFor(previewCode, { acknowledgedCodeWarning: false }),
        "module-approve-code-nowarn"), /invalid_request/u, "the CODE warning must be acknowledged");
      await assert.rejects(service.approve(limited, codeSubmission, draftFor(previewCode), "module-approve-code-limited"),
        /access_denied/u, "an owner grant below critical cannot approve CODE");
      // The database enforces the same owner rule for anyone holding INSERT.
      await assert.rejects(postgres.query("web", ...rawApproval({ moduleId: "sourceTools", ownerId: people.limited.id,
        key: "raw-code-limited-0001", moduleClass: "code", source: "signed", signer: publisher.keyId, ack: true })), /needs the owner/u);
      await assert.rejects(postgres.query("web", ...rawApproval({ moduleId: "sourceTools", ownerId: people.operator.id,
        key: "raw-code-operator-0001", moduleClass: "code", source: "signed", signer: publisher.keyId, ack: true })), /needs the owner/u);
      await assert.rejects(postgres.query("web", ...rawApproval({ moduleId: "sourceTools", ownerId: people.owner.id,
        key: "raw-code-unsigned-0001", moduleClass: "code", ack: true })), /check constraint/u, "CODE from an unsigned source");
      await assert.rejects(postgres.query("web", ...rawApproval({ moduleId: "sourceTools", ownerId: people.owner.id,
        key: "raw-code-noack-0001", moduleClass: "code", source: "signed", signer: publisher.keyId, ack: false })), /check constraint/u,
      "CODE without the warning acknowledged");
      assert.equal(await count("sourceTools"), 0);
      // The owner saw "signed by Test publisher"; the same CODE bytes arrive signed by the second trusted key.
      const codeBySecond = { bundle: codeBundle, signature: signModuleBundleV1(codeBundle, secondPublisher.privateKey, secondPublisher.spki) };
      await assert.rejects(service.approve(owner, codeBySecond, draftFor(previewCode), "module-approve-code-swap-signer"), /conflict/u);
      assert.equal(await count("sourceTools"), 0);
      const approvedCode = await service.approve(owner, codeSubmission, draftFor(previewCode), "module-approve-code-0001");
      assert.equal(approvedCode.sourceKind, "signed"); assert.equal(approvedCode.signerKeyId, publisher.keyId);
      assert.equal(approvedCode.executesCode, false); assert.equal(approvedCode.runsMigrations, false);
      assert.equal((await service.assertApproved(codeSubmission)).approvalId, approvedCode.approvalId);

      // --- A manifest tampered after approval. ---
      const tampered = code({ permissions: { ...permissions(), workerCapabilities: ["shell.execute"],
        projectData: [{ resource: "module_source_tools_notes", access: ["read", "write"] }] } });
      await assert.rejects(service.assertApproved({ bundle: tampered, signature: codeSubmission.signature }),
        /module_signature_digest_mismatch/u, "the approved signature does not cover the edited manifest");
      await assert.rejects(service.assertApproved(signed(tampered)), /module_install_approval_required/u,
        "even re-signed by the trusted publisher, the edited manifest needs the owner again");
      // Same version, same permissions, re-signed by the trusted publisher, but different code bytes.
      const swappedCode = { ...codeBundle, files: codeBundle.files.map(file => file.path === "dist/index.js"
        ? { ...file, contentBase64: b64("export const answer = 41;\n") } : file) };
      await assert.rejects(service.assertApproved(signed(swappedCode)), /module_install_approval_required/u);
      // The same bytes through a different trust source, or after the owner stops trusting the signer, are not approved.
      const reviewedOnly = new ModuleInstallApprovalServiceV1(connection.client, scope, KEY,
        { trustedKeys: [], reviewedBundleDigests: [digestOf(codeBundle)] }, "0.1.0", clock);
      await assert.rejects(reviewedOnly.assertApproved({ bundle: codeBundle }), /module_install_approval_required/u);
      await assert.rejects(reviewedOnly.assertApproved(codeSubmission), /module_signature_signer_untrusted/u);
      // A different integrity key cannot read the ledger as valid.
      const otherKey = new ModuleInstallApprovalServiceV1(connection.client, scope, new Uint8Array(32).fill(78), trusting, "0.1.0", clock);
      await assert.rejects(otherKey.assertApproved(codeSubmission), /module_install_approval_integrity_failed/u);
    } finally { await connection.close(); }

    // --- The chain's own race guard, below the service: two sessions, one head. ---
    const racer = async () => { const client = new Client(postgres.connection("web")); await client.connect(); return client; };
    const [first, second] = [await racer(), await racer()];
    try {
      const [rootSql, rootParams] = rawApproval({ moduleId: "raceProbe", ownerId: people.owner.id, key: "race-root-first-0001" });
      await first.query("BEGIN"); await second.query("BEGIN");
      await first.query(rootSql, rootParams);
      const blocked = second.query(...rawApproval({ moduleId: "raceProbe", ownerId: people.owner.id, key: "race-root-second-0001" }))
        .then(() => "inserted", (error: unknown) => String(error));
      await first.query("COMMIT");
      assert.match(await blocked, /duplicate key/u, "only one root per module, even under a race");
      await second.query("ROLLBACK");
      const root = String(rootParams[1]);
      await first.query("BEGIN"); await second.query("BEGIN");
      await first.query(...rawApproval({ moduleId: "raceProbe", ownerId: people.owner.id, key: "race-next-first-0001", supersedes: root }));
      const blockedNext = second.query(...rawApproval({ moduleId: "raceProbe", ownerId: people.owner.id, key: "race-next-second-0001",
        supersedes: root })).then(() => "inserted", (error: unknown) => String(error));
      await first.query("COMMIT");
      assert.match(await blockedNext, /duplicate key/u, "only one successor per approval, even under a race");
      await second.query("ROLLBACK");
    } finally { await first.end(); await second.end(); }
    assert.equal(await count("raceProbe"), 2);

    // Rows written around the service (no valid integrity tag) fail closed when read.
    const reader = pool(postgres);
    try {
      const service = new ModuleInstallApprovalServiceV1(reader.client, scope, KEY, trusting, "0.1.0");
      await assert.rejects(service.current(owner, "raceProbe"), /module_install_approval_integrity_failed/u);
    } finally { await reader.close(); }

    // The chain, not the clock, decides what is current: a successor stamped earlier than the
    // approval it supersedes still retires it (and, lacking a valid tag, fails closed).
    const codeHead = (await asAdmin("SELECT id FROM control_module_install_approvals WHERE module_id='sourceTools'")).rows[0]!.id as string;
    const [earlier, earlierParams] = rawApproval({ moduleId: "sourceTools", ownerId: people.owner.id, key: "raw-earlier-successor-0001",
      supersedes: codeHead, moduleClass: "code", source: "signed", signer: publisher.keyId, ack: true });
    await postgres.query("web", earlier.replace(/now\(\)\)$/u, "now()-interval '4 minutes')"), earlierParams);
    const afterSuccessor = pool(postgres);
    try {
      const service = new ModuleInstallApprovalServiceV1(afterSuccessor.client, scope, KEY, trusting, "0.1.0");
      await assert.rejects(service.assertApproved(signed(code())), /module_install_approval_integrity_failed/u);
    } finally { await afterSuccessor.close(); }

    // Append only, even to the login that writes approvals and to the superuser.
    await assert.rejects(postgres.query("web", "UPDATE control_module_install_approvals SET module_version='9.9.9'"), /permission denied/u);
    await assert.rejects(postgres.query("web", "DELETE FROM control_module_install_approvals"), /permission denied/u);
    await assert.rejects(postgres.query("web", "TRUNCATE control_module_install_approvals"), /permission denied/u);
    await assert.rejects(asAdmin("UPDATE control_module_install_approvals SET manifest='{}'::jsonb"), /append/u);
    await assert.rejects(asAdmin("DELETE FROM control_module_install_approvals"), /append/u);
    // An approval cannot be backdated.
    const [backdated, backdatedParams] = rawApproval({ moduleId: "backdated", ownerId: people.owner.id, key: "raw-backdated-0001" });
    await assert.rejects(postgres.query("web", backdated.replace(/now\(\)\)$/u, "now()-interval '1 hour')"), backdatedParams),
      /time rejected/u);
    // No other application login can read or write the owner's approvals (backup reads everything; the migrator owns the table).
    for (const role of ["app", "scheduler", "coordinator", "intake", "news", "results", "publisher", "queueWorker", "fleet", "fleetOwner"]) {
      await assert.rejects(postgres.query(role, "SELECT 1 FROM control_module_install_approvals LIMIT 1"), /permission denied/u, role);
      await assert.rejects(postgres.query(role, ...rawApproval({ moduleId: "otherRole", ownerId: people.owner.id,
        key: `raw-other-role-${role}-0001` })), /permission denied/u, role);
    }

    // The down file removes only what 0195 created and revokes only what it granted; the up file
    // then re-applies cleanly, its guarded grant included. Both run as the schema-owning migrator.
    const privileges = async () => (await asAdmin(`SELECT has_table_privilege('control_room_private_web',
      'control_module_install_approvals','SELECT') AS s, has_table_privilege('control_room_private_web',
      'control_module_install_approvals','INSERT') AS i, has_table_privilege('control_room_private_web',
      'control_module_install_approvals','UPDATE') AS u`)).rows[0];
    const webGrantsBefore = Number((await asAdmin(`SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE grantee='control_room_private_web'`)).rows[0]!.n);
    await postgres.query("migrator", await readFile(join(process.cwd(), "db/down/0195_module_install_approvals.sql"), "utf8"));
    assert.equal((await asAdmin("SELECT to_regclass('public.control_module_install_approvals') AS t")).rows[0]!.t, null);
    assert.equal(Number((await asAdmin("SELECT count(*)::int AS n FROM pg_proc WHERE proname='guard_module_install_approval_insert'")).rows[0]!.n), 0);
    assert.equal(Number((await asAdmin(`SELECT count(*)::int AS n FROM information_schema.role_table_grants
      WHERE grantee='control_room_private_web'`)).rows[0]!.n), webGrantsBefore - 2, "only SELECT and INSERT on this table went away");
    await postgres.query("migrator", `BEGIN;\n${await readFile(join(process.cwd(), "db/migrations/0195_module_install_approvals.sql"), "utf8")}\nCOMMIT;`);
    assert.deepEqual(await privileges(), { s: true, i: true, u: false });
  }, { port: PORT, allowedPorts: [PORT], boundMs: 180_000 }).catch(error => {
    throw new Error(`${String(error)} refused: ${refused.at(-1) ?? "none"}`, { cause: error });
  });
});

test("the module approval real-PostgreSQL proof ran when PostgreSQL is available", () => {
  if (!PG) { assert.equal(required, 0); return; }
  assert.equal(required, 1); assert.equal(ran, required);
});
