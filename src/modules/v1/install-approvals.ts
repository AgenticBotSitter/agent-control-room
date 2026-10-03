import { randomUUID, timingSafeEqual } from "node:crypto";
import type { DatabaseClient, DatabaseSession } from "../../persistence/database";
import { hmacSha256Tag, sha256Digest } from "../../security";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { parseModuleManifestV1 } from "./manifest";
import {
  assertModulePermissionDiffV1, legacyModulePermissionsDigestV1, previousModulePermissionsDigestV1, moduleAuthoritySurfaceV1, modulePermissionDiffDigestV1, modulePermissionDiffV1, modulePermissionsDigestV1,
  verifyModuleBundleV1, type ModulePermissionDiffV1, type ModuleTrustPolicyV1, type VerifiedModuleBundleV1,
} from "./bundle";

/**
 * The owner's durable installation approval for one exact module bundle.
 *
 * Approving records a decision; it never downloads, stages, loads, executes,
 * or migrates module material. Every entry point re-verifies the submitted
 * bundle against the owner's trust policy itself: a caller cannot hand in an
 * already-"verified" result.
 */
export interface ModuleBundleSubmissionV1 { readonly bundle: unknown; readonly signature?: unknown }
/** The trust line the owner was shown: how the bundle is vouched for, and by which key. */
export interface ModuleInstallExpectedSourceV1 {
  readonly kind: "declarative-unsigned" | "reviewed" | "signed";
  /** The signer's key id for `signed`, otherwise null. */
  readonly keyId: string | null;
}
export interface ModuleInstallApprovalDraftV1 {
  /** The digest the owner was shown. A different bundle at approval time is a conflict. */
  readonly expectedBundleDigest: string;
  /** The trust source the owner was shown. A different source kind or signer at approval time is a conflict. */
  readonly expectedSource: ModuleInstallExpectedSourceV1;
  /** The approval the owner saw as current (null for a first install). */
  readonly expectedCurrentApprovalId: string | null;
  /** The permission diff the owner saw, bound to the approval it replaces. */
  readonly acknowledgedPermissionDiffDigest: string;
  /** Required for CODE modules: the owner saw the "this module can run code" warning. */
  readonly acknowledgedCodeWarning: boolean;
}
export interface ModuleInstallApprovalViewV1 {
  readonly approvalId: string;
  readonly moduleId: string;
  readonly moduleVersion: string;
  readonly moduleClass: "declarative" | "code";
  readonly bundleDigest: string;
  readonly permissionsDigest: string;
  readonly sourceKind: "declarative-unsigned" | "reviewed" | "signed";
  readonly signerKeyId: string | null;
  readonly supersedesApprovalId: string | null;
  readonly permissionDiff: ModulePermissionDiffV1;
  readonly approvedAt: string;
}

type ApprovalRow = { id: string; module_id: string; module_version: string; module_class: "declarative" | "code";
  bundle_digest: string; permissions_digest: string; manifest: unknown; source_kind: ModuleInstallApprovalViewV1["sourceKind"];
  signer_key_id: string | null; code_warning_acknowledged: boolean; supersedes_approval_id: string | null;
  permission_diff: unknown; permission_diff_digest: string; owner_identity_id: string; idempotency_key: string;
  request_digest: string; record_digest: string; auth_tag: string; approved_at: string | Date };

type CheckedApproval = { view: ModuleInstallApprovalViewV1; surface: readonly string[]; row: ApprovalRow };

const COLUMNS = `id,module_id,module_version,module_class,bundle_digest,permissions_digest,manifest,source_kind,
  signer_key_id,code_warning_acknowledged,supersedes_approval_id,permission_diff,permission_diff_digest,
  owner_identity_id,idempotency_key,request_digest,record_digest,auth_tag,approved_at`;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const APPROVAL_ID_PATTERN = /^module-approval:[0-9a-f-]{36}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_-]{16,100}$/;
const MODULE_ID_PATTERN = /^[a-z][A-Za-z0-9.-]{2,63}$/;
const iso = (value: string | Date) => new Date(value).toISOString();
const same = (left: string, right: string) => { const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b); };

