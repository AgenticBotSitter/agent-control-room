import { createHmac, createSecretKey, timingSafeEqual, type KeyObject } from "node:crypto";
import { canonicalJson, SecurityStore, sha256Digest, type VerifiedAuthentication } from "../../security";
import { exactHostDataSnapshotV1, exactHostUint8ArrayV1, isHostProxyV1 } from "../../security/host-value";
import { ProjectWorkspaceContractErrorV1 } from "./errors";
import { exactProjectWorkspaceJsonV1, parseExactProjectWorkspaceV1 } from "./exact";
import {
  protectedProjectCatalogHighWaterSchemaV1,
  protectedProjectCatalogSchemaV1,
  projectWorkspaceSafeIdSchemaV1,
  projectWorkspaceTimeSchemaV1,
  projectWorkspaceVerifiedOwnerSessionSchemaV1,
} from "./schemas";
import {
  PROJECT_WORKSPACE_CATALOG_HIGH_WATER_CONTRACT_V1,
  type AuthorizedProjectWorkspaceReadScopeV1,
  type ProjectWorkspaceReadIdentityV1,
  type ProjectWorkspaceVerifiedOwnerSessionV1,
  type ProtectedProjectCatalogEntryV1,
  type ProtectedProjectCatalogHighWaterV1,
  type ProtectedProjectCatalogV1,
} from "./types";

const MAX_SESSION_LIFETIME_MS = 15 * 60_000;
const MAX_CLOCK_SKEW_MS = 5_000;

type CatalogUnsignedV1 = Omit<ProtectedProjectCatalogV1, "catalogDigest" | "catalogAuthTag">;
type CheckpointUnsignedV1 = Omit<ProtectedProjectCatalogHighWaterV1, "checkpointDigest" | "checkpointAuthTag">;
type SessionUnsignedV1 = Omit<ProjectWorkspaceVerifiedOwnerSessionV1, "sessionDigest">;

function protectedKey(value: Uint8Array): KeyObject {
  const observed = exactHostUint8ArrayV1(value, 64);
  if (!observed || observed.byteLength < 32) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const copy = observed.copy();
  try { return createSecretKey(copy); }
  finally { copy.fill(0); }
}

function authTag(value: unknown, key: KeyObject): string {
  return `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(value)).digest("hex")}`;
}

function sameAuthTag(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left.slice("hmac-sha256:".length), "hex");
  const rightBytes = Buffer.from(right.slice("hmac-sha256:".length), "hex");
  return leftBytes.length === 32 && rightBytes.length === 32 && timingSafeEqual(leftBytes, rightBytes);
}

function catalogUnsigned(value: ProtectedProjectCatalogV1): CatalogUnsignedV1 {
  const { catalogDigest: _digest, catalogAuthTag: _tag, ...material } = value;
  void _digest; void _tag;
  return material;
}

function checkpointUnsigned(value: ProtectedProjectCatalogHighWaterV1): CheckpointUnsignedV1 {
  const { checkpointDigest: _digest, checkpointAuthTag: _tag, ...material } = value;
  void _digest; void _tag;
  return material;
}

function sessionUnsigned(value: ProjectWorkspaceVerifiedOwnerSessionV1): SessionUnsignedV1 {
  const { sessionDigest: _digest, ...material } = value;
  void _digest;
  return material;
}

function projectIdentity(entry: ProtectedProjectCatalogEntryV1): ProjectWorkspaceReadIdentityV1 & { projectType: string } {
  return { tenantId: entry.tenantId, workspaceId: entry.workspaceId, projectId: entry.projectId, projectType: entry.projectType };
}

function projectIdentityDigest(entry: ProtectedProjectCatalogEntryV1): string {
  return sha256Digest(projectIdentity(entry));
}

export function buildProtectedProjectCatalogV1(input: CatalogUnsignedV1, keyBytes: Uint8Array): ProtectedProjectCatalogV1 {
  const key = protectedKey(keyBytes);
  const material = exactProjectWorkspaceJsonV1(input) as CatalogUnsignedV1;
  const catalogDigest = sha256Digest(material);
  return parseProtectedProjectCatalogWithKeyV1({ ...material, catalogDigest, catalogAuthTag: authTag({ ...material, catalogDigest }, key) }, key);
}

