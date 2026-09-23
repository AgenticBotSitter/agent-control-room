import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from "node:tls";
import { sha256Digest } from "../../security/canonical-digest";
import { exactHostDataSnapshotV1 } from "../../security/host-value";

export const PRIVATE_POSTGRES_ENDPOINT_V1 = "control-room.private-postgres-endpoint/v1" as const;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

/** Private, manifest-bound data. A digest records reviewed route evidence; it
 * does not itself prove that Tailscale is currently connected. TLS authenticates
 * every database connection independently, including pooled reconnections. */
export type PrivatePostgresEndpointPolicyV1 = Readonly<{
  schema: typeof PRIVATE_POSTGRES_ENDPOINT_V1;
  routeKind: "tailscale";
  endpointFingerprint: string;
  privateRouteEvidenceDigest: string;
  serverIdentity: Readonly<{ serverName: string; certificateSha256: string }>;
}>;
type Address = Readonly<{ host: string; port: number; database: string; majorVersion: 17 }>;

function refused(): never { throw new Error("invalid_private_database_endpoint"); }

/** Only exact canonical literals are accepted. No resolution, localhost alias,
 * IPv4 shorthand, mapped IPv6, subnet route, wildcard, or ambient DNS lookup. */
export function isSupportedPrivatePostgresHostV1(host: unknown): host is string {
  if (host === "127.0.0.1") return true;
  if (typeof host !== "string" || isIP(host) !== 4) return false;
  const bytes = host.split(".").map(Number);
  return bytes.join(".") === host && bytes[0] === 100 && bytes[1]! >= 64 && bytes[1]! <= 127
    && host !== "100.64.0.0" && host !== "100.127.255.255";
}

export function privatePostgresEndpointFingerprintV1(endpoint: Address): string {
  return sha256Digest({ purpose: "private-installed-postgres-endpoint/v1", host: endpoint.host,
    port: endpoint.port, database: endpoint.database, majorVersion: endpoint.majorVersion });
}

export function capturePrivatePostgresEndpointPolicyV1(endpoint: Address,
  value: unknown): PrivatePostgresEndpointPolicyV1 | undefined {
  if (!isSupportedPrivatePostgresHostV1(endpoint.host)) return refused();
  if (endpoint.host === "127.0.0.1") {
    if (value !== undefined) return refused();
    return undefined;
  }
  const policy = exactHostDataSnapshotV1(value,
    ["schema", "routeKind", "endpointFingerprint", "privateRouteEvidenceDigest", "serverIdentity"]);
  const identity = exactHostDataSnapshotV1(policy?.serverIdentity, ["serverName", "certificateSha256"]);
  if (!policy || !identity || policy.schema !== PRIVATE_POSTGRES_ENDPOINT_V1 || policy.routeKind !== "tailscale"
    || policy.endpointFingerprint !== privatePostgresEndpointFingerprintV1(endpoint)
    || typeof policy.privateRouteEvidenceDigest !== "string" || !digestPattern.test(policy.privateRouteEvidenceDigest)
    || typeof identity.certificateSha256 !== "string" || !digestPattern.test(identity.certificateSha256)
    || typeof identity.serverName !== "string" || identity.serverName.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(identity.serverName)
    || isIP(identity.serverName) !== 0 || identity.serverName.endsWith(".localhost")) return refused();
  return Object.freeze({ schema: PRIVATE_POSTGRES_ENDPOINT_V1, routeKind: "tailscale" as const,
    endpointFingerprint: policy.endpointFingerprint, privateRouteEvidenceDigest: policy.privateRouteEvidenceDigest,
    serverIdentity: Object.freeze({ serverName: identity.serverName, certificateSha256: identity.certificateSha256 }) });
}

/** Uses Node's chain validation and hostname validation, then additionally pins
 * the exact peer certificate. The server name is for TLS only, never routing.
 * No rejectUnauthorized:false, custom trust root, TLS downgrade or fallback. */
export function privatePostgresTlsOptionsV1(policy: PrivatePostgresEndpointPolicyV1 | undefined): false | ConnectionOptions {
  if (!policy) return false;
  const identity = policy.serverIdentity;
  return Object.freeze({ rejectUnauthorized: true, minVersion: "TLSv1.2" as const,
    servername: identity.serverName,
    checkServerIdentity(_name: string, certificate: PeerCertificate) {
      const failure = () => new Error("private_database_server_identity_refused");
      if (checkServerIdentity(identity.serverName, certificate)) return failure();
      if (!Buffer.isBuffer(certificate.raw)
        || `sha256:${createHash("sha256").update(certificate.raw).digest("hex")}` !== identity.certificateSha256)
        return failure();
      return undefined;
    } });
}

export function privatePostgresEndpointPolicyDigestV1(policy: PrivatePostgresEndpointPolicyV1 | undefined): string {
  return sha256Digest({ purpose: "private-postgres-endpoint-policy/v1", policy: policy ?? null });
}
