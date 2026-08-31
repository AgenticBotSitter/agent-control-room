import { z } from "zod";
import { projectWorkspaceDigestSchemaV1 as digest } from "../../project-workspace/v1";
import { sha256Digest } from "../../security";
import { parseOperationsReleaseCandidateV1 } from "./deployment";
import { OperationsContractErrorV1 } from "./errors";
import { parseExactOperationsV1, verifyOperationsDigestV1 } from "./exact";
import { OPERATIONS_SERVICE_IDS_V1, OPERATIONS_SERVICE_ROLES_V1, parseOperationsProductionTopologyV1,
  type OperationsServiceIdV1, type OperationsServiceRoleV1 } from "./topology";

export const OPERATIONS_SYSTEMD_REFERENCE_V1 = "control-room-operations-systemd-reference/v1" as const;
export const OPERATIONS_SYSTEMD_UNIT_NAMES_V1 = [
  "control-room-edge.service", "control-room-application.service", "control-room-migration.service",
  "control-room-postgres.service", "control-room-backup.service", "control-room-audit-anchor.service",
  "control-room-observer.service",
] as const;
type OperationsSystemdUnitNameV1 = (typeof OPERATIONS_SYSTEMD_UNIT_NAMES_V1)[number];

export interface OperationsSystemdUnitReferenceV1 {
  unitName: OperationsSystemdUnitNameV1;
  serviceId: OperationsServiceIdV1;
  role: OperationsServiceRoleV1;
  artifactIdentityDigest: string;
  configurationSchemaDigest: string;
  principalIdentityDigest: string;
  credentialReferenceDigests: string[];
  userReferencePlaceholder: string;
  executableReferencePlaceholder: string;
  configurationReferencePlaceholder: string;
  ownerEnableMarkerReferencePlaceholder: string;
  afterUnits: OperationsSystemdUnitNameV1[];
  requiresUnits: OperationsSystemdUnitNameV1[];
  serviceType: "simple" | "oneshot";
  restartPolicy: "on_failure_bounded" | "never";
  addressFamilies: ["AF_UNIX"] | ["AF_UNIX", "AF_INET", "AF_INET6"];
  writablePathClasses: [] | ["postgres_state"];
  unitText: string;
  installSectionPresent: false;
  shellPresent: false;
  rootUserAllowed: false;
  privilegeEscalationAllowed: false;
  hostAdministrationAllowed: false;
  executable: false;
  grantsServiceControl: false;
  grantsExecutionAuthority: false;
  unitReferenceDigest: string;
}

export interface OperationsSystemdReferenceV1 {
  contractVersion: typeof OPERATIONS_SYSTEMD_REFERENCE_V1;
  platform: "linux_systemd_reference_only";
  topologyDigest: string;
  releaseDigest: string;
  units: OperationsSystemdUnitReferenceV1[];
  productionValuesPresent: false;
  hostInspected: false;
  daemonReloadAttempted: false;
  serviceControlAttempted: false;
  installAttempted: false;
  executable: false;
  grantsDeploymentAuthority: false;
  grantsServiceControl: false;
  grantsExecutionAuthority: false;
  systemdReferenceDigest: string;
}

