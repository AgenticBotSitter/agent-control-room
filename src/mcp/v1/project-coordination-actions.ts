// CONN-009 — harness-neutral MCP action surface for project coordination.
//
// Thin adapter over the existing ProjectCoordinationHttpService. It creates
// no second task, permission, or approval system: every read returns bounded
// project/task/attention data through existing owner authorization, and every
// write calls the same propose/submit/review path (appoint/replace/revoke,
// pause/resume/revoke-policy) with the same idempotency keys and
// current-revision checks. The engine remains the authority; this module is
// a carrier that maps transport shapes to identical canonical outcomes.
//
// No MCP server install, network listener, credential, provider, or
// production effect. Pure delegation + an explicit unsupported-tool refusal.

import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import type {
  ProjectCoordinationActionOutcome,
  ProjectCoordinationHttpService,
  ProjectCoordinationPagePayload,
} from "../../web/v1/project-coordination-http";

export const CONTROL_ROOM_MCP_TOOL_NAMES = [
  "control_room_read_project",
  "control_room_appoint_coordinator",
  "control_room_replace_coordinator",
  "control_room_revoke_coordinator",
  "control_room_pause_policy",
  "control_room_resume_policy",
  "control_room_revoke_policy",
] as const;

export type ControlRoomMcpToolName = (typeof CONTROL_ROOM_MCP_TOOL_NAMES)[number];

export interface ControlRoomMcpToolDefinition {
  name: ControlRoomMcpToolName;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

// Tool descriptions grant no authority and reveal no private configuration.
// Each states that the caller must already hold the grant; nothing here
// confers it, and no endpoints, secrets, or topology are named.
export const CONTROL_ROOM_MCP_TOOLS: ControlRoomMcpToolDefinition[] = [
  {
    name: "control_room_read_project",
    description:
      "Read the bounded coordination page (project, coordinator head, policy summary, active work, conflicts, attention) for one project. Uses the caller's existing owner authorization; grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id, e.g. project:example." },
      },
      required: ["projectId"],
    },
  },
  {
    name: "control_room_appoint_coordinator",
    description:
      "Appoint the project coordinator through the existing lifecycle service. Requires the caller's existing grant, a current revision, and an idempotency key. Grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        revision: { type: "object", description: "Current page revision from a prior read." },
        coordinatorActorType: { type: "string", description: "human or agent." },
        coordinatorIdentityId: { type: "string", description: "Coordinator identity id." },
        idempotencyKey: { type: "string", description: "Caller-chosen idempotency key." },
      },
      required: ["projectId", "revision", "coordinatorActorType", "coordinatorIdentityId", "idempotencyKey"],
    },
  },
  {
    name: "control_room_replace_coordinator",
    description:
      "Replace the project coordinator through the existing lifecycle service. Requires the caller's existing grant, a current revision, and an idempotency key. Grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        revision: { type: "object", description: "Current page revision from a prior read." },
        coordinatorActorType: { type: "string", description: "human or agent." },
        coordinatorIdentityId: { type: "string", description: "Coordinator identity id." },
        idempotencyKey: { type: "string", description: "Caller-chosen idempotency key." },
      },
      required: ["projectId", "revision", "coordinatorActorType", "coordinatorIdentityId", "idempotencyKey"],
    },
  },
  {
    name: "control_room_revoke_coordinator",
    description:
      "Revoke the project coordinator through the existing lifecycle service. Requires the caller's existing grant, a current revision, and an idempotency key. Grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        revision: { type: "object", description: "Current page revision from a prior read." },
        coordinatorActorType: { type: "string", description: "human or agent." },
        coordinatorIdentityId: { type: "string", description: "Coordinator identity id." },
        idempotencyKey: { type: "string", description: "Caller-chosen idempotency key." },
      },
      required: ["projectId", "revision", "coordinatorActorType", "coordinatorIdentityId", "idempotencyKey"],
    },
  },
  {
    name: "control_room_pause_policy",
    description:
      "Pause the delegation policy through the existing lifecycle service. Requires the caller's existing grant, a current revision, the policy id, and an idempotency key. Grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        revision: { type: "object", description: "Current page revision from a prior read." },
        policyId: { type: "string", description: "Policy id from a prior read." },
        idempotencyKey: { type: "string", description: "Caller-chosen idempotency key." },
      },
      required: ["projectId", "revision", "policyId", "idempotencyKey"],
    },
  },
  {
    name: "control_room_resume_policy",
    description:
      "Resume the delegation policy through the existing lifecycle service. Requires the caller's existing grant, a current revision, the policy id, and an idempotency key. Grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        revision: { type: "object", description: "Current page revision from a prior read." },
        policyId: { type: "string", description: "Policy id from a prior read." },
        idempotencyKey: { type: "string", description: "Caller-chosen idempotency key." },
      },
      required: ["projectId", "revision", "policyId", "idempotencyKey"],
    },
  },
  {
    name: "control_room_revoke_policy",
    description:
      "Revoke the delegation policy through the existing lifecycle service. Requires the caller's existing grant, a current revision, the policy id, and an idempotency key. Grants nothing.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: { type: "string", description: "Project id." },
        revision: { type: "object", description: "Current page revision from a prior read." },
        policyId: { type: "string", description: "Policy id from a prior read." },
        idempotencyKey: { type: "string", description: "Caller-chosen idempotency key." },
      },
      required: ["projectId", "revision", "policyId", "idempotencyKey"],
    },
  },
];

export type ControlRoomMcpReadResult =
  | { status: "accepted"; page: ProjectCoordinationPagePayload }
  | { status: "refused"; reasonCode: string };

