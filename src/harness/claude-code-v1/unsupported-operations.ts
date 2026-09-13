import { connectorOperationAdmissibleV1, connectorOperationNamesV1,
  type ConnectorEvidenceLevelV1, type ConnectorOperationNameV1 } from "../v1/connector-profile";
import { claudeCodeConnectorProfileV1 } from "./connector-profile";

export const CLAUDE_CODE_OPERATION_REFUSAL_SCHEMA_V1 =
  "control-room.claude-code-operation-refusal/v1" as const;

export interface ClaudeCodeOperationRefusalV1 {
  readonly schema: typeof CLAUDE_CODE_OPERATION_REFUSAL_SCHEMA_V1;
  readonly connectorId: string;
  readonly operation: ConnectorOperationNameV1;
  readonly refused: true;
  readonly status: "unsupported" | "unknown";
  readonly evidence: ConnectorEvidenceLevelV1;
  /** The profile's own reason code. This module invents no new justification. */
  readonly reasonCode: string;
  readonly attempted: false;
  readonly grantsExecutionAuthority: false;
  readonly permitsRetry: false;
  readonly permitsResume: false;
}

const unavailable = (): never => { throw new Error("claude_code_operation_refusal_unavailable"); };

function isOperationName(value: unknown): value is ConnectorOperationNameV1 {
  return typeof value === "string"
    && (connectorOperationNamesV1 as readonly string[]).includes(value);
}

/**
 * Produces an explicit refusal for any operation this connector has not proven.
 * Callers must use this rather than silently doing nothing, so an unproven
 * operation is always visible as a refusal with a reason code. If a profile
 * operation ever becomes genuinely admissible this throws, because a refusal is
 * then the wrong answer and the caller must be updated deliberately.
 */
export function refuseClaudeCodeOperationV1(operation: unknown): ClaudeCodeOperationRefusalV1 {
  if (!isOperationName(operation)) return unavailable();
  const declared = claudeCodeConnectorProfileV1.operations[operation];
  if (declared.status === "supported" || connectorOperationAdmissibleV1(claudeCodeConnectorProfileV1, operation)) {
    return unavailable();
  }
  return Object.freeze({
    schema: CLAUDE_CODE_OPERATION_REFUSAL_SCHEMA_V1,
    connectorId: claudeCodeConnectorProfileV1.connectorId,
    operation,
    refused: true,
    status: declared.status,
    evidence: declared.evidence,
    reasonCode: declared.reasonCode,
    attempted: false,
    grantsExecutionAuthority: false,
    permitsRetry: false,
    permitsResume: false,
  });
}

/** Every declared operation, each with its own explicit refusal. */
export function claudeCodeOperationRefusalsV1(): Readonly<Record<ConnectorOperationNameV1, ClaudeCodeOperationRefusalV1>> {
  return Object.freeze(Object.fromEntries(
    connectorOperationNamesV1.map(name => [name, refuseClaudeCodeOperationV1(name)]),
  ) as Record<ConnectorOperationNameV1, ClaudeCodeOperationRefusalV1>);
}