const unitName = z.enum(OPERATIONS_SYSTEMD_UNIT_NAMES_V1), placeholder = z.string().regex(/^\{\{[A-Z0-9_]+\}\}$/);
const unitSchema = z.object({ unitName, serviceId: z.enum(OPERATIONS_SERVICE_IDS_V1), role: z.enum(OPERATIONS_SERVICE_ROLES_V1),
  artifactIdentityDigest: digest, configurationSchemaDigest: digest, principalIdentityDigest: digest,
  credentialReferenceDigests: z.array(digest).max(4), userReferencePlaceholder: placeholder,
  executableReferencePlaceholder: placeholder, configurationReferencePlaceholder: placeholder,
  ownerEnableMarkerReferencePlaceholder: placeholder, afterUnits: z.array(unitName).max(6), requiresUnits: z.array(unitName).max(2),
  serviceType: z.enum(["simple", "oneshot"]), restartPolicy: z.enum(["on_failure_bounded", "never"]),
  addressFamilies: z.union([z.tuple([z.literal("AF_UNIX")]), z.tuple([z.literal("AF_UNIX"), z.literal("AF_INET"), z.literal("AF_INET6")])]),
  writablePathClasses: z.union([z.tuple([]), z.tuple([z.literal("postgres_state")])]), unitText: z.string().min(1).max(30_000),
  installSectionPresent: z.literal(false), shellPresent: z.literal(false), rootUserAllowed: z.literal(false),
  privilegeEscalationAllowed: z.literal(false), hostAdministrationAllowed: z.literal(false), executable: z.literal(false),
  grantsServiceControl: z.literal(false), grantsExecutionAuthority: z.literal(false), unitReferenceDigest: digest }).strict();
const inputSchema = z.object({ topology: z.unknown(), release: z.unknown() }).strict();
const referenceSchema = z.object({ contractVersion: z.literal(OPERATIONS_SYSTEMD_REFERENCE_V1),
  platform: z.literal("linux_systemd_reference_only"), topologyDigest: digest, releaseDigest: digest,
  units: z.array(unitSchema).length(7), productionValuesPresent: z.literal(false), hostInspected: z.literal(false),
  daemonReloadAttempted: z.literal(false), serviceControlAttempted: z.literal(false), installAttempted: z.literal(false),
  executable: z.literal(false), grantsDeploymentAuthority: z.literal(false), grantsServiceControl: z.literal(false),
  grantsExecutionAuthority: z.literal(false), systemdReferenceDigest: digest }).strict();

const dependencies: ReadonlyArray<readonly OperationsSystemdUnitNameV1[]> = [
  [OPERATIONS_SYSTEMD_UNIT_NAMES_V1[1]], [OPERATIONS_SYSTEMD_UNIT_NAMES_V1[3]], [OPERATIONS_SYSTEMD_UNIT_NAMES_V1[3]], [],
  [OPERATIONS_SYSTEMD_UNIT_NAMES_V1[3]], [OPERATIONS_SYSTEMD_UNIT_NAMES_V1[3]], OPERATIONS_SYSTEMD_UNIT_NAMES_V1.slice(0, 5),
];
const externalNetworkRoles = new Set<OperationsServiceRoleV1>([
  "edge_connector", "control_room_application", "backup_controller", "audit_anchor",
]);

function renderUnit(unit: Omit<OperationsSystemdUnitReferenceV1, "unitText" | "unitReferenceDigest">): string {
  const description = unit.role.split("_").map((part) => part[0]!.toUpperCase() + part.slice(1)).join(" ");
  const lines = ["# VALUE-FREE REFERENCE ONLY — NOT INSTALLABLE", "[Unit]", `Description=Control Room ${description}`,
    "Documentation=control-room:CR10A-OPS-020", `ConditionPathExists=${unit.ownerEnableMarkerReferencePlaceholder}`];
  if (unit.afterUnits.length > 0) lines.push(`After=${unit.afterUnits.join(" ")}`);
  if (unit.requiresUnits.length > 0) lines.push(`Requires=${unit.requiresUnits.join(" ")}`);
  lines.push("", "[Service]", `Type=${unit.serviceType}`, `User=${unit.userReferencePlaceholder}`,
    `Group=${unit.userReferencePlaceholder}`, `ExecStart=${unit.executableReferencePlaceholder} --configuration-reference ${unit.configurationReferencePlaceholder}`,
    "NoNewPrivileges=true", "CapabilityBoundingSet=", "AmbientCapabilities=", "ProtectSystem=strict", "ProtectHome=true",
    "PrivateTmp=true", "PrivateDevices=true", "ProtectKernelTunables=true", "ProtectKernelModules=true",
    "ProtectKernelLogs=true", "ProtectControlGroups=true", "RestrictSUIDSGID=true", "RestrictNamespaces=true",
    "LockPersonality=true", "SystemCallArchitectures=native", `RestrictAddressFamilies=${unit.addressFamilies.join(" ")}`,
    "UMask=0077", `Restart=${unit.restartPolicy === "never" ? "no" : "on-failure"}`);
  if (unit.restartPolicy !== "never") lines.push("RestartSec=5", "StartLimitIntervalSec=60", "StartLimitBurst=3");
  if (unit.writablePathClasses.length > 0) lines.push("ReadWritePaths={{POSTGRES_STATE_ROOT_REFERENCE}}");
  for (const reference of unit.credentialReferenceDigests) lines.push(`# X-ControlRoom-Credential-Reference-Digest=${reference}`);
  lines.push("# [Install] intentionally absent", "");
  return lines.join("\n");
}