export type ControlRoomMcpWriteResult = ProjectCoordinationActionOutcome;

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;
  for (const key of ["reasonCode", "code", "safeCode"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function refused(reasonCode: string): { status: "refused"; reasonCode: string } {
  return { status: "refused", reasonCode };
}

function hasRevision(input: unknown): boolean {
  return typeof input === "object" && input !== null && "revision" in input &&
    typeof (input as { revision?: unknown }).revision === "object" &&
    (input as { revision?: unknown }).revision !== null;
}

function hasIdempotencyKey(input: unknown): boolean {
  return typeof input === "object" && input !== null &&
    typeof (input as { idempotencyKey?: unknown }).idempotencyKey === "string" &&
    ((input as { idempotencyKey: string }).idempotencyKey.length > 0);
}

// Visible adapter-boundary refusals. The engine stays authoritative for
// everything else; these only catch malformed envelopes before delegating.
function coordinatorInputError(input: unknown): { status: "refused"; reasonCode: string } | null {
  if (!hasRevision(input) || !hasIdempotencyKey(input)) return refused("invalid_input");
  const record = input as { coordinatorActorType?: unknown; coordinatorIdentityId?: unknown };
  if (record.coordinatorActorType !== "human" && record.coordinatorActorType !== "agent") {
    return refused("invalid_input");
  }
  if (typeof record.coordinatorIdentityId !== "string" || record.coordinatorIdentityId.length === 0) {
    return refused("invalid_input");
  }
  return null;
}

function policyInputError(input: unknown): { status: "refused"; reasonCode: string } | null {
  if (!hasRevision(input) || !hasIdempotencyKey(input)) return refused("invalid_input");
  const record = input as { policyId?: unknown };
  if (typeof record.policyId !== "string" || record.policyId.length === 0) {
    return refused("invalid_input");
  }
  return null;
}

export class ProjectCoordinationMcpActions {
  constructor(private readonly service: ProjectCoordinationHttpService) {}

  listTools(): ControlRoomMcpToolDefinition[] {
    return CONTROL_ROOM_MCP_TOOLS;
  }

  async readProject(
    identity: VerifiedWebIdentity,
    projectId: string,
  ): Promise<ControlRoomMcpReadResult> {
    if (typeof projectId !== "string" || projectId.length === 0) {
      return refused("invalid_input");
    }
    try {
      const page = await this.service.read(identity, projectId);
      return { status: "accepted", page };
    } catch (error: unknown) {
      return refused(errorCode(error) ?? "unknown_project");
    }
  }

  async appointCoordinator(
    identity: VerifiedWebIdentity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
  ): Promise<ControlRoomMcpWriteResult> {
    const boundary = coordinatorInputError(input);
    if (boundary) {
      return { ...boundary, revision: input?.revision ?? { projectId: input?.projectId ?? "" } } as ControlRoomMcpWriteResult;
    }
    return this.service.appointCoordinator(identity, input);
  }

  async replaceCoordinator(
    identity: VerifiedWebIdentity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
  ): Promise<ControlRoomMcpWriteResult> {
    const boundary = coordinatorInputError(input);
    if (boundary) {
      return { ...boundary, revision: input?.revision } as ControlRoomMcpWriteResult;
    }
    return this.service.replaceCoordinator(identity, input);
  }

  async revokeCoordinator(
    identity: VerifiedWebIdentity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
  ): Promise<ControlRoomMcpWriteResult> {
    const boundary = coordinatorInputError(input);
    if (boundary) {
      return { ...boundary, revision: input?.revision } as ControlRoomMcpWriteResult;
    }
    return this.service.revokeCoordinator(identity, input);
  }

  async pausePolicy(
    identity: VerifiedWebIdentity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
  ): Promise<ControlRoomMcpWriteResult> {
    const boundary = policyInputError(input);
    if (boundary) {
      return { ...boundary, revision: input?.revision } as ControlRoomMcpWriteResult;
    }
    return this.service.pauseDelegationPolicy(identity, input);
  }

  async resumePolicy(
    identity: VerifiedWebIdentity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
  ): Promise<ControlRoomMcpWriteResult> {
    const boundary = policyInputError(input);
    if (boundary) {
      return { ...boundary, revision: input?.revision } as ControlRoomMcpWriteResult;
    }
    return this.service.resumeDelegationPolicy(identity, input);
  }

  async revokePolicy(
    identity: VerifiedWebIdentity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
  ): Promise<ControlRoomMcpWriteResult> {
    const boundary = policyInputError(input);
    if (boundary) {
      return { ...boundary, revision: input?.revision } as ControlRoomMcpWriteResult;
    }
    return this.service.revokeDelegationPolicy(identity, input);
  }

  // Single dispatch entry. Unknown tool names refuse visibly with
  // `unsupported_tool` instead of throwing or routing anywhere.
  async callTool(
    identity: VerifiedWebIdentity,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    toolName: string, input: any,
  ): Promise<ControlRoomMcpReadResult | ControlRoomMcpWriteResult> {
    switch (toolName) {
      case "control_room_read_project":
        return this.readProject(identity, input?.projectId);
      case "control_room_appoint_coordinator":
        return this.appointCoordinator(identity, input);
      case "control_room_replace_coordinator":
        return this.replaceCoordinator(identity, input);
      case "control_room_revoke_coordinator":
        return this.revokeCoordinator(identity, input);
      case "control_room_pause_policy":
        return this.pausePolicy(identity, input);
      case "control_room_resume_policy":
        return this.resumePolicy(identity, input);
      case "control_room_revoke_policy":
        return this.revokePolicy(identity, input);
      default:
        return refused("unsupported_tool");
    }
  }
}
