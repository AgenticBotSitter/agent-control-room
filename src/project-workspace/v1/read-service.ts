import type { OperatorSurfaceReadServiceV1, OperatorSurfaceSnapshotV1 } from "../../operator-surfaces/v1";
import { parseOperatorSurfaceSnapshotV1 } from "../../operator-surfaces/v1";
import { sha256Digest } from "../../security";
import { ProjectWorkspaceContractErrorV1 } from "./errors";
import { exactProjectWorkspaceJsonV1, parseExactProjectWorkspaceV1 } from "./exact";
import {
  authorizedProjectWorkspaceReadScopeSchemaV1,
  projectWorkspaceReadIdentitySchemaV1,
  projectWorkspaceReadModelSchemaV1,
} from "./schemas";
import {
  PROJECT_WORKSPACE_READ_CONTRACT_V1,
  type AuthorizedProjectWorkspaceReadScopeV1,
  type ProjectWorkspaceReadIdentityV1,
  type ProjectWorkspaceReadModelV1,
  type ProjectWorkspaceReadResultV1,
} from "./types";

const MAX_SCOPE_AGE_MS = 15 * 60 * 1_000;
const CURRENT_READ_AGE_MS = 5 * 60 * 1_000;

export interface ProjectWorkspaceOperatorReadSourceV1 {
  read(input: { tenantId: string; actorId: string; grantedAt: string; now: string }): Promise<OperatorSurfaceSnapshotV1>;
}

export class OperatorSurfaceProjectWorkspaceReadSourceV1 implements ProjectWorkspaceOperatorReadSourceV1 {
  constructor(private readonly service: OperatorSurfaceReadServiceV1) {}

  async read(input: { tenantId: string; actorId: string; grantedAt: string; now: string }): Promise<OperatorSurfaceSnapshotV1> {
    return (await this.service.read({
      scope: { tenantId: input.tenantId, actorId: input.actorId, grantedAt: input.grantedAt },
      now: input.now,
    })).snapshot;
  }
}

function sameIdentity(left: ProjectWorkspaceReadIdentityV1, right: ProjectWorkspaceReadIdentityV1): boolean {
  return left.tenantId === right.tenantId && left.workspaceId === right.workspaceId && left.projectId === right.projectId;
}

function unsigned(model: ProjectWorkspaceReadModelV1): Omit<ProjectWorkspaceReadModelV1, "readDigest"> {
  const { readDigest: _readDigest, ...material } = model;
  void _readDigest;
  return material;
}

export function parseProjectWorkspaceReadModelV1(value: unknown): ProjectWorkspaceReadModelV1 {
  const model = parseExactProjectWorkspaceV1(projectWorkspaceReadModelSchemaV1, value) as ProjectWorkspaceReadModelV1;
  if (sha256Digest(unsigned(model)) !== model.readDigest) throw new ProjectWorkspaceContractErrorV1("digest_mismatch");
  return model;
}

/**
 * Composes one project-only view from the existing authenticated operator read port.
 * The registry is server-owned. This class has no database, network, write, command, or effect client of its own.
 */
export class ProjectWorkspaceReadServiceV1 {
  private readonly registry: readonly ProjectWorkspaceReadIdentityV1[];