function makeUnits(topology: ReturnType<typeof parseOperationsProductionTopologyV1>): OperationsSystemdUnitReferenceV1[] {
  return topology.services.map((service, position) => {
    const unitNameValue = OPERATIONS_SYSTEMD_UNIT_NAMES_V1[position]!, afterUnits = [...dependencies[position]!],
      requiresUnits = service.role === "operations_observer" ? [] : [...dependencies[position]!],
      roleToken = service.role.toUpperCase();
    const base: Omit<OperationsSystemdUnitReferenceV1, "unitText" | "unitReferenceDigest"> = {
      unitName: unitNameValue, serviceId: service.serviceId, role: service.role,
      artifactIdentityDigest: service.artifactIdentityDigest, configurationSchemaDigest: service.configurationSchemaDigest,
      principalIdentityDigest: service.principalIdentityDigest, credentialReferenceDigests: service.credentialReferenceDigests,
      userReferencePlaceholder: `{{${roleToken}_DISTINCT_USER_REFERENCE}}`,
      executableReferencePlaceholder: `{{${roleToken}_IMMUTABLE_EXECUTABLE_REFERENCE}}`,
      configurationReferencePlaceholder: `{{${roleToken}_CONFIGURATION_REFERENCE}}`,
      ownerEnableMarkerReferencePlaceholder: `{{${roleToken}_OWNER_ENABLE_MARKER_REFERENCE}}`, afterUnits, requiresUnits,
      serviceType: service.role === "migration_runner" ? "oneshot" : "simple",
      restartPolicy: service.role === "migration_runner" ? "never" : "on_failure_bounded",
      addressFamilies: externalNetworkRoles.has(service.role) ? ["AF_UNIX", "AF_INET", "AF_INET6"] : ["AF_UNIX"],
      writablePathClasses: service.role === "postgres_primary" ? ["postgres_state"] : [], installSectionPresent: false,
      shellPresent: false, rootUserAllowed: false, privilegeEscalationAllowed: false, hostAdministrationAllowed: false,
      executable: false, grantsServiceControl: false, grantsExecutionAuthority: false,
    };
    const unitText = renderUnit(base), material = { ...base, unitText };
    return { ...material, unitReferenceDigest: sha256Digest(material) };
  });
}