const SOURCE_KINDS = new Set(["declarative-unsigned", "reviewed", "signed"]);
const exactly = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

/** The source binding of a verified bundle, in the draft's shape. */
export function moduleInstallSourceOfV1(verified: Pick<VerifiedModuleBundleV1, "source">): ModuleInstallExpectedSourceV1 {
  return Object.freeze({ kind: verified.source.kind, keyId: verified.source.kind === "signed" ? verified.source.keyId : null });
}

function parseSource(value: unknown): ModuleInstallExpectedSourceV1 | undefined {
  if (!exactly(value, ["kind", "keyId"]) || typeof value.kind !== "string" || !SOURCE_KINDS.has(value.kind)) return undefined;
  // A signed source names exactly one key; every other source names none.
  if (value.kind === "signed" ? typeof value.keyId !== "string" || !DIGEST_PATTERN.test(value.keyId) : value.keyId !== null) return undefined;
  return { kind: value.kind as ModuleInstallExpectedSourceV1["kind"], keyId: value.keyId as string | null };
}

function parseDraft(value: unknown): ModuleInstallApprovalDraftV1 | undefined {
  const keys = ["expectedBundleDigest", "expectedSource", "expectedCurrentApprovalId", "acknowledgedPermissionDiffDigest",
    "acknowledgedCodeWarning"];
  if (!exactly(value, keys)) return undefined;
  const draft = value, expectedSource = parseSource(draft.expectedSource);
  if (!expectedSource || typeof draft.expectedBundleDigest !== "string" || !DIGEST_PATTERN.test(draft.expectedBundleDigest)
    || !(draft.expectedCurrentApprovalId === null || (typeof draft.expectedCurrentApprovalId === "string"
      && APPROVAL_ID_PATTERN.test(draft.expectedCurrentApprovalId)))
    || typeof draft.acknowledgedPermissionDiffDigest !== "string" || !DIGEST_PATTERN.test(draft.acknowledgedPermissionDiffDigest)
    || typeof draft.acknowledgedCodeWarning !== "boolean") return undefined;
  return { expectedBundleDigest: draft.expectedBundleDigest, expectedSource,
    expectedCurrentApprovalId: draft.expectedCurrentApprovalId as string | null,
    acknowledgedPermissionDiffDigest: draft.acknowledgedPermissionDiffDigest, acknowledgedCodeWarning: draft.acknowledgedCodeWarning };
}

function parseDiff(value: unknown): ModulePermissionDiffV1 {
  const diff = value as { added?: unknown; removed?: unknown } | null;
  const lines = (list: unknown) => Array.isArray(list) && list.every(line => typeof line === "string") ? list as string[] : undefined;
  const added = lines(diff?.added), removed = lines(diff?.removed);
  if (!added || !removed || Object.keys(diff!).length !== 2) throw new Error("module_install_approval_integrity_failed");
  return Object.freeze({ added: Object.freeze([...added]), removed: Object.freeze([...removed]) });
}

export class ModuleInstallApprovalServiceV1 {
  readonly #key: Uint8Array;
  readonly #authority: WebSessionAuthority;

  constructor(private readonly db: DatabaseClient, private readonly scope: { tenantId: string; workspaceId: string },
    integrityKey: Uint8Array, private readonly trust: ModuleTrustPolicyV1, private readonly hostVersion: string,
    clock: () => number = Date.now) {
    if (!(integrityKey instanceof Uint8Array) || integrityKey.length !== 32) throw new Error("module_install_approval_configuration_invalid");
    this.#key = Uint8Array.from(integrityKey);
    this.#authority = new WebSessionAuthority(db, scope, clock, "module");
  }