  constructor(private readonly source: ProjectWorkspaceOperatorReadSourceV1, registryValue: unknown) {
    const raw = exactProjectWorkspaceJsonV1(registryValue);
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 1_000) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const parsed = raw.map((entry) => parseExactProjectWorkspaceV1(projectWorkspaceReadIdentitySchemaV1, entry) as ProjectWorkspaceReadIdentityV1);
    const keys = parsed.map((entry) => `${entry.tenantId}\u0000${entry.workspaceId}\u0000${entry.projectId}`);
    if (new Set(keys).size !== keys.length) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    this.registry = Object.freeze(parsed.map((entry) => Object.freeze({ ...entry })));
  }

  async read(inputValue: unknown): Promise<ProjectWorkspaceReadResultV1> {
    const input = parseExactProjectWorkspaceV1(zReadInput, inputValue) as { scope: AuthorizedProjectWorkspaceReadScopeV1; now: string };
    const nowMs = Date.parse(input.now), grantedMs = Date.parse(input.scope.grantedAt), expiresMs = Date.parse(input.scope.expiresAt);
    if (grantedMs > nowMs || nowMs - grantedMs > MAX_SCOPE_AGE_MS || expiresMs <= nowMs
      || expiresMs <= grantedMs || expiresMs - grantedMs > MAX_SCOPE_AGE_MS) {
      throw new ProjectWorkspaceContractErrorV1("invalid_read_scope");
    }
    const registered = this.registry.find((entry) => sameIdentity(entry, input.scope));
    if (!registered) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");

    let sourceValue: OperatorSurfaceSnapshotV1;
    try {
      sourceValue = await this.source.read({ tenantId: input.scope.tenantId, actorId: input.scope.actorId, grantedAt: input.scope.grantedAt, now: input.now });
    } catch {
      return { state: "unavailable", code: "protected_source_unavailable" };
    }
    let source: OperatorSurfaceSnapshotV1;
    try {
      source = parseOperatorSurfaceSnapshotV1(exactProjectWorkspaceJsonV1(sourceValue));
    } catch {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }
    if (source.tenantId !== input.scope.tenantId) throw new ProjectWorkspaceContractErrorV1("scope_mismatch");
    const sourceAge = nowMs - Date.parse(source.generatedAt);
    if (sourceAge < 0) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    const allServiceIds = new Set(source.services.map((entry) => entry.serviceId));
    if (source.serviceIncidents.some((entry) => !allServiceIds.has(entry.serviceId))) {
      throw new ProjectWorkspaceContractErrorV1("integrity_failed");
    }

    const portfolio = source.portfolio.find((entry) => entry.projectId === input.scope.projectId);
    const relatedWork = source.activeWork.filter((entry) => entry.projectId === input.scope.projectId);
    const services = source.services.filter((entry) => entry.projectId === input.scope.projectId);
    const schedules = source.schedules.filter((entry) => entry.projectId === input.scope.projectId);
    const actionInbox = source.actionInbox.filter((entry) => entry.projectId === input.scope.projectId);
    const ownerFocus = source.ownerFocus.filter((entry) => entry.projectId === input.scope.projectId);
    const serviceIds = new Set(services.map((entry) => entry.serviceId));
    const serviceIncidents = source.serviceIncidents.filter((entry) => serviceIds.has(entry.serviceId));
    const hasRelatedRecord = relatedWork.length > 0 || services.length > 0 || schedules.length > 0 || actionInbox.length > 0 || ownerFocus.length > 0 || serviceIncidents.length > 0;
    if (!portfolio) {
      if (hasRelatedRecord) throw new ProjectWorkspaceContractErrorV1("integrity_failed");
      return { state: "unavailable", code: "project_not_found" };
    }

    const freshness = sourceAge <= CURRENT_READ_AGE_MS ? "current" as const : "stale" as const;
    const material: Omit<ProjectWorkspaceReadModelV1, "readDigest"> = {
      contractVersion: PROJECT_WORKSPACE_READ_CONTRACT_V1,
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      projectId: input.scope.projectId,
      sourceMode: "protected_operator_surface",
      freshness,
      safeStatusCode: freshness === "current" ? "protected_read_current" : "protected_read_stale",
      readAt: input.now,
      sourceGeneratedAt: source.generatedAt,
      portfolio,
      activeWork: relatedWork,
      services,
      schedules,
      serviceIncidents,
      actionInbox,
      ownerFocus,
      presentationOnly: true,
      grantsApproval: false,
      grantsNetworkAuthority: false,
      grantsCommandAuthority: false,
      grantsLeaseAuthority: false,
      grantsExecutionAuthority: false,
    };
    return { state: "available", model: parseProjectWorkspaceReadModelV1({ ...material, readDigest: sha256Digest(material) }) };
  }
}

const zReadInput = {
  parse(value: unknown): { scope: AuthorizedProjectWorkspaceReadScopeV1; now: string } {
    const exact = exactProjectWorkspaceJsonV1(value);
    if (!exact || typeof exact !== "object" || Array.isArray(exact)) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const keys = Object.keys(exact);
    if (keys.length !== 2 || !keys.includes("scope") || !keys.includes("now")) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    const record = exact as { scope?: unknown; now?: unknown };
    const scope = authorizedProjectWorkspaceReadScopeSchemaV1.parse(record.scope);
    const now = typeof record.now === "string" ? record.now : "";
    if (Number.isNaN(Date.parse(now)) || new Date(now).toISOString() !== now) throw new ProjectWorkspaceContractErrorV1("invalid_input");
    return { scope, now };
  },
};