export function buildOperationsSystemdReferenceV1(inputValue: unknown): OperationsSystemdReferenceV1 {
  const input = parseExactOperationsV1(inputSchema, inputValue, "operations systemd reference input"),
    topology = parseOperationsProductionTopologyV1(input.topology), release = parseOperationsReleaseCandidateV1(input.release);
  if (release.applicationArtifactDigest !== topology.services[1]!.artifactIdentityDigest
    || release.migrationBundleDigest !== topology.services[2]!.artifactIdentityDigest
    || release.publicAssetsDigest !== topology.services[0]!.artifactIdentityDigest) throw new OperationsContractErrorV1("scope_mismatch");
  const material: Omit<OperationsSystemdReferenceV1, "systemdReferenceDigest"> = {
    contractVersion: OPERATIONS_SYSTEMD_REFERENCE_V1, platform: "linux_systemd_reference_only",
    topologyDigest: topology.topologyDigest, releaseDigest: release.releaseDigest, units: makeUnits(topology),
    productionValuesPresent: false, hostInspected: false, daemonReloadAttempted: false, serviceControlAttempted: false,
    installAttempted: false, executable: false, grantsDeploymentAuthority: false, grantsServiceControl: false,
    grantsExecutionAuthority: false,
  };
  return parseOperationsSystemdReferenceV1({ ...material, systemdReferenceDigest: sha256Digest(material) });
}

export function parseOperationsSystemdReferenceV1(value: unknown): OperationsSystemdReferenceV1 {
  const parsed = parseExactOperationsV1(referenceSchema, value, "operations systemd reference");
  if (parsed.units.map((unit) => unit.unitName).join("|") !== OPERATIONS_SYSTEMD_UNIT_NAMES_V1.join("|")
    || parsed.units.map((unit) => unit.serviceId).join("|") !== OPERATIONS_SERVICE_IDS_V1.join("|")
    || parsed.units.map((unit) => unit.role).join("|") !== OPERATIONS_SERVICE_ROLES_V1.join("|")
    || new Set(parsed.units.map((unit) => unit.userReferencePlaceholder)).size !== parsed.units.length
    || new Set(parsed.units.map((unit) => unit.principalIdentityDigest)).size !== parsed.units.length
    || new Set(parsed.units.map((unit) => unit.artifactIdentityDigest)).size !== parsed.units.length
    || parsed.units.some((unit, position) => unit.afterUnits.join("|") !== dependencies[position]!.join("|")
      || unit.requiresUnits.join("|") !== (unit.role === "operations_observer" ? "" : dependencies[position]!.join("|"))
      || unit.userReferencePlaceholder !== `{{${unit.role.toUpperCase()}_DISTINCT_USER_REFERENCE}}`
      || unit.executableReferencePlaceholder !== `{{${unit.role.toUpperCase()}_IMMUTABLE_EXECUTABLE_REFERENCE}}`
      || unit.configurationReferencePlaceholder !== `{{${unit.role.toUpperCase()}_CONFIGURATION_REFERENCE}}`
      || unit.ownerEnableMarkerReferencePlaceholder !== `{{${unit.role.toUpperCase()}_OWNER_ENABLE_MARKER_REFERENCE}}`
      || unit.serviceType !== (unit.role === "migration_runner" ? "oneshot" : "simple")
      || unit.restartPolicy !== (unit.role === "migration_runner" ? "never" : "on_failure_bounded")
      || unit.addressFamilies.join("|") !== (externalNetworkRoles.has(unit.role) ? "AF_UNIX|AF_INET|AF_INET6" : "AF_UNIX")
      || (unit.writablePathClasses.length === 1) !== (unit.role === "postgres_primary")
      || unit.unitText !== renderUnit(unit)
      || /(?:\[Install\]\s*\n|User=(?:root|0)\b|sudo\b|\/bin\/(?:sh|bash)\b|ExecStartPre=|ExecStartPost=|ExecReload=|PermissionsStartOnly=true|AmbientCapabilities=\S|CapabilityBoundingSet=\S|Restart=always)/i.test(unit.unitText))) {
    throw new OperationsContractErrorV1("scope_mismatch");
  }
  for (const unit of parsed.units) verifyOperationsDigestV1(unit as unknown as Record<string, unknown>,
    "unitReferenceDigest", unit.unitReferenceDigest);
  verifyOperationsDigestV1(parsed as unknown as Record<string, unknown>, "systemdReferenceDigest", parsed.systemdReferenceDigest);
  return parsed;
}
