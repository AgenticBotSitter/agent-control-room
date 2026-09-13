import { z } from "zod";

export const CONNECTOR_PROFILE_SCHEMA_V1 = "control-room.connector-profile/v1" as const;
export const connectorOperationNamesV1 = [
  "submit", "status", "result", "events", "cancel", "resume", "read", "usage", "artifacts",
] as const;
export type ConnectorOperationNameV1 = (typeof connectorOperationNamesV1)[number];
export const connectorEvidenceLevelsV1 = [
  "source_inspected", "fixture_tested", "actual_interface_tested", "native_qualified",
] as const;
export type ConnectorEvidenceLevelV1 = (typeof connectorEvidenceLevelsV1)[number];

const id = z.string().min(3).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const version = z.string().min(1).max(80).regex(/^[a-zA-Z0-9][a-zA-Z0-9._+-]*$/);
const npmPackageName = z.string().min(1).max(214)
  .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/);
const npmExactVersion = z.string().min(5).max(80).regex(
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/,
);
const npmSha512Integrity = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/).refine(value => {
  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64 && decoded.toString("base64") === encoded;
}, "integrity must be the canonical Base64 encoding of exactly 64 bytes");
const sourcePackage = z.object({
  ecosystem: z.literal("npm"),
  name: npmPackageName,
  version: npmExactVersion,
  integrity: npmSha512Integrity,
}).strict();
const operation = z.object({
  status: z.enum(["supported", "unsupported", "unknown"]),
  evidence: z.enum(connectorEvidenceLevelsV1),
  reasonCode: id,
}).strict();

const operations = Object.fromEntries(connectorOperationNamesV1.map(name => [name, operation])) as {
  [K in ConnectorOperationNameV1]: typeof operation;
};

/**
 * Public, inert connector metadata. This describes an upstream interface and its
 * evidence; it contains no callbacks, credentials, endpoints or execution authority.
 */
export const connectorProfileSchemaV1 = z.object({
  schema: z.literal(CONNECTOR_PROFILE_SCHEMA_V1),
  connectorId: id,
  connectorVersion: version,
  harness: z.enum(["hermes", "codex", "claude", "other"]),
  harnessVersion: version,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  sourcePackage: sourcePackage.optional(),
  transport: z.enum(["fastmcp_tools", "json_rpc_stdio", "jsonl_stdio", "rest", "observation_only"]),
  isolation: z.enum(["adapter_process", "worktree", "container", "harness_owned"]),
  credentialResolution: z.enum(["harness_native", "node_reference_only", "unsupported"]),
  distribution: z.enum(["invocation_only", "redistributable"]),
  operations: z.object(operations).strict(),
  resultContract: z.object({
    forms: z.tuple([z.literal("utf8_text")]),
    maximumBytes: z.literal(65_536),
    additionalAttachments: z.literal(false),
  }).strict(),
}).strict().superRefine((profile, context) => {
  if ((profile.sourceRevision !== undefined) === (profile.sourcePackage !== undefined)) {
    context.addIssue({
      code: "custom",
      message: "exactly one upstream source identity is required",
      path: ["sourceRevision"],
    });
  }
  if (profile.sourcePackage && profile.sourcePackage.version !== profile.harnessVersion) {
    context.addIssue({
      code: "custom",
      message: "package version must match harness version",
      path: ["sourcePackage", "version"],
    });
  }
  if (profile.transport === "observation_only"
    && ["submit", "cancel", "resume"].some(name => profile.operations[name as ConnectorOperationNameV1].status === "supported")) {
    context.addIssue({ code: "custom", message: "observation-only connectors cannot advertise execution operations", path: ["operations"] });
  }
  if (profile.credentialResolution === "unsupported" && profile.operations.submit.status === "supported") {
    context.addIssue({ code: "custom", message: "submission requires an explicit credential resolution mode", path: ["credentialResolution"] });
  }
});

export type ConnectorProfileV1 = z.infer<typeof connectorProfileSchemaV1>;

export function parseConnectorProfileV1(value: unknown): ConnectorProfileV1 {
  return structuredClone(connectorProfileSchemaV1.parse(value));
}

/** Source or fixture evidence can guide integration, but cannot enable a runtime operation. */
export function connectorOperationAdmissibleV1(profileValue: unknown, operationName: ConnectorOperationNameV1): boolean {
  const profile = connectorProfileSchemaV1.parse(profileValue);
  const operationValue = profile.operations[operationName];
  return operationValue.status === "supported"
    && ["actual_interface_tested", "native_qualified"].includes(operationValue.evidence);
}
