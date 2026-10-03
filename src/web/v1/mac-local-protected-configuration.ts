import { captureOwnerTrustedLocalEnablementV1, type OwnerTrustedLocalEnablementV1 } from "../../harness/v1/owner-trusted-local-enablements";
import { captureLocalOwnerSessionProfileV1, type LocalOwnerSessionProfileV1 } from "./local-owner-session";
import { validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import { captureMacLocalRemoteAccessV1, macLocalRemoteOriginsV1, type MacLocalRemoteAccessV1 } from "./mac-local-remote-access";

export const MAC_LOCAL_PROTECTED_CONFIGURATION_V1 = "control-room.mac-local-protected-configuration/v1" as const;

export type MacLocalProtectedConfigurationV1 = Readonly<{
  schema: typeof MAC_LOCAL_PROTECTED_CONFIGURATION_V1;
  port: number;
  workspaceId: string;
  localOwnerSession: LocalOwnerSessionProfileV1;
  database: PrivatePostgresConfiguration;
  enablement: OwnerTrustedLocalEnablementV1;
  workIntakeProjectIds: readonly string[];
  /** Normalised remote-access paths; absent means loopback only. */
  remoteAccess?: MacLocalRemoteAccessV1;
}>;

/**
 * Captures the small, owner-controlled configuration used by the Mac-local
 * composition. It is deliberately data only: reading this value neither opens
 * PostgreSQL nor starts a listener or worker. The later startup composition
 * supplies those effects explicitly.
 */
export function captureMacLocalProtectedConfigurationV1(value: unknown,
  context: Readonly<{ installRoot?: string }> = {}): MacLocalProtectedConfigurationV1 {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error();
    const record = value as Record<string, unknown>;
    const requiredKeys = ["schema", "port", "workspaceId", "localOwnerSession", "database", "enablement"];
    const keys = [...requiredKeys, "workIntakeProjectIds", "remoteAccess"];
    const workIntakeProjectIds = record.workIntakeProjectIds ?? [];
    if (requiredKeys.some(key => !(key in record)) || Object.keys(record).some(key => !keys.includes(key))
      || record.schema !== MAC_LOCAL_PROTECTED_CONFIGURATION_V1 || !Number.isSafeInteger(record.port)
      || (record.port as number) < 1 || (record.port as number) > 65535 || typeof record.workspaceId !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(record.workspaceId)
      || !Array.isArray(workIntakeProjectIds) || workIntakeProjectIds.length > 32
      || workIntakeProjectIds.some(projectId => typeof projectId !== "string"
        || !/^(?:\*|[A-Za-z0-9][A-Za-z0-9._:-]{0,179})$/.test(projectId))
      || new Set(workIntakeProjectIds).size !== workIntakeProjectIds.length
      || (workIntakeProjectIds.includes("*") && workIntakeProjectIds.length !== 1)) throw new Error();
    // remoteOrigins is derived below from remoteAccess, never written directly.
    if (record.localOwnerSession && typeof record.localOwnerSession === "object"
      && "remoteOrigins" in (record.localOwnerSession as object)) throw new Error();
    const ownerSession = captureLocalOwnerSessionProfileV1(record.localOwnerSession);
    if (new URL(ownerSession.origin).port !== String(record.port)) throw new Error();
    const remoteAccess = record.remoteAccess === undefined && ownerSession.trustedOrigin === undefined ? undefined
      : captureMacLocalRemoteAccessV1(record.remoteAccess, ownerSession.origin, ownerSession.trustedOrigin);
    const { trustedOrigin: _legacy, ...sessionWithoutLegacy } = ownerSession;
    const localOwnerSession = remoteAccess ? captureLocalOwnerSessionProfileV1({ ...sessionWithoutLegacy,
      remoteOrigins: macLocalRemoteOriginsV1(remoteAccess) }) : ownerSession;
    const database = validatePrivatePostgresConfiguration(record.database as PrivatePostgresConfiguration, context);
    const enablement = captureOwnerTrustedLocalEnablementV1(record.enablement, { allowEmpty: true });
    return Object.freeze({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: record.port as number,
      workspaceId: record.workspaceId, localOwnerSession, database, enablement,
      workIntakeProjectIds: Object.freeze([...(workIntakeProjectIds as string[])]),
      ...(remoteAccess ? { remoteAccess } : {}) });
  } catch { throw new Error("mac_local_protected_configuration_invalid"); }
}
