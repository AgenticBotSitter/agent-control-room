import { SecurityStore, type RecordedDecision, type VerifiedAuthentication } from "../../security";
import type { DatabaseClient } from "../../persistence/database";
import { OperatorSurfaceStoreV1, OperatorSurfaceStoreError } from "./store";
import type { OwnerFocusCommandV1, OwnerFocusPinV1 } from "./types";

export class OwnerFocusCommandError extends Error {
  constructor(readonly safeCode: "invalid_owner_focus_command" | "owner_focus_forbidden" | "owner_focus_unavailable") { super(safeCode); }
}

export interface AuthorizedOwnerFocusResultV1 {
  replayed: boolean;
  pin?: OwnerFocusPinV1;
  authorization: Pick<RecordedDecision, "id" | "allowed" | "reasonCodes" | "expiresAt">;
}

/**
 * Policy-gated write for owner priority intent. It deliberately creates no
 * reservation, scheduler change, outbox event, dispatch, or external effect.
 */
export class AuthorizedOwnerFocusCommandServiceV1 {
  private readonly security: SecurityStore;
  private readonly surfaces: OperatorSurfaceStoreV1;

  constructor(db: DatabaseClient) {
    this.security = new SecurityStore(db);
    this.surfaces = new OperatorSurfaceStoreV1(db);
  }

  async apply(input: { command: OwnerFocusCommandV1; authentication: VerifiedAuthentication; decisionId: string }): Promise<AuthorizedOwnerFocusResultV1> {
    const { command, authentication, decisionId } = input;
    if (command.tenantId !== authentication.tenantId) throw new OwnerFocusCommandError("invalid_owner_focus_command");
    let authorization: RecordedDecision;
    try {
      authorization = await this.security.authorize({
        decisionId,
        authentication,
        request: {
          tenantId: command.tenantId,
          action: command.operation === "set_owner_focus" ? "owner_focus.set" : "owner_focus.clear",
          resourceType: "owner_focus",
          resourceId: command.projectId,
          projectId: command.projectId,
          risk: "low",
          externalEffect: false,
          occurredAt: command.requestedAt,
        },
      });
    } catch {
      throw new OwnerFocusCommandError("owner_focus_unavailable");
    }
    if (!authorization.allowed) throw new OwnerFocusCommandError("owner_focus_forbidden");
    try {
      const result = await this.surfaces.applyAuthorizedOwnerFocus(command);
      return { replayed: result.replayed, pin: result.pin, authorization: { id: authorization.id, allowed: authorization.allowed, reasonCodes: authorization.reasonCodes, expiresAt: authorization.expiresAt } };
    } catch (error) {
      if (error instanceof OperatorSurfaceStoreError) throw new OwnerFocusCommandError("invalid_owner_focus_command");
      throw new OwnerFocusCommandError("owner_focus_unavailable");
    }
  }
}
