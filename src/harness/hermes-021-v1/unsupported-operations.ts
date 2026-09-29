import { connectorOperationAdmissibleV1, connectorOperationNamesV1,
  type ConnectorEvidenceLevelV1, type ConnectorOperationNameV1 } from "../v1/connector-profile";
import { hermes021MacosLocalConnectorProfileV1 } from "./connector-profile";

export interface Hermes021MacosOperationRefusalV1 {
  readonly connectorId: string;
  readonly operation: ConnectorOperationNameV1;
  readonly refused: true;
  readonly status: "unsupported" | "unknown";
  readonly evidence: ConnectorEvidenceLevelV1;
  readonly reasonCode: string;
  readonly attempted: false;
  readonly grantsExecutionAuthority: false;
  readonly permitsRetry: false;
}

const unavailable = (): never => { throw new Error("hermes_021_macos_operation_refusal_unavailable"); };

/** Makes unqualified Hermes actions visible rather than silently attempting them. */
export function refuseHermes021MacosOperationV1(operation: unknown): Hermes021MacosOperationRefusalV1 {
  if (typeof operation !== "string" || !(connectorOperationNamesV1 as readonly string[]).includes(operation)) unavailable();
  const name = operation as ConnectorOperationNameV1;
  const declared = hermes021MacosLocalConnectorProfileV1.operations[name];
  if (declared.status === "supported" || connectorOperationAdmissibleV1(hermes021MacosLocalConnectorProfileV1, name)) unavailable();
  const status: "unsupported" | "unknown" = declared.status === "unsupported" ? "unsupported" : "unknown";
  return Object.freeze({
    connectorId: hermes021MacosLocalConnectorProfileV1.connectorId, operation: name, refused: true,
    status, evidence: declared.evidence, reasonCode: declared.reasonCode,
    attempted: false, grantsExecutionAuthority: false, permitsRetry: false,
  });
}
