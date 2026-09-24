import { captureOwnerTrustedLocalEnablementV1, type OwnerTrustedLocalEnablementV1 } from "../../harness/v1/owner-trusted-local-enablements";
import { captureLocalOwnerSessionProfileV1, type LocalOwnerSessionProfileV1 } from "./local-owner-session";
import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";

export const MAC_LOCAL_PROTECTED_CONFIGURATION_V1 = "control-room.mac-local-protected-configuration/v1" as const;

export type MacLocalProtectedConfigurationV1 = Readonly<{
  schema: typeof MAC_LOCAL_PROTECTED_CONFIGURATION_V1;
  port: number;
  workspaceId: string;
  localOwnerSession: LocalOwnerSessionProfileV1;
  database: PrivatePostgresConfiguration;
  enablement: OwnerTrustedLocalEnablementV1;
}>;

/**
 * Captures the small, owner-controlled configuration used by the Mac-local
 * composition. It is deliberately data only: reading this value neither opens
 * PostgreSQL nor starts a listener or worker. The later startup composition
 * supplies those effects explicitly.
 */
export function captureMacLocalProtectedConfigurationV1(value: unknown): MacLocalProtectedConfigurationV1 {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error();
    const record = value as Record<string, unknown>;
    const keys = ["schema", "port", "workspaceId", "localOwnerSession", "database", "enablement"];
    if (Object.keys(record).length !== keys.length || keys.some(key => !(key in record)) || Object.keys(record).some(key => !keys.includes(key))
      || record.schema !== MAC_LOCAL_PROTECTED_CONFIGURATION_V1 || !Number.isSafeInteger(record.port)
      || (record.port as number) < 1 || (record.port as number) > 65535 || typeof record.workspaceId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(record.workspaceId)) throw new Error();
    const localOwnerSession = captureLocalOwnerSessionProfileV1(record.localOwnerSession);
    if (new URL(localOwnerSession.origin).port !== String(record.port)) throw new Error();
    const database = validatePrivatePostgresConfiguration(record.database as PrivatePostgresConfiguration);
    const enablement = captureOwnerTrustedLocalEnablementV1(record.enablement);
    return Object.freeze({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: record.port as number,
      workspaceId: record.workspaceId, localOwnerSession, database, enablement });
  } catch { throw new Error("mac_local_protected_configuration_invalid"); }
}