  #verify(submission: unknown): Readonly<VerifiedModuleBundleV1> {
    if (submission === null || typeof submission !== "object" || Array.isArray(submission)) throw new Error("module_bundle_malformed");
    const { bundle, signature, ...rest } = submission as { bundle?: unknown; signature?: unknown };
    if (Object.keys(rest).length) throw new Error("module_bundle_malformed");
    return verifyModuleBundleV1(bundle, signature, { trust: this.trust, hostVersion: this.hostVersion });
  }

  #material(row: ApprovalRow) {
    return { id: row.id, tenantId: this.scope.tenantId, moduleId: row.module_id, moduleVersion: row.module_version,
      moduleClass: row.module_class, bundleDigest: row.bundle_digest, permissionsDigest: row.permissions_digest,
      manifest: row.manifest, sourceKind: row.source_kind, signerKeyId: row.signer_key_id,
      codeWarningAcknowledged: row.code_warning_acknowledged, supersedesApprovalId: row.supersedes_approval_id,
      permissionDiff: row.permission_diff, permissionDiffDigest: row.permission_diff_digest,
      ownerIdentityId: row.owner_identity_id, idempotencyKey: row.idempotency_key, requestDigest: row.request_digest,
      approvedAt: iso(row.approved_at) };
  }

  /** Recomputes the record digest and HMAC and re-derives the stored surface; any mismatch fails closed. */
  #checked(row: ApprovalRow): CheckedApproval {
    const material = this.#material(row);
    if (sha256Digest(material) !== row.record_digest
      || !same(hmacSha256Tag(this.#key, { purpose: "module-install-approval/v1", record: material }), row.auth_tag)) {
      throw new Error("module_install_approval_integrity_failed");
    }
    let manifest;
    try { manifest = parseModuleManifestV1(row.manifest); } catch { throw new Error("module_install_approval_integrity_failed"); }
    if (manifest.id !== row.module_id || manifest.version !== row.module_version || manifest.class !== row.module_class
      || (modulePermissionsDigestV1(manifest) !== row.permissions_digest
        && previousModulePermissionsDigestV1(manifest) !== row.permissions_digest
        && legacyModulePermissionsDigestV1(manifest) !== row.permissions_digest)) throw new Error("module_install_approval_integrity_failed");
    const view: ModuleInstallApprovalViewV1 = Object.freeze({ approvalId: row.id, moduleId: row.module_id,
      moduleVersion: row.module_version, moduleClass: row.module_class, bundleDigest: row.bundle_digest,
      permissionsDigest: row.permissions_digest, sourceKind: row.source_kind, signerKeyId: row.signer_key_id,
      supersedesApprovalId: row.supersedes_approval_id, permissionDiff: parseDiff(row.permission_diff),
      approvedAt: iso(row.approved_at) });
    return { view, surface: moduleAuthoritySurfaceV1(manifest), row };
  }

  /** The head of the module's approval chain, integrity-checked. More than one head is corruption. */
  async #head(tx: DatabaseSession, moduleId: string): Promise<CheckedApproval | undefined> {
    const rows = (await tx.query<ApprovalRow>(`SELECT ${COLUMNS} FROM control_module_install_approvals a
      WHERE a.tenant_id=$1 AND a.module_id=$2 AND NOT EXISTS (SELECT 1 FROM control_module_install_approvals s
        WHERE s.tenant_id=a.tenant_id AND s.module_id=a.module_id AND s.supersedes_approval_id=a.id) LIMIT 2`,
    [this.scope.tenantId, moduleId])).rows;
    if (rows.length > 1) throw new Error("module_install_approval_integrity_failed");
    return rows[0] ? this.#checked(rows[0]) : undefined;
  }

  #plan(verified: Readonly<VerifiedModuleBundleV1>, head: CheckedApproval | undefined) {
    const diff = modulePermissionDiffV1(head ? head.surface : null, verified.authoritySurface);
    if (head) assertModulePermissionDiffV1(parseModuleManifestV1(head.row.manifest),verified.manifest,diff);
    const diffDigest = modulePermissionDiffDigestV1({ moduleId: verified.moduleId, fromApprovalId: head?.view.approvalId ?? null,
      fromBundleDigest: head?.view.bundleDigest ?? null, toBundleDigest: verified.bundleDigest, diff });
    return { diff, diffDigest, alreadyCurrent: head !== undefined && ModuleInstallApprovalServiceV1.#matches(head.view, verified) };
  }

  static #matches(view: ModuleInstallApprovalViewV1, verified: Readonly<VerifiedModuleBundleV1>): boolean {
    return view.moduleId === verified.moduleId && view.moduleVersion === verified.moduleVersion
      && view.moduleClass === verified.moduleClass && view.bundleDigest === verified.bundleDigest
      && view.sourceKind === verified.source.kind
      && view.signerKeyId === (verified.source.kind === "signed" ? verified.source.keyId : null);
  }

  /** What the owner sees before approving: exact digest, trust source, CODE warning, and the permission diff. */
  async preview(identity: VerifiedWebIdentity, submission: ModuleBundleSubmissionV1) {
    // Verification refusals keep their specific code (for example module_signature_invalid) so the
    // owner is told exactly why a bundle cannot be approved.
    const verified = this.#verify(submission);
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("modules.install", undefined, true);
      const head = await this.#head(tx, verified.moduleId);
      const plan = this.#plan(verified, head);
      return Object.freeze({ moduleId: verified.moduleId, moduleVersion: verified.moduleVersion, moduleClass: verified.moduleClass,
        name: verified.manifest.name, publisher: verified.manifest.publisher, bundleDigest: verified.bundleDigest,
        source: verified.source, expectedSource: moduleInstallSourceOfV1(verified), codeWarning: verified.codeWarning,
        files: verified.files, currentApproval: head?.view ?? null, approvalRequired: !plan.alreadyCurrent,
        permissionDiff: plan.diff, permissionDiffDigest: plan.diffDigest,
        installsNow: false as const, executesCode: false as const, runsMigrations: false as const });
    }, { readOnly: true });
  }

  /** The current approval for a module, or null. Read-only, owner or operator with modules.read. */
  async current(identity: VerifiedWebIdentity, moduleId: string) {
    if (typeof moduleId !== "string" || !MODULE_ID_PATTERN.test(moduleId)) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("modules.read");
      return (await this.#head(tx, moduleId))?.view ?? null;
    }, { readOnly: true });
  }

  async approve(identity: VerifiedWebIdentity, submission: ModuleBundleSubmissionV1, value: unknown, idempotencyKey: string) {
    const draft = parseDraft(value);
    if (!draft || typeof idempotencyKey !== "string" || !IDEMPOTENCY_PATTERN.test(idempotencyKey)) throw new WebAccessError("invalid_request");
    // Verification refusals keep their specific code (for example module_signature_invalid) so the
    // owner is told exactly why a bundle cannot be approved.
    const verified = this.#verify(submission);
    const requestDigest = sha256Digest({ schema: "control-room.module-install-approval-request/v1", ...this.scope,
      bundleDigest: verified.bundleDigest, sourceKind: verified.source.kind,
      signerKeyId: verified.source.kind === "signed" ? verified.source.keyId : null, ...draft, idempotencyKey });
    return this.#authority.authenticated(identity, async (tx, actor) => {
      actor.require("modules.install", undefined, true, verified.moduleClass === "code" ? "critical" : "high");
      const byKey = async () => (await tx.query<ApprovalRow>(`SELECT ${COLUMNS} FROM control_module_install_approvals
        WHERE tenant_id=$1 AND owner_identity_id=$2 AND idempotency_key=$3`, [this.scope.tenantId, actor.id, idempotencyKey])).rows[0];
      const replay = async (row: ApprovalRow) => {
        if (row.request_digest !== requestDigest) throw new WebAccessError("conflict");
        const checked = this.#checked(row);
        // A replayed receipt reports whether that approval is STILL current; replay never re-activates it.
        const head = await this.#head(tx, row.module_id);
        return this.#receipt(checked.view, true, head?.view.approvalId === row.id);
      };
      const prior = await byKey(); if (prior) return replay(prior);
      // The owner approves the bundle they were shown, vouched for the way they were shown (the same
      // source kind and the same signer), against the approval they saw as current.
      const source = moduleInstallSourceOfV1(verified);
      if (draft.expectedBundleDigest !== verified.bundleDigest || draft.expectedSource.kind !== source.kind
        || draft.expectedSource.keyId !== source.keyId) throw new WebAccessError("conflict");
      if (verified.codeWarning && !draft.acknowledgedCodeWarning) throw new WebAccessError("invalid_request");
      const head = await this.#head(tx, verified.moduleId);
      if ((head?.view.approvalId ?? null) !== draft.expectedCurrentApprovalId) throw new WebAccessError("conflict");
      const plan = this.#plan(verified, head);
      if (plan.alreadyCurrent || plan.diffDigest !== draft.acknowledgedPermissionDiffDigest) throw new WebAccessError("conflict");
      const partial: ApprovalRow = { id: `module-approval:${randomUUID()}`, module_id: verified.moduleId,
        module_version: verified.moduleVersion, module_class: verified.moduleClass, bundle_digest: verified.bundleDigest,
        permissions_digest: verified.permissionsDigest, manifest: verified.manifest, source_kind: verified.source.kind,
        signer_key_id: verified.source.kind === "signed" ? verified.source.keyId : null,
        code_warning_acknowledged: draft.acknowledgedCodeWarning, supersedes_approval_id: head?.view.approvalId ?? null,
        permission_diff: { added: [...plan.diff.added], removed: [...plan.diff.removed] }, permission_diff_digest: plan.diffDigest,
        owner_identity_id: actor.id, idempotency_key: idempotencyKey, request_digest: requestDigest,
        record_digest: "", auth_tag: "", approved_at: actor.now };
      const material = this.#material(partial), recordDigest = sha256Digest(material);
      const authTag = hmacSha256Tag(this.#key, { purpose: "module-install-approval/v1", record: material });
      // No UPDATE grant, so no row lock. Same-owner writes serialize on the identity lock; the
      // chain's unique keys stop a second approval of the same head from any other session.
      const inserted = await tx.query<{ id: string }>(`INSERT INTO control_module_install_approvals(tenant_id,id,module_id,
        module_version,module_class,bundle_digest,permissions_digest,manifest,source_kind,signer_key_id,
        code_warning_acknowledged,supersedes_approval_id,permission_diff,permission_diff_digest,owner_identity_id,
        idempotency_key,request_digest,record_digest,auth_tag,approved_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT DO NOTHING RETURNING id`,
      [this.scope.tenantId, partial.id, partial.module_id, partial.module_version, partial.module_class, partial.bundle_digest,
        partial.permissions_digest, JSON.stringify(partial.manifest), partial.source_kind, partial.signer_key_id,
        partial.code_warning_acknowledged, partial.supersedes_approval_id, JSON.stringify(partial.permission_diff),
        partial.permission_diff_digest, actor.id, idempotencyKey, requestDigest, recordDigest, authTag, partial.approved_at]);
      if (!inserted.rows.length) {
        const winner = await byKey(); if (!winner) throw new WebAccessError("conflict");
        return replay(winner);
      }
      return this.#receipt(this.#checked({ ...partial, record_digest: recordDigest, auth_tag: authTag }).view, false, true);
    });
  }

  #receipt(view: ModuleInstallApprovalViewV1, replayed: boolean, current: boolean) {
    return Object.freeze({ ...view, replayed, current,
      installsNow: false as const, executesCode: false as const, runsMigrations: false as const });
  }

  /**
   * Server-side gate for a later installer step: re-verifies the bundle under
   * today's trust policy and requires it to be exactly what the owner's current
   * approval names. A new version, a changed manifest or permission surface, a
   * different trust source or signer, or a superseded approval all fail with
   * module_install_approval_required. The receipt grants no execution.
   */
  async assertApproved(submission: ModuleBundleSubmissionV1) {
    const verified = this.#verify(submission);
    return this.db.transaction(async tx => {
      const head = await this.#head(tx, verified.moduleId);
      if (!head || !ModuleInstallApprovalServiceV1.#matches(head.view, verified)) throw new Error("module_install_approval_required");
      return Object.freeze({ approvalId: head.view.approvalId, moduleId: verified.moduleId, moduleVersion: verified.moduleVersion,
        bundleDigest: verified.bundleDigest, permissionsDigest: verified.permissionsDigest,
        executesCode: false as const, runsMigrations: false as const });
    });
  }
}