function parseProtectedProjectCatalogWithKeyV1(value: unknown, key: KeyObject): ProtectedProjectCatalogV1 {
  const catalog = parseExactProjectWorkspaceV1(protectedProjectCatalogSchemaV1, value) as ProtectedProjectCatalogV1;
  const material = catalogUnsigned(catalog);
  if (sha256Digest(material) !== catalog.catalogDigest
    || !sameAuthTag(authTag({ ...material, catalogDigest: catalog.catalogDigest }, key), catalog.catalogAuthTag)) {
    throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }
  return catalog;
}

export function parseProtectedProjectCatalogV1(value: unknown, keyBytes: Uint8Array): ProtectedProjectCatalogV1 {
  return parseProtectedProjectCatalogWithKeyV1(value, protectedKey(keyBytes));
}

function assertCatalogTransition(prior: ProtectedProjectCatalogHighWaterV1 | undefined, catalog: ProtectedProjectCatalogV1): void {
  if (!prior) {
    if (catalog.revision !== 1 || catalog.previousCatalogDigest !== null) throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
    return;
  }
  if (prior.catalogState === "revoked" || catalog.revision !== prior.revision + 1
    || catalog.previousCatalogDigest !== prior.catalogDigest || catalog.catalogId !== prior.catalogId
    || catalog.tenantId !== prior.tenantId || catalog.sourceIdentityDigest !== prior.sourceIdentityDigest) {
    throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
  }
  const current = new Map(catalog.entries.map((entry) => [entry.projectId, entry]));
  for (const previous of prior.projects) {
    const next = current.get(previous.projectId);
    if (!next || projectIdentityDigest(next) !== previous.identityDigest || next.workspaceId !== previous.workspaceId
      || next.projectType !== previous.projectType || (previous.state === "revoked" && next.state !== "revoked")) {
      throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
    }
  }
}

