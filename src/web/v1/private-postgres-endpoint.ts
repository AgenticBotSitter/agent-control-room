import { isIP } from "node:net";
import { posix } from "node:path";
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from "node:tls";
import { sha256Digest } from "../../security/canonical-digest";
import { exactHostDataSnapshotV1 } from "../../security/host-value";

export const PRIVATE_POSTGRES_ENDPOINT_V2 = "control-room.private-postgres-endpoint/v2" as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

/** Private, manifest-bound data. A digest records reviewed route evidence; it
 * does not itself prove that Tailscale is currently connected. TLS authenticates
 * every database connection independently, including pooled reconnections. */
export type PrivatePostgresEndpointPolicyV2 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_ENDPOINT_V2;
  routeKind: "tailscale";
  endpointFingerprint: string;
  privateRouteEvidenceDigest: string;
  serverIdentity: Readonly<{ serverName: string }>;
}>;
type Address = Readonly<{ host: string; port: number; database: string; majorVersion: 17 }>;

function refused(): never { throw new Error("invalid_private_database_endpoint"); }

const INSTALLED_SOCKET_SUFFIX_V1 = "/pg/socket";
export type PrivatePostgresValidationContextV1 = Readonly<{ installRoot?: string }>;

/** The installer's own socket directory, `<root>/pg/socket`: the installed cluster
 * is socket-only (`listen_addresses = ''`), so this is how the services reach it.
 * Absolute, already normal (no `.`/`..`/`//`), no control, invisible or separator
 * characters. (A path too long for a Unix socket is the cluster's own refusal, at
 * init.) A caller that knows the install root (every protected-file loader and the
 * composer pass it; it never comes from the JSON itself) gets exactly
 * `<installRoot>/pg/socket` and every other directory is refused. Without a root,
 * only the shape is checked; that is re-validation of an already-bound value. */
export function isInstalledPostgresSocketDirectoryV1(host: unknown, installRoot?: string): host is string {
  if (typeof host !== "string" || !host.startsWith("/") || !host.endsWith(INSTALLED_SOCKET_SUFFIX_V1)
    || host.length <= INSTALLED_SOCKET_SUFFIX_V1.length || host.length > 1024
    || posix.normalize(host) !== host || /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u.test(host)) return false;
  if (installRoot === undefined) return true;
  return typeof installRoot === "string" && installRoot.startsWith("/") && installRoot !== "/"
    && posix.normalize(installRoot) === installRoot && host === `${installRoot}${INSTALLED_SOCKET_SUFFIX_V1}`;
}

/** Only exact canonical literals are accepted. No resolution, localhost alias,
 * IPv4 shorthand, mapped IPv6, subnet route, wildcard, or ambient DNS lookup.
 * The one non-address host is the installed socket directory (above). */
export function isSupportedPrivatePostgresHostV1(host: unknown, installRoot?: string): host is string {
  if (host === "127.0.0.1" || isInstalledPostgresSocketDirectoryV1(host, installRoot)) return true;
  if (typeof host !== "string" || isIP(host) !== 4) return false;
  const bytes = host.split(".").map(Number);
  return bytes.join(".") === host && bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127
    && host !== "100.64.0.0" && host !== "100.127.255.255";
}

export function privatePostgresEndpointFingerprintV1(endpoint: Address): string {
  return sha256Digest({ purpose: "private-installed-postgres-endpoint/v1", host: endpoint.host,
    port: endpoint.port, database: endpoint.database, majorVersion: endpoint.majorVersion });
}

export function capturePrivatePostgresEndpointPolicyV2(endpoint: Address,
  value: unknown, context: PrivatePostgresValidationContextV1 = {}): PrivatePostgresEndpointPolicyV2 | undefined {
  if (!isSupportedPrivatePostgresHostV1(endpoint.host, context.installRoot)) return refused();
  // Loopback and the local socket never leave this Mac: no route evidence, no TLS.
  if (endpoint.host === "127.0.0.1" || isInstalledPostgresSocketDirectoryV1(endpoint.host, context.installRoot)) {
    if (value !== undefined) return refused();
    return undefined;
  }
  const policy = exactHostDataSnapshotV1(value,
    ["schema", "routeKind", "endpointFingerprint", "privateRouteEvidenceDigest", "serverIdentity"]);
  const identity = exactHostDataSnapshotV1(policy?.serverIdentity, ["serverName"]);
  if (!policy || !identity || policy.schema !== PRIVATE_POSTGRES_ENDPOINT_V2 || policy.routeKind !== "tailscale"
    || policy.endpointFingerprint !== privatePostgresEndpointFingerprintV1(endpoint)
    || typeof policy.privateRouteEvidenceDigest !== "string" || !digestPattern.test(policy.privateRouteEvidenceDigest)
    || typeof identity.serverName !== "string" || identity.serverName.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(identity.serverName)
    || isIP(identity.serverName) !== 0 || identity.serverName.endsWith(".localhost")) return refused();
  return Object.freeze({ schema: PRIVATE_POSTGRES_ENDPOINT_V2, routeKind: "tailscale" as const,
    endpointFingerprint: policy.endpointFingerprint, privateRouteEvidenceDigest: policy.privateRouteEvidenceDigest,
    serverIdentity: Object.freeze({ serverName: identity.serverName }) });
}

/** Uses Node's normal trust-chain validation and explicit hostname validation.
 * The server name is for TLS only, never routing; certificate renewal is safe.
 * No rejectUnauthorized:false, custom trust root, TLS downgrade or fallback. */
export function privatePostgresTlsOptionsV2(policy: PrivatePostgresEndpointPolicyV2 | undefined): false | ConnectionOptions {
  if (!policy) return false;
  const identity = policy.serverIdentity;
  return Object.freeze({ rejectUnauthorized: true, minVersion: "TLSv1.2" as const,
    servername: identity.serverName,
    checkServerIdentity(_name: string, certificate: PeerCertificate) {
      const failure = () => new Error("private_database_server_identity_refused");
      if (checkServerIdentity(identity.serverName, certificate)) return failure();
      return undefined;
    } });
}

export function privatePostgresEndpointPolicyDigestV2(policy: PrivatePostgresEndpointPolicyV2 | undefined): string {
  return sha256Digest({ purpose: "private-postgres-endpoint-policy/v2", policy: policy ?? null });
}
