import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "../../web/v1/private-postgres";
import type { AuthenticatedPrincipal } from "../../security";

export const WORK_INTAKE_INSTALLED_CONFIGURATION_V1 = "control-room.work-intake-installed/v1" as const;
export type WorkIntakeInstalledConfigurationV1 = Readonly<{
  schema: typeof WORK_INTAKE_INSTALLED_CONFIGURATION_V1;
  port: number;
  database: PrivatePostgresConfiguration;
  bearerSecret: string;
  principal: AuthenticatedPrincipal;
  integrityKey: string;
  queueDepthLimit: number;
}>;

const exactKeys = (value: Record<string, unknown>, expected: readonly string[]) =>
  Object.keys(value).sort().join(",") === [...expected].sort().join(",");
const token = /^[A-Za-z0-9_-]{43}$/u;
const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,179}$/u;

export function captureWorkIntakeInstalledConfigurationV1(value: unknown): WorkIntakeInstalledConfigurationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("work_intake_installed_configuration_refused");
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["schema", "port", "database", "bearerSecret", "principal", "integrityKey", "queueDepthLimit"])
    || input.schema !== WORK_INTAKE_INSTALLED_CONFIGURATION_V1 || !Number.isSafeInteger(input.port)
    || (input.port as number) < 1 || (input.port as number) > 65535 || !token.test(String(input.bearerSecret))
    || !token.test(String(input.integrityKey)) || Buffer.from(String(input.integrityKey), "base64url").length !== 32
    || !Number.isSafeInteger(input.queueDepthLimit) || (input.queueDepthLimit as number) < 1
    || (input.queueDepthLimit as number) > 20 || !input.principal || typeof input.principal !== "object"
    || Array.isArray(input.principal)) throw new Error("work_intake_installed_configuration_refused");
  const principal = input.principal as Record<string, unknown>;
  if (!exactKeys(principal, ["tenantId", "identityId", "actorType", "authenticatedAt", "expiresAt"])
    || !id.test(String(principal.tenantId)) || !id.test(String(principal.identityId)) || principal.actorType !== "agent"
    || !Number.isFinite(Date.parse(String(principal.authenticatedAt)))
    || !Number.isFinite(Date.parse(String(principal.expiresAt)))) throw new Error("work_intake_installed_configuration_refused");
  const database = validatePrivatePostgresConfiguration(input.database as PrivatePostgresConfiguration);
  if (database.username !== "control_room_work_intake_agent") throw new Error("work_intake_installed_configuration_refused");
  return Object.freeze({ schema: WORK_INTAKE_INSTALLED_CONFIGURATION_V1, port: input.port as number, database,
    bearerSecret: String(input.bearerSecret), principal: Object.freeze({ tenantId: String(principal.tenantId),
      identityId: String(principal.identityId), actorType: "agent", authenticatedAt: String(principal.authenticatedAt),
      expiresAt: String(principal.expiresAt) }),
    integrityKey: String(input.integrityKey), queueDepthLimit: input.queueDepthLimit as number });
}

export function privateServiceConfigurationFromInstalledV1(value: WorkIntakeInstalledConfigurationV1) {
  const captured = captureWorkIntakeInstalledConfigurationV1(value);
  return Object.freeze({ port: captured.port, database: captured.database, bearerSecret: captured.bearerSecret,
    principal: captured.principal, integrityKey: Uint8Array.from(Buffer.from(captured.integrityKey, "base64url")),
    queueDepthLimit: captured.queueDepthLimit });
}