export function buildProtectedProjectCatalogHighWaterV1(input: {
  catalog: ProtectedProjectCatalogV1;
  prior?: ProtectedProjectCatalogHighWaterV1;
  checkpointId: string;
  recordedAt: string;
}, catalogKeyBytes: Uint8Array, highWaterKeyBytes: Uint8Array): ProtectedProjectCatalogHighWaterV1 {
  const captured = exactHostDataSnapshotV1(input, ["catalog", "checkpointId", "recordedAt"], ["prior"]);
  if (!captured) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const catalogKey = protectedKey(catalogKeyBytes), highWaterKey = protectedKey(highWaterKeyBytes);
  const catalog = parseProtectedProjectCatalogWithKeyV1(captured.catalog, catalogKey);
  const prior = captured.prior ? parseProtectedProjectCatalogHighWaterWithKeyV1(captured.prior, highWaterKey) : undefined;
  assertCatalogTransition(prior, catalog);
  const material: CheckpointUnsignedV1 = {
    contractVersion: PROJECT_WORKSPACE_CATALOG_HIGH_WATER_CONTRACT_V1,
    checkpointId: projectWorkspaceSafeIdSchemaV1.parse(captured.checkpointId),
    catalogId: catalog.catalogId,
    tenantId: catalog.tenantId,
    revision: catalog.revision,
    catalogDigest: catalog.catalogDigest,
    catalogState: catalog.state,
    sourceIdentityDigest: catalog.sourceIdentityDigest,
    projects: catalog.entries.map((entry) => ({ ...projectIdentity(entry), identityDigest: projectIdentityDigest(entry), state: entry.state })),
    recordedAt: projectWorkspaceTimeSchemaV1.parse(captured.recordedAt),
    previousCheckpointDigest: prior?.checkpointDigest ?? null,
  };
  if (Date.parse(material.recordedAt) < Date.parse(catalog.recordedAt)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const checkpointDigest = sha256Digest(material);
  return parseProtectedProjectCatalogHighWaterWithKeyV1({
    ...material,
    checkpointDigest,
    checkpointAuthTag: authTag({ ...material, checkpointDigest }, highWaterKey),
  }, highWaterKey);
}

function parseProtectedProjectCatalogHighWaterWithKeyV1(value: unknown, key: KeyObject): ProtectedProjectCatalogHighWaterV1 {
  const checkpoint = parseExactProjectWorkspaceV1(protectedProjectCatalogHighWaterSchemaV1, value) as ProtectedProjectCatalogHighWaterV1;
  const material = checkpointUnsigned(checkpoint);
  if (sha256Digest(material) !== checkpoint.checkpointDigest
    || !sameAuthTag(authTag({ ...material, checkpointDigest: checkpoint.checkpointDigest }, key), checkpoint.checkpointAuthTag)) {
    throw new ProjectWorkspaceContractErrorV1("integrity_failed");
  }
  return checkpoint;
}

export function parseProtectedProjectCatalogHighWaterV1(value: unknown, keyBytes: Uint8Array): ProtectedProjectCatalogHighWaterV1 {
  return parseProtectedProjectCatalogHighWaterWithKeyV1(value, protectedKey(keyBytes));
}

function assertCatalogMatchesCheckpoint(catalog: ProtectedProjectCatalogV1, checkpoint: ProtectedProjectCatalogHighWaterV1): void {
  if (catalog.catalogId !== checkpoint.catalogId || catalog.tenantId !== checkpoint.tenantId
    || catalog.revision !== checkpoint.revision || catalog.catalogDigest !== checkpoint.catalogDigest
    || catalog.state !== checkpoint.catalogState || catalog.sourceIdentityDigest !== checkpoint.sourceIdentityDigest
    || checkpoint.projects.length !== catalog.entries.length) throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
  for (let index = 0; index < catalog.entries.length; index += 1) {
    const entry = catalog.entries[index]!, highWater = checkpoint.projects[index]!;
    if (entry.projectId !== highWater.projectId || entry.tenantId !== highWater.tenantId
      || entry.workspaceId !== highWater.workspaceId || entry.projectType !== highWater.projectType
      || entry.state !== highWater.state || projectIdentityDigest(entry) !== highWater.identityDigest) {
      throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
    }
  }
}

export interface ProjectWorkspaceProtectedCatalogSourceV1 { read(): Promise<unknown> }
export interface ProjectWorkspaceCatalogHighWaterStoreV1 { read(catalogId: string): Promise<unknown> | unknown }

export class InMemoryProjectWorkspaceCatalogHighWaterStoreV1 implements ProjectWorkspaceCatalogHighWaterStoreV1 {
  readonly #key: KeyObject;
  #checkpoint?: ProtectedProjectCatalogHighWaterV1;

  constructor(keyBytes: Uint8Array, options: { testOnly: true }) {
    if (options.testOnly !== true) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    this.#key = protectedKey(keyBytes);
  }

  apply(value: unknown): void {
    const next = parseProtectedProjectCatalogHighWaterWithKeyV1(value, this.#key), prior = this.#checkpoint;
    if (!prior) {
      if (next.revision !== 1 || next.previousCheckpointDigest !== null) throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
    } else {
      if (prior.catalogState === "revoked" || next.catalogId !== prior.catalogId || next.tenantId !== prior.tenantId
        || next.sourceIdentityDigest !== prior.sourceIdentityDigest || next.revision !== prior.revision + 1
        || next.previousCheckpointDigest !== prior.checkpointDigest) throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
      const current = new Map(next.projects.map((entry) => [entry.projectId, entry]));
      for (const previous of prior.projects) {
        const project = current.get(previous.projectId);
        if (!project || project.identityDigest !== previous.identityDigest || (previous.state === "revoked" && project.state !== "revoked")) {
          throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
        }
      }
    }
    this.#checkpoint = structuredClone(next);
  }

  read(catalogId: string): ProtectedProjectCatalogHighWaterV1 | undefined {
    return this.#checkpoint?.catalogId === catalogId ? structuredClone(this.#checkpoint) : undefined;
  }
}

export class ProjectWorkspaceProtectedCatalogAuthorityV1 {
  readonly #catalogKey: KeyObject;
  readonly #highWaterKey: KeyObject;
  private readonly expected: Readonly<{ catalogId: string; tenantId: string; sourceIdentityDigest: string }>;
  constructor(
    private readonly source: ProjectWorkspaceProtectedCatalogSourceV1,
    private readonly highWater: ProjectWorkspaceCatalogHighWaterStoreV1,
    expectedValue: unknown,
    catalogKeyBytes: Uint8Array,
    highWaterKeyBytes: Uint8Array,
  ) {
    const expected = exactHostDataSnapshotV1(expectedValue, ["catalogId", "tenantId", "sourceIdentityDigest"]);
    if (!expected) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    this.#catalogKey = protectedKey(catalogKeyBytes);
    this.#highWaterKey = protectedKey(highWaterKeyBytes);
    const catalogId = projectWorkspaceSafeIdSchemaV1.parse(expected.catalogId);
    const tenantId = projectWorkspaceSafeIdSchemaV1.parse(expected.tenantId);
    const sourceIdentityDigest = typeof expected.sourceIdentityDigest === "string" ? expected.sourceIdentityDigest : "";
    if (!/^sha256:[a-f0-9]{64}$/.test(sourceIdentityDigest)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    this.expected = Object.freeze({ catalogId, tenantId, sourceIdentityDigest });
  }

  async resolve(projectId: string, now: string): Promise<{
    identity: ProjectWorkspaceReadIdentityV1;
    catalogId: string;
    catalogRevision: number;
    catalogDigest: string;
    catalogCheckpointDigest: string;
  }> {
    projectWorkspaceSafeIdSchemaV1.parse(projectId);
    projectWorkspaceTimeSchemaV1.parse(now);
    let catalog: ProtectedProjectCatalogV1;
    try { catalog = parseProtectedProjectCatalogWithKeyV1(await this.source.read(), this.#catalogKey); }
    catch (error) {
      if (error instanceof ProjectWorkspaceContractErrorV1 && error.safeCode === "integrity_failed") throw error;
      throw new ProjectWorkspaceContractErrorV1("catalog_unavailable");
    }
    if (catalog.catalogId !== this.expected.catalogId || catalog.tenantId !== this.expected.tenantId
      || catalog.sourceIdentityDigest !== this.expected.sourceIdentityDigest) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
    let rawCheckpoint: unknown;
    try { rawCheckpoint = await this.highWater.read(this.expected.catalogId); }
    catch { throw new ProjectWorkspaceContractErrorV1("catalog_unavailable"); }
    if (!rawCheckpoint) throw new ProjectWorkspaceContractErrorV1("catalog_unavailable");
    const checkpoint = parseProtectedProjectCatalogHighWaterWithKeyV1(rawCheckpoint, this.#highWaterKey);
    assertCatalogMatchesCheckpoint(catalog, checkpoint);
    const observedAt = Date.parse(now);
    if (Date.parse(catalog.recordedAt) > observedAt + MAX_CLOCK_SKEW_MS
      || Date.parse(checkpoint.recordedAt) < Date.parse(catalog.recordedAt)
      || Date.parse(checkpoint.recordedAt) > observedAt + MAX_CLOCK_SKEW_MS) {
      throw new ProjectWorkspaceContractErrorV1("catalog_rollback");
    }
    if (catalog.state === "revoked") throw new ProjectWorkspaceContractErrorV1("catalog_revoked");
    const entry = catalog.entries.find((candidate) => candidate.projectId === projectId);
    if (!entry) throw new ProjectWorkspaceContractErrorV1("not_found");
    if (entry.state === "revoked") throw new ProjectWorkspaceContractErrorV1("catalog_revoked");
    return {
      identity: { tenantId: entry.tenantId, workspaceId: entry.workspaceId, projectId: entry.projectId },
      catalogId: catalog.catalogId,
      catalogRevision: catalog.revision,
      catalogDigest: catalog.catalogDigest,
      catalogCheckpointDigest: checkpoint.checkpointDigest,
    };
  }
}

export function buildProjectWorkspaceVerifiedOwnerSessionV1(input: SessionUnsignedV1): ProjectWorkspaceVerifiedOwnerSessionV1 {
  const material = exactProjectWorkspaceJsonV1(input) as SessionUnsignedV1;
  return parseProjectWorkspaceVerifiedOwnerSessionV1({ ...material, sessionDigest: sha256Digest(material) });
}

export function parseProjectWorkspaceVerifiedOwnerSessionV1(value: unknown): ProjectWorkspaceVerifiedOwnerSessionV1 {
  const session = parseExactProjectWorkspaceV1(projectWorkspaceVerifiedOwnerSessionSchemaV1, value) as ProjectWorkspaceVerifiedOwnerSessionV1;
  if (sha256Digest(sessionUnsigned(session)) !== session.sessionDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return session;
}

export interface ProjectWorkspaceOwnerSessionPortV1 { verify(credential: unknown, now: string): Promise<unknown> }

export class ProjectWorkspaceOwnerReadScopeAuthorityV1 {
  constructor(
    private readonly sessionPort: ProjectWorkspaceOwnerSessionPortV1,
    private readonly catalog: ProjectWorkspaceProtectedCatalogAuthorityV1,
    private readonly security: SecurityStore,
  ) {}

  async authorize(inputValue: unknown): Promise<AuthorizedProjectWorkspaceReadScopeV1> {
    const input = parseAuthorizeInput(inputValue);
    let rawSession: unknown;
    try { rawSession = await this.sessionPort.verify(input.credential, input.now); }
    catch { throw new ProjectWorkspaceContractErrorV1("session_unavailable"); }
    if (rawSession === undefined || rawSession === null) throw new ProjectWorkspaceContractErrorV1("authentication_required");
    const session = parseProjectWorkspaceVerifiedOwnerSessionV1(rawSession);
    const nowMs = Date.parse(input.now), authenticatedMs = Date.parse(session.authenticatedAt), expiresMs = Date.parse(session.expiresAt);
    if (authenticatedMs > nowMs + MAX_CLOCK_SKEW_MS || expiresMs <= nowMs || expiresMs <= authenticatedMs
      || expiresMs - authenticatedMs > MAX_SESSION_LIFETIME_MS) throw new ProjectWorkspaceContractErrorV1("authentication_required");
    const catalog = await this.catalog.resolve(input.projectId, input.now);
    if (session.tenantId !== catalog.identity.tenantId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
    let principal: Awaited<ReturnType<SecurityStore["authorizeRead"]>>;
    try {
      const authentication: VerifiedAuthentication = {
        tenantId: session.tenantId,
        provider: session.provider,
        subject: session.subject,
        verifiedAt: session.authenticatedAt,
        expiresAt: session.expiresAt,
      };
      principal = await this.security.authorizeRead({
        authentication,
        requiredRoleKey: "owner",
        request: {
          tenantId: catalog.identity.tenantId,
          action: "project_workspace.read",
          resourceType: "project_workspace",
          resourceId: catalog.identity.projectId,
          projectId: catalog.identity.projectId,
          risk: "low",
          externalEffect: false,
          occurredAt: input.now,
        },
      });
    } catch { throw new ProjectWorkspaceContractErrorV1("policy_denied"); }
    return {
      ...catalog.identity,
      actorId: principal.identityId,
      grantedAt: input.now,
      expiresAt: principal.expiresAt,
      sessionDigest: session.sessionDigest,
      catalogId: catalog.catalogId,
      catalogRevision: catalog.catalogRevision,
      catalogDigest: catalog.catalogDigest,
      catalogCheckpointDigest: catalog.catalogCheckpointDigest,
    };
  }
}

function parseAuthorizeInput(value: unknown): { credential: unknown; projectId: string; now: string } {
  if (!value || typeof value !== "object" || Array.isArray(value) || isHostProxyV1(value)
    || Object.getPrototypeOf(value) !== Object.prototype) throw new ProjectWorkspaceContractErrorV1("invalid_input");
  const descriptors = Object.getOwnPropertyDescriptors(value), keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || keys.some((key) => typeof key !== "string" || !["credential", "projectId", "now"].includes(key))) {
    throw new ProjectWorkspaceContractErrorV1("invalid_input");
  }
  for (const key of keys as string[]) {
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || descriptor.get || descriptor.set || !descriptor.enumerable) {
      throw new ProjectWorkspaceContractErrorV1("invalid_input");
    }
  }
  return {
    credential: descriptors.credential!.value,
    projectId: projectWorkspaceSafeIdSchemaV1.parse(descriptors.projectId!.value),
    now: projectWorkspaceTimeSchemaV1.parse(descriptors.now!.value),
  };
}

export const PROJECT_WORKSPACE_PROTECTED_RUNTIME_DISABLED_V1 = Object.freeze({
  state: "disabled_pending_protected_catalog_and_owner_session" as const,
  catalogConfigured: false as const,
  catalogHighWaterConfigured: false as const,
  ownerSessionVerifierConfigured: false as const,
  ownerReadPolicyConfigured: false as const,
  acceptsCallerIdentityHeaders: false as const,
  grantsApproval: false as const,
  grantsNetworkAuthority: false as const,
  grantsCommandAuthority: false as const,
  grantsLeaseAuthority: false as const,
  grantsExecutionAuthority: false as const,
});
